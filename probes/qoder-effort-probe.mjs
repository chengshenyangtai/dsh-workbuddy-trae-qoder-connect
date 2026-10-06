/**
 * Qoder reasoning_effort 档位探针（自包含、只读、受控）
 *
 * 目的：确认 Qoder 上游到底接受哪几个 reasoning_effort 值，据此决定是否值得
 * 给插件加"思考档位"选择器（现在 Qoder 硬编码 high，Trae 完全不发该字段）。
 *
 * 为什么内联编码/签名而不是 import 插件模块：插件依赖 `@earendil-works/pi-ai`
 * 等 peer（在打包的 app.asar 里），从外部 import 会 MODULE_NOT_FOUND。
 * 下面这两段是**照抄** providers/qoder/index.js 的实现（含同一份字母表与
 * 同一把 RSA 公钥），保证发出去的请求与插件真实请求同形 —— 否则结论无效。
 *
 * 每个档位发 1 次极短请求（"1+1=?"、max_tokens=32），消耗极小。
 *
 * 用法：node qoder-effort-probe.mjs [modelKey]
 */

import { createCipheriv, createHash, publicEncrypt, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── 照抄 providers/qoder/index.js 的常量 ────────────────────────────────────
const CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const ENC_TABLE = new Uint8Array(256);
for (let i = 0; i < 256; i += 1) ENC_TABLE[i] = i;
for (let i = 0; i < 64; i += 1) ENC_TABLE[STD_ALPHABET.charCodeAt(i)] = CUSTOM_ALPHABET.charCodeAt(i);
ENC_TABLE["=".charCodeAt(0)] = "$".charCodeAt(0);

const QODER_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

const COSY_VERSION = "1.1.38";
const COSY_CLIENT_TYPE = "5";
const DEFAULT_CHAT_PATH = "/algo/api/v2/service/pro/sse/agent_chat_generation";
const GATEWAY = "https://gateway.qoder.com.cn";
const MODEL = process.argv[2] ?? "qmodel";

const md5 = (b) => createHash("md5").update(b).digest("hex");
const sigPathOf = (u) => {
  const p = new URL(u).pathname;
  return p.startsWith("/algo") ? p.slice("/algo".length) : p;
};

function qoderEncodeBody(plain) {
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

function machineOs() {
  if (process.platform === "win32") return process.arch === "arm64" ? "aarch64_windows" : "x86_64_windows";
  if (process.platform === "darwin") return process.arch === "arm64" ? "aarch64_darwin" : "x86_64_darwin";
  return process.arch === "arm64" ? "aarch64_linux" : "x86_64_linux";
}

function resolveMachineId() {
  for (const p of [join(homedir(), ".qoder-cn", ".auth", "machine_id"), join(homedir(), ".qoder", ".auth", "machine_id")]) {
    try {
      const v = readFileSync(p, "utf8").trim();
      if (v.length > 0) return v;
    } catch { /* 继续 */ }
  }
  return randomUUID();
}

function buildCosyHeaders(body, requestUrl, creds) {
  const authToken = creds.authToken !== "" ? creds.authToken : creds.jobToken;
  const aesKey = randomUUID().replace(/-/g, "").slice(0, 16);
  const userInfo = { uid: creds.userID, security_oauth_token: authToken, name: creds.name ?? "", aid: "", email: creds.email ?? "" };
  const cipher = createCipheriv("aes-128-cbc", Buffer.from(aesKey), Buffer.from(aesKey));
  const infoB64 = cipher.update(JSON.stringify(userInfo), "utf8", "base64") + cipher.final("base64");
  const cosyKey = publicEncrypt({ key: QODER_RSA_PUBLIC_KEY, padding: 1 }, Buffer.from(aesKey)).toString("base64");
  const ts = String(Math.floor(Date.now() / 1000));
  const payloadB64 = Buffer.from(JSON.stringify({ version: "v1", requestId: randomUUID(), info: infoB64, cosyVersion: COSY_VERSION, ideVersion: "" })).toString("base64");
  const bodyBytes = Buffer.isBuffer(body) ? body : Buffer.from(body ?? "");
  const sig = createHash("md5").update(payloadB64).update("\n").update(cosyKey).update("\n").update(ts).update("\n").update(bodyBytes).update("\n").update(sigPathOf(requestUrl)).digest("hex");
  const machineId = resolveMachineId();
  return {
    Authorization: `Bearer COSY.${payloadB64}.${sig}`,
    "Cosy-Key": cosyKey, "Cosy-User": creds.userID, "Cosy-Date": ts, "Cosy-Version": COSY_VERSION,
    "Cosy-Machineid": machineId, "Cosy-Machinetoken": machineId, "Cosy-Machinetype": "5",
    "Cosy-Machineos": machineOs(), "Cosy-Clienttype": COSY_CLIENT_TYPE, "Cosy-Clientip": "127.0.0.1",
    "Cosy-Bodyhash": md5(bodyBytes), "Cosy-Bodylength": String(bodyBytes.length), "Cosy-Sigpath": sigPathOf(requestUrl),
    "Cosy-Data-Policy": "disagree", "Cosy-Organization-Id": "", "Cosy-Organization-Tags": "",
    "Login-Version": "v2", "X-Request-Id": randomUUID(),
  };
}

// ── 探针 ────────────────────────────────────────────────────────────────────
const session = JSON.parse(readFileSync(join(homedir(), ".dsh", "connect-auth", "qoder-session.json"), "utf8"));
const credential = { userID: session.uid, authToken: session.token, name: session.name ?? "", email: session.email ?? "" };
console.log(`凭据 uid=${session.uid}  token=${session.token.slice(0, 3)}…`);

function buildBody(effort) {
  const id = randomUUID();
  const parameters = { enable_thinking: true, max_tokens: 32 };
  if (effort !== "__none__") parameters.reasoning_effort = effort;
  return {
    request_id: id, request_set_id: id, chat_record_id: id, session_id: randomUUID(),
    stream: true, chat_task: "FREE_INPUT", is_reply: true, is_retry: false, source: 1,
    version: "3", agent_id: "agent_common", task_id: "common", session_type: "qoderclicn",
    code_language: "", chat_prompt: "", image_urls: null, aliyun_user_type: "", system: "",
    messages: [{ role: "user", content: "1+1=?" }], tools: [], parameters,
    chat_context: {
      chatPrompt: "", imageUrls: null,
      extra: { context: [], modelConfig: { key: MODEL, is_reasoning: true }, originalContent: "1+1=?" },
      features: [], text: "1+1=?",
    },
    model_config: { key: MODEL, source: "system" },
    business: { product: "cli", version: "1.0.0", type: "agent", stage: "start", id, name: "1+1=?", begin_at: Date.now() },
  };
}

const url = `${GATEWAY}${DEFAULT_CHAT_PATH}?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;

async function probe(effort) {
  const body = buildBody(effort);
  const encoded = qoderEncodeBody(Buffer.from(JSON.stringify(body), "utf8"));
  const headers = { ...buildCosyHeaders(encoded, url, credential), "Content-Type": "application/json" };
  try {
    const res = await fetch(url, { method: "POST", headers, body: encoded, signal: AbortSignal.timeout(35000) });
    if (!res.ok) return { verdict: `HTTP ${res.status}`, detail: "" };
    const text = await res.text();
    // 上游恒回 200，业务成败在信封里：抓 code / statusCodeValue / message。
    const codes = [...new Set([...text.matchAll(/"(?:statusCodeValue|code|bizCode)"\s*:\s*"?([A-Za-z0-9_.\-]+)"?/g)].map((m) => m[1]))];
    const msgs = [...new Set([...text.matchAll(/"(?:statusMessage|message|errorMsg)"\s*:\s*"([^"]{0,140})"/g)].map((m) => m[1]))];
    const hasContent = /"content"\s*:\s*"[^"]/.test(text) || /"reasoning_content"\s*:\s*"[^"]/.test(text);
    const looksRejected = /invalid|unsupported|illegal|not support|不支持|非法|参数错误/i.test(text);
    return {
      verdict: looksRejected ? "被拒" : hasContent ? "接受(有内容)" : "接受(无内容)",
      detail: `codes=${codes.slice(0, 4).join("|") || "-"} msg=${msgs.slice(0, 2).join(" / ").slice(0, 110) || "-"} bytes=${text.length}`,
    };
  } catch (error) {
    return { verdict: "异常", detail: String(error?.message ?? error).slice(0, 110) };
  }
}

const EFFORTS = ["__none__", "minimal", "low", "medium", "high", "max", "off", "bogus_value_xyz"];
console.log(`\n模型 ${MODEL}  逐档位探测（每档 1 次，max_tokens=32）\n`);
const rows = [];
for (const e of EFFORTS) {
  const r = await probe(e);
  const label = e === "__none__" ? "(不发该字段)" : e;
  rows.push([label, r.verdict, r.detail]);
  console.log(`  ${String(label).padEnd(16)} → ${r.verdict.padEnd(14)} ${r.detail}`);
  await new Promise((s) => setTimeout(s, 1200));
}
console.log("\n判读要点：");
console.log("  · 若 `bogus_value_xyz` 也被接受 → 上游不校验该参数，加档位选择器没有意义；");
console.log("  · 若个别档位被拒、其余接受 → 那些就是真实可用档位，值得加选择器；");
console.log("  · `(不发该字段)` 用来对比默认行为。");
