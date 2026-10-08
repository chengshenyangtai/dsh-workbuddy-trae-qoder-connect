/**
 * Qoder 探查「契约形状」端到端验证（离线，不重启、不打上游）
 *
 * 验证的是**跨进程契约**：后端 status 文档产出的 `probe`/`probeKey` 形状，
 * 必须与前端控件实际读取的字段一致。这类"字段名对不上"的 bug 不会报错，
 * 只会表现成"按钮不出现 / 结果不显示"，所以值得单独钉一遍。
 *
 * 做法：把后端 status 文档的 probe 段构造逻辑，与前端控件读取的字段清单，
 * 两边都从源码里提取出来做交叉比对。
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LIB = join(homedir(), ".dsh", "profiles", "desktop", "node_modules", process.env.DSH_CONNECT_DIR ?? "dsh-connect", "lib");
const qoderSrc = readFileSync(join(LIB, "providers", "qoder", "index.js"), "utf8");
const clientSrc = readFileSync(join(LIB, "client.js"), "utf8");

let pass = 0;
let fail = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`); }
};

console.log("【1】后端产出 vs 前端读取 —— 字段必须对得上");

check("后端 status 提供 probe 段", /probe: \{/.test(qoderSrc), true);
check("后端 status 提供 probeKey", /probeKey: deps\.probe\.key\(\)/.test(qoderSrc), true);
check("probe 段含 candidates（前端据此判断按钮是否显示）",
  /candidates: models\.filter/.test(qoderSrc), true);
check("probe 段含 running（前端据此显示进度）", /running: deps\.probe\.service\.isRunning\(\)/.test(qoderSrc), true);
check("probe 段含 results（前端据此显示已探结果）", /results: models\.flatMap/.test(qoderSrc), true);

// 前端确实读这些字段（从 client.js 里的实际引用确认）
check("前端读 probe.candidates", /probe\?\.candidates\.includes\(model\)/.test(clientSrc), true);
check("前端读 probe.running", /probe\?\.running === true/.test(clientSrc), true);
check("前端读 status.probeKey", /status\.probeKey/.test(clientSrc), true);
check("前端读 result.probedAt（毫秒时间戳）", /formatTime\(result\.probedAt\)/.test(clientSrc), true);

console.log("\n【2】探查 POST 的请求/响应契约");

// 前端发出的形状
check("前端用 header: X-WorkBuddy-Probe-Key", /"X-WorkBuddy-Probe-Key": key/.test(clientSrc), true);
check("前端 body 含 action 与 model", /action: "probe",\s*\n\s*model/.test(clientSrc), true);
// 后端接收的形状（必须兼容上面两个）
check("后端读该 header（大小写不敏感，Node 已小写化）",
  /headers\?\.\["x-workbuddy-probe-key"\]/.test(qoderSrc), true);
check("后端从 body 取 model", /parsed\?\.model === "string" \? parsed\.model/.test(qoderSrc), true);
// 响应形状：前端只接受这四种字段
check("后端返回 state: ok（前端校验 body.state !== 'ok'）", /service\.probe\(modelId, true\)/.test(qoderSrc), true);
check("ProbeService 返回 state: ok", /return \{ state: "ok", \.\.\.result \}/.test(readFileSync(join(LIB, "shared", "probe.js"), "utf8")), true);

console.log("\n【3】探查结果会触发模型列表重建（否则 UI 看不到变化）");
check("ProbeService 调 onProbed", /this\.options\.onProbed\?\.\(modelId, result\)/.test(readFileSync(join(LIB, "shared", "probe.js"), "utf8")), true);
check("Qoder 把 onProbed 接到 adapters-updated", /onProbed: \(\) => \{[\s\S]{0,200}adapters-updated/.test(qoderSrc), true);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
