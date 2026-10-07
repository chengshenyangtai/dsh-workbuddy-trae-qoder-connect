/**
 * 面板与聚合（宿主侧）—— 属于 dsh-connect 这个唯一插件。
 *
 * ## 它是什么 / 不是什么
 *
 * 它**不是** provider 插件：不注册模型、不起回环 shim、**完全不碰凭据**
 * （token / PAT / 凭据文件都不读）。它只做两件事：
 *
 *   1. 把各插件**既有的**回环路由扇出、归一化成一份统一文档给浏览器侧；
 *   2. 提供「一键签到」——并发调各插件既有的 POST /checkin。
 *
 * 因此它不依赖任何插件的内部结构，**加渠道 = 在 HUB_CHANNELS 里加一行**；
 * 某个渠道插件没装 / 没登录 / 上游挂了，也只影响它自己那一行。
 *
 * ## 为什么走 HTTP 扇出而不是进程内直连
 *
 * 三个插件各自把状态/签到路由挂在 DSH 自己的 webServer 上，守卫统一是
 * 「Host + Origin 双回环」（**缺失 Origin 放行** —— 宿主进程内 fetch 不带 Origin，
 * 天然通过）。这条缝已经存在且稳定，复用它比自己另开一套进程内注册表更省事：
 * 三插件零改动，hub 可整体卸载。
 *
 * ## 安全
 *
 * - hub 自己的三个路由沿用同款回环守卫（非回环一律 403 `request-not-trusted`）。
 * - 扇出只发到 `127.0.0.1:<DSH_PORT>`，**不转发任何 Authorization**。
 * - 唯一可写的是 hub 自己的 settings 段（`dsh-connect`），字段仅三个布尔/字符串数组。
 */

import z from "@deepseek-ai/schemastery";
import { briefMessage, loopbackBaseFrom, loopbackRequest, writeJson } from "./shared/http.js";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import {
  CHANNEL_KINDS,
  allChannels,
  channelOf,
  nextWorkbuddySlot,
  readRegistry,
  registryPath,
  writeRegistry,
} from "./channel-registry.js";

//#region 常量

/** cordis 插件名，必须与 cordis.patch.yml 里的 `- id:` 逐字一致。 */
export const name = "connect-hub";

/** 三个路由；客户端侧的字面量必须与这里逐字一致。 */
export const HUB_STATUS_ROUTE = "/plugins/dsh-connect/status";
export const HUB_CHECKIN_ROUTE = "/plugins/dsh-connect/checkin";
export const HUB_SETTINGS_ROUTE = "/plugins/dsh-connect/settings";
export const HUB_MODELS_ROUTE = "/plugins/dsh-connect/models";
export const HUB_AUTH_ROUTE = "/plugins/dsh-connect/auth";
/**
 * 渠道管理动作现在**共用 `/auth` 端点**（见该路由里的说明：独立路由在 DSH 里注册不生效）。
 * 客户端不再需要单独的路径常量，保留这个名字只为文档可检索。
 */
export const HUB_CHANNELS_ROUTE = HUB_AUTH_ROUTE;

/**
 * hub 自己的设置命名空间。
 *
 * 名字必须符合 `^[a-z][a-z0-9-]*$`（dsh-settings 的 NAMESPACE_PATTERN）。
 * DSH 0.1.5 的设置 Plugins 页按「宿主在服务哪些命名空间」逐个派发
 * `settings.plugin.item`，所以客户端那张卡片的 key 也必须等于这个字符串。
 */
export const HUB_SETTINGS_NS = "dsh-connect";

/** 单渠道扇出的超时。状态接口内部各自还有 20-30s 的上游超时，这里只兜住"连不上自己"。 */
const FANOUT_TIMEOUT_MS = 8000;

//#endregion

//#region 渠道表

/**
 * **全部槽位**的清单 —— 数据驱动。
 *
 * `kind` 决定归一化映射（见 KIND_ADAPTERS）。新增一条渠道需要满足的唯一前提是：
 * 那个插件的 `<statusPath>` / `<checkinPath>` 已挂上且沿用同一套回环守卫。
 *
 * [2026-09-25] 渠道清单的**唯一事实源**已搬进 `lib/channel-registry.js`
 * （`$DSH_HOME/connect-channels.json`）：
 *   - `HUB_CHANNELS` 在这里按注册表生成，仅供「启动时注册一次」的消费方
 *     （单渠道签到 exact 路由、日志计数）取**启动快照**；
 *   - 面板 / `/auth` / `hubChannels` 每次请求都重读注册表（`allChannels()`），
 *     所以注册表改动对面板**即时生效**；
 *   - provider 侧（workbuddy 变体表）在模块加载时从同一份注册表生成 ——
 *     新**增**的 workbuddy 槽位要重启 DSH 才会真的注册 provider 与路由；
 *     改名/删除则面板即时、provider 下次启动跟上。
 *
 * 旧部署兼容：注册表文件不存在时回落与旧版逐字相同的内置默认
 * （workbuddy 1/2/3 + trae + qoder），见 channel-registry.js 的 DEFAULT_REGISTRY_CHANNELS。
 *
 * ⚠️ 槽位与 provider 变体表（`providers/workbuddy/variants-CnrmSn0Q.js` 的
 * `WORKBUDDY_VARIANTS`）**必须一一对应** —— 那张表决定 provider 侧真的注册了几个；
 * 这里多写一条只会得到一个永远 unavailable 的行。
 */
export const HUB_CHANNELS = allChannels();

/**
 * 认证页要展示的全部渠道（含空闲槽位）：每读一次注册表。
 *
 * 与 {@link HUB_CHANNELS}（启动快照）分开：认证页的「添加渠道」改注册表后，
 * 不重启也能立刻看到新槽位并给它粘贴凭据。
 */
function registryChannels() {
  return allChannels();
}

/**
 * 各渠道的凭据落点。
 *
 * ⚠️ 这里**只存路径、不存密钥内容**：页面把用户粘贴的凭据写进这些文件（0600），
 * 密钥永不进 settings.yaml，也永不回显。
 *
 * [2026-09-25] 落点已**统一**到 `$DSH_HOME/connect-auth/`，一渠道一文件：
 *
 *   connect-auth/workbuddy1.json       workbuddy 个人账号 1（明文快照，需 auth.accessToken）
 *   connect-auth/workbuddy2.json       workbuddy 个人账号 2
 *   connect-auth/workbuddy3.json       workbuddy 企业版账号
 *   connect-auth/trae.json             Trae 明文凭据快照（JSON）
 *   connect-auth/qoder.pat             官方 PAT（纯文本，读取时 trim）
 *   connect-auth/qoder-session.json    Qoder App 会话（优先于 PAT，由 qoder-vault.mjs 写出）
 *
 * 以前散在 `workbuddy/`、`trae/`、`qoder/` 三处，迁移或多端部署要逐个记路径、很容易漏
 * （实测 `devbox/secrets/` 里就少了企业版那份）。现在**搬这一个目录就能迁移**。
 *
 * workbuddy 仍保留环境变量覆盖（`WORKBUDDY{N}_AUTH_FILE`）：容器里由 compose 显式钉死，
 * 换成别的位置时不用改代码。三个 provider 的默认路径与这张表必须一致。
 */
function authTargets() {
  const dir = join(resolveDshHome(), "connect-auth");
  const env = (name) => {
    const value = process.env[name];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  };
  const targets = {};
  for (const channel of registryChannels()) {
    if (channel.kind === "workbuddy") {
      const slot = /^workbuddy(\d+)$/.exec(channel.id)?.[1];
      const envPath = slot === undefined ? undefined : env(`WORKBUDDY${slot}_AUTH_FILE`);
      targets[channel.id] = {
        kind: "workbuddy",
        // 注册表 id 与凭据文件名一一对应；老 compose 的环境变量仍然优先。
        path: envPath ?? join(dir, `${channel.id}.json`),
        source: `connect-auth/${channel.id}.json`,
        hint: `粘贴宿主导出的 ${channel.displayName} 明文快照（JSON，含 auth.accessToken）`,
      };
      continue;
    }
    if (channel.kind === "trae") {
      targets[channel.id] = {
        kind: "trae",
        path: join(dir, "trae.json"),
        source: "connect-auth/trae.json",
        hint: "粘贴 export-connect-credentials 导出的 Trae 凭据快照（JSON）",
      };
      continue;
    }
    if (channel.kind === "qoder") {
      targets[channel.id] = {
        kind: "qoder",
        path: join(dir, "qoder.pat"),
        source: "connect-auth/qoder.pat",
        hint: "粘贴官方 PAT（pt- 前缀）；也可用 qoder-vault.mjs 装 App 会话",
      };
    }
  }
  return targets;
}

/** 统一认证目录（`authTargets` 与下面这几个判定必须用同一个）。 */
function authDir() {
  return join(resolveDshHome(), "connect-auth");
}

/**
 * 某槽位**可能**存在的凭据文件。
 *
 * Qoder 是"会话优先、PAT 兜底"，所以有两个候选；其余槽位各一个。
 */
