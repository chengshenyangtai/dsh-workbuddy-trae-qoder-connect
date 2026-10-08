#!/usr/bin/env node
// probes/verify-trae-parser-handoff.mjs
// 钉死 2026-10-08 修的**两处 Trae 侧缺陷**（都是"静默丢内容"型）：
//
//  A. **首事件预读后的 parser 交接**（事故链的真正源头）
//     `chatStream` 先建 parser A 读首个事件，随后 `translate` 又 `createSseReader()`
//     建了 parser B。parser A 里残留的**半截事件**（TCP 分片正好切在事件中间）与
//     TextDecoder 里不完整的多字节序列被永久丢弃。
//     丢掉的很可能是**带 id/name 的头部片** → 剩下的参数分片变成"无名调用" →
//     宿主按未知工具记进历史 → 对空名严格的模型（deepseek 系）此后每一轮
//     400/11133。done 一起丢时，真实 finish_reason 还会被兜底改写成 stop。
//
//  B. **未闭合残片规则的误伤**
//     旧实现 `/<seed:[^>]*>[\s\S]*$/` 是"从标记删到片尾"，而本函数按内容分片调用，
//     于是任何**提到**该标记的正常正文都会被截断（`The tag <seed:tool_call> is
//     emitted by GLM.` → `The tag `）。现在只在该标记后面**紧跟调用内容**时才删。
//
// 两项都用**行为**断言（不是读源码字符串），并各自做反向验证。
//
// 用法：node probes/verify-trae-parser-handoff.mjs [--installed]

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

// —— 加载真实模块（真 schemastery + 桩宿主包），与其它 trae 探针同构 ——
const stubDir = path.join(HERE, ".handoff-stubs");
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

const mod = await import(pathToFileURL(path.join(SRC, "lib", "providers", "trae", "index.js")).href);
const { createSseReader, sanitizeAgentResidue } = mod;
if (typeof createSseReader !== "function") throw new Error("没有导出 createSseReader");

// ============ A. parser 的残片与收尾 ============

ok("A1: 同一 parser 跨多次 push 能拼出被 TCP 切开的事件", () => {
  const p = createSseReader();
  const head = 'event: output\ndata: {"response":"中';
  const tail = '文"}\n\n';
  eq(p.push(Buffer.from(head, "utf8")), [], "半截字符不该产出事件");
  const out = p.push(Buffer.from(tail, "utf8"));
  eq(out.length, 1, "事件数");
  eq(out[0].data, { response: "中文" }, "跨 push 的多字节内容");
});

ok("A2: **end() 能把没有尾随空行的最后一个事件吐出来**（旧实现会永久丢掉）", () => {
  const p = createSseReader();
  eq(p.push(Buffer.from('event: output\ndata: {"response":"AAA"}', "utf8")), [], "缺尾随空行时 push 不该吐");
  const tail = p.end();
  eq(tail.length, 1, "end() 应补出 1 个事件");
  eq(tail[0].data, { response: "AAA" }, "补出的事件内容");
});

ok("A3: end() 之后不会重复吐同一事件（幂等）", () => {
  const p = createSseReader();
  p.push(Buffer.from('event: output\ndata: {"response":"AAA"}\n\n', "utf8"));
  eq(p.end().length, 0, "已闭合的事件不该再吐一次");
  eq(p.end().length, 0, "再次调用仍应为空");
});

ok("A4: 完整流（含 done）走 push 即可，end() 不产生多余事件", () => {
  const p = createSseReader();
  const out = p.push(Buffer.from('event: output\ndata: {"response":"hi"}\n\nevent: done\ndata: {"finish_reason":"stop"}\n\n', "utf8"));
  eq(out.length, 2, "事件数");
  eq(out[1].event, "done", "第二个事件");
  eq(p.end().length, 0, "end() 不该再补出东西");
});

// ============ B. 残片规则的误伤 ============

ok("B1: 真实的未闭合残片仍被清除（后面紧跟调用内容）", () => {
  const out = sanitizeAgentResidue('前半句。<seed:tool_call><function name="bash">', false);
  if (out.includes("seed:")) throw new Error(`残片未清除：${out}`);
  if (!out.startsWith("前半句。")) throw new Error(`前半句被误删：${out}`);
});

ok("B2: **正常行文提到该标记时不再截断后半句**（旧实现会删到片尾）", () => {
  const input = "The tag <seed:tool_call> is emitted by GLM models. That is all.";
  const out = sanitizeAgentResidue(input, false);
  eq(out, input, "提到标记的正常正文");
});

ok("B3: 代码块里的成对标记仍按成对规则处理（不误伤围栏文本）", () => {
  const out = sanitizeAgentResidue('You can write <seed:tool_call> in Trae.', false);
  eq(out, "You can write <seed:tool_call> in Trae.", "行文提到标记");
});

ok("B4: 成对标记仍然被清除", () => {
  const out = sanitizeAgentResidue('看下：<seed:tool_call><function name="bash"></function></seed:tool_call>', false);
  if (out.includes("seed:")) throw new Error(`成对标记未清除：${out}`);
});

ok("B5: 发了 tools 时一律不清洗", () => {
  const input = '<seed:tool_call><function name="bash"></function></seed:tool_call>';
  eq(sanitizeAgentResidue(input, true), input, "toolsSent=true 不该清洗");
});

ok("B6: **句中分片不删「行首前缀」**（leading=false 时保留）", () => {
  // 上游把一句切成两片，第二片以 "user says:" 开头 —— 它在原文里是句中
  const first = sanitizeAgentResidue("Sure. The ", false, true);
  const second = sanitizeAgentResidue("user says: hello was printed.", false, false);
  eq(first + second, "Sure. The user says: hello was printed.", "两片拼接");
});

ok("B7: 真正的行首复述前缀（首片）仍然被清除", () => {
  const out = sanitizeAgentResidue("The user says: 看下目录", false, true);
  if (/user says/i.test(out)) throw new Error(`首片前缀未清除：${out}`);
});

fs.rmSync(stubDir, { recursive: true, force: true });
await chain;
console.log(`\nverify-trae-parser-handoff: ${passed} 通过 / ${failed} 失败  [src=${SRC}]`);
process.exitCode = failed ? 1 : 0;
