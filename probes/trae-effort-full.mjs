/**
 * Trae 思考档位：按**真实日志里的完整 custom_model 结构**发请求
 *
 * 日志实证（renderer.log，真实用户请求）里 custom_model 的完整字段：
 *   provider, is_preset, config_name, config_source, model_name, display_model_name,
 *   ak, base_url, use_remote_service, multimodal, prompt_max_tokens,
 *   toolcall_history_max_tokens, extra_config, ab_versions, persist_meta,
 *   raw_chat_function, prompt_set, context_window_sizes, max_turn, display_options,
 *   max_tokens, application_config, sk, auth_type, region, session_token,
 *   custom_model_type, reasoning_effort_level
 *
 * 我此前只拼了其中一半（且缺 config_source），所以档位只产生 ~1/1.5 的弱差异，
 * 而用户实测 light 应达 ~1/7。这个脚本补齐全部字段。
 *
 * 用法：node trae-effort-full.mjs <档位> [模型] [function]
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const cred = JSON.parse(readFileSync(join(homedir(), ".dsh", "connect-auth", "trae.json"), "utf8"));
const url = (cred.gateway || "https://trae-api-cn.mchost.guru").replace(/\/+$/, "") + "/api/agent/v3/llm_utils_chat";

const EFFORT = process.argv[2] ?? "extra_high";
const MODEL = process.argv[3] ?? "glm-5.3";
const FN = process.argv[4] ?? "solo_agent_lite";
const PROMPT = "证明 Ramsey 定理 R(3,3)=6：任意 6 人中必有 3 人互相认识或 3 人互相不认识。给出完整严格证明，并说明 5 人时为何不成立。";

/** 完整 custom_model：字段名**与取值类型**都照抄日志里的真实请求。 */
function buildCustomModel(effort) {
  return {
    provider: "",
    is_preset: true,
    config_name: MODEL,
    /**
     * ⚠️ `config_source` 是**数字枚举**（真实请求里是 1），不是字符串。
     *
     * 我第一版写 `"trae"`（字符串）——服务端解析不出模型来源，档位只会被
     * 部分接受（实测只降到 1/1.5，而用户实测 light 应到 ~1/7）。
     * 这是"看起来传了、其实没完全生效"的典型原因。
     */
    config_source: 1,
    model_name: MODEL,
    display_model_name: MODEL,
    ak: "",
    base_url: "",
    use_remote_service: true,
    // multimodal 真实值是 false（原版我写 true）。
    multimodal: false,
    // prompt_max_tokens 保持 null：它是上下文额度，属于 Max 模式范畴，**不是本次目标**。
    prompt_max_tokens: null,
    toolcall_history_max_tokens: null,
    extra_config: null,
    ab_versions: null,
    // persist_meta 留空：真实请求里的 smart_selection.strategy:"max" 是 **1M 上下文（Max 模式）**，
    // 与思考强度无关。之前把它当"缺字段"补上属于跑偏 —— 本次只控制档位。
    persist_meta: null,
    raw_chat_function: null,
    prompt_set: null,
    context_window_sizes: null,
    max_turn: null,
    display_options: null,
    max_tokens: null,
    application_config: null,
    sk: null,
    auth_type: null,
    region: null,
    session_token: null,
    custom_model_type: null,
    ...(effort === "__none__" ? {} : { reasoning_effort_level: effort }),
  };
}

const payload = {
  app_id: cred.appId,
  app_version_code: cred.appVersionCode,
  function: FN,
  model_name: MODEL,
  custom_model: buildCustomModel(EFFORT),
  messages: [{ role: "user", content: [{ type: "text", text: PROMPT }] }],
  max_tokens: 32000,
  stream: true,
};

const t0 = Date.now();
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
    console.log(`  effort=${EFFORT.padEnd(11)} model=${MODEL.padEnd(20)} http=${res.status}  耗时=${((Date.now() - t0) / 1000).toFixed(1)}s  思考链=${reason}  正文=${content}${err ? "  err=" + err : ""}${attempt > 1 ? `  (第 ${attempt} 次)` : ""}`);
    done = true;
  } catch (error) {
    console.log(`  effort=${EFFORT.padEnd(11)} 第 ${attempt} 次失败: ${String(error?.message ?? error).slice(0, 70)}`);
    if (attempt < ATTEMPTS) await new Promise((s) => setTimeout(s, 3000));
  }
}
