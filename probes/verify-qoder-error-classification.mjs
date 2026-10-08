#!/usr/bin/env node
// probes/verify-qoder-error-classification.mjs
// 钉死 2026-10-08 修的「Qoder 报 API 密钥无效，其实是额度用尽」。
//
// ## 事故
//
// 用户看到的是宿主前端的固定文案「本轮运行失败 API 密钥无效」。真实上游错误是
//   qoder upstream (http 403): {"code":"110","message":"Billing daily count exceeded"}
// —— **额度问题**，跟密钥无关（同一份凭据探测上游一直 200）。
//
// ## 根因（在宿主 asar 里读出来的判定顺序）
//
//   function classifyPiAiError(message) {
//     if (/\b(?:401|403)\b/.test(message)) return "AUTH";              // ← 先看数字
//     if (isQuotaExceededError(message)) return QUOTA_EXCEEDED_CODE;   // ← 永远轮不到
//     ...
//   }
//
// 宿主是**按错误文案里的数字**分类的。插件把 `(http 403)` 原样写进 message，
// 于是额度错误被判成 AUTH；而前端对 AUTH 会把原文**整条丢弃**
// （`displayFailure` 对 AUTH 只返回空 message），用户就只看到"API 密钥无效"，
// 真实原因完全不可见、还会被误导去查密钥。
//
// ## 修法
//
// 额度类失败改用宿主认得的措辞（`usage limit exceeded`）并把裸状态码换成词，
// 让它落进 QUOTA/RATE_LIMIT 分支；真正的凭据失败保持原文（本来就该按状态码走）。
//
// 断言直接复刻宿主的分类函数，所以测的是"最终会被显示成什么"，不是我们自己
// 的措辞偏好。
//
// 用法：node probes/verify-qoder-error-classification.mjs [--installed]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SRC = process.argv.includes("--installed")
  ? path.join(os.homedir(), ".dsh", "profiles", "desktop", "node_modules", process.env.DSH_CONNECT_DIR ?? "dsh-connect")
  : REPO;

let passed = 0;
let failed = 0;
let chain = Promise.resolve();
const ok = (label, fn) => {
  chain = chain.then(async () => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      console.error(`FAIL ${label}\n  ${e && e.message}`);
    }
  });
};

// —— 加载真实模块（真 schemastery + 桩宿主包）——
const stubDir = path.join(HERE, ".qerr-stubs");
fs.mkdirSync(stubDir, { recursive: true });
const stubNames = {
  "@deepseek-ai/dsh-home-paths": ["resolveDshHome"],
  "@deepseek-ai/dsh-llm": ["resolveRetryPolicy"],
  "@deepseek-ai/dsh-llm-pi-ai": ["PiAiAdapter"],
  "@earendil-works/pi-ai": ["createProvider"],
  "@earendil-works/pi-ai/api/openai-completions.lazy": ["openAICompletionsApi"],
  "@deepseek-ai/dsh-atomic-write": ["withFileLock", "writeFileAtomic"],
};
const stubMap = {};
for (const [spec, names] of Object.entries(stubNames)) {
  const file = path.join(stubDir, spec.replace(/[@/]/g, "_") + ".mjs");
  const body =
    spec === "@deepseek-ai/dsh-home-paths"
      ? `export const resolveDshHome = () => ${JSON.stringify(path.join(os.homedir(), ".dsh"))};\nexport default { resolveDshHome };\n`
      : `const mk=(n)=>{const f=function(){return f};return f};\n` + names.map((n) => `export const ${n}=mk(${JSON.stringify(n)});`).join("\n") + `\nexport default new Proxy({},{get:()=>mk("d")});\n`;
  fs.writeFileSync(file, body);
  stubMap[spec] = file;
}
{
  const sc = path.join(os.homedir(), ".dsh", "profiles", "desktop", "node_modules", "@deepseek-ai", "schemastery", "lib", "index.mjs");
  if (!fs.existsSync(sc)) {
    console.error("找不到宿主真包 @deepseek-ai/schemastery —— 本探针需要装过 dsh 桌面版的机器。");
    process.exit(2);
  }
  stubMap["@deepseek-ai/schemastery"] = sc;
}
const loaderFile = path.join(stubDir, "loader.mjs");
fs.writeFileSync(
  loaderFile,
  `import { pathToFileURL } from "node:url";\nconst map=${JSON.stringify(stubMap)};\nexport async function resolve(s,c,n){ if(map[s]) return {url:pathToFileURL(map[s]).href,shortCircuit:true,format:"module"}; return n(s,c) }\n`,
);
const { register } = await import("node:module");
register(new URL(`file://${loaderFile.replace(/\\/g, "/")}`).href, import.meta.url);

