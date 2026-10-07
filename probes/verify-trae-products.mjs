/**
 * Trae「产品变体」离线验证（确定性，不依赖 DSH 重启、默认不打上游）
 *
 * 覆盖 2026-10-07 那次「Trae 渠道从 TRAE SOLO CN 切到 Trae CN」的全部承重逻辑：
 *   1. `resolveProduct` / `activeProduct` 的判定优先级（配置 > 快照声明 > 嗅探 > SOLO 兜底）；
 *   2. `TRAE_PRODUCTS` 两张变体表的字段完整性与内部一致性；
 *   3. `decodeModelId` 的 function 白名单**按产品**放行；
 *   4. 账号写接口的 `req_source` 确实由产品决定（CN=1 / SOLO=2）；
 *   5. 模型目录按产品分文件、per-function 的档位与窗口不丢、
 *      `maxTokens` 不越过任一 dev 窗口（越界会**静默开 Max、5× 计费**）。
 *
 * ⚠️ 第 5 组依赖宿主导出的真实快照（`~/.dsh/trae-cn/models.json` 等）。
 * 没装 Trae 的机器上这些断言**自动跳过**并说明原因 —— 本脚本必须能在任何机器上跑绿，
 * 否则它在 CI / 别人手里就是个永久红灯，反而掩盖真问题。
 *
 * 做法（与同目录其它 verify-* 一致）：provider 的 peer 依赖打包在应用 asar 里，
 * 外部 import 会 MODULE_NOT_FOUND，所以把源码拷进临时目录、用极小的桩替换那几个
 * import，**被测函数体一个字节都不改**。
 *
 * 用法：
 *   node probes/verify-trae-products.mjs            # 验证仓库自己的源码
 *   node probes/verify-trae-products.mjs --installed # 验证已安装的那份
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const INSTALLED = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-connect');
const USE_INSTALLED = process.argv.includes('--installed');
const SRC_ROOT = USE_INSTALLED ? INSTALLED : REPO;
const HOME = path.join(os.homedir(), '.dsh');

const SRC = path.join(SRC_ROOT, 'lib', 'providers', 'trae', 'index.js');
if (!fs.existsSync(SRC)) {
  console.error(`找不到 trae provider：${SRC}\n（用 --installed 可以改测已安装的那份）`);
  process.exit(2);
}

// ── 沙箱：peer 依赖打桩，源码本体不动 ──────────────────────────────────────
const SANDBOX = path.join(os.tmpdir(), 'dsh-trae-products-sandbox');
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(SANDBOX, { recursive: true });
// 沙箱根声明 ESM：原包靠 package.json 的 "type":"module"，拷出来必须自己补，
// 否则 .js 被当 CommonJS，import 直接语法错。
fs.writeFileSync(path.join(SANDBOX, 'package.json'), JSON.stringify({ name: 'trae-provider-sandbox', type: 'module', private: true }, null, 1));
// 只拷 trae provider 与 shared/http.js：垫片 `withLegacyImageBudget` 已提到 shared，
// 所以这里不再需要 providers/workbuddy/**（它会把 variants-CnrmSn0Q.js 一并拖进来）。
for (const rel of ['lib/providers/trae/index.js', 'lib/shared/http.js']) {
  const dst = path.join(SANDBOX, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.join(SRC_ROOT, rel), dst);
}

const stubs = {
  // 两个说明符（`.` 与子路径）**都要**带 openAICompletionsApi —— Node 按导出名校验。
  '@earendil-works/pi-ai': 'export function createProvider(o){return o;}\nexport function openAICompletionsApi(){return {id:"stub"};}',
  '@deepseek-ai/dsh-llm-pi-ai': 'export class PiAiAdapter{constructor(o){this.o=o;}}',
  '@deepseek-ai/dsh-llm': 'export function resolveRetryPolicy(_v,label){return {label};}',
  '@deepseek-ai/dsh-home-paths': `import { homedir } from "node:os";
import { join } from "node:path";
export function resolveDshHome(){ const c = process.env.DSH_HOME?.trim(); return c === undefined || c === "" ? join(homedir(), ".dsh") : c; }`,
  // schemastery 走桩：真实那份带传递依赖，桩足够让模块顶层的 Config 跑起来即可。
  '@deepseek-ai/schemastery': `const leaf = { default(){ return leaf; }, description(){ return leaf; }, volatile(){ return leaf; }, array(){ return leaf; }, object(){ return leaf; }, enum(){ return leaf; } };
const z = new Proxy({}, { get: () => () => leaf });
export default z;`,
};
const subpaths = {
  '@earendil-works/pi-ai': { './api/openai-completions.lazy': { file: './lazy.js', body: 'export function openAICompletionsApi(){return {id:"stub"};}' } },
};
for (const [pkg, body] of Object.entries(stubs)) {
  const dir = path.join(SANDBOX, 'node_modules', ...pkg.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  const exports = { '.': './index.js' };
  for (const [sub, { file, body: subBody }] of Object.entries(subpaths[pkg] ?? {})) {
    exports[sub] = file;
    fs.writeFileSync(path.join(dir, file.replace(/^\.\//, '')), `${subBody}\n`);
  }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: pkg, type: 'module', main: 'index.js', exports }, null, 1));
  fs.writeFileSync(path.join(dir, 'index.js'), `${body}\n`);
}

const mod = await import(pathToFileURL(path.join(SANDBOX, 'lib/providers/trae/index.js')).href);
const { resolveProduct, activeProduct, createCatalog, createTraeAccountClient, createTraeClient, decodeModelId, TRAE_PRODUCTS } = mod;

// ── 断言工具 ────────────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
let skipped = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  OK    ${label}${extra ? '   ' + extra : ''}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${extra ? '   ' + extra : ''}`); }
};
/** 依赖宿主导出快照的断言：文件不在就跳过，不算失败。 */
const okIf = (label, cond, ready, extra = '') => {
  if (!ready) { skipped += 1; console.log(`  SKIP  ${label}   （缺快照：${ready === false ? '本机未装/未导出' : ''}）`); return; }
  ok(label, cond, extra);
};
const CN_CRED = path.join(HOME, 'connect-auth', 'trae.json');
const CN_CATALOG = path.join(HOME, 'trae-cn', 'models.json');
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return undefined; } };
const cnCred = readJson(CN_CRED);
const cnCatalog = readJson(CN_CATALOG);
const cnReady = cnCred !== undefined && cnCatalog !== undefined;

