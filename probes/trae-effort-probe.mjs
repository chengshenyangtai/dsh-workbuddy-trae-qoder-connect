/**
 * Trae 思考档位探针（`deepseek-v4.1-flash`）
 *
 * ## 要回答的问题
 *
 * Qoder 那边已实测：上游**校验** `reasoning_effort`（乱填值被 400 拒绝）。
 * Trae 这边静态看代码，payload 只转发 `function` / `model_name` / `messages` /
 * `max_tokens`（`trae/index.js:546-554`），**完全不发档位字段**；Trae 导出的模型
 * 目录里 `reasoning_effort_options` 也全是 null。
 *
 * 但"插件没发"不等于"上游不支持"。这份探针直接打 Trae 网关，把几种可能的
 * 字段名（reasoning_effort / thinking / enable_thinking…）各试一遍，并**带一个
 * 乱填值的对照组** —— 与 Qoder 探针同一套判据：
 *   · 乱填值被拒  → 上游确实校验该字段（那么插件漏发了，值得补）
 *   · 乱填值也收  → 该字段不被校验（发了也没意义，结论是"别做"）
 *
 * 只发极短请求（max_tokens 小、prompt 极简），消耗极小。
 *
 * 用法：node trae-effort-probe.mjs [modelName]
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CRED = join(homedir(), ".dsh", "connect-auth", "trae.json");
const cred = JSON.parse(readFileSync(CRED, "utf8"));
const GATEWAY = (cred.gateway ?? "https://trae-api-cn.mchost.guru").replace(/\/+$/, "");
const ENDPOINT = `${GATEWAY}/api/agent/v3/llm_utils_chat`;
const MODEL = process.argv[2] ?? "deepseek-v4.1-flash";
const FUNCTION = "solo_work_lite";

console.log(`模型 ${MODEL}`);
console.log(`网关 ${GATEWAY}`);
console.log(`凭据 userId=${cred.userId}  deviceId=${cred.deviceId || "(缺失)"}`);

/**
 * 探针用例：既试字段名，也试档位取值。
 * `__none__` = 完全不发该字段（基线，用来判断"拒绝是否归因于该字段"）。
 */
const CASES = [
  ["基线(不发任何档位字段)", {}],
  ["reasoning_effort=low", { reasoning_effort: "low" }],
  ["reasoning_effort=high", { reasoning_effort: "high" }],
  ["reasoning_effort=max", { reasoning_effort: "max" }],
  ["reasoning_effort=乱填(对照)", { reasoning_effort: "bogus_value_xyz" }],
  ["thinking={type:enabled}", { thinking: { type: "enabled" } }],
  ["enable_thinking=true", { enable_thinking: true }],
];

