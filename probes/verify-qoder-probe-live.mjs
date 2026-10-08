/**
 * Qoder 探查端到端验证（真实上游，含对照组）
 *
 * 直接复用插件里的探测逻辑（`sendQoderProbe` 的等价实现）打真实上游，
 * 证明：
 *   1. 哨兵值会被 400 拒绝 → 哨兵拒绝法在 Qoder 上成立；
 *   2. 逐档扫描能得到真实的接受集合。
 *
 * 之所以不复用 WorkBuddy 那套"跑一次就信"的做法：必须自己先验证方法论
 * 在这个上游确实成立（Trae 就不成立 —— 它静默忽略非法值）。
 *
 * 消耗：每个模型 2 + 候选数（5）个极短请求（max_tokens=16），很小。
 *
 * 用法：node verify-qoder-probe-live.mjs [modelId]
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createCipheriv, createHash, publicEncrypt, randomUUID } from "node:crypto";

const PLUGIN_DIR = join(homedir(), ".dsh", "profiles", "desktop", "node_modules", process.env.DSH_CONNECT_DIR ?? "dsh-connect");
// 从插件源码里取常量（照抄实现，避免探针与线上不同形）。
const qoderSrc = readFileSync(join(PLUGIN_DIR, "lib", "providers", "qoder", "index.js"), "utf8");

const CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const ENC = new Uint8Array(256);
for (let i = 0; i < 256; i += 1) ENC[i] = i;
for (let i = 0; i < 64; i += 1) ENC[STD_ALPHABET.charCodeAt(i)] = CUSTOM_ALPHABET.charCodeAt(i);
ENC["=".charCodeAt(0)] = "$".charCodeAt(0);

const RSA = qoderSrc.match(/const QODER_RSA_PUBLIC_KEY = `([\s\S]*?)`;/)[1];
const COSY_VERSION = qoderSrc.match(/const COSY_VERSION = "([^"]+)"/)[1];
const GATEWAY = "https://gateway.qoder.com.cn";
const CHAT_PATH = "/algo/api/v2/service/pro/sse/agent_chat_generation";

function encode(plain) {
  const std = plain.toString("base64");
  const n = std.length;
  const a = Math.floor(n / 3);
  const out = Buffer.allocUnsafe(n);
  let d = 0;
  for (let i = n - a; i < n; i += 1) out[d++] = ENC[std.charCodeAt(i)];
  for (let i = a; i < n - a; i += 1) out[d++] = ENC[std.charCodeAt(i)];
  for (let i = 0; i < a; i += 1) out[d++] = ENC[std.charCodeAt(i)];
  return out;
}
const sigPathOf = (u) => { const p = new URL(u).pathname; return p.startsWith("/algo") ? p.slice(5) : p; };

function cosy(body, url, creds) {
  const aesKey = randomUUID().replace(/-/g, "").slice(0, 16);
  const info = { uid: creds.userID, security_oauth_token: creds.authToken, name: creds.name ?? "", aid: "", email: creds.email ?? "" };
  const c = createCipheriv("aes-128-cbc", Buffer.from(aesKey), Buffer.from(aesKey));
  const infoB64 = c.update(JSON.stringify(info), "utf8", "base64") + c.final("base64");
  const cosyKey = publicEncrypt({ key: RSA, padding: 1 }, Buffer.from(aesKey)).toString("base64");
  const ts = String(Math.floor(Date.now() / 1000));
  const payload = Buffer.from(JSON.stringify({ version: "v1", requestId: randomUUID(), info: infoB64, cosyVersion: COSY_VERSION, ideVersion: "" })).toString("base64");
  const sig = createHash("md5").update(payload).update("\n").update(cosyKey).update("\n").update(ts).update("\n").update(body).update("\n").update(sigPathOf(url)).digest("hex");
  let mid = randomUUID();
  try { mid = readFileSync(join(homedir(), ".qoder-cn", ".auth", "machine_id"), "utf8").trim() || mid; } catch { /* 用随机 */ }
  return {
    Authorization: `Bearer COSY.${payload}.${sig}`, "Cosy-Key": cosyKey, "Cosy-User": creds.userID,
    "Cosy-Date": ts, "Cosy-Version": COSY_VERSION, "Cosy-Machineid": mid, "Cosy-Machinetoken": mid,
    "Cosy-Machinetype": "5",
    "Cosy-Machineos": process.platform === "win32" ? "x86_64_windows" : "x86_64_linux",
    "Cosy-Clienttype": "5", "Cosy-Clientip": "127.0.0.1",
    "Cosy-Bodyhash": createHash("md5").update(body).digest("hex"), "Cosy-Bodylength": String(body.length),
    "Cosy-Sigpath": sigPathOf(url), "Cosy-Data-Policy": "disagree",
    "Cosy-Organization-Id": "", "Cosy-Organization-Tags": "",
    "Login-Version": "v2", "X-Request-Id": randomUUID(), "Content-Type": "application/json",
  };
}

