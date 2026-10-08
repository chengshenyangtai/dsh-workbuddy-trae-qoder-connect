/**
 * dsh-qoder-connect —— 把 Qoder CN 订阅里的模型接入 DeepSeek Harness。
 *
 * 契约速查（完整背景见 docs/IMPLEMENTATION-NOTES.md「Qoder 渠道总览」）：
 *   · 凭据：App 会话（connect-auth/qoder-session.json，优先）或官方 PAT
 *     （connect-auth/qoder.pat），另有环境变量 QODERCN_PAT 等三条。
 *     PAT 不自动续期（官方明确不刷），jobToken 那层本模块自己刷。
 *   · 鉴权：COSY 签名而非裸 Bearer —— `buildCosyHeaders`；签名只覆盖
 *     实际发出的字节（先 encode 后 sign）。`sigPath` = pathname 去
 *     前导 `/algo`、不含 query。
 *   · 请求体经 `qoderEncodeBody` 双重编码（base64 + 自定义字母表 + 三段块旋转）。
 *   · 响应是**双层 SSE**：外层信封 `statusCodeValue/body`，内层才是 OpenAI delta；
 *     业务错误藏在信封里（HTTP 200 也可能失败）。
 *   · 两个平面别混：推理 `gateway.qoder.com.cn/algo/**`（COSY+Encode）；
 *     OpenAPI `openapi.qoder.com.cn/**`（裸 Bearer jobToken，额度/签到）。
 *   · 数据流：DSH ──OpenAI──▶ 回环 shim ──双层 SSE──▶ 网关（shim 与
 *     workbuddy/trae 同构：127.0.0.1 随机端口 + 随机 bearer）。
 *
 * @module dsh-qoder-connect
 */

import z from "@deepseek-ai/schemastery";
import { createCipheriv, createHash, publicEncrypt, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { briefMessage, hostIsLoopback, loopbackRequest, originIsLoopback, withLegacyImageBudget, writeJson } from "../../shared/http.js";
import { ProbeService, ProbeStore, probeModel } from "../../shared/probe.js";
import { pollInterval, readBody, writeState as writeChannelState } from "../../shared/node.js";
import { hiddenMatcher } from "../../shared/hidden.js";

//#region 常量

/** Cordis 插件名。必须与 cordis.patch.yml 里的 `id` 一致。 */
export const name = "llm-qoder";
/** 注册 provider 之前必须先拿到模型注册表。 */
export const inject = ["llm"];

/** DSH 里对用户展示的 provider id，也是模型选择器上那一组的名字（= 渠道名）。 */
const QODER_PROVIDER = "qoder1";
const QODER_DISPLAY_NAME = "Qoder CN";

/** 推理平面（COSY 签名 + `Encode=1`）。 */
const DEFAULT_GATEWAY = "https://gateway.qoder.com.cn";
/** OpenAPI 平面（普通 Bearer）：userinfo / 额度 / 签到活动。 */
const DEFAULT_OPENAPI = "https://openapi.qoder.com.cn";

/** PAT → jobToken。**不需要签名**，也不带 Encode。 */
const PATH_EXCHANGE = "/api/v1/jobToken/exchange";
const PATH_USERINFO = "/api/v1/userinfo";
/** 额度：参考实现那条路（COSY 签名）。 */
const PATH_QUOTA_LEGACY = "/api/v2/quota/usage";
/** 额度：**App 自己**打的那条（OpenAPI 平面 + 普通 Bearer），字段更全。 */
const PATH_ACCOUNT_USAGE = "/sash/api/v2/me/usage";
/** 「签到活动」状态：App 的 CampaignMainService 就是打这个。 */
const PATH_CAMPAIGNS = "/sash/api/v1/me/campaigns";
/** 模型目录。`Encode=1` 只约束请求体，GET 的响应是明文 JSON。 */
/**
 * [dsh-connect 2026-09-24 修正] 网关的模型目录在 **`/algo` 前缀**下。
 *
 * 实测：`/algo/api/v2/model/list?Encode=1` → 200（70KB 完整目录）；
 * 而少了 `/algo` 的老路径会被 ALB 挡成 **HTTP 503 Service Temporarily Unavailable**
 * （不是鉴权问题，所以很容易误判成"token 不对"）。同网关的 chat 路径本来就带 `/algo`，
 * 这条是唯一漏了前缀的。
 */
const PATH_MODELS = "/algo/api/v2/model/list?Encode=1";
/** 对话。CN 渠道的 agent 入口（pathname 部分；签名只覆盖它，不含 query）。 */
const PATH_CHAT = "/algo/api/v2/service/pro/sse/agent_chat_generation";
/**
 * 对话的完整路径 + 查询串。
 *
 * `Encode=1` 必须有（插件的请求体是编码过的）；`FetchKeys` / `AgentId` 是从
 * 社区 MIT 实现 `pi-provider-qoder` 抄来的，SDK 里的常量只有裸 pathname
 * （查询串由它的 wasm `prepareRequest` 补）。保险起见整串可配置：万一哪天服务端
 * 不认这两个参数，改配置即可，不用改代码。多带的查询参数一般会被忽略，
 * 而漏掉 `Encode=1` 是致命的，所以默认按「全带上」。
 */
const DEFAULT_CHAT_PATH = `${PATH_CHAT}?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;
/** CN 客户端身份。SDK 里 `Ji ? "qoderclicn" : "qodercli"`，CN 走前者。 */
const DEFAULT_SESSION_TYPE = "qoderclicn";

//#endregion
//#region COSY 客户端身份常量

/**
 * COSY 内置 RSA 公钥（用来加密临时的 aesKey）。
 * 与 Qoder CLI 同一份；换 key 只会在服务端轮换时发生。
 */
const QODER_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

/**
 * 客户端身份版本号。
 *
 * ⚠️ 这是**硬编码契约**：`Cosy-Version` 落后于 Qoder CLI 当前版本时，服务端会
 * 返回被裁剪过的模型列表（本地实测：CLI 1.1.61 对应 1.1.38 可用）。
 * 随 CLI 升级要复核这里。
 */
const COSY_VERSION = "1.1.38";
/** OpenAPI 平面用的是另一条版本线。 */
const COSY_OPENAPI_VERSION = "1.0.1";
/**
 * **网关平面**的 `Cosy-Clienttype`（只给 `buildCosyHeaders` 用）。
 *
 * ⚠️ 它和 OpenAPI 平面的值**不是同一个**，别共用 —— 曾经共用过，正是 2026-09-27
 * 「签到活动读不到」那次误判的根因：两个平面各有各的契约。
 */
const COSY_CLIENT_TYPE = "5";
/**
 * **OpenAPI 平面**的 `Cosy-ClientType`。
 *
 * App 主包里这是**全局唯一**常量，额度 / dataPolicy / partnerPlan / remoteControl /
 * 签到活动全都用它：
 *
 *   const Mh = Object.freeze({ clientType: 10, businessProduct: "app", sessionType: "app" });
 *   const YR = (t) => ({ …, "Cosy-ClientType": String(Mh.clientType), "User-Agent": "Qoder" });
 *
 * ## 为什么必须写 10
 *
 * `GET /sash/api/v1/me/campaigns`（签到活动）**按客户端类型门控**：用 5 会**稳定**返回
 * `{showCampaign:false, claimable:false, campaigns:[]}`。这个形状与「账号压根没有活动」
 * **完全一样**，于是被误判 —— 2026-09-27 实际踩到：据此把面板改成了"不适用"，
 * 而同一时刻桌面 App 用 10 拿到的是 `claimable:true`、`+100 credits`、`CLAIMABLE`。
 *
 * ## 换成 10 的副作用范围（已逐端点实测）
 *
 * 额度 / 成就 / 积分汇总 / 积分热力 / 活动限额 —— 两档响应**逐字节相同**；
 * 只有「签到活动」不同。验证脚本：`scripts/qoder-openapi-clienttype-compare.mjs`。
 */
const COSY_OPENAPI_CLIENT_TYPE = "10";
const COSY_DATA_POLICY = "disagree";

//#endregion
//#region Encode=1（Qoder 自定义 base64）

/** 自定义字母表：第 i 个字符替代标准 base64 的第 i 个字符。 */
const CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const ENC_TABLE = new Uint8Array(256);
for (let i = 0; i < 256; i += 1) ENC_TABLE[i] = i;
for (let i = 0; i < 64; i += 1) ENC_TABLE[STD_ALPHABET.charCodeAt(i)] = CUSTOM_ALPHABET.charCodeAt(i);
// Qoder 用 `$` 代替标准 base64 的 `=`。
ENC_TABLE["=".charCodeAt(0)] = "$".charCodeAt(0);

/**
 * 请求体编码：标准 base64 → 字母表重映射 → 三段块旋转。
 *
 *   标准串 std[0,n)，a = floor(n/3)
 *   密文 = map(std[n-a, n)) + map(std[a, n-a)) + map(std[0, a))
 *
 * 返回 Buffer 直接当请求体用。
 */
export function qoderEncodeBody(plain) {
  const std = Buffer.isBuffer(plain) ? plain.toString("base64") : Buffer.from(plain, "utf8").toString("base64");
  const n = std.length;
  const a = Math.floor(n / 3);
  const out = Buffer.allocUnsafe(n);
  let dst = 0;
  for (let i = n - a; i < n; i += 1) out[dst++] = ENC_TABLE[std.charCodeAt(i)];
  for (let i = a; i < n - a; i += 1) out[dst++] = ENC_TABLE[std.charCodeAt(i)];
  for (let i = 0; i < a; i += 1) out[dst++] = ENC_TABLE[std.charCodeAt(i)];
  return out;
}

//#endregion
//#region COSY 鉴权头

const md5 = (bytes) => createHash("md5").update(bytes).digest("hex");

/**
 * 签名只覆盖 pathname 去掉前导 `/algo`，**不含 query**。
 *
 * 例：`/algo/api/v2/model/list?Encode=1` → `/api/v2/model/list`。
 * 这一点错了会拿到 401 而不是 404，很容易误判成 token 失效。
 */
export function sigPathOf(url) {
  const p = new URL(url).pathname;
  return p.startsWith("/algo") ? p.slice("/algo".length) : p;
}

/** 机器码：优先用 Qoder 已落盘的那份，保证跨次稳定（否则服务端会当成新设备）。 */
export function resolveMachineId() {
  const candidates = [
    process.env.QODERCN_MACHINE_ID,
    join(homedir(), ".qoder-cn", ".auth", "machine_id"),
    join(homedir(), ".qoder", ".auth", "machine_id"),
  ].filter((p) => typeof p === "string" && p.length > 0);
  for (const path of candidates) {
    try {
      const value = readFileSync(path, "utf8").trim();
      if (value.length > 0) return value;
    } catch { /* 继续找下一个 */ }
  }
  const fallback = join(resolveDshHome(), "qoder", "machine-id");
  try {
    const value = readFileSync(fallback, "utf8").trim();
    if (value.length > 0) return value;
  } catch { /* 下面生成 */ }
  const generated = randomUUID();
  try {
    mkdirSync(dirname(fallback), { recursive: true });
    writeFileSync(fallback, `${generated}\n`, { mode: 0o600 });
  } catch { /* 只读环境就算了，本次进程内仍然一致 */ }
  return generated;
}

/** 平台串。SDK 会按 arch/os 拼，这里照抄。 */
function machineOs() {
  if (process.platform === "win32") return process.arch === "arm64" ? "aarch64_windows" : "x86_64_windows";
  if (process.platform === "darwin") return process.arch === "arm64" ? "aarch64_darwin" : "x86_64_darwin";
  return process.arch === "arm64" ? "aarch64_linux" : "x86_64_linux";
}

/**
 * 生成 `Authorization: Bearer COSY.<payloadB64>.<sig>` 及其配套 `Cosy-*` 头。
 *
 * `body` 必须是**最终要发出去的字节**（即已经过 {@link qoderEncodeBody} 的那份），
 * 因为签名和 `Cosy-Bodyhash` / `Cosy-Bodylength` 都覆盖它。
 */
export function buildCosyHeaders(body, requestUrl, creds) {
  if (typeof creds?.userID !== "string" || creds.userID.length === 0) throw new Error("cosy: userID 为空");
  /**
   * [dsh-connect 2026-09-24 修正] token 的字段名有两套：
   * token-manager 产出的凭据对象用 `jobToken`，而 userinfo 那一步是显式传 `authToken`。
   * 之前只认 `authToken` → 目录刷新每次都抛「cosy: authToken 为空」，
   * 表现成"已登录但模型永远只有兜底那一个"。两者都认即可。
   */
  const authToken = typeof creds?.authToken === "string" && creds.authToken !== "" ? creds.authToken : creds?.jobToken;
  if (typeof authToken !== "string" || authToken.length === 0) throw new Error("cosy: authToken 为空");

  const aesKey = randomUUID().replace(/-/g, "").slice(0, 16);
  const userInfo = {
    uid: creds.userID,
    security_oauth_token: authToken,
    name: creds.name ?? "",
    aid: "",
    email: creds.email ?? "",
  };
  const cipher = createCipheriv("aes-128-cbc", Buffer.from(aesKey), Buffer.from(aesKey));
  const infoB64 = cipher.update(JSON.stringify(userInfo), "utf8", "base64") + cipher.final("base64");
  const cosyKey = publicEncrypt(
    { key: QODER_RSA_PUBLIC_KEY, padding: 1 /* RSA_PKCS1_PADDING */ },
    Buffer.from(aesKey),
  ).toString("base64");

  const ts = String(Math.floor(Date.now() / 1000));
  const payloadB64 = Buffer.from(JSON.stringify({
    version: "v1",
    requestId: randomUUID(),
    info: infoB64,
    cosyVersion: COSY_VERSION,
    ideVersion: "",
  })).toString("base64");

  const bodyBytes = body === undefined || body === null
    ? Buffer.alloc(0)
    : (Buffer.isBuffer(body) ? body : Buffer.from(body));
  const sig = createHash("md5")
    .update(payloadB64).update("\n")
    .update(cosyKey).update("\n")
    .update(ts).update("\n")
    .update(bodyBytes).update("\n")
    .update(sigPathOf(requestUrl))
    .digest("hex");

  const machineId = creds.machineID ?? resolveMachineId();
  return {
    Authorization: `Bearer COSY.${payloadB64}.${sig}`,
    "Cosy-Key": cosyKey,
    "Cosy-User": creds.userID,
    "Cosy-Date": ts,
    "Cosy-Version": COSY_VERSION,
    "Cosy-Machineid": machineId,
    "Cosy-Machinetoken": machineId,
    "Cosy-Machinetype": "5",
    "Cosy-Machineos": machineOs(),
    "Cosy-Clienttype": COSY_CLIENT_TYPE,
    "Cosy-Clientip": "127.0.0.1",
    "Cosy-Bodyhash": md5(bodyBytes),
    "Cosy-Bodylength": String(bodyBytes.length),
    "Cosy-Sigpath": sigPathOf(requestUrl),
    "Cosy-Data-Policy": COSY_DATA_POLICY,
    "Cosy-Organization-Id": "",
    "Cosy-Organization-Tags": "",
    "Login-Version": "v2",
    "X-Request-Id": randomUUID(),
  };
}

//#endregion
//#region 配置

/**
 * ⚠️ **本模块不导出 `Config`，也不接受用户配置**（2026-10-08 收口，理由同 trae）。
 *
 * 三合一时本模块被 `lib/index.js` 以 `apply(ctx, {})` 调起 —— 第二个参数恒为
 * 空对象，导出的 `Config` 对宿主不可见。保留 schema 只会让读者误以为这些键
 * 可以设。因此撤下；内部读取点保持 `config()?.x ?? DEFAULT` 原样，
 * config 恒空时自然落到内置默认，运行时行为与收口前一致。
 *
 * 被撤下的键（均有内置默认）：patFile、gateway、openapiBase、chatPath、
 * sessionType、pollIntervalMs。
 *
 * ⚠️ 覆盖通道不受本次收口影响的只有一条：PAT 本体可经**环境变量**
 * `QODERCN_PAT` / `QODERCN_PERSONAL_ACCESS_TOKEN` / `QODERCN_API_KEY`
 * 提供（见 `fromEnv()`）—— 这是运行凭据的正规入口，不属于配置面。
 */

/**
 * 解析路径默认值 —— 必须在 DSH_HOME 可用之后才能求值。
 *
 * [2026-09-25] 认证统一收进 `$DSH_HOME/connect-auth/`（见 trae 那边的同一条说明）：
 * PAT 与 App 会话都放这里，迁移只需搬一个目录。旧路径仍可用 `patFile` / `sessionFile`
 * 配置项指回。
 */
function defaultPatPath() {
  return join(resolveDshHome(), "connect-auth", "qoder.pat");
}

//#endregion
//#region 凭据（PAT）

/**
 * PAT 读取器。
 *
 * 每次 `resolve()` 都重新读盘 + 重新读环境变量，所以宿主侧换 PAT 之后**不用重启
 * DSH** 就能生效（与 WorkBuddy / Trae 两条路一致）。
 */
/**
 * [dsh-connect] App 会话凭据：读宿主导出的 Qoder CN 桌面 App 登录态。
 *
 * 为什么要它：官方 PAT 要在网页上手工自建，而 App 本来就已经登录好了。
 * 实测 App 的会话 token（`dt-` 前缀）在 **两个平面都是有效的 Bearer** ——
 * OpenAPI（userinfo/额度/签到）与推理（COSY 头里带的就是它），
 * 所以不需要 PAT 交换，uid 也直接来自会话（不必再问 userinfo）。
 *
 * 文件由宿主脚本 `scripts/qoder-vault.mjs --install-session` 写出（Electron safeStorage 解密）：
 *   $DSH_HOME/connect-auth/qoder-session.json   {token, refreshToken, expiresAt, uid, name, email}
 *
 * 读不到 / 过期 / 格式不对，一律返回 undefined，调用方回落到 PAT。
 */
export function createSessionStore(options) {
  const { config } = options;
  const explicitPath = () => {
    const value = config()?.sessionFile;
    return typeof value === "string" && value.length > 0 ? value : join(resolveDshHome(), "connect-auth", "qoder-session.json");
  };

  return {
    path: explicitPath,
    /** 当前可用的会话凭据；不可用时 undefined（不抛，因为 PAT 还能兜底）。 */
    async current() {
      const path = explicitPath();
      if (!existsSync(path)) return undefined;
      let doc;
      try {
        doc = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        return undefined;
      }
      const token = typeof doc?.token === "string" ? doc.token.trim() : "";
      const uid = typeof doc?.uid === "string" ? doc.uid.trim() : "";
      if (token === "" || uid === "") return undefined;
      // 过期就用不了（App 会自己续；续完重跑导出脚本即可）
      const expiresAt = resolveExpiry({ expires_at: doc?.expiresAt, expiresAt: doc?.expiresAt }) ?? 0;
      if (expiresAt !== 0 && expiresAt - JOB_TOKEN_SKEW_MS <= Date.now()) return undefined;
      return {
        token,
        uid,
        name: typeof doc?.name === "string" ? doc.name : "",
        email: typeof doc?.email === "string" ? doc.email : "",
        expiresAt: expiresAt === 0 ? Date.now() + ASSUMED_JOB_TOKEN_TTL_MS : expiresAt,
        source: path,
      };
    },
  };
}

export function createPatStore(options) {
  const { config } = options;
  const explicitPath = () => {
    const value = config()?.patFile;
    return typeof value === "string" && value.length > 0 ? value : defaultPatPath();
  };

  const fromEnv = () => {
    for (const key of ["QODERCN_PAT", "QODERCN_PERSONAL_ACCESS_TOKEN", "QODERCN_API_KEY"]) {
      const value = process.env[key];
      if (typeof value === "string" && value.trim().length > 0) return { pat: value.trim(), source: key };
    }
    return undefined;
  };

  const fromFile = () => {
    const path = explicitPath();
    if (!existsSync(path)) return undefined;
    try {
      const value = readFileSync(path, "utf8").trim();
      return value.length > 0 ? { pat: value, source: path } : undefined;
    } catch {
      return undefined;
    }
  };

  return {
    path: explicitPath,
    /**
     * 取 PAT。读不到就抛，由调用方降级成「未登录」。
     *
     * 环境变量优先于文件：便于临时用另一个账号跑一次而不动落盘的凭据。
     */
    async resolve() {
      const found = fromEnv() ?? fromFile();
      if (found === undefined) {
        throw new Error(`未配置 Qoder PAT：既没有 QODERCN_PAT/QODERCN_PERSONAL_ACCESS_TOKEN/QODERCN_API_KEY，也读不到 ${explicitPath()}。请到 https://qoder.com.cn/account/integrations 建一个 pt- 开头的 PAT。`);
      }
      if (!found.pat.startsWith("pt-")) {
        throw new Error(`${found.source} 里的令牌不是 pt- 前缀，Qoder 的 PAT 形如 pt-xxxxxxxx。`);
      }
      return found;
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

