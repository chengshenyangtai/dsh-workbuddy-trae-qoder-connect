// 在宿主机上执行：解开 Trae SOLO CN（字节跳动 trae.cn 的 VS Code fork）本地凭据，
// 并用解出的会话令牌直连 Trae 生产网关做只读自检。
//
// 背景：Trae 把登录态以 `iCubeAuthInfo://<域>` 为 key 存在
//   ~/Library/Application Support/TRAE SOLO CN/User/globalStorage/storage.json
// 值是一串 base64，头部 6 字节是 `74 63 05 10 00 00`（"tc" 05 10 00 00）。
// 本脚本复刻了 App 内置的 out-build/vs/base/common/byteCrypto.js，格式为：
//
//   envelope = hdr(6) ‖ key32 ‖ AES-128-CBC(payload)
//   hdr      = [116,99,5,16,0,0]
//   payload  = SHA512(明文) ‖ 明文          ← 明文前 64 字节是整性校验
//   kdf(k32) : n = SHA512(k32) ‖ (WOE ⊕ VOE)     // 128 字节
//              n[0:64] = SHA512(n)               // 覆盖前 64
//              aesKey  = n[0:16], iv = n[16:32]
//
// 关键区别（对比同目录的 export-wb-plain.mjs）：WorkBuddy 的信封密钥由 App 自己的
// Electron 原生绑定持有，宿主上必须借 App 的二进制才能解；Trae 这套**纯自包含**——
// 密钥就是信封里的 key32，KDF 只用 SHA-512 和两组写死在 JS 里的常量表，
// 没有钥匙串、没有设备私钥、没有 NATIVE 调用。所以可以完全离线复现（本脚本已在
// 0.1.66 上做过 encrypt→decrypt 往返自检，四组 UTF-8 样本全部一致）。
//
// 已实测的线上事实（2026-09-24，免费账号）：
//   · 鉴权头就是 `Authorization: Cloud-IDE-JWT <token>`（session.token，RS256 JWT）
//   · https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage        → 200（额度）
//   · https://api.trae.cn/trae/api/v2/ug/checkin_credits/status     → 200（签到）
//   · https://trae-api-cn.mchost.guru/api/ide/v1/features           → 200（功能开关）
//   · https://trae-api-cn.mchost.guru/api/ide/v1/chat               → SSE 流
//   · https://trae-api-cn.mchost.guru/api/ide/v2/llm_raw_chat       → SSE 流
//   · https://trae-api-cn.mchost.guru/api/ide/v1/providers          → 200（BYOK 供应商目录）
//   · https://trae-api-cn.mchost.guru/api/ide/v1/batch_get_detail_param → 200（模型配置注册表）
// 注意 llm_raw_chat 还差一层「app config」注册（服务端回 code 2001），
// 所以本脚本的 probe 只做**不消耗额度**的只读探测，不发推理请求。
//
// 为什么值得做：Trae 的 BYOK 密钥走的不是本地解密，而是**服务端代理**
// （dylib 里的 custom_model_proxy）——请求里只带 config_name/custom_model_uniq_id，
// 密钥留在服务端注入。也就是说一个会话令牌就能覆盖「内置模型 + 用户自配模型」全部，
// 不需要去解 model_list_map 里那些 ak（它们也不是本套 envelope，解不出来）。
//
// 用法：
//   node scripts/trae-vault.mjs dump            # 解密全部 iCubeAuthInfo（默认脱敏）
//   node scripts/trae-vault.mjs dump --full     # 不脱敏，打印完整明文
//   node scripts/trae-vault.mjs probe           # 用令牌打线上只读接口
//   node scripts/trae-vault.mjs encrypt '<文本>' # 生成 x-icube-context 用得到的密文
//   node scripts/trae-vault.mjs selftest        # 加解密往返自检（不碰网络、不碰凭据）
//
// 安全约定：默认不打印任何 token 原文；只读 storage.json，不写不改任何文件。

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ── byteCrypto 常量（同步自 main.js 的 out-build/vs/base/common/byteCrypto.js）─────
// WOE 经独立核对 = AES 逆 S 盒的前 64 字节；VOE/JOE/HOE 是配对使用的异或掩码表。
// AES 模式用 WOE⊕VOE，AES_PRIVATE 模式用 JOE⊕HOE（本账号用不到后者）。
const JOE = Buffer.from([191,192,216,250,122,246,220,97,31,254,98,27,8,72,71,176,135,99,96,18,127,101,203,104,211,102,191,125,37,72,150,156,51,229,121,35,17,153,141,177,110,131,150,128,172,255,254,6,18,140,55,62,236,249,135,64,135,12,117,4,89,149,168,209]);
const HOE = Buffer.from([246,204,26,232,232,70,129,109,223,146,169,242,23,241,105,145,50,196,165,42,254,120,3,54,244,207,209,85,53,6,138,106,175,148,31,204,186,186,165,182,87,142,49,10,39,110,26,154,86,56,173,125,18,64,198,225,99,99,83,82,191,134,76,170]);
const WOE = Buffer.from([82,9,106,213,48,54,165,56,191,64,163,158,129,243,215,251,124,227,57,130,155,47,255,135,52,142,67,68,196,222,233,203,84,123,148,50,166,194,35,61,238,76,149,11,66,250,195,78,8,46,161,102,40,217,36,178,118,91,162,73,109,139,209,37]);
const VOE = Buffer.from([31,221,168,51,136,7,199,49,177,18,16,89,39,128,236,95,96,81,127,169,25,181,74,13,45,229,122,159,147,201,156,239,160,224,59,77,174,42,245,176,200,235,187,60,131,83,153,97,23,43,4,126,186,119,214,38,225,105,20,99,85,33,12,125]);

