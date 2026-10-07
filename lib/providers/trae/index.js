/**
 * dsh-trae-connect —— 把 Trae（SOLO CN 桌面版）订阅里的模型接入 DeepSeek Harness。
 *
 * ## 它为什么长这样
 *
 * Trae 的推理入口**不是** `/api/ide/v2/llm_raw_chat`。那条路属于 BYOK/custom-model
 * 通道（dylib 里叫 `llm_raw_chat_custom_model`），要服务端按 (user, env, function)
 * 预置一份 app config，外部调用只会拿到
 *   `2001 failed to do chat: failed to get app config: record not found`。
 *
 * 真正能用的是 **agent 服务**：`/api/agent/v3/llm_utils_chat`（Go 服务，内部名
 * `llm_raw_chat_v2`）。它只要求三样东西：
 *
 *   1. `app_id` + `app_version_code`(int64) —— 来自 product.json 的 bootConfig，是
 *      **产品级常量**，不是账号级；同一串被硬编码在 libai_agent.dylib 里。
 *   2. `function` —— 必须是服务端为该 appId 注册过的名字。实测有效集合见
 *      {@link TRAE_FUNCTIONS}；给错名字会回
 *      `no function config found for appId=..., function=...`。
 *   3. `messages[].content` 必须是**对象数组** `[{type:"text",text:"..."}]`，
 *      不是字符串（给字符串会回 `cannot unmarshal string into Go struct field
 *      LLMRawMessage.messages.content`）。
 *
 * 拿到一个有效 `function` 之后，**任意** preset 模型都可用（实测 9×19=171 组合全过）。
 *
 * ## 数据流
 *
 *   DSH ──OpenAI──▶ 本插件的回环 shim ──Trae SSE──▶ trae-api-cn.mchost.guru
 *
 * shim 与 `dsh-workbuddy-connect` 同构：127.0.0.1 随机端口 + 32 字节随机 bearer，
 * 只服务 `/healthz`、`/v1/models`、`/v1/chat/completions`。区别在于**上游不是
 * OpenAI 形状**，所以这里要把 Trae 的 SSE 逐事件翻译成 OpenAI 的 chat.completion.chunk。
 *
 * ## 凭据
 *
 * 容器看不到宿主 macOS 的 `~/Library/Application Support/TRAE SOLO CN/`。
 * 因此由宿主侧 `scripts/export-trae-plain.mjs` 解密 byteCrypto 信封后写明文快照到
 * `~/.dsh/trae/{credential.json,models.json}`（`~/.dsh` 已 bind mount 成 `/root/.dsh`），
 * 本插件只读这两份快照，绝不碰桌面 App 自己的目录。
 *
 * @module dsh-trae-connect
 */

import z from "@deepseek-ai/schemastery";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { briefMessage, hostIsLoopback, loopbackRequest, originIsLoopback, writeJson } from "../../shared/http.js";

//#region 常量

/** Cordis 插件名。必须与 cordis.patch.yml 里的 `id` 一致。 */
export const name = "llm-trae";
/** 注册 provider 之前必须先拿到模型注册表。 */
export const inject = ["llm"];

/** DSH 里对用户展示的 provider id，也是模型选择器上那一组的名字。 */
const TRAE_PROVIDER = "trae";
const TRAE_DISPLAY_NAME = "Trae";

/** 推理网关。product.json 的 bootConfig.agent/hub/remote 全部指向它。 */
const DEFAULT_GATEWAY = "https://trae-api-cn.mchost.guru";
/** 账号/计费网关。凭据里的 `host` 就是它，签到与额度都打这里。 */
const DEFAULT_ACCOUNT_BASE = "https://api.trae.cn";
/** 产品级 App 身份（bootConfig.hub.appId / agent.appId）。 */
const DEFAULT_APP_ID = "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8";
/** product.json 的 buildId。 */
const DEFAULT_APP_VERSION_CODE = 1227681842690;

/**
 * 模型配置注册表 —— 倍率的**唯一权威来源**。
 *
 * 同一台网关（`trae-api-cn.mchost.guru`）下的 `/api/ide/v1/**` 命名空间，
 * 与推理同源，不需要额外主机常量。
 *
 * 三个请求头缺一不可，且行为都不直观（实测矩阵见 {@link createTraeRateClient}）：
 * `X-Ide-Token` 缺 → 401；`X-App-Id` 缺 → 只回 1.3 KB 空壳；
 * `X-Ide-Version-Code` 用小值 → **静默降级**成 6.5 KB 的不带 function_configs 的壳。
 */
const DETAIL_PARAM_PATH = "/api/ide/v1/batch_get_detail_param";

/**
 * 倍率刷新间隔。**与 30s 的凭据巡检解耦** —— 定价变动以小时计，
 * 而一次全量响应约 1.4 MB（约 96 次/天 = 130 MB/天），按凭据频率打会把上游打疼。
 */
const RATE_REFRESH_MS = 900000;
const MIN_RATE_REFRESH_MS = 60000;
const MAX_RATE_REFRESH_MS = 86400000;
/** 倍率请求超时：响应 1.4 MB，实测 0.4–27 s（上游会抖），别用默认的短超时。 */
const RATE_TIMEOUT_MS = 60000;

/**
 * 积分与签到的两个上游端点。
 *
 * 两者都是 **POST**（`out/main.js` 里 `eb(path, "POST", ...)`），尽管 GET 也回 200 ——
 * 但只有 POST 是 App 自己用的那条路，所以照抄 POST。
 *
 * 返回形状：
 *   status → {code, message, enable, checked_in, did_checked_in, credits, extra_credits}
 *   claim  → {code, message}            // code === 0 即成功
 *   usage  → {usage_summary:{consumed_amount,total_amount,consumption_ratio}, ...}
 */
const CHECKIN_STATUS_PATH = "/trae/api/v2/ug/checkin_credits/status";
const CHECKIN_CLAIM_PATH = "/trae/api/v2/ug/checkin_credits/claim";
const ENTITLEMENT_USAGE_PATH = "/trae/api/v2/pay/ide_user_ent_usage";

/**
 * 请求体里的 `req_source`，**漏了它 claim 会回 9004**。
 *
 * App 侧（`out/main.js` 的 `eb()`）发的是 `{req_source: a}`，其中
 * `a = Pr(product) ? 2 : 1`；而 `Pr` 判定 `packageType ∈ {SOLO_CN, SOLO_I18N,
 * SOLO_CN_ENTERPRISE}`。本机 `product.json` 是 `packageType: "SOLO_CN"`，
 * 所以是 **2**（"work/lite" 产品线，与 `sendEvent` 里的 `product: "trae_work"` 一致）。
 *
 * 实测：不带这个字段时 status 仍回 200，但 claim 回
 * `9004 The submitted order parameters are incorrect` —— 只读接口不校验它，
 * 写接口校验。这种"只读能过、写入被拒"的差异很容易被误判成鉴权问题。
 */
const TRAE_REQ_SOURCE = 2;

/** 浏览器侧读的那两个路由，与 client.js 里的字面量必须一致。 */
const TRAE_STATUS_ROUTE = "/plugins/dsh-trae-connect/status";
const TRAE_CHECKIN_ROUTE = "/plugins/dsh-trae-connect/checkin";

/**
 * 服务端为该 App 注册过的 function 名。在这个集合之外的任何名字都会被
 * `no function config found for appId=...` 拒绝（实测 86 个候选里只有这 9 个通过）。
 *
 * 前 7 个对应 Trae 的 agent 分组（与 state.vscdb 的 model_list_map 分组名一致），
 * 后 2 个是工具型 function。
 */
export const TRAE_FUNCTIONS = [
  "solo_work_lite",
  "solo_agent_lite",
  "solo_coder",
  "solo_work_remote",
  "solo_agent_remote",
  "solo_design_lite",
  "solo_design_remote",
  "multimodal",
  "refactor",
];
/** 不指定时的默认 function：SOLO 的通用 work agent。 */
/**
 * 默认 function（能力槽位）。
 *
 * ⚠️ **思考档位是按 (模型 × function) 配对下发的**，这是选它的唯一理由：
 *
 * | function | 支持档位的模型数 | 三档齐全 |
 * |---|---|---|
 * | `solo_agent_lite` / `solo_agent_remote` | 11 / 18 | 6 |
 * | `solo_work_lite`（旧默认） | **0 / 17** | 0 |
 * | 其余 5 个 | 0 | 0 |
 *
 * 实测（2026-10-06，同一账号）：`deepseek-v4.1-flash` 在 `solo_agent_lite` 下
 * 是 `{support_thinking:true, options:["light","high","extra_high"]}`，
 * 而在 `solo_work_lite` 下是 `{support_thinking:false}` —— 传任何档位都无效。
 *
 * 切换代价为零：`solo_work_lite` 的 17 个模型**全部**包含在 `solo_agent_lite`
 * 的 18 个里（还多一个 Seed-Code），不会丢模型。
 */
const DEFAULT_FUNCTION = "solo_agent_lite";

/**
 * 思考档位映射：Trae 线上值 → pi-ai 的档位键。
 *
 * Trae 只有三个值（服务端下发的 `options` 与客户端常量表里都只出现它们）：
 *   `light` → 轻、`high` → 高、`extra_high` → 极高
 * 依次对应 pi-ai 的 `low` / `high` / `xhigh`。
 *
 * ⚠️ 不能照搬 Qoder/WorkBuddy 的 `low/medium/high/xhigh/max`：Trae 对不认识的
 * 值会**静默忽略**（实测乱填同样返回 200），错值不报错、只会让人误判"档位无效"。
 *
 * 这张表是**唯一事实来源**，声明（正向）与请求（反向）都从这里取，
 * 免得两处各写一份而漂移。
 */
