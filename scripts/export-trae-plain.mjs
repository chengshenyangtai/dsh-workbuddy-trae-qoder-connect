#!/usr/bin/env node
/**
 * export-trae-plain.mjs —— 把 Trae 桌面端的登录态与模型目录导出为 dsh-connect 可读的明文快照。
 *
 * **两个产品都支持**（`--app` 选择，默认自动挑）：
 *
 *   cn    Trae CN —— IDE 版（`product.json: packageType=TRAE_CN`，win32NameVersion=TraeCode CN）
 *                 模型更多更全：比 SOLO 多 glm-5.3-flash / glm-5.3-flashx / kimi-k2.8-preview /
 *                 qwen3.8-flash 等，且 solo_agent 分组里 11 个模型档位三档齐全、上下文可扩到 1M。
 *   solo  TRAE SOLO CN —— 办公向 harness（旧称 TraeWork CN，`packageType=SOLO_CN`）。
 *                 本脚本的历史唯一目标，行为逐字保留。
 *
 * 为什么需要它：
 *   Trae 的凭据在宿主机的
 *     Windows : %APPDATA%\<产品目录>\User\globalStorage\storage.json
 *     macOS   : ~/Library/Application Support/<产品目录>/User/globalStorage/storage.json
 *   里以 byteCrypto 信封（`dGMF` 前缀）存储，解密逻辑是**纯 JS**（见 trae-vault.mjs），
 *   但 DSH 跑在容器里根本看不到这个路径。因此由宿主侧解密，写明文快照到
 *     ~/.dsh/trae-cn/{credential.json,models.json}   ← cn 产品（本次切换后的默认）
 *     ~/.dsh/trae/{credential.json,models.json}      ← solo 产品（历史路径，逐字不变）
 *     ~/.dsh/connect-auth/trae.json                  ← 插件真正读的凭据（两种产品都镜像一份）
 *   （`~/.dsh` 已 bind mount 成 `/root/.dsh`）；插件只读这几份快照，绝不碰桌面 App 的目录。
 *
 * 与 WorkBuddy 的差异：
 *   WorkBuddy 的信封密钥握在 App 自己的 Electron 原生绑定里，必须宿主解密；
 *   Trae 同样是宿主解密，但算法完全自包含 —— 所以这里直接复用 trae-vault.mjs 的 unseal()。
 *
 * 用法：
 *   node scripts/export-trae-plain.mjs                  # 自动选产品（有 Trae CN 就用 CN）
 *   node scripts/export-trae-plain.mjs --app solo       # 指定导 SOLO
 *   node scripts/export-trae-plain.mjs --app cn         # 指定导 Trae CN
 *   node scripts/export-trae-plain.mjs --list           # 只列两个产品各人的登录态，不写文件
 *   node scripts/export-trae-plain.mjs --check          # 体检当前要导的那份，不写文件
 *   node scripts/export-trae-plain.mjs --out DIR        # 自定义输出目录（此时不再镜像到 connect-auth）
 *
 * 只读宿主源文件；除 --out 指定的那两份快照（以及默认位置下连带的 connect-auth 镜像）外
 * 不做任何写入。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { unseal } from './trae-vault.mjs';

/**
 * 两个 Trae 产品的常量表 —— 与插件侧 `providers/trae/index.js` 的 `TRAE_PRODUCTS`
 * 一一对应，**两边都要改的时候记得同步**（这份是宿主导出用的事实源，那份是容器消费用的）。
 *
 * 每一项都不是凭猜测填的：
 *   - `dir`            注册表/开始菜单里两个产品各自的数据根目录（实测本机并存）。
 *   - `packageType`    各自 `product.json` 的字面值 —— 它决定签到 `req_source`。
 *   - `buildId`        各自 `product.json` 的 `buildId`，也是倍率接口 `X-Ide-Version-Code`
 *                      的**筛选键**：用错值不报错，只回一份没有 function_configs 的空壳。
 *   - `reqSource`      App 侧 `out/main.js` 的 `eb()` 发 `{req_source: a}`，
 *                      `a = Pr(product) ? 2 : 1`，`Pr` 判定 `packageType ∈ {SOLO_*}`。
 *                      CN 实测 1/2 都放行（见 2026-10-07 探测），但仍按 App 自己的取值填 1。
 *   - `catalogGroups`  从 `model_list_map` 收模型时只认这几个分组：
 *                      CN 的 `code_reviewer` / `refactor` 里装着 `refactor_scoper`、
 *                      `code-review-judge` 这类**内部流水线小模型**，它们能推理但不该
 *                      出现在 DSH 的模型选择器里；`chat_v3`/`builder_v3` 与 `solo_agent`
 *                      同宽（各 18/10 个 preset），并集只多不减，所以三个都收。
 */
