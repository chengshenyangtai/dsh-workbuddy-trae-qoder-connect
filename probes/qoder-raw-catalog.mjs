/**
 * 查清 Qoder 目录里 `is_reasoning` 的真实含义。
 *
 * 背景：`dfmodel`（DeepSeek-Flash）目录标 `is_reasoning: false`，但实测上游
 * **接受** reasoning_effort（乱填值被 400 拒绝 → 确实在校验）。
 * 两种可能：
 *   (a) 目录字段标错了；
 *   (b) 该字段含义不是"支持 reasoning_effort 档位"，而是别的意思。
 *
 * 做法：读 `GET /algo/api/v2/model/list` 的**原始**响应，把 dfmodel 与一个
 * 实测支持档位的模型逐字段对照 —— 找出真正的区分字段。
 *
 * ⚠️ 三处实现细节照抄插件（`lib/providers/qoder/index.js`），自己重写会踩：
 *   1. 路径必须带 `/algo` 前缀，少了被 ALB 挡成 503（极易误判成 token 失效）；
 *   2. 目录是 **GET 且无 body**（签名 body 传 null），当 POST 发会被拒成 400；
 *   3. 响应是**明文 JSON**，没有编码层。
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createCipheriv, createHash, publicEncrypt, randomUUID } from "node:crypto";

const LIB = join(homedir(), ".dsh", "profiles", "desktop", "node_modules", "dsh-connect", "lib");
const qoderSrc = readFileSync(join(LIB, "providers", "qoder", "index.js"), "utf8");
const RSA = qoderSrc.match(/const QODER_RSA_PUBLIC_KEY = `([\s\S]*?)`;/)[1];
const COSY_VERSION = qoderSrc.match(/const COSY_VERSION = "([^"]+)"/)[1];
const GATEWAY = "https://gateway.qoder.com.cn";

const session = JSON.parse(readFileSync(join(homedir(), ".dsh", "connect-auth", "qoder-session.json"), "utf8"));
const creds = { userID: session.uid, authToken: session.token, name: session.name ?? "", email: session.email ?? "" };

const sigPathOf = (u) => { const p = new URL(u).pathname; return p.startsWith("/algo") ? p.slice(5) : p; };

function headers(body, url) {
  const aesKey = randomUUID().replace(/-/g, "").slice(0, 16);
  const info = { uid: creds.userID, security_oauth_token: creds.authToken, name: creds.name, aid: "", email: creds.email };
  const c = createCipheriv("aes-128-cbc", Buffer.from(aesKey), Buffer.from(aesKey));
  const infoB64 = c.update(JSON.stringify(info), "utf8", "base64") + c.final("base64");
  const cosyKey = publicEncrypt({ key: RSA, padding: 1 }, Buffer.from(aesKey)).toString("base64");
  const ts = String(Math.floor(Date.now() / 1000));
  const payload = Buffer.from(JSON.stringify({ version: "v1", requestId: randomUUID(), info: infoB64, cosyVersion: COSY_VERSION, ideVersion: "" })).toString("base64");
  // body 为 null（GET 无 body）时按空串处理，与插件 buildCosyHeaders(null, ...) 一致
  const bodyText = body === null || body === undefined ? "" : String(body);
  const sig = createHash("md5").update(payload).update("\n").update(cosyKey).update("\n").update(ts).update("\n").update(bodyText).update("\n").update(sigPathOf(url)).digest("hex");
  let mid = randomUUID();
  try { mid = readFileSync(join(homedir(), ".qoder-cn", ".auth", "machine_id"), "utf8").trim() || mid; } catch { /* 随机即可 */ }
  return {
    Authorization: `Bearer COSY.${payload}.${sig}`, "Cosy-Key": cosyKey, "Cosy-User": creds.userID,
    "Cosy-Date": ts, "Cosy-Version": COSY_VERSION, "Cosy-Machineid": mid, "Cosy-Machinetoken": mid,
    "Cosy-Machinetype": "5", "Cosy-Machineos": "x86_64_windows", "Cosy-Clienttype": "5",
    "Cosy-Clientip": "127.0.0.1", "Cosy-Bodyhash": createHash("md5").update(bodyText).digest("hex"),
    "Cosy-Bodylength": String(bodyText.length), "Cosy-Sigpath": sigPathOf(url), "Cosy-Data-Policy": "disagree",
    "Cosy-Organization-Id": "", "Cosy-Organization-Tags": "", "Login-Version": "v2",
    Accept: "application/json", "User-Agent": "dsh-qoder-connect", "Content-Type": "application/json",
  };
}

const url = `${GATEWAY}/algo/api/v2/model/list?Encode=1`;
const res = await fetch(url, { method: "GET", headers: headers(null, url), signal: AbortSignal.timeout(60000) });
if (!res.ok) { console.log("HTTP", res.status, (await res.text()).slice(0, 200)); process.exit(1); }
const list = JSON.parse(await res.text())?.chat ?? [];
console.log(`模型数: ${list.length}\n`);

const nameOf = (m) => m?.key ?? m?.name ?? m?.config_name ?? m?.model_key ?? "?";
const target = process.argv[2] ?? "dfmodel";
const ref = process.argv[3] ?? "qmodel";
const t = list.find((m) => nameOf(m) === target);
const r = list.find((m) => nameOf(m) === ref);

console.log("=== 原始字段（第一个模型，展示上游到底给了什么）===");
for (const [k, v] of Object.entries(list[0] ?? {})) {
  const s = JSON.stringify(v);
  console.log(`  ${k.padEnd(26)} ${s === undefined ? "undefined" : s.slice(0, 64)}`);
}

console.log("\n=== is_reasoning 分布 ===");
for (const m of list) {
  console.log(`  ${String(nameOf(m)).padEnd(18)} is_reasoning=${JSON.stringify(m.is_reasoning)}`);
}

console.log("\n=== thinking_config.efforts（上游**已声明**的档位；is_reasoning 只是「是否专用思考模型」）===");
for (const m of list) {
  const eff = m.thinking_config?.enabled?.efforts;
  const keys = eff !== null && typeof eff === "object" ? Object.keys(eff) : [];
  const def = Object.entries(eff ?? {}).find(([, v]) => v?.is_default === true)?.[0];
  console.log(`  ${String(nameOf(m)).padEnd(18)} is_reasoning=${String(m.is_reasoning).padEnd(5)} efforts=[${keys.join(",").padEnd(18)}] default=${def ?? "-"}`);
}
console.log("\n=== 完整 thinking_config 样例（dfmodel / qmodel / dmodel）===");
for (const k of [target, ref, "dmodel", "q37fmodel", "mmodel"]) {
  const m = list.find((x) => nameOf(x) === k);
  console.log(`\n--- ${k} ---`);
  console.log(JSON.stringify(m?.thinking_config, null, 2));
}

if (t !== undefined && r !== undefined) {
  console.log(`\n=== ${target} vs ${ref} 的差异字段（后者实测支持档位）===`);
  for (const k of new Set([...Object.keys(t), ...Object.keys(r)])) {
    const tv = JSON.stringify(t[k]);
    const rv = JSON.stringify(r[k]);
    if (tv !== rv) console.log(`  ${k.padEnd(26)} ${target}=${tv?.slice(0, 44)}   |   ${ref}=${rv?.slice(0, 44)}`);
  }
} else {
  console.log(`\n（未匹配 target/ref：target=${target} ref=${ref}；实际 key 见上方列表）`);
}
