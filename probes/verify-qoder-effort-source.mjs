/**
 * 验证档位解析的「并集语义」：上游声明 ∪ 探查实测。
 *
 * 为什么是并集而不是"谁优先"（2026-10-06 的实测教训）：
 *   · `qmodel`   声明为空、实测接受 5 档  → 只信声明会**丢**真实档位；
 *   · `dfmodel`  声明 3 档、实测接受 5 档  → "声明优先"会把实测的 2 档永远藏住；
 *   · `kmodel_latest` 声明 3 档、实测 non-validating → 只信实测会把 3 档**全丢**
 *     （non-validating 只说明"上游不校验"，不说明"档位无效"）。
 * 三个方向各错一次之后，结论只有一种：两个来源互补，取并集。
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LIB = join(homedir(), ".dsh", "profiles", "desktop", "node_modules", process.env.DSH_CONNECT_DIR ?? "dsh-connect", "lib");
const qoderSrc = readFileSync(join(LIB, "providers", "qoder", "index.js"), "utf8");

let pass = 0;
let fail = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`); }
};

// 提取两个函数（都保留完整函数定义，直接注入后调用 —— 剥外壳再包一层
// 曾把语句序列误当表达式，报 "Identifier 'set' has already been declared"）。
const PI = qoderSrc.match(/export const PI_AI_THINKING_LEVELS = \[[^\]]*\];/)[0].replace("export ", "");
const helper = qoderSrc.match(/export function supportedEffortsOf\(info, observed\) \{[\s\S]*?\n\}/)[0]
  .replace(/^export /, "");
const fnDef = qoderSrc.match(/function reasoningFieldsFor\(info, observed\) \{[\s\S]*?\n\}/)[0];
const reasoningFieldsFor = new Function("info", "observed", `${PI}\n${helper}\n${fnDef}\nreturn reasoningFieldsFor(info, observed);`);
const supportedEffortsOf = new Function("info", "observed", `${PI}\n${helper}\nreturn supportedEffortsOf(info, observed);`);

const levelsOf = (r) => (r.reasoning === false ? "NO_EFFORTS" : Object.entries(r.thinkingLevelMap)
  .filter(([, v]) => v !== null).map(([k, v]) => `${k}→${v}`).join(" "));

console.log("【1】只有声明（2026-10-06 实测目录值）");
check("dfmodel（is_reasoning=false 但声明 high/max/low）拿到档位",
  reasoningFieldsFor({ isReasoning: false, declaredEfforts: ["high", "max", "low"] }, undefined).reasoning, true);
check("dfmodel 的档位映射",
  levelsOf(reasoningFieldsFor({ isReasoning: false, declaredEfforts: ["high", "max", "low"] }, undefined)),
  "low→low high→high max→max");
check("qmodel_38max 拿到 xhigh（曾被误置 null）",
  levelsOf(reasoningFieldsFor({ isReasoning: true, declaredEfforts: ["xhigh", "low", "medium"] }, undefined)),
  "low→low medium→medium xhigh→xhigh");
check("dmodel 只给 high/max（不硬塞别的）",
  levelsOf(reasoningFieldsFor({ isReasoning: true, declaredEfforts: ["high", "max"] }, undefined)),
  "high→high max→max");

console.log("\n【2】只有实测（声明为空，探查 validating）");
check("qmodel 情形：声明空 + validating → 按实测给",
  levelsOf(reasoningFieldsFor({ isReasoning: true, declaredEfforts: [] }, { validation: "validating", efforts: ["low", "medium", "high", "max"] })),
  "low→low medium→medium high→high max→max");
check("实测 non-validating ≠ 不支持（kmodel_latest 情形：声明还在）",
  levelsOf(reasoningFieldsFor({ isReasoning: false, declaredEfforts: ["high", "low", "max"] }, { validation: "non-validating", efforts: [] })),
  "low→low high→high max→max");

console.log("\n【3】并集：实测比声明宽 → 补上；声明比实测宽 → 保住");
check("dfmodel 实测 5 档、声明 3 档 → 给 5 档（此前被藏住 2 档）",
  levelsOf(reasoningFieldsFor({ isReasoning: false, declaredEfforts: ["high", "max", "low"] }, { validation: "validating", efforts: ["minimal", "low", "medium", "high", "max"] })),
  "low→low medium→medium high→high max→max");
check("声明 3 档、实测只有 2 档 → 声明的仍保留",
  levelsOf(reasoningFieldsFor({ isReasoning: true, declaredEfforts: ["high", "max", "low"] }, { validation: "validating", efforts: ["low", "max"] })),
  "low→low high→high max→max");

console.log("\n【4】都没有 → 不给档位");
check("无声明且无探查 → reasoning:false", reasoningFieldsFor({ isReasoning: true, declaredEfforts: [] }, undefined).reasoning, false);
check("非思考模型且无声明 → reasoning:false", reasoningFieldsFor({ isReasoning: false, declaredEfforts: [] }, undefined).reasoning, false);
check("排序按强度递增", supportedEffortsOf({ declaredEfforts: ["max", "low"] }, { validation: "validating", efforts: ["xhigh", "medium"] }), ["low", "medium", "xhigh", "max"]);

console.log("\n【5】通用性：不允许写死档位名单");
check("探查候选=键空间推导（非写死 5 档）", /candidates: PROBE_CANDIDATE_EFFORTS/.test(qoderSrc), true);
check("候选含 xhigh（早期被硬编码挡掉）", /PROBE_CANDIDATE_EFFORTS = PI_AI_THINKING_LEVELS\.filter/.test(qoderSrc), true);
check("回退值来自 supportedEfforts（非写死 high）", /usable\[usable\.length - 1\]/.test(qoderSrc), true);
check("无写死的档位字面量白名单", !/ACCEPTED_REASONING_EFFORTS/.test(qoderSrc), true);
check("探查按钮=无记录的模型（数据驱动）", /probe\.service\.cached\(model\.id\) === undefined/.test(qoderSrc), true);

console.log("\n【6】接线完整性（曾因漏传/TDZ 出过问题）");
check("catalog 解析出 declaredEfforts", /declaredEfforts: thinking\.declared/.test(qoderSrc), true);
check("shim 判据含声明（非仅 isReasoning）", /supportsThinking \|\| probed \|\| entry\?\.isReasoning === true/.test(qoderSrc), true);
check("probe 用 setProbe 后挂（避开 TDZ）", /setProbe: \(next\) => \{ probe = next; \}/.test(qoderSrc), true);
check("shim 调 setProbe", /shim\.setProbe\?\.\(probe\)/.test(qoderSrc), true);
check("supportedEfforts 传入 buildChatBody", /supportedEfforts: request\.supportedEfforts/.test(qoderSrc), true);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
