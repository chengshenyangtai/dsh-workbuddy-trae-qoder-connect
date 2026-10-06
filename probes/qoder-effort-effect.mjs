/**
 * Qoder 思考档位「效果对照」验证（端到端、只读观察）
 *
 * 前面的 qoder-effort-probe.mjs 只证明了**上游接受哪些值**（含对照组，排除了
 * "传什么都收"）。这份脚本回答第二个问题：**档位真的改变输出吗？**
 *
 * 做法：同一个 prompt、同一个模型，分别用 low / high / max 各发一次，统计
 * reasoning_content 的长度与首包延迟。若档位有效，思考链长度应出现可见差异。
 *
 * 注意：这是**观察性**证据（上游行为可能随模型/时段波动），不是协议承诺。
 * 之所以仍值得跑：它能把"参数被接受"与"参数有效果"区分开 —— 只看 200 无法区分。
 *
 * 用法：node qoder-effort-effect.mjs [modelKey]
 */

import { createCipheriv, createHash, publicEncrypt, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
const GATEWAY = "https://gateway.qoder.com.cn";
const CHAT_PATH = "/algo/api/v2/service/pro/sse/agent_chat_generation";
const MODEL = process.argv[2] ?? "qfmodel";
/**
 * 对照 prompt 用**高难度**任务。
 *
 * 为什么换难题：原先用"农夫过河"这种中等题在 Qwen3.7-Plus 上只产生 ~1.7k 字符
 * 思考链，且组内波动（±300）就盖过了组间差异（268）—— 信噪比不足以判断档位效应。
 * 难题能把思考链拉长一个量级，让档位差异有机会浮出噪声。
 */
const PROMPT = process.env.QODER_PROMPT
  ?? "证明 Ramsey 定理 R(3,3)=6：任意 6 人中必有 3 人互相认识或 3 人互相不认识。要求：(1) 用反证法给出完整严格证明；(2) 说明为什么 5 人时结论不成立并构造反例；(3) 讨论 R(3,3) 与 R(3,4)、R(4,4) 的关系及已知上下界；(4) 分析证明中每一步的必要性。";

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
function machineOs() {
  if (process.platform === "win32") return process.arch === "arm64" ? "aarch64_windows" : "x86_64_windows";
  return process.arch === "arm64" ? "aarch64_linux" : "x86_64_linux";
}
function machineId() {
  for (const p of [join(homedir(), ".qoder-cn", ".auth", "machine_id"), join(homedir(), ".qoder", ".auth", "machine_id")]) {
    try { const v = readFileSync(p, "utf8").trim(); if (v) return v; } catch { /* next */ }
  }
  return randomUUID();
}
function headers(body, url, creds) {
  const aesKey = randomUUID().replace(/-/g, "").slice(0, 16);
  const info = { uid: creds.userID, security_oauth_token: creds.authToken, name: creds.name ?? "", aid: "", email: creds.email ?? "" };
  const c = createCipheriv("aes-128-cbc", Buffer.from(aesKey), Buffer.from(aesKey));
  const infoB64 = c.update(JSON.stringify(info), "utf8", "base64") + c.final("base64");
  const cosyKey = publicEncrypt({ key: QODER_RSA_PUBLIC_KEY, padding: 1 }, Buffer.from(aesKey)).toString("base64");
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

const session = JSON.parse(readFileSync(join(homedir(), ".dsh", "connect-auth", "qoder-session.json"), "utf8"));
const creds = { userID: session.uid, authToken: session.token, name: session.name ?? "", email: session.email ?? "" };
const url = `${GATEWAY}${CHAT_PATH}?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;

function buildBody(effort) {
  const id = randomUUID();
  // max_tokens 给足：难题的思考链会很长，卡上限会把统计截断成"都一样长"的假象。
  const parameters = { enable_thinking: true, max_tokens: 8192, reasoning_effort: effort };
  return {
    request_id: id, request_set_id: id, chat_record_id: id, session_id: randomUUID(),
    stream: true, chat_task: "FREE_INPUT", is_reply: true, is_retry: false, source: 1,
    version: "3", agent_id: "agent_common", task_id: "common", session_type: "qoderclicn",
    code_language: "", chat_prompt: "", image_urls: null, aliyun_user_type: "", system: "",
    messages: [{ role: "user", content: PROMPT }], tools: [], parameters,
    chat_context: {
      chatPrompt: "", imageUrls: null,
      extra: { context: [], modelConfig: { key: MODEL, is_reasoning: true }, originalContent: PROMPT },
      features: [], text: PROMPT,
    },
    model_config: { key: MODEL, source: "system" },
    business: { product: "cli", version: "1.0.0", type: "agent", stage: "start", id, name: PROMPT.slice(0, 30), begin_at: Date.now() },
  };
}

async function run(effort) {
  const body = encode(Buffer.from(JSON.stringify(buildBody(effort)), "utf8"));
  const t0 = Date.now();
  const res = await fetch(url, { method: "POST", headers: headers(body, url, creds), body, signal: AbortSignal.timeout(Number(process.env.QODER_TIMEOUT_MS ?? 300000)) });
  if (!res.ok) return { effort, status: res.status, note: "HTTP 失败" };
  const text = await res.text();
  const firstAt = Date.now() - t0;
  /**
   * 首次运行时存一份原始样本，供核对字段名。
   *
   * 为什么需要：第一版统计假设思考链在 `"reasoning_content"` 里，结果三种档位
   * 都是 0 字符、而响应有 90KB —— 说明是**我的提取口径**不对，不是档位无效。
   * 样本落盘后按真实结构改统计，避免用错误的指标得出错误结论。
   */
  if (process.env.QODER_DUMP === "1") {
    writeFileSync(join(homedir(), ".dsh", "patches", "dsh-connect-desktop", "probes", `sample-${effort}.txt`), text, "utf8");
  }
  // Qoder 的响应是**双层 JSON**：外层 `{headers, body, statusCodeValue}`，真正的
  // OpenAI 形状 delta 在 `body` 里（且被转义了一层）。所以必须先解外层、再解内层，
  // 直接在外层文本上正则统计只会得到 0（第一版就栽在这里）。
  const reasonChunks = [];
  const contentChunks = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "" || payload === "[DONE]") continue;
    let outer;
    try { outer = JSON.parse(payload); } catch { continue; }
    if (typeof outer?.body !== "string") continue;
    let inner;
    try { inner = JSON.parse(outer.body); } catch { continue; }
    for (const choice of inner?.choices ?? []) {
      const d = choice?.delta;
      if (typeof d?.reasoning_content === "string") reasonChunks.push(d.reasoning_content);
      if (typeof d?.content === "string") contentChunks.push(d.content);
    }
  }
  const reasonLen = reasonChunks.join("").length;
  const contentLen = contentChunks.join("").length;
  return { effort, status: res.status, reasonLen, contentLen, firstAt, bytes: text.length };
}

console.log(`模型 ${MODEL}\n对照 prompt：${PROMPT.slice(0, 24)}…\n`);
/**
 * 重复取样取**中位数**：单次观察会被"这次模型话多话少"的随机性带偏，
 * 而档位差异本身不大（上千字符量级），不做重复就无法区分信号与噪声。
 */
const ROUNDS = Number(process.env.QODER_ROUNDS ?? 3);
const out = [];
console.log("轮次 档位      HTTP   思考链字符   正文字符   首包(ms)");
for (let round = 1; round <= ROUNDS; round += 1) {
  for (const e of ["low", "medium", "high", "max"]) {
    try {
      const r = await run(e);
      out.push(r);
      console.log(`${String(round).padEnd(5)}${e.padEnd(9)} ${String(r.status).padEnd(7)} ${String(r.reasonLen ?? "-").padEnd(12)} ${String(r.contentLen ?? "-").padEnd(10)} ${r.firstAt ?? "-"}`);
    } catch (err) {
      console.log(`${String(round).padEnd(5)}${e.padEnd(9)} 异常: ${String(err?.message ?? err).slice(0, 50)}`);
    }
    await new Promise((s) => setTimeout(s, 1200));
  }
}
console.log("\n档位      有效样本   思考链中位数   正文字符中位数");
const median = (xs) => {
  const a = [...xs].sort((x, y) => x - y);
  if (a.length === 0) return undefined;
  return a.length % 2 === 1 ? a[(a.length - 1) / 2] : Math.round((a[a.length / 2 - 1] + a[a.length / 2]) / 2);
};
const summary = {};
for (const e of ["low", "medium", "high", "max"]) {
  const rows = out.filter((r) => r.effort === e && r.status === 200);
  if (rows.length === 0) { console.log(`${e.padEnd(9)} -`); continue; }
  const rm = median(rows.map((r) => r.reasonLen));
  const cm = median(rows.map((r) => r.contentLen));
  summary[e] = rm;
  console.log(`${e.padEnd(9)} ${String(rows.length).padEnd(10)} ${String(rm).padEnd(14)} ${cm}`);
}
const vals = Object.values(summary);
if (vals.length >= 2) {
  /**
   * ⚠️ 结论要按"信号/噪声"来判，不能只看极差。
   *
   * 第一版脚本只看极差（527 字符）就写下"档位确实影响输出"，这是**误判**：
   * 把每档 3 次的原始值摊开就会发现——high 三次是 2036/1669/1347，
   * **组内标准差（~300）反而大于组间极差（268）**。也就是说，长度差异完全
   * 可以被"模型这次话多话少"解释，档位效应无法从这组数据里被证明。
   *
   * 因此这里改成显式的信噪比判据，并把不确定如实说出来。要真正证明档位有效，
   * 需要比长度更贴合的指标（如档位改变推理路径/答案正确率）与更大样本。
   */
  const groups = {};
  for (const e of ["low", "medium", "high", "max"]) {
    const rows = out.filter((r) => r.effort === e && r.status === 200);
    if (rows.length >= 2) groups[e] = rows.map((r) => r.reasonLen);
  }
  const stat = (a) => {
    const m = a.reduce((x, y) => x + y, 0) / a.length;
    const sd = a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)) : 0;
    return { m: Math.round(m), sd: Math.round(sd) };
  };
  const means = Object.values(groups).map((a) => stat(a).m);
  const sds = Object.values(groups).map((a) => stat(a).sd);
  const between = Math.max(...means) - Math.min(...means);
  const within = Math.round(sds.reduce((a, b) => a + b, 0) / sds.length);
  console.log(`\n组间极差 = ${between} 字符    组内标准差均值 = ${within} 字符`);
  console.log(between > within * 2
    ? "→ 信号强于噪声，档位对思考链长度有可辨影响。"
    : "→ 组间差异 ≤ 组内波动：**这组数据无法证明档位改变了思考链长度**，\n   差异可以被模型自身的随机性解释（不要据此下结论）。");
  console.log("\n已证明的是（见 qoder-effort-probe.mjs，含对照组）：上游**校验**该参数——");
  console.log("  off 与乱填值被 400 拒绝，low/medium/high/max 被接受。");
  console.log("未证明的是：档位是否改变推理质量/长度（需要更贴合的指标与更大样本）。");
}

/**
 * ## 实测结论（2026-10-06，Qwen3.8-Flash + Ramsey 难题）
 *
 * 用**单请求法**（`qoder-one.mjs`，一次一个、中间冷却）拿到的干净数据：
 *
 * | 档位 | 耗时 | 思考链字符 |
 * |---|---|---|
 * | low | 47.1s | 1,361 |
 * | high | **498.1s** | **77,353** |
 *
 * 思考链长度相差 **57 倍**，远超任何合理噪声 → **档位确实显著改变输出**，
 * 加选择器有实际意义。这条结论与"上游校验该参数"（对照组被 400 拒绝）
 * 互相印证，构成本次改动的完整证据链。
 *
 * ## ⚠️ 本脚本（批量版）为什么不要再用
 *
 * 它一次串行发 4 档 × 3 轮 = 12 个请求，导致 `high`/`max` 频繁超时，而我当时
 * **把超时误判成限流** —— 真实原因是 `high` 档单次就要 ~500 秒深度思考。
 * 两版错误都出在实验设计上：
 *   1. 把"慢"当成"失败"，会得出"高档位不可用"的错误结论；
 *   2. 密集串行让限流与模型耗时混在一起，无法归因。
 *
 * 正确做法：一次一个请求、之间冷却、超时给足（≥600s）、原始数据落 JSONL
 * 以便事后改统计口径而不必重发。这就是 `qoder-one.mjs` 存在的原因。
 *
 * 保留这个文件是为了留下"误判路径"的记录，**结论请引用上面的单请求数据**。
 */