const mod = await import(pathToFileURL(path.join(SRC, "lib", "providers", "qoder", "index.js")).href);

/**
 * 宿主 `classifyPiAiError` 的忠实复刻（从 app.asar 里读出来的顺序）。
 * 顺序本身就是 bug 的一半：401/403 分支在额度分支**之前**。
 */
function classifyPiAiError(message) {
  if (/\b(?:401|403)\b/.test(message)) return "AUTH";
  if (
    /\binsufficient[\s_-]+(?:quota|balance|credits?)\b/i.test(message) ||
    /\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b/i.test(message) ||
    /\bexceed(?:ed|s)?[\s_-]+(?:(?:your|the)[\s_-]+)?(?:current[\s_-]+)?quota\b/i.test(message) ||
    /\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted)\b/i.test(message) ||
    /\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i.test(message)
  ) {
    return "QUOTA";
  }
  if (/\b429\b|rate.?limit/i.test(message)) return "RATE_LIMIT";
  if (/\b413\b|payload too large|request body too large/i.test(message)) return "INVALID_REQUEST";
  if (/\b400\b|invalid.?request/i.test(message)) return "INVALID_REQUEST";
  if (/\b5\d\d\b/.test(message)) return "SERVER";
  if (/\btime(?:d)?\s*out\b|timeout/i.test(message)) return "TIMEOUT";
  return "PI_AI_ERROR";
}

// 只有导出了才算能测；没有导出就直接读源文件里的函数体（保守回退）
const hasHelper = typeof mod.describeUpstreamFailure === "function";
const classifyText =
  mod.describeUpstreamFailure ??
  ((status, message) => `qoder upstream (http ${status}): ${String(message).slice(0, 400)}`);

if (!hasHelper) {
  console.error("警告：describeUpstreamFailure 未导出，用旧文案回退 —— 这组断言应当变红。");
}

const QUOTA_RAW = '{"code":"110","message":"Billing daily count exceeded"}';

ok("1. 额度类失败（403 code:110）→ 宿主判为 QUOTA，**不是** AUTH", () => {
  const text = classifyText(403, QUOTA_RAW);
  const kind = classifyPiAiError(text);
  if (kind === "AUTH") {
    throw new Error(`仍被判成 AUTH（前端会显示"API 密钥无效"并丢弃原文）：${text.slice(0, 160)}`);
  }
  if (kind !== "QUOTA" && kind !== "RATE_LIMIT") {
    throw new Error(`期望 QUOTA/RATE_LIMIT，实际 ${kind}：${text.slice(0, 160)}`);
  }
});

ok("2. 渲染后的文案**仍保留原始诊断信息**（不能因为改措辞就把原因藏起来）", () => {
  const text = classifyText(403, QUOTA_RAW);
  if (!/Billing daily count exceeded/i.test(text)) {
    throw new Error(`上游原文被丢了：${text.slice(0, 160)}`);
  }
});