console.log(`验证目标：${USE_INSTALLED ? '已安装副本' : '仓库源码'}  (${SRC})\n`);

console.log('[1] resolveProduct：判定优先级 = 配置 > 快照 > 嗅探 > SOLO 兜底');
const SYN_CN = { token: 't', product: 'cn', packageType: 'TRAE_CN', appVersionCode: TRAE_PRODUCTS.cn.appVersionCode };
const SYN_SOLO = { token: 't', product: 'solo', packageType: 'SOLO_CN', appVersionCode: TRAE_PRODUCTS.solo.appVersionCode };
const SYN_OLD = { token: 't', appVersionCode: TRAE_PRODUCTS.solo.appVersionCode };
ok('显式声明 cn → cn', resolveProduct({}, SYN_CN).id === 'cn');
ok('显式声明 solo → solo', resolveProduct({}, SYN_SOLO).id === 'solo');
ok('老快照（无 product/packageType）→ solo（升级前后行为一致）', resolveProduct({}, SYN_OLD).id === 'solo');
ok('只有 packageType 也能判 cn', resolveProduct({}, { packageType: 'TRAE_CN' }).id === 'cn');
ok('只有 buildId 也能判 cn（嗅探）', resolveProduct({}, { appVersionCode: TRAE_PRODUCTS.cn.appVersionCode }).id === 'cn');
ok('配置可强制覆盖快照', resolveProduct({ product: 'solo' }, SYN_CN).id === 'solo');
ok('配置乱填 → 忽略、按快照判', resolveProduct({ product: 'nope' }, SYN_CN).id === 'cn');
ok('空文档 → solo（绝不抛）', resolveProduct({}, undefined).id === 'solo');