//#endregion
//#region jobToken 管理

/** 换来的 jobToken 还剩不到这个时长就提前重换一次。 */
const JOB_TOKEN_SKEW_MS = 120000;

/**
 * `expires_at` 在 Qoder 的返回里可能是 ISO 串、秒级数字或毫秒级数字；
 * `expires_in` 可能是秒也可能是毫秒。全部宽容处理，读不出来就返回 undefined
 * （调用方按「保守 30 分钟」处理）。
 */
export function resolveExpiry(doc) {
  const at = doc?.expires_at;
  if (typeof at === "string") {
    const parsed = Date.parse(at);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof at === "number" && Number.isFinite(at)) return at < 1e12 ? at * 1000 : at;
  const inSecondsOrMs = doc?.expires_in;
  if (typeof inSecondsOrMs === "number" && Number.isFinite(inSecondsOrMs) && inSecondsOrMs > 0) {
    return Date.now() + (inSecondsOrMs < 1e6 ? inSecondsOrMs * 1000 : inSecondsOrMs);
  }
  return undefined;
}

/** 保守兜底：拿不到有效期时按 30 分钟算。 */
const ASSUMED_JOB_TOKEN_TTL_MS = 1800000;

/**
 * PAT → jobToken 的管理器。
 *
 * 一次成功的交换缓存起来；并发调用只会打一次上游（single-flight）。
 * jobToken 过期就重新用 PAT 换 —— PAT 本身不会过期（除非用户在网页上吊销）。
 */
export function createTokenManager(options) {
  const { pats, sessions, logger, config } = options;
  const openapiBase = () => String(config()?.openapiBase ?? DEFAULT_OPENAPI).replace(/\/+$/, "");

  /** @type {{ jobToken: string, expiresAt: number, userID: string, name: string, email: string, machineID: string, source: string }|undefined} */
  let cached;
  /** @type {Promise<unknown>|undefined} */
  let inflight;

  /** PAT 交换。不需要签名，也不带 Encode —— 这是唯一一条「裸」请求。 */
  async function exchange(pat) {
    const url = `${openapiBase()}${PATH_EXCHANGE}`;
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "dsh-qoder-connect",
          "Cosy-Version": COSY_OPENAPI_VERSION,
          "Cosy-ClientType": COSY_CLIENT_TYPE,
        },
        body: JSON.stringify({ personal_token: pat }),
        signal: AbortSignal.timeout(20000),
      });
    } catch (error) {
      throw new Error(`连不上 Qoder OpenAPI（${openapiBase()}）：${error instanceof Error ? error.message : String(error)}`);
    }
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      const brief = text.replace(/\s+/g, " ").slice(0, 200);
      if (response.status === 401 || response.status === 403) {
        throw new Error(`PAT 被拒绝（HTTP ${response.status}）：可能已吊销或填错。${brief}`);
      }
      throw new Error(`PAT 交换失败（HTTP ${response.status}）：${brief}`);
    }
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      throw new Error(`PAT 交换返回的不是 JSON：${text.slice(0, 200)}`);
    }
    const jobToken = typeof doc?.token === "string" ? doc.token.trim() : "";
    if (jobToken.length === 0) throw new Error(`PAT 交换没有返回 token：${text.slice(0, 200)}`);
    return {
      jobToken,
      refreshToken: typeof doc?.refresh_token === "string" ? doc.refresh_token : "",
      expiresAt: resolveExpiry(doc) ?? (Date.now() + ASSUMED_JOB_TOKEN_TTL_MS),
    };
  }

  /** userinfo：补上 COSY 签名需要的 uid/name/email。 */
  async function fetchUserInfo(creds) {
    const url = `${openapiBase()}${PATH_USERINFO}`;
    const response = await fetch(url, {
      headers: { ...buildCosyHeaders(null, url, creds), Accept: "application/json", "User-Agent": "dsh-qoder-connect" },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      throw new Error(`userinfo 返回 HTTP ${response.status}：${(await response.text().catch(() => "")).slice(0, 200)}`);
    }
    const doc = await response.json().catch(() => undefined);
    return {
      userID: typeof doc?.id === "string" ? doc.id : "",
      email: typeof doc?.email === "string" ? doc.email : "",
      name: typeof doc?.name === "string" ? doc.name : (typeof doc?.username === "string" ? doc.username : ""),
    };
  }

  async function refresh() {
    const machineID = resolveMachineId();

    // —— 优先用 App 会话：不需要 PAT、不需要 userinfo 往返 ——
    // 实测 App 的会话 token 在两个平面都有效（OpenAPI 200；推理平面 COSY 头里用的就是它）。
    if (sessions !== undefined) {
      const session = await sessions.current().catch(() => undefined);
      if (session !== undefined) {
        cached = {
          jobToken: session.token,
          expiresAt: session.expiresAt,
          userID: session.uid,
          name: session.name,
          email: session.email,
          machineID,
          source: session.source,
        };
        logger?.debug?.(`dsh-qoder-connect: 使用 App 会话凭据（uid=${cached.userID}，有效期至 ${new Date(cached.expiresAt).toISOString()}）`);
        return cached;
      }
    }

    const { pat, source } = await pats.resolve();
    const exchanged = await exchange(pat);

    // userinfo 要 uid 才能签，而 uid 又要拿 jobToken 去问 —— 先要一次再补全。
    const identity = await fetchUserInfo({ userID: "", authToken: exchanged.jobToken, machineID }).catch(async (error) => {
      logger?.warn(`dsh-qoder-connect: userinfo 读取失败（额度与签到会缺账号名，推理不受影响）：${error instanceof Error ? error.message : String(error)}`);
      return { userID: "", email: "", name: "" };
    });
    if (identity.userID === "") {
      // uid 拿不到就签不出 COSY，等于不能用。
      throw new Error("Qoder userinfo 没有返回用户 id，无法生成 COSY 签名（PAT 可能已失效）。");
    }

    cached = {
      jobToken: exchanged.jobToken,
      expiresAt: exchanged.expiresAt,
      userID: identity.userID,
      name: identity.name,
      email: identity.email,
      machineID,
      source,
    };
    logger?.debug?.(`dsh-qoder-connect: jobToken 已刷新（uid=${cached.userID}，有效期至 ${new Date(cached.expiresAt).toISOString()}）`);
    return cached;
  }

  return {
    /** 拿一份当前可用的凭据；过期或缺失就重换。 */
    async get() {
      if (cached !== undefined && cached.expiresAt - JOB_TOKEN_SKEW_MS > Date.now()) return cached;
      if (inflight === undefined) {
        inflight = refresh().finally(() => { inflight = undefined; });
      }
      return inflight;
    },
    /** 只读快照，不触发刷新；状态路由用它避免每次打开面板都打上游。 */
    peek() {
      return cached;
    },
    /** 强制重换（PAT 在网页上被吊销后，用户改了 pat 文件等场景）。 */
    invalidate() {
      cached = undefined;
    },
  };
}

//#endregion
//#region 模型目录

/**
 * 拿不到目录时的兜底名单。
 *
 * **只放确认存在的 key。** 目录是懒加载的（要先有可用 jobToken），在第一次成功
 * 拉取之前模型组得有东西，否则 DSH 会按「模型组为空」把它整个隐藏掉。
 *
 * `qmodel_38max` 是从本机 Qoder CN 的运行清单里读到的真实 key
 * （`~/.qoder-cn/logs/runs/&lt;run_id&gt;/manifest.json` 的 `--model` 参数）；
 * 其余模型一律等网关目录返回，不猜名字。
 */
export const FALLBACK_QODER_MODELS = [
  // `isReasoning`/`declaredEfforts` 取自上游目录实测（2026-10-06）：
  // Qwen3.8-Max 声明 xhigh/low/medium。早期这里写死 `isReasoning: false`，
  // 恰好演示了那个坑 —— 判断档位要看 `declaredEfforts`，不是 `isReasoning`。
  { id: "qmodel_38max", name: "Qwen3.8-Max", contextWindow: 200000, maxTokens: 32000, supportsImages: false, isReasoning: true, declaredEfforts: ["xhigh", "low", "medium"], defaultEffort: "medium", isFree: false, rate: undefined },
];

/** 宽松取数：数字或数字串都认（SDK 的 `oci()` 就是这么写的）。 */
function toNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** 宽松取布尔（SDK 的 `aci()`）。 */
function toBoolean(value) {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  return undefined;
}

/** 目录最大可用的上下文窗口：优先 `context_config` 里最大的 token_count。 */
function contextWindowOf(entry) {
  const config = entry?.context_config;
  if (config !== null && typeof config === "object" && !Array.isArray(config)) {
    let best;
    for (const window of Object.values(config)) {
      const count = toNumber(window?.token_count);
      if (count !== undefined && (best === undefined || count > best)) best = count;
    }
    if (best !== undefined) return best;
  }
  const maxInput = toNumber(entry?.max_input_tokens ?? entry?.maxInputTokens);
  if (maxInput !== undefined && maxInput > 0) return maxInput;
  return undefined;
}

/**
 * 把网关的 `chat[]` 条目归一化成本插件内部形状。
 *
 * 字段名以 `@qoder-ai/qoder-cn-agent-sdk` 的 `sci()` 为准（那里是 camelCase 与
 * snake_case 都认）——**倍率就是 `price_factor`**，界面上按 `<n>×` 显示。
 */
/**
 * 解析上游的 `thinking_config` → 档位声明。
 *
 * ## 为什么要单独解析它
 *
 * `is_reasoning` **不是**"支不支持思考档位"。实测反例（2026-10-06，原始目录）：
 *
 * | 模型 | is_reasoning | thinking_config.enabled.efforts |
 * |---|---|---|
 * | DeepSeek-Flash (`dfmodel`) | **false** | **high / max / low** |
 * | Kimi-K3 (`kmodel_latest`) | **false** | **high / low / max** |
 * | Qwen3.8-Max (`qmodel_38max`) | true | **xhigh / low / medium** |
 * | Qwen3.7-Plus (`qmodel`) | true | （空） |
 *
 * `is_reasoning` 的含义是"是否**专用**思考模型"（Flash 系列不是），所以
 * DeepSeek-Flash 标 false 是**上游的正确表述**，别拿它当"不支持档位"。
 * 真正的档位声明在 `thinking_config.enabled.efforts` 这个字典里，**逐模型不同**。
 *
 * @returns `{ declared, defaultEffort, canDisable }`；无配置时 declared 为空数组。
 */
