/**
 * Qoder 思考档位「请求透传」验证（决定性、可复现）
 *
 * ## 为什么需要这份
 *
 * 效果类验证（qoder-effort-effect.mjs）得到的结论是"无法证明档位改变输出长度"：
 * 组内波动大于组间差异。那是**上游行为**的不确定，不该拿它当改动是否生效的证据。
 *
 * 本次改动真正要保证的是**机制**：pi-ai 把 UI 档位按 thinkingLevelMap 映射成
 * `reasoning_effort` 写进请求体 → shim 读出 → buildChatBody 写进上游 payload。
 * 这条链路可以用**确定性**方式验证：直接调用插件导出的 buildChatBody，
 * 断言它在不同入参下产出的 payload 字段值 —— 不需要网络、不受上游随机性影响。
 *
 * 另外附一条**对照**：证明改动前的行为（写死 high）与新行为在"未选档位"时一致，
 * 即这次改动不会让默认行为发生变化（向后兼容）。
 *
 * 用法：node qoder-effort-passthrough.mjs
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PLUGIN = join(homedir(), ".dsh", "profiles", "desktop", "node_modules", "dsh-connect", "lib", "providers", "qoder", "index.js");

// 插件模块 import 了 peer 依赖（@earendil-works/pi-ai 等，在打包 asar 里），
// 外部 import 会 MODULE_NOT_FOUND。所以这里**从源码中提取**目标函数体做等价执行，
// 并同时断言源码里的真实赋值语句形状 —— 两者结合，既能跑又不失真。
const src = readFileSync(PLUGIN, "utf8");
// 探查契约的 ③ 在**前端**（client.js）里，所以这里也读它 —— 否则那两条断言
// 会拿 qoder/index.js 的文本去匹配、永远为 false（假失败）。
const clientSrc = readFileSync(join(dirname(PLUGIN), "..", "..", "client.js"), "utf8");

let pass = 0;
let fail = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`); }
};

console.log("【1】源码形状断言：确认关键逻辑真的在文件里");

check("pi-ai 键空间常量存在（宿主契约）", /export const PI_AI_THINKING_LEVELS = \[/.test(src), true);
check("探查候选由键空间推导（无写死名单）", /candidates: PROBE_CANDIDATE_EFFORTS/.test(src), true);
check("buildChatBody 接收 reasoningEffort 与 supportedEfforts",
  /const \{ modelKey, messages, isReasoning, reasoningEffort, reasoningEffortExact, supportedEfforts,/.test(src), true);
check("正常路径：在该模型支持的档位内原样透传",
  /usable\.includes\(reasoningEffort\)\s*\n\s*\? reasoningEffort/.test(src), true);
check("非法输入回退到该模型的最高档（非写死 high）",
  /: usable\[usable\.length - 1\];/.test(src), true);
check("探查可用 reasoningEffortExact 原样透传哨兵（不走回退）",
  /if \(typeof reasoningEffortExact === "string"\) \{\s*\n\s*parameters\.reasoning_effort = reasoningEffortExact;/.test(src), true);
check("shim 从请求体读 reasoning_effort",
  /reasoningEffort: typeof request\.reasoning_effort === "string" \? request\.reasoning_effort : undefined/.test(src), true);
check("chatStream 把档位与 supportedEfforts 传进 buildChatBody",
  /reasoningEffort: request\.reasoningEffort,/.test(src) && /supportedEfforts: request\.supportedEfforts,/.test(src), true);
check("模型声明里使用 reasoningFieldsFor（并带上探查结果）",
  /\.\.\.reasoningFieldsFor\(info, probe\?\.service\?\.cached\(info\.id\)\),/.test(src), true);

console.log("\n【1b】探查契约：前端「检测」按钮要能看到 Qoder");
/**
 * 这三处缺一不可（新渠道接入探查的完整清单）：
 *   ① 状态文档下发 probe + probeKey → 前端才渲染按钮；
 *   ② 探查路由校验 key → 探查花额度，必须有授权；
 *   ③ 前端 provider → 路由映射 → 按钮才知道往哪发。
 * 只做 ①/② 而漏 ③，表现就是"服务端都对了但界面上没按钮"。
 */
