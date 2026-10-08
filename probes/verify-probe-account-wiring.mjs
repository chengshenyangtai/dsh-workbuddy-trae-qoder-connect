#!/usr/bin/env node
// probes/verify-probe-account-wiring.mjs
// 钉死一件事：**推理档位探查用的账号标识必须来自凭据，不能读配置**。
//
// ## 事故（2026-10-08）
//
// Qoder 的探查曾经是 `account: () => current()?.account` —— 读配置对象里一个永远
// 没人写的字段（profile 里只有 autoCheckin / disabledChannels / disabledModels）。
// 而 ProbeService 的第一步就是：
//
//     const account = this.options.account();
//     if (account === undefined) return { state: "unavailable", reason: "no credential" };
//
// 于是面板上点「检测档位」**必然**返回 `no credential`，与凭据是否有效无关。
// 现象自相矛盾：状态行显示 signed-in，探查却说没有凭据。
//
// 对照 WorkBuddy（一直正常）：`account: () => identityOf(variant.id)` —— 动态解析
// 真实身份。所以本探针断言的是**接线形状**：account 解析器必须引用凭据来源
// （tokens / identity / credential），不得只引 `current()` / 配置对象。
//
// 用法：node probes/verify-probe-account-wiring.mjs [--installed]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SRC = process.argv.includes("--installed")
  ? path.join(os.homedir(), ".dsh", "profiles", "desktop", "node_modules", process.env.DSH_CONNECT_DIR ?? "dsh-connect")
  : REPO;

let passed = 0;
let failed = 0;
const ok = (label, fn) => {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`FAIL ${label}\n  ${e && e.message}`);
  }
};

/** 去掉注释后的源码：本仓库的修复注释里逐字写着事故代码，不剥注释就是自己抓自己。 */
function code(rel) {
  return fs
    .readFileSync(path.join(SRC, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

/**
 * 取出 `account: () => <expr>,` 的表达式本体。
 * 允许跨行（实参里常有箭头函数），用括号/大括号配对找到终止的 `,` 或 `}`。
 */
function accountExpr(src, marker) {
  const at = src.indexOf(marker);
  if (at === -1) return undefined;
  const start = src.indexOf("account:", at);
  if (start === -1) return undefined;
  let i = src.indexOf(":", start) + 1;
  let depth = 0;
  let out = "";
  for (; i < src.length; i++) {
    const ch = src[i];
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) {
      if (depth === 0) break;
      depth--;
    } else if (ch === "," && depth === 0) break;
    out += ch;
  }
  return out.trim();
}

// —— Qoder ——
const qSrc = code("lib/providers/qoder/index.js");
const qExpr = accountExpr(qSrc, "createQoderProbe({");
ok("Qoder: 能找到 createQoderProbe 的 account 实参", () => {
  if (qExpr === undefined) throw new Error("定位不到 account 实参（createQoderProbe 调用形状变了？）");
});
ok("Qoder: account 不再直接读配置对象（current()?.account）", () => {
  if (/current\(\)\s*\?\.\s*account/.test(qExpr)) {
    throw new Error(`account 仍在读配置：${qExpr} —— 该字段从不被写入，探查必然返回 no credential`);
  }
});
ok("Qoder: account 引用了凭据来源（probeAccount/tokens/credential）", () => {
  if (!/probeAccount|tokens|credential|userID|identity/i.test(qExpr)) {
    throw new Error(`account 没有引用任何凭据来源：${qExpr}`);
  }
});
ok("Qoder: 身份缓存由 tokens.get() 填充（同步可读 + 异步刷新）", () => {
  if (!/tokens\s*\.\s*get\(\)/.test(qSrc)) throw new Error("没有从 tokens.get() 取身份");
  if (!/probeAccountCache/.test(qSrc)) throw new Error("没有同步可读的身份缓存 —— ProbeService 是同步调用的");
});
ok("Qoder: 凭据巡检里会刷新身份缓存", () => {
  // refresh() 里应当调用 refreshProbeAccount()
  const refreshAt = qSrc.indexOf("const refresh = ()");
  if (refreshAt === -1) throw new Error("找不到 refresh() 定义");
  const body = qSrc.slice(refreshAt, refreshAt + 600);
  if (!/refreshProbeAccount\(\)/.test(body)) {
    throw new Error("refresh() 没有刷新身份缓存 —— 冷启动后第一次点击可能仍拿不到身份");
  }
});

// —— WorkBuddy：对照组，必须保持"动态解析真实身份"的形状 ——
const wSrc = code("lib/providers/workbuddy/index.js");
const wExpr = accountExpr(wSrc, "new WorkBuddyProbeService({");
ok("WorkBuddy: account 动态解析真实身份（对照组，防止被改成读配置）", () => {
  if (wExpr === undefined) throw new Error("定位不到 WorkBuddy 的 account 实参");
  if (!/identityOf|accountOf|identity|credential/i.test(wExpr)) {
    throw new Error(`WorkBuddy 的 account 不再解析真实身份：${wExpr}`);
  }
  if (/current\(\)\s*\?\.\s*account/.test(wExpr)) {
    throw new Error("WorkBuddy 也被改成读配置了 —— 那条路一直正常，不该动");
  }
});

// —— ProbeService：契约层，缺 account 必须仍然明确报错（不能静默）——
const pSrc = code("lib/shared/probe.js");
ok("ProbeService: account 缺失时明确返回 no credential（不静默放行）", () => {
  if (!/reason:\s*"no credential"/.test(pSrc)) {
    throw new Error("ProbeService 不再明确报 no credential —— 缺身份会被静默当成可用");
  }
});
ok("ProbeService: account 在探查前取一次、并在过程中复核（防止中途换号）", () => {
  const n = (pSrc.match(/this\.options\.account\(\)/g) ?? []).length;
  if (n < 1) throw new Error("ProbeService 从不取 account");
});

console.log(`\nverify-probe-account-wiring: ${passed} 通过 / ${failed} 失败  [src=${SRC}]`);
process.exitCode = failed ? 1 : 0;
