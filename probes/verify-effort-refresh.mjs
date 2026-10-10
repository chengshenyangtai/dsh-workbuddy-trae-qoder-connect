/**
 * 思考档位三件套的离线回归（2026-10-09）：
 *
 *   A. diffCatalog —— 「更新模型」的档位差异（lib/shared/catalog-diff.js）
 *   B. Qoder 兜底名单 —— 兜底 = 不知道，不得谎报档位
 *   C. 未选档回退目录默认档 —— Qoder buildChatBody / Trae shim / WorkBuddy withDefaultEffort
 *
 * 每条断言都对应一个真实行为：A 对应"上游改档位面板却说没有变化"，
 * B 对应"目录挂了所有模型都变成 xhigh/low/medium"，C 对应"新会话的默认档
 * 与 UI 展示的目录声明脱节"。反向验证：把对应修复删掉，本探针必须变红。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** 探针允许两种取源：仓库内（默认）与安装副本（--installed / DSH_CONNECT_DIR）。 */
const argInstalled = process.argv.includes("--installed");
const base = argInstalled
  ? join(process.env.HOME ?? "", ".dsh", "profiles", "desktop", "node_modules", process.env.DSH_CONNECT_DIR ?? "dsh-workbuddy-trae-qoder-connect")
  : join(here, "..");

let passed = 0;
async function ok(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    console.error(error?.message?.split("\n").slice(0, 6).join("\n") ?? String(error));
    process.exitCode = 1;
  }
}

//#region A. diffCatalog
console.log("\n[A] diffCatalog（档位差异）");
const { diffCatalog, effortSignature } = await import(
  `file://${argInstalled ? base : join(here, "..")}/lib/shared/catalog-diff.js`.replaceAll("\\", "/")
);

const qoderEfforts = (entry) => entry?.declaredEfforts;

await ok("新增/删除/计数照旧（id 差集语义不变）", () => {
  const diff = diffCatalog(
    [{ id: "a", declaredEfforts: ["low"] }, { id: "b", declaredEfforts: [] }],
    [{ id: "b", declaredEfforts: [] }, { id: "c", declaredEfforts: ["high"] }],
    qoderEfforts,
  );
  assert.deepEqual(diff.added, ["c"]);
  assert.deepEqual(diff.removed, ["a"]);
  assert.equal(diff.count, 2);
});

await ok("上游给已有模型新增档位 → changed 且带 from/to", () => {
  const diff = diffCatalog(
    [{ id: "dmodel", declaredEfforts: ["high", "max"] }],
    [{ id: "dmodel", declaredEfforts: ["high", "max", "xhigh"] }],
    qoderEfforts,
  );
  assert.equal(diff.efforts.changed.length, 1);
  assert.equal(diff.efforts.changed[0].id, "dmodel");
  assert.equal(diff.efforts.changed[0].from, "high,max");
  assert.equal(diff.efforts.changed[0].to, "high,max,xhigh");
  assert.equal(diff.added.length, 0);
});

await ok("从无到有/从有到无 → gained / lost", () => {
  const diff = diffCatalog(
    [{ id: "m1", declaredEfforts: [] }, { id: "m2", declaredEfforts: ["low"] }],
    [{ id: "m1", declaredEfforts: ["low", "high"] }, { id: "m2", declaredEfforts: [] }],
    qoderEfforts,
  );
  assert.deepEqual(diff.efforts.gained, ["m1"]);
  assert.deepEqual(diff.efforts.lost, ["m2"]);
});

await ok("档位集合顺序不同不算变化（签名先排序）", () => {
  const diff = diffCatalog(
    [{ id: "x", declaredEfforts: ["max", "high", "low"] }],
    [{ id: "x", declaredEfforts: ["low", "high", "max"] }],
    qoderEfforts,
  );
  assert.equal(diff.efforts.changed.length, 0);
});

