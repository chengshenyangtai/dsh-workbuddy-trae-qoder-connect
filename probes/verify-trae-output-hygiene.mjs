#!/usr/bin/env node
// probes/verify-trae-output-hygiene.mjs
// 钉死两件「静默失败」的事故，它们都会让用户看到"莫名其妙"的输出：
//
//   A. **agent 模板泄漏**：本轮没发 tools 时，模型按 Trae agent 模板自编
//      工具标记或复述前缀，**整段落进正文**（实测会看到
//      `<seed:tool_call>…` 或开头的 `The user says: '`）。
//      修法：SSE 翻译层在"没发 tools"时清洗正文。
//
//   B. **中途截断无声消失**：上游断流时只补 `[DONE]`，既无 finish_reason
//      也无任何正文 → 下游看到"说一半就没了"，没有可诊断的信息。
//      修法：补错误正文 + finish_reason:"error"；另有 error 事件的提示
//      在"没有 done"时补出来。
//
// 用法：node probes/verify-trae-output-hygiene.mjs [--installed]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SRC = process.argv.includes("--installed")
  ? path.join(os.homedir(), ".dsh", "profiles", "desktop", "node_modules", process.env.DSH_CONNECT_DIR ?? "dsh-connect")
  : REPO;

/**
 * 断言收集器 —— **必须 await，且必须串行**。
 *
 * ## 这个 await 是踩出来的（2026-10-08）
 *
 * 第一版写成 `fn()` 不 await，于是**所有异步用例的失败都变成了未处理的
 * promise rejection**：`try/catch` 抓不到，测试永远显示"全绿"。反向验证时
 * 发现删掉修复后探针**依然全过** —— 假阴性。
 *
 * 用例本身也差点是假的：原本用 `res.destroy()` 制造断流，但那会让 reader
 * 正常收到 `done`，走的是"上游没给 done 的兜底路径"，**catch 根本没进**，
 * 于是测的并不是想测的分支。现在 B1 构造一个**下一次 read 必定抛错**的
 * reader（直接替换全局 fetch），走的就是真实的 catch 路径。
 *
 * 串行的原因同上：这些用例共享全局 `fetch` 与端口，并发会互相串味。
 */
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

// —— 加载真实模块（真 schemastery + 桩宿主包）——
const stubDir = path.join(HERE, ".hygiene-stubs");
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
map_real_schemastery: {
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
const { sanitizeAgentResidue, createTraeClient } = mod;

// ============ A. agent 模板泄漏：纯函数层 ============

ok("A1: 删掉 <seed:tool_call>…</seed:tool_call> 整段（没发 tools 时）", () => {
  const input = '前面的正文。<seed:tool_call><function name="bash"><parameter name="command">ls</parameter></function></seed:tool_call>后面的正文。';
  const out = sanitizeAgentResidue(input, false);
  if (out.includes("seed:tool_call")) throw new Error(`未清除：${out}`);
  if (!out.includes("前面的正文。")) throw new Error("误删了正常正文");
  if (!out.includes("后面的正文。")) throw new Error("误删了正常正文");
});

ok("A2: 删掉 <|FunctionCallBegin|>…<|FunctionCallEnd|>（没发 tools 时）", () => {
  const input = '<|FunctionCallBegin|>[{"name":"get_weather","parameters":{"city":"北京"}}]<|FunctionCallEnd|>答案在这里。';
  const out = sanitizeAgentResidue(input, false);
  if (out.includes("FunctionCall")) throw new Error(`未清除：${out}`);
  if (!out.includes("答案在这里。")) throw new Error("误删了正文");
});

ok("A3: 删掉行首复述前缀 The user says: '", () => {
  const out = sanitizeAgentResidue("The user says: '看下目录里有什么' 我这就回答。", false);
  if (/^\s*The user says/i.test(out)) throw new Error(`前缀未清除：${out}`);
  if (!out.includes("我这就回答。")) throw new Error("误删了正文");
});

ok("A4: 行首中文复述前缀也被清除", () => {
  const out = sanitizeAgentResidue("用户说：帮我看下配置", false);
  if (/^\s*用户说/.test(out)) throw new Error(`未清除：${out}`);
});

ok("A5: **发了 tools 时不清洗**（有结构化通道，正文里的内容是真内容）", () => {
  const input = '<seed:tool_call><function name="bash"></function></seed:tool_call>';
  const out = sanitizeAgentResidue(input, true);
  if (out !== input) throw new Error("发了 tools 却仍然清洗 —— 会掩盖真问题");
});

ok("A6: 正文中间正常提到这些词时**不被误伤**", () => {
  const input = "简单说，tool_call 是一种协议，seed:tool_call 是某家模型的私有标记。";
  const out = sanitizeAgentResidue(input, false);
  if (!out.includes("tool_call 是一种协议")) throw new Error(`误删：${out}`);
  if (!out.includes("私有标记")) throw new Error("误删");
});

ok("A7: 未闭合的残片（流被截断时只收到半个标记）也能清除", () => {
  const out = sanitizeAgentResidue("前半句。<seed:tool_call><function name=\"bash\">", false);
  if (out.includes("seed:")) throw new Error(`未清除残片：${out}`);
});

// ============ B. 中途截断：端到端（假上游）============

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function withFakeUpstream(handler, fn) {
  const port = 41000 + Math.floor(Math.random() * 900);
  let capturedRequest;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      capturedRequest = JSON.parse(body);
      handler(res);
    });
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  try {
    return await fn({ port, capturedRequest: () => capturedRequest });
  } finally {
    server.close();
  }
}

