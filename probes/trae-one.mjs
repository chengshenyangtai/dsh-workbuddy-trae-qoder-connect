/**
 * Trae 思考档位「效果对照」—— 单请求版
 *
 * ## 为什么还要测效果
 *
 * `trae-effort-probe.mjs` 只证明了 Trae 上游**不校验** `reasoning_effort`
 * （乱填值同样被接受）。但"不校验"**不等于"无效果"** —— 有些服务端照单全收，
 * 却只认某一个值。所以必须再测一次效果，才能断定"Trae 加档位有没有意义"。
 *
 * ## 从 Qoder 那次实验学到的三条（直接照搬到本脚本）
 *
 * 1. **一次一个请求**：批量串行会把"模型耗时长"和"上游限流"混在一起，无法归因；
 * 2. **超时给足**（默认 600s）：高档位可能就是慢，把"慢"当"失败"会得出错误结论；
 * 3. **原始数据落 JSONL**：统计口径可以事后修正，不必重发请求。
 *
 * ## 观测口径
 *
 * 思考链取自 SSE 的 `event: output` 里的 `data.reasoning_content`
 * （正文是 `data.response`）—— 与插件 `trae/index.js:626-632` 的解析一致。
 *
 * 用法：
 *   node trae-one.mjs <档位> [模型]     # 发一个请求
 *   node trae-one.mjs --report          # 只统计已落盘数据
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const OUT = join(homedir(), ".dsh", "patches", "dsh-connect-desktop", "probes", "trae-effort-samples.jsonl");
const cred = JSON.parse(readFileSync(join(homedir(), ".dsh", "connect-auth", "trae.json"), "utf8"));
const GATEWAY = (cred.gateway ?? "https://trae-api-cn.mchost.guru").replace(/\/+$/, "");
const ENDPOINT = `${GATEWAY}/api/agent/v3/llm_utils_chat`;

const PROMPT = process.env.TRAE_PROMPT
  ?? "证明 Ramsey 定理 R(3,3)=6：任意 6 人中必有 3 人互相认识或 3 人互相不认识。要求：(1) 用反证法给出完整严格证明；(2) 说明为什么 5 人时结论不成立并构造反例；(3) 讨论 R(3,3) 与 R(3,4)、R(4,4) 的关系及已知上下界。";

/** 统计已落盘样本（不发请求）。 */
function report() {
  if (!existsSync(OUT)) { console.log(`还没有样本文件：${OUT}`); return; }
  const rows = readFileSync(OUT, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
  console.log(`样本总数 ${rows.length}\n`);
  console.log("档位      样本  成功  思考链(各次)                  中位数   耗时(各次)");
  const by = {};
  for (const r of rows) (by[r.effort] ??= []).push(r);
  const med = (xs) => { const a = [...xs].sort((x, y) => x - y); return a.length === 0 ? undefined : a.length % 2 ? a[(a.length - 1) / 2] : Math.round((a[a.length / 2 - 1] + a[a.length / 2]) / 2); };
  const meds = {};
  // 档位顺序：基线在前，其余按 Trae 词表阶梯排；未列出的（探针新增值）追加在后面。
  // 之前硬编码列表会把 extra_high 这类新测的档位**静默漏掉**，看着像"没测过"。
  const order = ["__none__", "light", "low", "medium", "high", "extra_high", "xhigh", "max"];
  const keys = [...order.filter((e) => by[e] !== undefined), ...Object.keys(by).filter((e) => !order.includes(e))];
  for (const e of keys) {
    const g = by[e];
    const ok = g.filter((r) => r.http === 200);
    const lens = ok.map((r) => r.reasonLen);
    meds[e] = med(lens);
    console.log(`${e.padEnd(11)} ${String(g.length).padEnd(6)} ${String(ok.length).padEnd(6)} ${(lens.join(" / ") || "-").padEnd(30)} ${String(med(lens) ?? "-").padEnd(8)} ${ok.map((r) => (r.ms / 1000).toFixed(0) + "s").join(" / ")}`);
  }
  const vals = Object.values(meds).filter((v) => v !== undefined);
  if (vals.length >= 2) {
    const between = Math.max(...vals) - Math.min(...vals);
    const sds = [];
    for (const e of Object.keys(meds)) {
      const a = (by[e] ?? []).filter((r) => r.http === 200).map((r) => r.reasonLen);
      if (a.length < 2) continue;
      const m = a.reduce((x, y) => x + y, 0) / a.length;
      sds.push(Math.round(Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1))));
    }
    const within = sds.length ? Math.round(sds.reduce((a, b) => a + b, 0) / sds.length) : 0;
    console.log(`\n组间极差 = ${between}    组内标准差均值 = ${within}${sds.length ? "" : "（每档仅 1 个样本，无法估计组内波动）"}`);
    if (between >= 5000) console.log("→ 差异量级远大于合理噪声：档位可能**确有实效**（需补重复样本确认）。");
    else if (sds.length && between <= within) console.log("→ 组间差异 ≤ 组内波动：此数据不足以证明档位有效。");
    else console.log("→ 尚不足以判断，建议补样本。");
  }
}