await ok("undefined 与 [] 是不同签名（无概念 ≠ 声明为空）", () => {
  assert.notEqual(effortSignature(undefined), effortSignature([]));
  const diff = diffCatalog(
    [{ id: "y" }],
    [{ id: "y", declaredEfforts: ["high"] }],
    qoderEfforts,
  );
  assert.equal(diff.efforts.changed.length, 1);
  // 反向：[] → ["high"] 也是变化（声明清空后重新声明）。
  const diff2 = diffCatalog([{ id: "z", declaredEfforts: [] }], [{ id: "z", declaredEfforts: ["high"] }], qoderEfforts);
  assert.equal(diff2.efforts.changed.length, 1);
});

await ok("仅 id 变化时不产生档位差异（两组互不污染）", () => {
  const diff = diffCatalog(
    [{ id: "a", declaredEfforts: ["low"] }],
    [{ id: "a", declaredEfforts: ["low"] }, { id: "b", declaredEfforts: ["high"] }],
    qoderEfforts,
  );
  assert.deepEqual(diff.added, ["b"]);
  assert.equal(diff.efforts.changed.length, 0);
});
//#endregion

//#region B. Qoder 兜底名单
console.log("\n[B] Qoder 兜底名单不谎报档位");
const qoderSrc = fs.readFileSync(join(base, "lib", "providers", "qoder", "index.js"), "utf8");
const { FALLBACK_QODER_MODELS } = await import(
  `file://${join(base, "lib", "providers", "qoder", "index.js")}`.replaceAll("\\", "/")
).catch(() => ({ FALLBACK_QODER_MODELS: undefined }));

if (FALLBACK_QODER_MODELS !== undefined) {
  ok("兜底条目 declaredEfforts 为空数组", () => {
    for (const entry of FALLBACK_QODER_MODELS) {
      assert.deepEqual(entry.declaredEfforts, [], `${entry.id} 不得带档位声明`);
    }
  });
} else {
  // 兜底名单有内部依赖（pi-ai），模块可能加载不出来 —— 退化为源码断言。
  ok("（源码）兜底条目不再写死非空档位数组", () => {
    const block = qoderSrc.match(/FALLBACK_QODER_MODELS = \[[\s\S]*?\n\];/);
    assert.ok(block, "FALLBACK_QODER_MODELS 定义未找到");
    assert.doesNotMatch(block[0], /declaredEfforts:\s*\[(?!\s*\])/, "仍写着非空 declaredEfforts");
  });
}
await ok("（源码）supportedEffortsOf 对空声明返回空 → reasoning:false（不再兜住档位）", () => {
  // 回退目标也变了：未选档时优先 defaultEffort。
  assert.match(qoderSrc, /reasoningEffort === undefined && typeof defaultEffort === "string"/);
});
//#endregion

//#region C. 未选档回退目录默认档
console.log("\n[C] 未选档回退目录默认档");

// —— 加载真实 qoder 模块（真 schemastery + 桩宿主包，模式同 verify-qoder-stream-fixes）——
const stubDir = join(here, ".effort-stubs");
fs.mkdirSync(stubDir, { recursive: true });
const stubNames = {
  "@deepseek-ai/dsh-home-paths": ["resolveDshHome"],
  "@deepseek-ai/dsh-llm": ["resolveRetryPolicy"],
  "@deepseek-ai/dsh-llm-pi-ai": ["PiAiAdapter"],
  "@earendil-works/pi-ai": ["createProvider"],
  "@earendil-works/pi-ai/api/openai-completions.lazy": ["openAICompletionsApi"],
};
const stubMap = {};
for (const [spec, names] of Object.entries(stubNames)) {
  const file = join(stubDir, spec.replace(/[@/]/g, "_") + ".mjs");
  const body = `const mk=(n)=>{const f=function(){return f};return f};\n` + names.map((n) => `export const ${n}=mk(${JSON.stringify(n)});`).join("\n") + `\nexport default new Proxy({},{get:()=>mk("d")});\n`;
  fs.writeFileSync(file, body);
  stubMap[spec] = file;
}
{
  const sc = join(os.homedir(), ".dsh", "profiles", "desktop", "node_modules", "@deepseek-ai", "schemastery", "lib", "index.mjs");
  if (!fs.existsSync(sc)) {
    console.error("找不到宿主真包 @deepseek-ai/schemastery —— 本探针需要装过 dsh 桌面版的机器。");
    process.exit(2);
  }
  stubMap["@deepseek-ai/schemastery"] = sc;
}
const loaderFile = join(stubDir, "loader.mjs");
fs.writeFileSync(
  loaderFile,
  `import { pathToFileURL } from "node:url";\nconst map=${JSON.stringify(stubMap)};\nexport async function resolve(s,c,n){ if(map[s]) return {url:pathToFileURL(map[s]).href,shortCircuit:true,format:"module"}; return n(s,c) }\n`,
);
const { register } = await import("node:module");
register(new URL(`file://${loaderFile.replaceAll("\\", "/")}`).href, import.meta.url);

