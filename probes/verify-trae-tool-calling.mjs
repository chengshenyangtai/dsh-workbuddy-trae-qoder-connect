#!/usr/bin/env node
// probes/verify-trae-tool-calling.mjs
// 钉死 Trae 渠道的工具调用链路（离线，不花额度）。
//
// 事故背景（2026-10-08）：插件的 Trae provider **从不向上游发送 tools**，
// 且消息转换丢弃 assistant.tool_calls / role:"tool"，响应侧又把上游的
// `function_call` 形状原样透传（下游认的是 `function`）。后果是 DSH 的 agent
// 回合在 Trae 下必然失败：模型看不到工具定义，于是自造原生文本标记
//   <|FunctionCallBegin|>[{"name":"get_weather",...}]<|FunctionCallEnd|>
// 漏成正文（用户看到"报一堆东西"），或者干脆空回合。
//
// 本探针用**实测抓到的真实 SSE 形态**做输入（见文件末尾 RAW_SAMPLE_*），
// 断言三件事：
//   1. 请求侧：tools 转换后的 parameters 是 **JSON 字符串**（上游契约，
//      传对象会被 4001 拒绝 —— 这是唯一一个"猜错就整轮崩"的点）；
//   2. 消息侧：工具往返历史按上游认的形状保留（function_call + tool 消息
//      不带 tool_call_id —— 形状 A 会静默失败，实测过）；
//   3. 响应侧：上游分片 function_call 被归一成 OpenAI 形状并保留分片顺序，
//      且 finish_reason 被改写为 tool_calls。
//
// 用法：node probes/verify-trae-tool-calling.mjs [--installed]

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
const ok = (label, fn) => {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`FAIL ${label}\n  ${e && e.message}`);
  }
};
const eq = (actual, expected, what) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: 期望 ${b}，实际 ${a}`);
};

// —— 载入真实模块（stub 掉只在安装包内的宿主 peer）——
const stubDir = path.join(HERE, ".toolcall-stubs");
fs.mkdirSync(stubDir, { recursive: true });
const stubNames = {
  "@deepseek-ai/dsh-home-paths": ["resolveDshHome"],
  "@deepseek-ai/dsh-llm": ["resolveRetryPolicy"],
  "@deepseek-ai/dsh-llm-pi-ai": ["PiAiAdapter"],
  "@earendil-works/pi-ai": ["createProvider"],
  "@earendil-works/pi-ai/api/openai-completions.lazy": ["openAICompletionsApi"],
};
const stubMap = {};
for (const [spec, names] of Object.entries(stubNames)) {
  const file = path.join(stubDir, spec.replace(/[@/]/g, "_") + ".mjs");
  fs.writeFileSync(
    file,
    `const mk=(n)=>{const f=function(){return f};f.__stub=n;return f};\n` +
      names.map((n) => `export const ${n}=mk(${JSON.stringify(n)});`).join("\n") +
      `\nexport default new Proxy({},{get:()=>mk('default')});\n`,
  );
  stubMap[spec] = file;
}

/**
 * schemastery 必须用**宿主真包**，不能 stub。
 *
 * 这个探针的存在本身就源自一次 stub 事故：上一轮的沙箱把 schemastery 也 stub 了，
 * 于是 `z.enum(...)`（宿主没有这个方法）被 stub 照单全收，测试全绿而插件在
 * 真实宿主里加载即崩。契约为先的依赖一律用真包。
 */
const schemasteryDir = path.join(os.homedir(), ".dsh", "profiles", "desktop", "node_modules", "@deepseek-ai", "schemastery");
const schemasteryEntry = (() => {
  const pkgPath = path.join(schemasteryDir, "package.json");
  if (!fs.existsSync(pkgPath)) return null;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  let entry = pkg.exports?.["."] ?? pkg.main ?? "index.js";
  if (typeof entry === "object" && entry !== null) {
    entry = entry.import ?? entry.module ?? entry.default ?? Object.values(entry).find((v) => typeof v === "string");
  }
  if (typeof entry !== "string") return null;
  entry = entry.replace(/^\.\//, "");
  for (const cand of [entry.replace(/\.cjs$/, ".mjs"), entry]) {
    const file = path.join(schemasteryDir, cand);
    if (fs.existsSync(file)) return file;
  }
  return null;
})();
if (schemasteryEntry === null) {
  console.error("找不到宿主真包 @deepseek-ai/schemastery —— 本探针需要一个装过 dsh 桌面版的机器。");
  process.exit(2);
}
stubMap["@deepseek-ai/schemastery"] = schemasteryEntry;
const loaderFile = path.join(stubDir, "loader.mjs");
fs.writeFileSync(
  loaderFile,
  `import { pathToFileURL } from "node:url";\nconst map=${JSON.stringify(stubMap)};\n` +
    `export async function resolve(s,c,n){ if(map[s]) return {url:pathToFileURL(map[s]).href,shortCircuit:true,format:"module"}; return n(s,c) }\n`,
);
const { register } = await import("node:module");
register(new URL(`file://${loaderFile.replace(/\\/g, "/")}`).href, import.meta.url);