const APPS = {
  cn: {
    id: 'cn',
    label: 'Trae CN（IDE）',
    dir: 'Trae CN',
    packageType: 'TRAE_CN',
    reqSource: 1,
    buildId: 1232067209986,
    appVersion: '3.3.104',
    /** 推理网关与账号网关都从 product.json 现读，这里只放兜底值。 */
    gateway: 'https://trae-api-cn.mchost.guru',
    accountBase: 'https://api.trae.cn',
    /** SOLO 的 function 名在 CN 上同样可用（同 appId），所以默认槽位用 CN 自己的。 */
    defaultFunction: 'solo_agent',
    catalogGroups: ['solo_agent', 'chat_v3', 'builder_v3'],
    /** 快照落盘子目录（$DSH_HOME 下）。 */
    outSubdir: 'trae-cn',
  },
  solo: {
    id: 'solo',
    label: 'TRAE SOLO CN（TraeWork）',
    dir: 'TRAE SOLO CN',
    packageType: 'SOLO_CN',
    reqSource: 2,
    buildId: 1227681842690,
    appVersion: '0.1.66',
    gateway: 'https://trae-api-cn.mchost.guru',
    accountBase: 'https://api.trae.cn',
    defaultFunction: 'solo_agent_lite',
    catalogGroups: [
      'solo_agent_lite', 'solo_agent_remote', 'solo_coder', 'solo_work_lite', 'solo_work_remote',
      'solo_design_lite', 'solo_design_remote',
    ],
    outSubdir: 'trae',
  },
};

/**
 * ai-agent 侧固定的 App 身份（product.json 的 bootConfig.appId，非账号级）。
 * 实测两个产品的 bootConfig.agent/ckg/cue/hub.appId 都是这一串，所以留一个常量，
 * 但导出时会**优先用 product.json 里读到的值**，这里只是读不到时的兜底。
 */
const FALLBACK_APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8';

/**
 * 服务端注册过的 function（倍率查询用；CN/SOLO 各一张）。
 *
 * ⚠️ 别为了「覆盖率」往里堆名字：实测上游对 `functions` 长度的延迟是非线性的
 * （见下面 RATE_CHUNK 的注释），而且倍率对同一模型跨 function 取值一致 ——
 * 多查只是多花一次往返，不会多出一个模型的价。所以这张表 = 该产品的可推理
 * function + 两个「只在注册表里出现」的名字，与插件侧
 * `TRAE_PRODUCTS[*].functions + rateExtraFunctions` 保持一致。
 */
const FUNCTIONS_BY_APP = {
  cn: [
    'solo_agent', 'chat_v3', 'builder_v3', 'solo_agent_lite', 'solo_work_lite',
    'solo_agent_remote', 'solo_work_remote', 'multimodal', 'refactor', 'assistant', 'builder',
  ],
  solo: [
    'solo_work_lite', 'solo_agent_lite', 'solo_coder', 'solo_work_remote', 'solo_agent_remote',
    'solo_design_lite', 'solo_design_remote', 'multimodal', 'refactor', 'assistant', 'builder',
  ],
};

function log(...a) { process.stdout.write(a.join(' ') + '\n'); }

// ── 宿主目录与源文件 ────────────────────────────────────────────────────────
/**
 * 产品数据根目录（按平台）。
 *
 * Windows 在 `%APPDATA%`（= Roaming），macOS 在 `~/Library/Application Support/`。
 * 两边的**内部结构完全一致**（`User/globalStorage/{storage.json,state.vscdb}`），
 * 凭据格式与信封算法也一致 —— Windows 版同样把登录态写成
 * `iCubeAuthInfo://icube.cloudide` 的 byteCrypto 信封，而 `unseal()` 是纯 JS、
 * 不依赖钥匙串，所以只需换根，不需要第二份脚本。
 * （2026-10-06 在 Trae SOLO CN Windows 版实测导出成功；2026-10-07 加 Trae CN。）
 */
function appSupportDir(dirName) {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), dirName);
  }
  return path.join(os.homedir(), 'Library', 'Application Support', dirName);
}

/** 该产品的宿主安装是否存在（装了才有得导）。 */
function installed(app) {
  return fs.existsSync(path.join(appSupportDir(app.dir), 'User', 'globalStorage', 'storage.json'));
}

/**
 * 从该产品的安装目录现读 product.json。
 *
 * 为什么不让用户填、也不完全信任上面那张表：`buildId` 每次 App 升级都会变，
 * 而它是倍率接口的**筛选键** —— 写死一个旧值不报错，只会让整列倍率静默消失。
 * 找不到时（例如装在非默认位置且注册表没有 InstallLocation）退回表里的值，
 * 并在日志里点名这一点。
 *
 * ⚠️ 必须按 `packageType` **核对**再采纳：实测有人的 Trae CN 装在
 * `<盘符>\TRAE SOLO CN\Trae CN` 这种嵌套位置（安装器把 IDE 放进了 SOLO 的目录里），
 * 只按路径猜会把 SOLO 的 product.json 当成 CN 的，buildId 立刻张冠李戴。
 * 代码里那几条 `D:\` 候选就是为了覆盖这种「非系统盘安装」，不是特定机器专属。
 */