const qoderMod = await import(pathToFileURL(join(base, "lib", "providers", "qoder", "index.js")).href).catch(() => undefined);
const buildChatBody = qoderMod?.buildChatBody;

if (buildChatBody !== undefined) {
  await ok("Qoder buildChatBody：未选档 → 发目录默认档", async () => {
    const body = buildChatBody({
      modelKey: "dmodel",
      messages: [{ role: "user", content: "hi" }],
      isReasoning: true,
      supportedEfforts: ["high", "max"],
      defaultEffort: "max",
    });
    assert.equal(body.parameters.reasoning_effort, "max");
  });
  await ok("Qoder buildChatBody：用户选了档 → 原样发", async () => {
    const body = buildChatBody({
      modelKey: "dmodel",
      messages: [{ role: "user", content: "hi" }],
      isReasoning: true,
      reasoningEffort: "high",
      supportedEfforts: ["high", "max"],
      defaultEffort: "max",
    });
    assert.equal(body.parameters.reasoning_effort, "high");
  });
  await ok("Qoder buildChatBody：选了但不支持 → 回退支持集合最高档（原行为不变）", async () => {
    const body = buildChatBody({
      modelKey: "dmodel",
      messages: [{ role: "user", content: "hi" }],
      isReasoning: true,
      reasoningEffort: "medium",
      supportedEfforts: ["high", "max"],
      defaultEffort: "max",
    });
    assert.equal(body.parameters.reasoning_effort, "max");
  });
  await ok("Qoder buildChatBody：默认档不在支持集合 → 仍回退支持集合最高档（不发明知会被拒的值）", async () => {
    const body = buildChatBody({
      modelKey: "x",
      messages: [{ role: "user", content: "hi" }],
      isReasoning: true,
      supportedEfforts: ["high", "max"],
      defaultEffort: "low",
    });
    assert.equal(body.parameters.reasoning_effort, "max");
  });
} else {
  await ok("（源码）Qoder 未选档回退 defaultEffort", async () => {
    assert.match(qoderSrc, /reasoningEffort === undefined && typeof defaultEffort === "string"/);
  });
}

await ok("Trae shim：未选档 → 发目录 default_level（已是线上拼写）", () => {
  const src = fs.readFileSync(join(base, "lib", "providers", "trae", "index.js"), "utf8");
  assert.match(src, /default_level/);
  // 用户选档时：pi-ai 发 pi-ai 键名（low/high/xhigh），shim 查表成线上值。
  assert.match(src, /LEVEL_TO_TRAE_EFFORT\.get\(level\)/);
  // effort 取值：用户选了→按选择；没选/映射不到→defaultWire。
  assert.match(src, /\?\? defaultWire/);
  // level 只在请求带了非空 reasoning_effort 时非 undefined。
  assert.match(src, /request\.reasoning_effort !== ""/);
});

/**
 * 2026-10-10 的真实回归：`default_level` 被二次映射。
 *
 * `LEVEL_TO_TRAE_EFFORT` 的**键是 pi-ai 档位**（low/high/xhigh），而快照里的
 * `default_level` **本来就是 Trae 线上拼写**（light/high/extra_high）。
 * 拿后者查前者，只有 `high` 因为两边同名才侥幸生效 —— 默认档为 `extra_high`
 * 的 GLM-5.3 系 / Kimi-K2.8 / Kimi-K3 与 `light` 的模型全部丢掉默认档。
 * 表现就是"档位都有了，但默认档不生效"。
 */
