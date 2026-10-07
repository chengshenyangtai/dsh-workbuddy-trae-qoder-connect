#!/usr/bin/env node
// probes/verify-provider-config-schema.mjs
// 钉死一件事：三个 provider 在**模块求值阶段**用到的 schemastery 字段构造
// 调用，必须在宿主机真实的 @deepseek-ai/schemastery 上可执行。
//
// 背景：bada691 给 Trae 配置加了 PRODUCT_FIELD，写成 z.enum(["cn","solo"])。
// schemastery 的默认导出没有 .enum（它是 z.const / z.union 一族），于是
// lib/providers/trae/index.js 在 import 阶段抛
//   TypeError: z.enum is not a function
// —— Trae / Qoder / WorkBuddy 三条渠道随整个 bundle 一起加载失败，
// 表现为「重启后渠道中心一个渠道都不显示」。沙箱自测当时全绿，
// 因为它把 schemastery 也 stub 掉了 —— 对宿主契约 API 的断言，必须用真包跑。
//
// 用法：
//   node probes/verify-provider-config-schema.mjs [--installed]
// 依赖：宿主机 profile 已安装 @deepseek-ai/schemastery（dsh 桌面版默认满足）。
// 找不到真包时相关断言会 SKIP（打印 skip 行），不误报失败。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOME_DIR = os.homedir();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SRC = process.argv.includes("--installed")
  ? path.join(HOME_DIR, ".dsh", "profiles", "desktop", "node_modules", "dsh-connect")
  : REPO;

// 解析真实的 schemastery：优先 profile 的 node_modules（与宿主运行时同源）。
function resolveRealSchemastery() {
  const profile = path.join(HOME_DIR, ".dsh", "profiles", "desktop");
  const pkgDir = path.join(profile, "node_modules", "@deepseek-ai", "schemastery");
  const pkgPath = path.join(pkgDir, "package.json");
  if (!fs.existsSync(pkgPath)) return null;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  let entry = pkg.exports?.["."] ?? pkg.main ?? "index.js";
  if (typeof entry === "object" && entry !== null) {
    // 条件导出对象：按 import -> module -> default 的顺序取字符串
    entry = entry.import ?? entry.module ?? entry.default ?? Object.values(entry).find((v) => typeof v === "string");
  }
  if (typeof entry !== "string") return null;
  entry = entry.replace(/^\.\//, "");
  const asEsm = entry.replace(/\.cjs$/, ".mjs");
  const file = path.join(pkgDir, fs.existsSync(path.join(pkgDir, asEsm)) ? asEsm : entry);
  return fs.existsSync(file) ? file : null;
}

const SCHEMA_FILE = resolveRealSchemastery();

let passed = 0;
let failed = 0;
let skipped = 0;
const ok = (label, fn) => {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`FAIL ${label}\n  ${e && e.message}`);
  }
};
const skip = (label, why) => {
  skipped++;
  console.log(`SKIP ${label} (${why})`);
};