function readProductJson(app) {
  /**
   * `add(root)` 把一个**安装根目录**转成候选文件：
   *   - Windows：`<root>\resources\app\product.json`（Electron 应用的固定布局）
   *   - 也接受 root 已经是 `<...>\Contents`（macOS 的 .app 内部）或产品目录嵌一层的形态。
   */
  const candidates = [];
  const add = (root) => {
    if (typeof root !== 'string' || root.trim() === '') return;
    candidates.push(path.join(root, 'resources', 'app', 'product.json'));
    candidates.push(path.join(root, app.dir, 'resources', 'app', 'product.json'));
  };
  // 1) 注册表卸载信息（Windows 最可靠：装在哪由安装器说了算）
  for (const loc of registryInstallLocations()) add(loc);
  // 2) 常规安装位置
  add(path.join(process.env.LOCALAPPDATA ?? '', 'Programs', app.dir));
  add(path.join(process.env['ProgramFiles'] ?? '', app.dir));
  add(path.join('C:\\Program Files', app.dir));
  add('D:\\');
  add(path.join('D:\\', app.dir));
  // 3) macOS：.app/Contents 下就是 resources/app/product.json
  add(path.join(os.homedir(), 'Applications', `${app.dir}.app`, 'Contents'));
  add(path.join('/Applications', `${app.dir}.app`, 'Contents'));

  for (const c of candidates) {
    let doc;
    try { doc = JSON.parse(fs.readFileSync(c, 'utf8')); } catch { continue; }
    if (!doc || typeof doc !== 'object') continue;
    if (typeof doc.packageType === 'string' && doc.packageType !== app.packageType) continue;
    const agent = doc.bootConfig?.agent ?? {};
    return {
      file: c,
      appId: typeof agent.appId === 'string' ? agent.appId : undefined,
      gateway: typeof agent.trae?.normal === 'string' ? agent.trae.normal : undefined,
      accountBase: typeof doc.bootConfig?.account?.trae?.normal === 'string' ? doc.bootConfig.account.trae.normal : undefined,
      appVersionCode: Number.isFinite(Number(doc.buildId)) ? Number(doc.buildId) : undefined,
      appVersion: typeof doc.appVersion === 'string' ? doc.appVersion : undefined,
      packageType: typeof doc.packageType === 'string' ? doc.packageType : undefined,
      nameLong: typeof doc.nameLong === 'string' ? doc.nameLong : undefined,
    };
  }
  return undefined;
}

/**
 * Windows 注册表里的卸载项 → InstallLocation。
 *
 * 用 PowerShell 现查而不是硬编码路径：Trae 的安装位置由安装器决定（见过 IDE 被
 * 装进 SOLO 目录子层的），任何写死的猜测都会踩空。
 * 一次 spawnSync 拿 JSON，失败就当没有（退回常量表）。
 */
function registryInstallLocations() {
  if (process.platform !== 'win32') return [];
  const ps = String.raw`
$keys = @('HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')
Get-ItemProperty $keys -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -match 'Trae' -and $_.InstallLocation } |
  ForEach-Object { $_.InstallLocation } | Sort-Object -Unique | ConvertTo-Json -Compress
`;
  const r = spawnSync('pwsh', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 20000 });
  if (r.status !== 0 || !r.stdout?.trim()) return [];
  try {
    const parsed = JSON.parse(r.stdout.trim());
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.filter((x) => typeof x === 'string' && x.trim() !== '');
  } catch { return []; }
}

// ── 凭据 ────────────────────────────────────────────────────────────────────
/**
 * 设备号。
 *
 * 它就**藏在 storage.json 的键名里**：`iCubeAuthInfo://icube-dc:<deviceId>`，
 * 值与 `state.vscdb` 里 `getCommonApiParams().did` 一致（形如 16 位数字）。
 *
 * 为什么必须带出来：Trae 的**写接口**（签到 claim 等）会校验 `x-device-id`，
 * 缺失时回 `9004 The submitted order parameters are incorrect`；而只读接口不校验。
 * 这个"只读能过、写入被拒"的差异非常容易被误判成鉴权或参数结构问题。
 */
function readDeviceId(vault) {
  for (const key of Object.keys(vault)) {
    const match = /^iCubeAuthInfo:\/\/icube-dc:(.+)$/.exec(key);
    if (match) return match[1];
  }
  return undefined;
}