function candidatePaths(channelId) {
  const dir = authDir();
  if (channelId === "qoder") return [join(dir, "qoder-session.json"), join(dir, "qoder.pat")];
  const target = authTargets()[channelId];
  const paths = typeof target?.path === "string" ? [target.path] : [];
  /**
   * workbuddy 的**扫码登录**把凭据写进插件自有副本 `$DSH_HOME/.<id>-auth.json`，
   * 而不是 `connect-auth/<id>.json`（后者是「粘贴」的落点）。两者都是合法凭据来源，
   * 判定"这个槽位在不在用"必须都算上 —— 只看 connect-auth 会把纯扫码进来的账号
   * 当成空闲槽位：渠道页看不到它、一键签到也漏掉它，但它其实**已经登录**，
   * 直接打它的 status 路由就是 `signed-in`。这跟 README「扫码会接管这个槽位」
   * 的语义是矛盾的。
   */
  if (typeof channelId === "string" && /^workbuddy\d+$/.test(channelId)) {
    paths.push(join(resolveDshHome(), `.${channelId}-auth.json`));
  }
  return paths;
}

/**
 * 该槽位是否**已配置**（凭据文件存在）。
 *
 * 这是"这个渠道在不在用"的唯一判据：空槽位的 provider 一样会被注册、
 * 一样会回 `signed-out`，只能靠它把空位从渠道列表里剔除。
 */
export function slotConfigured(channelId) {
  return candidatePaths(channelId).some((path) => existsSync(path));
}

/**
 * 面板**渠道页**要展示的渠道 = 已配置的槽位（含被禁用的，好让用户看到"已禁用"并能启用回来）。
 *
 * 空槽位不出现在这里（否则就有一排"未登录"的噪音），但它们会出现在**认证页**里，
 * 等着被粘贴凭据 —— 那就是「添加渠道」。
 */
export function hubChannels(options = {}) {
  const prefs = livePrefs();
  const hidden = new Set(prefs.hiddenChannels);
  const disabled = new Set(prefs.disabledChannels);
  return registryChannels().filter(
    // `hiddenChannels` 只影响"面板列表里显不显示"，**不影响它参不参与** ——
    // 所以签到与单渠道路由（includeHidden）必须把它算进来，否则被隐藏的渠道
    // 会悄悄漏掉每日签到（用户只是不想看见它，不是不想签）。
    (channel) => slotConfigured(channel.id) && (options.includeHidden === true || !hidden.has(channel.id)),
  ).map((channel) => ({
    ...channel,
    disabled: disabled.has(channel.id),
  }));
}
//#endregion

//#region 小工具

const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/**
 * 模型倍率（展示用字符串）。
 *
 * 三个渠道的形态不一样，这里统一成显示字符串：
 *   workbuddy 在 `model.credits`，是字符串（形如 "x0.79"）
 *   qoder     在 `model.rate`，是字符串（形如 "0.5×"）
 *   trae      在 `model.rate`，是**数字**（0.78）—— 来自 `consumption_rate.data.rate`
 *
 * ⚠️ 早先只认字符串，于是 trae 的 `0.78`（number）被当成"没有倍率"直接丢掉。
 * 这里把数字补上格式化成 `x0.78`，与 workbuddy 的写法保持一致。
 */
function modelRate(model) {
  if (typeof model?.rate === "string" && model.rate !== "") return model.rate;
  if (typeof model?.rate === "number" && Number.isFinite(model.rate)) return `x${model.rate}`;
  if (typeof model?.credits === "string" && model.credits !== "") return model.credits;
  return undefined;
}

/** 展示用数字：整数不带小数，最多两位，带千分位。 */
function formatNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
}

/**
 * 账号脱敏：只做"别在截图里裸奔"这一层。
 *
 * 星号固定 3 颗，**不随长度变化** —— 否则打码本身就泄露了账号长度。
 * 短串（≤8）原样返回：那种长度掩掉之后就认不出是哪个账号了，反而有害。
 */
export function maskAccount(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") return undefined;
  const at = text.indexOf("@");
  if (at > 0) return `${text.slice(0, Math.min(2, at))}***${text.slice(at)}`;
  if (text.length <= 8) return text;
  return `${text.slice(0, 4)}***${text.slice(-4)}`;
}

//#endregion

//#region 归一化

/**
 * 额度归一化。
 *
 * 三个渠道的额度文档形状完全不同，这里各自收敛成
 * `{ value, label, resetAt?, progress? }`，**展示文案在宿主侧拼好**，客户端不做业务判断。
 */
function creditsOf(kind, doc) {
  if (kind === "workbuddy") {
    const credits = doc.credits;
    if (credits === undefined || credits === null) return undefined;
    const total = num(credits.total);
    const accounts = Array.isArray(credits.accounts) ? credits.accounts : [];
    /**
     * 个人版与企业版**共用一套算法**：把各包的 size / remain 分别求和。
     *
     * 企业版只有一条 `enterprise` 包（周期总额），求和就是它自己；
     * 个人版是**一长串裂变包** —— 实测 40 个（1 个在消耗 + 39 个满额赠送包），
     * 求和得到的是"总池子"。早先这里只认 `accounts.length === 1`，于是个人版
     * **完全没有进度条**；而其实每个包都带 size（实测 40/40），总量是算得出来的。
     *
     * 这个条反映的是**总池子**的消耗比例（个人版实测 4394/4795 ≈ 92%），
     * 而不是某一个包 —— 后者放在 40 个包的场景里会被误读成"总额度只有 500"。
     */
    const sumSize = accounts.reduce((acc, account) => acc + (num(account.size) ?? 0), 0);
    const sumRemain = accounts.reduce((acc, account) => acc + (num(account.remain) ?? 0), 0);
    const pooled = accounts.length > 0 && sumSize > 0;
    return {
      value: total,
      label:
        total === undefined
          ? undefined
          : pooled
            ? `${formatNumber(total)} / ${formatNumber(sumSize)}`
            : formatNumber(total),
      resetAt: typeof credits.cycleResetTime === "string" ? credits.cycleResetTime : undefined,
      ...pooled && sumRemain > 0 ? { progress: Math.min(1, sumRemain / sumSize) } : {},
      // 包数：个人版动辄几十个包，值得让界面点明"这个数字是几十个包加起来的"。
      ...accounts.length > 1 ? { packages: accounts.length } : {},
    };
  }
  if (kind === "trae") {
    const credits = doc.credits;
    if (credits === undefined || credits === null) return undefined;
    const remain = num(credits.remain);
    const total = num(credits.total);
    return {
      value: remain,
      label:
        remain === undefined
          ? undefined
          : total === undefined
            ? formatNumber(remain)
            : `${formatNumber(remain)} / ${formatNumber(total)}`,
      // Trae 没有"周期重置"概念，额度是按量消耗的。
      ...remain !== undefined && total !== undefined && total > 0 ? { progress: remain / total } : {},
    };
  }
  if (kind === "qoder") {
    const quota = doc.quota;
    if (quota === undefined || quota === null) return undefined;
    if (quota.unlimited === true) return { label: "不限量" };
    if (quota.enterprise === true) return { label: "按组织计量" };
    const remaining = num(quota.remaining);
    const total = num(quota.total);
    const used = num(quota.used);
    if (remaining !== undefined) {
      return {
        value: remaining,
        label: total === undefined ? formatNumber(remaining) : `${formatNumber(remaining)} / ${formatNumber(total)}`,
        ...total !== undefined && total > 0 ? { progress: remaining / total } : {},
      };
    }
    if (used !== undefined) return { value: undefined, label: `已用 ${formatNumber(used)}` };
    return undefined;
  }
  return undefined;
}

/**
 * 签到状态归一化。
 *
 * 统一成 `claimable` / `claimed` / `done` / `manual` / `unsupported` / `unavailable` /
 * `unknown` / `failed` 八态。其中 `unsupported`（渠道明确说不支持，重试无用）与
 * `unavailable`（现在问不到，重试可能就好）**必须分开** —— 前者不该给动作入口。
 * `checkinDoc` 是 GET `<checkinPath>` 的返回，**只有 workbuddy 需要**（它的状态文档
 * 不含签到字段，必须额外探一次）；trae / qoder 的状态文档里已经带了。
 */
