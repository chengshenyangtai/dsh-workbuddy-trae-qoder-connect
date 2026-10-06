/**
 * Trae 思考档位：按**客户端真实结构**发请求
 *
 * ## 之前为什么一直测不出档位（三层原因，逐层挖出来的）
 *
 * 1. **值域错**：我用了 low/max/xhigh，而 Trae 的值是 light/high/extra_high；
 * 2. **function 槽位错**：档位是 (模型 × function) 配对下发的，插件的默认槽位
 *    `solo_work_lite` 下**所有模型** support_thinking=false，必须用
 *    `solo_agent_lite`/`solo_agent_remote`（实测这两个才有档位）；
 * 3. **字段位置错（本脚本要解决的）**：客户端把档位塞进 **`custom_model` 对象**：
 *      customModel = { provider, is_preset, config_name, ak, base_url, ...,
 *                      reasoning_effort 或 reasoning_effort_level }
 *    而插件只在**顶层**发 model_name / reasoning_effort_level —— 位置不对，
 *    上游直接忽略。这正是"传了像没传"的机制性原因。
 *
 * 来源：`@byted-icube/ai-modules-chat` 的模型描述符构造（偏移 11148388 / 11148444）：
 *   "reasoning_effort" === field && value !== undefined ? r.reasoning_effort = value
 *   : "reasoning_effort_level" === field && value !== undefined && (r.reasoning_effort_level = value), r
 *   → return { modelName, customModel: r, ... }
 *
 * 用法：node trae-effort-custom-model.mjs <档位> [模型] [function]
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const cred = JSON.parse(readFileSync(join(homedir(), ".dsh", "connect-auth", "trae.json"), "utf8"));
const url = (cred.gateway || "https://trae-api-cn.mchost.guru").replace(/\/+$/, "") + "/api/agent/v3/llm_utils_chat";

const EFFORT = process.argv[2] ?? "light";
const MODEL = process.argv[3] ?? "deepseek-v4.1-flash";
const FN = process.argv[4] ?? "solo_agent_lite";
const PROMPT = "证明 Ramsey 定理 R(3,3)=6：任意 6 人中必有 3 人互相认识或 3 人互相不认识。给出完整严格证明，并说明 5 人时为何不成立。";

/**
 * custom_model 描述符：字段名照抄客户端那一段构造。
 * `is_preset: true` 表示这是 Trae 内置模型（对应 config_source === Trae）。
 *
 * ⚠️ 档位字段**两个分支都填**：客户端源码里是按开关二选一的
 *   reasoning_effort / reasoning_effort_level
 * 我此前只填 `_level`，实测只产生 ~1.3 倍的弱差异，而用户实测 light 应到
 * **~1/7（30 秒 / 1000 字符量级）**，说明还有分支没覆盖到。两个都填以穷尽。
 */
const customModel = {
  provider: "",
  is_preset: true,
  config_name: MODEL,
  display_model_name: MODEL,
  ak: "",
  use_remote_service: true,
  base_url: "",
  context_window_size: null,
  region: "",
  sk: "",
  auth_type: 0,
  custom_model_type: null,
  max_tokens: null,
  max_turn: null,
  prompt_max_tokens: null,
  reasoning_effort_level: EFFORT,
  reasoning_effort: EFFORT,
};

const payload = {
  app_id: cred.appId,
  app_version_code: cred.appVersionCode,
  function: FN,
  model_name: MODEL,
  custom_model: customModel,
  messages: [{ role: "user", content: [{ type: "text", text: PROMPT }] }],
  max_tokens: 32000,
  stream: true,
};

const t0 = Date.now();
/**
 * 带重试：200 秒级的长请求容易被网络抖动打断（实测出现过 `terminated`），
 * 单次失败不等于档位无效，必须重试以免把偶发中断误判成结论。
 */
const ATTEMPTS = Number(process.env.TRAE_ATTEMPTS ?? 3);
let done = false;
for (let attempt = 1; attempt <= ATTEMPTS && !done; attempt += 1) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Cloud-IDE-JWT ${cred.token}`, "x-ide-token": cred.token },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(Number(process.env.TRAE_TIMEOUT_MS ?? 600000)),
    });
    const text = await res.text();
    let reason = 0;
    let content = 0;
    let err = "";
    for (const block of text.split(/\n\n+/)) {
      const dl = block.split(/\r?\n/).find((l) => l.startsWith("data:"));
      if (dl === undefined) continue;
      let d;
      try { d = JSON.parse(dl.slice(5).trim()); } catch { continue; }
      if (typeof d?.reasoning_content === "string") reason += d.reasoning_content.length;
      if (typeof d?.response === "string") content += d.response.length;
      if (typeof d?.message === "string" && err === "") err = d.message.slice(0, 90);
    }
    console.log(`  effort=${EFFORT.padEnd(11)} fn=${FN.padEnd(17)} http=${res.status}  耗时=${((Date.now() - t0) / 1000).toFixed(1)}s  思考链=${reason}  正文=${content}${err ? "  err=" + err : ""}${attempt > 1 ? `  (第 ${attempt} 次尝试)` : ""}`);
    done = true;
  } catch (error) {
    const msg = String(error?.message ?? error).slice(0, 80);
    console.log(`  effort=${EFFORT.padEnd(11)} fn=${FN.padEnd(17)} 第 ${attempt} 次失败: ${msg}`);
    if (attempt < ATTEMPTS) await new Promise((s) => setTimeout(s, 3000));
  }
}
