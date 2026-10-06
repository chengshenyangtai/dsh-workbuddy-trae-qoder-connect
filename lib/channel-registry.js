/**
 * 渠道注册表 —— dsh-connect 的**唯一渠道事实源**。
 *
 * 「任意添加、删改渠道」的边界，先说清楚再动手：
 *
 * 1. **面板/聚合侧是全动态的**：本模块把渠道清单从 panel.js 的硬编码数组
 *    改成 `$DSH_HOME/connect-channels.json` 驱动。面板每读一次注册表就重新
 *    渲染，加一条、改个名、删一条，面板与汇总立刻跟着变（无需重启）。
 *
 * 2. **provider 侧是重启装载的**：workbuddy 的 provider 变体表
 *    （variants-CnrmSn0Q.js 的 WORKBUDDY_VARIANTS）在模块加载时从注册表
 *    生成 —— 变体决定 provider 注册、回环路由、状态文件名，这些都挂在
 *    cordis 的 apply 生命周期上，进程内动态增删要改三个 provider 的运行时
 *    结构，风险远大于收益（README 里对「不动渠道」的论证仍然成立）。
 *    所以注册表改动会在**下次启动**时改变 provider 拓扑；面板侧则即时可见。
 *
 * 3. **kind 是有限集合**：workbuddy / trae / qoder。新增一种「渠道类型」
 *    （另一种厂商、另一种协议）需要先写 provider 驱动，那是代码工作，
 *    不是注册表能表达的事。注册表管的是「同类渠道的实例增删」。
 *
 * 设计取舍：为什么不用 settings 段存渠道清单 —— settings.yaml 是明文全局
 * 配置，往里写渠道元数据容易和 `hiddenChannels` / `disabledChannels` 这类
 * 面板偏好纠缠（前者是「有哪些渠道」，后者是「怎么展示」）。一个独立的
 * 注册表文件把两件事分开，备份/迁移时也和 connect-auth/ 一起搬。
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 小模块自行解析 DSH_HOME，避免注册表基础层反向依赖宿主包。 */
function resolveDshHome() {
  const configured = process.env.DSH_HOME?.trim();
  return configured === undefined || configured === "" ? join(homedir(), ".dsh") : configured;
}

//#region 常量

/** 注册表文件名（落在 `$DSH_HOME/` 下，随 ~/.dsh 一起挂载与迁移）。 */
export const REGISTRY_FILENAME = "connect-channels.json";

/** 注册表文档版本；读不出这个版本的整份丢弃，回落内置默认。 */
const REGISTRY_VERSION = 1;

/**
 * 渠道 kind 元数据：归一化映射与实例上限。
 *
 * - workbuddy：多实例（一个变体 = 一个账号，各自独立的凭据/状态文件）。
 * - trae / qoder：单实例 —— 两个 provider 的路由与状态文件都是单例写死的，
 *   注册表允许第二条只会得到一个永远 unavailable 的行。
 */
export const CHANNEL_KINDS = {
  workbuddy: { multi: true },
  trae: { multi: false },
  qoder: { multi: false },
};

/**
 * 内置默认注册表 —— 注册表文件不存在时的兜底。
 *
 * 与现状逐字对齐（workbuddy 1/2/3 + trae + qoder）：已有部署不受影响；
 * 「删除」一个渠道时会写出**显式的**注册表文件（哪怕删得一个不剩），
 * 所以默认表只在「从未管理过」时生效。
 */
export const DEFAULT_REGISTRY_CHANNELS = [
  { id: "workbuddy1", kind: "workbuddy", displayName: "WorkBuddy 账号 1" },
  { id: "workbuddy2", kind: "workbuddy", displayName: "WorkBuddy 账号 2" },
  { id: "workbuddy3", kind: "workbuddy", displayName: "WorkBuddy 企业版" },
  { id: "trae", kind: "trae", displayName: "Trae" },
  { id: "qoder", kind: "qoder", displayName: "Qoder CN" },
];

//#endregion

//#region 读取与校验

/** 注册表文件路径。 */
export function registryPath() {
  return join(resolveDshHome(), REGISTRY_FILENAME);
}

