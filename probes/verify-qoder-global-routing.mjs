#!/usr/bin/env node
// probes/verify-qoder-global-routing.mjs
// 钉死 Qoder 双区域（国区 `qoder` / 国际版 `qoder-global`）的**路由与凭据落点**。
//
// ## 为什么需要它
//
// 双区域是 2026-10-19 加的：国际版走 `*.qoder.sh`、国区走 `*.qoder.com.cn`，
// 两套服务账号/额度/目录都不互通，所以必须能同时挂两个 provider。
//
// 这个改动把"三处必须逐字相同"的东西拆成了两份，而它们分居不同文件：
//
//   1. `channel-registry.js` 的 `channelOf()` —— 面板按它拼 URL 去 fetch；
//   2. `providers/qoder/index.js` 的 `qoderRoutesOf()` —— provider 按它注册路由；
//   3. 两份凭据/状态文件名 —— provider 读它们，面板拿它判"槽位是否已配置"。
//
// 任何一处漏改，症状都是**静默**的：面板那条渠道 404（看起来像"插件没加载"），
// 或者国际版把国区的会话文件当成自己的（看起来像"串号"）。所以钉死它们。
//
// ## 断言的边界
//
// 只断言"两边算出来的字符串一致"与"四个命名空间两两不相交"，
// 不钉具体路由写法 —— 日后要改成 `/plugins/dsh-qoder-connect/<region>/*`
// 这种形态时，探针该绿还是绿。
//
// 用法：node probes/verify-qoder-global-routing.mjs [--installed]

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

const show = (name, detail) => console.log(`  · ${name}${detail === undefined ? "" : ` → ${detail}`}`);

// ── 载入两个模块 ──────────────────────────────────────────────────────────
// provider 顶层 import 了宿主 peer（schemastery / pi-ai / dsh-llm…），
// 裸 node 下解析不到，所以用 stub loader 把它们换成显式声明的最小替身
// （符合 probes/README.md 的"stub 必须显式声明缺哪个包"）。
const STUB_DIR = path.join(HERE, "_qoder-stubs");
const loaderPath = path.join(STUB_DIR, "loader.mjs");

if (!fs.existsSync(loaderPath)) {
  console.error(`缺少 stub loader：${loaderPath}`);
  process.exit(1);
}

const { register } = await import("node:module");
register(pathToFileURL(loaderPath).href, import.meta.url);

const registry = await import(pathToFileURL(path.join(SRC, "lib", "channel-registry.js")).href);
const qoder = await import(pathToFileURL(path.join(SRC, "lib", "providers", "qoder", "index.js")).href);

// ── 区域档案 ──────────────────────────────────────────────────────────────
console.log("【1】两个区域都在档案表里");
const REGIONS = qoder.QODER_REGIONS ?? {};
check("QODER_REGIONS 导出且含 cn", typeof REGIONS.cn, "object");
check("QODER_REGIONS 含 global", typeof REGIONS.global, "object");
show("cn 端点", `${REGIONS.cn?.gateway} / ${REGIONS.cn?.openapi}`);
show("global 端点", `${REGIONS.global?.gateway} / ${REGIONS.global?.openapi}`);

console.log("\n【2】两套服务真的是两套域名（不是同一份配置复制粘贴）");
check("推理网关不同", REGIONS.cn?.gateway !== REGIONS.global?.gateway, true);
check("OpenAPI 不同", REGIONS.cn?.openapi !== REGIONS.global?.openapi, true);
check("国际版走 qoder.sh", /^https:\/\/[a-z0-9.-]*qoder\.sh/i.test(REGIONS.global?.gateway ?? ""), true);
check("国区走 qoder.com.cn", /^https:\/\/[a-z0-9.-]*qoder\.com\.cn/i.test(REGIONS.cn?.gateway ?? ""), true);
check("会话类型区分（qoderclicn / qodercli）", [REGIONS.cn?.sessionType, REGIONS.global?.sessionType], ["qoderclicn", "qodercli"]);

console.log("\n【3】provider id 两两不同（否则模型组会混在一起）");
const ids = [REGIONS.cn?.providerId, REGIONS.global?.providerId];
check("两个 providerId 都存在", ids.every((v) => typeof v === "string" && v.length > 0), true);
check("两个 providerId 不相等", ids[0] !== ids[1], true);
show("providerId", ids.join(" / "));

console.log("\n【4】注册表派生 ≡ provider 注册（面板按前者 fetch，provider 按后者挂）");
const qoderEntries = registry.DEFAULT_REGISTRY_CHANNELS.filter((e) => e.kind === "qoder");
check("默认表里 qoder 有两个实例", qoderEntries.length, 2);
check("两个实例 id 分别是 qoder / qoder-global",
  qoderEntries.map((e) => e.id).sort(), ["qoder", "qoder-global"]);

for (const entry of qoderEntries) {
  const channel = registry.channelOf(entry);
  const regionKey = channel.region === "global" ? "global" : "cn";
  const routes = qoder.qoderRoutesOf(REGIONS[regionKey]);
  check(`[${entry.id}] statusPath 与 provider 路由逐字一致`, channel.statusPath, routes.status);
  check(`[${entry.id}] checkinPath 与 provider 路由逐字一致`, channel.checkinPath, routes.checkin);
  check(`[${entry.id}] 面板 provider 与区域档案一致`, channel.provider, REGIONS[regionKey].providerId);
  show(`[${entry.id}]`, `${channel.provider} → ${channel.statusPath}`);
}

console.log("\n【5】四条命名空间两两不相交（串了就会互相覆盖）");
const filesOf = (r) => [r.patFile, r.sessionFile, r.stateFile, r.routePrefix];
const names = ["patFile", "sessionFile", "stateFile", "routePrefix"];
for (let i = 0; i < names.length; i += 1) {
  check(`${names[i]} 两区不同`, REGIONS.cn[names[i]] !== REGIONS.global[names[i]], true);
}
const cnAll = new Set(filesOf(REGIONS.cn));
const globalAll = filesOf(REGIONS.global);
check("国际版没有任何一个名字撞进国区", globalAll.some((v) => cnAll.has(v)), false);

console.log("\n【6】国区对外常量逐字不变（老部署升级后行为不动）");
// 这三条是 client.js 里的字面量 + 已装浏览器侧产物的契约，改一个字就打不到。
check("QODER_STATUS_ROUTE", qoder.QODER_STATUS_ROUTE, "/plugins/dsh-qoder-connect/status");
check("QODER_CHECKIN_ROUTE", qoder.QODER_CHECKIN_ROUTE, "/plugins/dsh-qoder-connect/checkin");
check("QODER_PROBE_ROUTE", qoder.QODER_PROBE_ROUTE, "/plugins/dsh-qoder-connect/probe");
check("国区 status 路由 === 常量",
  qoder.qoderRoutesOf(REGIONS.cn).status, qoder.QODER_STATUS_ROUTE);

console.log("\n【7】region 缺省即国区（不传 region 的老调用方不受影响）");
// apply 内部走 regionProfileOf(config)；这里只断言"cn 档案不会因为多出 global 而变"。
check("cn 档案 id 仍是 cn", REGIONS.cn.id, "cn");
check("global 档案 id 是 global", REGIONS.global.id, "global");

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