const mod = await import(pathToFileURL(path.join(SRC, "lib", "providers", "trae", "index.js")).href);
const { toTraeTools, toTraeToolCalls, toTraeMessages } = mod;

// —— 1. 请求侧：parameters 必须是 JSON 字符串 ——
ok("toTraeTools: parameters 输出为 JSON 字符串（上游契约）", () => {
  const tools = [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "查询天气",
        parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      },
    },
  ];
  const out = toTraeTools(tools);
  if (typeof out[0].function.parameters !== "string") {
    throw new Error(`parameters 类型是 ${typeof out[0].function.parameters}，上游要求 string`);
  }
  const parsed = JSON.parse(out[0].function.parameters);
  eq(parsed.required, ["city"], "parameters 内容应可被 JSON.parse 还原");
});

ok("toTraeTools: 已是字符串的 parameters 原样保留（不双重编码）", () => {
  const raw = '{"type":"object"}';
  const out = toTraeTools([{ type: "function", function: { name: "f", parameters: raw } }]);
  eq(out[0].function.parameters, raw, "字符串不该被再 JSON.stringify 一次");
});

ok("toTraeTools: 缺 parameters 时补 '{}'（而非 undefined）", () => {
  const out = toTraeTools([{ type: "function", function: { name: "noargs" } }]);
  eq(out[0].function.parameters, "{}", "空参数应为空对象字符串");
});

ok("toTraeTools: 无名函数被丢弃；空数组返回 undefined", () => {
  eq(toTraeTools([{ type: "function", function: { description: "无名" } }]), undefined, "无名应被过滤");
  eq(toTraeTools([]), undefined, "空输入应返回 undefined");
  eq(toTraeTools(undefined), undefined, "undefined 输入应返回 undefined");
});

// —— 2. 消息侧：工具往返历史按上游认的形状保留 ——
ok("toTraeMessages: assistant.tool_calls 用 function_call 形状（不是 function）", () => {
  const msgs = [
    { role: "user", content: "北京天气？" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"北京"}' } }],
    },
  ];
  const out = toTraeMessages(msgs, true);
  const assistant = out.find((m) => m.role === "assistant");
  if (assistant === undefined) throw new Error("assistant 消息被丢掉了");
  if (assistant.tool_calls === undefined) throw new Error("tool_calls 被丢掉了");
  const call = assistant.tool_calls[0];
  if (call.function_call === undefined) throw new Error("必须是 function_call 形状（实测形状 A 会静默失败）");
  if (call.function !== undefined) throw new Error("不该同时带 OpenAI 的 function 字段");
  eq(call.function_call.name, "get_weather", "name");
  eq(call.function_call.arguments, '{"city":"北京"}', "arguments");
});

