#!/usr/bin/env node
// probes/verify-qoder-cn-no-regression.mjs
// 钉死「加国际版不能动国区」这条线。
//
// ## 为什么需要它
//
// 双区域把 `lib/providers/qoder/index.js` 里一批写死的常量（provider id、路由、
// 凭据路径、状态文件名、端点、会话类型）改成了按区域档案取值。这类改动的危险
// 不在于"国际版不работа"——它坏了会立刻发现；而在于**国区悄悄变了**：
//
//   · provider id 从 `qoder1` 漂成别的 → 用户已选的模型全部失效、要重选；
//   · 路由前缀变了 → 浏览器侧那份已构建的 `client.js` 打不到，渠道卡片变空；
//   · 凭据文件名变了 → 已登录的部署升级后集体"未登录"；
//   · 会话类型变了 → 上游 400，但错误藏在信封里，表现为"这轮失败下轮又好"。
//
// 这些都不会在开发机上炸，只会在老部署上炸。所以单独一个探针钉住。
//
// ## 断言的边界
//
// 只断言**对外可见的契约**（常量字面量、档案默认值、函数签名），
// 不钉内部实现写法 —— 日后重构 provider 内部时，探针该绿还是绿。
//
// 用法：node probes/verify-qoder-cn-no-regression.mjs [--installed]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SRC = process.argv.includes("--installed")
  ? path.join(os.homedir(), ".dsh", "profiles", "desktop", "node_modules", process.env.DSH_CONNECT_DIR ?? "dsh-workbuddy-trae-qoder-connect")
  : REPO;

let passed = 0;
let failed = 0;

const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`);
  }
};

const { register } = await import("node:module");
register(pathToFileURL(path.join(HERE, "_qoder-stubs", "loader.mjs")).href, import.meta.url);

const qoder = await import(pathToFileURL(path.join(SRC, "lib", "providers", "qoder", "index.js")).href);
const registry = await import(pathToFileURL(path.join(SRC, "lib", "channel-registry.js")).href);

const CN = qoder.QODER_REGIONS?.cn ?? {};

// ── 1. 对外常量 ────────────────────────────────────────────────────────────
console.log("【1】浏览器侧契约：三条路由字面量一个字都不能变");
// client.js（已构建产物）里写死了这三条，改任一字符 → 渠道卡片静默变空。
check("QODER_STATUS_ROUTE", qoder.QODER_STATUS_ROUTE, "/plugins/dsh-qoder-connect/status");
check("QODER_CHECKIN_ROUTE", qoder.QODER_CHECKIN_ROUTE, "/plugins/dsh-qoder-connect/checkin");
check("QODER_PROBE_ROUTE", qoder.QODER_PROBE_ROUTE, "/plugins/dsh-qoder-connect/probe");

// ── 2. 国区档案的四件套 ───────────────────────────────────────────────────
console.log("\n【2】国区档案：端点 / 会话类型 / provider id 与改造前一致");
check("推理网关", CN.gateway, "https://gateway.qoder.com.cn");
check("OpenAPI", CN.openapi, "https://openapi.qoder.com.cn");
check("会话类型 qoderclicn", CN.sessionType, "qoderclicn");
check("provider id qoder1（用户已选的模型不用重选）", CN.providerId, "qoder1");

console.log("\n【3】国区凭据与状态文件名不变（否则老部署升级后集体未登录）");
check("PAT 文件名", CN.patFile, "qoder.pat");
check("会话文件名", CN.sessionFile, "qoder-session.json");
check("运行态文件名", CN.stateFile, ".qoder-connect-state.json");
check("路由前缀", CN.routePrefix, "/plugins/dsh-qoder-connect");

// ── 4. 注册表里那条老条目 ─────────────────────────────────────────────────
console.log("\n【4】注册表：老的 `qoder` 条目形状与派生不变");
const entries = registry.DEFAULT_REGISTRY_CHANNELS;
const cnEntry = entries.find((e) => e.kind === "qoder" && (e.id === "qoder" || e.region === "cn"));
check("仍有 id=qoder 的国区条目", cnEntry?.id, "qoder");
const channel = registry.channelOf(cnEntry);
check("面板 provider 仍是 qoder1", channel.provider, "qoder1");
check("面板 statusPath 未变", channel.statusPath, "/plugins/dsh-qoder-connect/status");
check("面板 checkinPath 未变", channel.checkinPath, "/plugins/dsh-qoder-connect/checkin");
check("凭据提示仍是 connect-auth/qoder.pat", channel.credentialHint, "connect-auth/qoder.pat");

// ── 5. 缺省行为：不传 region 的调用方拿到国区 ──────────────────────────────
console.log("\n【5】region 缺省 = 国区（apply(ctx, {}) 的老调用方不受影响）");
// provider 用 regionProfileOf(options) 解析；这里断言"空对象落到 cn 档案"。
const src = fs.readFileSync(path.join(SRC, "lib", "providers", "qoder", "index.js"), "utf8");
check("regionProfileOf 存在", /function regionProfileOf\(options\)/.test(src), true);
check("缺省回落到 cn 档案", /QODER_REGIONS\[raw\] \?\? QODER_REGIONS\.cn/.test(src), true);
check("qoderRoutesOf 缺省 = cn", JSON.stringify(qoder.qoderRoutesOf(undefined)), JSON.stringify(qoder.qoderRoutesOf(CN)));
check("apply 仍导出", typeof qoder.apply, "function");

// ── 6. workbuddy / trae 的多实例契约没被连带改动 ──────────────────────────
console.log("\n【6】连带检查：另两条渠道的注册表派生未受影响");
const wb = entries.filter((e) => e.kind === "workbuddy");
check("workbuddy 仍是 4 个内置槽位", wb.length, 4);
for (const entry of wb) {
  const ch = registry.channelOf(entry);
  check(`[${entry.id}] 路由仍按编号派生`,
    ch.statusPath, `/plugins/dsh-workbuddy-connect/${entry.id.replace("workbuddy", "")}/status`);
}
const trae = entries.find((e) => e.kind === "trae");
check("trae 仍是单例", registry.channelOf(trae).id, "trae");
check("trae 路由未变", registry.channelOf(trae).statusPath, "/plugins/dsh-trae-connect/status");

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
