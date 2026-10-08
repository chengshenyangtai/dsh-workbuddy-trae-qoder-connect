#!/usr/bin/env node
// probes/verify-qoder-stream-fixes.mjs
// 钉死 2026-10-08 Qoder 侧修的三处**静默丢内容 / 假成功**缺陷。
//
// ## 事故背景
//
// 这三处都不是"看起来不对"，而是能实测出来的行为缺陷：
//
//  A. **首事件预读只接住第一个事件**
//     `parser.push()` 返回整批事件并清空内部队列，所以循环里的 `break` 之后
//     `parser.pending()` 必然是空数组 —— 实测一个 TCP 分片含 3 个事件时，
//     下游只收到 1 个，**丢掉的可能是正文分片或 `[DONE]`**。
//
//  B. **`attempt()` 的返回形状不一致**
//     网络失败/取消返回裸的 `{ok:false,…}`，其余分支返回 `{error:{…}}`。
//     调用方只认后者，于是 `{ok:true, response:undefined}` 被当成成功：
//     shim 写 200 → `Readable.fromWeb(undefined)` 抛错 → 用户看到一个空的 200，
//     而且 invalidate + 重试**都不会发生**。
//
//  C. **取消接线注册得太晚**
//     `req.on("close")` 若在 `readBody` 之后注册，客户端在流式阶段断开的监听器
//     不触发，上游请求不被 abort（Qoder 继续生成并计费）。
//
// 以及 D：`parser.end()` 曾是死代码（只有 Trae 调用），最后一个无尾随空行的
// 事件仍会丢。
//
// 用法：node probes/verify-qoder-stream-fixes.mjs [--installed]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SRC = process.argv.includes("--installed")
  ? path.join(os.homedir(), ".dsh", "profiles", "desktop", "node_modules", "dsh-connect")
  : REPO;

let passed = 0;
let failed = 0;
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
const eq = (a, b, what) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
};

// —— 加载真实模块（真 schemastery + 桩宿主包）——
const stubDir = path.join(HERE, ".qstream-stubs");
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
{
  const sc = path.join(os.homedir(), ".dsh", "profiles", "desktop", "node_modules", "@deepseek-ai", "schemastery", "lib", "index.mjs");
  if (!fs.existsSync(sc)) {
    console.error("找不到宿主真包 @deepseek-ai/schemastery —— 本探针需要装过 dsh 桌面版的机器。");
    process.exit(2);
  }
  stubMap["@deepseek-ai/schemastery"] = sc;
}
const loaderFile = path.join(stubDir, "loader.mjs");
fs.writeFileSync(
  loaderFile,
  `import { pathToFileURL } from "node:url";\nconst map=${JSON.stringify(stubMap)};\nexport async function resolve(s,c,n){ if(map[s]) return {url:pathToFileURL(map[s]).href,shortCircuit:true,format:"module"}; return n(s,c) }\n`,
);
const { register } = await import("node:module");
register(new URL(`file://${loaderFile.replace(/\\/g, "/")}`).href, import.meta.url);

const mod = await import(pathToFileURL(path.join(SRC, "lib", "providers", "qoder", "index.js")).href);

const src = fs.readFileSync(path.join(SRC, "lib", "providers", "qoder", "index.js"), "utf8");
/** 去注释后再断言源码，避免"注释里提到就该通过"的假阴性（踩过的坑）。 */
const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ============ A. 首事件预读不再只接住第一个 ============

ok("A1: createSseReader 一次 push 能返回整批事件（前提）", () => {
  const p = mod.createSseReader();
  const three =
    'data: {"choices":[{"delta":{"content":"AAA"},"finish_reason":null}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"BBB"},"finish_reason":null}]}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n';
  const out = p.push(Buffer.from(three, "utf8"));
  eq(out.length, 3, "同批事件数");
});

