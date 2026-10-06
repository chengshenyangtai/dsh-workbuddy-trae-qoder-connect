/**
 * Qoder 思考档位「效果对照」—— 单请求版（一次一个，避免限流）
 *
 * ## 为什么要拆成单请求
 *
 * 前两版一次跑 4 档 × 3 轮 = 12 个连续请求，结果 `high`/`max` 稳定超时。
 * 但那个"超时"**不干净**：既是难题本身耗时长，又叠加上游限流（同一 key 短时间
 * 密集调用），两者混在一起无法归因 —— 这正是我上一版的错误。
 *
 * 本版一次运行只发**一个**请求，把结果追加到 JSONL，由调用方逐次触发、
 * 每次之间留足冷却。这样：
 *   · 限流不再是变量（相邻请求间隔以分钟计）；
 *   · 单次失败可以单独重跑，不必重做整组；
 *   · 原始数据落盘，统计口径可以事后修正而不用重发请求。
 *
 * 用法：
 *   node qoder-one.mjs <档位> [模型]
 *   node qoder-one.mjs low qfmodel
 *   node qoder-one.mjs --report            # 只统计已落盘数据，不发请求
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createCipheriv, createHash, publicEncrypt, randomUUID } from "node:crypto";

const OUT = join(homedir(), ".dsh", "patches", "dsh-connect-desktop", "probes", "qoder-effort-samples.jsonl");

// ── 与插件同形的编码/签名（照抄 providers/qoder/index.js）──────────────────
const CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const ENC_TABLE = new Uint8Array(256);
for (let i = 0; i < 256; i += 1) ENC_TABLE[i] = i;
for (let i = 0; i < 64; i += 1) ENC_TABLE[STD_ALPHABET.charCodeAt(i)] = CUSTOM_ALPHABET.charCodeAt(i);
ENC_TABLE["=".charCodeAt(0)] = "$".charCodeAt(0);

const RSA = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;
const COSY_VERSION = "1.1.38";
const GATEWAY = "https://gateway.qoder.com.cn";
const CHAT_PATH = "/algo/api/v2/service/pro/sse/agent_chat_generation";

const PROMPT = process.env.QODER_PROMPT
  ?? "证明 Ramsey 定理 R(3,3)=6：任意 6 人中必有 3 人互相认识或 3 人互相不认识。要求：(1) 用反证法给出完整严格证明；(2) 说明为什么 5 人时结论不成立并构造反例；(3) 讨论 R(3,3) 与 R(3,4)、R(4,4) 的关系及已知上下界。";

const md5 = (b) => createHash("md5").update(b).digest("hex");
const sigPathOf = (u) => { const p = new URL(u).pathname; return p.startsWith("/algo") ? p.slice(5) : p; };

function encode(plain) {
  const std = plain.toString("base64");
  const n = std.length, a = Math.floor(n / 3);
  const out = Buffer.allocUnsafe(n);
  let d = 0;
  for (let i = n - a; i < n; i += 1) out[d++] = ENC_TABLE[std.charCodeAt(i)];
  for (let i = a; i < n - a; i += 1) out[d++] = ENC_TABLE[std.charCodeAt(i)];
  for (let i = 0; i < a; i += 1) out[d++] = ENC_TABLE[std.charCodeAt(i)];
  return out;
}
const machineOs = () => process.platform === "win32"
  ? (process.arch === "arm64" ? "aarch64_windows" : "x86_64_windows")
  : (process.arch === "arm64" ? "aarch64_linux" : "x86_64_linux");
function machineId() {
  for (const p of [join(homedir(), ".qoder-cn", ".auth", "machine_id"), join(homedir(), ".qoder", ".auth", "machine_id")]) {
    try { const v = readFileSync(p, "utf8").trim(); if (v) return v; } catch { /* next */ }
  }
  return randomUUID();
}
function cosy(body, url, creds) {
  const aesKey = randomUUID().replace(/-/g, "").slice(0, 16);
  const info = { uid: creds.userID, security_oauth_token: creds.authToken, name: creds.name ?? "", aid: "", email: creds.email ?? "" };
  const c = createCipheriv("aes-128-cbc", Buffer.from(aesKey), Buffer.from(aesKey));
  const infoB64 = c.update(JSON.stringify(info), "utf8", "base64") + c.final("base64");
  const cosyKey = publicEncrypt({ key: RSA, padding: 1 }, Buffer.from(aesKey)).toString("base64");
  const ts = String(Math.floor(Date.now() / 1000));
  const payload = Buffer.from(JSON.stringify({ version: "v1", requestId: randomUUID(), info: infoB64, cosyVersion: COSY_VERSION, ideVersion: "" })).toString("base64");
  const sig = createHash("md5").update(payload).update("\n").update(cosyKey).update("\n").update(ts).update("\n").update(body).update("\n").update(sigPathOf(url)).digest("hex");
  const mid = machineId();
  return {
    Authorization: `Bearer COSY.${payload}.${sig}`, "Cosy-Key": cosyKey, "Cosy-User": creds.userID,
    "Cosy-Date": ts, "Cosy-Version": COSY_VERSION, "Cosy-Machineid": mid, "Cosy-Machinetoken": mid,
    "Cosy-Machinetype": "5", "Cosy-Machineos": machineOs(), "Cosy-Clienttype": "5", "Cosy-Clientip": "127.0.0.1",
    "Cosy-Bodyhash": md5(body), "Cosy-Bodylength": String(body.length), "Cosy-Sigpath": sigPathOf(url),
    "Cosy-Data-Policy": "disagree", "Cosy-Organization-Id": "", "Cosy-Organization-Tags": "",
    "Login-Version": "v2", "X-Request-Id": randomUUID(), "Content-Type": "application/json",
  };
}