ok("toTraeMessages: 纯工具调用的 assistant 消息不被 parts.length===0 丢掉", () => {
  const out = toTraeMessages(
    [{ role: "assistant", content: "", tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "{}" } }] }],
    true,
  );
  if (out.length !== 1) throw new Error(`期望保留 1 条，实际 ${out.length} 条`);
});

ok("toTraeMessages: role:'tool' 正文保留，且**不带** tool_call_id", () => {
  const out = toTraeMessages(
    [{ role: "tool", tool_call_id: "call_1", content: '{"temp":7}' }],
    true,
  );
  const tool = out.find((m) => m.role === "tool");
  if (tool === undefined) throw new Error("tool 消息被丢掉了");
  eq(tool.content[0].text, '{"temp":7}', "工具结果正文");
  if (tool.tool_call_id !== undefined) {
    throw new Error("tool_call_id 会让上游静默丢弃整段历史（实测），不该带");
  }
});

ok("toTraeMessages: tool 结果是片段数组时也能取到正文", () => {
  const out = toTraeMessages([{ role: "tool", content: [{ type: "text", text: "结果A" }, { type: "text", text: "结果B" }] }], true);
  // 片段按顺序拼接（不是用分隔符连接）—— 工具结果常是 JSON，插分隔符会破坏它
  eq(out[0].content[0].text, "结果A结果B", "片段应顺序拼接");
});

ok("toTraeMessages: 工具结果为空时仍保留该轮（不能静默丢）", () => {
  const out = toTraeMessages([{ role: "tool", content: "" }], true);
  if (out.length !== 1) throw new Error(`空结果也应保留占位，实际 ${out.length} 条`);
});

// —— 3. 响应侧：真实 SSE 形状 → OpenAI 形状 ——
// 下面这段是 2026-10-08 抓包的真实分片形态（write_note 调用，4 片参数）
const SHARDS = [
  { index: 0, id: "call_z26mvgpgp2x0p7uclyq1nrle", type: "function", function_call: { name: "write_note", arguments: "", partial_arguments: null, namespace: null } },
  { index: 0, id: "", type: "", function_call: { name: "", arguments: '{"path": "/tmp/dsh-probe.md", "body": "', partial_arguments: null, namespace: null } },
  { index: 0, id: "", type: "", function_call: { name: "", arguments: "这是一段用于观察参数分片行为的较长", partial_arguments: null, namespace: null } },
  { index: 0, id: "", type: "", function_call: { name: "", arguments: "正文，请原样传入，不要改写，也不要", partial_arguments: null, namespace: null } },
  { index: 0, id: "", type: "", function_call: { name: "", arguments: "只用一句话。\"}", partial_arguments: null, namespace: null } },
];

// normalizeToolCalls 是 translate() 内部函数（不导出），所以这里用等价断言：
// 直接验证模块导出的转换 + 用真实 SSE 走一遍 shim 的翻译逻辑（见下节）。
ok("真实分片：拼接后是合法 JSON（决定 arguments 能否被下游解析）", () => {
  const joined = SHARDS.map((s) => s.function_call.arguments).join("");
  const parsed = JSON.parse(joined);
  eq(parsed.path, "/tmp/dsh-probe.md", "拼接后的 path");
  if (typeof parsed.body !== "string" || parsed.body.length === 0) throw new Error("拼接后的 body 为空");
});

// —— 4. 端到端：用真实分片喂给 chatStream，断言下发的 OpenAI SSE ——
// 起一个假上游（回上面那 5 个 output 事件 + done），再让真实 client 去翻译。
const { createTraeClient } = mod;
const fakePort = 39000 + Math.floor(Math.random() * 500);
const http = await import("node:http");

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    capturedRequest = JSON.parse(body);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const shard of SHARDS) res.write(sse("output", { tool_calls: [shard] }));
    res.write(sse("token_usage", { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }));
    // ⚠️ 关键：上游即使有工具调用也报 stop（实测），插件必须改成 tool_calls
    res.write(sse("done", { finish_reason: "stop" }));
    res.end();
  });
});