const HDR = Buffer.from([116, 99, 5, 16, 0, 0]);
const MAGIC = 'dGMF';           // base64("tc\x05")
const U_LEN = 32;               // key32
const H_LEN = 64;               // SHA-512 摘要长度
const MODE_AES = 1;

const sha512 = (b) => createHash('sha512').update(b).digest();

// DUe(n, mode)：取出 n 字节掩码。AES 模式 = WOE⊕VOE，PRIVATE 模式 = JOE⊕HOE。
function mask(n, mode) {
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) out[i] = mode === MODE_AES ? WOE[i] ^ VOE[i] : JOE[i] ^ HOE[i];
  return out;
}

// Roe(k32) → { aesKey, iv }：n = SHA512(k32) ‖ mask(64)，再把 n 前 64 覆盖成 SHA512(n)。
function kdf(key32, mode = MODE_AES) {
  const n = Buffer.alloc(H_LEN + 64);
  n.set(sha512(key32), 0);
  n.set(mask(64, mode), H_LEN);
  n.set(sha512(n), 0);
  return { aesKey: n.subarray(0, 16), iv: n.subarray(16, 32) };
}

// Km() 等价物：加密。App 里用于 x-icube-context 这类要传给服务端的上下文。
export function seal(plain) {
  const pt = Buffer.from(plain, 'utf8');
  const key32 = randomBytes(U_LEN);
  const { aesKey, iv } = kdf(key32);
  const body = Buffer.alloc(H_LEN + pt.length);
  body.set(sha512(pt), 0);
  body.set(pt, H_LEN);
  const c = createCipheriv('aes-128-cbc', aesKey, iv);
  return Buffer.concat([HDR, key32, c.update(body), c.final()]).toString('base64');
}

