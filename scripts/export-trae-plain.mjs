#!/usr/bin/env node
/**
 * export-trae-plain.mjs —— 把 Trae SOLO CN 的登录态与模型目录导出为容器可读的明文快照。
 *
 * 为什么需要它：
 *   Trae 的凭据在宿主 macOS 的
 *     ~/Library/Application Support/TRAE SOLO CN/User/globalStorage/storage.json
 *   里以 byteCrypto 信封（`dGMF` 前缀）存储，解密逻辑是**纯 JS**（见 trae-vault.mjs），
 *   但容器根本看不到这个路径。因此由宿主侧解密，写一份明文到
 *     ~/.dsh/trae/credential.json     ← ~/.dsh 已 bind mount 到容器 /root/.dsh
 *     ~/.dsh/trae/models.json
 *   插件（容器内）只读这两份快照，不碰桌面 App 的目录。
 *
 * 与 WorkBuddy 的差异：
 *   WorkBuddy 的信封密钥握在 App 自己的 Electron 原生绑定里，必须宿主解密；
 *   Trae 同样是宿主解密，但算法完全自包含 —— 所以这里直接复用 trae-vault.mjs 的 unseal()。
 *
 * 用法：
 *   node scripts/export-trae-plain.mjs              # 导出到 ~/.dsh/trae/
 *   node scripts/export-trae-plain.mjs --out DIR    # 自定义输出目录
 *   node scripts/export-trae-plain.mjs --check      # 只体检，不写文件
 *
 * 只读宿主源文件；除 --out 指定的两个快照外不做任何写入。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { unseal } from './trae-vault.mjs';

/**
 * Trae 桌面端的数据根目录（按平台）。
 *
 * macOS 在 `~/Library/Application Support/`，Windows 在 `%APPDATA%`（= Roaming）。
 * 两边的**内部结构完全一致**（`User/globalStorage/{storage.json,state.vscdb}`），
 * 凭据格式与信封算法也一致 —— Windows 版同样把登录态写成
 * `iCubeAuthInfo://icube.cloudide` 的 byteCrypto 信封，而 `unseal()` 是纯 JS、
 * 不依赖钥匙串，所以只需换根，不需要第二份脚本。
 * （2026-10-06 在 Trae SOLO CN Windows 版实测导出成功。）
 */
function appSupportDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'TRAE SOLO CN');
  }
  return path.join(os.homedir(), 'Library/Application Support/TRAE SOLO CN');
}

const APP_SUPPORT = appSupportDir();
const STORAGE_JSON = path.join(APP_SUPPORT, 'User/globalStorage/storage.json');
const STATE_VSCDB = path.join(APP_SUPPORT, 'User/globalStorage/state.vscdb');

/** ai-agent 侧固定的 App 身份（来自 product.json 的 bootConfig，非账号级）。 */
const APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8';
const APP_VERSION_CODE = 1227681842690;
const APP_VERSION = '0.1.66';
/** 推理网关。bootConfig.agent/hub/remote 都指向它。 */
const GATEWAY = 'https://trae-api-cn.mchost.guru';

/**
 * 服务端为本 App 注册过的 function 名（`no function config found` 之外的即为有效）。
 * 实测 2026-09-24 全量扫描所得；拿到有效 function 后每个 preset 模型都可用。
 */
const FUNCTIONS = [
  'solo_work_lite', 'solo_agent_lite', 'solo_coder', 'solo_work_remote',
  'solo_agent_remote', 'solo_design_lite', 'solo_design_remote', 'multimodal', 'refactor',
];

function log(...a) { process.stdout.write(a.join(' ') + '\n'); }

// ── 1. 凭据 ────────────────────────────────────────────────────────────────
/**
 * 设备号。
 *
 * 它就**藏在 storage.json 的键名里**：`iCubeAuthInfo://icube-dc:<deviceId>`，
 * 值与 `state.vscdb` 里 `getCommonApiParams().did` 一致（形如 16 位数字）。
 *
 * 为什么必须带出来：Trae 的**写接口**（签到 claim、以及日后可能加的其它领取类接口）
 * 会校验 `x-device-id`，缺失时回 `9004 The submitted order parameters are incorrect`；
 * 而只读接口（额度、签到状态）不校验。这个"只读能过、写入被拒"的差异非常容易被
 * 误判成鉴权或参数结构问题。
 */
function readDeviceId(vault) {
  for (const key of Object.keys(vault)) {
    const match = /^iCubeAuthInfo:\/\/icube-dc:(.+)$/.exec(key);
    if (match) return match[1];
  }
  return undefined;
}