let capturedRequest;
await new Promise((resolve) => server.listen(fakePort, "127.0.0.1", resolve));

const client = createTraeClient({ logger: { warn() {}, info() {} } });
const credential = {
  token: "fake.jwt.token",
  appId: "fake-app",
  appVersionCode: 1,
  gateway: `http://127.0.0.1:${fakePort}`,
  product: { functions: ["solo_agent"], reqSource: 1 },
};

const result = await client.chatStream(
  credential,
  {
    model: "glm-5.3-flash",
    function: "solo_agent",
    messages: [{ role: "user", content: [{ type: "text", text: "写个笔记" }] }],
    tools: toTraeTools([
      { type: "function", function: { name: "write_note", parameters: { type: "object", properties: { path: { type: "string" } } } } },
    ]),
    toolChoice: "auto",
  },
  undefined,
);

ok("端到端：chatStream 返回 ok", () => {
  if (result.ok !== true) throw new Error(`未 ok：${JSON.stringify(result).slice(0, 200)}`);
});

ok("端到端：**上游请求真的带上了 tools**（本次修复的核心）", () => {
  if (capturedRequest === undefined) throw new Error("假上游没收到请求");
  if (!Array.isArray(capturedRequest.tools)) throw new Error("payload.tools 缺失 —— agent 回合必然失败");
  eq(typeof capturedRequest.tools[0].function.parameters, "string", "parameters 必须是字符串");
  eq(capturedRequest.tool_choice, "auto", "tool_choice 应透传");
});

const text = await new Response(result.response).text();
const chunks = text
  .split("\n\n")
  .filter((b) => b.startsWith("data: ") && !b.includes("[DONE]"))
  .map((b) => JSON.parse(b.slice(6)));

ok("端到端：tool_calls 被归一成 OpenAI 形状（function，不是 function_call）", () => {
  const withCalls = chunks.filter((c) => c.choices[0].delta.tool_calls !== undefined);
  if (withCalls.length === 0) throw new Error("下游一个 tool_calls delta 都没收到 —— 工具调用被丢弃");
  const first = withCalls[0].choices[0].delta.tool_calls[0];
  if (first.function === undefined) throw new Error("缺少 OpenAI 的 function 字段");
  if (first.function_call !== undefined) throw new Error("不该把上游的 function_call 原样透传");
  eq(first.id, "call_z26mvgpgp2x0p7uclyq1nrle", "首片应带 id");
  eq(first.function.name, "write_note", "首片应带 name");
});

ok("端到端：参数分片顺序保持，拼接后可解析", () => {
  const withCalls = chunks.filter((c) => c.choices[0].delta.tool_calls !== undefined);
  const joined = withCalls.map((c) => c.choices[0].delta.tool_calls[0].function.arguments).join("");
  const parsed = JSON.parse(joined);
  eq(parsed.path, "/tmp/dsh-probe.md", "拼接后的 path");
});

ok("端到端：后续分片不把 id/name 覆盖成空串", () => {
  const withCalls = chunks.filter((c) => c.choices[0].delta.tool_calls !== undefined);
  const later = withCalls.slice(1);
  for (const c of later) {
    const call = c.choices[0].delta.tool_calls[0];
    if (call.id === "") throw new Error("空 id 被透传（会覆盖已建立的名字）");
    if (call.function.name === "") throw new Error("空 name 被透传");
  }
});

ok("端到端：finish_reason 被改写为 tool_calls（上游报的是 stop）", () => {
  const finals = chunks.filter((c) => c.choices[0].finish_reason !== null);
  if (finals.length === 0) throw new Error("没有终结 chunk");
  eq(finals[finals.length - 1].choices[0].finish_reason, "tool_calls", "有工具调用时必须报 tool_calls");
});