function readCredential(app) {
  const storage = path.join(appSupportDir(app.dir), 'User', 'globalStorage', 'storage.json');
  if (!fs.existsSync(storage)) throw new Error(`找不到 storage.json: ${storage}（${app.label} 未安装或从未登录过）`);
  const vault = JSON.parse(fs.readFileSync(storage, 'utf8'));
  const entry = vault['iCubeAuthInfo://icube.cloudide'];
  if (typeof entry !== 'string') throw new Error(`${storage} 里没有 iCubeAuthInfo://icube.cloudide 条目`);
  let session;
  try {
    const plain = unseal(entry);
    if (plain === null) throw new Error('unseal 返回 null（校验位不通过）');
    session = JSON.parse(plain);
  } catch (e) {
    throw new Error(`信封解密失败（byteCrypto 常量表可能已随版本变化）：${e.message}`);
  }
  if (typeof session.token !== 'string' || session.token.length === 0) throw new Error('解密结果里没有 token');
  session.deviceId = readDeviceId(vault);
  return session;
}

/** 解析 JWT 的 payload（不验签，只读 exp）。 */
function jwtPayload(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch { return undefined; }
}

// ── 模型目录 ────────────────────────────────────────────────────────────────
/**
 * 从 state.vscdb 读 model_list_map。
 *
 * 该文件是普通 SQLite（非 SQLCipher），但 Node 读页头 + 扫描不可靠 —— 这里
 * 改用 python 的 sqlite3；不可用时退化为「无目录」，插件仍能靠内置兜底模型工作。
 *
 * ⚠️ 键的分隔符**两个产品不一样**（实测）：
 *   TRAE SOLO CN → `<uid>:AI.agent.model.model_list_map`
 *   Trae CN      → `<uid>_AI.agent.model.model_list_map`
 * 所以这里用 LIKE 匹配 `<uid>%…`，而不是拼死一个冒号 —— 否则 CN 侧永远查不到行，
 * 表现是「导出成功但 models.json 空着」，插件静默退回 7 个兜底模型。
 */