function parseThinkingConfig(raw) {
  const enabled = raw?.thinking_config?.enabled;
  const efforts = enabled?.efforts !== null && typeof enabled?.efforts === "object" ? enabled.efforts : undefined;
  const declared = efforts === undefined ? [] : Object.keys(efforts);
  const defaultEffort = efforts === undefined
    ? undefined
    : (Object.entries(efforts).find(([, v]) => v?.is_default === true)?.[0]);
  // `disabled` 段存在 = 上游提供"关闭思考"这一档（对应 id 后缀 @nothink）。
  const canDisable = raw?.thinking_config?.disabled !== null && typeof raw?.thinking_config?.disabled === "object";
  return { declared, defaultEffort, canDisable };
}

export function normalizeCatalogEntry(raw) {
  const key = String(raw?.key ?? raw?.model_key ?? "").trim();
  if (key.length === 0) return undefined;
  const enabled = raw?.enable === undefined ? true : (toBoolean(raw.enable) ?? true);
  const rate = toNumber(raw?.price_factor ?? raw?.priceFactor);
  const free = toBoolean(raw?.is_free ?? raw?.isFree) ?? (rate === 0);
  const thinking = parseThinkingConfig(raw);
  return {
    id: key,
    name: String(raw?.display_name ?? raw?.name ?? key) || key,
    contextWindow: contextWindowOf(raw),
    maxTokens: toNumber(raw?.max_output_tokens) ?? 32000,
    supportsImages: toBoolean(raw?.is_vl) === true,
    isReasoning: toBoolean(raw?.is_reasoning) === true,
    /**
     * 上游声明的档位（逐模型不同）。**空数组表示上游没声明** —— 不等于"不支持"，
     * 实测 `qmodel` 声明为空却接受全部档位，所以这种情况交给探查实测。
     */
    declaredEfforts: thinking.declared,
    defaultEffort: thinking.defaultEffort,
    canDisableThinking: thinking.canDisable,
    isFree: free,
    rate,
    originalRate: toNumber(raw?.original_price_factor ?? raw?.originPriceFactor),
    promotion: raw?.promotion !== null && typeof raw?.promotion === "object" ? raw.promotion : undefined,
    source: typeof raw?.source === "string" ? raw.source : "system",
    outerProvider: typeof raw?.outer_provider === "string" ? raw.outer_provider : undefined,
    enabled,
  };
}

/**
 * 模型目录。
 *
 * 与 WorkBuddy / Trae 两条路不同，Qoder 的目录是**懒加载 + 快照兜底**：
 * 只有拿到可用 jobToken 才会去拉一次，拉到就缓存；失败保留上一次的结果（或者
 * 兜底名单），绝不让「目录暂时不可用」升级成「渠道消失」。
 */