const client = createTraeClient({ logger: { warn() {}, info() {} } });
function cred(port) {
  return { token: "t", appId: "a", appVersionCode: 1, gateway: `http://127.0.0.1:${port}`, product: { functions: ["solo_agent"], reqSource: 1 } };
}
async function streamChunks(result) {
  const text = await new Response(result.response).text();
  return text
    .split("\n\n")
    .filter((b) => b.startsWith("data: ") && !b.includes("[DONE]"))
    .map((b) => JSON.parse(b.slice(6)));
}

/**
 * 造一个"发了一部分就抛错"的流 —— **确定性地**触发翻译层的 catch 分支。
 *
 * ## 为什么不用真 socket 断流（踩出来的教训）
 *
 * 第一版用 `res.destroy()`：那会让 reader 正常收到 `done: true`，于是走的是
 * 「上游没给 done 的兜底收尾」，**catch 根本没进** —— 测试看着通过，测的却是
 * 另一条分支。删掉 catch 里的提示它照样全绿。
 *
 * 现在改成：先让上游正常发第一个 output 事件（触发 chatStream 的首事件预读），
 * 然后把 `response.body` 换成一个**下一次 read 必定抛错**的流。这样
 * `pump()` 里的 `await reader.read()` 一定抛，走的就是真实的 catch 路径。
 */
function makeUpstreamThatThrowsAfterFirstEvent() {
  const encoder = new TextEncoder();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    let reads = 0;
    return {
      ok: true,
      status: 200,
      body: {
        getReader() {
          return {
            async read() {
              reads += 1;
              if (reads === 1) {
                return {
                  done: false,
                  value: encoder.encode(sse("output", { response: "模型说到一半…" })),
                };
              }
              throw new Error("upstream reset by peer");
            },
            cancel() {},
          };
        },
      },
      text: async () => "",
    };
  };
  return () => {
    globalThis.fetch = realFetch;
  };
}

ok("B1: 上游 read 抛错时，输出里出现可见的中断说明（不再无声消失）", async () => {
  const restore = makeUpstreamThatThrowsAfterFirstEvent();
  try {
    const result = await client.chatStream(
      { token: "t", appId: "a", appVersionCode: 1, gateway: "http://127.0.0.1:1", product: { functions: ["solo_agent"], reqSource: 1 } },
      { model: "m", function: "solo_agent", messages: [{ role: "user", content: "hi" }] },
      AbortSignal.timeout(20000),
    );
    if (result.ok !== true) throw new Error(`期望 ok（已下发内容应保留），实际 ${JSON.stringify(result).slice(0, 150)}`);
    const chunks = await streamChunks(result);
    const content = chunks.map((c) => c.choices[0].delta.content ?? "").join("");
    const finals = chunks.filter((c) => c.choices[0].finish_reason !== null);
    if (!/上游中断/.test(content)) {
      throw new Error(`没有中断说明，正文=${JSON.stringify(content.slice(0, 140))} finish=${JSON.stringify(finals.map((f) => f.choices[0].finish_reason))}`);
    }
    if (finals.length === 0) throw new Error("没有 finish_reason —— 下游无法判断这轮异常");
    if (finals[finals.length - 1].choices[0].finish_reason !== "error") {
      throw new Error(`finish_reason 应为 error，实际 ${finals[finals.length - 1].choices[0].finish_reason}`);
    }
    if (!content.includes("模型说到一半")) throw new Error("已下发正文被吞了");
  } finally {
    restore();
  }
});