const [, , argEffort, argModel] = process.argv;
if (argEffort === "--report" || argEffort === undefined) { report(); process.exit(0); }

const EFFORT = argEffort;
const MODEL = argModel ?? process.env.TRAE_MODEL ?? "deepseek-v4.1-flash";
const TIMEOUT_MS = Number(process.env.TRAE_TIMEOUT_MS ?? 600000);

const id = `probe-${Date.now()}`;
const payload = {
  app_id: cred.appId,
  app_version_code: cred.appVersionCode,
  function: "solo_work_lite",
  model_name: MODEL,
  // content 必须是数组（字符串会被上游 400，见 trae-effort-probe.mjs 的踩坑记录）。
  messages: [{ role: "user", content: [{ type: "text", text: PROMPT }] }],
  max_tokens: 32000,
  stream: true,
};
/**
 * 档位字段。`__none__` = 不发（注意：**不能拿它当档位对照**，网关会对缺省兜底）。
 *
 * ⚠️ **字段名很关键，我踩过坑**：Trae 客户端（`@byted-icube/ai-modules-chat`）里是
 * 按一个布尔开关二选一发的：
 *
 *   reasoning_effort:       o ? r : void 0,
 *   reasoning_effort_level: o ? void 0 : r       // o 默认 false
 *
 * 也就是说**默认路径发的是 `reasoning_effort_level`**，而 `reasoning_effort` 只在
 * 特定开关下才用。我最初只发 `reasoning_effort`，等于测了个不被采用的字段 ——
 * 这正是"传了没反应"的可能原因。所以这里两个都发，确保覆盖真实路径。
 *
 * 词表也照抄客户端（i18n 显示名 → 线上值）：
 *   light → "Low" / low → "Low" / medium → "Medium" / high → "High" /
 *   extra_high·xhigh → "Extra high" / max → "Max"
 */
if (EFFORT !== "__none__") {
  payload.reasoning_effort = EFFORT;
  payload.reasoning_effort_level = EFFORT;
}

/**
 * 显式思考开关（`THINK=on|off`，缺省不发）。
 *
 * 为什么单独加：Trae 的模型目录里带着 `thinking_enable` / `reasoning_effort_config`
 * 字段，说明"要不要思考"与"思考多深"可能是**两个独立开关**。之前我只动
 * `reasoning_effort` 而从不显式开思考，等于把"开不开思考"交给网关兜底 ——
 * 那样即便档位有效，也可能因兜底把差异抹平。要判断档位，必须先固定思考开关。
 */
const THINK = process.env.TRAE_THINK;   // "on" | "off" | undefined
if (THINK === "on" || THINK === "off") {
  payload.thinking_enable = THINK === "on";
  payload.enable_thinking = THINK === "on";   // 两种拼写都发，看上游认哪个
}

