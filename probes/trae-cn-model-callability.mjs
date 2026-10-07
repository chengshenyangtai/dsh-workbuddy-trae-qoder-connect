/**
 * Trae CN 独占模型的可调用性实测（活体，每条 1 个 token 级请求）
 *
 * 为什么要留在仓库里：README 里那句「`glm-5.3-flash` 能不能调，主要取决于账号档位，
 * 不是插件能力」是个**会被质疑**的结论（同类插件的文档写的是「上游不提供，报 4001」）。
 * 有脚本在，任何人都能在自己的账号上复算，不用信我的转述。
 *
 * 判据要点（踩过一次，别再踩）：**reasoning_content 也算「上游确实在服务这个模型」**。
 * 只数 `response` 会把 thinking 模型判成「无响应/超时」，进而得出「这模型不可用」的
 * 错误结论 —— 实测 `glm-5.3-flash` 先出的是思考链。
 *
 * 成本：每条 `max_tokens: 16`、不带工具、prompt 一句。六个用例合计不到 100 token。
 * 只读凭据快照，不写任何文件；**输出已脱敏**（账号 id 只给长度）。
 *
 * 用法：node probes/trae-cn-model-callability.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
const credPath = process.argv[2] || path.join(HOME, 'connect-auth', 'trae.json');
if (!fs.existsSync(credPath)) {
  console.error(`找不到 Trae 凭据快照：${credPath}\n先在宿主跑 scripts/export-trae-plain.mjs --app cn`);
  process.exit(2);
}
const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'));
if (typeof cred?.token !== 'string' || cred.token === '') { console.error('快照里没有 token'); process.exit(2); }

const H = {
  'Content-Type': 'application/json',
  Accept: '*/*',
  Authorization: `Cloud-IDE-JWT ${cred.token}`,
  'x-ide-token': cred.token,
  'X-Ide-Token': cred.token,
  'X-App-Id': cred.appId,
  'X-Ide-Version': cred.appVersion,
  'X-Ide-Version-Code': String(cred.appVersionCode),
  'X-Device-Id': cred.deviceId ?? '',
  'User-Agent': 'TraeClient/TTNet',
};
const url = `${cred.gateway}/api/agent/v3/llm_utils_chat`;

async function tryCall(fn, model) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({
        app_id: cred.appId,
        app_version_code: Number(cred.appVersionCode),
        function: fn,
        model_name: model,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'reply with exactly: PONG' }] }],
        max_tokens: 16,
        stream: true,
      }),
      signal: AbortSignal.timeout(45000),
    });
  } catch (e) { return { verdict: `未测出（${e.name}）`, ms: Date.now() - t0 }; }
  if (!res.ok) return { verdict: `HTTP ${res.status}`, ms: Date.now() - t0 };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let err = '';
  let response = '';
  let reasoning = '';
  let sawToolCall = false;
  try {
    for (let i = 0; i < 60; i += 1) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const evs = buf.split(/\n\n/);
      buf = evs.pop() ?? '';
      for (const ev of evs) {
        const m = /event:(\w+)\s+data:(.*)/.exec(ev.replace(/\n/g, ' '));
        if (!m) continue;
        let d;
        try { d = JSON.parse(m[2]); } catch { d = {}; }
        if (m[1] === 'error') err = JSON.stringify(d).slice(0, 150);
        if (m[1] === 'output') {
          if (typeof d.response === 'string' && d.response) response += d.response;
          if (typeof d.reasoning_content === 'string' && d.reasoning_content) reasoning += d.reasoning_content;
          if (Array.isArray(d.tool_calls) && d.tool_calls.length > 0) sawToolCall = true;
        }
        if (m[1] === 'done') i = 999;
      }
      if (err || response || reasoning || sawToolCall) break;
    }
  } catch { /* 超时也是一种结论，下面如实报告 */ }
  try { reader.cancel().catch(() => {}); } catch { /* 已读完 */ }
  const ms = Date.now() - t0;
  if (err) return { verdict: `上游拒绝 ${err}`, ms };
  if (response) return { verdict: `可用（回复="${response.trim().slice(0, 16)}"）`, ms };
  if (reasoning) return { verdict: `可用（仅思考流，${reasoning.length} 字）`, ms };
  if (sawToolCall) return { verdict: '可用（返回工具调用）', ms };
  return { verdict: '未测出（超时/无事件）——不等于不可用', ms };
}

const cases = [
  ['solo_agent', 'glm-5.3-flash', 'CN 目录独占'],
  ['solo_agent', 'kimi-k2.8-preview', 'CN 目录独占'],
  ['solo_agent', 'qwen3.8-flash', 'CN 目录独占'],
  ['solo_agent', 'glm-5.3', '共有（对照组）'],
  ['solo_work_lite', 'glm-5.3-flash', '用 SOLO 的 function 名试 CN 独占'],
  ['chat_v3', 'glm-5.3-flash', '换一个 CN function 复算'],
];

// 脱敏：账号 id / 设备号只给长度，不给值 —— 这份输出可以直接贴进 issue。
console.log(`product=${cred.product ?? '(未声明)'}  buildId=${cred.appVersionCode}  账号id长度=${String(cred.userId ?? '').length}  设备号长度=${String(cred.deviceId ?? '').length}\n`);
for (const [fn, model, note] of cases) {
  const r = await tryCall(fn, model);
  console.log(`  ${fn.padEnd(16)} ${model.padEnd(20)} ${String(r.ms).padStart(6)}ms  ${r.verdict.padEnd(42)} # ${note}`);
}
console.log('\n注：「未测出」不等于「不可用」；只有上游明确 4001/4023 才是负面结论。');