export function createCatalog(options) {
  const { tokens, logger, config } = options;
  const gateway = () => String(config()?.gateway ?? DEFAULT_GATEWAY).replace(/\/+$/, "");

  let models = [...FALLBACK_QODER_MODELS];
  let source = "fallback";
  let fetchedAt = 0;
  let lastError;

  /** 打一次 `GET /api/v2/model/list?Encode=1`（COSY 签名，响应是明文 JSON）。 */
  async function fetchFromRemote(credential) {
    const url = `${gateway()}${PATH_MODELS}`;
    const response = await fetch(url, {
      headers: { ...buildCosyHeaders(null, url, credential), Accept: "application/json", "User-Agent": "dsh-qoder-connect" },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      throw new Error(`model/list 返回 HTTP ${response.status}：${(await response.text().catch(() => "")).slice(0, 300)}`);
    }
    const doc = await response.json().catch(() => undefined);
    const chat = Array.isArray(doc?.chat) ? doc.chat : [];
    const usable = chat.map((entry) => normalizeCatalogEntry(entry)).filter((entry) => entry !== undefined && entry.enabled);
    if (usable.length === 0) throw new Error(`model/list 没有返回任何可用模型（chat 长度 ${chat.length}）`);
    return usable;
  }

  /** 刷新目录。并发调用共享同一次上游请求。 */
  let inflight;
  async function reload() {
    if (inflight === undefined) {
      inflight = (async () => {
        const credential = await tokens.get();
        const list = await fetchFromRemote(credential);
        models = list;
        source = "remote";
        fetchedAt = Date.now();
        lastError = undefined;
        logger?.info?.(`dsh-qoder-connect: 目录已刷新，${list.length} 个模型可用`);
        return list;
      })().catch((error) => {
        lastError = error instanceof Error ? error.message : String(error);
        logger?.warn?.(`dsh-qoder-connect: 目录刷新失败，沿用${source === "remote" ? "上次快照" : "兜底名单"}：${lastError}`);
        throw error;
      }).finally(() => { inflight = undefined; });
    }
    return inflight;
  }

  return {
    reload,
    source: () => source,
    fetchedAt: () => fetchedAt,
    lastError: () => lastError,
    current: () => models,
    find: (id) => models.find((model) => model.id === id),
  };
}

//#endregion
//#region 上游对话客户端

/** 逐字节喂入的 SSE 读取器：`event:<name>\n` + `data:<payload>\n\n`。 */
export function createSseReader() {
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";
  const dataLines = [];
  const pending = [];

  const flush = () => {
    if (eventName === "" && dataLines.length === 0) return;
    const raw = dataLines.join("\n");
    pending.push({ event: eventName === "" ? "message" : eventName, raw });
    eventName = "";
    dataLines.length = 0;
  };

  return {
    push(bytes) {
      buffer += decoder.decode(bytes, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line === "") { flush(); continue; }
        if (line.startsWith("event:")) { eventName = line.slice(6).trim(); continue; }
        if (line.startsWith("data:")) { dataLines.push(line.slice(5).replace(/^ /, "")); continue; }
      }
      const out = pending.slice();
      pending.length = 0;
      return out;
    },
    /**
     * 流结束时的收尾（2026-10-08 加，与 Trae 侧同形）。
     *
     * 事件分隔靠空行，最后一个事件没有尾随换行时会一直留在 `buffer` 里被丢掉
     * （实测 `"event: a\ndata: 1"` → `[]`）。被截断的流最容易缺这个空行，
     * 而丢掉的又可能是 `[DONE]`／终态事件，于是正常收尾与截断分不出来。
     */
    end() {
      buffer += decoder.decode();
      const tail = buffer.replace(/\r$/, "");
      buffer = "";
      if (tail !== "") {
        if (tail.startsWith("event:")) eventName = tail.slice(6).trim();
        else if (tail.startsWith("data:")) dataLines.push(tail.slice(5).replace(/^ /, ""));
      }
      flush();
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

/** Qoder 的 SSE 控制哨兵（见 SDK 的 `giA()`）。 */
function isControlSentinel(raw) {
  return raw === "[DONE]"
    || raw === "[NOT_EXCEED_QUOTA]"
    || raw.startsWith("[EXCEED_QUOTA]")
    || raw.startsWith("[NOTIFICATIONS]");
}

/**
 * 解开一层 Qoder 信封。
 *
 * Qoder 的 `data:` 有两层：
 *   data: {"statusCodeValue":200,"statusCode":200,"body":"{\"choices\":[...]}"}
 * 其中 `body` 是**字符串**，里面才是 OpenAI 形状的 chunk；也可能是 `"[DONE]"`。
 *
 * 返回：
 *   `{kind:"chunk", chunk}`   内层是普通 chunk
 *   `{kind:"done"}`           流结束
 *   `{kind:"error", code, message}` 上游业务错误（code 来自 statusCodeValue）
 *   `{kind:"ignore"}`         控制哨兵 / 空事件
 */
/**
 * 判断一条 403 错误是不是**凭据失效**。
 *
 * 为什么要看文案而不是只看状态码（2026-10-08 实测）：Qoder 用 403 表示两种
 * 完全不同的事 ——
 *   · `{"code":"110","message":"Billing daily count exceeded"}` = 当日调用次数超限
 *   · 真正的 token 失效 / PAT 被吊销
 * 两者状态码相同。若一律当凭据问题，就会出现「刷新 token → 再打一次 → 还是
 * 403 → 用户看到"API 密钥无效"」这种误导性提示，还白花一次请求。
 *
 * 判据：403 的正文里出现凭据类词汇才算。命中即视为可重试的凭据问题。
 */
export function isCredentialRejection(message) {
  const text = typeof message === "string" ? message.toLowerCase() : "";
  if (text === "") return false;
  // 明确的"额度/限额"语义优先否决，避免 billing/unauthorized 之类的交叉词误判。
  if (/billing|quota|exceed|rate.?limit|too many|额度|限额/.test(text)) return false;
  return /token|credential|api.?key|unauthori|auth|invalid|expire|登录|凭据|密钥/.test(text);
}

/**
 * 额度/限流类失败的判据（与 {@link isCredentialRejection} 互补）。
 *
 * 实测（2026-10-08）：Qoder 的当日次数超限走 `403 code:110
 * "Billing daily count exceeded"` —— 是额度语义，不是凭据失效。
 */
export function isQuotaRejection(message) {
  const text = typeof message === "string" ? message.toLowerCase() : "";
  if (text === "") return false;
  /**
   * 中英双语都要覆盖：本机实测出现过的原文是
   *   · `{"code":"110","message":"Billing daily count exceeded"}`
   *   · WorkBuddy 侧同族文案 `您的使用量已超出频率限制，将在 … 重置`
   * 少一种语言，那条失败就还会被当成密钥问题。
   */
  return /billing|quota|exceed|rate.?limit|too many|usage limit|额度|限额|次数|频率限制|使用量已超出|超出频率/.test(text);
}

/**
 * 抹掉文案里的裸 HTTP 状态码。
 *
 * DSH 前端用 `classifyPiAiError(message)` **从错误文案里猜类别**，判定顺序是：
 *
 *   1. `/\b(?:401|403)\b/`             → `AUTH`
 *   2. `isQuotaExceededError(message)`  → `QUOTA`
 *   3. `/\b429\b|rate.?limit/`          → `RATE_LIMIT`
 *   4. `/\b(?:413|400)\b/`              → `INVALID_REQUEST`
 *   5. `/\b5\d\d\b/`                    → `SERVER`
 *
 * 顺序决定了一件要命的事：**文案里只要出现 401/403 这三个数字，额度错误也会被判成
 * `AUTH`**。而 `AUTH` 在前端会把原文**整条丢弃**（`displayFailure` 对 AUTH 只返回
 * 空 message），于是用户看到的是「API 密钥无效」——真实原因完全不可见，还会被误导
 * 去找密钥问题（凭据其实一直有效，同凭据探测能正常打上游）。
 *
 * 所以额度类失败在渲染前把状态码换成**词**：保留诊断信息，同时不再被前面的分支抢走。
 */
export function neutralizeStatusTokens(text) {
  return String(text ?? "")
    .replace(/\b(?:401|403)\b/g, "denied")
    .replace(/\b429\b/g, "rate-limited")
    .replace(/\b413\b/g, "too-large")
    .replace(/\b400\b/g, "bad-request")
    .replace(/\b5\d\d\b/g, "server-error");
}

/**
 * 把上游失败渲染成**宿主能正确分类**的文案。
 *
 * 额度/限流类：改用宿主认得的措辞（`usage limit exceeded`）并抹掉状态码，
 * 让它落进 `QUOTA`/`RATE_LIMIT`，前端就会显示额度提示而不是"API 密钥无效"。
 * 其余（含真正的凭据失效）保持原文 —— 那些本来就该按状态码分类。
 */
export function describeUpstreamFailure(status, message) {
  const text = typeof message === "string" ? message : String(message ?? "");
  if (isQuotaRejection(text)) {
    return `Qoder 上游额度限制：usage limit exceeded（当日调用次数或额度已达上限，额度恢复后可继续使用）。上游原文：${neutralizeStatusTokens(text).slice(0, 300)}`;
  }
  return `qoder upstream (http ${status}): ${text.slice(0, 400)}`;
}

export function unwrapQoderEvent(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") return { kind: "ignore" };
  if (text === "[DONE]") return { kind: "done" };
  if (text === "[NOT_EXCEED_QUOTA]") return { kind: "ignore" };
  if (text.startsWith("[EXCEED_QUOTA]")) return { kind: "error", code: 429, message: "Qoder 额度已用尽（EXCEED_QUOTA）" };
  if (text.startsWith("[NOTIFICATIONS]")) return { kind: "ignore" };

  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    return { kind: "ignore" };
  }

  // 带信封的形状。
  if (envelope !== null && typeof envelope === "object" && envelope.statusCodeValue !== undefined && envelope.body !== undefined) {
    const code = toNumber(envelope.statusCodeValue);
    if (code !== undefined && code !== 200) {
      const detail = typeof envelope.body === "string" ? envelope.body : JSON.stringify(envelope.body);
      /**
       * **带上 `code`**（2026-10-08 加）：业务级 401/403 藏在这个信封里，
       * 而调用方要靠它判断"是不是凭据问题、要不要 invalidate 后重试"。
       * 修之前这里只给 message，于是凭据失效走不到重试分支 ——
       * 表现成「整轮失败：API 密钥无效」，而下一轮又正常。
       */
      return { kind: "error", code, message: `Qoder 上游 ${code}：${detail.slice(0, 400)}` };
    }
    const body = envelope.body;
    if (typeof body !== "string") {
      // 有的实现直接把对象塞在 body 里。
      return body !== null && typeof body === "object" ? { kind: "chunk", chunk: body, envelope } : { kind: "ignore" };
    }
    const inner = body.trim();
    if (inner === "") return { kind: "ignore" };
    if (inner === "[DONE]") return { kind: "done" };
    if (isControlSentinel(inner)) return { kind: "ignore" };
    try {
      return { kind: "chunk", chunk: JSON.parse(inner), envelope };
    } catch {
      return { kind: "ignore" };
    }
  }

  // 裸 OpenAI chunk（防御性：万一服务端换了形状）。
  if (envelope !== null && typeof envelope === "object" && Array.isArray(envelope.choices)) {
    return { kind: "chunk", chunk: envelope };
  }
  return { kind: "ignore" };
}

/** 把 Qoder 的 delta 翻成 OpenAI 的 delta。 */
function deltaOf(chunk) {
  const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : undefined;
  const delta = choice?.delta;
  if (delta === null || typeof delta !== "object") return undefined;
  const out = {};
  if (typeof delta.content === "string" && delta.content.length > 0) out.content = delta.content;
  // Qoder 的思考链字段就叫 reasoning_content（与 DeepSeek 一致）。
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) out.reasoning_content = delta.reasoning_content;
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) out.tool_calls = delta.tool_calls;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 组装对话请求体（OpenAI 形状 + Qoder 专有字段）。 */
/**
 * pi-ai 的思考档位键空间（宿主契约，**不可扩展**）。
 *
 * 取自 pi-ai 源码 `THINKING_LEVELS`（`Object.keys({off,minimal,low,medium,high,xhigh,max})`），
 * 按"强度递增"排列。`thinkingLevelMap` 的**键**必须落在这个集合里，多一个键会被
 * 宿主忽略、少一个就少一档可选。
 *
 * ⚠️ 这里固定的是**键**（宿主定死的），不是"哪些键可用"——后者由上游声明
 * （`declaredEfforts`）与探查实测决定，见 {@link reasoningFieldsFor}。
 * 早先的错误做法是拿一个写死的 5 档子集当"上游支持集"，那既漏了 `xhigh`，
 * 又让探查永远找不到新档位。
 */
export const PI_AI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * 该渠道**可能**在线上出现的档位（探查候选的上界）。
 *
 * = pi-ai 键空间去掉 `off`：实测上游对 `off` 返回 400，它不是"关思考"的拼写
 * （关思考走 id 后缀 `@nothink`）。其余键都值得一探 —— 包括上游今天没声明的，
 * 因为实测显示**声明为空 ≠ 不支持**（`qmodel` 声明空却接受 5 档）。
 */
export const PROBE_CANDIDATE_EFFORTS = PI_AI_THINKING_LEVELS.filter((level) => level !== "off");

/**
 * 算某个模型"支持哪些档位"：**上游声明 ∪ 探查实测**，并按强度排序。
 *
 * 唯一的档位真值来源，shim 与模型描述符共用，避免各处各算一套。
 * - 上游声明（`declaredEfforts`）来自 `thinking_config.enabled.efforts`；
 * - 探查实测（`validating` 时的 efforts）覆盖"声明为空但实际支持"的情形。
 * 两者都没有则返回空数组，调用方据此决定"不给档位"。
 */
export function supportedEffortsOf(info, observed) {
  const declared = Array.isArray(info?.declaredEfforts) ? info.declaredEfforts : [];
  const measured = observed?.validation === "validating" && Array.isArray(observed.efforts) ? observed.efforts : [];
  const set = new Set([...declared, ...measured]);
  // 按 pi-ai 键空间的强度顺序排序；声明里出现的未知拼写也保留（排最后）。
  return [...set].sort((a, b) => {
    const ia = PI_AI_THINKING_LEVELS.indexOf(a);
    const ib = PI_AI_THINKING_LEVELS.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
}

export function buildChatBody(options) {
  const { modelKey, messages, isReasoning, reasoningEffort, reasoningEffortExact, supportedEfforts, maxTokens, tools, toolChoice, temperature, sessionId, sessionType } = options;
  const requestId = randomUUID();
  const lastUser = [...(Array.isArray(messages) ? messages : [])].reverse().find((m) => m?.role === "user");
  const promptText = typeof lastUser?.content === "string"
    ? lastUser.content
    : Array.isArray(lastUser?.content)
      ? lastUser.content.filter((p) => p?.type === "text").map((p) => p.text).join("\n")
      : "";

  /** @type {Record<string, unknown>} */
  const parameters = { enable_thinking: isReasoning === true };
  if (Number.isFinite(maxTokens) && maxTokens > 0) parameters.max_tokens = Math.trunc(maxTokens);
  if (Number.isFinite(temperature)) parameters.temperature = temperature;
  /**
   * 思考档位。原先写死 `"high"`，用户无从选择；现在用 pi-ai 按 `thinkingLevelMap`
   * 映射后下发的值（见 {@link reasoningFieldsFor} 的实测依据）。
   *
   * 只接受已知档位，其余一律回退 `"high"`：
   * - 上游对未知值（含 `off`）返回 400，宁可回退也不能把请求打挂；
   * - `"high"` 正是改动前的行为，所以异常输入不会让体验变差。
   */
  if (isReasoning === true) {
    /**
     * `reasoningEffortExact` 供**探查**使用：原样透传、不走回退。
     *
     * 探查必须能发出"上游不认识的哨兵值"。若被回退成合法档位，就永远测不出
     * "上游是否校验该字段" —— 哨兵拒绝法会整体失效（所有值都被当成接受）。
     */
    if (typeof reasoningEffortExact === "string") {
      parameters.reasoning_effort = reasoningEffortExact;
    } else {
      /**
       * 正常路径：只发该模型**确实支持**的档位。
       *
       * 早期这里是"不在一张写死的 5 档白名单里就回退 high"，有两个问题：
       *   · 写死 ⇒ 上游新增档位（xhigh）永远选不到；
       *   · 回退值写死 `high` ⇒ 对"只支持 low/max"的模型，
       *     任何非法输入都会触发上游 400，把请求打挂。
       * 所以 `supportedEfforts` 由调用方按 (声明 ∪ 探查) 算好传进来，
       * 回退目标取**其中最高档**；调用方没给就退回键空间最高档。
       */
      const usable = (Array.isArray(supportedEfforts) && supportedEfforts.length > 0
        ? supportedEfforts
        : PROBE_CANDIDATE_EFFORTS);
      parameters.reasoning_effort = usable.includes(reasoningEffort)
        ? reasoningEffort
        : usable[usable.length - 1];
    }
  }

  return {
    request_id: requestId,
    request_set_id: requestId,
    chat_record_id: requestId,
    session_id: typeof sessionId === "string" && sessionId.length > 0 ? sessionId : randomUUID(),
    stream: true,
    chat_task: "FREE_INPUT",
    is_reply: true,
    is_retry: false,
    source: 1,
    version: "3",
    agent_id: "agent_common",
    task_id: "common",
    session_type: typeof sessionType === "string" && sessionType.length > 0 ? sessionType : DEFAULT_SESSION_TYPE,
    code_language: "",
    chat_prompt: "",
    image_urls: null,
    aliyun_user_type: "",
    // 顶层 system 服务端会忽略，系统提示走 messages 里的 {role:"system"}。
    system: "",
    messages: Array.isArray(messages) ? messages : [],
    tools: Array.isArray(tools) ? tools : [],
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
    parameters,
    chat_context: {
      chatPrompt: "",
      imageUrls: null,
      extra: {
        context: [],
        modelConfig: { key: modelKey, is_reasoning: isReasoning === true },
        originalContent: promptText,
      },
      features: [],
      text: promptText,
    },
    model_config: { key: modelKey, source: "system" },
    business: {
      product: "cli",
      version: "1.0.0",
      type: "agent",
      stage: "start",
      id: requestId,
      name: promptText.slice(0, 30),
      begin_at: Date.now(),
    },
  };
}

/**
 * 上游对话客户端。
 *
 * `chatStream` 发一次 `POST /algo/api/v2/service/pro/sse/agent_chat_generation`，
 * 返回一个**已经把 Qoder 双层 SSE 翻成 OpenAI SSE** 的 ReadableStream，
 * 这样 shim 只要 pipe 出去就行。
 */
export function createQoderClient(options) {
  const { tokens, logger, config } = options;
  const gateway = () => String(config()?.gateway ?? DEFAULT_GATEWAY).replace(/\/+$/, "");
  const chatPath = () => {
    const value = config()?.chatPath;
    return typeof value === "string" && value.length > 0 ? value : DEFAULT_CHAT_PATH;
  };
  const chatUrl = () => `${gateway()}${chatPath()}`;

  /**
   * 发一次流式请求（内部会在凭据被上游拒绝时重试一次）。
   *
   * 返回 `{ok:true, response}` 或 `{ok:false, status, kind, message}`。
   * 因为上游**总是**回 HTTP 200 + SSE（业务错误藏在信封的 `statusCodeValue` 里），
   * 所以这里先读**首个有效事件**再决定成败，避免已经写出 200 才发现是错误。
   *
   * ## 为什么多一次重试（2026-10-08 修）
   *
   * jobToken 是**上游轮换**的：Qoder 桌面 App 重新登录、或另一台设备刷新会话后，
   * 旧 token 会被立刻作废，而本机的快照文件（`connect-auth/qoder-session.json`）
   * 可能还没被导出流程更新。此时第一次请求必然 401。
   *
   * 修之前的做法是 `tokens.invalidate()` 然后**直接把错误返回给用户** ——
   * 于是表现为「有时能聊、有时整轮失败：API 密钥无效」，而下一轮又好了，
   * 看起来像随机故障。DSH 前端把 401/403 一律显示成 `message.failure.auth`
   * （"API 密钥无效"），所以文案与真实原因也对不上。
   *
   * 现在改成：凭据级失败 → 丢弃缓存 → 重新取一次 → **重试一次**。
   * 只重试一次是刻意的：第二次仍失败说明是真的没凭据（如 PAT 被吊销），
   * 再打上游只是浪费额度。
   */
  async function chatStream(request, signal) {
    const url = chatUrl();
    const body = buildChatBody({
      modelKey: request.model,
      messages: request.messages,
      isReasoning: request.isReasoning,
      // pi-ai 按 thinkingLevelMap 映射后下发的档位（未选/非法 → buildChatBody 按 supportedEfforts 回退）。
      reasoningEffort: request.reasoningEffort,
      // 该模型支持的档位（声明 ∪ 探查），由 shim 算好传入；回退取其中最高档。
      supportedEfforts: request.supportedEfforts,
      maxTokens: request.maxTokens,
      tools: request.tools,
      toolChoice: request.toolChoice,
      temperature: request.temperature,
      sessionId: request.sessionId,
      sessionType: config()?.sessionType,
    });

    // 只有要发出去的字节才参与签名 —— 顺序不能反。
    const encoded = qoderEncodeBody(Buffer.from(JSON.stringify(body), "utf8"));

    /**
     * 打一次，拿凭据与响应。返回 `{response}` 或 `{error}`（error 已是定稿形状）。
     * 凭据级失败时**只报告**不重试 —— 重试决策留在 chatStream 里，
     * 那里才知道该不该再来一次。
     */
    const attempt = async () => {
      const credential = await tokens.get();
      let response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            ...buildCosyHeaders(encoded, url, credential),
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            "Cache-Control": "no-cache",
            "Accept-Encoding": "identity",
            "X-Model-Key": request.model,
          "X-Model-Source": "system",
        },
        body: encoded,
        signal,
      });
    } catch (error) {
      /**
       * **返回形状必须与其它分支一致**（2026-10-08 修）。
       *
       * 这里原先直接返回裸的错误对象 `{ok:false, ...}`，而 `attempt()` 的其余
       * 出口都是包好的 `{error:{...}}`。调用方只认后者：
       *
       *     if (outcome.error?.kind === "auth") { …重试… }
       *     if (outcome.error !== undefined) return outcome.error;
       *     return { ok: true, response: outcome.response };
       *
       * 于是网络失败（`outcome.error === undefined`）会掉进最后一行，变成
       * `{ok:true, response:undefined}` —— shim 看到 ok 就写 200，
       * 然后 `Readable.fromWeb(undefined)` 抛错，而响应头已经发出去了，
       * 用户只看到一个空的 200。**顺带连 invalidate + 重试都不会发生。**
       * 实测三种情形（网络失败、客户端取消、正常失败）都会走到这里。
       */
      const aborted = signal?.aborted === true;
      return {
        error: {
          ok: false,
          status: 0,
          kind: aborted ? "aborted" : "network",
          message: aborted ? "客户端已取消" : `连不上 Qoder 网关：${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      /**
       * HTTP 层的 403 **同样不能一律当凭据失效**（2026-10-08 补）。
       *
       * 上一版只修了信封路径，这里仍是 `auth = 401 || 403` 的文本盲判：
       * 如果上游把额度错误放在 HTTP 层（而不是信封里），就会被标成 `kind:"auth"`，
       * 于是 (a) 白白 invalidate + 重试一次，(b) 文案里带着 `403` 且**断言是凭据问题**，
       * 前端照样显示「API 密钥无效」—— 额度提示永远出不来。
       * 判据与信封路径共用 `isCredentialRejection` / `isQuotaRejection`。
       */
      const quotaLike = isQuotaRejection(text);
      const auth = response.status === 401 || (response.status === 403 && !quotaLike && isCredentialRejection(text));
      if (auth) tokens.invalidate();
      return {
        error: {
          ok: false,
          status: quotaLike ? 429 : response.status,
          kind: auth ? "auth" : "upstream",
          message: auth
            ? `Qoder 拒绝了凭据（HTTP ${response.status}）：jobToken 可能已失效或 PAT 被吊销。${text.slice(0, 200)}`
            : text.replace(/\s+/g, " ").slice(0, 400),
        },
      };
    }
    if (response.body === null) return { error: { ok: false, status: response.status, kind: "upstream", message: "Qoder 返回了空响应体" } };

    const reader = response.body.getReader();
    const parser = createSseReader();
    /**
     * 首个事件预读：若上游直接报错，就在写响应头之前变成正经的 HTTP 错误。
     *
     * ⚠️ **必须把这一批里剩余的事件一起带上**（2026-10-08 修，与 Trae 侧同一个坑）。
     *
     * `parser.push()` 返回**整批**已解析事件并清空内部队列，所以只接住第一个就等于
     * 丢掉同批其余事件，而紧接着的 `parser.pending()` 只会拿到空数组 —— 实测
     * 一个 TCP 分片含 3 个事件时，下游只收到 1 个，丢掉的可能是正文分片或 `[DONE]`。
     * 生产环境一个分片常含多个事件，所以这不是理论问题。
     *
     * 现在把整批收下，交给 translate 按顺序回放（parser 也一并交接，见下）。
     */
    let initialEvents = [];
    while (initialEvents.length === 0) {
      const { done, value } = await reader.read();
      if (done) break;
      initialEvents = parser.push(value);
    }
    let first;
    for (const event of initialEvents) {
      const parsed = unwrapQoderEvent(event.raw);
      if (parsed.kind === "ignore") continue;
      first = parsed;
      break;
    }
    if (first === undefined) return { error: { ok: false, status: 502, kind: "upstream", message: "Qoder 流提前结束，没有读到任何事件" } };
    if (first.kind === "error") {
      /**
       * 业务错误也可能是凭据级：上游把 401/403 塞在信封的 `statusCodeValue` 里，
       * HTTP 仍是 200（只看 HTTP 会把"凭据失效"误判成成功）。
       * 这条路径**同样要能触发重试**，否则用户照样看到"API 密钥无效"。
       *
       * ⚠️ **403 不等于凭据失效**（2026-10-08 实测）：`code:110 / "Billing daily
       * count exceeded"` 也是 403，那是当日调用次数超限，刷新 token 没有意义，
       * 重试只是白花一次请求。所以只有 **401**，以及带明确失效语义的 403
       * （"token"/"credential"/"auth"/"unauthorized"）才算凭据问题。
       */
      const code = typeof first.code === "number" ? first.code : undefined;
      const authLike = code === 401 || (code === 403 && isCredentialRejection(first.message));
      if (authLike) tokens.invalidate();
      /**
       * 额度/限流类不要把 403 原样带出去。
       *
       * 宿主是按**文案里的数字**分类的（`classifyPiAiError` 先匹配 `403` → `AUTH`），
       * 而 `AUTH` 会把原文丢弃、只显示「API 密钥无效」。额度问题照原样上报就会
       * 变成误导性的密钥报错，所以这里换成 429 —— 它会被正确识别成 `RATE_LIMIT`
       * （429 分支在 AUTH 之后、但文案里已无 401/403 数字，见 writeOpenAIError 的渲染）。
       */
      const quotaLike = !authLike && isQuotaRejection(first.message);
      return {
        error: {
          ok: false,
          status: quotaLike ? 429 : code ?? 502,
          kind: authLike ? "auth" : "upstream",
          message: first.message,
        },
      };
    }
    if (first.kind === "done") return { error: { ok: false, status: 502, kind: "upstream", message: "Qoder 只回了一个结束标记，没有正文" } };
    return { response: translate(reader, parser, initialEvents, request, signal) };
    };

    // 第一次；凭据被拒就丢缓存重来一次（最多两次，绝不更多）。
    let outcome = await attempt();
    if (outcome.error?.kind === "auth") {
      tokens.invalidate();
      logger?.warn?.(`dsh-qoder-connect: 凭据被拒（${outcome.error.status}），已丢弃缓存并重试一次`);
      outcome = await attempt();
    }
    if (outcome.error !== undefined) return outcome.error;
    return { ok: true, response: outcome.response };
  }

  /**
   * 把已解析的 Qoder 事件流翻译成 OpenAI SSE 字节流。
   *
   * `parser` 由 `chatStream` 传进来**继续使用**，不在这里新建：首事件预读可能停在
   * 某个事件中间（TCP 分片切在事件内），那些残片只存在于那个 parser 的 buffer 里，
   * 换一个新 parser 就等于把它们丢掉（丢掉的可能是正文分片或 `[DONE]`）。
   * `initialEvents` 是首读那一批的**全部**事件，按顺序回放，不能只回放第一个。
   */
  function translate(reader, parser, initialEvents, request, signal) {
    const model = request.model;
    const id = `chatcmpl-qoder-${randomBytes(8).toString("hex")}`;
    const created = Math.floor(Date.now() / 1000);
    const encoder = new TextEncoder();
    let usage;
    let finished = false;

    const chunk = (delta, finishReason) => {
      const payload = {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
      };
      if (finishReason !== undefined && finishReason !== null) {
        // openai-completions 的解析器只在最后一帧读 usage，所以并到收尾帧里。
        payload.usage = {
          prompt_tokens: usage?.prompt_tokens ?? 0,
          completion_tokens: usage?.completion_tokens ?? 0,
          total_tokens: usage?.total_tokens ?? 0,
        };
      }
      return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
    };

    return new ReadableStream({
      start(controller) {
        // `finished` = 逻辑上收尾了；`closed` = 流真的关了。两者必须分开，
        // 否则 done 事件里 close() 之后 pump() 结尾再 close() 会抛 ERR_INVALID_STATE。
        let closed = false;
        const closeStream = () => {
          if (closed) return;
          closed = true;
          try { controller.close(); } catch { /* 下游已取消 */ }
        };
        const enqueue = (bytes) => {
          if (closed) return;
          try { controller.enqueue(bytes); } catch { closed = true; }
        };
        const emit = (parsed) => {
          if (finished || closed) return;
          if (parsed.kind === "ignore") return;
          if (parsed.kind === "error") {
            enqueue(chunk({ content: `\n\n[Qoder 错误] ${parsed.message}` }));
            return;
          }
          if (parsed.kind === "done") {
            finished = true;
            enqueue(chunk({}, "stop"));
            enqueue(encoder.encode("data: [DONE]\n\n"));
            closeStream();
            return;
          }
          const inner = parsed.chunk;
          if (inner?.usage !== undefined && inner.usage !== null) usage = inner.usage;
          const choice = Array.isArray(inner?.choices) ? inner.choices[0] : undefined;
          if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
            finished = true;
            const delta = deltaOf(inner) ?? {};
            enqueue(chunk(delta, choice.finish_reason));
            enqueue(encoder.encode("data: [DONE]\n\n"));
            closeStream();
            return;
          }
          const delta = deltaOf(inner);
          if (delta !== undefined) enqueue(chunk(delta));
        };

        const pump = async () => {
          try {
            // 首读那一批的全部事件，按原顺序回放（只回放第一个会丢掉同批其余事件）。
            for (const event of initialEvents) emit(unwrapQoderEvent(event.raw));
            while (!finished && !closed) {
              const { done, value } = await reader.read();
              if (done) break;
              for (const event of parser.push(value)) emit(unwrapQoderEvent(event.raw));
            }
            /**
             * 流读完先冲一次残留（2026-10-08 加）：最后一个事件没有尾随空行时
             * 会一直留在 buffer 里 —— 被截断的流最容易缺这个空行，而丢掉的
             * 可能是 `[DONE]`／收尾帧，于是"正常结束"与"被截断"分不出来。
             */
            if (!finished && !closed) {
              for (const event of parser.end()) emit(unwrapQoderEvent(event.raw));
            }
            if (!finished) {
              finished = true;
              enqueue(chunk({}, "stop"));
              enqueue(encoder.encode("data: [DONE]\n\n"));
            }
            closeStream();
          } catch (error) {
            logger?.warn?.(`dsh-qoder-connect: 上游流中断：${error instanceof Error ? error.message : String(error)}`);
            if (!finished) {
              finished = true;
              enqueue(chunk({}, "stop"));
              enqueue(encoder.encode("data: [DONE]\n\n"));
            }
            closeStream();
          }
        };

        if (signal?.aborted === true) { finished = true; closeStream(); return; }
        pump();
      },
      cancel() {
        finished = true;
        reader.cancel().catch(() => {});
      },
    });
  }

  return { chatStream };
}

