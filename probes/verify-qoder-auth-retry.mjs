#!/usr/bin/env node
// probes/verify-qoder-auth-retry.mjs
// 钉死 Qoder 的「凭据被拒 → 丢弃缓存 → 重试一次」。
//
// ## 事故（2026-10-08）
//
// 用户报「本轮运行失败：API 密钥无效」，但实测同一份凭据打上游成功 —— 因为
// Qoder 把 **401/403 藏在信封的 `statusCodeValue` 里，HTTP 仍是 200**。
// 而翻译层当时只给 error 事件一个 `message`，不保留 `code`，于是：
//
//   · 调用方分不出"凭据失效"与"其它业务错误" → 走不到 invalidate；
//   · 即使 HTTP 层 401，也只是 invalidate 后**直接把错误返回**给用户，
//     不重试 —— 表现为「这轮失败、下一轮又好了」，像随机故障；
//   · DSH 前端把 401/403 一律显示成 `message.failure.auth`（"API 密钥无效"），
//     所以文案与真实原因也对不上。
//
// 真实原因常常是 **jobToken 被上游轮换**：Qoder 桌面 App 重新登录后旧 token
// 立刻作废，而本机的会话快照还没更新。
//
// ## 三条必须成立的性质
//
//   1. 401（HTTP 层与信封层两种）→ invalidate + **重试一次**，用户无感；
//   2. 403 **不一定**是凭据问题：`code:110 / "Billing daily count exceeded"`
//      是当日次数超限，重试只会白花请求 —— 不得当成凭据错误；
//   3. 只重试一次（第二次仍失败说明真的没凭据）。
//
// 用法：node probes/verify-qoder-auth-retry.mjs [--installed]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SRC = process.argv.includes("--installed")
  ? path.join(os.homedir(), ".dsh", "profiles", "desktop", "node_modules", process.env.DSH_CONNECT_DIR ?? "dsh-connect")
  : REPO;

let passed = 0;
let failed = 0;
/**
 * 用例收集器 —— **必须串行**。
 *
 * 这些用例都要替换全局 `fetch`，而 `ok()` 会立刻开始执行异步函数：如果让它们
 * 并发跑，后一个用例的 `installFetch` 会在前一个还在 await 时把全局换掉，
 * 于是每个用例都读到别人的行为（调试时表现为「共 1 个行为」：拿到的是别人的）。
 * 所以这里把异步用例串成一条链，逐个 await。
 */
const pending = [];
let chain = Promise.resolve();
const ok = (label, fn) => {
  chain = chain.then(async () => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      console.error(`FAIL ${label}\n  ${e && e.message}`);
    }
  });
};

const stubDir = path.join(HERE, ".auth-retry-stubs");
fs.mkdirSync(stubDir, { recursive: true });
const stubNames = {
  "@deepseek-ai/dsh-home-paths": ["resolveDshHome"],
  "@deepseek-ai/dsh-llm": ["resolveRetryPolicy"],
  "@deepseek-ai/dsh-llm-pi-ai": ["PiAiAdapter"],
  "@earendil-works/pi-ai": ["createProvider"],
  "@earendil-works/pi-ai/api/openai-completions.lazy": ["openAICompletionsApi"],
  "@deepseek-ai/dsh-atomic-write": ["withFileLock", "writeFileAtomic"],
};
const stubMap = {};
for (const [spec, names] of Object.entries(stubNames)) {
  const file = path.join(stubDir, spec.replace(/[@/]/g, "_") + ".mjs");
  const body =
    spec === "@deepseek-ai/dsh-home-paths"
      ? `export const resolveDshHome = () => ${JSON.stringify(path.join(os.homedir(), ".dsh"))};\nexport default { resolveDshHome };\n`
      : `const mk=(n)=>{const f=function(){return f};return f};\n` + names.map((n) => `export const ${n}=mk(${JSON.stringify(n)});`).join("\n") + `\nexport default new Proxy({},{get:()=>mk("d")});\n`;
  fs.writeFileSync(file, body);
  stubMap[spec] = file;
}
const sc = path.join(os.homedir(), ".dsh", "profiles", "desktop", "node_modules", "@deepseek-ai", "schemastery", "lib", "index.mjs");
if (!fs.existsSync(sc)) {
  console.error("找不到宿主真包 @deepseek-ai/schemastery —— 本探针需要装过 dsh 桌面版的机器。");
  process.exit(2);
}
stubMap["@deepseek-ai/schemastery"] = sc;
const loaderFile = path.join(stubDir, "loader.mjs");
fs.writeFileSync(
  loaderFile,
  `import { pathToFileURL } from "node:url";\nconst map=${JSON.stringify(stubMap)};\nexport async function resolve(s,c,n){ if(map[s]) return {url:pathToFileURL(map[s]).href,shortCircuit:true,format:"module"}; return n(s,c) }\n`,
);
const { register } = await import("node:module");
register(new URL(`file://${loaderFile.replace(/\\/g, "/")}`).href, import.meta.url);

const mod = await import(pathToFileURL(path.join(SRC, "lib", "providers", "qoder", "index.js")).href);