// dv() 等价物：解密。校验不过返回 null（对应 App 返回空数组的失败分支）。
export function unseal(b64) {
  if (typeof b64 !== 'string' || !b64.startsWith(MAGIC)) return null;
  const blob = Buffer.from(b64, 'base64');
  if (blob.length < HDR.length + U_LEN + 16 || !blob.subarray(0, 6).equals(HDR)) return null;
  const { aesKey, iv } = kdf(blob.subarray(6, 6 + U_LEN));
  let pt;
  try {
    const d = createDecipheriv('aes-128-cbc', aesKey, iv);
    pt = Buffer.concat([d.update(blob.subarray(6 + U_LEN)), d.final()]);
  } catch { return null; }
  return sha512(pt.subarray(H_LEN)).equals(pt.subarray(0, H_LEN)) ? pt.subarray(H_LEN).toString('utf8') : null;
}

// ── vault 读取 ──────────────────────────────────────────────────────────────
const STORAGE = join(homedir(), 'Library', 'Application Support', 'TRAE SOLO CN',
  'User', 'globalStorage', 'storage.json');

function readVault() {
  if (!existsSync(STORAGE)) {
    console.error(`找不到 Trae 的 storage.json：\n  ${STORAGE}\n（未安装 TRAE SOLO CN，或从未登录过。）`);
    process.exit(2);
  }
  const doc = JSON.parse(readFileSync(STORAGE, 'utf8'));
  const out = [];
  for (const [key, val] of Object.entries(doc)) {
    if (typeof val !== 'string' || !val.startsWith(MAGIC)) continue;
    out.push({ key, plain: unseal(val), bytes: val.length });
  }
  return { doc, out };
}

// 只对「密钥类」字段做掩码，绝不全文正则——私钥 PEM 的 base64 里也可能出现 eyJ。
const SECRET_FIELDS = /^(token|refreshToken|accessToken|secret|password|ak|sk)$/i;
function redactObj(v, depth = 0) {
  if (Array.isArray(v)) return v.map((x) => redactObj(x, depth + 1));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === 'string' && val.length > 16 && SECRET_FIELDS.test(k)) {
        o[k] = `${val.slice(0, 12)}…(${val.length} 字符，已掩码)`;
      } else o[k] = redactObj(val, depth + 1);
    }
    return o;
  }
  return v;
}

// ── 子命令 ──────────────────────────────────────────────────────────────────
function cmdDump(full) {
  const { out } = readVault();
  if (!out.length) { console.log('vault 里没有 iCubeAuthInfo 条目（可能没登录）。'); return; }
  console.log(`storage.json: ${STORAGE}\n`);
  for (const { key, plain, bytes } of out) {
    console.log(`══ ${key}   (base64 ${bytes}B)`);
    if (!plain) { console.log('   ✗ 解密失败\n'); continue; }
    let shown = plain;
    try {
      const j = JSON.parse(plain);
      shown = JSON.stringify(full ? j : redactObj(j), null, 2);
    } catch { /* 非 JSON 原样 */ }
    console.log(shown.split('\n').map((l) => '   ' + l).join('\n'), '\n');
  }
  if (!full) console.log('（已脱敏：token / refreshToken 只留前缀。要看全文加 --full。）');
}

