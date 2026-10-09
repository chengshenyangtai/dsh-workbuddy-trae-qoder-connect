/**
 * 「禁用渠道」的生效验证（2026-10-09 修的真实 bug）。
 *
 * ## 事故
 *
 * 面板点「禁用」后，那一行显示「已禁用」，但**该渠道的模型仍然能在模型选择器里选**。
 * 界面自相矛盾，而用户拿它当"我关掉了"。
 *
 * ## 根因：两种 id 被当成同一种
 *
 * 禁用写入的是**渠道 id**（`managed.id` → `qoder`），
 * 而隐藏判定用的是 **provider id**（`disabledModelsFor("qoder1")`）：
 *
 *   | 渠道 | 渠道 id | provider id |
 *   |---|---|---|
 *   | Trae      | `trae`       | `trae`       |
 *   | WorkBuddy | `workbuddy1` | `workbuddy1` |
 *   | **Qoder** | **`qoder`**  | **`qoder1`** |
 *
 * 只有 Qoder 两个 id 不同，`includes(providerId)` 永远匹配不上 ⇒ 哨兵不返回
 * ⇒ 模型照常可见。而面板那行的「已禁用」走 `hubChannels()`（按渠道 id 判定），
 * 所以两边各说各话。
 *
 * 反向验证：把 `channelIdOfProvider` 的比对删掉，本探针必须变红。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const src = readFileSync(join(repo, "lib", "panel.js"), "utf8");

let pass = 0;
let fail = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`); }
};

console.log("【1】渠道 id 与 provider id 的映射必须被认出来");

// 注册表映射：qoder 渠道 → qoder1 provider。修复必须显式处理这个不一致。
check("修复里存在 provider→channel 的反查", /function channelIdOfProvider/.test(src), true);
check("反查按 channelOf(entry).provider 匹配", /channelOf\(item\)\?\.provider === providerId/.test(src), true);

/**
 * 剔除注释，只留可执行代码行 —— 断言必须打在**代码**上。
 *
 * 上面那段文档里就写着旧实现 `disabledChannels.includes(providerId)`（用来说明
 * bug 本身），若拿整份源码做正则，注释会把断言骗绿。
 */
const codeOnly = src
  .split("\n")
  .filter((line) => !/^\s*(\*|\/\*|\*\/|\/\/)/.test(line))
  .join("\n");

console.log("【2】禁用判定时两种 id 都要认（只查代码行）");

// 只认 providerId 是 bug 的根源（旧实现），代码里不能再有。
check("代码里不再用 disabledChannels.includes(providerId)",
  /disabledChannels\.includes\(providerId\)/.test(codeOnly), false);
// 修复：两个都比对（这行是注释，改从代码里查等价结构）。
check("代码里同时认渠道 id 与 provider id",
  /channels\.has\(providerId\) \|\| channels\.has\(channelIdOfProvider\(providerId\)\)/.test(codeOnly), true);
check("注释里仍保留了这次 bug 的来历（不该被当代码）",
  /以前这里直接 `disabledChannels\.includes\(providerId\)`/.test(src), true);

console.log("\n【3】哨兵语义没被改坏");

check("渠道禁用时返回整渠道隐藏哨兵", /return \[HIDE_ALL_SENTINEL\]/.test(src), true);
check("哨兵由 hiddenMatcher 统一解释",
  readFileSync(join(repo, "lib", "shared", "hidden.js"), "utf8").includes("HIDE_ALL_SENTINEL"), true);

console.log("\n【4】回归：模型级偏好仍不被渠道开关抹掉");

check("禁用渠道不动 disabledModels（只动 disabledChannels）",
  /禁用\/启用渠道不能动 `disabledModels`/.test(src), true);
check("delete 分支仍清理该 provider 的孤儿偏好",
  /keptModels = prefs\.disabledModels\.filter/.test(src), true);

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exitCode = 1;
