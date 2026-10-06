/**
 * 验证：档位是否只在支持它的 function 槽位下有效。
 *
 * 背景：Trae 把「思考强度」按 (模型 × function) 配对下发。插件的默认槽位
 * solo_work_lite 对 deepseek-v4.1-flash 是 support_thinking:false，所以此前
 * 无论传什么档位都没反应。本脚本对比 solo_work_lite 与 solo_agent_lite 两个槽位。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const cred = JSON.parse(readFileSync(join(homedir(), ".dsh", "connect-auth", "trae.json"), "utf8"));
const url = (cred.gateway || "https://trae-api-cn.mchost.guru").replace(/\/+$/, "") + "/api/agent/v3/llm_utils_chat";
const MODEL = process.argv[2] ?? "deepseek-v4.1-flash";
const FN = process.argv[3] ?? "solo_work_lite";
const EFFORT = process.argv[4] ?? "light";
const PROMPT = "证明 Ramsey 定理 R(3,3)=6：任意 6 人中必有 3 人互相认识或 3 人互相不认识。给出完整严格证明，并说明 5 人时为何不成立。";

const payload = {
  app_id: cred.appId,
  app_version_code: cred.appVersionCode,
  function: FN,
  model_name: MODEL,
  messages: [{ role: "user", content: [{ type: "text", text: PROMPT }] }],
  max_tokens: 32000,
  stream: true,
  reasoning_effort_level: EFFORT,
  reasoning_effort: EFFORT,
};

const t0 = Date.now();
try {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Cloud-IDE-JWT ${cred.token}`, "x-ide-token": cred.token },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(Number(process.env.TRAE_TIMEOUT_MS ?? 600000)),
  });
  const text = await res.text();
  let reason = 0, content = 0, err = "";
  for (const block of text.split(/\n\n+/)) {
    const dl = block.split(/\r?\n/).find((l) => l.startsWith("data:"));
    if (dl === undefined) continue;
    let d; try { d = JSON.parse(dl.slice(5).trim()); } catch { continue; }
    if (typeof d?.reasoning_content === "string") reason += d.reasoning_content.length;
    if (typeof d?.response === "string") content += d.response.length;
    if (typeof d?.message === "string" && err === "") err = d.message.slice(0, 80);
  }
  console.log(`  fn=${FN.padEnd(19)} effort=${EFFORT.padEnd(11)} http=${res.status}  耗时=${((Date.now() - t0) / 1000).toFixed(1)}s  思考链=${reason}  正文=${content}${err ? "  err=" + err : ""}`);
} catch (error) {
  console.log(`  fn=${FN.padEnd(19)} effort=${EFFORT.padEnd(11)} 失败: ${String(error?.message ?? error).slice(0, 70)}`);
}