//#endregion
//#region 账号侧客户端（额度 + 签到活动）

/**
 * OpenAPI 平面：普通 `Bearer <jobToken>` + `Cosy-ClientType`，**不需要 COSY 签名**。
 *
 * App 实际还多带 `Cosy-Version: <App 版本>` 与一整组 `Cosy-Machine*`（机器身份）。
 * 已实测**这些都不是必需的**：在 `Cosy-ClientType: 10` 的前提下逐个叠加它们，
 * 签到活动的返回没有任何变化（`scripts/qoder-campaign-headers-probe.mjs`）。
 * 所以这里保持最小头集，不引入机器身份（它在容器里根本拿不到）。
 */
function openApiHeaders(jobToken) {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${jobToken}`,
    "Cosy-ClientType": COSY_OPENAPI_CLIENT_TYPE,
    "User-Agent": "Qoder",
  };
}

/**
 * 额度与「签到」。
 *
 * 两条额度来源：
 *   1. `GET /sash/api/v2/me/usage`   —— **App 自己**用的那条（OpenAPI 平面），
 *      返回 `{displayMode, qoderUsage:{userType,userQuota:{used,total,percentage},…}}`。
 *   2. `GET /api/v2/quota/usage`     —— 社区参考实现那条（COSY 平面），
 *      返回 `{userQuota:{total,used,remaining,percentage,unit},…}`。
 *
 * 先打 1，失败回落到 2；两条都挂就抛，由状态文档降级成 `quotaError`。
 *
 * 签到：Qoder CN 有**每日活动**（App 左下角用量面板里的礼物图标，「每天领 100 Credits」，
 * 每日 10:00 (UTC+8) 刷新、奖励 30 天有效）。状态是
 * `GET /sash/api/v1/me/campaigns` → `{showCampaign, claimable, campaignUrl, campaigns[]}`。
 *
 * ⚠️ 这个端点**按 `Cosy-ClientType` 门控**，见 `COSY_OPENAPI_CLIENT_TYPE` ——
 * 客户端类型不对时它不报错，只回一份"没有任何活动"的空文档。
 *
 * **领取是可以调的**：`POST /sash/api/v1/me/campaigns/<campaignId>/claim`。
 * 这条路径是活动页自己拼出来的（活动页 JS 在公开 CDN 上：
 * `g.alicdn.com/qbase/qoder/<版本>/growth-page/activity-iframe/activity-iframe.js`），
 * 它把请求交给 App 的授权桥转发。因为它由 `${id}` 拼成，**在本地包里静态搜
 * `/sash/api/...` 字符串搜不到** —— 早先据此得出过"没有领取接口、只能只读"的错误结论。
 */
export function createQoderAccountClient(options) {
  const { tokens, config, logger } = options;
  const openapiBase = () => String(config()?.openapiBase ?? DEFAULT_OPENAPI).replace(/\/+$/, "");
  const TIMEOUT_MS = 20000;

  /**
   * 打 OpenAPI 平面。失败一律抛，由调用方决定降级方式。
   *
   * `options.method` / `options.body` 供**写**请求用（目前只有签到领取那条 POST）。
   * 不传就是原来的 GET，行为不变。
   */
  async function getOpenApi(path, label, credential, options) {
    const url = `${openapiBase()}${path}`;
    const hasBody = options?.body !== undefined;
    let response;
    try {
      response = await fetch(url, {
        method: options?.method ?? "GET",
        headers: hasBody
          ? { ...openApiHeaders(credential.jobToken), "Content-Type": "application/json" }
          : openApiHeaders(credential.jobToken),
        ...(hasBody ? { body: options.body } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(`${label} 连不上 ${openapiBase()}：${error instanceof Error ? error.message : String(error)}`);
    }
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) tokens.invalidate();
      throw new Error(`${label} 返回 HTTP ${response.status}：${text.replace(/\s+/g, " ").slice(0, 200)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${label} 返回的不是 JSON：${text.slice(0, 200)}`);
    }
  }

  /** 打 COSY 平面（备用额度来源）。 */
  async function getCosy(path, label, credential) {
    const url = `${openapiBase()}${path}`;
    const response = await fetch(url, {
      headers: { ...buildCosyHeaders(null, url, credential), Accept: "application/json", "User-Agent": "dsh-qoder-connect" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`${label} 返回 HTTP ${response.status}：${(await response.text().catch(() => "")).slice(0, 200)}`);
    }
    return response.json();
  }

  /** 「已用 / 总额 / 百分比」→ 统一形状。`total` 为 0 表示不限量。 */
  function shapeQuota(source, parts) {
    const used = toNumber(parts.used);
    const total = toNumber(parts.total);
    const remaining = toNumber(parts.remaining) ?? (total !== undefined && used !== undefined ? Math.max(0, total - used) : undefined);
    let percentage = toNumber(parts.percentage);
    // 有的实现给 0..1 的比例，有的给 0..100 的百分数 —— 统一成 0..1。
    if (percentage !== undefined && percentage > 1) percentage /= 100;
    if (percentage === undefined && total !== undefined && total > 0 && used !== undefined) percentage = used / total;
    return {
      source,
      used,
      total,
      remaining,
      percentage,
      unit: typeof parts.unit === "string" ? parts.unit : undefined,
      unlimited: total === 0,
    };
  }

  /** App 那条：`displayMode === "enterprise"` 时没有可用数字，只有外链。 */
  function shapeAccountUsage(doc) {
    if (doc?.displayMode === "enterprise") {
      const detail = doc?.enterpriseUsage;
      return {
        source: "account-usage",
        enterprise: true,
        detailUrl: typeof detail?.detailUrl === "string" ? detail.detailUrl : undefined,
        unlimited: false,
      };
    }
    const usage = doc?.qoderUsage;
    if (usage === null || typeof usage !== "object") throw new Error("额度接口没有返回 qoderUsage");
    const user = usage.userQuota ?? {};
    const addOn = usage.addOnQuota === null || usage.addOnQuota === undefined ? {} : usage.addOnQuota;
    const addOnTotal = toNumber(addOn.total);
    const addOnUsed = toNumber(addOn.used);
    const addOnRemaining = addOnTotal === undefined || addOnUsed === undefined ? undefined : Math.max(0, addOnTotal - addOnUsed);

    /**
     * [dsh-connect 2026-09-24 修正] 主额度要把**加油包**算进来。
     *
     * 实测 personal_standard 账号：`userQuota = {total:0, used:0}` 而
     * `addOnQuota = {total:100, used:0}` —— 只读 userQuota 会得到 0/0，
     * 而 `unlimited: total === 0` 就把它显示成"不限量"（用户一眼看出不对）。
     * 合并成"总可用 = 主额度 + 加油包"才是这个面板该显示的账。
     */
    const sum = (a, b) => {
      const left = toNumber(a);
      const right = toNumber(b);
      if (left === undefined) return right;
      if (right === undefined) return left;
      return left + right;
    };

    const shaped = shapeQuota("account-usage", {
      used: sum(user.used, addOnUsed),
      total: sum(user.total, addOnTotal),
      // 不传 percentage：合并后按 used/total 重算，避免"主额度占比"与合并后的账不一致。
      unit: typeof user.unit === "string" ? user.unit : addOn.unit,
    });
    return {
      ...shaped,
      enterprise: false,
      userType: typeof usage.userType === "string" ? usage.userType : undefined,
      /** 加油包剩余（单独留一份，便于 UI 细分）。 */
      addOnRemaining,
      addOnTotal,
      /** 组织资源包（有些账号有）。 */
      orgUsed: usage.orgResourcePackage === null || usage.orgResourcePackage === undefined
        ? undefined
        : toNumber(usage.orgResourcePackage.used),
    };
  }

  return {
    /** 额度。两条来源依次尝试，都失败才抛。 */
    async fetchQuota(credential) {
      const errors = [];
      try {
        return shapeAccountUsage(await getOpenApi(PATH_ACCOUNT_USAGE, "额度", credential));
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
      try {
        const doc = await getCosy(PATH_QUOTA_LEGACY, "额度(备用)", credential);
        const user = doc?.userQuota ?? {};
        if (user.total === undefined && user.used === undefined && user.remaining === undefined) {
          throw new Error("备用额度接口没有返回 userQuota");
        }
        return {
          ...shapeQuota("quota-usage", { used: user.used, total: user.total, remaining: user.remaining, percentage: user.percentage, unit: user.unit }),
          enterprise: false,
          isQuotaExceeded: doc?.isQuotaExceeded === true,
          expiresAt: typeof doc?.expiresAt === "string" ? doc.expiresAt : undefined,
        };
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
      throw new Error(errors.join(" ／ "));
    },

    /**
     * 「签到」状态。只读。
     *
     * ⚠️ 这个端点是**按 `Cosy-ClientType` 门控**的（见 `COSY_OPENAPI_CLIENT_TYPE`）：
     * 客户端类型不对时它不报错，只回一份「没有任何活动」的空文档，与"账号真没活动"
     * 无法区分。历史上就是在这里被误导过。
     *
     * `campaigns[]` 才是权威细节（`claimStatus` 有 CLAIMABLE / CLAIMED / 过期等），
     * `claimable` / `showCampaign` 只是服务端汇总。读得到 `campaigns` 就优先按它判，
     * 读不到再退回汇总字段。
     */
    async fetchCampaign(credential) {
      let doc;
      try {
        doc = await getOpenApi(PATH_CAMPAIGNS, "签到活动", credential);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("HTTP 404")) {
          return { supported: false, showCampaign: false, claimable: false, reason: "当前账号没有签到活动" };
        }
        throw error;
      }
      const showCampaign = doc?.showCampaign === true;
      const claimable = doc?.claimable === true;
      const campaignUrl = typeof doc?.campaignUrl === "string" && doc.campaignUrl.trim().length > 0 ? doc.campaignUrl.trim() : undefined;
      const campaigns = Array.isArray(doc?.campaigns) ? doc.campaigns : [];
      /** 可领的那一条：动作类型必须是「领奖励」，且服务端标了 CLAIMABLE，且 id 可用。 */
      const target = campaigns.find(
        (c) =>
          c?.actionType === "CLAIM_BENEFIT" &&
          c?.claimStatus === "CLAIMABLE" &&
          typeof c?.campaignId === "string" &&
          c.campaignId.length > 0,
      );
      /** 「今天已经领过」的证据：有领奖励类活动但不是 CLAIMABLE。用于区分「已签」与「没活动」。 */
      const claimedToday = campaigns.some((c) => c?.actionType === "CLAIM_BENEFIT" && c?.claimStatus === "CLAIMED");
      const reward =
        target?.benefit?.kind === "CREDITS" && Number.isFinite(target.benefit.amount) ? target.benefit.amount : undefined;
      if (!showCampaign && !claimable) {
        return { supported: true, showCampaign: false, claimable: false, claimedToday, campaigns, reason: "当前账号没有进行中的签到活动" };
      }
      return {
        supported: true,
        showCampaign,
        // 「能不能领」以**能不能真领**为准，不看服务端汇总。
        claimable: Boolean(target) || claimable,
        claimedToday,
        /** 可直接领取的那条活动（没有就是 undefined）。领取时要用它的 campaignId。 */
        campaign: target,
        campaigns,
        campaignUrl,
        reward,
        claimableHere: Boolean(target),
        reason: target
          ? `Qoder CN 今日有可领取的奖励${reward === undefined ? "" : `（+${reward} credits）`}，可直接在本面板领取。`
          : "今日签到已完成或暂不可领。",
      };
    },

    /**
     * 领取。**永远不假装成功** —— 直接把「去哪儿领」告诉调用方。
     * 保留成异步是为了让路由对 GET/POST 一视同仁。
     */
    async claimCampaign(credential) {
      let campaign;
      try {
        campaign = await this.fetchCampaign(credential);
      } catch (error) {
        return { state: "failed", message: error instanceof Error ? error.message : String(error) };
      }
      if (campaign.supported === false) return { state: "unsupported", message: campaign.reason ?? "当前账号没有签到活动" };
      const target = campaign.campaign;
      if (target === undefined) {
        // 有活动但今天没得领 → 已签；连活动开关都没有 → 这个账号就没有活动。
        // ⚠️ 这两支必须分开：把「没有活动」报成 already-claimed 会被 normalizeClaim
        // 映射成 done，界面显示"已签到"却看不到积分增加（2026-09-27 踩过）。
        if (campaign.showCampaign === true || campaign.claimedToday === true) return { state: "already-claimed", campaign };
        return { state: "unsupported", message: campaign.reason ?? "当前账号没有进行中的签到活动" };
      }
      // 真领取。端点与形状来自活动页自己的 JS（见 createQoderAccountClient 的函数头注释）。
      const path = `${PATH_CAMPAIGNS}/${encodeURIComponent(target.campaignId)}/claim`;
      try {
        await getOpenApi(path, "签到领取", credential, { method: "POST", body: "{}" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // 404/410 = 活动已下线或窗口已过；这不是"故障"，按已结束处理。
        if (message.includes("HTTP 404") || message.includes("HTTP 410")) {
          return { state: "already-claimed", campaign, message: "领取窗口已结束或活动已下线" };
        }
        // 上游明说「已领过 / 不符合条件」时也按已领处理（幂等重试的常见返回）。
        if (/已领取|已经领取|重复领取|not\s*eligible|already/i.test(message)) {
          return { state: "already-claimed", campaign, message: "今日奖励已领取过" };
        }
        return { state: "failed", message };
      }
      return {
        state: "claimed",
        campaign,
        message: campaign.reward === undefined ? "已领取今日奖励" : `已领取 +${campaign.reward} credits`,
      };
    },
  };
}

//#endregion
//#region 回环 shim

function writeOpenAIError(res, status, code, message) {
  writeJson(res, status, { error: { message, type: code, code } });
}

/**
 * OpenAI → Qoder 的消息转换。
 *
 * Qoder 的请求是 OpenAI 形状，所以这里基本是透传 + 清洗：
 *   · `system` 保持独立角色（顶层 `system` 字段服务端会忽略）
 *   · 图片 `image_url` 原样保留
 *   · `assistant.tool_calls` 与 `role:"tool"` 原样保留
 */
export function toQoderMessages(messages) {
  const out = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message === null || typeof message !== "object") continue;
    let role = typeof message.role === "string" ? message.role : "user";
    /**
     * `developer` → `system`。
     *
     * OpenAI 新惯例把系统提示的角色拼写从 `system` 改成 `developer`，pi-ai 对
     * **声明了 reasoning 的模型**会用新拼写发来（旧实现全部 `reasoning:false`，
     * 走老路径，所以此前从没见过这个角色）。Qoder 上游只认
     * `system/assistant/user/tool/function`，收到 `developer` 直接 400：
     *   "developer is not one of ['system', 'assistant', 'user', 'tool', 'function']"
     * 两者语义等同（都是系统指令），归一化即可，不丢内容。
     */
    if (role === "developer") role = "system";
    /** @type {Record<string, unknown>} */
    const next = { role };
    if (typeof message.content === "string") {
      next.content = message.content;
    } else if (Array.isArray(message.content)) {
      next.content = message.content
        .map((part) => {
          if (part?.type === "text" && typeof part.text === "string") return { type: "text", text: part.text };
          if (part?.type === "image_url" && part.image_url?.url) return { type: "image_url", image_url: { url: part.image_url.url } };
          return undefined;
        })
        .filter((part) => part !== undefined);
    } else {
      next.content = "";
    }
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) next.tool_calls = message.tool_calls;
    if (typeof message.tool_call_id === "string") next.tool_call_id = message.tool_call_id;
    if (typeof message.name === "string") next.name = message.name;
    out.push(next);
  }
  if (out.length === 0) out.push({ role: "user", content: "" });
  return out;
}

/** 把 OpenAI 的 tools 原样透传（Qoder 的请求就是 OpenAI 形状）。 */
function toQoderTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((tool) => tool?.type === "function" && typeof tool.function?.name === "string")
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.function.name,
        ...(typeof tool.function.description === "string" ? { description: tool.function.description } : {}),
        parameters: tool.function.parameters ?? { type: "object", properties: {} },
        ...(typeof tool.function.strict === "boolean" ? { strict: tool.function.strict } : {}),
      },
    }));
}

/** 解码模型 id 里可选的后缀：`<key>@think` 强制开思考、`@nothink` 强制关。 */
export function decodeModelId(raw, fallback) {
  const id = typeof raw === "string" ? raw : "";
  if (id.endsWith("@think")) return { model: id.slice(0, -"@think".length), thinking: true };
  if (id.endsWith("@nothink")) return { model: id.slice(0, -"@nothink".length), thinking: false };
  return { model: id, thinking: fallback };
}

/**
 * 回环 OpenAI shim。与另外两条渠道同构：随机端口 + 随机 bearer，
 * 只服务三个路由；上游换成 Qoder 客户端。
 */
export function createQoderShim(options) {
  const { client, catalog } = options;
  const logger = options.logger;
  /**
   * 探查服务用**可后挂**的方式注入：它在 `apply` 里晚于 shim 创建（要读 catalog），
   * 但请求处理要用它来判断"该模型是否支持思考"。用可变引用而不是构造参数，
   * 是为了避开 `const` 的 TDZ 陷阱。
   */
  let probe = options.probe;
  /** 每次启动换一份共享密钥；只在 127.0.0.1 上用。 */
  const SHARED_SECRET = randomBytes(32).toString("base64url");

  function bearerOk(req) {
    const header = req.headers.authorization;
    if (typeof header !== "string") return false;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match === null) return false;
    const given = Buffer.from(match[1]);
    const expected = Buffer.from(SHARED_SECRET);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  const server = createServer((req, res) => { handle(req, res); });
  const ready = new Promise((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  server.listen(0, "127.0.0.1");
  const baseUrl = () => {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("dsh-qoder-connect: shim 没有监听地址");
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
        writeJson(res, 200, {
          object: "list",
          data: catalog.current().map((model) => ({ id: model.id, object: "model", created: 0, owned_by: QODER_PROVIDER })),
        });
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
    /**
     * 取消接线**必须在读出请求体之前**注册（2026-10-08 修）。
     *
     * `await readBody(req)` 会 `for await` 完整个请求体；`close` 监听器若在那之后
     * 才注册，客户端在**流式阶段**断开时它根本不会触发 —— 实测（普通 fetch abort
     * 与裸 socket destroy 两种方式）都不触发，而在入口注册的对照组会。
     * 后果：用户中途取消，上游请求不被 abort，**Qoder 仍在生成并计费**，
     * 直到 socket 自己死掉；同时往死掉的 socket 写 `[DONE]`。
     */
    const controller = new AbortController();
    req.on("close", () => controller.abort());
    let request;
    try {
      request = JSON.parse((await readBody(req)).toString("utf8"));
    } catch {
      writeOpenAIError(res, 400, "invalid_json", "请求体不是合法 JSON");
      return;
    }
    const decoded = decodeModelId(request.model, undefined);
    const entry = catalog.find(decoded.model);
    /**
     * 是否开思考 —— **不能只看 `entry.isReasoning`**。
     *
     * `is_reasoning` 的含义是"是否**专用**思考模型"：DeepSeek-Flash / Kimi-K3
     * 都是 false，但它们**支持思考档位**（上游在 `thinking_config` 里声明了 efforts）。
     * 只看它会让这些模型永远走不到 `enable_thinking: true`，档位形同虚设。
     *
     * 判据（与模型描述符的 `reasoningFieldsFor` 保持一致）：
     *   · 用户显式指定（`@nothink` 后缀或 `reasoning_effort`）以用户为准；
     *   · 否则看目录：声明了档位 ⇒ 该模型支持思考；实测探查结论 validating 也算。
     */
    const supportsThinking = Array.isArray(entry?.declaredEfforts) && entry.declaredEfforts.length > 0;
    const requestedEffort = typeof request.reasoning_effort === "string" && request.reasoning_effort.length > 0;
    // 探查实测为 validating 也算"支持思考"（上游没声明、但实测接受档位的情形）。
    const probed = probe?.service?.cached(decoded.model)?.validation === "validating";
    const isReasoning = decoded.thinking ?? (requestedEffort || supportsThinking || probed || entry?.isReasoning === true);

    /**
     * 取消接线在函数入口已注册（见上），这里不再重复注册 —— 在那个位置注册的
     * 监听器不会在流式阶段触发（`readBody` 已把 body 读完）。
     */

    let result;
    try {
      result = await client.chatStream({
        model: decoded.model,
        messages: toQoderMessages(request.messages),
        tools: toQoderTools(request.tools),
        toolChoice: request.tool_choice,
        isReasoning,
        /**
         * 用户选的思考档位。pi-ai 依据模型的 `thinkingLevelMap` 把 UI 档位映射成
         * 线上拼写，放在请求体的 `reasoning_effort` 里发到 shim —— 这里读出来
         * 透传给上游（WorkBuddy 那条渠道也是同一机制）。
         */
        reasoningEffort: typeof request.reasoning_effort === "string" ? request.reasoning_effort : undefined,
        /**
         * 该模型**确实支持**的档位（声明 ∪ 探查），供 `buildChatBody` 决定
         * 非法输入该回退到哪一档。传进来而不是让 buildChatBody 自己去查，
         * 是为了保持它是个纯函数（它不知道 catalog / probe）。
         */
        supportedEfforts: supportedEffortsOf(entry, probed ? probe?.service?.cached(decoded.model) : undefined),
        maxTokens: request.max_tokens ?? request.max_completion_tokens,
        temperature: request.temperature,
      }, controller.signal);
    } catch (error) {
      writeOpenAIError(res, 401, "not_signed_in", error instanceof Error ? error.message : String(error));
      return;
    }

    if (!result.ok) {
      const status = result.kind === "auth" ? 401 : result.kind === "aborted" ? 499 : 502;
      writeOpenAIError(res, status, result.kind, describeUpstreamFailure(result.status, result.message));
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
      logger?.warn?.(`dsh-qoder-connect: 上游流中断：${error instanceof Error ? error.message : String(error)}`);
      if (!sawDone && res.writable) res.end("data: [DONE]\n\n");
    });
    body.pipe(res);
  }

  return {
    ready,
    baseUrl,
    token: () => SHARED_SECRET,
    /** 后挂探查服务（见上方 `probe` 变量的说明）。 */
    setProbe: (next) => { probe = next; },
    close: () => new Promise((resolve, reject) => {
      server.close(() => resolve());
      server.closeAllConnections();
      server.once("error", reject);
    }),
  };
}

//#endregion
//#region 适配器

/** pi-ai 的 auth 平面在本插件里必须惰性：认证只走 shim 的共享密钥。 */
const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() { return []; },
    async modify() { throw new Error("dsh-qoder-connect: the qoder route has no pi-ai credential lifecycle"); },
    async delete() {},
  },
  authContext: {
    async env() {},
  },
};

/** pi-ai 模型描述里要显式写 0，否则计费面板会按未知价格处理。 */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20971520,
  requestImagePixelBudget: 4194304,
  requestImageMaxBytes: 1048576,
};
const QODER_STREAM_IDLE_TIMEOUT_MS = 300000;

/**
 * ── 推理等级探查（Qoder）────────────────────────────────────────────────
 *
 * Qoder 的模型目录只给 `is_reasoning` 布尔，**不声明支持哪些档位** ——
 * 所以它和 WorkBuddy 一样属于"必须探查"的渠道（Trae 相反：目录里直接
 * 按 (模型 × function) 声明了 options，无需探查）。
 *
 * 这里复用渠道无关的 {@link probeModel} 哨兵拒绝法。它能用的前提是
 * **上游会拒绝非法值** —— Qoder 实测确实如此（2026-10-06）：
 *
 * | 发送值 | 上游 |
 * |---|---|
 * | 不发该字段 | 200 |
 * | minimal/low/medium/high/max | 200 |
 * | `off` | **400** |
 * | 乱填（哨兵对照） | **400** |
 *
 * 对照组被拒是关键：证明上游在校验，而不是"传什么都收"。
 * （对照 Trae：乱填同样 200 → 哨兵法对它无效，所以 Trae 走目录声明。）
 */
const QODER_PROBE_FILENAME = ".qoder-probe.json";
const QODER_PROBE_FORMAT_VERSION = 1;

/**
 * 探查用的进程内密钥。
 *
 * 为什么需要它：探查会**花真实额度**（哨兵 + 逐档扫描会发多个请求），
 * 只靠"回环 Host"这层守卫不够 —— DNS rebinding 下任意本地页面都能发同源请求，
 * 而 Host 就是本机、拦不住。所以状态文档下发一个每次启动都换的随机 key，
 * POST 探查时必须带上。与 WorkBuddy 同机制（随机 key + 常量时间比较）。
 */
function createQoderProbeKey() {
  return randomBytes(24).toString("hex");
}

/** 常量时间比较；长度不符即失败，不抛。 */
function probeKeyMatches(expected, presented) {
  if (typeof presented !== "string" || presented.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(presented));
}

/** 判定"这次尝试是否被上游接受"。 */
function probeIsAcceptance(attempt) {
  return attempt?.status === 200;
}
/**
 * 判定"这次尝试是否属于**归因明确**的档位拒绝"。
 *
 * 只有 400 才算：401 是凭据问题、502 是网关问题，把它们当成"档位被拒"会得出
 * 完全错误的结论（会把"登录过期"报告成"这个档位不支持"）。
 */
function probeIsEffortRejection(attempt) {
  return attempt?.status === 400;
}

/**
 * 发一次探查请求。
 *
 * **不能走 `client.chatStream`**：它把上游业务错误统一包成 `status: 502`
 * （见 `chatStream` 的 `first.kind === "error"` 分支），400 与 502 就分不清了，
 * 而探查的全部意义正是区分它们。所以这里自己发一次、只读首个事件取真实状态码。
 */
async function sendQoderProbe({ tokens, config, logger }, modelId, effort, signal) {
  const credential = await tokens.get();
  const body = buildChatBody({
    modelKey: modelId,
    messages: [{ role: "user", content: "ping" }],
    isReasoning: true,
    // 探查专用：原样透传（含哨兵值），不做白名单回退。
    reasoningEffortExact: effort === undefined ? undefined : effort,
    maxTokens: 16,
    sessionType: config()?.sessionType,
  });
  if (effort === undefined) delete body.parameters.reasoning_effort;

  const url = `${String(config()?.gateway ?? DEFAULT_GATEWAY).replace(/\/+$/, "")}${DEFAULT_CHAT_PATH}?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;
  const encoded = qoderEncodeBody(Buffer.from(JSON.stringify(body), "utf8"));
  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...buildCosyHeaders(encoded, url, credential),
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "Accept-Encoding": "identity",
      "X-Model-Key": modelId,
      "X-Model-Source": "system",
    },
    body: encoded,
    signal,
  });
  if (!res.ok) {
    // 上游在 HTTP 层就拒了（400 就在这里）。
    await res.text().catch(() => "");
    return { status: res.status };
  }
  /**
   * 200 也要读首个事件：Qoder 会把业务错误塞在信封的 `statusCodeValue` 里
   * （HTTP 仍是 200）。只看 HTTP 会把"业务拒绝"误判成"接受"。
   */
  const text = await res.text().catch(() => "");
  const match = text.match(/"statusCodeValue"\s*:\s*(\d+)/);
  const bizCode = match === null ? undefined : Number(match[1]);
  if (bizCode !== undefined && bizCode >= 400) return { status: bizCode };
  return { status: 200 };
}