ok("B2: 中断时已下发的正文不丢失", async () => {
  await withFakeUpstream(
    (res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(sse("output", { response: "重要结论：已经说出来的内容。" }));
      setTimeout(() => res.destroy(), 10);
    },
    async ({ port }) => {
      const result = await client.chatStream(cred(port), { model: "m", function: "solo_agent", messages: [{ role: "user", content: "hi" }] }, AbortSignal.timeout(20000));
      const chunks = await streamChunks(result);
      const content = chunks.map((c) => c.choices[0].delta.content ?? "").join("");
      if (!content.includes("已经说出来的内容")) throw new Error("已下发正文被吞了");
    },
  );
});

ok("B3: 正常 done 时 finish_reason 仍是 stop（不要被新逻辑污染）", async () => {
  await withFakeUpstream(
    (res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(sse("output", { response: "正常回答。" }));
      res.write(sse("done", { finish_reason: "stop" }));
      res.end();
    },
    async ({ port }) => {
      const result = await client.chatStream(cred(port), { model: "m", function: "solo_agent", messages: [{ role: "user", content: "hi" }] }, AbortSignal.timeout(20000));
      const chunks = await streamChunks(result);
      const content = chunks.map((c) => c.choices[0].delta.content ?? "").join("");
      const finals = chunks.filter((c) => c.choices[0].finish_reason !== null);
      if (content !== "正常回答。") throw new Error(`正文被误改：${JSON.stringify(content)}`);
      if (finals.length !== 1 || finals[0].choices[0].finish_reason !== "stop") {
        throw new Error(`finish_reason 不对：${JSON.stringify(finals.map((f) => f.choices[0].finish_reason))}`);
      }
    },
  );
});

ok("B4: 上游发 error 事件、随后**没有 done 就结束**（正常收尾而非抛错）时，兜底提示必须补出上游错误原因", async () => {
  await withFakeUpstream(
    (res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(sse("output", { response: "开头说一点。" }));
      res.write(sse("error", { message: "quota exceeded" }));
      // 正常收尾但**不发 done**：走 `!finished` 兜底分支，不是 catch。
      res.end();
    },
    async ({ port }) => {
      const result = await client.chatStream(cred(port), { model: "m", function: "solo_agent", messages: [{ role: "user", content: "hi" }] }, AbortSignal.timeout(20000));
      const chunks = await streamChunks(result);
      const content = chunks.map((c) => c.choices[0].delta.content ?? "").join("");
      const finals = chunks.filter((c) => c.choices[0].finish_reason !== null);
      if (finals.length === 0) throw new Error("缺少 finish_reason");
      /**
       * 关键断言：必须出现**兜底那条**（`[Trae 提示]`）。
       *
       * error 事件自己也会发一条 `[Trae 错误] …`，所以只断言 /Trae/ 或
       * /quota exceeded/ 都会假通过 —— 反向验证时正是如此：把
       * `lastErrorHint = message` 删掉，探针依然全绿（它匹配到的是另一条）。
       * 这里区分两者的前缀，只认 `[Trae 提示]`。
       */
      if (!/\[Trae 提示\]/.test(content)) {
        throw new Error(`兜底提示没出现（lastErrorHint 未生效），正文=${JSON.stringify(content.slice(0, 220))}`);
      }
      if (!/quota exceeded/.test(content)) {
        throw new Error(`兜底提示没带出上游原因：${JSON.stringify(content.slice(0, 220))}`);
      }
    },
  );
});