function checkinOf(kind, doc, checkinDoc) {
  /**
   * [dsh-connect 2026-09-24] 自动签到那一趟拿的是 **POST <checkinPath> 的返回**，
   * 与渠道无关（三个渠道的 claim 都回 `{state}`），所以这段统一放在最前面。
   *
   * 为什么必须走 POST：workbuddy 的活动看板在活动未开放时整份都是默认值，
   * 判不出"今天签没签"；而 POST 的 10001（已签）/ `claimed`（刚领到）是可靠的。
   */
  if (checkinDoc !== undefined && checkinDoc.claim !== undefined) {
    const claim = checkinDoc.claim;
    const state = claim?.state;
    if (state === "claimed") return { state: "claimed", note: "刚刚领取" };
    if (state === "already-claimed" || state === "done") return { state: "done" };
    if (state === "manual-required") return { state: "manual", note: claim?.message };
    if (state === "unsupported") return { state: "unsupported", note: claim?.message };
    if (state === "disabled") return { state: "unavailable", note: claim?.message };
    if (state === "signed-out") return { state: "signed-out" };
    return { state: "failed", note: typeof claim?.message === "string" ? claim.message : "签到返回了未知结果" };
  }
  if (kind === "workbuddy") {
    // workbuddy 的 GET /checkin 回 `{ok:true,data:{active,today_checked_in,…}}`
    // 或 `{ok:false,code,message}`；它读的是**活动看板**，活动未开放时整份都是默认值，
    // 所以 active !== true 时只能给 unknown，不能断言"今天没签"。
    if (checkinDoc === undefined) return { state: "unknown" };
    if (checkinDoc.ok !== true) {
      return checkinDoc.code === undefined
        ? { state: "unknown" }
        : { state: "failed", note: checkinDoc.message };
    }
    const data = checkinDoc.data ?? {};
    // 企业账号：provider 已经明说不支持，别再渲染成可点的「签到」。
    if (data.unsupported === true) return { state: "unsupported", note: data.message };
    // ⚠️ 看板 `active:false` / `today_checked_in:false` 是**默认值**（上游在活动未开放时
    // 整份文档都是默认值，插件自己的注释也警告过不能据此断言"今天没签"）。
    // 实测这三条渠道的看板长期 active=false，而 daily-checkin 是活的、
    // 幂等（已签回 code 10001 → already-claimed）。所以这种情况给**可点的签到**，
    // 点了以真实结果为准，而不是给一个死的"未知"。
    if (data.today_checked_in === true) return { state: "done" };
    return {
      state: "claimable",
      ...data.active === true ? {} : { note: "签到看板未开放（默认值）；点『签到』以实际结果为准" },
    };
  }
  if (kind === "trae") {
    const checkin = doc.checkin;
    if (doc.checkinError !== undefined) return { state: "failed", note: String(doc.checkinError).slice(0, 300) };
    if (checkin === undefined || checkin === null) return { state: "unknown" };
    if (checkin.enable === false) return { state: "unsupported", note: "Trae 当前未开放签到" };
    if (checkin.checkedIn === true) return { state: "done" };
    return { state: "claimable", ...checkin.credits === undefined ? {} : { reward: num(checkin.credits) } };
  }
  if (kind === "qoder") {
    const checkin = doc.checkin;
    if (doc.checkinError !== undefined) return { state: "failed", note: String(doc.checkinError).slice(0, 300) };
    if (checkin === undefined || checkin === null) return { state: "unknown" };
    if (checkin.supported === false) return { state: "unsupported", note: checkin.reason };
    // 有可领 → 就给**可点的签到**：领取接口是真的（`POST /sash/api/v1/me/campaigns/<id>/claim`），
    // 见 providers/qoder/index.js 的 createQoderAccountClient 函数头。
    // 这里曾经只能报 `manual`（"去桌面 App 领"），那是基于「OpenAPI 平面没有 claim 端点」的
    // 错误结论 —— 那条路径是活动页拼出来的，静态搜字符串搜不到（2026-09-27 更正）。
    if (checkin.claimable === true) {
      return {
        state: "claimable",
        ...checkin.reward === undefined ? {} : { reward: num(checkin.reward) },
        note: checkin.reason,
      };
    }
    // 「活动在、今天不可领」= 今天已领过 / 已结束 → done。
    if (checkin.showCampaign === true || checkin.claimedToday === true) return { state: "done" };
    // [dsh-connect 2026-09-27] 「压根没有活动」：`showCampaign=false` 且 `claimable=false`
    // 且 `campaigns:[]`。必须报 unsupported → 界面显示"不适用"、不给动作入口。
    //
    // ⚠️ 注意这个形状**有两种来源**，必须都能覆盖：
    //   1. 账号确实没有任何进行中的活动（企业号、活动之间的空档）；
    //   2. **请求头 `Cosy-ClientType` 用错**——服务端不报错，只回一份同样形状的空文档。
    //      这正是 2026-09-27「Qoder 签到看着没成功」的根因（当时用的是 5，本端点是门控的，
    //      正确值是 10）。所以看到这一支先怀疑头，别急着下"账号没活动"的结论。
    // 无论如何**不能**报 already-claimed —— 那会被 normalizeClaim 映射成 done，
    // 界面显示"已签到"，用户以为签到成功却看不到积分增加。
    return { state: "unsupported", note: checkin.reason ?? "当前账号没有进行中的签到活动" };
  }
  return { state: "unknown" };
}

/** 各 kind 的适配器：要不要额外探签到、怎么归一化。 */
const KIND_ADAPTERS = {
  // probeCheckin：状态文档里没有签到信息、需要额外探一次（只有 workbuddy 这样）
  // autoClaim   ：能被"自动签到"直接领取。
  //                qoder **可以**：`POST /sash/api/v1/me/campaigns/<id>/claim` 是真实存在的
  //                领取接口（2026-09-27 更正；早先以为领取只能在桌面 App 里做，
  //                那条结论来自"静态搜不到 claim 路径"，而该路径是活动页拼出来的）。
  workbuddy: { probeCheckin: true, autoClaim: true, creditsOf, checkinOf },
  trae: { probeCheckin: false, autoClaim: true, creditsOf, checkinOf },
  qoder: { probeCheckin: false, autoClaim: true, creditsOf, checkinOf },
};

/**
 * 把一条渠道的原始响应收敛成统一行。
 *
 * 契约：**永不抛**。任何解析失败都降级成 `state:"error"` 的一行，
 * 这样弹窗里能看到"这一条怎么了"，而不是整份文档 500。
 */
export function normalizeChannel(channel, raw, checkinDoc, transportError) {
  const base = {
    id: channel.id,
    provider: channel.provider,
    displayName: channel.displayName,
    kind: channel.kind,
    credentialHint: channel.credentialHint,
  };
  if (raw === undefined) {
    return {
      ...base,
      state: "unavailable",
      error: transportError === undefined ? "插件未响应（未安装或未启动）" : briefMessage(transportError),
    };
  }
  if (typeof raw !== "object" || raw === null) return { ...base, state: "error", error: "状态文档不是对象" };
  if (raw.status === "signed-out") {
    return { ...base, state: "signed-out", error: typeof raw.reason === "string" ? raw.reason : undefined };
  }
  if (raw.status !== "signed-in") return { ...base, state: "error", error: `未知状态 ${JSON.stringify(raw.status)}` };

  const adapter = KIND_ADAPTERS[channel.kind] ?? KIND_ADAPTERS.workbuddy;
  const account =
    channel.kind === "workbuddy"
      ? raw.nickname
      : typeof raw.account === "string" && raw.account !== ""
        ? raw.account
        : raw.email;

  let credits;
  let creditsError;
  try {
    credits = adapter.creditsOf(channel.kind, raw);
  } catch (error) {
    creditsError = briefMessage(error);
  }

  let checkin;
  try {
    checkin = adapter.checkinOf(channel.kind, raw, checkinDoc);
  } catch (error) {
    checkin = { state: "unknown", note: briefMessage(error) };
  }

  return {
    ...base,
    state: "signed-in",
    account: maskAccount(account),
    /**
     * Trae 渠道把「现在接的是哪个产品」透出（`cn` = Trae IDE / `solo` = TraeWork）。
     *
     * 为什么不能让面板自己拼进 `displayName`：那个字段是用户在认证页「改名」写的，
     * 覆盖它等于吃掉用户的命名。所以单列一个标签，由界面画成名字旁边的小 chip。
     * 两个产品共用 `connect-auth/trae.json` 这一份凭据（最后一次导出者赢），
     * 界面上没有这个标签就完全看不出当前用的是哪一份 —— 出问题时无从下手。
     */
    ...typeof raw.productLabel === "string" && raw.productLabel !== ""
      ? { product: raw.product, productLabel: raw.productLabel, packageType: raw.packageType }
      : {},
    modelCount: Array.isArray(raw.models) ? raw.models.length : num(raw.modelCount),
    // 面板要按渠道列模型做"禁用"配置；上限 200 条，避免把超大目录塞进浏览器。
    ...Array.isArray(raw.models)
      ? {
          models: raw.models
            .slice(0, 200)
            .map((m) => ({
              id: String(m?.id ?? ""),
              name: String(m?.name ?? m?.id ?? ""),
              ...modelRate(m) === undefined ? {} : { rate: modelRate(m) },
            }))
            .filter((m) => m.id !== ""),
        }
      : {},
    credits,
    ...raw.creditsError === undefined && raw.quotaError === undefined ? {} : { creditsError: String(raw.creditsError ?? raw.quotaError).slice(0, 300) },
    ...creditsError === undefined ? {} : { creditsError },
    checkin,
  };
}

/**
 * 签到结果的归一化。
 *
 * 三个插件的 claim 返回各自的 `state` 字面量，这里映射成统一态 + 原样透出 note。
 * 注意 Qoder **永远不会回 `claimed`**（领取动作在桌面 App 里），只会回 `manual-required`。
 *
 * `unsupported` 与 `unavailable` 是**两件事**，别合：
 *   - `unsupported` = 渠道**明确**说了不支持（企业版账号、活动未开放）→ 界面显示"不适用"，
 *     不给动作入口，重试也没用；
 *   - `unavailable` = **现在问不到**（插件没装 / 没登录）→ 界面显示"未响应"，重试可能就好了。
 * 早先把两者都压成 `unavailable`，结果企业版账号会显示成一个可点的「签到」按钮。
 */