/** 组装 Qoder 的探查运行器 + 存储，供路由与适配器共用。 */
export function createQoderProbe(options) {
  const { tokens, config, catalog, logger } = options;
  // 每次启动换一份；只随状态文档下发给同源页面，POST 探查时必须回传。
  const key = createQoderProbeKey();
  const store = new ProbeStore({
    path: join(resolveDshHome(), QODER_PROBE_FILENAME),
    version: QODER_PROBE_FORMAT_VERSION,
    logger,
  });
  const service = new ProbeService({
    consent: options.consent,
    catalog: () => catalog.current(),
    account: () => options.account?.(),
    store,
    logger,
    // 探查改了"支持哪些档位"→ 必须让宿主重建模型列表，否则界面上看不到变化。
    onProbed: options.onProbed,
    run: (modelId) => probeModel({
      // 候选 = pi-ai 键空间去掉 off（见 PROBE_CANDIDATE_EFFORTS 的说明）。
      // 这是协议层的"上界"，不是某个模型的写死名单 —— 探出来多少算多少。
      candidates: PROBE_CANDIDATE_EFFORTS,
      send: (effort, signal) => sendQoderProbe({ tokens, config, logger }, modelId, effort, signal),
      isAcceptance: probeIsAcceptance,
      isEffortRejection: probeIsEffortRejection,
    }),
  });
  return { service, store, key: () => key };
}

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