// ============ C. 端到端：agent 模板泄漏是否真的被清洗掉 ============
ok("C1: 上游正文里的 <seed:tool_call> 在「没发 tools」时被清掉", async () => {
  await withFakeUpstream(
    (res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(sse("output", { response: '好的。<seed:tool_call><function name="bash"><parameter name="command">ls</parameter></function></seed:tool_call>' }));
      res.write(sse("done", { finish_reason: "stop" }));
      res.end();
    },
    async ({ port }) => {
      const result = await client.chatStream(cred(port), { model: "m", function: "solo_agent", messages: [{ role: "user", content: "hi" }] }, AbortSignal.timeout(20000));
      const chunks = await streamChunks(result);
      const content = chunks.map((c) => c.choices[0].delta.content ?? "").join("");
      if (content.includes("seed:")) throw new Error(`泄漏仍在：${JSON.stringify(content)}`);
      if (!content.includes("好的。")) throw new Error("正常正文被误删");
    },
  );
});

ok("C2: 发了 tools 时同样内容**保留**（真内容不该被删）", async () => {
  await withFakeUpstream(
    (res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(sse("output", { response: '这里提到 <seed:tool_call> 只是解释。' }));
      res.write(sse("done", { finish_reason: "stop" }));
      res.end();
    },
    async ({ port }) => {
      const result = await client.chatStream(
        cred(port),
        {
          model: "m",
          function: "solo_agent",
          messages: [{ role: "user", content: "hi" }],
          tools: mod.toTraeTools([{ type: "function", function: { name: "pwsh", parameters: { type: "object" } } }]),
          toolChoice: "auto",
        },
        AbortSignal.timeout(20000),
      );
      const captured = result.__captured;
      const chunks = await streamChunks(result);
      const content = chunks.map((c) => c.choices[0].delta.content ?? "").join("");
      if (!content.includes("只是解释")) throw new Error(`发了 tools 却仍被清洗：${JSON.stringify(content)}`);
    },
  );
});

ok("C3: 上游请求确实带了 tools（清洗开关的前提）", async () => {
  await withFakeUpstream(
    (res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(sse("output", { response: "x" }));
      res.write(sse("done", { finish_reason: "stop" }));
      res.end();
    },
    async ({ port, capturedRequest }) => {
      await client.chatStream(
        cred(port),
        {
          model: "m",
          function: "solo_agent",
          messages: [{ role: "user", content: "hi" }],
          tools: mod.toTraeTools([{ type: "function", function: { name: "pwsh", parameters: { type: "object" } } }]),
          toolChoice: "auto",
        },
        AbortSignal.timeout(20000),
      );
      const req = capturedRequest();
      if (!Array.isArray(req.tools)) throw new Error("payload.tools 缺失");
      if (typeof req.tools[0].function.parameters !== "string") throw new Error("parameters 必须是字符串");
    },
  );
});

/**
 * C. **首事件预读的 parser 交接**（2026-10-08，事故链的真正源头）。
 *
 * 这组必须走**真实 chatStream** 才能测到：缺陷在接线，不在 parser 本身 ——
 * 单独 new 一个 parser 测它的行为永远是绿的（反向验证时 M1/M2 就是这样漏掉的）。
 *
 * 手法：上游把第一个 TCP 分片切在**事件中间**（第二个事件只发一半），这样首读
 * 退出时 parser A 里一定留着一个半截事件；随后 `translate` 若新建 parser，
 * 那半截就永久丢失。
 */
function makeChunkedUpstream(chunks) {
  const encoder = new TextEncoder();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    let i = 0;
    return {
      ok: true,
      status: 200,
      body: {
        getReader() {
          return {
            async read() {
              if (i >= chunks.length) return { done: true, value: undefined };
              const value = encoder.encode(chunks[i]);
              i += 1;
              return { done: false, value };
            },
            cancel() {},
          };
        },
      },
      text: async () => "",
    };
  };
  return () => { globalThis.fetch = realFetch; };
}