/** 渠道 id 的合法形状：小写字母开头，后接小写字母/数字/连字符，≤32 位。 */
const ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * 把一条原始注册表条目收敛成规范形状；形状不对返回 undefined（调用方丢弃）。
 *
 * 读取侧即做完整校验（kind 白名单、workbuddy 编号形状、单例 id === kind）：
 * 注册表文件可能被手写或跨版本拷贝，这里过滤掉的结构性坏条目不需要任何
 * 调用方再兜底；面板 create op（panel.js 的 /auth POST）另有面向用户的
 * 400 报错文案，两边校验规则保持同步。
 */
function normalizeEntry(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const kind = typeof value.kind === "string" ? value.kind.trim() : "";
  const displayName = typeof value.displayName === "string" ? value.displayName.trim() : "";
  if (!ID_PATTERN.test(id)) return undefined;
  if (!Object.hasOwn(CHANNEL_KINDS, kind)) return undefined;
  if (kind === "workbuddy" && !/^workbuddy[1-9]\d*$/.test(id)) return undefined;
  if (kind !== "workbuddy" && id !== kind) return undefined;
  return {
    id,
    kind,
    displayName: displayName === "" ? id : displayName,
  };
}

/**
 * 读注册表（同步，模块加载与每次面板请求都会走）。
 *
 * 任何解析失败都回落内置默认 —— 注册表是「增强」，不是「依赖」：
 * 文件损坏不该让整个面板 500。文件不存在与文件为空数组**含义不同**：
 * 前者是「从未管理过」（用默认表），后者是「用户删光了」（尊重它，
 * 一个渠道都不注册 —— 但 trae/qoder 单例也删掉是用户自己的选择）。
 *
 * @returns {{ channels: Array<{id,kind,displayName}>, explicit: boolean }}
 *   explicit = 文件存在且可解析（面板据此知道当前清单是用户管理过的）。
 */
function defaultChannelsWithOrphans() {
  const dir = join(resolveDshHome(), "connect-auth");
  const base = DEFAULT_REGISTRY_CHANNELS.map((entry) => ({ ...entry }));
  const known = new Set(base.map((entry) => entry.id));
  // 兼容旧版固定 workbuddy4/5/6 槽位：只有凭据真实存在时才自动收纳，避免空槽位噪音。
  let orphans;
  try {
    orphans = readdirSync(dir);
  } catch {
    return base; // 目录不存在 = 从未有孤儿凭据
  }
  for (const filename of orphans) {
    const match = /^workbuddy(\d+)\.json$/.exec(filename);
    if (match === null) continue;
    const id = `workbuddy${match[1]}`;
    if (known.has(id)) continue;
    base.push({ id, kind: "workbuddy", displayName: `WorkBuddy 账号 ${match[1]}` });
    known.add(id);
  }
  // 排序稳定化：workbuddy 按编号升序在前，trae/qoder 保持默认表相对顺序。
  base.sort((a, b) => {
    const na = /^workbuddy(\d+)$/.exec(a.id)?.[1];
    const nb = /^workbuddy(\d+)$/.exec(b.id)?.[1];
    if (na !== undefined && nb !== undefined) return Number(na) - Number(nb);
    if (na !== undefined) return -1;
    if (nb !== undefined) return 1;
    return 0;
  });
  return base;
}

export function readRegistry() {
  const path = registryPath();
  if (!existsSync(path)) return { channels: defaultChannelsWithOrphans(), explicit: false };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { channels: defaultChannelsWithOrphans(), explicit: false };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { channels: defaultChannelsWithOrphans(), explicit: false };
  }
  if (parsed.version !== REGISTRY_VERSION || !Array.isArray(parsed.channels)) {
    return { channels: defaultChannelsWithOrphans(), explicit: false };
  }
  const raw = parsed.channels;
  const seen = new Set();
  const channels = [];
  for (const value of raw) {
    const entry = normalizeEntry(value);
    if (entry === undefined) continue; // 坏条目丢弃，不连坐整份文件
    if (seen.has(entry.id)) continue; // 重复 id 保留首个
    seen.add(entry.id);
    channels.push(entry);
  }
  return { channels, explicit: true };
}