/**
 * Qoder 思考档位（reasoning_effort）声明。
 *
 * ## 为什么现在敢声明了
 *
 * 早先这里是写死的 `reasoning: false`，注释理由是"避免 pi-ai 塞 Qoder 不认识的
 * reasoning 参数"。**实测推翻了这个假设**：上游不但认识，而且会校验。
 *
 * 2026-10-06 用真实凭据逐档位探测（复用本文件的编码/COSY 签名，保证请求同形；
 * 脚本见 `probes/qoder-effort-probe.mjs`，含一个乱填值的对照组）：
 *
 * | 发送值 | 上游 |
 * |---|---|
 * | 不发该字段 | 200 |
 * | minimal / low / medium / high / max | 200（全部接受）|
 * | off | **400 拒绝** |
 * | `bogus_value_xyz`（对照） | **400 拒绝** |
 *
 * 对照组是关键：**乱填会被拒**，证明上游确实在校验这个参数，而不是"传什么都收"。
 * 响应体量也随档位分层（high 45KB / max 39KB / low 30KB vs 不传 17KB），说明
 * 档位真的改变输出，不是被忽略的装饰参数。
 *
 * ## 映射规则
 *
 * pi-ai 的 `thinkingLevelMap` 把 UI 档位映射成**线上拼写**（值与键同名即原样发）。
 * - `off` 置 `null`：上游对 `off` 返回 400，这不是"关思考"的意思。
 *   要关思考走既有的 id 后缀 `@nothink`（`decodeModelId`），那是另一条已验证的路径。
 * - `minimal` 置 `null`：上游接受，但 DSH 的档位 UI 不呈现该级别，留着是死配置。
 * - 其余档位（low/medium/high/xhigh/max）**逐模型**按上游声明给出。
 *
 * ## ⚠️ 曾用错判据的教训（2026-10-06）
 *
 * 早先这里用 `isReasoning`（上游 `is_reasoning`）当"支不支持档位"的判据，
 * 结果 DeepSeek-Flash、Kimi-K3 都拿不到档位。**那个判据是错的**：
 * `is_reasoning` 说的是"是否**专用**思考模型"，Flash 系列自然不是；
 * 档位声明在 `thinking_config.enabled.efforts` 里（见 {@link parseThinkingConfig}）。
 *
 * 而且档位**逐模型不同**（实测原始目录）：
 *   qmodel_38max → xhigh / low / medium；dfmodel → high / max / low。
 * 早先"所有模型同一套档位"的做法，等于给部分模型发了它不认的值。
 *
 * ## 声明 vs 实测：**取并集**，不是二选一
 *
 * 上游没声明 ≠ 不支持：`qmodel` 声明为空，实测却接受全部 5 档。
 * 反过来，声明也**可能比实测窄**：`dfmodel` 声明 3 档，实测接受 5 档 ——
 * 若"声明优先"，实测出的 2 个真实档位会被永远藏住。
 * 所以两者**取并集**（见 {@link supportedEffortsOf}）：声明是保底，
 * 实测发现的额外档位是对它的**扩展**，谁也不压谁。
 */
function reasoningFieldsFor(info, observed) {
  /**
   * 并集语义（与 {@link supportedEffortsOf} 一致）：
   *   · 声明 = 上游对 UI 的正式承诺，保底；
   *   · 实测（仅 `validating` 才算数）= 已证实的额外档位；
   *   · `non-validating`/`unknown` **不能**当"不支持"—— 哨兵被接受只说明
   *     上游不校验，档位可能照常生效（`kmodel_latest` 声明 3 档但实测
   *     non-validating，此时必须保住声明的 3 档）。
   * 并集为空 → `reasoning: false`。
   */
  const supported = supportedEffortsOf(info, observed);
  if (supported.length === 0) return { reasoning: false };

  const set = new Set(supported);
  const levelOf = (value) => (set.has(value) ? value : null);
  return {
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: levelOf("low"),
      medium: levelOf("medium"),
      high: levelOf("high"),
      // xhigh 不是死配置：Qwen3.8 系列（qmodel_38max / qfmodel）上游**确实**声明了它。
      xhigh: levelOf("xhigh"),
      max: levelOf("max"),
    },
  };
}

