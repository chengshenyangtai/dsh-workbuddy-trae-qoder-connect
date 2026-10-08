#!/usr/bin/env node
// probes/verify-workbuddy-reasoning-levels.mjs
// 钉死 2026-10-08 修的「WorkBuddy 档位下拉提供了上游必然拒绝的 off」。
//
// ## 事故（实测）
//
// `reasoning_effort` 打到真实上游的结果：
//   · `low` / `high` / `max` → 200
//   · `off`                  → **400 / code 11133 / extError.code=model_param_invalid**
//     （原文："the request parameters were rejected by the model provider"）
//
// 而目录里 `canDisableThinking: true` 的模型（如 `deepseek-v4.1-flash`）原本会把
// `off` 映射成字面量 `"off"` 发出去 —— 也就是说**下拉里选「关思考」会让整轮请求失败**，
// 属于"UI 提供了一个上游不接受的档位"。同族的 Qoder 上游 `off` 同样 400，那边一直
// 硬置 `null`；WorkBuddy 此前只凭"声明了 canDisableThinking"放行，是未实测的推断。
//
// 本探针把这条契约钉住：thinkingLevelMap.off 必须恒为 null，其余档位按声明映射。
//
// 用法：node probes/verify-workbuddy-reasoning-levels.mjs [--installed]

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

// —— 加载真实模块（真 schemastery + 桩宿主包）——
const stubDir = path.join(HERE, ".wb-effort-stubs");
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

const src = fs.readFileSync(path.join(SRC, "lib", "providers", "workbuddy", "index.js"), "utf8");
/** 去掉注释后再做源码断言（否则注释里提到某个词就会误判 —— 踩过的坑）。 */
const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

ok("1. `off` 恒为 null —— 上游实测对 `off` 返回 400/11133（model_param_invalid）", () => {
  if (!/thinkingLevelMap:\s*\{[\s\S]*?off:\s*null/.test(stripped)) {
    throw new Error("thinkingLevelMap.off 不是 null —— 下拉会给出一个上游必然拒绝的档位");
  }
});

ok("2. 源码里不再出现把 off 映射成字面量 \"off\" 的写法", () => {
  if (/off:\s*reasoning\.canDisableThinking\s*===\s*true/.test(stripped)) {
    throw new Error("off 仍在按 canDisableThinking 映射成 \"off\"（未经实测的推断）");
  }
  if (/off:\s*"off"/.test(stripped)) {
    throw new Error('仍有 off: "off" 的映射');
  }
});

ok("3. 其余档位仍按 supportedEfforts 声明映射（别把整个档位功能删掉）", () => {
  for (const level of ["low", "medium", "high", "xhigh", "max"]) {
    const re = new RegExp(`${level}:\\s*efforts\\.includes\\("${level}"\\)\\s*\\?\\s*"${level}"\\s*:\\s*null`);
    if (!re.test(stripped)) throw new Error(`${level} 的映射不见了`);
  }
});

ok("4. minimal 仍为 null（pi-ai 键空间的保留位，上游无对应拼写）", () => {
  if (!/minimal:\s*null/.test(stripped)) throw new Error("minimal 不再是 null");
});

fs.rmSync(stubDir, { recursive: true, force: true });
await chain;
console.log(`\nverify-workbuddy-reasoning-levels: ${passed} 通过 / ${failed} 失败  [src=${SRC}]`);
process.exitCode = failed ? 1 : 0;