ok("C1: 首读切在事件中间时，后半截事件**不丢**（parser 交接）", async () => {
  const whole = sse("output", { response: "后半截不能丢" });
  const cut = Math.floor(whole.length / 2);
  const restore = makeChunkedUpstream([
    sse("output", { response: "前半句。" }) + whole.slice(0, cut),
    whole.slice(cut),
    sse("done", { finish_reason: "stop" }),
  ]);
  try {
    const result = await client.chatStream(
      { token: "t", appId: "a", appVersionCode: 1, gateway: "http://127.0.0.1:1", product: { functions: ["solo_agent"], reqSource: 1 } },
      { model: "m", function: "solo_agent", messages: [{ role: "user", content: "hi" }] },
      AbortSignal.timeout(20000),
    );
    const chunks = await streamChunks(result);
    const content = chunks.map((c) => c.choices[0].delta.content ?? "").join("");
    if (!content.includes("后半截不能丢")) {
      throw new Error(`半截事件被丢弃（正文=${JSON.stringify(content)}）—— parser 交接没做对`);
    }
    if (!content.includes("前半句。")) throw new Error(`前半句丢了：${JSON.stringify(content)}`);
  } finally {
    restore();
  }
});

ok("C2: 丢掉的若是**工具调用的头部片**，下游会拿到无名调用（这就是历史污染的来源）", async () => {
  // 首片带 id/name，分片边界正好把它切开 —— 交接正确时它必须完整送达
  const header = sse("output", {
    tool_calls: [{ index: 0, id: "call_head", type: "function", function_call: { name: "write_note", arguments: "" } }],
  });
  const cut = Math.floor(header.length / 2);
  const restore = makeChunkedUpstream([
    header.slice(0, cut),
    header.slice(cut) + sse("output", { tool_calls: [{ index: 0, id: "", type: "", function_call: { name: "", arguments: '{"x":1}' } }] }),
    sse("done", { finish_reason: "stop" }),
  ]);
  try {
    const result = await client.chatStream(
      { token: "t", appId: "a", appVersionCode: 1, gateway: "http://127.0.0.1:1", product: { functions: ["solo_agent"], reqSource: 1 } },
      { model: "m", function: "solo_agent", messages: [{ role: "user", content: "hi" }] },
      AbortSignal.timeout(20000),
    );
    const chunks = await streamChunks(result);
    const calls = chunks.flatMap((c) => c.choices[0].delta.tool_calls ?? []);
    const named = calls.find((c) => c.function?.name === "write_note");
    if (named === undefined) {
      throw new Error(`头部片丢了 → 只剩无名分片（calls=${JSON.stringify(calls).slice(0, 200)}）`);
    }
    if (calls.some((c) => c.function && c.function.name === "")) {
      throw new Error(`出现了空名字的调用（这就是污染历史的形态）：${JSON.stringify(calls).slice(0, 200)}`);
    }
  } finally {
    restore();
  }
});

ok("C3: 最后一个事件没有尾随空行时，done 仍被解析（真实 finish_reason 不被兜底顶替）", async () => {
  const restore = makeChunkedUpstream([
    sse("output", { response: "内容。" }),
    // 注意：**故意不补** 结尾的 \n\n
    'event: done\ndata: {"finish_reason":"length"}',
  ]);
  try {
    const result = await client.chatStream(
      { token: "t", appId: "a", appVersionCode: 1, gateway: "http://127.0.0.1:1", product: { functions: ["solo_agent"], reqSource: 1 } },
      { model: "m", function: "solo_agent", messages: [{ role: "user", content: "hi" }] },
      AbortSignal.timeout(20000),
    );
    const chunks = await streamChunks(result);
    const finals = chunks.filter((c) => c.choices[0].finish_reason !== null);
    if (finals.length === 0) throw new Error("没有 finish_reason");
    const reason = finals[finals.length - 1].choices[0].finish_reason;
    if (reason !== "length") {
      throw new Error(`真实 finish_reason 被兜底顶替成 ${JSON.stringify(reason)}（应为 length）—— 截断与正常结束分不出来了`);
    }
  } finally {
    restore();
  }
});

fs.rmSync(stubDir, { recursive: true, force: true });
// 等所有用例跑完再统计（漏了这一行，"全绿"就是假的）。
await chain;
console.log(`\nverify-trae-output-hygiene: ${passed} 通过 / ${failed} 失败  [src=${SRC}]`);
process.exitCode = failed ? 1 : 0;