function readCredential() {
  if (!fs.existsSync(STORAGE_JSON)) throw new Error(`找不到 storage.json: ${STORAGE_JSON}`);
  const vault = JSON.parse(fs.readFileSync(STORAGE_JSON, 'utf8'));
  const entry = vault['iCubeAuthInfo://icube.cloudide'];
  if (typeof entry !== 'string') throw new Error('storage.json 里没有 iCubeAuthInfo://icube.cloudide 条目');
  let session;
  try {
    session = JSON.parse(unseal(entry));
  } catch (e) {
    throw new Error(`信封解密失败（byteCrypto 常量表可能已随版本变化）：${e.message}`);
  }
  if (typeof session.token !== 'string' || session.token.length === 0) throw new Error('解密结果里没有 token');
  session.deviceId = readDeviceId(vault);
  return session;
}

/** 解析 JWT 的 payload（不验签，只读 exp）。 */
function jwtPayload(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch { return undefined; }
}

// ── 2. 模型目录 ────────────────────────────────────────────────────────────
/**
 * 从 state.vscdb 读 model_list_map。
 * 该文件是普通 SQLite（非 SQLCipher），用 Node 读页头 + 简单扫描不可靠 —— 这里
 * 改用 python3 的 sqlite3；不可用时退化为「无目录」，插件仍能靠内置兜底模型工作。
 */