function readModelGroups(app, uid) {
  const vscdb = path.join(appSupportDir(app.dir), 'User', 'globalStorage', 'state.vscdb');
  if (!fs.existsSync(vscdb)) { log(`  ⚠ 找不到 state.vscdb: ${vscdb}`); return undefined; }
  /**
   * ⚠️ 必须自己写 UTF-8 字节，不能靠 print。
   *
   * 教训（2026-10-07 切 CN 时踩到）：Windows 上 python 的 `sys.stdout` 默认按**控制台
   * 代码页**（本机 cp936/GBK）编码，而 Node 这边用 `encoding: 'utf8'` 解 ——
   * 于是 `display_name` 里的中文全成 mojibake：`DeepSeek-V4-Flash 正式版` 变成
   * `DeepSeek-V4-Flash ʽ`，而且**一路写进 models.json、显示进 DSH 的模型选择器**。
   * `PYTHONIOENCODING=utf-8` 有时被宿主策略覆盖，所以直接把字节写到 fd 1 最稳。
   */
  const py = String.raw`
import sqlite3, json, sys, urllib.parse, os
con = sqlite3.connect("file:%s?mode=ro" % urllib.parse.quote(sys.argv[1]), uri=True)
like = sys.argv[2] + "%AI.agent.model.model_list_map"
row = con.execute("SELECT value FROM ItemTable WHERE key LIKE ?", (like,)).fetchone()
sys.stdout.buffer.write((row[0] if row else "").encode("utf-8"))
`;
  // Python 可执行名按平台：macOS/Linux 通常是 python3，Windows 上通常只有 python。
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const r = spawnSync(python, ['-c', py, vscdb, String(uid)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  if (r.status !== 0 || !r.stdout?.trim()) {
    if (r.stderr?.trim()) log('  ⚠ python 报错:', r.stderr.trim().split('\n').pop());
    return undefined;
  }
  try { return JSON.parse(r.stdout); } catch { return undefined; }
}

function readModels(app, uid) {
  const groups = readModelGroups(app, uid);
  if (groups === undefined) return undefined;
  /** 该模型记录在本分组里的 dev 窗口（没有就退回 context_window_size.default / 整条窗口）。 */
  const devOf = (m, def, contextWindow) => {
    const d = m?.context_window_tokens?.dev;
    if (Number.isFinite(d) && d > 0) return d;
    if (Number.isFinite(def) && def > 0) return def;
    return contextWindow;
  };
  const wanted = app.catalogGroups;
  const byName = new Map();
  const fields = new Map();
  let skippedGroups = 0;
  for (const [group, arr] of Object.entries(groups)) {
    if (!Array.isArray(arr)) continue;
    // 只收「能推理、且该在界面上出现」的分组（见 APPS[*].catalogGroups 的注释）。
    if (!wanted.includes(group)) { skippedGroups += 1; continue; }
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
       * 若 contextWindow 只存一个数，跨组覆盖后 1M 就丢了。
       *
       * CN 侧这条更要命：它的**分组名与 SOLO 不同**（solo_agent / chat_v3 / builder_v3），
       * 插件按「当前 function」去 `reasoningByGroup` 里取档位，键名必须与之一致，
       * 否则取不到 → 界面上所有模型都显示「不支持思考档位」。
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
      /**
       * ⚠️ `maxTokens` 要按**当前分组自己的 dev 窗口**封顶，不能照抄 `prompt_max_tokens`。
       *
       * 踩坑实录（2026-10-07 切 CN）：CN 目录里模型的 `prompt_max_tokens` 存的是
       * **Max 模式下**的值（`936000` ≈ 1M × 0.936），而 dev 窗口只有 200000。
       * 插件的 shim 用「请求的 max_tokens 是否超过 dev 窗口」决定要不要带 Max 标记
       * （`providers/trae/index.js` 的 maxMode），照抄的后果是**每一个请求都被判成
       * 开了 Max 模式** —— 而 Max 是按 5× 倍率计费的（实测 glm-5.3 x0.46→x2.3）。
       * 表现为「额度掉得莫名其妙快」，且界面上没有任何地方说它开了 Max。
       *
       * SOLO 侧没暴露这个 bug 纯属巧合：它的 dev 是 200000、pmt 是 168000，
       * 天然 `168000 < 200000`，永远触发不了那条判据。
       *
       * 所以：封顶到 dev 窗口 ⇒ 默认请求不带 Max 标记（要 1M 得显式改 max_tokens，
       * 那时候用户是知道自己要什么的）。这里宁可不给 1M，也不要静默 5× 计费。
       */
      /**
       * `maxTokens` 先按**本分组**的 dev 记一个候选值；真正的封顶在函数末尾那趟
       * 统一处理（跨分组取**最小** dev），理由见上面那段踩坑实录。
       */
      const groupDev = devOf(m, def, contextWindow);
      const rawMax = Number.isFinite(m.prompt_max_tokens) && m.prompt_max_tokens > 0 ? m.prompt_max_tokens : Math.min(16384, contextWindow);
      const entry = {
        id: name,
        name: typeof m.display_name === 'string' && m.display_name ? m.display_name : name,
        contextWindow,
        maxTokens: Math.max(1024, Math.min(rawMax, groupDev)),
        supportsImages: m.multimodal === true,
        groups: [...new Set([...(prev?.groups ?? []), group])],
        reasoningByGroup: effortByGroup,
        contextWindowByGroup: tokensByGroup,
        maxModeByGroup,
        /** 上游原样的 pmt，供人核对「为什么这里比 prompt_max_tokens 小」。 */
        upstreamPromptMaxTokens: Number.isFinite(m.prompt_max_tokens) ? m.prompt_max_tokens : undefined,
        /**
         * 原样保留上游字段：这里只取固定几项，别的一律丢掉 —— 留下 raw 之后，
         * 容器里能直接看出来上游到底给过哪些字段（排查"某个值怎么没有"时很省事）。
         *
         * ⚠️ 倍率**不在这里导出**（它是定价，由插件运行时打 batch_get_detail_param 现取）。
         * 本脚本偶尔会把 rate 写进 models.json，那只是一份**兜底快照**，正常路径不会用到它。
         */
        raw: m,
      };
      byName.set(name, entry);
    }
  }
  log(`  上游原始字段（出现次数）: ${[...fields.entries()].sort((a, b) => b[1] - a[1]).map(([key, n]) => `${key}×${n}`).join(', ')}`);
  if (skippedGroups > 0) {
    log(`  （跳过 ${skippedGroups} 个不用于模型选择器的分组: ${Object.keys(groups).filter((g) => !wanted.includes(g)).join(', ')}）`);
  }
  /**
   * 跨分组统一封顶 `maxTokens`：取该模型**所有分组里最小的 dev 窗口**当上限。
   *
   * 为什么是最小而不是最大：插件 shim 判「要不要带 Max 标记」用的是
   * 「请求的 max_tokens > **当前 function 的** dev 窗口」。同一个模型在
   * `solo_agent` 是 200000、在 `chat_v3` 只有 116000 —— 若按最大封顶，用户在
   * chat_v3 下就会**悄悄**开 Max（5× 计费）。按最小封顶 ⇒ 默认任何分组都不触发；
   * 想要 1M 的人在 DSH 里显式把 max_tokens 调大，那时 Max 才跟着开，符合预期。
   */
  const out = [];
  for (const m of byName.values()) {
    const devs = Object.values(m.contextWindowByGroup ?? {})
      .map((t) => (Number.isFinite(t?.dev) && t.dev > 0 ? t.dev : undefined))
      .filter((n) => n !== undefined);
    const cap = devs.length > 0 ? Math.min(...devs) : m.contextWindow;
    const maxTokens = Math.max(1024, Math.min(m.maxTokens, cap));
    out.push({ ...m, maxTokens, devWindowCap: cap });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 补上「消耗倍率」。
 *
 * 为什么要额外打一次接口：倍率**不在** App 的本地缓存里（`state.vscdb` 的
 * `model_list_map` 里只有一个恒为 2 的 `fee_model_level`，没法区分模型）。
 * 它由服务端在 `batch_get_detail_param` 里下发，藏在
 * `display_contact_config`（一个内嵌的 JSON 字符串）里的
 * `consumption_rate.data.rate`。
 *
 * ⚠️ `X-Ide-Version-Code` 必须是**这个产品自己的** buildId：
 * 拿 SOLO 的 1227681842690 去查 CN 的注册表不报错，只会拿到一份缺模型的文档。
 *
 * ⚠️ **必须分批查**：实测（2026-10-07，同一份凭据）上游延迟对 `functions` 长度是
 * **非线性**的 —— 3 个 2.4 s / 5 个 8.1 s / 9 个 10.2 s，而 **12 个直接 60 s 超时**。
 * 所以这里按 6 个一批切开顺序合并（导出是一次性动作，多花十几秒无所谓；
 * 插件运行时那份有更严的约束，见 providers/trae/index.js 的 RATE_QUERY_CHUNK）。
 * 单批失败只丢那一批的模型，不会让整列倍率消失。
 *
 * 拿不到就跳过 —— 倍率是装饰性信息，不该让整个导出失败。
 */
const RATE_CHUNK = 6;

async function fetchRateBatch(app, session, functions) {
  const endpoint = `${app.gateway}/api/ide/v1/batch_get_detail_param`;
  const body = {
    functions,
    agent_type: '',
    current_config_info: { config_name: '', is_custom_model: false },
    mode_type: 0,
    access_type: 1,
    ab_force_vids: '',
    ab_autotest_advanced_mode: 0,
    show_custom_model: true,
  };
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: '*/*',
      'X-Ide-Token': session.token,
      'User-Agent': 'TraeClient/TTNet',
      'X-App-Id': app.appId ?? FALLBACK_APP_ID,
      'X-App-Version': 'default',
      'X-App-Version-Code': String(app.appVersionCode ?? app.buildId),
      'X-Ide-Version': app.appVersion ?? 'default',
      'X-Ide-Version-Code': String(app.appVersionCode ?? app.buildId),
      'X-Ide-Version-Type': 'stable',
      'X-Device-Id': session.deviceId ?? '',
      'X-Device-Type': process.platform === 'win32' ? 'windows' : 'mac',
      'Package-Type': 'stable_cn',
      'Request-Traffic-Type': 'prod',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 120)}`);
  const doc = JSON.parse(text);
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
  return rates;
}

async function enrichRates(app, session, list) {
  const all = FUNCTIONS_BY_APP[app.id] ?? FUNCTIONS_BY_APP.solo;
  const rates = new Map();
  let batches = 0;
  let failed = 0;
  for (let i = 0; i < all.length; i += RATE_CHUNK) {
    const chunk = all.slice(i, i + RATE_CHUNK);
    batches += 1;
    try {
      for (const [name, value] of await fetchRateBatch(app, session, chunk)) {
        if (!rates.has(name)) rates.set(name, value);
      }
    } catch (e) {
      failed += 1;
      log(`  ⚠ 倍率第 ${batches} 批（${chunk.join(',')}）失败: ${e?.message ?? e} —— 只丢这批的模型`);
    }
  }
  if (rates.size === 0) {
    log(`  ⚠ ${batches} 批都没解析到 consumption_rate —— 跳过（models.json 里不会有 rate，插件运行时会自己再取）`);
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
  log(`  倍率: ${hit}/${list.length} 个模型命中（${batches} 批${failed > 0 ? `，${failed} 批失败` : ''}；上游给了 ${rates.size} 条）`);
  return out;
}

// ── main ───────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const appIdx = args.indexOf('--app');
const appKeyRaw = appIdx !== -1 ? String(args[appIdx + 1] ?? '').trim().toLowerCase() : '';
if (appKeyRaw !== '' && appKeyRaw !== 'cn' && appKeyRaw !== 'solo') {
  log(`用法错误：--app 只接受 cn / solo（收到 "${args[appIdx + 1]}"）`);
  process.exit(2);
}
const outIdx = args.indexOf('--out');
const checkOnly = args.includes('--check');
const listOnly = args.includes('--list');

/**
 * 选产品：显式 `--app` > 自动（装了 Trae CN 就用 CN，否则退回 SOLO）。
 *
 * 自动顺序把 CN 放前面是这次的需求本身：用户要的就是「接 IDE 版、别再走 SOLO」。
 * 两个都没装则直接报错退出，不写任何文件。
 */
function pickApp() {
  if (appKeyRaw === 'cn' || appKeyRaw === 'solo') return APPS[appKeyRaw];
  if (installed(APPS.cn)) return APPS.cn;
  if (installed(APPS.solo)) return APPS.solo;
  return undefined;
}

if (listOnly) {
  log('本机 Trae 产品:');
  for (const app of Object.values(APPS)) {
    const storage = path.join(appSupportDir(app.dir), 'User', 'globalStorage', 'storage.json');
    if (!fs.existsSync(storage)) { log(`  ${app.id.padEnd(5)} ${app.label.padEnd(26)} 未安装（${storage}）`); continue; }
    try {
      const s = readCredential(app);
      const payload = jwtPayload(s.token);
      const expIso = s.expiredAt ?? (payload?.exp ? new Date(payload.exp * 1000).toISOString() : '');
      const expired = payload?.exp ? payload.exp * 1000 < Date.now() : false;
      log(`  ${app.id.padEnd(5)} ${app.label.padEnd(26)} user=${s.userId} token到期=${expIso}${expired ? '（已过期）' : ''} deviceId=${s.deviceId || '⚠无'}`);
    } catch (e) {
      log(`  ${app.id.padEnd(5)} ${app.label.padEnd(26)} ✗ ${e.message}`);
    }
  }
  const picked = pickApp();
  log(`\n--app 省略时的默认选择: ${picked ? picked.id + '（' + picked.label + '）' : '无（两个产品都没装）'}`);
  process.exit(0);
}

const app = pickApp();
if (app === undefined) {
  log('两个 Trae 产品都没装（Trae CN / TRAE SOLO CN），无法导出。');
  process.exit(2);
}

// 拷贝一份，避免改动常量表本体；后面把 product.json 现读的值覆盖进来。
const target = {
  ...app,
  appId: app.appId ?? FALLBACK_APP_ID,
  appVersionCode: app.buildId,
};
const pj = readProductJson(app);
if (pj === undefined) {
  log(`⚠ 没找到 ${app.label} 的 product.json，产品身份退回内置常量（buildId=${app.buildId}）`);
  log('   若 App 已升级到别的 buildId，倍率整列会静默空白 —— 用 --out 指到安装目录同级或修正安装位置后重跑。');
} else {
  target.appId = pj.appId ?? target.appId;
  target.gateway = pj.gateway ?? target.gateway;
  target.accountBase = pj.accountBase ?? target.accountBase;
  target.appVersionCode = pj.appVersionCode ?? target.appVersionCode;
  target.appVersion = pj.appVersion ?? target.appVersion;
  log(`  product.json : ${pj.file}`);
  log(`  packageType  : ${pj.packageType ?? '?'}  nameLong=${pj.nameLong ?? '?'}  appId=${target.appId}  buildId=${target.appVersionCode}  appVersion=${target.appVersion}`);
}

const defaultOutDir = path.join(os.homedir(), '.dsh', target.outSubdir);
const outDir = outIdx !== -1 && args[outIdx + 1] ? path.resolve(args[outIdx + 1]) : defaultOutDir;

log('Trae 凭据快照导出');
log('  产品         :', `${target.id} —— ${target.label}`);
log('  storage.json :', path.join(appSupportDir(target.dir), 'User', 'globalStorage', 'storage.json'));
log('  state.vscdb  :', path.join(appSupportDir(target.dir), 'User', 'globalStorage', 'state.vscdb'));
log('  输出目录     :', outDir);
log('');

const session = readCredential(target);
const payload = jwtPayload(session.token);
const nowSec = Math.floor(Date.now() / 1000);

const credential = {
  formatVersion: 2,
  /**
   * **产品线标识** —— 插件侧 `providers/trae/index.js` 的 `resolveProduct()` 靠它
   * 决定 function 白名单、默认槽位、models.json 目录、倍率查询集与签到 `req_source`。
   * 老快照没有这个字段，插件一律按 SOLO 处理（与历史行为逐字相同）。
   */
  product: target.id,
  packageType: target.packageType,
  reqSource: target.reqSource,
  exportedAt: new Date().toISOString(),
  gateway: target.gateway,
  appId: target.appId,
  appVersionCode: target.appVersionCode,
  appVersion: target.appVersion,
  functions: FUNCTIONS_BY_APP[target.id] ?? FUNCTIONS_BY_APP.solo,
  catalogGroups: target.catalogGroups,
  defaultFunction: target.defaultFunction,
  token: session.token,
  refreshToken: session.refreshToken ?? '',
  expiredAt: session.expiredAt ?? (payload?.exp ? new Date(payload.exp * 1000).toISOString() : ''),
  refreshExpiredAt: session.refreshExpiredAt ?? '',
  userId: session.userId ?? String(payload?.data?.id ?? ''),
  host: session.host ?? target.accountBase,
  deviceId: session.deviceId ?? '',
  account: session.account ?? {},
};

log('凭据:');
log('  product      :', credential.product, `(${target.label}, req_source=${credential.reqSource})`);
log('  userId       :', credential.userId);
log('  账号         :', credential.account?.username ?? '(未知)');
log('  设备号       :', credential.deviceId || '⚠️ 未取到（签到会被上游拒为 9004）');
log('  token 过期   :', credential.expiredAt, `(${payload?.exp ? `${Math.round((payload.exp - nowSec) / 86400)} 天）` : ''}`);
log('  refresh 过期 :', credential.refreshExpiredAt);
if (payload?.exp && payload.exp < nowSec) log('  ⚠️ token 已过期 —— 请在该产品的桌面端重新登录一次再导出');
if (!credential.deviceId) log('  ⚠️ storage.json 里没有 iCubeAuthInfo://icube-dc:<deviceId> 键，签到功能会失败');

const models = readModels(target, credential.userId);

const modelsWithRates = models === undefined ? undefined : await enrichRates(target, session, models);
if (models === undefined) {
  log('\n⚠️ 未能读取模型目录（state.vscdb 读取失败或该账号没有 model_list_map）—— 插件将使用内置兜底模型表。');
} else {
  log(`\n模型目录: ${models.length} 个 preset 模型（分组 ${target.catalogGroups.join(' / ')}）`);
  for (const m of models) {
    const fns = Object.keys(m.reasoningByGroup ?? {}).filter((g) => m.reasoningByGroup?.[g]?.support_thinking === true);
    log(`  ${m.id.padEnd(28)} ${String(m.name).padEnd(22)} ctx=${m.contextWindow} img=${m.supportsImages} 档位组=${fns.join(',') || '-'}`);
  }
}

if (checkOnly) { log('\n--check 模式：未写入任何文件。'); process.exit(0); }

fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
const credPath = path.join(outDir, 'credential.json');
fs.writeFileSync(credPath, JSON.stringify(credential, null, 1), { mode: 0o600 });
log('\n已写入 (0600):', credPath);

const modelsPath = path.join(outDir, 'models.json');
fs.writeFileSync(modelsPath, JSON.stringify({
  formatVersion: 2,
  product: target.id,
  exportedAt: new Date().toISOString(),
  functions: FUNCTIONS_BY_APP[target.id] ?? FUNCTIONS_BY_APP.solo,
  defaultFunction: target.defaultFunction,
  models: modelsWithRates ?? [],
}, null, 1), { mode: 0o600 });
log('已写入 (0600):', modelsPath);

/**
 * 双写插件真正读取的默认凭据路径 —— 修 2026-10-07 那次「Trae 渠道显示未登录」的根因。
 *
 * dsh-connect 的 trae provider 默认凭据文件是 `$DSH_HOME/connect-auth/trae.json`
 * （providers/trae/index.js `defaultCredentialPath()`），而本脚本历史上只写
 * `$DSH_HOME/trae/credential.json` 这个**旧位置**。两边 schema 一致，但导出只落旧路径
 * → 新路径留着上一天的过期快照 → 插件按 JWT 的 exp 判过期，报「未登录 / token 已过期」。
 *
 * 所以：outDir 就是这个产品的默认输出目录时，额外镜像一份到 connect-auth/；
 * 若用户用 --out 指定了别处，则尊重 --out，不再多写。
 *
 * ⚠️ connect-auth/trae.json 是**两个产品共用**的一个文件 —— 这正是「切换」的机关：
 * 最后一次导出者赢。插件靠文件里的 `product` 字段跟着换整套接线，所以不会
 * 出现「CN 的 token 配 SOLO 的 function」。想看当前生效的是哪个，读这个文件的 `product`，
 * 或看 `$DSH_HOME/.trae-connect-state.json` 的 `product` / `productLabel`。
 */
const pluginCredentialPath = path.join(os.homedir(), '.dsh', 'connect-auth', 'trae.json');
if (path.resolve(outDir) === path.resolve(defaultOutDir)) {
  fs.mkdirSync(path.dirname(pluginCredentialPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(pluginCredentialPath, JSON.stringify(credential, null, 1), { mode: 0o600 });
  log('已写入 (0600):', pluginCredentialPath, '  ← dsh-connect 插件默认读取路径（当前产品：' + credential.product + '）');
} else {
  log('\n（--out 指向别处，未镜像到', pluginCredentialPath, '；要让插件用这份快照，把 credentialFile 配置项指到', credPath, '）');
}

log('');
log('生效说明:');
log('  插件按 30 秒一轮巡检重读凭据与目录，**不用重启 DSH**。');
log(`  模型目录: ~/.dsh/${target.outSubdir}/models.json（产品 ${target.id}）`);
log('  容器内路径: /root/.dsh/ 下同构；当前产品切换状态可在 ~/.dsh/.trae-connect-state.json 里核对。');
