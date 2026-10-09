#!/usr/bin/env node
/**
 * 钉死 2026-10-09 的「Qoder 每轮对话都 499 客户端已取消」根因。
 *
 * ## 事故
 *
 * Qoder 桌面端一切正常，DSH 里用 qoder 模型对话却**必现**报错：shim 回
 * 499 `qoder upstream (http 0): 客户端已取消`。
 *
 * ## 根因
 *
 * 三个回环 shim 都曾用 `req.on("close", () => controller.abort())` 取消上游。
 * 但 Node ≥16 的 `IncomingMessage` 在**请求体读完**时就 emit `'close'`
 * （语义是"消息已完成"，不是"连接断了"）：
 *   · Qoder 把监听注册在 readBody **之前** → 请求体一读完就 abort → 每次都 499；
 *   · trae / workbuddy 注册在 readBody **之后** → 'close' 已触发过 → 永远不响
 *     （用户中途取消，上游仍在生成、继续计费）。
 * 正确判据是 `ServerResponse` 的 `'close'` 并用 `writableEnded` 区分正常收尾 /
 * 真断开（shared/http.js 的 abortOnClientDisconnect）。
 *
 * 本探针**真实起一个 http 服务**跑两种情形（不打上游、不花额度），
 * 再断言三个 provider 的 shim 都接了这条线、且没有残留 req.on("close")。
 *
 * 用法：node probes/verify-shim-cancel-wiring.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

let passed = 0;
let failed = 0;
const ok = async (label, fn) => {
  try { await fn(); passed += 1; console.log(`  ✓ ${label}`); }
  catch (e) { failed += 1; console.error(`  ✗ ${label}\n      ${e?.message ?? e}`); }
};
const assert = (cond, message) => { if (!cond) throw new Error(message); };

const { abortOnClientDisconnect } = await import(
  pathToFileURL(path.join(REPO, "lib", "shared", "http.js")).href
);

/** 起一个用了 abortOnClientDisconnect 的最小 SSE 服务。 */
function startServer() {
  const seen = { abortedDuringBody: false, abortedAfterDone: false };
  const server = createServer(async (req, res) => {
    const controller = new AbortController();
    abortOnClientDisconnect(res, controller);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.abortedDuringBody = controller.signal.aborted;
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (let i = 0; i < 20; i += 1) {
      if (controller.signal.aborted) break;
      res.write(`data: chunk-${i}\n\n`);
      await new Promise((r) => setTimeout(r, 60));
    }
    if (!res.writableEnded) { try { res.end("data: [DONE]\n\n"); } catch { /* 已断 */ } }
    seen.abortedAfterDone = controller.signal.aborted;
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, seen }));
  });
}

const post = (url, signal) => fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "m", messages: [] }),
  ...(signal === undefined ? {} : { signal }),
});

await ok("正常请求：请求体读完 / 响应完成时都**不** abort（Qoder 不再 499）", async () => {
  const { server, url, seen } = await startServer();
  const res = await post(url);
  assert(res.status === 200, `期望 200，实际 ${res.status}`);
  await res.text();
  await new Promise((r) => setTimeout(r, 300));
  assert(seen.abortedDuringBody === false, "请求体读完时就被 abort（499 复现）");
  assert(seen.abortedAfterDone === false, "正常完成后仍被 abort");
  await new Promise((r) => server.close(r));
});

await ok("中途断开：**会** abort 上游（不再继续生成/计费）", async () => {
  const { server, url } = await startServer();
  const ac = new AbortController();
  const res = await post(url, ac.signal);
  let n = 0;
  try {
    for await (const _ of res.body) {
      n += 1;
      if (n === 3) { ac.abort(); break; }
    }
  } catch { /* 客户端取消，预期 */ }
  // 等服务端循环感知到 abort 并跳出
  await new Promise((r) => setTimeout(r, 300));
  assert(n === 3, `应在第 3 块取消，实际读了 ${n} 块`);
  await new Promise((r) => server.close(r));
});

// —— 源码契约：三个 shim 都接这条线，且没有残留 req.on("close") ——
const read = (rel) => {
  const p = rel.startsWith(os.homedir())
    ? rel
    : path.join(REPO, rel);
  return fs.readFileSync(p, "utf8");
};
const SRC = process.argv.includes("--installed")
  ? path.join(os.homedir(), ".dsh", "profiles", "desktop", "node_modules", process.env.DSH_CONNECT_DIR ?? "dsh-workbuddy-trae-qoder-connect")
  : REPO;

for (const rel of ["lib/providers/qoder/index.js", "lib/providers/trae/index.js", "lib/providers/workbuddy/index.js"]) {
  await ok(`${rel}：abortOnClientDisconnect 接线存在、无 req.on("close") 残留`, () => {
    const src = read(path.join(SRC, rel));
    assert(/abortOnClientDisconnect\(res,\s*controller\)/.test(src), `${rel} 没有调用 abortOnClientDisconnect`);
    assert(!/req\.on\(\s*["']close["']/.test(src), `${rel} 仍残留 req.on("close")`);
  });
}

console.log(`\nverify-shim-cancel-wiring: ${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