const TRAE_EFFORT_TO_LEVEL = {
  light: "low",
  high: "high",
  extra_high: "xhigh",
};
/** 反向查表：pi-ai 档位键 → Trae 线上值。 */
const LEVEL_TO_TRAE_EFFORT = new Map(
  Object.entries(TRAE_EFFORT_TO_LEVEL).map(([wire, level]) => [level, wire]),
);

/** 流式请求在两次数据之间允许的最长静默。 */
const TRAE_STREAM_IDLE_TIMEOUT_MS = 300000;

/** pi-ai 模型描述里要显式写 0，否则计费面板会按未知价格处理。 */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20971520,
  requestImagePixelBudget: 4194304,
  requestImageMaxBytes: 1048576,
};

/**
 * 拿不到 models.json 时的兜底名单。
 *
 * 只放确定存在的 preset 模型；不在名单里的 id 照样能用（catalog 是建议性的），
 * 这里的作用只是让模型选择器在首次导出前不至于空着。
 */
export const FALLBACK_TRAE_MODELS = [
  { id: "DeepSeek-V4-Flash-Official", name: "DeepSeek-V4-Flash 正式版", contextWindow: 200000, maxTokens: 32768, supportsImages: false },
  { id: "DeepSeek-V4-Pro-Official", name: "DeepSeek-V4-Pro 正式版", contextWindow: 200000, maxTokens: 32768, supportsImages: false },
  { id: "Doubao-Seed-Evolving", name: "Seed-Evolving", contextWindow: 256000, maxTokens: 32768, supportsImages: true },
  { id: "glm-5.3", name: "GLM-5.3", contextWindow: 200000, maxTokens: 32768, supportsImages: false },
  { id: "kimi-k3", name: "Kimi-K3", contextWindow: 200000, maxTokens: 32768, supportsImages: true },
  { id: "minimax-m3", name: "MiniMax-M3", contextWindow: 128000, maxTokens: 32768, supportsImages: true },
  { id: "qwen3.8-max", name: "Qwen3.8-Max", contextWindow: 200000, maxTokens: 32768, supportsImages: true },
];

/**
 * pi-ai 的 auth 平面在本插件里必须是惰性的：认证只走 shim 的共享密钥，
 * 由 `resolveApiKey` 每个请求现取，pi-ai 自己不该凭空造一份凭据出来。
 */
const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() { return []; },
    async modify() { throw new Error("dsh-trae-connect: the trae route has no pi-ai credential lifecycle"); },
    async delete() {},
  },
  authContext: {
    async env() {},
  },
};

//#endregion
//#region 配置

const CREDENTIAL_FILE_FIELD = z.string().description("Trae 明文凭据快照（默认 $DSH_HOME/connect-auth/trae.json）");
const MODEL_CATALOG_FILE_FIELD = z.string().description("Trae 模型目录快照（默认 $DSH_HOME/trae/models.json）");
const FUNCTION_FIELD = z.string().description(`默认使用的 Trae function（可选：${TRAE_FUNCTIONS.join(" / ")}）`);
const GATEWAY_FIELD = z.string().description("Trae 推理网关");
const ACCOUNT_BASE_FIELD = z.string().description("Trae 账号/计费网关（签到、额度；默认 https://api.trae.cn）");
const APP_ID_FIELD = z.string().description("Trae 产品级 appId（bootConfig.hub.appId）");
const APP_VERSION_CODE_FIELD = z.number().description("Trae buildId（product.json 的 buildId）");
const INLINE_SYSTEM_FIELD = z.boolean().default(true).description("把 system 消息并入首条 user 消息（Trae 的 function 有自己的系统提示，直接传 system 角色不保证被接受）");
const POLL_FIELD = z.number().description("凭据轮询间隔（毫秒）");
const RATE_ENABLED_FIELD = z.boolean().default(true).description("运行时从上游注册表拉取模型消耗倍率（关闭则只用 models.json 快照里的 rate）");
const RATE_REFRESH_FIELD = z.number().description("倍率刷新间隔（毫秒，默认 900000 = 15 分钟）");
const RATE_FUNCTIONS_FIELD = z.array(z.string()).description(`拉倍率时要查的 function 列表（默认全部：${TRAE_FUNCTIONS.join(" / ")}）`);

export const Config = z.object({
  credentialFile: CREDENTIAL_FILE_FIELD,
  modelCatalogFile: MODEL_CATALOG_FILE_FIELD,
  function: FUNCTION_FIELD,
  gateway: GATEWAY_FIELD,
  accountBase: ACCOUNT_BASE_FIELD,
  appId: APP_ID_FIELD,
  appVersionCode: APP_VERSION_CODE_FIELD,
  inlineSystemPrompt: INLINE_SYSTEM_FIELD,
  pollIntervalMs: POLL_FIELD,
  rateEnabled: RATE_ENABLED_FIELD,
  rateRefreshMs: RATE_REFRESH_FIELD,
  rateFunctions: RATE_FUNCTIONS_FIELD,
});

/**
 * 解析路径默认值 —— 必须在 DSH_HOME 可用之后才能求值。
 *
 * [2026-09-25] 认证统一收进 `$DSH_HOME/connect-auth/`：迁移或多端部署时只需搬这一个目录，
 * 不必再逐渠道记路径。旧位置 `$DSH_HOME/trae/credential.json` 仍可通过
 * `credentialFile` 配置项指回（`scripts/export-connect-credentials.mjs restore` 会搬运）。
 */
function defaultCredentialPath() {
  return join(resolveDshHome(), "connect-auth", "trae.json");
}
/** 模型目录缓存 —— 这不是凭据，留在原处。 */
function defaultCatalogPath() {
  return join(resolveDshHome(), "trae", "models.json");
}

//#endregion
//#region 凭据与目录