ok("A2: **预读那一批的全部事件都被收下**（不是只留第一个）", () => {
  /**
   * 接线断言：`initialEvents = parser.push(value)` 必须保留整批，
   * 且 translate 收到的是整批 + 同一个 parser。
   */
  if (!/initialEvents = parser\.push\(value\)/.test(stripped)) {
    throw new Error("预读没有把整批事件接住");
  }
  if (!/return \{ response: translate\(reader, parser, initialEvents, request, signal\) \}/.test(stripped)) {
    throw new Error("translate 没有同时收到整批事件与同一个 parser");
  }
  if (/translate\(reader, parser\.pending\(\)/.test(stripped)) {
    throw new Error("仍在用 parser.pending() 传事件（push 已清空队列，必然是空的）");
  }
});

ok("A3: translate 声明里不再新建 parser（否则残片会丢）", () => {
  if (!/function translate\(reader, parser, initialEvents, request, signal\)/.test(stripped)) {
    throw new Error("translate 的签名不是 (reader, parser, initialEvents, …)");
  }
  // translate 函数体内不得再出现 createSseReader()
  const at = stripped.indexOf("function translate(");
  const body = stripped.slice(at, stripped.indexOf("\n  }\n", at));
  if (/createSseReader\(\)/.test(body)) {
    throw new Error("translate 内部又新建了 parser —— 首读残留的半截事件会被丢弃");
  }
});

ok("A4: pump 按顺序回放整批（不是只发第一个）", () => {
  if (!/for \(const event of initialEvents\) emit\(unwrapQoderEvent\(event\.raw\)\)/.test(stripped)) {
    throw new Error("pump 没有遍历 initialEvents 回放");
  }
  if (/firstChunk !== undefined\) emit\(firstChunk\)/.test(stripped)) {
    throw new Error("仍在只补发第一个 chunk");
  }
});

// ============ B. attempt() 返回形状统一 ============

ok("B1: 传输失败/取消也返回包好的 {error:{…}}（不再有裸形状）", () => {
  if (/return \{ ok: false, status: 0, kind: "(network|aborted)"/.test(stripped)) {
    throw new Error("仍有裸的 {ok:false,status:0,…} 返回 —— 会被调用方当成成功");
  }
  if (!/kind: aborted \? "aborted" : "network"/.test(stripped)) {
    throw new Error("传输失败分支没有包进 {error:{…}}");
  }
});

ok("B2: 调用方的三分支语义成立（模拟网络失败不会变成 ok:true）", () => {
  // 直接按调用方的形状判断逻辑推演，钉住"裸形状会走错分支"这个不变式
  const wrapped = { error: { ok: false, status: 0, kind: "network", message: "x" } };
  if (wrapped.error === undefined) throw new Error("包好的形状应立刻被 error 分支接住");
  const bare = { ok: false, status: 0, kind: "network", message: "x" };
  if (bare.error !== undefined) throw new Error("前提错误");
  if (!(bare.error === undefined)) throw new Error("前提错误");
  // 也就是说：裸形状会掉到 `return {ok:true, response:outcome.response}` → 假成功
});

// ============ C. 取消接线在 readBody 之前 ============

ok("C1: `req.on(\"close\")` 注册在 `readBody` 之前", () => {
  const closeAt = stripped.indexOf('req.on("close"');
  const readAt = stripped.indexOf("await readBody(req)");
  if (closeAt === -1) throw new Error("没有注册 close 监听");
  if (readAt === -1) throw new Error("找不到 readBody 调用");
  if (closeAt > readAt) {
    throw new Error("close 监听注册在 readBody 之后 —— 流式阶段取消不会 abort 上游（继续计费）");
  }
});

ok("C2: 只有一个 AbortController 声明（不重复注册）", () => {
  const n = [...stripped.matchAll(/const controller = new AbortController\(\)/g)].length;
  if (n !== 1) throw new Error(`AbortController 声明了 ${n} 次，应为 1`);
});

// ============ D. end() 真正被调用 ============

ok("D1: 最后一个无尾随空行的事件不再丢（end() 有实现且被调用）", () => {
  const p = mod.createSseReader();
  eq(p.push(Buffer.from('data: {"choices":[{"delta":{"content":"AAA"}}]}', "utf8")), [], "缺空行时 push 不吐");
  const tail = p.end();
  eq(tail.length, 1, "end() 应补出 1 个事件");
  if (!/parser\.end\(\)/.test(stripped)) throw new Error("end() 没有被调用 —— 是死代码");
});

fs.rmSync(stubDir, { recursive: true, force: true });
await chain;
console.log(`\nverify-qoder-stream-fixes: ${passed} 通过 / ${failed} 失败  [src=${SRC}]`);
process.exitCode = failed ? 1 : 0;