// —— 1) 纯函数层：信封解包必须保留 code ——
const { unwrapQoderEvent } = mod;

ok("1.1: 信封里的业务错误保留 code（调用方据此判凭据问题）", () => {
  const raw = JSON.stringify({ statusCodeValue: 401, body: JSON.stringify({ message: "token expired" }) });
  const r = unwrapQoderEvent(raw);
  if (r.kind !== "error") throw new Error(`kind=${r.kind}`);
  if (r.code !== 401) throw new Error(`没有保留 code（实际 ${JSON.stringify(r.code)}）—— 调用方无法区分凭据错误`);
});

ok("1.2: 403 也保留 code", () => {
  const raw = JSON.stringify({ statusCodeValue: 403, body: JSON.stringify({ code: "110", message: "Billing daily count exceeded" }) });
  const r = unwrapQoderEvent(raw);
  if (r.code !== 403) throw new Error(`code=${r.code}`);
});

ok("1.3: EXCEED_QUOTA 哨兵带 code 429（不该被当成凭据问题）", () => {
  const r = unwrapQoderEvent("[EXCEED_QUOTA]");
  if (r.kind !== "error") throw new Error(`kind=${r.kind}`);
  if (r.code !== 429) throw new Error(`code=${r.code}`);
});

ok("1.4: 正常 200 信封仍是 chunk（不受影响）", () => {
  const inner = JSON.stringify({ choices: [{ delta: { content: "hi" } }] });
  const r = unwrapQoderEvent(JSON.stringify({ statusCodeValue: 200, body: inner }));
  if (r.kind !== "chunk") throw new Error(`kind=${r.kind}`);
});

// —— 2) 端到端：假的 fetch 驱动重试逻辑 ——
function installFetch(behaviors) {
  const real = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async () => {
    const index = Math.min(call, behaviors.length - 1);
    const behavior = behaviors[index];
    call += 1;
    if (process.env.PROBE_DEBUG) console.log(`    [fetch #${call}] 用第 ${index + 1} 个行为（共 ${behaviors.length} 个）`);
    return behavior();
  };
  return { restore: () => { globalThis.fetch = real; }, calls: () => call };
}

function httpError(status) {
  return async () => ({ ok: false, status, body: null, text: async () => `denied ${status}` });
}
function envelopeError(code, body) {
  return async () => ({
    ok: true,
    status: 200,
    body: {
      getReader() {
        let sent = false;
        return {
          async read() {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: new TextEncoder().encode(`event: message\ndata: ${JSON.stringify({ statusCodeValue: code, body: JSON.stringify(body) })}\n\n`) };
          },
          cancel() {},
        };
      },
    },
    text: async () => "",
  });
}
function okStream(text) {
  return async () => ({
    ok: true,
    status: 200,
    body: {
      getReader() {
        let sent = false;
        return {
          async read() {
            if (sent) return { done: true, value: undefined };
            sent = true;
            const inner = JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] });
            return { done: false, value: new TextEncoder().encode(`event: message\ndata: ${JSON.stringify({ statusCodeValue: 200, body: inner })}\n\n`) };
          },
          cancel() {},
        };
      },
    },
    text: async () => "",
  });
}

function makeTokens(sequence) {
  let i = 0;
  let invalidated = 0;
  return {
    tokens: {
      async get() {
        const c = sequence[Math.min(i, sequence.length - 1)];
        i += 1;
        return c;
      },
      peek: () => sequence[sequence.length - 1],
      invalidate: () => {
        invalidated += 1;
      },
    },
    getCalls: () => i,
    invalidations: () => invalidated,
  };
}

const good = { userID: "u", jobToken: "jt-good", name: "", email: "", expiresAt: Date.now() + 3600000, source: "test" };
const rotated = { userID: "u", jobToken: "jt-rotated", name: "", email: "", expiresAt: Date.now() + 3600000, source: "test" };

function clientFor(tokens) {
  return mod.createQoderClient({ tokens, config: () => ({}), logger: { info() {}, warn() {}, debug() {}, error() {} } });
}
const request = { model: "qfmodel", messages: [{ role: "user", content: "ping" }], isReasoning: false, maxTokens: 16, sessionType: "app" };

ok("2.1: HTTP 401 → invalidate + 重试一次 → 用户无感（拿到第二次的正文）", async () => {
  const f = installFetch([httpError(401), okStream("重试后的回答")]);
  const { tokens, getCalls, invalidations } = makeTokens([good, rotated]);
  try {
    const result = await clientFor(tokens).chatStream(request, AbortSignal.timeout(20000));
    if (result.ok !== true) throw new Error(`期望 ok，实际 ${JSON.stringify(result).slice(0, 160)}`);
    if (getCalls() < 2) throw new Error(`tokens.get 只被调用 ${getCalls()} 次 —— 没重试`);
    if (invalidations() < 1) throw new Error("没有 invalidate 缓存");
    const text = await new Response(result.response).text();
    if (!text.includes("重试后的回答")) throw new Error("第二次的正文没拿到");
  } finally {
    f.restore();
  }
});