function readModels(uid) {
  const key = `${uid}:AI.agent.model.model_list_map`;
  const py = String.raw`
import sqlite3, json, sys, urllib.parse
con = sqlite3.connect("file:%s?mode=ro" % urllib.parse.quote(sys.argv[1]), uri=True)
row = con.execute("SELECT value FROM ItemTable WHERE key=?", (sys.argv[2],)).fetchone()
print(row[0] if row else "")
`;
  // Python 可执行名按平台：macOS/Linux 通常是 python3，Windows 上通常只有 python。
  // 找不到就当"没有模型目录"降级（插件有内置兜底表），不让整次导出失败。
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const r = spawnSync(python, ['-c', py, STATE_VSCDB, key], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout.trim()) return undefined;
  let groups;
  try { groups = JSON.parse(r.stdout); } catch { return undefined; }

  const byName = new Map();
  // 上游字段清单（出现次数）：模型目录是排查"某个字段有没有"的唯一来源，
  // 导出时顺手统计，缺字段时不用再去翻 state.vscdb。
  const fields = new Map();
  for (const [group, arr] of Object.entries(groups)) {
    if (!Array.isArray(arr)) continue;
    for (const m of arr) {
      if (m?.is_preset !== true) continue;
      const name = m.name;
      if (typeof name !== 'string' || name.length === 0) continue;
      for (const key of Object.keys(m)) fields.set(key, (fields.get(key) ?? 0) + 1);
      const cw = m.context_window_size;
      const max = Array.isArray(cw?.max) ? Math.max(...cw.max.filter((n) => Number.isFinite(n)), 0) : 0;
      const def = Number.isFinite(cw?.default) ? cw.default : 0;
      const contextWindow = Math.max(max, def, 0) || 128000;
      const prev = byName.get(name);
      /**
       * ⚠️ 目录是 **按 (模型 × function) 配对**下发的，不止档位——**上下文窗口也是**。
       *
       * 教训一（档位，2026-10-06）：同一个 `deepseek-v4.1-flash`
       *   solo_agent_lite  → {support_thinking:true,  options:["light","high","extra_high"]}
       *   solo_work_lite   → {support_thinking:false}          ← 无档位
       * 按模型名去重时若只留一份，档位会随机丢失。
       *
       * 教训二（上下文，2026-10-06）：同一个 `deepseek-v4.1-flash`
       *   solo_agent_lite  → {dev:200000, max:1000000}   ← Max 开关扩到 1M
       *   solo_work_lite   → {dev:200000}                ← 根本没有 max
       * 若 contextWindow 只存一个数，跨组覆盖后 1M 就丢了——用户在 Trae 客户端
       * 明明看得到「更大上下文（Max）扩至 1M」，插件里却只剩 200k。
       *
       * 所以两样都按组分别记录，交给插件按当前 function 取对应那份。
       */
      const effortConfig = m.reasoning_effort_config ?? null;
      const effortByGroup = prev?.reasoningByGroup ?? {};
      effortByGroup[group] = effortConfig;
      const tokensByGroup = prev?.contextWindowByGroup ?? {};
      tokensByGroup[group] = m.context_window_tokens ?? { dev: def || undefined };
      const maxModeByGroup = prev?.maxModeByGroup ?? {};
      maxModeByGroup[group] = m.max_mode === true;
      const entry = {
        id: name,
        name: typeof m.display_name === 'string' && m.display_name ? m.display_name : name,
        contextWindow,
        maxTokens: Number.isFinite(m.prompt_max_tokens) && m.prompt_max_tokens > 0 ? Math.min(m.prompt_max_tokens, contextWindow) : Math.min(16384, contextWindow),
        supportsImages: m.multimodal === true,
        groups: [...(prev?.groups ?? []), group],
        // 每个 function 组各自的档位配置；插件按当前 function 取用。
        reasoningByGroup: effortByGroup,
        // 每个 function 组各自的上下文窗口（dev/max）与 Max 模式可用性。
        // `max` 存在即客户端 UI 上的「更大上下文（Max）」档，值就是扩展后的窗口。
        contextWindowByGroup: tokensByGroup,
        maxModeByGroup,
        // 原样保留上游字段：这里只取固定几项，别的一律丢掉 —— 留下 raw 之后，
        // 容器里能直接看出来上游到底给过哪些字段（排查"某个值怎么没有"时很省事）。
        //
        // ⚠️ 倍率**不在这里导出**。它是定价，由插件在运行时打
        // `POST {gateway}/api/ide/v1/batch_get_detail_param` 现取（15 分钟一次），
        // 详见 plugins/dsh-connect/README.md「倍率：三个渠道各自的来源」。
        // 本脚本偶尔会把 rate 写进 models.json（旧版本手工补过一次），
        // 那只是一份**兜底快照**，正常路径不会用到它。
        raw: m,
      };
      byName.set(name, entry);
    }
  }
  log(`  上游原始字段（出现次数）: ${[...fields.entries()].sort((a, b) => b[1] - a[1]).map(([key, n]) => `${key}×${n}`).join(', ')}`);
  return [...byName.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// ── main ───────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const outIdx = args.indexOf('--out');
const outDir = outIdx !== -1 && args[outIdx + 1] ? path.resolve(args[outIdx + 1]) : path.join(os.homedir(), '.dsh', 'trae');

log('Trae SOLO CN 凭据快照导出');
log('  storage.json :', STORAGE_JSON);
log('  state.vscdb  :', STATE_VSCDB);
log('  输出目录     :', outDir);
log('');

const session = readCredential();
const payload = jwtPayload(session.token);
const nowSec = Math.floor(Date.now() / 1000);

const credential = {
  formatVersion: 1,
  exportedAt: new Date().toISOString(),
  gateway: GATEWAY,
  appId: APP_ID,
  appVersionCode: APP_VERSION_CODE,
  appVersion: APP_VERSION,
  functions: FUNCTIONS,
  token: session.token,
  refreshToken: session.refreshToken ?? '',
  expiredAt: session.expiredAt ?? (payload?.exp ? new Date(payload.exp * 1000).toISOString() : ''),
  refreshExpiredAt: session.refreshExpiredAt ?? '',
  userId: session.userId ?? String(payload?.data?.id ?? ''),
  host: session.host ?? 'https://api.trae.cn',
  deviceId: session.deviceId ?? '',
  account: session.account ?? {},
};

log('凭据:');
log('  userId       :', credential.userId);
log('  账号         :', credential.account?.username ?? '(未知)');
log('  设备号       :', credential.deviceId || '⚠️ 未取到（签到会被服务端拒为 9004）');
log('  token 过期   :', credential.expiredAt, `(${payload?.exp ? `${Math.round((payload.exp - nowSec) / 86400)} 天）` : ''}`);
log('  refresh 过期 :', credential.refreshExpiredAt);
if (payload?.exp && payload.exp < nowSec) log('  ⚠️ token 已过期 —— 请在 Trae 里重新登录一次再导出');
if (!credential.deviceId) log('  ⚠️ storage.json 里没有 iCubeAuthInfo://icube-dc:<deviceId> 键，签到功能会失败');

const models = readModels(credential.userId);

/**
 * 补上「消耗倍率」。
 *
 * 为什么要额外打一次接口：倍率**不在** App 的本地缓存里（`state.vscdb` 的
 * `model_list_map` 里只有一个恒为 2 的 `fee_model_level`，没法区分模型）。
 * 它由服务端在 `batch_get_detail_param` 里下发，藏在
 * `display_contact_config`（一个内嵌的 JSON 字符串）里的
 * `consumption_rate.data.rate`。
 *
 * 拿不到就跳过 —— 倍率是装饰性信息，不该让整个导出失败。
 */
async function enrichRates(list) {
  const endpoint = 'https://api5-normal.mchost.guru/api/ide/v1/batch_get_detail_param';
  const body = {
    functions: FUNCTIONS,
    agent_type: '',
    current_config_info: { config_name: '', is_custom_model: false },
    mode_type: 0,
    access_type: 1,
    ab_force_vids: '',
    ab_autotest_advanced_mode: 0,
    show_custom_model: true,
  };
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: '*/*',
        'X-Ide-Token': session.token,
        'User-Agent': 'TraeClient/TTNet',
        'X-App-Id': '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
        'X-App-Version': 'default',
        'X-App-Version-Code': '20260912',
        'X-Ide-Version': '0.1.66',
        'X-Ide-Version-Code': '20260912',
        'X-Ide-Version-Type': 'stable',
        // vault 是 readCredential() 的内部变量，这里用已解析好的 session.deviceId。
        'X-Device-Id': session.deviceId ?? '',
        'X-Device-Type': 'mac',
        'X-Device-Brand': 'Mac17,3',
        'X-Device-Cpu': 'Apple',
        'Package-Type': 'stable_cn',
        'Request-Traffic-Type': 'prod',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    log(`  ⚠ 取倍率失败（网络）: ${e?.message ?? e} —— 跳过，models.json 里不会有 rate`);
    return list;
  }
  if (!res.ok) {
    log(`  ⚠ 取倍率失败: HTTP ${res.status} —— 跳过`);
    return list;
  }
  let doc;
  try {
    doc = await res.json();
  } catch {
    log('  ⚠ 取倍率的响应不是 JSON —— 跳过');
    return list;
  }

  const pick = (o, ...keys) => keys.reduce((cur, k) => (cur && typeof cur === 'object' ? cur[k] : undefined), o);
  const asRate = (x) => {
    if (typeof x === 'number' && Number.isFinite(x)) return x;
    const r = pick(x, 'data', 'rate');
    return typeof r === 'number' && Number.isFinite(r) ? r : undefined;
  };
  const rates = new Map();
  for (const fn of doc?.function_configs ?? []) {
    for (const cfg of fn?.config_info_list ?? []) {
      const name = cfg?.config_name;
      if (typeof name !== 'string') continue;
      let dcc = cfg?.display_contact_config;
      if (typeof dcc === 'string') {
        try { dcc = JSON.parse(dcc); } catch { continue; }
      }
      if (!dcc || typeof dcc !== 'object') continue;
      const r = asRate(dcc.consumption_rate);
      if (r === undefined) continue;
      const prev = rates.get(name);
      if (prev === undefined || r > prev.rate) {
        rates.set(name, {
          rate: r,
          discount: asRate(pick(dcc, 'discount', 'data', 'consumption_rate')),
          activity: asRate(pick(dcc, 'activity_discount', 'data', 'current', 'consumption_rate')),
        });
      }
    }
  }
  if (rates.size === 0) {
    log('  ⚠ 接口里没解析到 consumption_rate —— 跳过');
    return list;
  }
  let hit = 0;
  const out = list.map((m) => {
    const r = rates.get(m.id);
    if (!r) return m;
    hit += 1;
    return {
      ...m,
      rate: r.rate,
      ...r.discount === undefined ? {} : { rateDiscount: r.discount },
      ...r.activity === undefined ? {} : { rateActivity: r.activity },
    };
  });
  log(`  倍率: ${hit}/${list.length} 个模型命中（来源 consumption_rate.data.rate）`);
  return out;
}
const modelsWithRates = models === undefined ? undefined : await enrichRates(models);
if (models === undefined) {
  log('\n⚠️ 未能读取模型目录（state.vscdb 读取失败）—— 插件将使用内置兜底模型表。');
} else {
  log(`\n模型目录: ${models.length} 个 preset 模型`);
  for (const m of models) log(`  ${m.id.padEnd(32)} ${m.name.padEnd(22)} ctx=${m.contextWindow} img=${m.supportsImages}`);
}

if (checkOnly) { log('\n--check 模式：未写入任何文件。'); process.exit(0); }

fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
const credPath = path.join(outDir, 'credential.json');
fs.writeFileSync(credPath, JSON.stringify(credential, null, 1), { mode: 0o600 });
log('\n已写入 (0600):', credPath);

const modelsPath = path.join(outDir, 'models.json');
fs.writeFileSync(modelsPath, JSON.stringify({ formatVersion: 1, exportedAt: new Date().toISOString(), functions: FUNCTIONS, models: modelsWithRates ?? [] }, null, 1), { mode: 0o600 });
log('已写入 (0600):', modelsPath);
log('\n容器内路径: /root/.dsh/trae/credential.json 与 /root/.dsh/trae/models.json');