// —— 1) 源码级：禁止任何 z.enum( 出现在 provider/面板源码里 ——
const providerFiles = [
  "lib/providers/trae/index.js",
  "lib/providers/qoder/index.js",
  "lib/providers/workbuddy/index.js",
  "lib/panel.js",
  "lib/channel-registry.js",
];
const zEnumHits = [];
for (const rel of providerFiles) {
  const abs = path.join(SRC, rel);
  if (!fs.existsSync(abs)) continue;
  const src = fs.readFileSync(abs, "utf8");
  for (const [i, line] of src.split("\n").entries()) {
    // 注释行不算（本文件自身的说明注释就含 z.enum 字样）
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*")) continue;
    if (/(^|[^.\w])z\.enum\s*\(/.test(line)) zEnumHits.push(`${rel}:${i + 1}`);
  }
}
ok("源码中不存在 z.enum( 调用", () => {
  if (zEnumHits.length) throw new Error(`发现 z.enum: ${zEnumHits.join(", ")}`);
});

// —— 2) 契约级：真实 schemastery 上，union-of-const 是合法字段形状 ——
if (!SCHEMA_FILE) {
  skip("真实 schemastery 契约断言", "profile 里找不到 @deepseek-ai/schemastery（非 dsh 桌面环境）");
} else {
  const { default: z } = await import(new URL(`file://${SCHEMA_FILE.replace(/\\/g, "/")}`).href);
  ok("schemastery 默认导出可加载", () => {
    if (typeof z !== "function" && typeof z !== "object") throw new Error("default export 不是构造器集合");
  });
  ok("schemastery 没有 z.enum（若有，说明宿主 API 变了，本探针与源码注释需同步更新）", () => {
    if (typeof z.enum === "function") throw new Error("宿主 schemastery 已提供 z.enum，请改用原生写法");
  });
  ok("z.const 存在", () => {
    if (typeof z.const !== "function") throw new Error("z.const 缺失");
  });
  ok("z.union 存在", () => {
    if (typeof z.union !== "function") throw new Error("z.union 缺失");
  });
  ok("z.union([z.const('cn'), z.const('solo')]).description(...) 可构造", () => {
    const field = z.union([z.const("cn"), z.const("solo")]).description("product line");
    const json = JSON.parse(JSON.stringify(field));
    const refs = Object.values(json.refs ?? {});
    if (!refs.some((r) => r.type === "union")) throw new Error("构造结果不是 union schema");
    if (!refs.some((r) => r.type === "const" && r.value === "cn")) throw new Error("union 成员丢失：cn");
  });
  ok("string/boolean/number/array/dict/object + .description/.default 链全绿", () => {
    z.string().description("s").default("");
    z.number().description("n");
    z.boolean().default(true).description("b");
    z.array(z.string()).description("a");
    z.dict(z.string()).description("d");
    z.object({ x: z.string() }).description("o");
  });
}

// —— 3) 端到端级：真实 provider 模块能在 stub 宿主包 + 真 schemastery 下求值 ——
// 只在 --installed（宿主 profile 上下文）时跑，仓库环境缺 peer 依赖会 SKIP。
if (process.argv.includes("--installed")) {
  const stubDir = path.join(HERE, ".schema-stubs");
  fs.mkdirSync(stubDir, { recursive: true });
  const stubNames = {
    "@deepseek-ai/dsh-home-paths": ["resolveDshHome"],
    "@deepseek-ai/dsh-llm": ["resolveRetryPolicy"],
    "@deepseek-ai/dsh-llm-pi-ai": ["PiAiAdapter"],
    "@earendil-works/pi-ai": ["createProvider"],
    "@earendil-works/pi-ai/api/openai-completions.lazy": ["openAICompletionsApi"],
  };
  const stubOf = (names) =>
    `const mk=(n)=>{const f=function(){return f};f.__stub=n;return f};\n` +
    names.map((n) => `export const ${n}=mk(${JSON.stringify(n)});`).join("\n") +
    `\nexport default new Proxy({},__stubget__);\n`;
  const stubMap = {};
  for (const [spec, names] of Object.entries(stubNames)) {
    const file = path.join(stubDir, spec.replace(/[@/]/g, "_") + ".mjs");
    fs.writeFileSync(file, `const __stubget__={get:()=>(()=>({}))};\n` + stubOf(names));
    stubMap[spec] = file;
  }
  const loaderFile = path.join(stubDir, "loader.mjs");
  fs.writeFileSync(
    loaderFile,
    `import { pathToFileURL } from "node:url";\n` +
      `const map = ${JSON.stringify(stubMap)};\n` +
      `export async function resolve(s, c, n) {\n` +
      `  if (map[s]) return { url: pathToFileURL(map[s]).href, shortCircuit: true, format: "module" };\n` +
      `  return n(s, c);\n}\n`,
  );
  const { register } = await import("node:module");
  register(new URL(`file://${loaderFile.replace(/\\/g, "/")}`).href, import.meta.url);

  try {
    const mod = await import(pathToFileURL(path.join(SRC, "lib", "providers", "trae", "index.js")).href);
    ok("真实 trae provider 模块求值成功（真 schemastery + stub 宿主包）", () => {
      if (!mod) throw new Error("空模块");
    });
  } catch (e) {
    failed++;
    console.error(`FAIL 真实 trae provider 模块求值\n  ${e && e.message}`);
  }
  fs.rmSync(stubDir, { recursive: true, force: true });
} else {
  skip("真实 provider 模块求值", "未加 --installed（需宿主 profile 的 schemastery 在解析链上）");
}

console.log(`\nverify-provider-config-schema: ${passed} 通过 / ${failed} 失败 / ${skipped} 跳过  [src=${SRC}]`);
process.exitCode = failed ? 1 : 0;