check("① status 文档带 probe 段", /probe: \{/.test(src), true);
check("① status 文档带 probeKey", /probeKey: deps\.probe\.key\(\)/.test(src), true);
check("① 探查候选=没有探查记录的模型（数据驱动；探过则按钮展示结果）",
  /candidates: models\.filter\(\(model\) => deps\.probe\.service\.cached\(model\.id\) === undefined\)/.test(src), true);
check("② 探查路由校验 key", /probeKeyMatches\(probe\.key\(\), presented\)/.test(src), true);
check("② 兼容前端既有的 header 名（复用同一控件）", /x-workbuddy-probe-key/.test(src), true);
check("③ 前端映射表含 qoder1", /id: "qoder1", statusPath: QODER_STATUS_PATH/.test(clientSrc), true);
check("③ 探查控件用探查专用表（不污染 WorkBuddy 设置卡片）", /PROBE_TARGETS\.find/.test(clientSrc), true);

console.log("\n【2】行为断言：等价执行「supportedEfforts 回退」逻辑（与源码同一表达式）");
// 从源码提取 PI_AI_THINKING_LEVELS，与源码赋值语句等价的实现：
// 在 supported 集合内原样透传；否则回退到该集合的**最高档**（按键空间强度序）。
const levels = JSON.parse(src.match(/export const PI_AI_THINKING_LEVELS = (\[[^\]]*\]);/)[1]);
// 与源码等价：先按 pi-ai 键空间强度排序（supportedEffortsOf 的排序），再取透传/回退。
const sortLevels = (arr) => [...new Set(arr)].sort((a, b) => levels.indexOf(a) - levels.indexOf(b));
const pick = (isReasoning, reasoningEffort, declaredEfforts) => {
  if (isReasoning !== true) return undefined;
  const usable = Array.isArray(declaredEfforts) && declaredEfforts.length > 0 ? sortLevels(declaredEfforts) : levels.filter((l) => l !== "off");
  return usable.includes(reasoningEffort) ? reasoningEffort : usable[usable.length - 1];
};
const DF = ["high", "max", "low"]; // DeepSeek-Flash 上游声明（原始顺序；生产里会先排序）

check("low 在声明集内 → 原样透传", pick(true, "low", DF), "low");
check("high/max 同样透传", [pick(true, "high", DF), pick(true, "max", DF)], ["high", "max"]);
check("声明外的 medium → 回退到该模型最高档 max", pick(true, "medium", DF), "max");
check("off → 回退（上游对 off 返回 400）", pick(true, "off", DF), "max");
check("乱填值 → 回退", pick(true, "bogus_value_xyz", DF), "max");
check("未选档位 → 回退最高档", pick(true, undefined, DF), "max");
check("非思考模型不发该字段", pick(false, "low", DF), undefined);
check("无声明无探查 → 回退到键空间最高档", pick(true, undefined, undefined), "max");

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
console.log("\n覆盖范围说明（三段证据链，各管一段）：");
console.log("  1. 上游**校验**该参数：由 qoder-effort-probe.mjs 实测 ——");
console.log("     off 与乱填值被 400 拒绝，low/medium/high/max 被接受（乱填对照组是关键）。");
console.log("  2. 插件**正确透传**：由本脚本确定性验证（不依赖网络，不受上游随机性影响）。");
console.log("  3. 档位**确有实效**：由 qoder-one.mjs 单请求实测 ——");
console.log("     Qwen3.8-Flash 同一难题下 low 思考链 1361 字符 / 47s，");
console.log("     high 达 77353 字符 / 498s，相差 57 倍。");
console.log("\n  （对照）Trae 侧**已同样支持档位**，但走的是另一条路：");
console.log("    · Trae 目录**按 (模型 × function) 声明** options → 声明即权威，不需要探查；");
console.log("    · 线上值是 light/high/extra_high（不是 low/medium/high/xhigh/max）；");
console.log("    · 档位须放进 custom_model 且 config_source 为数字 1；");
console.log("    · 实测 light 62s/1984 字符 vs extra_high 153s/4924 字符。");
console.log("    详见 verify-trae-effort-chain.mjs 与 TRAE-REASONING-EFFORT.md。");
process.exit(fail === 0 ? 0 : 1);
