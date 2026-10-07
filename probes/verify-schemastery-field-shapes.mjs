#!/usr/bin/env node
// probes/verify-schemastery-field-shapes.mjs
// 把「provider 配置字段用到的每个 schemastery 调用形状」钉死在宿主的真包里。
//
// 与 verify-provider-config-schema.mjs 的分工：那个管「源码不许出现 z.enum」+
// 真模块能求值；这个管**逐个字段形状**：只要有人在模块顶层写了
// 宿主 schemastery 不支持的链式调用（.optional / .integer / .trim / .enum …），
// 这里立刻变红，而不是等到重启后整条渠道静默消失。
//
// 用法：node probes/verify-schemastery-field-shapes.mjs
// 找不到宿主真包时 SKIP（非 dsh 桌面环境），不误报失败。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

// —— 解析宿主真实 schemastery ——
function resolveRealSchemastery() {
  const dir = path.join(os.homedir(), ".dsh", "profiles", "desktop", "node_modules", "@deepseek-ai", "schemastery");
  const pkgPath = path.join(dir, "package.json");
  if (!fs.existsSync(pkgPath)) return null;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  let entry = pkg.exports?.["."] ?? pkg.main ?? "index.js";
  if (typeof entry === "object" && entry !== null) {
    entry = entry.import ?? entry.module ?? entry.default ?? Object.values(entry).find((v) => typeof v === "string");
  }
  if (typeof entry !== "string") return null;
  entry = entry.replace(/^\.\//, "");
  const asEsm = entry.replace(/\.cjs$/, ".mjs");
  for (const cand of [asEsm, entry]) {
    const file = path.join(dir, cand);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

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

// —— 1) 从源码里收集 provider 实际用到的 z.<method>() 与链式方法 ——
const FILES = [
  "lib/providers/trae/index.js",
  "lib/providers/qoder/index.js",
  "lib/providers/workbuddy/index.js",
  "lib/panel.js",
];

const used = new Map(); // key -> rel:line（首次出现位置，便于报错定位）
const usedAt = (key, rel, line) => {
  if (!used.has(key)) used.set(key, `${rel}:${line}`);
};
for (const rel of FILES) {
  const abs = path.join(REPO, rel);
  if (!fs.existsSync(abs)) continue;
  const src = fs.readFileSync(abs, "utf8");
  const lineOf = (index) => src.slice(0, index).split("\n").length;
  // 注释行不算：修复注释里会直接写 z.enum 字样，扫描器不能自己抓自己
  const commentLines = new Set(
    src
      .split("\n")
      .map((l, i) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? i + 1 : -1))
      .filter((n) => n > 0),
  );
  for (const m of src.matchAll(/\bz\.([A-Za-z][\w]*)\s*\(/g)) {
    const ln = lineOf(m.index);
    if (!commentLines.has(ln)) usedAt(`z.${m[1]}`, rel, ln);
  }
  // 链式方法：出现在 `= z.` 起头的字段表达式里的 .<m>(
  for (const m of src.matchAll(/=\s*z\.[\w.()[]'",\s]*?\)/gs)) {
    const ln = lineOf(m.index);
    if (commentLines.has(ln)) continue;
    for (const chain of m[0].matchAll(/\.([A-Za-z][\w]*)\s*\(/g)) usedAt(`.${chain[1]}`, rel, ln);
  }
}

const SCHEMA_FILE = resolveRealSchemastery();
if (!SCHEMA_FILE) {
  console.log(`SKIP 宿主 schemastery 契约断言（未找到宿主真包）；源码扫描到 ${used.size} 种调用形状`);
} else {
  const { default: z } = await import(pathToFileURL(SCHEMA_FILE).href);

  // —— 2) 每个 z.<method> 必须存在于宿主包 ——
  for (const [key, at] of [...used].filter(([k]) => k.startsWith("z.")).sort()) {
    const name = key.slice(2);
    ok(`宿主 schemastery 提供 z.${name}（源码 ${at}）`, () => {
      if (typeof z[name] !== "function") throw new Error(`z.${name} 不是函数（typeof=${typeof z[name]}）`);
    });
  }

  // —— 3) 每个链式方法必须能在对应叶子类型上调用 ——
  // 叶子类型取 string / number / boolean / array / object / union 逐个试，
  // 只要有一种叶子类型能接住这个方法就算通过（不同字段用不同叶子）。
  const leafFactories = {
    string: () => z.string(),
    number: () => z.number(),
    boolean: () => z.boolean(),
    array: () => z.array(z.string()),
    object: () => z.object({ a: z.string() }),
    union: () => z.union([z.const("cn"), z.const("solo")]),
  };
  for (const [key, at] of [...used].filter(([k]) => k.startsWith(".")).sort()) {
    const name = key.slice(1);
    ok(`链式 .${name}() 至少在一种叶子类型上可调用（源码 ${at}）`, () => {
      const errs = [];
      for (const [lname, mk] of Object.entries(leafFactories)) {
        try {
          const leaf = mk();
          if (typeof leaf[name] !== "function") {
            errs.push(`${lname}:无此方法`);
            continue;
          }
          if (name === "default") return; // 存在性检查即可，值随字段而变
          const arg = name === "description" ? "d" : 1;
          leaf[name](arg);
          return; // 有一种成功即可
        } catch (e) {
          errs.push(`${lname}:${e.message.split("\n")[0]}`);
        }
      }
      throw new Error(`所有叶子类型都拒绝 .${name}() -> ${errs.slice(0, 3).join(" | ")}`);
    });
  }

  // —— 4) 明确钉死：schemastery 没有 z.enum，产品线这类可选值必须用 union-of-const ——
  ok("宿主 schemastery 不提供 z.enum（若已提供，请改用原生并更新本探针）", () => {
    if (typeof z.enum === "function") throw new Error("宿主已提供 z.enum，源码应改回 z.enum 并删掉本断言");
  });
  ok("z.union([z.const('cn'), z.const('solo')]) 是 PRODUCT_FIELD 的正确形状", () => {
    const json = JSON.parse(JSON.stringify(z.union([z.const("cn"), z.const("solo")]).description("p")));
    const refs = Object.values(json.refs ?? {});
    if (!refs.some((r) => r.type === "union")) throw new Error("不是 union schema");
    const consts = refs.filter((r) => r.type === "const").map((r) => r.value);
    for (const want of ["cn", "solo"]) {
      if (!consts.includes(want)) throw new Error(`union 缺成员 ${want}`);
    }
  });
}

// —— 5) 源码里绝不允许出现 z.enum( ——
const hits = [];
for (const rel of FILES) {
  const abs = path.join(REPO, rel);
  if (!fs.existsSync(abs)) continue;
  for (const [i, line] of fs.readFileSync(abs, "utf8").split("\n").entries()) {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*")) continue;
    if (/(^|[^.\w])z\.enum\s*\(/.test(line)) hits.push(`${rel}:${i + 1}`);
  }
}
ok("源码中不存在 z.enum( 调用", () => {
  if (hits.length) throw new Error(`发现 z.enum: ${hits.join(", ")}`);
});

console.log(`\nverify-schemastery-field-shapes: ${passed} 通过 / ${failed} 失败  [扫描到 ${used.size} 种调用形状]`);
process.exitCode = failed ? 1 : 0;