export function normalizeClaim(channel, payload, transportError) {
  if (transportError !== undefined) {
    return { id: channel.id, displayName: channel.displayName, state: "failed", note: briefMessage(transportError) };
  }
  const base = { id: channel.id, displayName: channel.displayName };
  if (payload === undefined || typeof payload !== "object") return { ...base, state: "failed", note: "签到接口没有返回可解析的 JSON" };
  const note = typeof payload.message === "string" && payload.message !== "" ? payload.message.slice(0, 300) : undefined;
  switch (payload.state) {
    case "claimed":
      return { ...base, state: "claimed", ...note === undefined ? {} : { note } };
    case "already-claimed":
      return { ...base, state: "done" };
    case "manual-required":
      return { ...base, state: "manual", ...note === undefined ? {} : { note }, ...typeof payload.campaignUrl === "string" ? { campaignUrl: payload.campaignUrl } : {} };
    case "unsupported":
      return { ...base, state: "unsupported", ...note === undefined ? {} : { note } };
    case "disabled":
      return { ...base, state: "unavailable", ...note === undefined ? {} : { note } };
    case "signed-out":
      return { ...base, state: "signed-out" };
    default:
      return { ...base, state: "failed", ...note === undefined ? { note: `未知返回 ${JSON.stringify(payload.state)}` } : { note } };
  }
}

//#endregion

//#region 扇出

/**
 * 扇出基址（无请求上下文时的兜底）：`DSH_PORT` → `DSH_WEB_URL` 的端口 → 3079。
 *
 * 正常路径走 {@link fanoutBaseOf}：由**进来的请求 Host** 决定（见 `loopbackBaseFrom`
 * 的说明）。这里只是没有请求可依时的兜底 —— 例如测试直接调 `probeAll()`、
 * 或将来有别的东西在进程内主动探一次状态。
 *
 * `DSH_WEB_URL` 那一档是为桌面宿主加的：它按 `dsh web --port <n>` 起服务，
 * `DSH_PORT` 不在其进程环境里（那是 compose 注入的），但 GUI 地址会以
 * `DSH_WEB_URL` 暴露给宿主侧。
 */
function loopbackBaseFallback() {
  const fromEnv = String(process.env.DSH_PORT ?? "").trim();
  if (fromEnv !== "") return `http://127.0.0.1:${fromEnv}`;
  try {
    const url = new URL(String(process.env.DSH_WEB_URL ?? "").trim());
    if (url.protocol === "http:" && url.port !== "") return `http://127.0.0.1:${url.port}`;
  } catch {
    /* 缺失/畸形都不算错，落到默认档 */
  }
  return `http://127.0.0.1:3079`;
}

/**
 * 本次扇出该用的基址：**请求 Host 优先**，拿不到再回退。
 *
 * 为什么不是"进程级常量"：桌面宿主的端口是启动参数（动态的），而每个进来的请求
 * 都自带正确的 Host。以请求为准，同一个进程里既不需要读环境变量、也不怕将来
 * 换端口。非回环 Host 会被 `loopbackBaseFrom` 拒掉，不会拿外部输入当跳板。
 */
function fanoutBaseOf(req) {
  const fromRequest = loopbackBaseFrom(req?.headers?.host);
  return fromRequest ?? loopbackBaseFallback();
}

/**
 * 打一次同进程内的回环路由。
 *
 * `Host` 由 fetch 依 URL 自动带（127.0.0.1），Origin 显式补上 ——
 * 各插件要求"浏览器发的 Origin 必须是回环"，补上它比依赖"缺失即放行"更稳。
 */