const session = JSON.parse(readFileSync(join(homedir(), ".dsh", "connect-auth", "qoder-session.json"), "utf8"));
const creds = { userID: session.uid, authToken: session.token, name: session.name ?? "", email: session.email ?? "" };
const url = `${GATEWAY}${CHAT_PATH}?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;
const MODEL = process.argv[2] ?? "qmodel";

/** 发一次探查请求，返回真实状态码（业务错误从信封的 statusCodeValue 取）。 */
async function send(effort) {
  const id = randomUUID();
  const parameters = { enable_thinking: true, max_tokens: 16 };
  if (effort !== undefined) parameters.reasoning_effort = effort;
  const body = {
    request_id: id, request_set_id: id, chat_record_id: id, session_id: randomUUID(),
    stream: true, chat_task: "FREE_INPUT", is_reply: true, is_retry: false, source: 1,
    version: "3", agent_id: "agent_common", task_id: "common", session_type: "qoderclicn",
    code_language: "", chat_prompt: "", image_urls: null, aliyun_user_type: "", system: "",
    messages: [{ role: "user", content: "ping" }], tools: [], parameters,
    chat_context: { chatPrompt: "", imageUrls: null, extra: { context: [], modelConfig: { key: MODEL, is_reasoning: true }, originalContent: "ping" }, features: [], text: "ping" },
    model_config: { key: MODEL, source: "system" },
    business: { product: "cli", version: "1.0.0", type: "agent", stage: "start", id, name: "ping", begin_at: Date.now() },
  };
  const encoded = encode(Buffer.from(JSON.stringify(body), "utf8"));
  const res = await fetch(url, { method: "POST", headers: cosy(encoded, url, creds), body: encoded, signal: AbortSignal.timeout(60000) });
  if (!res.ok) { await res.text().catch(() => ""); return res.status; }
  const text = await res.text().catch(() => "");
  const m = text.match(/"statusCodeValue"\s*:\s*(\d+)/);
  const biz = m === null ? undefined : Number(m[1]);
  return biz !== undefined && biz >= 400 ? biz : 200;
}

console.log(`模型 ${MODEL} — 验证哨兵拒绝法是否成立\n`);
const baseline = await send(undefined);
console.log(`  基线(不发档位)      → ${baseline}`);
const sentinel = await send(`zz-${randomUUID()}`);
console.log(`  哨兵(随机乱填)      → ${sentinel}   ${sentinel === 400 ? "✓ 被拒 → 哨兵法成立" : "✗ 被接受 → 哨兵法不成立"}`);

if (sentinel === 400) {
  console.log("\n  逐档扫描：");
  const accepted = [];
  for (const effort of ["minimal", "low", "medium", "high", "max"]) {
    const status = await send(effort);
    if (status === 200) accepted.push(effort);
    console.log(`    ${effort.padEnd(9)} → ${status}`);
    await new Promise((s) => setTimeout(s, 800));
  }
  console.log(`\n  结论：validating，接受档位 = [${accepted.join(", ")}]`);
  console.log("  （与插件内 reasoningFieldsFor 的默认集对照，看是否一致）");
} else {
  console.log("\n  结论：non-validating —— 上游不校验该字段，不应据此给出档位选择器。");
}