//#endregion

//#region 写入

/**
 * 原子写注册表：同目录 tmp + rename。
 *
 * 与 panel.js 写凭据同一套纪律：读到一半的 JSON 会被当成「文件损坏 →
 * 回落默认表」，那等于静默丢掉用户全部渠道管理，必须用原子替换杜绝。
 *
 * version 检查（读侧）：不认识的版本整份回落默认 —— 旧代码遇到未来 v2
 * 形状的文档时宁可丢配置也不猜结构，避免半兼容解析静默错绑渠道。
 */
export function writeRegistry(channels) {
  const path = registryPath();
  const document = { version: REGISTRY_VERSION, channels };
  const tmp = join(dirname(path), `.${REGISTRY_FILENAME}.tmp`);
  mkdirSync(dirname(path), { recursive: true });
  // 残留的 tmp 可能带着旧权限（0o600 只在创建时生效），写完显式收紧再改名。
  writeFileSync(tmp, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

//#endregion

//#region 派生

/**
 * 注册表条目 → 面板渠道行（panel.js 的 HUB_CHANNELS 形状）。
 *
 * 路由路径按 kind 推导：workbuddy 的每实例路由是
 * `/plugins/dsh-workbuddy-connect/<N>/…`，N 取 id 里的数字；trae / qoder
 * 是固定单例路径。凭据落点统一在 connect-auth/ 下按 id 命名 —— 这让
 * 「注册表 id」与「凭据文件名」永远一致，删渠道时删哪个文件不用猜。
 */
export function channelOf(entry) {
  if (entry.kind === "workbuddy") {
    const n = /^workbuddy(\d+)$/.exec(entry.id)?.[1] ?? "0";
    return {
      id: entry.id,
      displayName: entry.displayName,
      provider: entry.id,
      kind: "workbuddy",
      statusPath: `/plugins/dsh-workbuddy-connect/${n}/status`,
      checkinPath: `/plugins/dsh-workbuddy-connect/${n}/checkin`,
      credentialHint: `connect-auth/${entry.id}.json`,
    };
  }
  if (entry.kind === "trae") {
    return {
      id: "trae",
      displayName: entry.displayName,
      provider: "trae",
      kind: "trae",
      statusPath: "/plugins/dsh-trae-connect/status",
      checkinPath: "/plugins/dsh-trae-connect/checkin",
      credentialHint: "connect-auth/trae.json",
    };
  }
  if (entry.kind === "qoder") {
    return {
      id: "qoder",
      displayName: entry.displayName,
      provider: "qoder1",
      kind: "qoder",
      statusPath: "/plugins/dsh-qoder-connect/status",
      checkinPath: "/plugins/dsh-qoder-connect/checkin",
      credentialHint: "connect-auth/qoder.pat",
    };
  }
  return undefined;
}

/**
 * 全部渠道（含未配置凭据的空闲槽位）—— 面板认证页与 `/auth` GET 用。
 *
 * 每次调用都重读注册表：注册表是热事实，面板刷新就能看到别的入口
 * （或未来的 CLI）写进来的改动，不依赖进程重启。
 */
export function allChannels() {
  return readRegistry().channels.map((entry) => channelOf(entry)).filter((channel) => channel !== undefined);
}

/**
 * 当前注册表里的下一个空闲 workbuddy 槽位号。
 *
 * 添加渠道 UI 用它预填 id（`workbuddy7`），用户可改 —— 但改动要过
 * `^[a-z][a-z0-9-]{0,31}$` 且不与现有 id 冲突。数字连续性不做强制：
 * 删了 7 号再添加，会拿到 8 号而不是复用 7（凭据文件名是按 id 命名的，
 * 复用已删槽位的 id 容易把旧文件的残留当成新渠道的凭据）。
 */
export function nextWorkbuddySlot() {
  const used = new Set(readRegistry().channels.filter((entry) => entry.kind === "workbuddy").map((entry) => entry.id));
  for (let n = 1; n <= 999; n += 1) {
    if (!used.has(`workbuddy${n}`)) return n;
  }
  return undefined;
}

//#endregion