async function fetchRoute(path, { method = "GET", timeoutMs = FANOUT_TIMEOUT_MS, base = loopbackBaseFallback() } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { Accept: "application/json", Origin: base },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    // 404 = 该渠道插件没装；其余按错误透出。
    throw new Error(response.status === 404 ? "404（该渠道插件未安装）" : `HTTP ${response.status}：${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`返回的不是 JSON：${text.slice(0, 120)}`);
  }
}

/** 扇出一条渠道：拉状态（workbuddy 还要额外探一次签到看板）。 */
export async function probeChannel(channel, options = {}) {
  const base = options.base ?? loopbackBaseFallback();
  let raw;
  try {
    raw = await fetchRoute(channel.statusPath, { base });
  } catch (error) {
    return normalizeChannel(channel, undefined, undefined, error);
  }
  const adapter = KIND_ADAPTERS[channel.kind] ?? KIND_ADAPTERS.workbuddy;
  let checkinDoc;
  const signedIn = raw !== undefined && raw.status === "signed-in";
  if (options.autoCheckin === true && adapter.autoClaim === true && signedIn) {
    // 自动签到：POST 领取（幂等）。这一趟同时把"今天签没签"带回来。
    try {
      checkinDoc = { claim: await fetchRoute(channel.checkinPath, { method: "POST", timeoutMs: 25000, base }) };
    } catch (error) {
      checkinDoc = { claim: { state: "failed", message: briefMessage(error) } };
    }
  } else if (adapter.probeCheckin === true && signedIn) {
    try {
      checkinDoc = await fetchRoute(channel.checkinPath, { base });
    } catch {
      /* 签到看板拿不到不影响这一行；checkin 会退化成 unknown */
    }
  }
  return normalizeChannel(channel, raw, checkinDoc);
}

/** 扇出所有渠道（并发，互不影响）。 */
export async function probeAll(channels = registryChannels(), options = {}) {
  const results = await Promise.all(channels.map((channel) => probeChannel(channel, options)));
  return results;
}

/** 汇总行：给 dock 按钮的角标用。 */
export function summarize(rows) {
  const summary = { total: rows.length, signedIn: 0, claimable: 0, done: 0, manual: 0, unsupported: 0, issues: 0 };
  for (const row of rows) {
    if (row.state === "signed-in") summary.signedIn += 1;
    else summary.issues += 1;
    const state = row.checkin?.state;
    if (state === "claimable") summary.claimable += 1;
    // `claimed`（**本次刚领到**，来自自动签到那一趟的 POST 返回）与 `done`（今天已领过）
    // 对用户是同一件事，都要算进「已签」。漏掉 claimed 的话，每天**第一次**签到的那一刻
    // 汇总会少一档（当天后续刷新才补上）—— 2026-09-27 发现并修掉。
    else if (state === "done" || state === "claimed") summary.done += 1;
    else if (state === "manual") summary.manual += 1;
    else if (state === "unsupported") summary.unsupported += 1;
  }
  return summary;
}

//#endregion

//#region 设置段

/**
 * hub 自己能改的东西：只有几个偏好项，业务配置一律留在各插件自己那里。
 *
 * ## 为什么每个字段都带 `.volatile()`
 *
 * DSH 0.1.7-rc.2 起 `ctx.settings` 由 `SettingsProvider`（插件 `register(ns, schema)`
 * 自建命名空间）换成了 `SettingsForms`（**插件自己的 `Config` 就是表单**）。
 * 新版只把「**volatile** 字段」当作可编辑字段（见 `dsh-settings` 的
 * `volatileForm` / `isVolatilePath`）：没有 volatile 字段的条目会被直接跳过
 * —— `describe()` 不返回它、`update()` 报 `has no volatile fields`。
 *
 * 约束（`schemastery` 的 `validateVolatileSchema`）：volatile **不能嵌套**，
 * 且数组/字典的**元素内**不能标 volatile（索引不是固定路径）。所以这里的规则是
 * 「根对象不标，每个直接子字段标」；`z.array(z.string())` 标在数组本身上。
 *
 * 这个 schema 现在**同时**是插件的 `Config`（见 lib/index.js 的 `export const Config`），
 * 所以改这里的字段 = 同时改设置表单和插件配置，二者不会再漂移。
 */
export const HUB_SECTION = z.object({
  autoCheckin: z.boolean().default(true).description("打开面板时自动领取各渠道的每日签到（幂等；同时也是 workbuddy 签到状态的唯一可靠来源）").volatile(),
  showDockButton: z.boolean().default(true).description("在左侧栏显示渠道中心入口（关掉后只能从设置页打开面板）").volatile(),
  hiddenChannels: z.array(z.string()).default([]).description("在面板里隐藏的渠道 id").volatile(),
  /**
   * 被**禁用**的渠道 id。
   *
   * 与 `hiddenChannels` 是两件事，别混：
   *   - `hiddenChannels` —— 面板列表里不显示，但模型照常可用（少看一眼而已）；
   *   - `disabledChannels` —— 该渠道所有模型对模型选择器**不可见**，也不参与一键签到。
   *     凭据保留，随时可启用回来。
   *
   * 实现复用既有的 `setExternalHidden` 钩子（与"禁用单个模型"同一条路），
   * 所以**运行时即刻生效，不需要重启**。
   */
  disabledChannels: z.array(z.string()).default([]).description("禁用的渠道 id（其模型不可见、不参与签到；凭据保留）").volatile(),
  disabledModels: z.array(z.string()).default([]).description("禁用的模型，条目形如 <provider id>/<模型 id>").volatile(),
});

export const HUB_DEFAULTS = { autoCheckin: true, showDockButton: true, hiddenChannels: [], disabledChannels: [], disabledModels: [] };

/**
 * 从 settings 服务读回本插件那一段的**权威值**（已过 schema，含默认值）。
 *
 * 取代 0.1.7-rc.2 里被删掉的 `settings.section(ns)`：新 API 没有「按 ns 读一段」，
 * 只有 `describe()`（返回所有具备 volatile 字段的 profile 条目），所以这里按
 * `ns === HUB_SETTINGS_NS` 找自己那一行。读不到就交给调用方回退默认值。
 */
/**
 * volatile 配置引用的识别符号 —— 等价于 cosmokit ≥1.8.5 的 `isVolatile()`。
 *
 * `createVolatile()` 返回的是
 * `Object.freeze({ get, [Symbol.for('cosmokit.volatile.write')]: write })`。
 * 这里用**全局 Symbol** 直判，跨版本/跨 ESM-CJS 副本都成立（profile 里钉的
 * cosmokit 与宿主内部那份未必同版本）。
 */
const VOLATILE_WRITE = Symbol.for("cosmokit.volatile.write");
const isVolatileRef = (value) => typeof value === "object" && value !== null && VOLATILE_WRITE in value;

/** 把 volatile 配置引用递归摊平成普通值（引用本身只认 `.get()`）。 */
const unwrapConfig = (value) => {
  if (isVolatileRef(value)) return unwrapConfig(value.get());
  if (Array.isArray(value)) return value.map(unwrapConfig);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, unwrapConfig(child)]));
  }
  return value;
};

/**
 * 从 settings 服务按 ns 读回本插件那一段（**兜底读源**，不是主路径）。
 *
 * 取代 0.1.7-rc.2 里被删掉的 `settings.section(ns)`。注意它的**局限**：
 * `describe()` 只列 `entry.fiber.state === 2` 的条目，而 `update()` 写 profile patch
 * 会让本插件条目**热重载** —— 重载窗口里这里读到 `undefined`。所以主路径读的是
 * 插件自己的 volatile 引用；这个函数只在「apply 拿到的 config 不是解析结果」时兜底。
 */
export function readHubSection(settingsApi) {
  try {
    const rows = settingsApi?.describe?.({ redactSecrets: true }) ?? [];
    return rows.find((row) => row.ns === HUB_SETTINGS_NS)?.value;
  } catch {
    return undefined;
  }
}

/** 把用户层（可能残缺）收敛成完整偏好。 */
export function resolvePrefs(raw) {
  const source = raw !== null && typeof raw === "object" ? raw : {};
  return {
    autoCheckin: source.autoCheckin !== false,
    showDockButton: source.showDockButton !== false,
    hiddenChannels: Array.isArray(source.hiddenChannels)
      ? source.hiddenChannels.filter((value) => typeof value === "string")
      : [],
    disabledChannels: Array.isArray(source.disabledChannels)
      ? source.disabledChannels.filter((value) => typeof value === "string")
      : [],
    disabledModels: Array.isArray(source.disabledModels)
      ? source.disabledModels.filter((value) => typeof value === "string" && value.includes("/"))
      : [],
  };
}

/**
 * 面板偏好的"活值" —— 供 provider 侧读取。
 *
 * provider 不认识面板，它们通过 lib/index.js 注入的钩子调用 {@link disabledModelsFor}；
 * 这里必须是个**每次重新求值**的闭包（不能缓存快照），否则用户在面板里改完不生效。
 * 未装设置段时它就是 HUB_DEFAULTS。
 */
let livePrefs = () => HUB_DEFAULTS;

/** 某个 provider 被禁用的模型 id 列表（provider id 就是渠道的 provider 字段）。 */
export function disabledModelsFor(providerId) {
  const entries = livePrefs().disabledModels;
  const prefix = `${providerId}/`;
  const out = [];
  for (const entry of entries) {
    if (entry.startsWith(prefix)) out.push(entry.slice(prefix.length));
  }
  return out;
}

/** 给一行渠道补上每个模型的 `disabled` 标记（面板据此渲染勾选框）。 */
export function decorateModels(row, disabledModels) {
  if (!Array.isArray(row.models)) return row;
  const mine = new Set(disabledModelsFor(row.provider));
  return {
    ...row,
    models: row.models.map((model) => ({ ...model, disabled: mine.has(model.id) })),
    disabledModels: [...mine],
  };
}

//#endregion

//#region 路由

/**
 * 注册 hub 的四类路由：状态、全部签到、单渠道签到、偏好读写。
 *
 * `prefs` 与 `settingsApi` 用 getter 传进来（而不是值），因为设置段是**可选注入**的：
 * settings 服务晚于 webServer 就绪是正常的，闭包必须在调用时再取。
 */
export function registerHubRoutes(ctx, deps) {
  const routes = [
    [
      HUB_STATUS_ROUTE,
      async (req, res) => {
        if (!loopbackRequest(req)) return writeJson(res, 403, { error: "request-not-trusted" });
        if (req.method !== "GET") return writeJson(res, 405, { error: "method not allowed" });
        const prefsNow = deps.prefs();
        /**
         * 自动签到的门控 = 「偏好开着」**且**「请求带 `?auto=1`」。
         *
         * ⚠️ **客户端三个调用点（角标、弹窗、设置页卡片）现在一律带 `auto=1`**，
         * 所以这里事实上只剩偏好在把关。曾经只有弹窗带、角标不带，刻意"避免在读路径上写"，
         * 结果两条路**不同源**：角标恒显示「可签 2」，弹窗同一时刻显示「已签」。
         *
         * 那个"避免在读路径上写"的取舍站不住脚，因为 **workbuddy 的「今天签没签」压根
         * 没有只读来源**：它的签到看板（`/v2/billing/meter/checkin-status`）在活动未开放时
         * 整份都是默认值，**当天已签到也依然如此**；唯一可靠来源是幂等的 `daily-checkin`。
         * 只读路径猜出来的 `claimable` 不是"可签"、是"不知道"，拿它当角标数字必然不准。
         * 详见 panel-client.js 的 `useHubStatus`。**别把角标那条改回不带 auto。**
         */
        const auto = prefsNow.autoCheckin === true && String(req.url ?? "").includes("auto=1");
        const disabledChannels = new Set(prefsNow.disabledChannels);
        const rows = hideAll(await probeAll(hubChannels(), { autoCheckin: auto, base: fanoutBaseOf(req) }), prefsNow.hiddenChannels)
          .map((row) => decorateModels(row, prefsNow.disabledModels))
          // 被禁用的渠道照常返回，只多一个标记 —— 面板据此把它画成灰色并给"启用"入口。
          // 它的模型此时已经全在 disabledModels 里，所以模型选择器里也不会出现。
          .map((row) => (disabledChannels.has(row.id) ? { ...row, disabled: true } : row));
        writeJson(res, 200, {
          channels: rows,
          summary: summarize(rows),
          preferences: deps.prefs(),
          fetchedAt: Date.now(),
        });
      },
    ],
    [
      HUB_CHECKIN_ROUTE,
      async (req, res) => {
        if (!loopbackRequest(req)) return writeJson(res, 403, { error: "request-not-trusted" });
        if (req.method !== "POST" && req.method !== "GET") return writeJson(res, 405, { error: "method not allowed" });
        const results = await claimAll(deps.channels(), { base: fanoutBaseOf(req) });
        writeJson(res, 200, { results, summary: summarizeClaims(results) });
      },
    ],
    [
      HUB_SETTINGS_ROUTE,
      async (req, res) => {
        if (!loopbackRequest(req)) return writeJson(res, 403, { error: "request-not-trusted" });
        if (req.method === "GET") return writeJson(res, 200, deps.prefs());
        if (req.method !== "POST") return writeJson(res, 405, { error: "method not allowed" });
        const settingsApi = deps.settingsApi();
        if (settingsApi === undefined || typeof settingsApi.update !== "function") {
          return writeJson(res, 503, { error: "settings-unavailable" });
        }
        let patch;
        try {
          patch = JSON.parse(await readBody(req));
        } catch {
          return writeJson(res, 400, { error: "bad-json" });
        }
        // 只接受自己 schema 里的三个键，其余一律丢弃 —— 免得把任意键写进 settings.yaml。
        const safe = {};
        if (typeof patch?.autoCheckin === "boolean") safe.autoCheckin = patch.autoCheckin;
        if (typeof patch?.showDockButton === "boolean") safe.showDockButton = patch.showDockButton;
        if (Array.isArray(patch?.hiddenChannels)) {
          safe.hiddenChannels = patch.hiddenChannels.filter((value) => typeof value === "string");
        }
        if (Object.keys(safe).length === 0) return writeJson(res, 400, { error: "no-whitelisted-field" });
        try {
          await settingsApi.update(HUB_SETTINGS_NS, safe);
        } catch (error) {
          return writeJson(res, 500, { error: briefMessage(error) });
        }
        // 写完回读，让调用方拿到权威值（settings 的合并规则不在 hub 这边）。
        // `deps.prefs()` 每次都现读 describe()，所以这里天然是"写后权威值"；
        // 旧版用的 `settingsApi.section(ns)` 在 0.1.7-rc.2 已被移除。
        const resolved = deps.prefs();
        writeJson(res, 200, resolved);
      },
    ],
    [
      HUB_MODELS_ROUTE,
      async (req, res) => {
        if (!loopbackRequest(req)) return writeJson(res, 403, { error: "request-not-trusted" });
        if (req.method === "GET") {
          const prefsNow = deps.prefs();
          const rows = hideAll(await probeAll(registryChannels(), { base: fanoutBaseOf(req) }), prefsNow.hiddenChannels).map((row) => decorateModels(row, prefsNow.disabledModels));
          writeJson(res, 200, {
            channels: rows.map((row) => ({
              id: row.id,
              provider: row.provider,
              displayName: row.displayName,
              state: row.state,
              models: Array.isArray(row.models) ? row.models : [],
              disabledModels: Array.isArray(row.disabledModels) ? row.disabledModels : [],
            })),
          });
          return;
        }
        if (req.method !== "POST") return writeJson(res, 405, { error: "method not allowed" });

        const settingsApi = deps.settingsApi();
        if (settingsApi === undefined || typeof settingsApi.update !== "function") {
          return writeJson(res, 503, { error: "settings-unavailable" });
        }
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return writeJson(res, 400, { error: "bad-json" });
        }
        const channel = typeof body?.channel === "string" ? body.channel : "";
        const model = typeof body?.model === "string" ? body.model : "";
        // ⚠️ 校验顺序是承重的：`all: true`（全选/全不选）**不带 model**，
        // 所以"必须有 model"这条必须放到 all 分支**之后**，
        // 否则全选请求会被 400 挡掉 —— 表现就是按钮像没反应。
        if (channel === "") return writeJson(res, 400, { error: "missing-channel" });
        // 只接受注册表里的 provider —— 免得把任意字符串写进设置。
        const knownChannels = registryChannels();
        if (!knownChannels.some((entry) => entry.provider === channel)) {
          return writeJson(res, 400, { error: "unknown-channel" });
        }
        const next = new Set(deps.prefs().disabledModels);

        // —— 全选 / 全不选：把该渠道的模型一次全设成同一个状态 ——
        if (body.all === true) {
          const target = knownChannels.find((item) => item.provider === channel);
          if (target === undefined) return writeJson(res, 400, { error: "unknown-channel" });
          const row = await probeChannel(target, { base: fanoutBaseOf(req) });
          const ids = Array.isArray(row.models) ? row.models.map((item) => item.id) : [];
          for (const item of [...next]) {
            if (item.startsWith(`${channel}/`)) next.delete(item);
          }
          if (body.disabled === true) for (const id of ids) next.add(`${channel}/${id}`);
          try {
            await settingsApi.update(HUB_SETTINGS_NS, { disabledModels: [...next].sort() });
          } catch (error) {
            return writeJson(res, 500, { error: briefMessage(error) });
          }
          try {
            deps.onModelsChanged?.();
          } catch {
            /* 通知失败不影响写入结果 */
          }
          return writeJson(res, 200, { disabledModels: deps.prefs().disabledModels, changed: ids.length });
        }

        if (model === "") return writeJson(res, 400, { error: "missing-model" });
        const entry = `${channel}/${model}`;
        if (body.disabled === true) next.add(entry);
        else next.delete(entry);
        try {
          await settingsApi.update(HUB_SETTINGS_NS, { disabledModels: [...next].sort() });
        } catch (error) {
          return writeJson(res, 500, { error: briefMessage(error) });
        }
        // 让宿主重新问各 provider 要模型列表（否则模型选择器还是旧的）。
        try {
          deps.onModelsChanged?.();
        } catch {
          /* 通知失败不影响写入结果 */
        }
        writeJson(res, 200, { disabledModels: deps.prefs().disabledModels });
      },
    ],
    [
      HUB_AUTH_ROUTE,
      async (req, res) => {
        if (!loopbackRequest(req)) return writeJson(res, 403, { error: "request-not-trusted" });
        const targets = authTargets();

        if (req.method === "GET") {
          const rows = await probeAll(registryChannels(), { base: fanoutBaseOf(req) });
          const byProvider = new Map(rows.map((row) => [row.provider, row]));
          writeJson(res, 200, {
            channels: registryChannels().map((channel) => {
              const target = targets[channel.id] ?? {};
              const row = byProvider.get(channel.provider);
              /**
               * 落点提示跟**实际存在的那个**候选文件走。
               *
               * Qoder 是"会话优先、PAT 兜底"，写入目标固定是 `qoder.pat`；但如果已经用
               * `qoder-vault.mjs` 装了 App 会话，凭据其实在 `qoder-session.json` ——
               * 只显示写入目标会让人按一个根本不存在的文件名去找。这里只改**显示**，
               * 写入目标仍是 `target.path`（粘 PAT 就该落在 .pat 上）。
               */
              const present = candidatePaths(channel.id).find((candidate) => existsSync(candidate));
              return {
                id: channel.id,
                provider: channel.provider,
                displayName: channel.displayName,
                kind: channel.kind,
                state: row === undefined ? "unavailable" : row.state,
                account: row === undefined ? undefined : row.account,
                // Trae 用同一份凭据文件接两个产品，认证页也必须看得出当前是哪个。
                product: row === undefined ? undefined : row.product,
                productLabel: row === undefined ? undefined : row.productLabel,
                source: target.source,
                targetPath: present ?? (typeof target.path === "string" ? target.path : null),
                hint: target.hint,
                writable: typeof target.path === "string" && target.path !== "",
                /** 是否已有凭据 —— 认证页据此区分「已配置」与「空闲槽位（可添加）」。 */
                configured: slotConfigured(channel.id),
                disabled: deps.prefs().disabledChannels.includes(channel.id),
              };
            }),
            /** 下一个空闲 workbuddy 槽位号，添加表单预填用。 */
            nextWorkbuddySlot: nextWorkbuddySlot(),
            // 导出脚本只跑在宿主上（要读桌面 App / 钥匙串），容器里给不出，只能提示。
            exportHint: "宿主上执行：node scripts/export-connect-credentials.mjs（Trae 两个产品可选：export-trae-plain.mjs --app cn|solo）",
          });
          return;
        }

        if (req.method !== "POST") return writeJson(res, 405, { error: "method not allowed" });

        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return writeJson(res, 400, { error: "bad-json" });
        }
        /**
         * 渠道管理动作：`create` / `update` / `disable` / `enable` / `delete`，
         * 与凭据写入共用本端点。
         *
         * ⚠️ **协议字段叫 `op` 而不是 `action`。** 实测（2026-09-25）`action` 是 DSH 的
         * **保留字段名**：请求体里只要带 `action`，整个请求就被 DSH 的中间件截走，
         * 回一个**空的 400**，永远到不了插件（同一条路由、同一份 handler，把字段换成
         * `op`/`kind`/`cmd`/`type` 都正常）。这类"字段名撞保留字"没有任何报错提示，
         * 只能靠对照实验发现。
         *
         * ⚠️ **不要再拆成独立路由。** 实测新增的一条路由在 DSH 里注册不生效：
         * 源码里在、用 mock ctx 调 `registerHubRoutes` 也在（能列出 7 条），
         * 但真实请求一律落到兜底 —— POST 回空的 400、GET 回 405；
         * 换路径名（`/channels` → `/channel-admin`）、换注册顺序都一样。
         * 合并进 `/auth` 既绕开它，语义上也更顺：`/auth` 本来就是"渠道凭据管理"。
         *
         * 禁用为什么是"把该渠道的模型全写进 disabledModels"：provider 的隐藏钩子
         * （`setExternalHidden`）只认**模型 id 列表**，它不知道"渠道"这个概念。
         * 复用已有的"全不选"能力即可立刻生效，不必改三个 provider。
         * `disabledChannels` 照样记着，用于面板显示"已禁用"，以及下次打开面板时纠偏。
         *
         * create / update 是**注册表**操作（`connect-channels.json`）：
         *   - create：新增一个 workbuddy 槽位（唯一允许 multi 的 kind）。
         *     注册表写入后面板立即可见、可粘贴凭据；provider 侧的路由与
         *     provider 注册要**重启 DSH** 才跟上 —— 响应里带 `restartRequired: true`，
         *     前端据此提示。凭据粘贴本身不依赖重启（store 轮询文件）。
         *   - update：改 displayName。面板即时生效；provider 的模型组名
         *     （adapter 注册时传入）下次启动跟上。
         *   - delete：删注册表条目 + 凭据文件 + 该渠道的禁用痕迹。
         */
        const manageAction = typeof body?.op === "string" ? body.op : "";
        if (manageAction !== "") {
          /**
           * ⚠️ `settingsApi` **必须在这里自己取一次**。
           *
           * 它不是模块级变量，而是各路由 handler 内 `const settingsApi = deps.settingsApi()` 的
           * 局部变量（`/settings` 与 `/models` 各取各的）。早先这里直接引用了它 ——
           * 每次请求都是 `ReferenceError: settingsApi is not defined`，被 DSH 兜住后回一个
           * **空的 400**。现象极具误导性：源码里路由明明注册了、mock 调用也正常，
           * 却像是"路由不存在"。
           */
          const settingsApi = deps.settingsApi();
          if (settingsApi === undefined) return writeJson(res, 503, { error: "settings-unavailable" });

          // —— create：注册表追加一个新渠道槽位 ——
          if (manageAction === "create") {
            const kind = typeof body?.kind === "string" ? body.kind.trim() : "";
            const id = typeof body?.id === "string" ? body.id.trim() : "";
            const displayName = typeof body?.displayName === "string" ? body.displayName.trim() : "";
            if (!Object.hasOwn(CHANNEL_KINDS, kind)) {
              return writeJson(res, 400, { error: "unknown-kind", message: `kind 只能是 ${Object.keys(CHANNEL_KINDS).join(" / ")}` });
            }
            if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) {
              return writeJson(res, 400, { error: "bad-id", message: "id 须为小写字母开头，仅含小写字母/数字/连字符，≤32 位" });
            }
            if (kind !== "workbuddy" && id !== kind) {
              // trae / qoder 是单例：id 必须等于 kind（provider 路由是写死的）。
              return writeJson(res, 400, { error: "singleton-id", message: `${kind} 是单例渠道，id 必须是 "${kind}"` });
            }
            const registry = readRegistry();
            if (registry.channels.some((entry) => entry.id === id)) {
              return writeJson(res, 409, { error: "duplicate-id", message: `渠道 id "${id}" 已存在` });
            }
            if (kind === "workbuddy" && !/^workbuddy[1-9]\d*$/.test(id)) {
              // 变体路由 /plugins/dsh-workbuddy-connect/<N>/… 按 id 里的数字推导，
              // 不带数字或 0 开头的 workbuddy id 会拿到幽灵路由（与注册表读取侧
              // channel-registry.js normalizeEntry 的校验保持一致）。
              return writeJson(res, 400, { error: "bad-workbuddy-id", message: "workbuddy 渠道的 id 须形如 workbuddy<N>（N≥1），如 workbuddy4" });
            }
            // 新 id 尚未进入 authTargets，直接检查默认路径与环境覆盖路径。
            const credentialPaths = kind === "qoder"
              ? [join(authDir(), "qoder-session.json"), join(authDir(), "qoder.pat")]
              : [join(authDir(), `${id}.json`)];
            if (kind === "workbuddy") {
              const override = process.env[`WORKBUDDY${id.slice(9)}_AUTH_FILE`]?.trim();
              if (override) credentialPaths.push(override);
              credentialPaths.push(join(resolveDshHome(), `.${id}-auth.json`));
            }
            if (credentialPaths.some((path) => existsSync(path))) {
              return writeJson(res, 409, {
                error: "stray-credential",
                message: `connect-auth/ 下已有 ${id} 的残留凭据文件；先删除它（或换一个 id），避免新槽位静默继承旧凭据`,
              });
            }
            const entry = { id, kind, displayName: displayName === "" ? id : displayName };
            try {
              writeRegistry([...registry.channels, entry]);
            } catch (error) {
              return writeJson(res, 500, { error: briefMessage(error) });
            }
            return writeJson(res, 200, {
              created: channelOf(entry),
              registryPath: registryPath(),
              restartRequired: true,
              note: "槽位已加入注册表；面板立即可粘贴凭据，provider 路由重启 DSH 后生效。",
            });
          }

          // —— update：改 displayName ——
          if (manageAction === "update") {
            const wanted = typeof body?.channel === "string" ? body.channel : "";
            const displayName = typeof body?.displayName === "string" ? body.displayName.trim() : "";
            const registry = readRegistry();
            const entry = registry.channels.find((item) => item.id === wanted);
            if (entry === undefined) return writeJson(res, 400, { error: "unknown-channel" });
            if (displayName === "") return writeJson(res, 400, { error: "empty-display-name" });
            const next = registry.channels.map((item) => (item.id === wanted ? { ...item, displayName } : item));
            try {
              writeRegistry(next);
            } catch (error) {
              return writeJson(res, 500, { error: briefMessage(error) });
            }
            return writeJson(res, 200, {
              updated: channelOf({ ...entry, displayName }),
              registryPath: registryPath(),
              note: "已改名；面板即时生效，模型选择器里的渠道组名下次启动跟上。",
            });
          }

          const wanted = typeof body?.channel === "string" ? body.channel : "";
          const managed = readRegistry()
            .channels.map((entry) => channelOf(entry))
            .find((item) => item?.id === wanted);
          if (managed === undefined) return writeJson(res, 400, { error: "unknown-channel" });
          const prefs = deps.prefs();
          const models = new Set(prefs.disabledModels);
          const dropProviderModels = () => {
            for (const item of [...models]) {
              if (item.startsWith(`${managed.provider}/`)) models.delete(item);
            }
          };
          const commit = async (disabledChannels) => {
            try {
              await settingsApi.update(HUB_SETTINGS_NS, { disabledModels: [...models].sort(), disabledChannels });
            } catch (error) {
              writeJson(res, 500, { error: briefMessage(error) });
              return false;
            }
            // 让宿主重新问各 provider 要模型列表，否则模型选择器还是旧的。
            try {
              deps.onModelsChanged?.();
            } catch {
              /* 通知失败不影响写入结果 */
            }
            return true;
          };
          const snapshot = () => ({
            disabledChannels: deps.prefs().disabledChannels,
            disabledModels: deps.prefs().disabledModels,
          });

          if (manageAction === "delete") {
            // 删除 = 凭据文件 + 注册表条目一起删（两步确认在客户端做过了）。
            const removedPaths = [];
            for (const path of candidatePaths(managed.id)) {
              if (!existsSync(path)) continue;
              try {
                unlinkSync(path);
                removedPaths.push(path);
              } catch (error) {
                return writeJson(res, 500, { error: briefMessage(error), path });
              }
            }
            // 注册表条目删除（即使没有凭据文件也删 —— 「删一个空槽位」是合法操作）。
            const registry = readRegistry();
            const nextChannels = registry.channels.filter((entry) => entry.id !== managed.id);
            try {
              writeRegistry(nextChannels);
            } catch (error) {
              return writeJson(res, 500, { error: briefMessage(error) });
            }
            dropProviderModels();
            if (!(await commit(prefs.disabledChannels.filter((id) => id !== managed.id)))) return;
            return writeJson(res, 200, {
              removed: removedPaths,
              registryPath: registryPath(),
              restartRequired: true,
              ...snapshot(),
            });
          }

          if (manageAction === "disable") {
            // 先探一次拿模型 id —— 禁用必须落到具体模型上才真正生效。
            const row = await probeChannel(managed, { base: fanoutBaseOf(req) });
            const ids = Array.isArray(row.models) ? row.models.map((item) => item.id) : [];
            dropProviderModels();
            for (const id of ids) models.add(`${managed.provider}/${id}`);
            if (!(await commit([...new Set([...prefs.disabledChannels, managed.id])]))) return;
            return writeJson(res, 200, { hidModels: ids.length, ...snapshot() });
          }

          if (manageAction === "enable") {
            dropProviderModels();
            if (!(await commit(prefs.disabledChannels.filter((id) => id !== managed.id)))) return;
            return writeJson(res, 200, snapshot());
          }

          return writeJson(res, 400, { error: "unknown-action" });
        }

        const channel = typeof body?.channel === "string" ? body.channel : "";
        const secret = typeof body?.secret === "string" ? body.secret : "";
        const target = targets[channel];
        if (target === undefined) return writeJson(res, 400, { error: "unknown-channel" });
        if (typeof target.path !== "string" || target.path === "") {
          return writeJson(res, 409, {
            error: "no-target-path",
            message: "该渠道的凭据落点不可知（对应的环境变量没设），请改 compose 或用导出脚本",
          });
        }
        if (secret.trim() === "") return writeJson(res, 400, { error: "empty-secret" });

        // —— 按渠道校验形状：宁可在写入前拒绝，也别写一个"静默未登录"的文件 ——
        let content = secret;
        if (target.kind === "workbuddy" || target.kind === "trae") {
          let parsed;
          try {
            parsed = JSON.parse(secret);
          } catch {
            return writeJson(res, 400, { error: "bad-json", message: "该渠道要粘贴 JSON（导出脚本产出的那一份）" });
          }
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            return writeJson(res, 400, { error: "bad-json", message: "顶层应是 JSON 对象" });
          }
          if (target.kind === "workbuddy") {
            // 插件的 parseWorkBuddyAuth 只认 auth.accessToken 非空，否则静默判"未登录"。
            const token = parsed?.auth?.accessToken ?? parsed?.accessToken;
            if (typeof token !== "string" || token === "") {
              return writeJson(res, 400, {
                error: "no-access-token",
                message: "快照里找不到非空的 auth.accessToken，插件会判为未登录",
              });
            }
          }
          content = JSON.stringify(parsed, null, 2) + "\n";
        } else {
          if (!secret.trim().startsWith("pt-")) {
            return writeJson(res, 400, { error: "not-a-pat", message: "Qoder 的凭据应是 pt- 开头的官方 PAT" });
          }
          content = secret.trim() + "\n";
        }

        try {
          mkdirSync(dirname(target.path), { recursive: true });
          // 原子写：tmp + rename。半截 JSON 会被凭据轮询当成「文件损坏 → 未登录」，
          // 一次失败的写入不该把一个原本健康的凭据变成这样。
          const tmp = `${target.path}.tmp`;
          writeFileSync(tmp, content, { mode: 0o600 });
          renameSync(tmp, target.path);
          try {
            chmodSync(target.path, 0o600);
          } catch {
            /* 已存在的文件可能改不动权限，不致命 */
          }
        } catch (error) {
          return writeJson(res, 500, { error: briefMessage(error) });
        }

        writeJson(res, 200, {
          ok: true,
          targetPath: target.path,
          note: "已写入（0600）。插件按 30 秒轮询凭据，最多半分钟生效。",
        });
      },
    ],
  ];

  /**
   * 单渠道签到：`/checkin/<id>`。
   *
   * 原实现为**启动瞬间**的 `deps.channels()`（= 那一刻已有凭据的槽位）逐条注册
   * exact 路由。于是「先建槽位 → 重启 → 再扫码」这个标准流程里，新槽位在启动时
   * 还没有凭据、拿不到自己的 checkin 路由 —— 等它扫码登录成功，面板那一行的
   * 「签到」按钮就一直 405，而「一键签到」走的是每次现算的 claimAll，所以
   * 表现为"总签到说领了、单点没反应"。
   *
   * 这里改成**一条 prefix 路由 + 运行时查注册表**：webServer 只支持
   * `exact`/`prefix` 两种（没有 `:id` 参数路由），所以用 prefix 吃掉整段前缀、
   * 在 handler 里解析 id。路由表因此与注册表解耦：槽位在任何时刻出现都能签，
   * 既不用为它重启，也不需要启动时就知道有哪些 id。未配置的槽位点下去会如实回
   * `signed-out`（与 status 路由一致），不再有幽灵 405。
   */
  routes.push([
    {
      kind: "prefix",
      path: HUB_CHECKIN_ROUTE,
    },
    async (req, res) => {
      if (!loopbackRequest(req)) return writeJson(res, 403, { error: "request-not-trusted" });
      if (req.method !== "POST" && req.method !== "GET") return writeJson(res, 405, { error: "method not allowed" });
      let id = "";
      try {
        id = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname.slice(`${HUB_CHECKIN_ROUTE}/`.length));
      } catch {
        id = "";
      }
      const channel = id === "" ? undefined : registryChannels().find((entry) => entry.id === id);
      if (channel === undefined) return writeJson(res, 404, { error: "unknown-channel", id });
      writeJson(res, 200, await claimOne(channel, { base: fanoutBaseOf(req) }));
    },
  ]);

  for (const [route, handler] of routes) {
    // 路由既可以写成 `${path}`（默认 exact），也可以写成 `{kind, path}`。
    const spec = typeof route === "string" ? { kind: "exact", path: route } : route;
    ctx.effect(() => {
      const dispose = ctx.webServer.register({ kind: spec.kind, path: spec.path, handler });
      return () => {
        dispose();
      };
    }, `dsh-connect: ${spec.path}`);
  }
}

/** 请求体读取：只用于 POST /settings，加个长度上限免得被灌。 */
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** 隐藏渠道：**只影响展示与汇总**（角标数字要和列表一致），不影响扇出与签到 ——
 * 把某个渠道从面板里藏起来，不该让人少领那天的积分。 */
function hideAll(rows, hidden) {
  if (!Array.isArray(hidden) || hidden.length === 0) return rows;
  return rows.filter((row) => !hidden.includes(row.id));
}

/** 并发签掉一条渠道；**永不抛**，失败也变成一条结果。 */
export async function claimOne(channel, options = {}) {
  const base = options.base ?? loopbackBaseFallback();
  try {
    const payload = await fetchRoute(channel.checkinPath, { method: "POST", timeoutMs: 25000, base });
    return normalizeClaim(channel, payload);
  } catch (error) {
    return normalizeClaim(channel, undefined, error);
  }
}

/** 并发签掉所有渠道（部分失败不影响其他）。 */
export async function claimAll(channels = hubChannels(), options = {}) {
  const base = options.base ?? loopbackBaseFallback();
  return Promise.all(channels.map((channel) => claimOne(channel, { base })));
}

/** 签到汇总：给"一键签到"的按钮文案用。 */
export function summarizeClaims(results) {
  const summary = { total: results.length, claimed: 0, done: 0, manual: 0, unsupported: 0, failed: 0, unavailable: 0 };
  for (const row of results) {
    if (row.state === "claimed") summary.claimed += 1;
    else if (row.state === "done") summary.done += 1;
    else if (row.state === "manual") summary.manual += 1;
    else if (row.state === "unsupported") summary.unsupported += 1;
    else if (row.state === "unavailable" || row.state === "signed-out") summary.unavailable += 1;
    else summary.failed += 1;
  }
  return summary;
}

//#endregion

//#region 面板入口

/**
 * 把面板挂到宿主 ctx 上（由 lib/index.js 的编排调用，**不再自己是一个 cordis 插件**）。
 *
 * 无硬依赖：webServer / settings 都用可选注入，缺哪个就少一半能力。
 */
export function registerPanel(ctx, config) {
  let stopped = false;
  let settingsApi;

  /**
   * 面板偏好的「活值」读源。
   *
   * ## 为什么主路径读**自己的配置引用**，而不是 `settings.describe()`
   *
   * `dsh-connect` 在 profile 里的条目现在就带 `config`（= HUB_SECTION），
   * 解析后**标了 `.volatile()` 的字段是引用对象**：`.get()` 现读现值，
   * 宿主写配置时用 `updateVolatile()` **原地更新**它 —— 这正是 volatile 的用途。
   *
   * 反例（实测踩过）：改成每次去 `settings.describe()` 里找自己那一行，会踩两个坑 ——
   *   1. `update()` 会写 profile 的 patch 文档，而 profile 是 `patchReload: live`，
   *      于是一次写入就让本插件条目**热重载**；重载窗口里 `entry.fiber.state !== 2`，
   *      `describe()` 会把该条目**整个跳过** → 读到 `undefined` → 若此时退回内置默认值，
   *      表现就是「刚禁用的模型/渠道又全部放开」（写入后十几秒内 `/models` 全空，
   *      之后自行恢复）。自己的引用不受这个窗口影响。
   *   2. `describe()` 要重建全部 21 个条目的 schema，而 `hubChannels()` 每个请求都调 ——
   *      实测 2 分钟被调 231 次，纯浪费。
   *
   * 兜底：万一 `apply()` 拿到的 config 不是解析结果（缺省值没补上），仍去 settings
   * 服务要权威值。只在「自己一个字段都没有」时才走这条。
   */
  const ownConfig = () => {
    try {
      return unwrapConfig(config) ?? {};
    } catch {
      return {};
    }
  };

  const source = () => {
    const own = ownConfig();
    if (own !== null && typeof own === "object" && Object.keys(own).length > 0) return own;
    return readHubSection(settingsApi) ?? HUB_DEFAULTS;
  };

  const prefs = () => resolvePrefs(source());

  // provider 侧（`disabledModelsFor` / `hubChannels`）读的就是这个活值。
  // 在**这里**（而不是等 settings 注入）就赋上，这样即使 settings 一直不来、
  // 或插件正在热重载，面板偏好也照样是活的。
  livePrefs = () => resolvePrefs(source());

  const deps = {
    prefs,
    /**
     * 用于签到与单渠道路由注册：**已配置**的槽位（空槽位不参与），
     * 但**包含被隐藏的渠道** —— 隐藏只是"面板里不显示"。
     * `/status` 自己会用 `hideAll` 再滤一次，所以两处口径不冲突。
     */
    channels: () => hubChannels({ includeHidden: true }),
    settingsApi: () => settingsApi,
    /** 由编排层注入：模型禁用列表变化后，通知宿主刷新各 provider 的模型列表。 */
    onModelsChanged: typeof config?.onModelsChanged === "function" ? config.onModelsChanged : undefined,
  };

  ctx.inject(["webServer"], (webCtx) => {
    if (stopped) return;
    try {
      registerHubRoutes(webCtx, deps);
      ctx.logger?.info?.(`dsh-connect: 面板已挂 ${HUB_CHANNELS.length + 4} 条路由（注册表渠道 ${registryChannels().length} 条）`);
    } catch (error) {
      ctx.logger?.warn?.("dsh-connect: 面板路由注册失败（面板不可用，各渠道不受影响）", error);
    }
  });

  ctx.inject(["settings"], (settingsCtx) => {
    if (stopped) return;
    // 0.1.7-rc.2：`installSection` / `section` 已从 settings 服务移除。
    // 新模型下"本插件的偏好"就是 `Config`（= HUB_SECTION，字段带 volatile）本身，
    // 所以不再"安装一个设置段" —— 这里只需要**写**入通道：
    //   写 → update(ns, patch)（签名与旧版一致，调用点不用动）
    //   读 → 主路径是 ownConfig()，见上面的说明。
    const svc = settingsCtx.settings;
    if (typeof svc?.update !== "function") {
      ctx.logger?.warn?.("dsh-connect: 宿主 settings 无 update，偏好项不可改（面板其余功能正常）");
      return;
    }
    settingsApi = svc;
  });

  ctx.effect(() => () => {
    stopped = true;
  });
}

//#endregion
