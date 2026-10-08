#!/usr/bin/env node
// probes/verify-workbuddy-tool-pairing.mjs
// 钉死 WorkBuddy 的「切换渠道后 11133/11148」修复。
//
// ## 事故（2026-10-08，用户实测）
//
// agent 会话中途切到 workbuddy1/deepseek-v4.1-flash 后，每轮都报
//   400 11133 "the request parameters were rejected by the model provider"
// 新开会话则正常。证据链（全部实测）：
//   · 该轮历史的 **542 条 role:"tool" 结果**里，配对状态无法在上游对上；
//   · 把历史**原样重放** → 400；把配对修复后重放 → 200；
//   · 逐档位探查全部 200 —— 排除凭据/额度/档位因素。
// 根因：多渠道聚合的历史由多个上游拼成，一家眼里合法的 tool id 序列，
// 另一家可能视为配对破损（上游对「调用必须有结果」的校验严格）。
//
// 修法：shim 在转发前修复配对（丢孤儿结果、删未应答调用）。
//
// 用法：node probes/verify-workbuddy-tool-pairing.mjs [--installed]

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

// —— 加载真实模块（真 schemastery + 桩宿主包）——
const stubDir = path.join(HERE, ".wb-pairing-stubs");
fs.mkdirSync(stubDir, { recursive: true });
const stubMap = {};
const stubs = {
  "@deepseek-ai/dsh-home-paths": ["resolveDshHome"],
  "@deepseek-ai/dsh-llm": ["resolveRetryPolicy"],
  "@deepseek-ai/dsh-llm-pi-ai": ["PiAiAdapter"],
  "@earendil-works/pi-ai": ["createProvider"],
  "@earendil-works/pi-ai/api/openai-completions.lazy": ["openAICompletionsApi"],
  "@deepseek-ai/dsh-atomic-write": ["withFileLock", "writeFileAtomic"],
};
for (const [spec, names] of Object.entries(stubs)) {
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

const mod = await import(pathToFileURL(path.join(SRC, "lib", "providers", "workbuddy", "index.js")).href);
const { createWorkBuddyShim } = mod;

// —— helper：起 shim（真实 HTTP），发请求，拿转发到"上游"的 body ——
async function withShim(fn) {
  const captured = [];
  let invalidated = 0;
  const credential = { accessToken: "tok", domain: "www.codebuddy.cn", uid: "u" };
  const fakeUpstream = (http) => {
    const server = http.createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        captured.push(JSON.parse(b));
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n');
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    return server;
  };
  const http = await import("node:http");
  const upstream = fakeUpstream(http);
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const port = upstream.address().port;

  // 让 shim 的上游指向假服务器：client.chatStream 指向 chatBase(credential)
  // chatBase 取 credential.domain —— 指到 127.0.0.1:port
  const shimCred = { ...credential, domain: `127.0.0.1:${port}`, protocol: "http" };
  // chatBase 的拼法可能是 https://{domain} —— 查看：为通用性，直接monkeypatch client
  const store = { resolve: async () => shimCred, refreshIfDue: async () => shimCred };
  const realChatStream = mod.WorkBuddyUpstreamClient;
  const client = {
    chatStream: async (cred, body, signal) => {
      // 直接转发到假上游（绕过 chatBase 拼法差异），但保留"发字符串 body"的语义
      const res = await fetch(`http://127.0.0.1:${port}/v2/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { ok: false, status: res.status, kind: "client", message: text };
      }
      return { ok: true, response: res };
    },
  };

  const shim = createWorkBuddyShim({ store, client, catalog: { current: () => [] }, logger: { warn(...a) { console.log("  [warn]", ...a); }, info() {} } });
  await shim.ready;
  const base = shim.baseUrl();

  try {
    await fn({
      async post(bodyObj) {
        const res = await fetch(`${base}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${shim.token()}` },
          body: JSON.stringify(bodyObj),
        });
        return { status: res.status, text: await res.text() };
      },
      capturedBodies: () => captured,
    });
  } finally {
    await shim.close();
    upstream.close();
  }
}

// —— 历史形状：从事故里提炼 ——
const BROKEN_HISTORY = {
  model: "deepseek-v4.1-flash",
  stream: true,
  max_tokens: 64,
  messages: [
    { role: "system", content: "You are a coding agent." },
    { role: "user", content: "看看目录" },
    // 一次正常往返（应保留）
    { role: "assistant", content: "", tool_calls: [{ id: "call_ok_1", type: "function", function: { name: "pwsh", arguments: '{"command":"ls"}' } }] },
    { role: "tool", tool_call_id: "call_ok_1", content: "file1.txt" },
    { role: "assistant", content: "列出来了。" },
    { role: "user", content: "切换模型继续" },
    // —— 破损形态 A：孤儿结果（切换后，新上游没见过这个调用）——
    { role: "tool", tool_call_id: "call_orphan_from_other_channel", content: "42" },
    // —— 破损形态 B：调用后没有结果（原渠道的会话被截断）——
    { role: "assistant", content: "", tool_calls: [{ id: "call_dangling_2", type: "function", function: { name: "read", arguments: '{"path":"x"}' } }] },
    { role: "user", content: "继续" },
  ],
};

await ok("1. 配对破损的历史 → 修复后转发：孤儿结果与未应答调用被移除", async () => {
  await withShim(async ({ post, capturedBodies }) => {
    const res = await post(BROKEN_HISTORY);
    if (res.status !== 200) throw new Error(`shim 返回 ${res.status}: ${res.text.slice(0, 160)}`);
    const bodies = capturedBodies();
    if (bodies.length === 0) throw new Error("上游没收到请求");
    const msgs = bodies[0].messages ?? [];
    const ids = msgs.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
    if (ids.includes("call_orphan_from_other_channel")) throw new Error("孤儿结果未被移除");
    const dangling = msgs.find((m) => m.role === "assistant" && (m.tool_calls ?? []).some((c) => c.id === "call_dangling_2"));
    if (dangling) throw new Error("未应答调用未被移除");
    // 正常往返必须原样保留
    if (!ids.includes("call_ok_1")) throw new Error("正常往返被误删");
  });
});

await ok("2. 完好的历史 → **逐字节原样转发**（不做任何多余改写）", async () => {
  await withShim(async ({ post, capturedBodies }) => {
    const intact = {
      model: "deepseek-v4.1-flash",
      stream: true,
      max_tokens: 64,
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "pwsh", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: "out" },
        { role: "assistant", content: "done" },
        { role: "user", content: "go" },
      ],
    };
    await post(intact);
    const bodies = capturedBodies();
    const msgs = bodies[0].messages ?? [];
    if (JSON.stringify(msgs) !== JSON.stringify(intact.messages)) {
      throw new Error(`完好历史被改写：${JSON.stringify(msgs).slice(0, 200)}`);
    }
  });
});

await ok("3. tool_calls 全部无结果且**无正文**时，整条 assistant 消息被丢弃（与 pi-ai 对齐）", async () => {
  await withShim(async ({ post, capturedBodies }) => {
    await post({
      model: "m",
      stream: true,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "", tool_calls: [{ id: "x1", type: "function", function: { name: "f", arguments: "{}" } }] },
        { role: "user", content: "继续" },
      ],
    });
    const msgs = capturedBodies()[0].messages ?? [];
    /**
     * 删空 tool_calls 后剩下「无正文 + 无 tool_calls」的 assistant 消息 —— 这正是
     * pi-ai 自己会跳过的非法形状（"either content or tool_calls, but not none"），
     * 所以整条丢弃，而不是留一个空壳给上游。
     */
    if (msgs.some((m) => m.role === "assistant")) {
      throw new Error(`空壳 assistant 消息还在：${JSON.stringify(msgs).slice(0, 200)}`);
    }
    if (!msgs.some((m) => m.role === "user")) throw new Error("user 消息被误删");
  });
});

await ok("3b. tool_calls 全部无结果但**有正文**时：保留消息、只去掉 tool_calls 字段", async () => {
  await withShim(async ({ post, capturedBodies }) => {
    await post({
      model: "m",
      stream: true,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "我先看看。", tool_calls: [{ id: "x2", type: "function", function: { name: "f", arguments: "{}" } }] },
        { role: "user", content: "继续" },
      ],
    });
    const msgs = capturedBodies()[0].messages ?? [];
    const a = msgs.find((m) => m.role === "assistant");
    if (a === undefined) throw new Error("带正文的 assistant 消息被误删");
    if (a.tool_calls !== undefined) throw new Error("空的 tool_calls 字段还在");
    if (a.content !== "我先看看。") throw new Error(`正文被改动：${JSON.stringify(a.content)}`);
  });
});

await ok("6. **空函数名调用 + 其配对结果**被整对摘掉（11133 的真正根因）", async () => {
  await withShim(async ({ post, capturedBodies }) => {
    /**
     * 事故形态：上游适配层退化产出一条 `function.name === ""` 的调用，宿主按
     * "未知工具"执行并记进历史。实测该形态让 deepseek-v4.1-flash 直接
     * 400/11133（4 条消息、约 200 字节即可复现），而 glm-5.3-flash 宽容放行。
     */
    await post({
      model: "deepseek-v4.1-flash",
      stream: true,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "我想读图。", tool_calls: [{ id: "call_bad", type: "function", function: { name: "", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_bad", content: 'Error: unknown tool ""' },
        { role: "assistant", content: "算了。" },
        { role: "user", content: "继续" },
      ],
    });
    const msgs = capturedBodies()[0].messages ?? [];
    if (JSON.stringify(msgs).includes('"name":""')) throw new Error("空名调用仍被转发给上游");
    if (msgs.some((m) => m.role === "tool" && m.tool_call_id === "call_bad")) throw new Error("空名调用的结果还在（会变成孤儿）");
    if (!msgs.some((m) => m.role === "assistant" && m.content === "算了。")) throw new Error("正常消息被误删");
  });
});

await ok("6b. **缺 name 键**的调用同样按退化处理（下游同样得到无名调用）", async () => {
  await withShim(async ({ post, capturedBodies }) => {
    /**
     * OpenAI 流式契约里首片必定带 name，所以"有 id 但没有 name 键"只可能是
     * 首片丢失后的残片 —— 下游 pi-ai 以 name 建块，最终仍是一个没法执行的
     * 无名调用（与空串同效），所以一并摘掉。
     */
    await post({
      model: "m",
      stream: true,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "", tool_calls: [{ id: "call_noname", type: "function", function: { arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_noname", content: "out" },
      ],
    });
    const msgs = capturedBodies()[0].messages ?? [];
    if (msgs.some((m) => (m.tool_calls ?? []).some((c) => c.id === "call_noname"))) {
      throw new Error("缺 name 键的调用未被摘掉");
    }
    if (msgs.some((m) => m.role === "tool" && m.tool_call_id === "call_noname")) throw new Error("配对结果未一起摘掉");
  });
});

await ok("6c. 空白字符串 name（\"   \"）同样按退化处理", async () => {
  await withShim(async ({ post, capturedBodies }) => {
    await post({
      model: "m",
      stream: true,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "x", tool_calls: [{ id: "call_ws", type: "function", function: { name: "   ", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_ws", content: "out" },
      ],
    });
    const msgs = capturedBodies()[0].messages ?? [];
    if (msgs.some((m) => (m.tool_calls ?? []).some((c) => c.id === "call_ws"))) throw new Error("空白 name 未被判为退化");
    if (msgs.some((m) => m.role === "tool" && m.tool_call_id === "call_ws")) throw new Error("配对结果未一起摘掉");
  });
});

await ok("4. tool 结果连着**同 id 的重复结果**：只要调用存在就保留（不越权重写）", async () => {
  await withShim(async ({ post, capturedBodies }) => {
    await post({
      model: "m",
      stream: true,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "", tool_calls: [{ id: "c9", type: "function", function: { name: "f", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c9", content: "a" },
        { role: "tool", tool_call_id: "c9", content: "b" },
      ],
    });
    const msgs = capturedBodies()[0].messages ?? [];
    const tools = msgs.filter((m) => m.role === "tool");
    if (tools.length !== 2) throw new Error(`重复结果被改动：${tools.length} 条`);
  });
});

await ok("5. 无 messages 字段的请求体 → 原样放行（repairToolPairing 不炸）", async () => {
  await withShim(async ({ post, capturedBodies }) => {
    const res = await post({ model: "m", stream: true });
    if (res.status !== 200) throw new Error(`shim 返回 ${res.status}：${res.text.slice(0, 160)}`);
    const bodies = capturedBodies();
    if (bodies.length !== 1) throw new Error("上游没收到恰一次请求");
    /**
     * 请求体本来就没有 messages —— repairToolPairing 必须原样放行
     * （不能凭空造一个空数组出来，也不能 500）。这是「不炸」的判据。
     */
    if (bodies[0].model !== "m") throw new Error(`model 字段丢失：${JSON.stringify(bodies[0]).slice(0, 120)}`);
    if (bodies[0].messages !== undefined) throw new Error("不该凭空出现 messages");
  });
});

fs.rmSync(stubDir, { recursive: true, force: true });
await chain;
console.log(`\nverify-workbuddy-tool-pairing: ${passed} 通过 / ${failed} 失败  [src=${SRC}]`);
process.exitCode = failed ? 1 : 0;