console.log('\n[2] activeProduct：只读文件，不判 token 过期（未登录也要有答案）');
ok('从凭据文件判定', activeProduct(() => ({ credentialFile: CN_CRED })) !== undefined);
ok('配置强制生效', activeProduct({ product: 'solo' }).id === 'solo');
ok('文件不存在 → solo 且不抛', activeProduct({ credentialFile: path.join(HOME, 'definitely-missing.json') }).id === 'solo');

console.log('\n[3] TRAE_PRODUCTS 变体表完整性（缺一个字段就是半套配置）');
for (const p of Object.values(TRAE_PRODUCTS)) {
  const need = ['id', 'label', 'appDir', 'packageType', 'reqSource', 'appVersionCode', 'appVersion', 'defaultFunction', 'functions', 'rateExtraFunctions', 'catalogGroups', 'fallbackModels', 'catalogSubdir'];
  const missing = need.filter((k) => p[k] === undefined || (Array.isArray(p[k]) && p[k].length === 0));
  ok(`${p.id}：字段齐全`, missing.length === 0, missing.join(','));
  ok(`${p.id}：defaultFunction 在自己的白名单里`, p.functions.includes(p.defaultFunction), p.defaultFunction);
  ok(`${p.id}：catalogGroups ⊆ functions（档位键名取得到）`, p.catalogGroups.every((g) => p.functions.includes(g)), p.catalogGroups.filter((g) => !p.functions.includes(g)).join(','));
}
ok('两个产品的 buildId 不同（倍率接口按它筛选，相同就静默降级）', TRAE_PRODUCTS.cn.appVersionCode !== TRAE_PRODUCTS.solo.appVersionCode, `${TRAE_PRODUCTS.cn.appVersionCode} / ${TRAE_PRODUCTS.solo.appVersionCode}`);
ok('两个产品的 reqSource 不同（SOLO=2 / CN=1）', TRAE_PRODUCTS.cn.reqSource === 1 && TRAE_PRODUCTS.solo.reqSource === 2);
ok('SOLO 的兜底名单保持历史 7 条（逐字不变）', TRAE_PRODUCTS.solo.fallbackModels.length === 7, `n=${TRAE_PRODUCTS.solo.fallbackModels.length}`);
ok('SOLO 的目录子目录仍是 trae/（旧快照不用重导）', TRAE_PRODUCTS.solo.catalogSubdir === 'trae');
ok('CN 用独立的 trae-cn/（不与 SOLO 目录混）', TRAE_PRODUCTS.cn.catalogSubdir === 'trae-cn');

console.log('\n[4] decodeModelId：function 白名单按产品');
ok('CN 放行 solo_agent', decodeModelId('glm-5.3@solo_agent', 'chat_v3', TRAE_PRODUCTS.cn.functions).functionName === 'solo_agent');
ok('CN 拒绝 solo 专有 solo_coder → 退回默认', decodeModelId('glm-5.3@solo_coder', 'solo_agent', TRAE_PRODUCTS.cn.functions).functionName === 'solo_agent');
ok('SOLO 放行 solo_coder', decodeModelId('glm-5.3@solo_coder', 'solo_work_lite', TRAE_PRODUCTS.solo.functions).functionName === 'solo_coder');
ok('无 @ 后缀 → 用默认 function', decodeModelId('glm-5.3', 'solo_agent', TRAE_PRODUCTS.cn.functions).functionName === 'solo_agent');
ok('未知后缀 → 退回默认 function，且模型名保持原样（不静默剥后缀，让上游报 model is unknown）', (() => {
  const d = decodeModelId('glm-5.3@bogus', 'solo_agent', TRAE_PRODUCTS.cn.functions);
  return d.functionName === 'solo_agent' && d.model === 'glm-5.3@bogus';
})());