/** 读 JSON 文件；不存在或格式坏都返回 undefined，绝不抛。 */
function readJsonFile(path) {
  if (typeof path !== "string" || path.length === 0 || !existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** JWT payload（不验签，只用来读 exp 做提前预警）。 */
function jwtExpirySeconds(token) {
  const parts = String(token).split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return typeof payload?.exp === "number" ? payload.exp : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 凭据读取器。每次 `resolve()` 都重新读盘 —— 宿主侧重新导出快照后无需重启 DSH
 * 即可生效，这与 WorkBuddy 那条路一致。
 */
export function createCredentialStore(options) {
  const { config, logger } = options;
  let lastWarn = 0;
  return {
    path: () => config().credentialFile || defaultCredentialPath(),
    async resolve() {
      const doc = readJsonFile(this.path());
      if (doc === undefined || typeof doc.token !== "string" || doc.token.length === 0) {
        throw new Error(`未登录：读不到 Trae 凭据快照（${this.path()}）。先在宿主机跑 scripts/export-trae-plain.mjs。`);
      }
      const exp = jwtExpirySeconds(doc.token);
      if (exp !== undefined && exp * 1000 < Date.now()) {
        const now = Date.now();
        if (now - lastWarn > 3600000) {
          lastWarn = now;
          logger?.warn(`dsh-trae-connect: Trae token 已于 ${new Date(exp * 1000).toISOString()} 过期，请在 Trae 重新登录后重跑 export-trae-plain.mjs`);
        }
        throw new Error("Trae token 已过期；请在 Trae 桌面端重新登录后重跑 scripts/export-trae-plain.mjs。");
      }
      return {
        token: doc.token,
        userId: typeof doc.userId === "string" ? doc.userId : "",
        /** 展示用账号名（Trae 的 `account.username`，形如 `用户7381384633`）。 */
        account: typeof doc.account?.username === "string" ? doc.account.username : "",
        gateway: config().gateway || doc.gateway || DEFAULT_GATEWAY,
        /** 签到与额度打的是账号网关，与推理网关不同。 */
        accountBase: config().accountBase || doc.host || DEFAULT_ACCOUNT_BASE,
        appId: config().appId || doc.appId || DEFAULT_APP_ID,
        appVersionCode: config().appVersionCode ?? doc.appVersionCode ?? DEFAULT_APP_VERSION_CODE,
        /**
         * 设备号，**写接口必需**（签到 claim 缺它会回 9004）。
         * 由 export-trae-plain.mjs 从 storage.json 的 `iCubeAuthInfo://icube-dc:<id>` 键取出。
         * 缺了不阻止插件启动 —— 只读功能（模型、额度、签到状态）都还能用。
         */
        deviceId: typeof doc.deviceId === "string" ? doc.deviceId : "",
        /** ISO 串（导出脚本从 JWT 的 exp 取），供界面显示有效期。 */
        expiresAt: typeof doc.expiredAt === "string" ? doc.expiredAt : undefined,
      };
    },
    async current() {
      try {
        return await this.resolve();
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * 模型目录 = **快照（名单与上下文窗口）** ＋ **实时倍率层**。
 *
 * 两层的来源与生命周期完全不同，所以这里显式分开：
 *
 * 1. **名单层**：`models.json` 快照（`export-trae-plain.mjs` 从 state.vscdb 导出）。
 *    它决定"有哪些模型、上下文多大"——这些值随 App 版本变，但变化很慢，
 *    而且是**必须**由宿主导出的（容器看不到 macOS 的 state.vscdb）。
 * 2. **倍率层**：运行时打 `POST /api/ide/v1/batch_get_detail_param` 现取，
 *    见 {@link createTraeRateClient}。倍率是**定价**，随促销/活动变，不该固化进文件。
 *
 * 叠加规则：live 值优先；拿不到（未启用/首次未回/该模型不在上游清单里）时，
 * 退回快照自带的 rate —— 老版本导出脚本写的离线倍率因此仍然是可用的兜底，
 * 不会因为一次网络抖就把整个倍率列清空。
 *
 * ⚠️ 重建对象时**必须显式透传 rate 三兄弟**。catalog 是按白名单字段重建的，
 * 早先只取 id/name/contextWindow/maxTokens/supportsImages 五项，rate 就算在
 * 上游/快照里存在也会在这里被静默丢掉 —— 表现就是"trae 永远没有倍率"，
 * 而且没有任何报错。这类"重建时漏字段"的 bug 只能靠逐层比对发现。
 */
export function createCatalog(options) {
  const { config } = options;
  /** 名单层：文件/兜底名单解析出来的条目（含文件自带的离线 rate，作兜底）。 */
  let base = [...FALLBACK_TRAE_MODELS];
  /** 倍率层：`id → {rate, rateDiscount, rateActivity}`，来自上游注册表。 */
  let rates = new Map();
  let ratesSource = "none";
  let ratesFetchedAt = 0;
  let ratesError;
  let models = [...FALLBACK_TRAE_MODELS];
  let source = "fallback";

  /** 把两层合成对外可见的模型列表。任何一层变化后都要调用。 */
  const rebuild = () => {
    models = base.map((m) => {
      const live = rates.get(m.id);
      const rate = live?.rate ?? m.rate;
      const rateDiscount = live?.rateDiscount ?? m.rateDiscount;
      const rateActivity = live?.rateActivity ?? m.rateActivity;
      return {
        id: m.id,
        name: m.name,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        supportsImages: m.supportsImages,
        // 档位按 (模型 × function) 配对，原样带下去，由适配器按当前 function 取用。
        ...(m.reasoningByGroup === undefined ? {} : { reasoningByGroup: m.reasoningByGroup }),
        // 上下文窗口/Max 开关同上（rebuild 的输入来自 load 的 base，字段要在这里透传）。
        ...(m.contextWindowByGroup === undefined ? {} : { contextWindowByGroup: m.contextWindowByGroup }),
        ...(m.maxModeByGroup === undefined ? {} : { maxModeByGroup: m.maxModeByGroup }),
        ...Number.isFinite(rate) ? { rate } : {},
        ...Number.isFinite(rateDiscount) ? { rateDiscount } : {},
        ...Number.isFinite(rateActivity) ? { rateActivity } : {},
      };
    });
  };

  const load = () => {
    const doc = readJsonFile(config().modelCatalogFile || defaultCatalogPath());
    const list = Array.isArray(doc?.models) ? doc.models : [];
    const usable = list.filter((m) => m && typeof m.id === "string" && m.id.length > 0);
    if (usable.length > 0) {
      base = usable.map((m) => ({
        id: m.id,
        name: typeof m.name === "string" && m.name.length > 0 ? m.name : m.id,
        contextWindow: Number.isFinite(m.contextWindow) && m.contextWindow > 0 ? m.contextWindow : 128000,
        maxTokens: Number.isFinite(m.maxTokens) && m.maxTokens > 0 ? m.maxTokens : 16384,
        supportsImages: m.supportsImages === true,
        /**
         * 档位配置**按 function 分别保留**。
         *
         * ⚠️ 这里曾经只挑固定几个字段，把 `reasoningByGroup` 整个丢掉了 ——
         * 于是模型列表里再也看不到"这个模型支持哪些思考档位"，档位功能无从实现。
         * 注意它必须是 **per-function 的字典**：同一个模型在 solo_agent_lite 下
         * 支持 light/high/extra_high，在 solo_work_lite 下 support_thinking=false。
         */
        ...(m.reasoningByGroup && typeof m.reasoningByGroup === "object" ? { reasoningByGroup: m.reasoningByGroup } : {}),
        /**
         * 上下文窗口**同样按 function 配对**（与 reasoningByGroup 同一批教训）：
         * `deepseek-v4.1-flash` 在 solo_agent_lite 是 {dev:200000, max:1000000}，
         * 在 solo_work_lite 只有 {dev:200000}。只存一个数会把 1M 丢掉。
         * `maxModeByGroup[group]===true` 表示客户端 UI 有「更大上下文(Max)」开关。
         */
        ...(m.contextWindowByGroup && typeof m.contextWindowByGroup === "object" ? { contextWindowByGroup: m.contextWindowByGroup } : {}),
        ...(m.maxModeByGroup && typeof m.maxModeByGroup === "object" ? { maxModeByGroup: m.maxModeByGroup } : {}),
        ...Number.isFinite(m.rate) ? { rate: m.rate } : {},
        ...Number.isFinite(m.rateDiscount) ? { rateDiscount: m.rateDiscount } : {},
        ...Number.isFinite(m.rateActivity) ? { rateActivity: m.rateActivity } : {},
      }));
      source = "snapshot";
    } else {
      base = [...FALLBACK_TRAE_MODELS];
      source = "fallback";
    }
    rebuild();
  };
  load();
  return {
    reload: load,
    source: () => source,
    current: () => models,
    /**
     * 灌入上游实时倍率。
     *
     * 全量替换而非合并：上游是**权威**，某个模型这次没返回就是"上游不再给这个价"，
     * 继续留着上一次的值只会让人以为它还有效。没被覆盖的模型会退回快照兜底
     * （见 {@link rebuild}），所以不会出现"整列消失"。
     */
    setRates(map) {
      rates = map instanceof Map ? map : new Map();
      ratesSource = "live";
      ratesFetchedAt = Date.now();
      ratesError = undefined;
      rebuild();
    },
    /**
     * 清空倍率层（换账号时用）。
     *
     * 倍率是**账号级**的（会员折扣、活动价都挂在账号上），沿用上一个账号的数值
     * 不只是显示错了 —— 还会让下一次刷新的"降级保护"拿旧账号的覆盖数当基线，
     * 从而误判新账号的正常响应为残缺。所以换账号先把基线清掉。
     */
    clearRates() {
      rates = new Map();
      ratesSource = "none";
      ratesFetchedAt = 0;
      ratesError = undefined;
      rebuild();
    },
    /** 记录一次失败的刷新：保留旧值，只留错误信息，且把时间推前避免疯狂重试。 */
    markRatesFailed(error) {
      ratesFetchedAt = Date.now();
      ratesError = briefMessage(error);
    },
    ratesSource: () => ratesSource,
    ratesFetchedAt: () => ratesFetchedAt,
    ratesError: () => ratesError,
    /** 当前展示的模型里，有多少个真的拿到了 live 倍率（诊断用）。 */
    rateCoverage: () => {
      let covered = 0;
      for (const m of models) if (rates.has(m.id)) covered += 1;
      return { covered, total: models.length };
    },
  };
}

//#endregion
//#region 请求/响应形状转换

/**
 * 模型 id 里可以写 `@<function>` 覆盖默认 function，例如
 * `DeepSeek-V4-Flash-Official@refactor`。这样既保持了模型选择器里的名字干净，
 * 又不必为 9 个 function 各铺一份模型列表。
 */
export function decodeModelId(raw, fallbackFunction) {
  const id = typeof raw === "string" ? raw : "";
  const at = id.lastIndexOf("@");
  if (at > 0) {
    const fn = id.slice(at + 1);
    const model = id.slice(0, at);
    if (TRAE_FUNCTIONS.includes(fn)) return { model, functionName: fn };
  }
  return { model: id, functionName: fallbackFunction };
}

/** 文本片段 → Trae 的 LLMRawMessageContent。 */
function textPart(text) {
  return { type: "text", text };
}

/**
 * OpenAI `messages` → Trae `messages`。
 *
 * Trae 的 `content` 是对象数组，不是字符串；图片按 `image_url` 形状透传，
 * 服务端不认识时会自行忽略，不会让整个请求失败。
 */
export function toTraeMessages(messages, inlineSystemPrompt) {
  const out = [];
  /** 被并入首条 user 消息的 system 文本。 */
  const systemTexts = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const role = typeof m?.role === "string" ? m.role : "user";
    const parts = [];
    const pushText = (t) => { if (typeof t === "string" && t.length > 0) parts.push(textPart(t)); };
    if (typeof m?.content === "string") {
      pushText(m.content);
    } else if (Array.isArray(m?.content)) {
      for (const p of m.content) {
        if (p?.type === "text" && typeof p.text === "string") pushText(p.text);
        else if (p?.type === "image_url" && p.image_url?.url) parts.push({ type: "image_url", image_url: { url: p.image_url.url } });
      }
    }
    /**
     * `developer` 是 OpenAI 对系统提示的新拼写（pi-ai 对声明 reasoning 的模型用它）。
     * 语义等同 `system`：必须并进 system 分支，否则会掉进下面的兜底逻辑被当成
     * `user`，把系统指令当用户输入发出去。
     */
    if (role === "system" || role === "developer") {
      if (inlineSystemPrompt) {
        for (const p of parts) if (typeof p.text === "string") systemTexts.push(p.text);
        continue;
      }
      if (parts.length === 0) continue;
      out.push({ role: "system", content: parts });
      continue;
    }
    if (parts.length === 0) continue;
    const mapped = role === "tool" || role === "function" ? "tool" : role === "assistant" ? "assistant" : "user";
    out.push({ role: mapped, content: parts });
  }
  if (systemTexts.length > 0) {
    const prefix = textPart(systemTexts.join("\n\n"));
    const firstUser = out.find((m) => m.role === "user");
    if (firstUser === undefined) out.unshift({ role: "user", content: [prefix] });
    else firstUser.content = [prefix, ...firstUser.content];
  }
  if (out.length === 0) out.push({ role: "user", content: [textPart("")] });
  return out;
}

/** Trae function 被拒时，服务端返回的是这句；翻译成人话。 */
function explainTraeError(message) {
  const text = typeof message === "string" ? message : String(message ?? "");
  const noFn = /no function config found for appId=\S+, function=(\S+)/.exec(text);
  if (noFn !== null) return `Trae 未为该 appId 注册 function="${noFn[1]}"（可用：${TRAE_FUNCTIONS.join(", ")}）`;
  const unknownModel = /model is unknown/i.test(text);
  if (unknownModel) return "Trae 不认识这个模型名（先用 export-trae-plain.mjs 导出 models.json 取准确 id）";
  if (/token|expired|unauthor/i.test(text)) return "Trae 登录态失效，请重新登录后重跑 export-trae-plain.mjs";
  return text === "" ? "Trae 上游返回了空错误" : text;
}

//#endregion
//#region 上游客户端

/**
 * 上游客户端。`chatStream` 发一次 `/api/agent/v3/llm_utils_chat`，
 * 返回一个**已经把 Trae SSE 翻译成 OpenAI SSE** 的 ReadableStream，
 * 这样 shim 只要 pipe 出去就行。
 */
export function createTraeClient(options) {
  const { logger } = options;
  const endpoint = (gateway) => `${gateway.replace(/\/+$/, "")}/api/agent/v3/llm_utils_chat`;

  /**
   * 发一次流式请求。
   *
   * 返回 `{ ok: true, response }`（response.body 是 OpenAI SSE）或
   * `{ ok: false, status, kind, message }`。因为 Trae 永远回 HTTP 200 + SSE，
   * 所以这里会先读到**首个事件**再决定是成功还是失败，避免已经把 200 写出去
   * 才发现是错误。
   */
  async function chatStream(credential, body, signal) {
    const url = endpoint(credential.gateway);
    const payload = {
      app_id: credential.appId,
      app_version_code: credential.appVersionCode,
      function: body.function,
      model_name: body.model,
      messages: body.messages,
      stream: true,
    };
    if (Number.isFinite(body.maxTokens) && body.maxTokens > 0) payload.max_tokens = body.maxTokens;
    /**
     * 带档位时必须同时带 `custom_model` —— 档位字段挂在它里面。
     *
     * 字段照抄 Trae 客户端的真实请求（`renderer.log` 里的请求体），故意保持**完整**：
     * 服务端按字段的存在性判断模型类型，少字段会被当成另一种模型处理。
     * 空的写 `""`/`null`、布尔的写 `false`，与客户端一致。
     *
     * ⚠️ **`config_source` 必须是数字 `1`，不能是字符串。**
     * 这是整个功能最关键的一处坑：写成字符串时服务端解析不出模型来源，档位只被
     * **部分**接受（同 prompt 下思考链的下降幅度明显小于正常档位差）；
     * 改成数字后与 Trae App 内选同一档位的表现一致。
     * （`1` 是内置模型的通用取值，见 `config_source` 枚举。）
     */
    if (body.effort !== undefined && body.effort !== null) {
      payload.custom_model = {
        provider: "",
        is_preset: true,
        config_name: body.model,
        config_source: 1,
        model_name: body.model,
        display_model_name: body.model,
        ak: "",
        base_url: "",
        use_remote_service: true,
        multimodal: false,
        prompt_max_tokens: null,
        toolcall_history_max_tokens: null,
        extra_config: null,
        /**
         * `persist_meta` 携带 Max 模式标记（2026-10-06 抓包实测）：
         * Trae 客户端开「更大上下文(Max)」后，真实请求的 model_info 是
         *   prompt_max_tokens: 936000   ← 从 168000 改成这个（≈1M 减预留）
         *   persist_meta: {smart_selection:{strategy:"max", ...}}
         * `context_window_sizes` 保持 null —— 窗口不在这个字段里表达。
         * `body.maxMode` 由 shim 按当前 function 的目录声明算好传入。
         */
        persist_meta: body.maxMode === true
          ? { smart_selection: { strategy: "max", fallback_to_advance_model: null, entitlement_id: null } }
          : null,
        raw_chat_function: null,
        prompt_set: null,
        context_window_sizes: null,
        max_turn: null,
        display_options: null,
        max_tokens: null,
        application_config: null,
        sk: null,
        auth_type: null,
        region: null,
        session_token: null,
        custom_model_type: null,
        reasoning_effort_level: body.effort,
        /** Max 开启时同时改写 prompt_max_tokens（客户端实测值 936000 的来源见上）。 */
        ...(body.maxMode === true && Number.isFinite(body.promptMaxTokens) && body.promptMaxTokens > 0
          ? { prompt_max_tokens: body.promptMaxTokens }
          : {}),
      };
    }
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Cloud-IDE-JWT ${credential.token}`,
          "x-ide-token": credential.token,
        },
        body: JSON.stringify(payload),
        signal,
      });
    } catch (error) {
      return { ok: false, status: 0, kind: "network", message: `连不上 Trae 网关：${error instanceof Error ? error.message : String(error)}` };
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return { ok: false, status: response.status, kind: response.status === 401 || response.status === 403 ? "auth" : "upstream", message: text.slice(0, 400) };
    }
    if (response.body === null) return { ok: false, status: response.status, kind: "upstream", message: "Trae 返回了空响应体" };

    const reader = response.body.getReader();
    const parser = createSseReader();
    // 先读首个事件：若上游直接报错，就在写响应头之前把它变成正经的 HTTP 错误。
    let first = undefined;
    while (first === undefined) {
      const { done, value } = await reader.read();
      if (done) break;
      const events = parser.push(value);
      if (events.length > 0) first = events[0];
    }
    if (first === undefined) return { ok: false, status: 502, kind: "upstream", message: "Trae 流提前结束，没有读到任何事件" };
    if (first.event === "error") {
      return { ok: false, status: 502, kind: "upstream", message: explainTraeError(first.data?.message) };
    }
    const rest = parser.pending();
    return { ok: true, response: translate(reader, [first, ...rest], body, signal) };
  }

  /** 把已解析的 Trae 事件流翻译成 OpenAI SSE 字节流。 */
  function translate(reader, initialEvents, body, signal) {
    const model = body.model;
    const id = `chatcmpl-trae-${randomBytes(8).toString("hex")}`;
    const created = Math.floor(Date.now() / 1000);
    const encoder = new TextEncoder();
    const parser = createSseReader();
    let usage;
    let finished = false;

    const chunk = (delta, finishReason) => {
      const payload = { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finishReason ?? null }] };
      if (finishReason !== undefined && usage !== undefined) payload.usage = { prompt_tokens: usage.prompt_tokens ?? 0, completion_tokens: usage.completion_tokens ?? 0, total_tokens: usage.total_tokens ?? 0 };
      return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
    };

    return new ReadableStream({
      start(controller) {
        // `finished` = 已收到 done 或已收尾；`closed` = 流已真正关闭。两者必须分开：
        // done 事件内部就会 close()，pump() 结尾再 close 一次会抛 ERR_INVALID_STATE。
        let closed = false;
        const closeStream = () => {
          if (closed) return;
          closed = true;
          try { controller.close(); } catch { /* 已被下游取消 */ }
        };
        const enqueue = (bytes) => {
          if (closed) return;
          try { controller.enqueue(bytes); } catch { closed = true; }
        };
        const emit = (event) => {
          if (finished || closed) return;
          if (event.event === "output") {
            const data = event.data ?? {};
            const reasoning = typeof data.reasoning_content === "string" ? data.reasoning_content : "";
            const content = typeof data.response === "string" ? data.response : "";
            if (reasoning.length > 0) enqueue(chunk({ reasoning_content: reasoning }));
            if (content.length > 0) enqueue(chunk({ content }));
            if (Array.isArray(data.tool_calls) && data.tool_calls.length > 0) enqueue(chunk({ tool_calls: data.tool_calls }));
            return;
          }
          if (event.event === "token_usage") { usage = event.data ?? {}; return; }
          if (event.event === "error") {
            enqueue(chunk({ content: `\n\n[Trae 错误] ${explainTraeError(event.data?.message)}` }));
            return;
          }
          if (event.event === "done") {
            finished = true;
            enqueue(chunk({}, event.data?.finish_reason ?? "stop"));
            enqueue(encoder.encode("data: [DONE]\n\n"));
            closeStream();
          }
        };
        const pump = async () => {
          try {
            for (const event of initialEvents) emit(event);
            while (!finished && !closed) {
              const { done, value } = await reader.read();
              if (done) break;
              for (const event of parser.push(value)) emit(event);
            }
            if (!finished) {
              finished = true;
              enqueue(chunk({}, "stop"));
              enqueue(encoder.encode("data: [DONE]\n\n"));
            }
            closeStream();
          } catch (error) {
            logger?.warn("dsh-trae-connect: upstream stream failed mid-flight", error);
            if (!finished) {
              finished = true;
              enqueue(encoder.encode("data: [DONE]\n\n"));
            }
            closeStream();
          }
        };
        if (signal?.aborted === true) { finished = true; closeStream(); return; }
        pump();
      },
      cancel() { finished = true; reader.cancel().catch(() => {}); },
    });
  }

  return { chatStream };
}

/**
 * 账号侧客户端：额度（剩余积分）与每日签到。
 *
 * 与推理完全无关的第二个上游 —— 它在 `api.trae.cn` 而不是 `trae-api-cn.mchost.guru`，
 * 走 `/trae/api/v2/**` 命名空间。接口是从 App 的 `out/main.js` 里挖出来的：
 *
 *   fetchCheckinCreditsStatus() → eb("/trae/api/v2/ug/checkin_credits/status","POST",…)
 *   claimCheckinCredits()       → eb("/trae/api/v2/ug/checkin_credits/claim","POST",…)
 *   ide_user_ent_usage          → 额度（consumed_amount / total_amount / consumption_ratio）
 *
 * 全部是**只读或幂等**的账号操作，不碰推理额度：签到是领取、状态是查询。
 */
export function createTraeAccountClient(options) {
  const { logger } = options;
  const TIMEOUT_MS = 20000;

  /** 打一次账号网关。失败一律抛，由调用方决定降级方式。 */
  async function post(credential, path, label) {
    const base = String(credential.accountBase || DEFAULT_ACCOUNT_BASE).replace(/\/+$/, "");
    let response;
    try {
      response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Cloud-IDE-JWT ${credential.token}`,
          "x-ide-token": credential.token,
          // 写接口（claim）会校验它；缺失时回 9004「order parameters are incorrect」，
          // 而只读接口（额度、签到状态）不校验 —— 所以漏了它只会在点击签到时才暴露。
          ...(credential.deviceId ? { "x-device-id": credential.deviceId } : {}),
        },
        body: JSON.stringify({ req_source: TRAE_REQ_SOURCE }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(`${label} 连不上 ${base}：${error instanceof Error ? error.message : String(error)}`);
    }
    const text = await response.text().catch(() => "");
    if (!response.ok) throw new Error(`${label} 返回 HTTP ${response.status}：${text.slice(0, 200)}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${label} 返回的不是 JSON：${text.slice(0, 200)}`);
    }
  }

  /** 数字字段的宽容读取：非有限数或负数一律当缺失。 */
  const num = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);

  return {
    /**
     * 剩余积分。
     *
     * Trae 只给「已消耗 / 总额」，剩余要自己减 —— 实测 `usage_summary` 里没有 remain 字段。
     * 拿不到 usage_summary 时抛，由状态文档降级成 `creditsError`，不影响签到等信息。
     */
    async fetchCredits(credential) {
      const doc = await post(credential, ENTITLEMENT_USAGE_PATH, "额度");
      const summary = doc?.usage_summary;
      const total = num(summary?.total_amount);
      const consumed = num(summary?.consumed_amount);
      if (total === undefined && consumed === undefined) throw new Error("额度接口没有返回 usage_summary");
      // 相减会带出浮点毛刺（4250 - 3429.47 = 820.5300000000002），
      // 在源头就收敛到 2 位 —— 服务端给的本就是两位小数。
      const remain = total !== undefined && consumed !== undefined
        ? Math.max(0, Math.round((total - consumed) * 100) / 100)
        : undefined;
      return {
        total,
        consumed,
        remain,
        ratio: num(summary?.consumption_ratio),
        isCreditsBilling: doc?.is_credits_billing === true,
        unlimited: false,
      };
    },

    /** 签到状态。`credits` 是今天签到可得，`extraCredits` 是额外奖励。 */
    async fetchCheckinStatus(credential) {
      const doc = await post(credential, CHECKIN_STATUS_PATH, "签到状态");
      return {
        enable: doc?.enable === true,
        checkedIn: doc?.checked_in === true,
        didCheckedIn: doc?.did_checked_in === true,
        credits: num(doc?.credits),
        extraCredits: num(doc?.extra_credits),
        code: typeof doc?.code === "number" ? doc.code : undefined,
      };
    },

    /**
     * 领取当日签到积分。
     *
     * 返回归一化的 `{state}`：`claimed` / `already-claimed` / `disabled` / `failed`。
     * 先读一次状态是为了区分「刚领到」和「今天已经领过」—— claim 接口本身
     * 只回 `{code, message}`，重复领取时 code 非 0 但语义是"今天领过了"，
     * 光看 code 分不出来。
     */
    async claimDailyCheckin(credential) {
      // 提前给出可执行的错误，而不是把服务端那句 9004 原样抛给用户 ——
      // 9004 的文案（"order parameters are incorrect"）完全指不到真正的原因。
      if (typeof credential.deviceId !== "string" || credential.deviceId === "") {
        return {
          state: "failed",
          message: "凭据快照里没有设备号，签到会被服务端拒绝；请在宿主重跑 scripts/export-trae-plain.mjs",
        };
      }
      let before;
      try {
        before = await this.fetchCheckinStatus(credential);
      } catch (error) {
        logger?.warn("dsh-trae-connect: 签到前读状态失败，直接尝试领取", error);
      }
      if (before?.enable === false) return { state: "disabled", message: "Trae 当前未开放签到" };
      if (before?.checkedIn === true) return { state: "already-claimed", checkin: before };
      const doc = await post(credential, CHECKIN_CLAIM_PATH, "签到");
      if (typeof doc?.code === "number" && doc.code !== 0) {
        return { state: "failed", code: doc.code, message: typeof doc?.message === "string" ? doc.message : `业务码 ${doc.code}` };
      }
      let after;
      try {
        after = await this.fetchCheckinStatus(credential);
      } catch { /* 领取已成功，状态刷新失败不影响结论 */ }
      return { state: "claimed", checkin: after };
    },
  };
}

/**
 * 倍率注册表客户端 —— 运行时现取每个模型的消耗倍率。
 *
 * 端点 `POST {gateway}/api/ide/v1/batch_get_detail_param`（与推理同网关，
 * 命名空间是 `/api/ide/v1/**`）。请求体照抄 App 的抓包，响应约 1.4 MB。
 *
 * ## 三个头，一个都不能少（实测矩阵）
 *
 * | 头 | 缺失/异常时的表现 |
 * |---|---|
 * | `X-Ide-Token` | 401 + `code:1001` |
 * | `X-App-Id` | 200，但正文只剩 **1304 B**（空壳，没有任何 config） |
 * | `X-Ide-Version-Code` | 见下 —— **静默降级**，最坑 |
 *
 * `X-Ide-Version-Code` 不是一个"版本校验"头，而是**配置注册表的筛选键**：
 *
 * ```
 * 1227681842690 (凭据里的 buildId) → 200, 1.45 MB, 302 条 config   ← 正确取值
 * 20260912      (App 抓包里的值)    → 200, 1.45 MB
 * 20260101                          → 200, 0.12 MB（只回一部分）
 * 1 / 不带                          → 200, 6.5 KB（空壳）
 * 非数字                             → 400
 * ```
 *
 * 也就是说用错值**不会报错**，只会拿到一份看似正常、实则没有 `function_configs`
 * 的文档 —— 表现就是"倍率全空"。所以这里取凭据里的 `appVersionCode`（就是
 * product.json 的 buildId），而不是另设一个魔法常量。
 *
 * ## 取值路径
 *
 * ```
 * function_configs[].config_info_list[]
 *   ├─ config_name                          → 模型 id（与 models.json 的 id 同名）
 *   ├─ display_contact_config.consumption_rate.data.rate        → 倍率
 *   ├─ display_contact_config.discount.data.consumption_rate    → 会员折扣价
 *   └─ display_contact_config.activity_discount.data.current.consumption_rate → 活动价
 * ```
 *
 * `display_contact_config` 是**字符串化的 JSON**（不是对象），要先解一层。
 * 同一个模型会出现在多个 function 下，取值完全一致（实测 81 个模型 0 冲突）。
 */

/** 把 `display_contact_config` 这类"JSON 藏在字符串里"的字段解出来。 */
export function parseEmbeddedJson(value) {
  if (typeof value === "object" && value !== null) return value;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 倍率的宽容读取：非有限数一律当缺失（上游会用 `null` 表示"无活动价"）。
 *
 * 同时容忍数字串（`"0.78"`）—— 上游同一份文档里 `rate` 是 number，
 * 但这类"配置下发"接口换个版本改成字符串是很常见的事，而 trae 的倍率一旦读不出来
 * 只会静默消失、不会报错，所以这里宁松勿紧（与 qoder 的 `toNumber` 一致）。
 */
function rateNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * 从注册表文档里抽出 `id → {rate, rateDiscount, rateActivity}`。
 *
 * 纯函数，不碰网络 —— 自检脚本直接喂一份抓包文档就能验，见
 * `scripts/trae-rates-selftest.mjs`。
 */
export function parseRateRegistry(doc) {
  const map = new Map();
  const configs = Array.isArray(doc?.function_configs) ? doc.function_configs : [];
  for (const fn of configs) {
    const list = Array.isArray(fn?.config_info_list) ? fn.config_info_list : [];
    for (const entry of list) {
      const id = typeof entry?.config_name === "string" ? entry.config_name.trim() : "";
      if (id === "") continue;
      const contact = parseEmbeddedJson(entry?.display_contact_config);
      if (contact === undefined) continue;

      // `consumption_rate.data.rate` 是当前生效倍率。少数只有会员折扣、没有
      // consumption_rate 的模型（如 glm-5.3）要退回折扣块里的原价，否则整条会丢。
      const discountData = parseEmbeddedJson(contact?.discount)?.data ?? contact?.discount?.data;
      const activityData = parseEmbeddedJson(contact?.activity_discount)?.data ?? contact?.activity_discount?.data;
      const rate = rateNumber(parseEmbeddedJson(contact?.consumption_rate)?.data?.rate)
        ?? rateNumber(discountData?.original_consumption_rate)
        ?? rateNumber(discountData?.consumption_rate);
      const rateDiscount = rateNumber(discountData?.consumption_rate);
      const rateActivity = rateNumber(activityData?.current?.consumption_rate);
      if (rate === undefined && rateDiscount === undefined && rateActivity === undefined) continue;
      // 先到先得：跨 function 取值一致，真出现冲突时不该由遍历顺序决定显示。
      if (!map.has(id)) map.set(id, { id, rate, rateDiscount, rateActivity });
    }
  }
  return map;
}

export function createTraeRateClient(options) {
  const { logger } = options;

  return {
    /**
     * 打一次注册表，返回倍率表。
     *
     * 失败一律抛 —— 由调用方决定降级（保留上一次的值），这里不吞。
     */
    async fetchRates(credential, functions, signal) {
      const base = String(credential.gateway || DEFAULT_GATEWAY).replace(/\/+$/, "");
      const url = `${base}${DETAIL_PARAM_PATH}`;
      const body = {
        functions: [...functions],
        agent_type: "",
        current_config_info: { config_name: "", is_custom_model: false },
        mode_type: 0,
        access_type: 1,
        ab_force_vids: "",
        ab_autotest_advanced_mode: 0,
        show_custom_model: true,
      };
      let response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "*/*",
            "X-Ide-Token": credential.token,
            "X-App-Id": credential.appId || DEFAULT_APP_ID,
            // 必须是真实 buildId；用小值会静默降级成空壳（见上方注释）。
            "X-Ide-Version-Code": String(credential.appVersionCode ?? DEFAULT_APP_VERSION_CODE),
            ...(credential.deviceId ? { "X-Device-Id": credential.deviceId } : {}),
            "User-Agent": "TraeClient/TTNet",
          },
          body: JSON.stringify(body),
          signal: signal ?? AbortSignal.timeout(RATE_TIMEOUT_MS),
        });
      } catch (error) {
        throw new Error(`倍率注册表连不上 ${base}：${error instanceof Error ? error.message : String(error)}`);
      }
      const text = await response.text().catch(() => "");
      if (!response.ok) throw new Error(`倍率注册表返回 HTTP ${response.status}：${text.slice(0, 200)}`);
      let doc;
      try {
        doc = JSON.parse(text);
      } catch {
        throw new Error(`倍率注册表返回的不是 JSON：${text.slice(0, 200)}`);
      }
      const map = parseRateRegistry(doc);
      if (map.size === 0) {
        // 最常见的成因是 X-Ide-Version-Code 被降级（200 + 6.5 KB 空壳）——
        // 把它写进错误信息，省得下次再去比对整份响应。
        throw new Error("倍率注册表没有返回任何 consumption_rate（多半是 X-Ide-Version-Code 被降级，检查凭据里的 appVersionCode）");
      }
      logger?.info?.(`dsh-trae-connect: 倍率已刷新，上游给出 ${map.size} 个模型的消耗倍率`);
      return map;
    },
  };
}

/** 逐字节喂入的 SSE 读取器：`event:<name>\n` + `data:<json>\n\n`。 */
export function createSseReader() {
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";
  const dataLines = [];
  const pending = [];

  const flush = () => {
    if (eventName === "" && dataLines.length === 0) return;
    const raw = dataLines.join("\n");
    let data;
    try { data = JSON.parse(raw); } catch { data = raw; }
    if (raw !== "" || eventName !== "") pending.push({ event: eventName || "message", data });
    eventName = "";
    dataLines.length = 0;
  };

  return {
    push(bytes) {
      buffer += decoder.decode(bytes, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (line === "") { flush(); continue; }
        if (line.startsWith("event:")) { eventName = line.slice(6).trim(); continue; }
        if (line.startsWith("data:")) { dataLines.push(line.slice(5).replace(/^ /, "")); continue; }
      }
      const out = pending.slice();
      pending.length = 0;
      return out;
    },
    pending() {
      const out = pending.slice();
      pending.length = 0;
      return out;
    },
  };
}

//#endregion
//#region 回环 shim

function writeOpenAIError(res, status, code, message) {
  writeJson(res, status, { error: { message, type: code, code } });
}
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * 回环 OpenAI shim。与 WorkBuddy 那条同构：随机端口 + 随机 bearer，
 * 只服务三个路由；上游换成 Trae 客户端，并把 Trae SSE 转成 OpenAI SSE。
 */
export function createTraeShim(options) {
  const { store, client, catalog } = options;
  const logger = options.logger;
  /** 每次启动一个新的共享密钥；只在本机回环上使用。 */
  const SHARED_SECRET = randomBytes(32).toString("base64url");

  function bearerOk(req) {
    const header = req.headers.authorization;
    if (typeof header !== "string") return false;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match === null) return false;
    const a = Buffer.from(match[1]);
    const b = Buffer.from(SHARED_SECRET);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  const server = createServer((req, res) => { handle(req, res); });
  const ready = new Promise((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  server.listen(0, "127.0.0.1");
  const baseUrl = () => {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("dsh-trae-connect: shim 没有监听地址");
    return `http://127.0.0.1:${address.port}`;
  };

  async function handle(req, res) {
    try {
      if (!hostIsLoopback(req.headers.host)) { writeOpenAIError(res, 403, "host_not_allowed", "Host 必须是回环地址"); return; }
      if (!originIsLoopback(req.headers.origin)) { writeOpenAIError(res, 403, "origin_not_allowed", "Origin 必须是回环地址"); return; }
      if (!bearerOk(req)) { writeOpenAIError(res, 401, "unauthorized", "Authorization bearer 缺失或不匹配"); return; }
      const url = req.url ?? "/";
      if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) { writeJson(res, 200, { ok: true }); return; }
      if (req.method === "GET" && (url === "/v1/models" || url === "/v1/models/")) {
        writeJson(res, 200, { object: "list", data: catalog.current().map((m) => ({ id: m.id, object: "model", created: 0, owned_by: TRAE_PROVIDER })) });
        return;
      }
      if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/v1/chat/completions/")) { await chatCompletions(req, res); return; }
      writeOpenAIError(res, 404, "not_found", `no such route: ${req.method} ${url}`);
    } catch (error) {
      if (!res.headersSent) writeOpenAIError(res, 500, "internal", String(error));
      else res.end();
    }
  }

  async function chatCompletions(req, res) {
    if (typeof req.headers["content-type"] !== "string" || !req.headers["content-type"].toLowerCase().includes("application/json")) {
      writeOpenAIError(res, 415, "unsupported_media_type", "Content-Type 必须是 application/json");
      return;
    }
    let credential;
    try {
      credential = await store.resolve();
    } catch (error) {
      writeOpenAIError(res, 401, "not_signed_in", error instanceof Error ? error.message : String(error));
      return;
    }
    let request;
    try {
      request = JSON.parse((await readBody(req)).toString("utf8"));
    } catch {
      writeOpenAIError(res, 400, "invalid_json", "请求体不是合法 JSON");
      return;
    }
    const settings = options.settings();
    const decoded = decodeModelId(request.model, settings.function);
    const controller = new AbortController();
    req.on("close", () => controller.abort());
    /**
     * 把 pi-ai 下发的档位反查回 Trae 的线上值。
     *
     * pi-ai 依据模型的 `thinkingLevelMap` 把 UI 档位映射成 wire 值写进请求体
     * （`reasoningEffort` → `reasoning_effort`），而 Trae 只认
     * `light`/`high`/`extra_high`。未识别或未选择一律 undefined
     * （= 不带 custom_model，走服务端默认档位）。
     */
    const level = typeof request.reasoning_effort === "string" ? request.reasoning_effort : undefined;
    const effort = level === undefined ? undefined : LEVEL_TO_TRAE_EFFORT.get(level);
    /**
     * Max 模式（更大上下文）按 (模型 × function) 的目录声明决定：
     * `contextWindowByGroup[fn].max` 存在且 > dev 窗口，说明该模型在当前
     * function 下有「更大上下文(Max)」档。
     *
     * 何时实际启用：请求的 max_tokens 超过 dev 窗口 ⇒ 对话确实需要大窗口。
     * 实测（2026-10-06 抓包 Trae 客户端）：Max 开启后请求带
     * prompt_max_tokens=936000（1M 的 93.6%）+ persist_meta.strategy="max"。
     */
    const tokensInfo = catalog.current().find((m) => m.id === decoded.model);
    const groupTokens = tokensInfo?.contextWindowByGroup?.[decoded.functionName];
    const devWindow = Number.isFinite(groupTokens?.dev) && groupTokens.dev > 0
      ? groupTokens.dev
      : tokensInfo?.contextWindow;
    const maxWindow = Number.isFinite(groupTokens?.max) && groupTokens.max > 0 ? groupTokens.max : undefined;
    const requested = Number.isFinite(request.max_tokens) ? request.max_tokens : 0;
    const maxMode = maxWindow !== undefined
      && Number.isFinite(devWindow) && devWindow > 0
      && maxWindow > devWindow
      && requested > devWindow;
    const promptMaxTokens = maxMode ? Math.floor(maxWindow * 0.936) : undefined;
    const result = await client.chatStream(credential, {
      model: decoded.model,
      function: decoded.functionName,
      messages: toTraeMessages(request.messages, settings.inlineSystemPrompt),
      maxTokens: request.max_tokens,
      effort,
      maxMode,
      promptMaxTokens,
    }, controller.signal);

    if (!result.ok) {
      const status = result.kind === "auth" ? 401 : result.kind === "network" ? 502 : 502;
      writeOpenAIError(res, status, result.kind, `trae upstream (http ${result.status}): ${result.message.slice(0, 500)}`);
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    let sawDone = false;
    const body = Readable.fromWeb(result.response);
    body.on("data", (chunk) => { if (chunk.includes("[DONE]")) sawDone = true; });
    body.on("error", (error) => {
      logger?.warn("dsh-trae-connect: 上游流中断", error);
      if (!sawDone && res.writable) res.end("data: [DONE]\n\n");
    });
    body.pipe(res);
  }

  return {
    ready,
    baseUrl,
    token: () => SHARED_SECRET,
    close: () => new Promise((resolve, reject) => {
      server.close(() => resolve());
      server.closeAllConnections();
      server.once("error", reject);
    }),
  };
}

//#endregion
//#region 适配器

/** 组装 pi-ai 的 provider + DSH 的 adapter。 */
/**
 * [dsh-connect] 面板下发的"禁用模型"钩子：`(providerId) => 要隐藏的模型 id[]`。
 *
 * provider 自己不知道面板的存在；lib/index.js 在启动时用 setExternalHidden 注入，
 * 未注入时视为"不隐藏"。每次构建模型列表时重新调用，所以用户在面板里改完立即生效。
 */
let externalHidden = () => [];
export function setExternalHidden(fn) {
  externalHidden = typeof fn === "function" ? fn : () => [];
}

export function createTraeAdapter(options) {
  const { shim, catalog } = options;
  const providerId = options.providerId ?? TRAE_PROVIDER;
  const displayName = options.displayName ?? TRAE_DISPLAY_NAME;
  /** [dsh-connect] 面板禁用的模型 id（每次构建列表时重读，改完立即生效）。 */
  const hidden = options.hidden ?? (() => []);

  /**
   * 把倍率挂到模型名上：`DeepSeek-V4-Pro` → `DeepSeek-V4-Pro · x0.72`。
   *
   * DSH 0.1.5 的模型下拉（dsh-client-ui-model-selection）只渲染 `model.name`
   * （`modelLabel = currentChoice?.model.name`，列表项也是 `children: model.name`），
   * `description` 根本不读 —— 想让每个模型都看到倍率，只能挂在名字上。
   *
   * 倍率本身是运行时从 `batch_get_detail_param` 现取的（见 `createCatalog` 的 rates 层），
   * 拿不到就原样返回，不硬凑。写法与面板的 `modelRate()` 对齐 —— trae 给的是数字，
   * 所以用 `x0.72` 而不是 qoder 那种 `0.5×`。
   */
  function withRateName(info) {
    const rate = info.rate;
    const text = typeof rate === "number" && Number.isFinite(rate) ? `x${rate}` : undefined;
    return text === undefined ? info.name : `${info.name} · ${text}`;
  }

  /**
   * 某个模型在**当前 function 下**支持的思考档位，转成 pi-ai 的 `thinkingLevelMap`。
   *
   * 为什么按 function 取：档位是 `(模型 × function)` 配对下发的。同一个
   * `deepseek-v4.1-flash` 在 `solo_agent_lite` 下有 light/high/extra_high，
   * 在 `solo_work_lite` 下 `support_thinking=false`。取错槽位就会得出
   * "这个模型不支持档位"的错误结论。
   *
   * 支持的档位集合从 {@link TRAE_EFFORT_TO_LEVEL} 生成：该表里出现过、且**被服务端
   * 声明**的线上值才映射成对应级；其余一律 `null`。置 null 而非省略是有意的 ——
   * pi-ai 对"缺失键"与"null"的处理不对称：缺失会被当成支持并用默认值。
   */
  function reasoningFieldsFor(info, fn) {
    const byGroup = info?.reasoningByGroup;
    const cfg = byGroup !== undefined && typeof byGroup === "object" ? byGroup[fn] : undefined;
    const declared = new Set(Array.isArray(cfg?.options) ? cfg.options : []);
    if (cfg?.support_thinking !== true || declared.size === 0) return { reasoning: false };
    const levels = {};
    for (const [wire, level] of Object.entries(TRAE_EFFORT_TO_LEVEL)) {
      levels[level] = declared.has(wire) ? wire : null;
    }
    return { reasoning: true, thinkingLevelMap: levels };
  }

  /**
   * 某模型在当前 function 下的上下文窗口。
   *
   * 目录按 (模型 × function) 配对下发的又一例：`deepseek-v4.1-flash` 在
   * `solo_agent_lite` 是 {dev:200000, max:1000000}，在 `solo_work_lite` 只有
   * {dev:200000}。早期导出按模型名去重、只留一个数，1M 那份被 work 组覆盖丢失
   * —— 用户在 Trae 客户端看得到「更大上下文扩至 1M」，插件里却只有 200k。
   * 有 `max` 用 max（上游按它计费/放行），否则退回模型级字段。
   */
  function contextWindowFor(info, fn) {
    const g = info?.contextWindowByGroup?.[fn];
    if (Number.isFinite(g?.max) && g.max > 0) return g.max;
    if (Number.isFinite(g?.dev) && g.dev > 0) return g.dev;
    return Number.isFinite(info?.contextWindow) && info.contextWindow > 0 ? info.contextWindow : 128000;
  }

  const buildModels = () => {
    const baseUrl = `${shim.baseUrl()}/v1`;
    const hiddenIds = new Set(hidden());
    const fn = options.settings().function;
    return catalog.current().filter((info) => !hiddenIds.has(info.id)).map((info) => ({
      id: info.id,
      // 倍率挂在名字上：模型下拉只渲染 `name`（理由见 withRateName）。
      name: withRateName(info),
      api: "openai-completions",
      provider: providerId,
      baseUrl,
      input: info.supportsImages === true ? ["text", "image"] : ["text"],
      ...reasoningFieldsFor(info, fn),
      cost: NO_COST,
      /**
       * 上下文窗口按当前 function 取目录声明（与档位同一教训：目录是
       * (模型 × function) 配对的）。声明里有更大的 `max`（Max 模式档）时
       * 直接上报 max —— pi-ai 会按它裁剪上下文，长会话才不会在 200k 被截。
       * 请求侧 shim 再依据 max_tokens 是否超 dev 窗口决定是否带 Max 标记
       * （见 chatStream 里的 maxMode / promptMaxTokens）。
       */
      contextWindow: contextWindowFor(info, fn),
      maxTokens: info.maxTokens,
      compat: { maxTokensField: "max_tokens" },
    }));
  };

  const provider = {
    ...createProvider({
      id: providerId,
      name: displayName,
      auth: {
        apiKey: {
          name: "Trae 会话 JWT（由 export-trae-plain.mjs 快照提供）",
          async resolve({ credential }) {
            const apiKey = credential?.key;
            return apiKey === undefined || apiKey.length === 0 ? undefined : { auth: { apiKey }, source: "Trae" };
          },
        },
      },
      models: buildModels(),
      api: openAICompletionsApi(),
    }),
    getModels: () => buildModels(),
  };

  const profile = {
    provider: providerId,
    displayName,
    streamIdleTimeoutMs: TRAE_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, "dsh-trae-connect retryPolicy"),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  };
  let profiles = new Map([[providerId, profile]]);
  return {
    adapter: new PiAiAdapter({
      profiles: () => profiles,
      auth: INERT_AUTH,
      resolveApiKey: async () => shim.token(),
    }),
    invalidate: () => { profiles = new Map([[providerId, profile]]); },
  };
}

//#endregion
//#region 渠道状态路由（供浏览器侧读取）

/**
 * 组装给浏览器侧的状态文档。
 *
 * 设计原则与 WorkBuddy 那条一致：**签到与额度都是"尽力而为"**——
 * 上游任何一段失败都降级成该字段的错误，而不是让整份文档 500。
 * 否则网络抖一下，界面上连渠道名和签到按钮都会消失。
 */
export async function traeWebStatus(deps) {
  const base = { provider: TRAE_PROVIDER, channel: TRAE_DISPLAY_NAME };
  const credential = await deps.store.current();
  if (credential === undefined) return { ...base, status: "signed-out" };

  const doc = {
    ...base,
    status: "signed-in",
    userId: credential.userId,
    account: credential.account,
    function: deps.settings().function,
    modelCount: deps.catalog.current().length,
    // [dsh-connect] 面板要按渠道列出模型做"禁用"配置，这里把清单带上（只读、最多 200 条）。
    models: deps.catalog.current().slice(0, 200).map((m) => ({
      id: m.id,
      name: m.name,
      /**
       * 面板要显示倍率，所以这里必须把它带出去。
       *
       * ⚠️ 这正是"trae 永远没有倍率"的**真正落点**：`/status` 文档此前只透出
       * `{id, name}` 两个字段 —— 即使 catalog 里读到了 rate（见上方 createCatalog），
       * 也会在这一步被抹掉。provider 内部"重建对象时只挑几个字段"是很常见的丢数据点，
       * 而且没有任何报错，只能靠逐层比对字段发现。
       */
      ...Number.isFinite(m.rate) ? { rate: m.rate } : {},
      ...Number.isFinite(m.rateDiscount) ? { rateDiscount: m.rateDiscount } : {},
      ...Number.isFinite(m.rateActivity) ? { rateActivity: m.rateActivity } : {},
    })),
    expiresAt: credential.expiresAt,
  };

  try {
    doc.credits = await deps.account.fetchCredits(credential);
  } catch (error) {
    doc.creditsError = briefMessage(error);
  }
  try {
    doc.checkin = await deps.account.fetchCheckinStatus(credential);
  } catch (error) {
    doc.checkinError = briefMessage(error);
  }
  return doc;
}

/** 签到路由：GET 读状态（只读），POST 领取。 */
export async function traeCheckinAction(deps, method) {
  const credential = await deps.store.current();
  if (credential === undefined) return { state: "signed-out" };
  if (method === "GET") {
    try {
      return { state: "signed-in", checkin: await deps.account.fetchCheckinStatus(credential) };
    } catch (error) {
      return { state: "failed", message: briefMessage(error) };
    }
  }
  try {
    return await deps.account.claimDailyCheckin(credential);
  } catch (error) {
    return { state: "failed", message: briefMessage(error) };
  }
}

/**
 * 两个路由的共用外壳。
 *
 * 必须做 loopback 守卫：这两个端点挂在用户自己的 DSH 端口上，而 DSH 端口
 * 可能被反代/局域网暴露。没有这道门，任何能访问该端口的页面都能借同源请求
 * 替用户点签到。Host **和** Origin 都要求是回环，缺一不可
 * （只有 Host 挡不住 DNS rebinding，只有 Origin 挡不住非浏览器客户端，但
 * 这个接口本身不写敏感数据，两者齐备即可）。
 */
function traeRouteHandler(handle) {
  return async (req, res) => {
    if (req.method !== "GET" && req.method !== "POST") {
      writeJson(res, 405, { error: "method not allowed" });
      return;
    }
    if (!loopbackRequest(req)) {
      writeJson(res, 403, { error: "request-not-trusted" });
      return;
    }
    try {
      writeJson(res, 200, await handle(req.method));
    } catch (error) {
      writeJson(res, 500, { error: briefMessage(error) });
    }
  };
}

/** 注册 `/plugins/dsh-trae-connect/{status,checkin}`；webServer 缺失时整段跳过。 */
export function registerTraeStatusRoutes(ctx, deps) {
  for (const [path, handle] of [
    [TRAE_STATUS_ROUTE, () => traeWebStatus(deps)],
    [TRAE_CHECKIN_ROUTE, (method) => traeCheckinAction(deps, method)],
  ]) {
    ctx.effect(() => {
      const dispose = ctx.webServer.register({ kind: "exact", path, handler: traeRouteHandler(handle) });
      return () => { dispose(); };
    }, `dsh-trae-connect: ${path}`);
  }
}

//#endregion
//#region 插件入口

const CREDENTIAL_POLL_MS = 30000;
const MIN_POLL_MS = 100;
const MAX_POLL_MS = 86400000;
function pollInterval(config) {
  const override = config?.pollIntervalMs;
  if (!Number.isFinite(override) || override < MIN_POLL_MS) return CREDENTIAL_POLL_MS;
  return Math.min(override, MAX_POLL_MS);
}

/** 倍率刷新间隔。下限 60s，避免配错成 0 之后每轮巡检都去打一次 1.4 MB。 */
function rateInterval(config) {
  const override = config?.rateRefreshMs;
  if (!Number.isFinite(override) || override < MIN_RATE_REFRESH_MS) return RATE_REFRESH_MS;
  return Math.min(override, MAX_RATE_REFRESH_MS);
}

/**
 * 拉倍率时要查的 function 清单。
 *
 * ⚠️ 这是**倍率注册表的查询键**，与推理用的 {@link TRAE_FUNCTIONS}（服务端为
 * 本 appId 注册过的 function 白名单）不是同一件事，所以多出 `assistant` / `builder`
 * 两个只出现在注册表里的名字。
 *
 * 为什么要列全：倍率对同一模型在各 function 下**取值一致**（实测 81 个模型 0 冲突），
 * 但**哪些模型出现在哪个 function 下**不同 —— 只查一个 function 会漏掉模型
 * （实测单查 `solo_work_lite` 只覆盖展示清单的 19/26），漏掉的只能退回快照兜底。
 * 列全（11 个）实测覆盖 26/26。
 */
const DEFAULT_RATE_FUNCTIONS = [...TRAE_FUNCTIONS, "assistant", "builder"];
function rateFunctions(config) {
  const override = config?.rateFunctions;
  if (!Array.isArray(override)) return DEFAULT_RATE_FUNCTIONS;
  const cleaned = override.filter((name) => typeof name === "string" && name.trim() !== "").map((name) => name.trim());
  return cleaned.length === 0 ? DEFAULT_RATE_FUNCTIONS : cleaned;
}

/**
 * 运行态落盘：`$DSH_HOME/.trae-connect-state.json`。
 *
 * 和 workbuddy 插件的 `-catalog.json` 同思路 —— DSH 的插件日志默认不进
 * `/app/.dsh-web.log`，只看日志无法判断一个渠道到底有没有注册成功、当前是
 * 「未登录」还是「已就绪」。这份文件把结果固化下来，排查时直接看它即可。
 */
function writeState(patch) {
  try {
    const path = join(resolveDshHome(), ".trae-connect-state.json");
    writeFileSync(path, `${JSON.stringify({ ...patch, at: new Date().toISOString() }, null, 2)}\n`, "utf8");
  } catch { /* 落盘失败不影响渠道本身 */ }
}

/**
 * 启动：起回环 shim → 注册 `trae` provider → 按凭据轮询刷新。
 *
 * 无论有没有凭据都先注册 provider —— DSH 用「模型组为空」来隐藏一个模型组，
 * 所以登录发生在 DSH 已经跑起来之后也能生效，不需要重新注册。
 */
export function apply(ctx, config) {
  let stopped = false;
  const current = () => config ?? {};
  const settings = () => ({
    function: TRAE_FUNCTIONS.includes(current().function) ? current().function : DEFAULT_FUNCTION,
    inlineSystemPrompt: current().inlineSystemPrompt !== false,
  });

  const store = createCredentialStore({ config: current, logger: ctx.logger });
  const catalog = createCatalog({ config: current });
  const client = createTraeClient({ logger: ctx.logger });
  const account = createTraeAccountClient({ logger: ctx.logger });
  const rateClient = createTraeRateClient({ logger: ctx.logger });

  const shim = createTraeShim({ store, client, catalog, settings, logger: ctx.logger });

  // 渠道状态页（渠道名 / 剩余积分 / 签到）走的是 DSH 自己的 webServer，
  // 不是回环 shim —— 前者给浏览器同源读取，后者只给 pi-ai 发 OpenAI 请求。
  // webServer 在非 web profile 里不存在，所以用 ctx.inject 做可选依赖。
  ctx.inject(["webServer"], (webCtx) => {
    if (stopped) return;
    try {
      registerTraeStatusRoutes(webCtx, { store, catalog, account, settings });
    } catch (error) {
      ctx.logger?.warn("dsh-trae-connect: 状态路由注册失败（渠道本身不受影响）", error);
    }
  });

  shim.ready.then(() => {
    if (stopped) return;
    const { adapter, invalidate } = createTraeAdapter({ shim, catalog, settings, hidden: () => externalHidden(TRAE_PROVIDER) });
    const release = ctx.llm.registerAdapter([TRAE_PROVIDER], adapter);
    try {
      ctx.effect(() => () => { release(); shim.close(); });
    } catch {
      release();
      shim.close();
    }
    /**
     * 倍率的刷新状态机。
     *
     * 与凭据/目录巡检**分开计时**（前者 30s，这里默认 15 分钟）：一次全量响应约
     * 1.4 MB，按凭据频率打等于每天几百 MB，而上游定价是按小时甚至按天变的。
     *
     * 三条边界：
     * - **并发去重**：一次刷新还在飞就不再开第二次（上一轮没回来时又到点了）。
     * - **失败也推进时间戳**：否则下一轮巡检（30s 后）又会立刻重试，
     *   上游一挂就变成每 30s 打一次 1.4 MB。失败保留上一次的倍率。
     * - **换账号立刻重拉**：倍率是账号级的（会员折扣不同），沿用上一个账号的
     *   数值比显示"暂无"更糟。
     */
    let ratesAt = 0;
    let ratesUserId;
    let ratesInflight;
    const refreshRates = (credential) => {
      if (config?.rateEnabled === false) return undefined;
      if (ratesInflight !== undefined) return ratesInflight;
      ratesInflight = rateClient
        .fetchRates(credential, rateFunctions(current()))
        .then(
          (map) => {
            if (stopped) return;
            /**
             * 降级保护：`setRates` 是**全量替换**（上游没给某个模型 = 这个价不在了），
             * 但那条规则的前提是"这份文档是完整的"。上游偶尔会回一份**残缺**文档
             * （实测把 `X-Ide-Version-Code` 换小值就能复现：200、体积正常、条目少一半），
             * 直接替换会让倍率大面积消失 —— 正是这次要根治的症状。
             *
             * 判据：新文档对我们已有倍率的模型覆盖不到一半。真被砍价砍掉一半以上
             * 是极小概率事件，宁可多留一次旧值，也不要整列空掉。
             */
            const before = catalog.rateCoverage().covered;
            const projected = catalog.current().filter((m) => map.has(m.id)).length;
            if (before >= 4 && projected * 2 < before) {
              catalog.markRatesFailed(new Error(`上游只回了 ${map.size} 条、仅覆盖 ${projected}/${before} 个已有倍率的模型，判定为残缺响应`));
              ratesAt = Date.now();
              ctx.logger.warn(`dsh-trae-connect: 倍率响应残缺（${projected}/${before}），保留上一次的值`);
              return;
            }
            catalog.setRates(map);
            ratesAt = Date.now();
            const coverage = catalog.rateCoverage();
            ctx.logger.info(`dsh-trae-connect: 倍率已就绪（live ${coverage.covered}/${coverage.total} 个展示模型）`);
          },
          (error) => {
            if (stopped) return;
            catalog.markRatesFailed(error);
            ratesAt = Date.now();
            ctx.logger.warn(`dsh-trae-connect: 倍率刷新失败，沿用上一次的值 — ${briefMessage(error)}`);
          },
        )
        .finally(() => { ratesInflight = undefined; });
      return ratesInflight;
    };

    const refresh = () => {
      if (stopped) return;
      store.resolve().then(
        (credential) => {
          if (stopped) return;
          catalog.reload();
          invalidate();
          ctx.emit("llm/adapters-updated");
          // 换账号 → 倍率立刻重取（折扣是账号级的）；否则按自己的节奏走。
          if (ratesUserId !== credential.userId) {
            ratesUserId = credential.userId;
            ratesAt = 0;
            catalog.clearRates();
          }
          if (Date.now() - ratesAt >= rateInterval(current())) refreshRates(credential);
          const models = catalog.current();
          const coverage = catalog.rateCoverage();
          writeState({
            ready: true,
            provider: TRAE_PROVIDER,
            shim: shim.baseUrl(),
            userId: credential.userId || "",
            function: settings().function,
            catalogSource: catalog.source(),
            modelCount: models.length,
            models: models.map((m) => m.id),
            // 倍率的来源与新鲜度 —— 判断"界面上的倍率是不是实时的"直接看这三行。
            rateEnabled: config?.rateEnabled !== false,
            ratesSource: catalog.ratesSource(),
            ratesFetchedAt: catalog.ratesFetchedAt() === 0 ? undefined : new Date(catalog.ratesFetchedAt()).toISOString(),
            rateCoverage: `${coverage.covered}/${coverage.total}`,
            rateError: catalog.ratesError(),
          });
          ctx.logger.info(`dsh-trae-connect: Trae 已就绪（user=${credential.userId || "?"}，${models.length} 个模型，function=${settings().function}）`);
        },
        (error) => {
          if (stopped) return;
          const message = error instanceof Error ? error.message : String(error);
          writeState({ ready: false, provider: TRAE_PROVIDER, shim: shim.baseUrl(), function: settings().function, error: message });
          ctx.logger.warn(`dsh-trae-connect: 未就绪 — ${message}`);
        },
      );
    };
    refresh();
    const timer = setInterval(refresh, pollInterval(current()));
    timer.unref?.();
    ctx.effect(() => () => { clearInterval(timer); });
  }).catch((error) => {
    ctx.logger.error("dsh-trae-connect: 回环 shim 启动失败", error);
  });

  ctx.effect(() => () => { stopped = true; });
}

//#endregion