export function createQoderAdapter(options) {
  const { shim, catalog } = options;
  const providerId = options.providerId ?? QODER_PROVIDER;
  const displayName = options.displayName ?? QODER_DISPLAY_NAME;
  /** [dsh-connect] 面板禁用的模型 id（每次构建列表时重读，改完立即生效）。 */
  const hidden = options.hidden ?? (() => []);

  const buildModels = () => {
    const baseUrl = `${shim.baseUrl()}/v1`;
    const hiddenIds = hiddenMatcher(hidden());
    const probe = options.probe;
    return catalog.current().filter((info) => !hiddenIds.has(info.id)).map((info) => ({
      id: info.id,
      // 倍率挂在名字上：模型下拉只渲染 `name`（理由见 withRateName）。
      name: withRateName(info),
      api: "openai-completions",
      provider: providerId,
      baseUrl,
      input: info.supportsImages === true ? ["text", "image"] : ["text"],
      // 探查过的模型以实测结果为准（仅采纳 validating，理由见 reasoningFieldsFor）。
      ...reasoningFieldsFor(info, probe?.service?.cached(info.id)),
      cost: NO_COST,
      contextWindow: info.contextWindow ?? 200000,
      maxTokens: info.maxTokens ?? 32000,
      compat: { maxTokensField: "max_tokens" },
    }));
  };

  const provider = {
    ...createProvider({
      id: providerId,
      name: displayName,
      auth: {
        apiKey: {
          name: "Qoder 回环凭据（由插件自己维护，无需填写）",
          async resolve({ credential }) {
            const apiKey = credential?.key;
            return apiKey === undefined || apiKey.length === 0 ? undefined : { auth: { apiKey }, source: "Qoder" };
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
    streamIdleTimeoutMs: QODER_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, "dsh-qoder-connect retryPolicy"),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  };
  let profiles = new Map([[providerId, profile]]);
  return {
    /**
     * 附件服务解析器 —— **带图会话能跑通全靠它**。
     *
     * 宿主 `dsh-llm-pi-ai` 在把请求交给 pi-ai 之前会先问这个函数要附件仓库：
     *
     * ```js
     * const attachments = containsImage ? this.config.resolveAttachments?.() : undefined;
     * if (containsImage && attachments === undefined)
     *   throw new LlmError("pi-ai image input requires the durable attachment service", "UNSUPPORTED_CONTENT");
     * ```
     *
     * 不传就是 `undefined`，于是**任何**带图片的请求都在这里被拒，请求根本到不了
     * Qoder 上游 —— 表现为「目录里明明写了 `is_vl: true` 却报 UNSUPPORTED_CONTENT」，
     * 很容易误判成模型不支持读图。WorkBuddy provider 一直是好的，正是因为它建
     * adapter 时把这行传了进去；Trae / Qoder 两路一直漏了，所以只有它们报错（2026-10-07 定位）。
     *
     * `ctx.get("attachments")` 在本插件这一层能取到服务：`dsh-base` 声明了
     * `id: attachment-local`，且三个渠道共用同一个 ctx（见 lib/index.js 的 `mod.apply(ctx, {})`）。
     * 套 `withLegacyImageBudget` 是为跨版本安装兜底（pi-ai 与附件服务的两代契约在
     * `readImageRequest` 的第二个参数上不一致）；同代 store 上它是 no-op，恒定套用安全。
     *
     * 参考实现：dingminhua/dsh-connect-trae `src/index.ts` 同一写法。
     *
     * 注：这段说明刻意放在 `new PiAiAdapter(` **外面** —— 放进实参里会让
     * `probes/verify-attachment-wiring.mjs` 把注释里的同名字符串当成接线证据。
     */
    adapter: new PiAiAdapter({
      profiles: () => profiles,
      auth: INERT_AUTH,
      resolveApiKey: async () => shim.token(),
      resolveAttachments: options.resolveAttachments,
    }),
    invalidate: () => { profiles = new Map([[providerId, profile]]); },
  };
}

//#endregion
//#region 状态路由（供浏览器侧读取）

/** 注册给浏览器侧的两个路由。与 client.js 里的字面量必须逐字一致。 */
export const QODER_STATUS_ROUTE = "/plugins/dsh-qoder-connect/status";
export const QODER_CHECKIN_ROUTE = "/plugins/dsh-qoder-connect/checkin";
/** 推理等级探查：GET 读已探结果，POST `{model}` 触发一次探测（会花真实额度）。 */
export const QODER_PROBE_ROUTE = "/plugins/dsh-qoder-connect/probe";

/** 倍率展示：0.8 → "0.8×"，整数去掉小数，拿不到就是 undefined。 */
function formatRate(rate) {
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return undefined;
  return Number.isInteger(rate) ? `${rate}×` : `${Number(rate.toFixed(2))}×`;
}

/**
 * 把倍率挂到模型名上：`Qwen3.8-Max` → `Qwen3.8-Max · 0.5×`。
 *
 * DSH 0.1.5 的模型下拉（dsh-client-ui-model-selection）只渲染 `model.name`
 * （`modelLabel = currentChoice?.model.name`，列表项也是 `children: model.name`），
 * `description` 根本不读 —— 想让每个模型都看到倍率，只能挂在名字上。
 *
 * 拿不到倍率（上游没给 `price_factor`，例如 `Qwen3.8-Flash`）就原样返回，不硬凑。
 * 面板状态文档里另有独立的 `rate` 字段，所以那一边不必重复。
 */
function withRateName(info) {
  const rate = formatRate(info.rate);
  return rate === undefined ? info.name : `${info.name} · ${rate}`;
}

/**
 * 组装给浏览器侧的状态文档。
 *
 * 与另外两条渠道同一原则：**额度与签到都是「尽力而为」**——上游任何一段失败都降级
 * 成该字段的错误串，而不是让整份文档 500。否则网络抖一下，界面上连渠道名和签到
 * 按钮都会消失。
 *
 * 这里额外把**每个模型的倍率**带上（`models[].rate`），因为 dock 那一行要显示
 * 当前选中模型的倍率，而它只随目录变，不该为它单独打一次上游。
 */
export async function qoderWebStatus(deps) {
  const base = { provider: QODER_PROVIDER, channel: QODER_DISPLAY_NAME };
  // 凭据可以来自 App 会话（session.json）或官方 PAT —— 两者都没有才算未登录。
  // （会话由宿主脚本 scripts/qoder-vault.mjs --install-session 导出，token-manager 会优先用它。）
  const session = deps.sessions === undefined ? undefined : await deps.sessions.current().catch(() => undefined);
  const pat = await deps.pats.current();
  if (session === undefined && pat === undefined) {
    return {
      ...base,
      status: "signed-out",
      patPath: deps.pats.path(),
      ...deps.sessions === undefined ? {} : { sessionPath: deps.sessions.path() },
    };
  }

  let credential;
  try {
    credential = await deps.tokens.get();
  } catch (error) {
    return { ...base, status: "signed-out", patPath: deps.pats.path(), patSource: pat.source, reason: briefMessage(error) };
  }

  const models = deps.catalog.current();
  const doc = {
    ...base,
    status: "signed-in",
    userId: credential.userID,
    account: credential.name === "" ? credential.email : credential.name,
    email: credential.email,
    patSource: credential.source,
    expiresAt: new Date(credential.expiresAt).toISOString(),
    modelCount: models.length,
    catalogSource: deps.catalog.source(),
    catalogFetchedAt: deps.catalog.fetchedAt() === 0 ? undefined : new Date(deps.catalog.fetchedAt()).toISOString(),
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      rate: formatRate(model.rate),
      free: model.isFree === true,
      isReasoning: model.isReasoning === true,
      contextWindow: model.contextWindow,
    })),
    /**
     * 推理等级探查契约（供前端渲染"检测"按钮）。
     *
     * 为什么 Qoder 需要而 Trae 不需要：Qoder 目录只给 `is_reasoning` 布尔、
     * **不声明档位列表**，所以"这个模型支持哪几档"只能靠探查实测；
     * 而 Trae 目录按 (模型 × function) 直接声明了 `options`，声明即权威。
     */
    ...deps.probe === undefined ? {} : {
      probe: {
        /**
         * 显示探查按钮的模型 = **还没有探查记录**的模型。
         *
         * 早期两版判据都不对：
         *   · `isReasoning === true` —— 把 DeepSeek-Flash / Kimi-K3 排除在外
         *     （它们 `is_reasoning=false` 却档位最全）；
         *   · 「没声明档位的」—— 反过来把**已声明**的模型藏起来，而实测恰恰
         *     可能比声明更宽（dfmodel 声明 3 档、实测 5 档），用户就永远
         *     发现不了多的那几档。
         * 「没有记录就值得探」是完全数据驱动的：探完有结果 → 按钮变成展示结果
         * （前端 `candidates.includes(model) || result !== undefined` 就是这个语义），
         * 模型增减自动跟随目录，无任何写死名单。
         */
        candidates: models.filter((model) => deps.probe.service.cached(model.id) === undefined).map((model) => model.id),
        running: deps.probe.service.isRunning(),
        results: models.flatMap((model) => {
          const record = deps.probe.service.cached(model.id);
          return record === undefined ? [] : [{ id: model.id, name: model.name, validation: record.validation, efforts: record.efforts, probedAt: record.probedAt }];
        }),
      },
      probeKey: deps.probe.key(),
    },
  };

  try {
    doc.quota = await deps.account.fetchQuota(credential);
  } catch (error) {
    doc.quotaError = briefMessage(error);
  }
  try {
    doc.checkin = await deps.account.fetchCampaign(credential);
  } catch (error) {
    doc.checkinError = briefMessage(error);
  }
  return doc;
}

/** 签到路由：GET 读状态（只读），POST 尝试领取（会如实返回 manual-required）。 */
export async function qoderCheckinAction(deps, method) {
  const credential = await deps.tokens.get().catch(() => undefined);
  if (credential === undefined) return { state: "signed-out" };
  if (method === "GET") {
    try {
      return { state: "signed-in", checkin: await deps.account.fetchCampaign(credential) };
    } catch (error) {
      return { state: "failed", message: briefMessage(error) };
    }
  }
  try {
    return await deps.account.claimCampaign(credential);
  } catch (error) {
    return { state: "failed", message: briefMessage(error) };
  }
}

/**
 * 两个路由的共用外壳。
 *
 * 必须做 loopback 守卫：这两个端点挂在用户自己的 DSH 端口上，而 DSH 端口可能被
 * 反代 / 局域网暴露。Host **和** Origin 都要求是回环，缺一不可
 * （只有 Host 挡不住 DNS rebinding，只有 Origin 挡不住非浏览器客户端；
 * 这两个接口本身不写敏感数据，两者齐备即可）。
 */
function qoderRouteHandler(handle) {
  return async (req, res) => {
    if (req.method !== "GET" && req.method !== "POST") {
      writeJson(res, 405, { error: "method not allowed" });
      return;
    }
    if (!loopbackRequest(req)) {
      writeJson(res, 403, { error: "request-not-trusted" });
      return;
    }
    /**
     * POST 要读 body：探查路由靠 `{model}` 指定目标模型。
     * 复用已有的 `readBody`（本文件里 shim 也在用同一个），不另造一份。
     */
    let body;
    if (req.method === "POST") {
      try {
        body = (await readBody(req)).toString("utf8");
      } catch (error) {
        writeJson(res, 400, { error: briefMessage(error) });
        return;
      }
    }
    try {
      writeJson(res, 200, await handle(req.method, body, req.headers));
    } catch (error) {
      writeJson(res, 500, { error: briefMessage(error) });
    }
  };
}

/**
 * 注册 `/plugins/dsh-qoder-connect/{status,checkin,probe}`；webServer 缺失时整段跳过。
 *
 * ## 新渠道接入探查需要改哪些地方
 *
 * 三处，缺一不可（Trae 只做了第 1 处，因为它的档位由目录声明、不需要探查）：
 *   1. 目录/provider 侧声明档位（若有 `options` 就到此为止）；
 *   2. **状态文档下发 `probe` + `probeKey`** —— 前端据此渲染"检测"按钮；
 *   3. **注册探查路由**并校验 key —— 探查会花额度，必须有这层授权。
 * 前端控件还需要认识该 provider（见 `client.js` 的 provider → 路由映射）。
 */
export function registerQoderStatusRoutes(ctx, deps) {
  for (const [path, handle] of [
    [QODER_STATUS_ROUTE, () => qoderWebStatus(deps)],
    [QODER_CHECKIN_ROUTE, (method) => qoderCheckinAction(deps, method)],
    [QODER_PROBE_ROUTE, (method, body, headers) => qoderProbeAction(deps, method, body, headers)],
  ]) {
    ctx.effect(() => {
      const dispose = ctx.webServer.register({ kind: "exact", path, handler: qoderRouteHandler(handle) });
      return () => { dispose(); };
    }, `dsh-qoder-connect: ${path}`);
  }
}

/**
 * 探查路由：`GET` 读已探结果、`POST` 触发一次探测（需带 key）。
 *
 * ## 为什么请求契约与 WorkBuddy 对齐
 *
 * 前端那个"检测"控件（`client.js` 的 `WorkBuddyProbeControl`）是**构建产物**，
 * 它发请求时用的是固定的头名与 body 结构（`X-WorkBuddy-Probe-Key` +
 * `{action:"probe", model}`）。为让 Qoder 复用同一个控件，这里**接收同样的形状**
 * 而不是另立一套 —— 否则就要去改打包后的 bundle，风险与收益不成比例。
 * 头部名是历史遗留（控件是 WorkBuddy 时期写的），不影响安全性：key 本身每次启动随机。
 *
 * 同时接受 `x-qoder-probe-key` + `{model}`，方便脚本/CLI 直连时用更自然的名字。
 */
async function qoderProbeAction(deps, method, body, headers) {
  const { probe } = deps;
  if (probe === undefined) return { state: "unavailable", reason: "probe not configured" };
  if (method === "POST") {
    /**
     * 只有 POST 需要 key：它会真的发请求、花额度。GET 是只读的已探结果，
     * 与状态路由同级，不额外设卡。
     */
    const presented = headers?.["x-workbuddy-probe-key"] ?? headers?.["x-qoder-probe-key"];
    if (!probeKeyMatches(probe.key(), presented)) {
      return { state: "unavailable", reason: "invalid-probe-key" };
    }
  }
  if (method === "GET") {
    return {
      running: probe.service.isRunning(),
      results: deps.catalog.current().flatMap((model) => {
        const record = probe.service.cached(model.id);
        return record === undefined ? [] : [{ id: model.id, validation: record.validation, efforts: record.efforts }];
      }),
    };
  }
  if (method !== "POST") return { error: "method not allowed" };
  let parsed;
  try {
    parsed = typeof body === "string" && body.length > 0 ? JSON.parse(body) : {};
  } catch {
    return { state: "unavailable", reason: "bad json" };
  }
  // `action` 在前端契约里恒为 "probe"；这里只校验 model。
  const modelId = typeof parsed?.model === "string" ? parsed.model : "";
  if (modelId === "") return { state: "unavailable", reason: "missing model" };
  /**
   * 面板/设置页的显式点击 = 一次性人工同意（`manualConsent`）。
   *
   * 与 WorkBuddy 同思路：人工点击不改变"自动探查"的配置，只对本次生效 ——
   * 探查会花真实额度，所以必须由用户逐个模型确认。
   */
  return await probe.service.probe(modelId, true);
}

//#endregion
//#region 插件入口

/** 运行态文件名（与 trae 的同名文件只差前缀）。 */
const QODER_STATE_FILENAME = ".qoder-connect-state.json";

/**
 * 运行态落盘：`$DSH_HOME/.qoder-connect-state.json`。
 *
 * 与另外两条渠道同思路 —— DSH 的插件日志默认不进 web 日志文件，
 * 只看日志无法判断一个渠道到底有没有注册成功、当前是「未登录」还是「已就绪」。
 * 这份文件把结论固化下来，排查时直接看它。
 *
 * 实现在 `shared/node.js`（与 trae 共用同一份，只差文件名）。
 */
function writeState(patch, logger) {
  writeChannelState({ filename: QODER_STATE_FILENAME, patch, logger });
}

/**
 * 启动：起回环 shim → 注册 `qoder1` provider → 按凭据巡检刷新目录。
 *
 * 无论有没有 PAT 都先注册 provider —— DSH 用「模型组为空」来隐藏一个模型组，
 * 所以登录（放进 PAT）发生在 DSH 已经跑起来之后也能生效，不需要重新注册。
 */
export function apply(ctx, config) {
  let stopped = false;
  const current = () => config ?? {};

  const pats = createPatStore({ config: current });
  // [dsh-connect] App 会话优先：导出了 ~/.dsh/qoder/session.json 就用它，不碰 PAT。
  const sessions = createSessionStore({ config: current });
  const tokens = createTokenManager({ pats, sessions, config: current, logger: ctx.logger });
  const catalog = createCatalog({ tokens, config: current, logger: ctx.logger });
  const client = createQoderClient({ tokens, config: current, logger: ctx.logger });
  const account = createQoderAccountClient({ tokens, config: current, logger: ctx.logger });

  const shim = createQoderShim({ client, catalog, logger: ctx.logger });

  /**
   * 探查用的账号标识 —— **必须来自凭据，不能读配置**。
   *
   * ## 为什么（2026-10-08 修）
   *
   * 这里原来是 `() => current()?.account`，即读**配置对象**里的一个字段。而该字段
   * 从来没人写过（profile 里只有 autoCheckin / disabledChannels / disabledModels），
   * 于是 `ProbeService.probe()` 里的
   *
   *     const account = this.options.account();
   *     if (account === undefined) return { state: "unavailable", reason: "no credential" };
   *
   * 每次都命中 —— **面板上点「检测档位」必然返回 `no credential`**，与凭据是否有效
   * 完全无关。状态行仍显示 `signed-in`（那条路走的是凭据解析），所以现象看起来
   * 自相矛盾：「已登录」却「没有凭据」。
   *
   * 对照 WorkBuddy：它用的是 `account: () => identityOf(variant.id)` —— 动态解析真实
   * 身份（`uid:enterpriseId`），所以那条路一直能探（`.workbuddy1-probe.json` 有记录）。
   * 本次修复就是把 Qoder 对齐到同一思路：**身份来自 tokens，而不是配置。**
   *
   * ## 为什么要缓存
   *
   * `ProbeService` 同步调用 `account()`，而 `tokens.get()` 是异步的（可能要刷新
   * jobToken）。所以这里维护一个**同步可读**的缓存，由凭据巡检在每次拿到凭据时刷新。
   * 缓存没热起来时返回 undefined —— 与旧行为一致（探查返回 no credential），
   * 但下一次巡检（默认 30 s）后就好了，属于可接受的冷启动窗口。
   */
  let probeAccountCache;
  const refreshProbeAccount = () => {
    tokens
      .get()
      .then((credential) => {
        const uid = typeof credential?.userID === "string" ? credential.userID.trim() : "";
        if (uid !== "") probeAccountCache = uid;
      })
      .catch(() => {
        /* 拿不到凭据就保持上一次的值；签出后再签入时会重新填上 */
      });
  };
  const probeAccount = () => probeAccountCache;
  // 立刻热一次（插件刚启动、凭据已在盘上时，第一次点击探查就能用）。
  refreshProbeAccount();

  /**
   * 推理等级探查。
   *
   * Qoder 的档位**优先**取上游目录的 `thinking_config.enabled.efforts` 声明
   * （逐模型精确）；探查只为**没声明**的那些兜底（哨兵拒绝法，见 {@link createQoderProbe}）。
   */
  const probe = createQoderProbe({
    tokens, config: current, catalog, logger: ctx.logger,
    account: () => probeAccount(),
    // 探查完必须广播一次：档位写在模型描述符里，重建后 UI 才会出现档位下拉。
    onProbed: () => {
      try {
        ctx.emit("llm/adapters-updated");
      } catch (error) {
        ctx.logger?.warn?.("dsh-qoder-connect: 探查后广播模型更新失败", error);
      }
    },
  });
  // shim 需要读探查结论来决定"这个模型是否开思考"，所以创建后再挂上去。
  // （顺序反了会踩 TDZ：`const` 在声明前不可访问。）
  shim.setProbe?.(probe);

  // 渠道状态行（渠道 / 倍率 / 额度 / 签到）走 DSH 自己的 webServer，不是回环 shim ——
  // 前者给浏览器同源读取，后者只给 pi-ai 发 OpenAI 请求。webServer 在非 web
  // profile 里不存在，所以用 ctx.inject 做可选依赖。
  ctx.inject(["webServer"], (webCtx) => {
    if (stopped) return;
    try {
      registerQoderStatusRoutes(webCtx, { pats, sessions, tokens, catalog, account, probe });
    } catch (error) {
      ctx.logger?.warn?.("dsh-qoder-connect: 状态路由注册失败（渠道本身不受影响）", error);
    }
  });

  shim.ready.then(() => {
    if (stopped) return;
    const { adapter, invalidate } = createQoderAdapter({
      shim,
      catalog,
      hidden: () => externalHidden(QODER_PROVIDER),
      probe,
      /** 附件仓库解析器；缺了它，带图请求会被宿主在进 pi-ai 之前拒掉（UNSUPPORTED_CONTENT）。 */
      resolveAttachments: () => {
        const store = ctx.get("attachments");
        return store === undefined ? undefined : withLegacyImageBudget(store, REQUEST_IMAGE_BUDGETS.requestImagePixelBudget);
      },
    });
    const release = ctx.llm.registerAdapter([QODER_PROVIDER], adapter);
    try {
      ctx.effect(() => () => { release(); shim.close(); });
    } catch {
      release();
      shim.close();
    }

    const refresh = () => {
      if (stopped) return;
      // 顺带热一次探查用的身份缓存（凭据已在这里解析，不必再起一条异步链）。
      refreshProbeAccount();
      tokens.get().then(
        (credential) => catalog.reload().then(
          () => {
            if (stopped) return;
            invalidate();
            ctx.emit("llm/adapters-updated");
            const models = catalog.current();
            writeState({
              ready: true,
              provider: QODER_PROVIDER,
              shim: shim.baseUrl(),
              userId: credential.userID,
              patSource: credential.source,
              jobTokenExpiresAt: new Date(credential.expiresAt).toISOString(),
              catalogSource: catalog.source(),
              modelCount: models.length,
              models: models.map((model) => ({ id: model.id, rate: model.rate, free: model.isFree })),
            }, ctx.logger);
            ctx.logger.info(`dsh-qoder-connect: Qoder 已就绪（uid=${credential.userID}，${models.length} 个模型）`);
          },
          (error) => {
            if (stopped) return;
            const message = error instanceof Error ? error.message : String(error);
            // 目录挂了但凭据是好的：渠道仍然可用（只是沿用兜底名单）。
            invalidate();
            ctx.emit("llm/adapters-updated");
            writeState({
              ready: true,
              provider: QODER_PROVIDER,
              shim: shim.baseUrl(),
              userId: credential.userID,
              catalogSource: catalog.source(),
              modelCount: catalog.current().length,
              catalogError: message,
            }, ctx.logger);
            ctx.logger.warn(`dsh-qoder-connect: 目录刷新失败，渠道沿用兜底名单 — ${message}`);
          },
        ),
        (error) => {
          if (stopped) return;
          const message = error instanceof Error ? error.message : String(error);
          writeState({ ready: false, provider: QODER_PROVIDER, shim: shim.baseUrl(), patPath: pats.path(), error: message }, ctx.logger);
          ctx.logger.warn(`dsh-qoder-connect: 未就绪 — ${message}`);
        },
      );
    };

    refresh();
    const timer = setInterval(refresh, pollInterval(current()));
    timer.unref?.();
    ctx.effect(() => () => { clearInterval(timer); });
  }).catch((error) => {
    ctx.logger?.error?.("dsh-qoder-connect: 回环 shim 启动失败", error);
  });

  ctx.effect(() => () => { stopped = true; });
}

//#endregion