async function probe(label, extra) {
  const payload = {
    app_id: cred.appId,
    app_version_code: cred.appVersionCode,
    function: FUNCTION,
    model_name: MODEL,
    /**
     * ⚠️ `content` 必须是**数组**，不能是字符串。
     *
     * 第一版发的是 `content: "1+1=?"`，上游直接 400：
     *   `json: cannot unmarshal string into Go struct field
     *    LLMRawMessage.messages.content of type []*idecopilot.LLMRawMessageContent`
     * 这是 Go 侧强类型反序列化的要求 —— 而插件的 shim 收到的是 OpenAI 兼容请求
     * （pi-ai 发字符串 content），说明**插件内部必然做了转换**，只是没在这个
     * 位置体现。探针按上游真实要求构造，否则测的只是"请求形状错"。
     */
    messages: [{ role: "user", content: [{ type: "text", text: "1+1=?" }] }],
    max_tokens: 16,
    stream: true,
    ...extra,
  };
  const t0 = Date.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Cloud-IDE-JWT ${cred.token}`,
        "x-ide-token": cred.token,
        // 写接口需要设备号；这里是只读性质，但带上更接近真实调用（README 提过 9004）。
        "x-device-id": cred.deviceId ?? "",
        "X-App-Id": cred.appId ?? "",
        "X-Ide-Version": "0.1.66",
        "Package-Type": "stable_cn",
        "Request-Traffic-Type": "prod",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60000),
    });
    const text = await res.text();
    const ms = Date.now() - t0;
    // Trae 常回 200 + SSE，业务错误藏在里面；同时抓 HTTP 与文本线索。
    const codeMatch = text.match(/"code"\s*:\s*"?([0-9A-Za-z_\-]+)"?/);
    const msgMatch = text.match(/"(?:message|msg|error)"\s*:\s*"([^"]{0,160})"/);
    const rejected = /invalid|unsupported|illegal|not support|不支持|非法|参数/i.test(text);
    const hasDelta = /"content"\s*:\s*"[^"]/.test(text) || /"reasoning_content"\s*:\s*"[^"]/.test(text);
    /**
     * 判定必须区分「请求形状错」与「档位被拒」——
     * 第一版把 HTTP 400 也标成"接受(无输出)"，那是判定 bug：基线被拒时
     * 整个实验都不成立（我当时正是靠"基线也被拒"才发现探针形状错了）。
     */
    const verdict = res.status !== 200
      ? (codeMatch?.[1] === "4001" ? "请求形状错(4001)" : `HTTP ${res.status}`)
      : rejected ? "疑似被拒"
        : hasDelta ? "接受(有输出)" : "接受(无输出)";
    return {
      label,
      http: res.status,
      verdict,
      code: codeMatch?.[1] ?? "-",
      msg: (msgMatch?.[1] ?? "-").slice(0, 90),
      bytes: text.length,
      ms,
    };
  } catch (error) {
    return { label, http: 0, verdict: "异常", code: "-", msg: String(error?.message ?? error).slice(0, 70), bytes: 0, ms: Date.now() - t0 };
  }
}

console.log("\n用例                              HTTP  判定            code   耗时   字节   消息");
for (const [label, extra] of CASES) {
  const r = await probe(label, extra);
  console.log(
    `${label.padEnd(32)} ${String(r.http).padEnd(6)} ${r.verdict.padEnd(15)} ${String(r.code).padEnd(7)} ${String(r.ms + "ms").padEnd(7)} ${String(r.bytes).padEnd(6)} ${r.msg}`,
  );
  await new Promise((s) => setTimeout(s, 1000));
}

console.log("\n判读：");
console.log("  · 若「乱填(对照)」与其它档位同为「接受」→ 上游不校验档位字段，Trae 加档位没有意义；");
console.log("  · 若「乱填(对照)」被拒、而 low/high/max 被接受 → 上游支持档位，插件漏发，值得补；");
console.log("  · 若「基线」也被拒 → 是模型/账号/请求形状问题，与档位无关（先修基线）。");

/**
 * ## 实测结论（2026-10-06）：Trae **不支持**思考档位，不要做
 *
 * ```
 * 用例                        HTTP   判定
 * 基线(不发任何档位字段)          200    接受(有输出)
 * reasoning_effort=low       200    接受(有输出)
 * reasoning_effort=high      200    接受(有输出)
 * reasoning_effort=max       200    接受(有输出)
 * reasoning_effort=乱填(对照)   200    接受(有输出)   ← 关键
 * thinking={type:enabled}    200    接受(有输出)
 * enable_thinking=true       200    接受(有输出)
 * ```
 *
 * **对照组（乱填值）同样被接受** → 上游不校验该字段，加档位选择器没有意义。
 * 这与静态证据一致：导出的模型目录里 `reasoning_effort_options` 全部为 null、
 * `reasoning_effort_config` 只有 `support_thinking=false`，payload 也只转发
 * `function`/`model_name`/`messages`/`max_tokens`。
 *
 * 反衬出 Qoder 的差异：那边**乱填值被 400 拒绝**，所以上游确实在校验，
 * 档位是真的（见 qoder-effort-probe.mjs）。两个渠道结论相反，都靠对照组区分。
 *
 * ### 踩过的坑（复跑时注意）
 *
 * `messages[].content` 必须是**数组**，不能是字符串，否则上游直接 400：
 *   `json: cannot unmarshal string into Go struct field LLMRawMessage.messages.content
 *    of type []*idecopilot.LLMRawMessageContent`
 * 第一版探针发了字符串，于是**基线也被拒**（全用例 400/4001）——那次结论无效。
 * 教训：档位实验里"基线必须成功"，否则测的是请求形状而非档位。
 */