const t0 = Date.now();
let record;
try {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Cloud-IDE-JWT ${cred.token}`,
      "x-ide-token": cred.token,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  const ms = Date.now() - t0;
  /**
   * 解析 Trae 的 SSE：事件形如 `event: output` + `data: {...}`，
   * 思考链在 `data.reasoning_content`，正文在 `data.response`。
   */
  let reasonLen = 0;
  let contentLen = 0;
  let events = 0;
  for (const block of text.split(/\n\n+/)) {
    const dataLine = block.split(/\r?\n/).find((l) => l.startsWith("data:"));
    if (dataLine === undefined) continue;
    let data;
    try { data = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
    events += 1;
    if (typeof data?.reasoning_content === "string") reasonLen += data.reasoning_content.length;
    if (typeof data?.response === "string") contentLen += data.response.length;
  }
  record = { at: new Date().toISOString(), effort: EFFORT, think: THINK ?? "(未显式)", model: MODEL, http: res.status, ms, reasonLen, contentLen, events, bytes: text.length };
  console.log(`effort=${EFFORT.padEnd(9)} think=${String(THINK ?? "(未显式)").padEnd(9)} http=${res.status}  耗时=${(ms / 1000).toFixed(1)}s  思考链=${reasonLen}  正文=${contentLen}  事件=${events}`);
} catch (error) {
  record = { at: new Date().toISOString(), effort: EFFORT, think: THINK ?? "(未显式)", model: MODEL, http: 0, ms: Date.now() - t0, reasonLen: 0, contentLen: 0, events: 0, bytes: 0, note: String(error?.message ?? error).slice(0, 120) };
  console.log(`effort=${EFFORT.padEnd(9)} 失败：${record.note}（耗时 ${(record.ms / 1000).toFixed(1)}s）`);
}
appendFileSync(OUT, `${JSON.stringify(record)}\n`, "utf8");
console.log(`已追加样本 → ${OUT}`);

/**
 * ## 实测结论（2026-10-06）：Trae 不认 reasoning_effort，**不要做这个功能**
 *
 * 有效对照（都显式传值，同一难题 deepseek-v4.1-flash）：
 *
 * | 用例 | 耗时 | 思考链字符 |
 * |---|---|---|
 * | low | 257.9s | 11,386 |
 * | max | 291.7s | 10,444 |
 *
 * low 与 max 几乎相同（差 942，8% 波动）。对照 Qoder 那边：low 1,361 vs
 * high 77,353，**相差 57 倍**。所以 Trae 侧该字段被忽略，加档位没有意义。
 *
 * ## ⚠️ 两个被我搞错的推理（别重犯）
 *
 * 1. **「乱填值也被接受」不能推出「上游不校验/无效果」**。
 *    服务端可以忽略未知值、但认已知值（Qoder 严格校验，Trae 宽松忽略，
 *    两者都是常见实现）。宽松 ≠ 无效，必须另测效果。
 *
 * 2. **「基线（不发该字段）」不能当对照** —— 网关会对缺省做**兜底**，
 *    所以基线拿到的是"服务端默认档位"，与显式 low 不可比。我自己就用这个
 *    错误对照得出过"low 比基线还长 → 档位无效"的结论，方向虽对、论据无效。
 *    正确对照只能两端都显式传值：low vs max（或 high）。
 *
 * （`__none__` 基线仍有价值：用来确认请求形状正确、解析口径通，不用于比档位。）
 */

/**
 * ## 补充实测（2026-10-06）：用**正确字段名与词表**重测，结论不变 —— Trae 不认档位
 *
 * 从 Trae 客户端本体（`D:\TRAE SOLO CN\...\@byted-icube\ai-modules-chat\dist\index.mjs`）
 * 挖出两个关键事实，纠正了我最初的探针：
 *
 * 1. **字段名是二选一的**（同一份源码里）：
 *      reasoning_effort:       o ? r : void 0,
 *      reasoning_effort_level: o ? void 0 : r      // o 默认 false
 *    即**默认路径发 `reasoning_effort_level`**。我最初只发 `reasoning_effort`，
 *    等于测了个不被采用的字段。现已两个都发。
 *
 * 2. **词表不是 low/medium/high/max**，客户端 i18n 显示名 → 线上值为：
 *      light → "Low" / low → "Low" / medium → "Medium" / high → "High" /
 *      extra_high·xhigh → "Extra high" / max → "Max"
 *    即 Trae 有自己的一套拼写（`light`、`extra_high`）。现已按此重测。
 *
 * ### 重测结果：仍无档位效应
 *
 * | 用例（均显式传值） | 耗时 | 思考链字符 |
 * |---|---|---|
 * | low | 257.9s | 11,386 |
 * | max | 291.7s | 10,444 |
 * | **extra_high**（最极端档，正确字段名） | 281.7s | **12,246** |
 *
 * 三档差异都在 ~1.8k 以内（≈15%），无单调关系；对比 Qoder 同法测得
 * low 1,361 vs high 77,353（**57 倍**）。故 Trae 侧该参数确实不起作用。
 *
 * ### 为什么 Trae 客户端本身也不给这些模型显示档位
 *
 * 客户端逻辑（同一份源码）：
 *   if (!r?.support_thinking || !Array.isArray(r.options) || r.options.length === 0) return [];
 * 而你导出的模型目录里 `reasoning_effort_config` 全是 `null` 或
 * `{support_thinking:false}`，**没有任何模型带 options** —— 所以客户端自己也不显示。
 * 三份证据（客户端不显示 / 上游不校验乱填值 / 实测无效果）互相印证。
 */