ok("2.2: 信封里的 401（HTTP 200）同样触发重试", async () => {
  const f = installFetch([envelopeError(401, { message: "token expired" }), okStream("信封重试成功")]);
  const { tokens, getCalls } = makeTokens([good, rotated]);
  try {
    const result = await clientFor(tokens).chatStream(request, AbortSignal.timeout(20000));
    if (result.ok !== true) throw new Error(`期望 ok，实际 ${JSON.stringify(result).slice(0, 200)}`);
    if (getCalls() < 2) throw new Error(`tokens.get 只被调用 ${getCalls()} 次 —— 信封 401 没触发重试`);
  } finally {
    f.restore();
  }
});

ok("2.3: 403 + Billing daily count exceeded → **不重试**（重试只会白花请求）", async () => {
  const f = installFetch([envelopeError(403, { code: "110", message: "Billing daily count exceeded" })]);
  /**
   * 第二次的 token 换成**另一个**凭据，并让第二次如果真的发生就会成功 ——
   * 这样"是否重试"就能从结果上区分出来：重试了就会拿到 ok:true。
   * 第一版两次给同样的凭据且都返回同样错误，只断言调用次数，
   * 结果把 `authLike` 改成 `code===401` 时探针依然全绿（反向验证抓到的漏过）。
   */
  const { tokens, getCalls } = makeTokens([good, rotated]);
  try {
    const result = await clientFor(tokens).chatStream(request, AbortSignal.timeout(20000));
    if (result.ok !== false) throw new Error("额度错误不该成功");
    if (result.ok === true) throw new Error("额度错误竟然重试成功了");
    if (result.kind !== "upstream") throw new Error(`kind 应为 upstream，实际 ${result.kind}（auth 会误导用户去换凭据）`);
    // 关键：一次都没多打，错误原文要带到用户面前
    if (getCalls() !== 1) throw new Error(`tokens.get 被调用 ${getCalls()} 次 —— 额度错误不该重试`);
    if (!/Billing daily count exceeded/.test(String(result.message))) {
      throw new Error(`错误原文没带到用户面前：${String(result.message).slice(0, 160)}`);
    }
  } finally {
    f.restore();
  }
});

ok("2.4: 403 + 明确的凭据失效文案 → 仍然重试", async () => {
  const f = installFetch([envelopeError(403, { message: "invalid token" }), okStream("凭据重试成功")]);
  const { tokens, getCalls } = makeTokens([good, rotated]);
  try {
    const result = await clientFor(tokens).chatStream(request, AbortSignal.timeout(20000));
    if (result.ok !== true) throw new Error(`期望 ok，实际 ${JSON.stringify(result).slice(0, 200)}`);
    if (getCalls() < 2) throw new Error("凭据失效的 403 没触发重试");
  } finally {
    f.restore();
  }
});

ok("2.5: 连续两次失败就停（只重试一次，不无限重试）", async () => {
  const f = installFetch([httpError(401)]);
  const { tokens, getCalls } = makeTokens([good]);
  try {
    const result = await clientFor(tokens).chatStream(request, AbortSignal.timeout(20000));
    if (result.ok !== false) throw new Error("期望失败");
    if (getCalls() > 2) throw new Error(`打了 ${getCalls()} 次 —— 应最多两次`);
  } finally {
    f.restore();
  }
});

ok("2.6: 非凭据类业务错误（500）不重试", async () => {
  const f = installFetch([envelopeError(500, { message: "internal error" })]);
  const { tokens, getCalls } = makeTokens([good, rotated]);
  try {
    const result = await clientFor(tokens).chatStream(request, AbortSignal.timeout(20000));
    if (result.ok !== false) throw new Error("期望失败");
    if (getCalls() !== 1) throw new Error(`打了 ${getCalls()} 次 —— 500 不该重试`);
  } finally {
    f.restore();
  }
});

ok("2.7: 交叉文案 —— 「billing limit reached, token quota exceeded」不误判成凭据失效", async () => {
  // 这条专门钉住 isCredentialRejection 里"额度语义优先否决"的那段守卫：
  // 该文案同时含 billing/quota 与 token，单看后者会被当成凭据失效 → 无谓重试。
  // 守卫被删掉时，下面的 getCalls 断言就会失败（反向验证抓到的漏过）。
  const f = installFetch([envelopeError(403, { message: "billing limit reached, token quota exceeded" })]);
  const { tokens, getCalls } = makeTokens([good, rotated]);
  try {
    const result = await clientFor(tokens).chatStream(request, AbortSignal.timeout(20000));
    if (result.ok !== false) throw new Error("期望失败");
    if (getCalls() !== 1) throw new Error(`打了 ${getCalls()} 次 —— 含额度语义的 403 不该被当成凭据问题`);
    if (result.kind !== "upstream") throw new Error(`kind 应为 upstream，实际 ${result.kind}`);
  } finally {
    f.restore();
  }
});

fs.rmSync(stubDir, { recursive: true, force: true });
// 等所有用例跑完再统计（漏了这一行，"全绿"就是假的）。
await chain;
console.log(`\nverify-qoder-auth-retry: ${passed} 通过 / ${failed} 失败  [src=${SRC}]`);
process.exitCode = failed ? 1 : 0;