/** 统计已落盘样本（不发请求）。 */
function report() {
  if (!existsSync(OUT)) { console.log("还没有样本文件：" + OUT); return; }
  const rows = readFileSync(OUT, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
  console.log(`样本总数 ${rows.length}（文件 ${OUT}）\n`);
  console.log("档位      样本  成功  思考链(各次)                     中位数  正文中位数");
  const byEffort = {};
  for (const r of rows) (byEffort[r.effort] ??= []).push(r);
  const med = (xs) => { const a = [...xs].sort((x, y) => x - y); return a.length === 0 ? undefined : a.length % 2 ? a[(a.length - 1) / 2] : Math.round((a[a.length / 2 - 1] + a[a.length / 2]) / 2); };
  const medians = {};
  for (const e of ["low", "medium", "high", "max"]) {
    const g = byEffort[e];
    if (g === undefined) continue;
    const ok = g.filter((r) => r.http === 200);
    const lens = ok.map((r) => r.reasonLen);
    medians[e] = med(lens);
    console.log(`${e.padEnd(9)} ${String(g.length).padEnd(6)} ${String(ok.length).padEnd(6)} ${(lens.join(" / ") || "-").padEnd(33)} ${String(med(lens) ?? "-").padEnd(7)} ${med(ok.map((r) => r.contentLen)) ?? "-"}`);
  }
  const vals = Object.values(medians).filter((v) => v !== undefined);
  if (vals.length >= 2) {
    const between = Math.max(...vals) - Math.min(...vals);
    const sds = [];
    for (const e of Object.keys(medians)) {
      const a = (byEffort[e] ?? []).filter((r) => r.http === 200).map((r) => r.reasonLen);
      if (a.length < 2) continue;
      const m = a.reduce((x, y) => x + y, 0) / a.length;
      sds.push(Math.round(Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1))));
    }
    const within = sds.length ? Math.round(sds.reduce((a, b) => a + b, 0) / sds.length) : 0;
    console.log(`\n组间极差(中位数) = ${between}    组内标准差均值 = ${within}`);
    console.log(between > within * 2
      ? "→ 信号强于噪声：档位对思考链长度有可辨影响。"
      : "→ 组间差异 ≤ 组内波动：此数据不足以证明档位改变思考链长度。");
  }
  // 把解析异常也摆出来，避免"只看成功样本"的偏差。
  const failed = rows.filter((r) => r.http !== 200);
  if (failed.length > 0) {
    console.log("\n未成功样本（不可当'无差异'处理）：");
    for (const r of failed) console.log(`  ${r.effort.padEnd(8)} http=${r.http}  ${r.note ?? ""}`);
  }
}