console.log('\n[5] 账号写接口的 req_source 由产品决定（桩 fetch，不打上游）');
const seen = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  seen.push({ url: String(url), body: JSON.parse(init.body) });
  return new Response(JSON.stringify({ code: 0, message: 'ok', enable: true, checked_in: true, credits: 100, usage_summary: { total_amount: 100, consumed_amount: 1 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const account = createTraeAccountClient({});
const credFor = (p) => ({ token: 't', userId: 'u', account: '', gateway: 'https://x', accountBase: 'https://api.trae.cn', appId: 'a', appVersionCode: 1, deviceId: 'd', product: p });
await account.fetchCheckinStatus(credFor(TRAE_PRODUCTS.cn));
await account.fetchCheckinStatus(credFor(TRAE_PRODUCTS.solo));
ok('CN → req_source=1', seen[0]?.body?.req_source === 1, JSON.stringify(seen[0]?.body));
ok('SOLO → req_source=2（历史行为不变）', seen[1]?.body?.req_source === 2, JSON.stringify(seen[1]?.body));

console.log('\n[6] 推理请求走 llm_utils_chat 并透传 function（桩 fetch）');
const sent = [];
globalThis.fetch = async (url, init) => {
  sent.push({ url: String(url), body: JSON.parse(init.body) });
  return new Response('event:output\ndata:{"response":"hi"}\n\nevent:done\ndata:{"finish_reason":"stop"}\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
};
await createTraeClient({}).chatStream(credFor(TRAE_PRODUCTS.cn), { model: 'glm-5.3', function: 'solo_agent', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }, undefined);
globalThis.fetch = realFetch;
ok('端点 = /api/agent/v3/llm_utils_chat', /\/api\/agent\/v3\/llm_utils_chat$/.test(sent[0]?.url ?? ''), sent[0]?.url);
ok('function 原样透传', sent[0]?.body?.function === 'solo_agent');

console.log('\n[7] 真实快照（宿主导出后才有；没装 Trae 的机器自动跳过）');
okIf('CN 快照判成 cn', cnCred?.product === 'cn', cnCred !== undefined, cnCred ? `label=${resolveProduct({}, cnCred).label}` : '');
okIf('CN 快照的 reqSource=1 且 buildId 与变体表一致', cnCred?.reqSource === 1 && cnCred?.appVersionCode === TRAE_PRODUCTS.cn.appVersionCode, cnCred !== undefined);
okIf('CN 目录读到 22 个模型（不是 SOLO 的 26）', cnCatalog?.models?.length === 22, cnCatalog !== undefined, `n=${cnCatalog?.models?.length}`);
okIf('目录里的中文 display_name 没乱码', (cnCatalog?.models ?? []).every((m) => !m.name.includes('\uFFFD')), cnCatalog !== undefined);
okIf('maxTokens 不越过任一分组 dev 窗口（越界=静默开 Max、5× 计费）', (cnCatalog?.models ?? []).every((m) => {
  const devs = Object.values(m.contextWindowByGroup ?? {}).map((t) => t?.dev).filter((n) => Number.isFinite(n) && n > 0);
  return devs.length === 0 || m.maxTokens <= Math.min(...devs);
}), cnCatalog !== undefined);
const g53 = (cnCatalog?.models ?? []).find((m) => m.id === 'glm-5.3');
okIf('glm-5.3 带 per-function 档位与窗口', !!g53?.reasoningByGroup?.solo_agent && !!g53?.contextWindowByGroup?.solo_agent, cnCatalog !== undefined);
okIf('CN 独占模型 4 个全在', ['glm-5.3-flash', 'glm-5.3-flashx', 'kimi-k2.8-preview', 'qwen3.8-flash'].every((id) => (cnCatalog?.models ?? []).some((m) => m.id === id)), cnCatalog !== undefined);
okIf('快照的 defaultFunction 与变体表一致', cnCatalog?.defaultFunction === TRAE_PRODUCTS.cn.defaultFunction, cnCatalog !== undefined, cnCatalog?.defaultFunction);
okIf('catalog 按产品分文件：SOLO 快照 → SOLO 目录', (() => {
  const soloCred = path.join(HOME, 'connect-auth', 'trae.json.solo-stash');
  if (!fs.existsSync(soloCred)) return undefined;
  return createCatalog({ config: () => ({ credentialFile: soloCred }) }).source() !== 'fallback';
})() !== false, readJson(path.join(HOME, 'connect-auth', 'trae.json.solo-stash')) !== undefined);

console.log(`\n结果：${pass} 通过 / ${fail} 失败${skipped > 0 ? ` / ${skipped} 跳过（无本机快照）` : ''}`);
process.exit(fail === 0 ? 0 : 1);