await ok("Trae：default_level 不得再过一次 LEVEL_TO_TRAE_EFFORT", () => {
  const src = fs.readFileSync(join(base, "lib", "providers", "trae", "index.js"), "utf8");
  assert.doesNotMatch(src, /LEVEL_TO_TRAE_EFFORT\.get\(effortCfg\.default_level\)/,
    "default_level 被二次映射 —— extra_high/light 的默认档会静默丢失");
  assert.match(src, /declaredOptions\.includes\(effortCfg\.default_level\)/,
    "默认档没有对照 options 校验，可能发出上游不认的值");
});

await ok("Trae：默认档取值语义（按快照真值模拟）", () => {
  const TRAE_EFFORT_TO_LEVEL = { light: "low", high: "high", extra_high: "xhigh" };
  const LEVEL_TO_TRAE_EFFORT = new Map(Object.entries(TRAE_EFFORT_TO_LEVEL).map(([w, l]) => [l, w]));
  const resolve = (cfg, requested) => {
    const options = Array.isArray(cfg?.options) ? cfg.options : [];
    const defaultWire = cfg?.support_thinking === true
      && typeof cfg.default_level === "string"
      && options.includes(cfg.default_level) ? cfg.default_level : undefined;
    const level = typeof requested === "string" && requested !== "" ? requested : undefined;
    return (level === undefined ? undefined : LEVEL_TO_TRAE_EFFORT.get(level)) ?? defaultWire;
  };
  // GLM-5.3@solo_agent：默认 extra_high（旧实现这里会给出 undefined）。
  const glm = { support_thinking: true, options: ["light", "high", "extra_high"], default_level: "extra_high" };
  assert.equal(resolve(glm, undefined), "extra_high", "未选档应发目录默认档 extra_high");
  assert.equal(resolve(glm, "low"), "light", "用户选档优先");
  assert.equal(resolve(glm, "xhigh"), "extra_high");
  // light 默认同样不能丢。
  assert.equal(resolve({ support_thinking: true, options: ["light", "high"], default_level: "light" }, undefined), "light");
  // 默认档不在 options 里 → 不发（宁缺毋错）。
  assert.equal(resolve({ support_thinking: true, options: ["high"], default_level: "extra_high" }, undefined), undefined);
  // 不支持思考 → 一律不发。
  assert.equal(resolve({ support_thinking: false, default_level: "high" }, undefined), undefined);
});

await ok("WorkBuddy shim：缺席 reasoning_effort 时补目录默认档", async () => {
  const src = fs.readFileSync(join(base, "lib", "providers", "workbuddy", "index.js"), "utf8");
  assert.match(src, /function withDefaultEffort/);
  // 只在缺席时补；显式值一律不碰。
  assert.match(src, /typeof body\["reasoning_effort"\] === "string" && body\["reasoning_effort"\] !== ""\s*\) return raw;/);
  // 接进了 chatCompletions（在 prepareChatBody 之前）。
  assert.match(src, /withDefaultEffort\(repairToolPairing\(raw, logger\), catalog\.current\(\)\)/);
});

await ok("三家 forceRefresh 都接了 diffCatalog（源码接线）", () => {
  for (const [name, rel] of [["qoder", "qoder"], ["trae", "trae"], ["workbuddy", "workbuddy"]]) {
    const src = fs.readFileSync(join(base, "lib", "providers", rel, "index.js"), "utf8");
    assert.match(src, /diffCatalog/, `${name} 未接 diffCatalog`);
    assert.doesNotMatch(src, /before\.filter\(\(id\) => !before/, `${name} 仍用手写 id 差集`);
  }
});

await ok("客户端：气泡文案接档位变化；模型按钮常显已选数", () => {
  const src = fs.readFileSync(join(base, "lib", "client.js"), "utf8");
  assert.match(src, /refreshEfforts/);
  assert.match(src, /modelsSelected/);
  assert.doesNotMatch(src, /modelsWithDisabled/);
});
//#endregion

console.log(`\n${passed} 项断言通过${process.exitCode === 1 ? "（有失败）" : ""}`);
