/**
 * Trae 档位链路离线验证（确定性，不依赖 DSH 重启、不打上游）
 *
 * 验证三段：
 *   1. `reasoningFieldsFor(info, fn)` 按 function 产出正确的 thinkingLevelMap；
 *   2. 反向映射（pi-ai 档位 → Trae 线上值）正确；
 *   3. chatStream 的 payload 形状：档位确实挂在 custom_model 里，且 config_source 是数字 1。
 *
 * 做法：从源码中提取这些函数/常量做等价执行（trae/index.js 依赖打包在 asar 里的
 * peer，外部 import 会 MODULE_NOT_FOUND），同时断言源码里的关键语句形状。
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SRC = join(homedir(), ".dsh", "profiles", "desktop", "node_modules", process.env.DSH_CONNECT_DIR ?? "dsh-connect", "lib", "providers", "trae", "index.js");
const src = readFileSync(SRC, "utf8");
const CATALOG = JSON.parse(readFileSync(join(homedir(), ".dsh", "trae", "models.json"), "utf8"));

let pass = 0;
let fail = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`); }
};

console.log("【1】源码形状断言");
check("默认 function 已切到 solo_agent_lite", /const DEFAULT_FUNCTION = "solo_agent_lite"/.test(src), true);
check("档位映射常量存在", /const TRAE_EFFORT_TO_LEVEL = \{/.test(src), true);
check("catalog 保留 reasoningByGroup", /reasoningByGroup: m\.reasoningByGroup/.test(src), true);
check("reasoningFieldsFor 按 function 取配置", /const cfg = byGroup !== undefined && typeof byGroup === "object" \? byGroup\[fn\] : undefined/.test(src), true);
check("buildModels 接入档位声明", /\.\.\.reasoningFieldsFor\(info, fn\)/.test(src), true);
check("payload 带 custom_model", /payload\.custom_model = \{/.test(src), true);
check("config_source 是数字 1", /config_source: 1,/.test(src), true);
check("档位字段名 reasoning_effort_level", /reasoning_effort_level: body\.effort,/.test(src), true);
check("shim 做反向映射（查表而非 switch）", /LEVEL_TO_TRAE_EFFORT\.get\(level\)/.test(src), true);
check("映射表是唯一事实来源（正向声明也用它）", /Object\.entries\(TRAE_EFFORT_TO_LEVEL\)/.test(src), true);
/**
 * 接线完整性：`buildModels` 要按当前 function 取档位，就会调用 `options.settings()`，
 * 因此 adapter 的**调用处必须把 settings 传进来**。漏传会让 `buildModels()` 抛
 * TypeError → provider 没有任何模型 → 表现为「渠道在模型选择器里消失」。
 * 该 bug 真实发生过（2026-10-06），在此钉死以防复发。
 */
check("adapter 调用处传入了 settings（漏传会让渠道在选择器里消失）",
  // 允许多行实参：这个调用点为加 resolveAttachments 已展开成多行，只认单行写法
  // 会把「一次代码格式化」变成假失败 —— 而漏传 settings 的后果是真的渠道消失。
  /createTraeAdapter\(\{[\s\S]{0,400}?\bsettings\b/.test(src), true);

console.log("\n【2】reasoningFieldsFor：按 function 产出档位");
// 提取并等价执行。注意该函数现在依赖模块级常量 TRAE_EFFORT_TO_LEVEL，
// 所以要把那张表一起注入（只提函数体已经跑不通 —— 这是重构后的必然变化）。
const tableSrc = src.match(/const TRAE_EFFORT_TO_LEVEL = \{[\s\S]*?\n\};/)[0];
const fnBody = src.match(/function reasoningFieldsFor\(info, fn\) \{[\s\S]*?\n  \}/)[0];
const reasoningFieldsFor = new Function(
  "info", "fn",
  `${tableSrc}\n${fnBody.replace(/^function reasoningFieldsFor\(info, fn\) \{/, "").replace(/\n  \}$/, "")}`,
);

const model = CATALOG.models.find((m) => m.id === "deepseek-v4.1-flash");
check("agent_lite 下：reasoning=true", reasoningFieldsFor(model, "solo_agent_lite").reasoning, true);
check("agent_lite 下的档位映射", reasoningFieldsFor(model, "solo_agent_lite").thinkingLevelMap,
  { low: "light", high: "high", xhigh: "extra_high" });
check("work_lite 下：reasoning=false（该槽位确实没档位）", reasoningFieldsFor(model, "solo_work_lite").reasoning, false);

// 两档模型：GLM-5.2 只有 high/extra_high
const glm52 = CATALOG.models.find((m) => m.id === "glm-5.2");
const glmMap = reasoningFieldsFor(glm52, "solo_agent_lite");
check("GLM-5.2 只有高/极高（low 为 null）", glmMap.thinkingLevelMap, { low: null, high: "high", xhigh: "extra_high" });

// 不支持档位的模型
const noEffort = CATALOG.models.find((m) => m.id === "kimi-k2.6");
check("不支持档位的模型 reasoning=false", reasoningFieldsFor(noEffort, "solo_agent_lite").reasoning, false);

console.log("\n【3】反向映射：pi-ai 档位 → Trae 线上值");
const reverseSrc = src.match(/const LEVEL_TO_TRAE_EFFORT = new Map\([\s\S]*?\n\);/)[0];
const toTrae = (level) => {
  const decode = new Function("request", `${tableSrc}\n${reverseSrc}\nconst level = request.reasoning_effort;\nreturn level === undefined ? undefined : LEVEL_TO_TRAE_EFFORT.get(level);`);
  return decode({ reasoning_effort: level });
};
check("low → light", toTrae("low"), "light");
check("high → high", toTrae("high"), "high");
check("xhigh → extra_high", toTrae("xhigh"), "extra_high");
check("medium → undefined（Trae 无此档）", toTrae("medium"), undefined);
check("max → undefined（Trae 无此档）", toTrae("max"), undefined);
check("未选择 → undefined（走服务端默认）", toTrae(undefined), undefined);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
console.log("\n说明：本脚本验证「声明 + 映射 + payload 形状」（确定性、不打上游）；");
console.log("上游实效由 trae-effort-full.mjs 实测对照得出（含 config_source 类型对照）。");
process.exit(fail === 0 ? 0 : 1);