// —— 5. 接线：shim 的调用点必须真的把 tools 传给 chatStream ——
// 端到端用例是自己把 tools 传给 chatStream 的，覆盖不到"调用点漏传"这条线
// （把调用点的 tools 去掉，上面 16 项仍然全绿 —— 已实测）。所以这一节直接
// 读源码，用**括号配对**取实参（简单正则会撞上实参里的箭头函数与对象，见
// verify-attachment-wiring.mjs 的同类教训）。
/** 去掉注释后的 provider 源码（断言一律用它，见下面的教训注释）。 */
function providerCode() {
  const raw = fs.readFileSync(path.join(SRC, "lib", "providers", "trae", "index.js"), "utf8");
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

ok("接线：client.chatStream 调用点传入了 tools / toolChoice", () => {
  const src = providerCode();
  const marker = "client.chatStream(credential, {";
  const at = src.indexOf(marker);
  if (at === -1) throw new Error("找不到 client.chatStream 调用点");
  const open = src.indexOf("{", at + marker.length - 1);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) throw new Error("实参对象没有闭合");
  const args = src.slice(open, end);
  // 去掉注释行，避免"注释里提到 tools"就误判为已接上
  const code = args
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
  /**
   * 断言**值**而不是键名：`tools: undefined,` 也含 `tools:`，
   * 只查键名会放过"接了个空"的假接线（已实测：把调用点改成 `tools: undefined`
   * 时，只查键名的版本仍然全绿）。
   */
  if (!/tools:\s*toTraeTools\(/.test(code)) {
    throw new Error("调用点没把 toTraeTools(request.tools) 接上 —— 模型看不到任何工具，agent 回合必然失败");
  }
  if (!/toolChoice:\s*request\.tool_choice/.test(code)) {
    throw new Error("调用点没把 request.tool_choice 接上");
  }
  /**
   * 2026-10-08：`toolsEnabled` 开关已随配置收口一并删除（配置通道本来就不通，
   * 开关是拧不动的假阀）。这里反向钉住"不得复活死开关"—— 若有人把它加回来，
   * 必须同时把配置通道接通，否则又是一个拧不动的假阀。
   */
  if (/toolsEnabled/.test(code)) {
    throw new Error("调用点又出现了 toolsEnabled 死开关（配置通道已收口，条件恒真）");
  }
});

ok("接线：上游 payload 组装处带上了 tools / tool_choice", () => {
  const src = providerCode();
  if (!/payload\.tools\s*=/.test(src)) throw new Error("payload 里没有 tools 字段");
  if (!/payload\.tool_choice\s*=/.test(src)) throw new Error("payload 里没有 tool_choice 字段");
});

ok("接线：初始事件批次整批保留（不能丢掉 events[1..]）", () => {
  const src = providerCode();
  /**
   * 剥掉注释再断言 —— 本文件的修复注释里**逐字写着**事故代码
   * （`first = events[0]`、`parser.pending()`），不剥注释就是自己抓自己。
   * 同类教训：verify-attachment-wiring.mjs 里 JSDoc 提到 resolveAttachments
   * 导致「删掉真代码仍全绿」的假阴性。
   */
  if (/first = events\[0\]/.test(src)) {
    throw new Error("又出现 `first = events[0]`：同批剩余事件会被丢弃（工具分片/done 一起到达时整段消失）");
  }
  if (!/initialEvents = parser\.push\(value\)/.test(src)) {
    throw new Error("初始事件没有整批接住");
  }
  if (/parser\.pending\(\)/.test(src)) {
    throw new Error("还在用 parser.pending() 取初始事件：push() 已清空队列，它必然返回空数组");
  }
});

server.close();
fs.rmSync(stubDir, { recursive: true, force: true });

console.log(`\nverify-trae-tool-calling: ${passed} 通过 / ${failed} 失败  [src=${SRC}]`);
process.exitCode = failed ? 1 : 0;