const [, , argEffort, argModel] = process.argv;
if (argEffort === "--report" || argEffort === undefined) { report(); process.exit(0); }

const EFFORT = argEffort;
const MODEL = argModel ?? process.env.QODER_MODEL ?? "qfmodel";
const TIMEOUT_MS = Number(process.env.QODER_TIMEOUT_MS ?? 600000);
const creds = (() => {
  const s = JSON.parse(readFileSync(join(homedir(), ".dsh", "connect-auth", "qoder-session.json"), "utf8"));
  return { userID: s.uid, authToken: s.token, name: s.name ?? "", email: s.email ?? "" };
})();
const url = `${GATEWAY}${CHAT_PATH}?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;

const id = randomUUID();
const body = {
  request_id: id, request_set_id: id, chat_record_id: id, session_id: randomUUID(),
  stream: true, chat_task: "FREE_INPUT", is_reply: true, is_retry: false, source: 1,
  version: "3", agent_id: "agent_common", task_id: "common", session_type: "qoderclicn",
  code_language: "", chat_prompt: "", image_urls: null, aliyun_user_type: "", system: "",
  messages: [{ role: "user", content: PROMPT }], tools: [],
  parameters: { enable_thinking: true, max_tokens: 8192, reasoning_effort: EFFORT },
  chat_context: {
    chatPrompt: "", imageUrls: null,
    extra: { context: [], modelConfig: { key: MODEL, is_reasoning: true }, originalContent: PROMPT },
    features: [], text: PROMPT,
  },
  model_config: { key: MODEL, source: "system" },
  business: { product: "cli", version: "1.0.0", type: "agent", stage: "start", id, name: PROMPT.slice(0, 30), begin_at: Date.now() },
};

const encoded = encode(Buffer.from(JSON.stringify(body), "utf8"));
const t0 = Date.now();
let record;
try {
  const res = await fetch(url, { method: "POST", headers: cosy(encoded, url, creds), body: encoded, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  const ms = Date.now() - t0;
  // 双层 JSON：外层信封的 body 里才是 OpenAI delta。
  let reasonLen = 0, contentLen = 0, chunks = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const p = line.slice(5).trim();
    if (p === "" || p === "[DONE]") continue;
    let outer; try { outer = JSON.parse(p); } catch { continue; }
    if (typeof outer.body !== "string") continue;
    let inner; try { inner = JSON.parse(outer.body); } catch { continue; }
    for (const ch of inner.choices ?? []) {
      const d = ch?.delta; chunks += 1;
      if (typeof d?.reasoning_content === "string") reasonLen += d.reasoning_content.length;
      if (typeof d?.content === "string") contentLen += d.content.length;
    }
  }
  record = { at: new Date().toISOString(), effort: EFFORT, model: MODEL, http: res.status, ms, reasonLen, contentLen, chunks, bytes: text.length };
  console.log(`effort=${EFFORT.padEnd(7)} http=${res.status}  耗时=${(ms / 1000).toFixed(1)}s  思考链=${reasonLen}  正文=${contentLen}  delta块=${chunks}`);
} catch (error) {
  record = { at: new Date().toISOString(), effort: EFFORT, model: MODEL, http: 0, ms: Date.now() - t0, reasonLen: 0, contentLen: 0, chunks: 0, bytes: 0, note: String(error?.message ?? error).slice(0, 120) };
  console.log(`effort=${EFFORT.padEnd(7)} 失败：${record.note}（耗时 ${(record.ms / 1000).toFixed(1)}s）`);
}
appendFileSync(OUT, `${JSON.stringify(record)}\n`, "utf8");
console.log(`已追加样本 → ${OUT}`);
