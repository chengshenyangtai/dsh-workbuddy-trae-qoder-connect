#!/usr/bin/env node
/**
 * WorkBuddy 扫码登录 CLI —— 给 AI / 终端用，绕开 GUI 弹窗。
 *
 * 用法：
 *   node scripts/workbuddy-login.mjs <slot>            # 发起登录，输出授权链接并轮询直到完成
 *   node scripts/workbuddy-login.mjs <slot> --url-only # 只输出链接，不轮询（AI 把链接转给用户即可）
 *
 * <slot> 是槽位 id，如 workbuddy1 / workbuddy2 / workbuddy3（面板认证页同款）。
 * 前提：DSH 已在运行（默认 127.0.0.1:19387；可用 --port 覆盖），且该槽位已装载。
 *
 * 流程：POST /plugins/dsh-workbuddy-connect/<n>/login/start 拿 {state, authUrl}
 *      → 用户在任意浏览器打开 authUrl 扫码/短信授权
 *      → GET  /plugins/dsh-workbuddy-connect/<n>/login/poll?state=…
 *      → signed-in 后凭据已由插件写入，本脚本退出码 0。
 */

const args = process.argv.slice(2);
const slot = args.find((a) => !a.startsWith("--"));
const urlOnly = args.includes("--url-only");
const portFlag = args.indexOf("--port");
const port = portFlag !== -1 ? Number(args[portFlag + 1]) : 19387;

if (!slot || !/^workbuddy\d+$/.test(slot)) {
  console.error("用法: node scripts/workbuddy-login.mjs <workbuddyN> [--url-only] [--port 19387]");
  process.exit(2);
}
const base = `http://127.0.0.1:${port}/plugins/dsh-workbuddy-connect/${slot.replace("workbuddy", "")}`;

const start = await fetch(`${base}/login/start`, { method: "POST", headers: { accept: "application/json" } });
const startBody = await start.json().catch(() => ({}));
if (!start.ok || startBody?.ok !== true || typeof startBody.authUrl !== "string") {
  console.error(`发起登录失败: HTTP ${start.status} ${JSON.stringify(startBody)}`);
  console.error(start.status === 404 || start.status === 405 ? "（槽位未装载：先重启 DSH，或确认槽位 id 正确）" : "");
  process.exit(1);
}

console.log("授权链接（在任意浏览器打开，扫码或手机号+短信均可）：");
console.log(startBody.authUrl);
if (urlOnly) process.exit(0);

console.log("\n轮询中（最长 15 分钟，每 2 秒一次；授权完成后凭据自动写入）…");
const deadline = Date.now() + 15 * 60 * 1000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000));
  const poll = await fetch(`${base}/login/poll?state=${encodeURIComponent(startBody.state)}`, { headers: { accept: "application/json" } });
  const body = await poll.json().catch(() => ({}));
  if (body?.status === "signed-in") {
    console.log(`✓ 登录成功${body?.replaced ? `（替换了原账号 ${String(body.replaced.uid ?? "").slice(0, 8)}…）` : ""}`);
    process.exit(0);
  }
  if (body?.status === "blocked" || body?.status === "failed") {
    console.error(`✗ 登录失败: ${body?.reason ?? body?.error ?? "未知原因"}`);
    process.exit(1);
  }
  if (body?.status === "expired" || body?.status === "unknown") {
    console.error("✗ 授权码已失效，请重新运行本脚本");
    process.exit(1);
  }
}
console.error("✗ 超时（15 分钟）未完成授权");
process.exit(1);