ok("3. 真正的凭据失败（401 token invalid）仍按 AUTH 上报（不要过度纠正）", () => {
  const text = classifyText(401, '{"code":"401","message":"token invalid"}');
  const kind = classifyPiAiError(text);
  if (kind !== "AUTH") throw new Error(`凭据失败应仍为 AUTH，实际 ${kind}：${text.slice(0, 160)}`);
});

ok("4. isQuotaRejection：额度词命中，凭据词不命中", () => {
  if (typeof mod.isQuotaRejection !== "function") throw new Error("未导出 isQuotaRejection");
  if (!mod.isQuotaRejection("Billing daily count exceeded")) throw new Error("额度文案未命中");
  if (!mod.isQuotaRejection("您的使用量已超出频率限制")) throw new Error("中文限流文案未命中");
  if (mod.isQuotaRejection("token invalid")) throw new Error("凭据文案被误判为额度");
});

ok("5. isCredentialRejection 与额度判定互斥（额度优先否决）", () => {
  if (typeof mod.isCredentialRejection !== "function") throw new Error("未导出 isCredentialRejection");
  if (mod.isCredentialRejection("Billing daily count exceeded")) {
    throw new Error("额度文案被当成凭据失败 —— 会白白 invalidate + 重试一次");
  }
  if (!mod.isCredentialRejection("token expired")) throw new Error("真正的凭据失效没被识别");
});

ok("6. neutralizeStatusTokens 清掉裸状态码，且不动普通文字", () => {
  if (typeof mod.neutralizeStatusTokens !== "function") throw new Error("未导出 neutralizeStatusTokens");
  const out = mod.neutralizeStatusTokens("upstream (http 403): billing exceeded");
  if (/\b403\b/.test(out)) throw new Error(`状态码没被抹掉：${out}`);
  const plain = mod.neutralizeStatusTokens("everything is fine here");
  if (plain !== "everything is fine here") throw new Error(`普通文字被改：${plain}`);
});

ok("7. **接线**：shim 的失败分支必须走 describeUpstreamFailure（不是自己拼字符串）", () => {
  /**
   * 这一条是**接线断言**，必须读源码。
   *
   * 反向验证时发现：只测 `describeUpstreamFailure` 本身，把调用点改回
   * `` `qoder upstream (http ${status}): …` `` 探针**依然全绿** —— 因为纯函数
   * 还是对的，只是没人用它。函数正确 + 没接线 = 用户照样看到"API 密钥无效"。
   * 这与 verify-trae-tool-calling 里"接线也要断言"的处理一致。
   */
  const src = fs.readFileSync(path.join(SRC, "lib", "providers", "qoder", "index.js"), "utf8");
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  if (!/writeOpenAIError\(res,\s*status,\s*result\.kind,\s*describeUpstreamFailure\(/.test(stripped)) {
    throw new Error("shim 的失败分支没有调用 describeUpstreamFailure —— 额度错误会退回『API 密钥无效』");
  }
  if (/writeOpenAIError\(res,\s*status,\s*result\.kind,\s*`qoder upstream \(http \$\{result\.status\}\)/.test(stripped)) {
    throw new Error("调用点仍是旧的裸模板写法");
  }
});

ok("8. **接线**：信封里的额度错误把 HTTP 状态换成 429（否则文案里的 403 会抢走分类）", () => {
  const src = fs.readFileSync(path.join(SRC, "lib", "providers", "qoder", "index.js"), "utf8");
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  if (!/isQuotaRejection\(first\.message\)/.test(stripped)) {
    throw new Error("信封分支没有用 isQuotaRejection 判断额度");
  }
  if (!/status:\s*quotaLike\s*\?\s*429/.test(stripped)) {
    throw new Error("额度类没有把状态换成 429");
  }
});

fs.rmSync(stubDir, { recursive: true, force: true });
await chain;
console.log(`\nverify-qoder-error-classification: ${passed} 通过 / ${failed} 失败  [src=${SRC}]`);
process.exitCode = failed ? 1 : 0;