async function cmdProbe() {
  const { out } = readVault();
  const entry = out.find((e) => e.key.startsWith('iCubeAuthInfo://icube.') || e.key === 'iCubeAuthInfo://icube.cloudide')
    || out.find((e) => e.plain && e.plain.includes('"token"'));
  if (!entry?.plain) { console.error('vault 里找不到带 token 的会话条目。'); process.exit(2); }
  const s = JSON.parse(entry.plain);
  const tok = s.token;
  const exp = s.expiredAt ? new Date(s.expiredAt) : null;

  console.log(`账号      : ${s.account?.username ?? '?'}  (userId ${s.userId}, scope ${s.account?.scope})`);
  console.log(`令牌       : 到期 ${s.expiredAt}  ${exp ? (exp > new Date() ? '（仍有效）' : '（已过期，需 App 刷新后重新 dump）') : ''}`);
  console.log(`refreshToken 到期：${s.refreshExpiredAt ?? '?'}\n`);

  const H = { Authorization: `Cloud-IDE-JWT ${tok}`, 'Content-Type': 'application/json' };
  const targets = [
    ['额度   ', 'GET', 'https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage', null],
    ['签到   ', 'GET', 'https://api.trae.cn/trae/api/v2/ug/checkin_credits/status', null],
    ['功能开关', 'GET', 'https://trae-api-cn.mchost.guru/api/ide/v1/features', null],
    ['推理端点', 'POST', 'https://trae-api-cn.mchost.guru/api/ide/v2/llm_raw_chat', {}],
  ];
  for (const [label, method, url, body] of targets) {
    try {
      const r = await fetch(url, { method, headers: H, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
      const t = await r.text();
      const brief = t.replace(/\s+/g, ' ').slice(0, 130);
      console.log(`  ${label} ${r.status}  ${new URL(url).host}${new URL(url).pathname}`);
      console.log(`           ${brief}`);
    } catch (e) {
      console.log(`  ${label} 请求失败: ${e.message}`);
    }
  }
  console.log('\n注：llm_raw_chat 返回 2001「failed to get app config」= 参数结构已通过校验、');
  console.log('    仅缺服务端的 app config 注册；本探测只发空体，不消耗额度。');
}

function cmdEncrypt(text) {
  if (!text) { console.error('用法: node scripts/trae-vault.mjs encrypt \'<文本>\''); process.exit(2); }
  const ct = seal(text);
  console.log('密文（base64，用作 x-icube-context）：\n');
  console.log(ct);
  console.log('\n自校验:', unseal(ct) === text ? '往返一致 ✓' : '往返不一致 ✗');
}

function cmdSelftest() {
  const samples = [
    'hello',
    '{"a":1}',
    '中文与符号 ✓ — “引号”',
    JSON.stringify({ app_version: '0.1.66', version_code: 1227681842690, device_id: '1234567890123456', plugin_channel: 'solo', is_solo_mode: true, enable_llm_utils_cloud: true, is_evaluation: false, user_timezone: 'Asia/Shanghai', scope: 'marscode' }),
    'x'.repeat(4096),
  ];
  let ok = true;
  for (const s of samples) {
    const enc = seal(s);
    const dec = unseal(enc);
    const good = dec === s;
    ok &&= good;
    console.log(`  ${good ? 'OK  ' : 'FAIL'}  ${Buffer.from(enc, 'base64').length}B  ${s.slice(0, 46)}`);
  }
  // 负例：改一位必须解不开
  const good = seal('tamper-me');
  const blob = Buffer.from(good, 'base64');
  blob[blob.length - 1] ^= 0x01;
  const tampered = unseal(blob.toString('base64'));
  console.log(`  篡改检测  ${tampered === null ? 'OK（被拒）' : 'FAIL（竟然解开了）'}`);
  console.log(`\n往返自检: ${ok && tampered === null ? '全部通过 ✓' : '存在失败 ✗'}`);
  process.exit(ok && tampered === null ? 0 : 1);
}

// ── CLI 入口（仅当被直接执行时；import 本模块只拿到 seal/unseal）─────────────────
const invokedDirectly = process.argv[1]?.endsWith('trae-vault.mjs');
if (invokedDirectly) {
  const [cmd = 'dump', ...rest] = process.argv.slice(2);
  if (cmd === 'dump') cmdDump(rest.includes('--full'));
  else if (cmd === 'probe') await cmdProbe();
  else if (cmd === 'encrypt') cmdEncrypt(rest[0]);
  else if (cmd === 'selftest') cmdSelftest();
  else {
    console.log(`用法:
  node scripts/trae-vault.mjs dump [--full]   解密 vault（默认脱敏）
  node scripts/trae-vault.mjs probe           线上只读自检
  node scripts/trae-vault.mjs encrypt <文本>  生成 x-icube-context 密文
  node scripts/trae-vault.mjs selftest        加解密往返自检`);
    process.exit(1);
  }
}
