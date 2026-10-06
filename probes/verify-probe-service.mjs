/**
 * 通用探查服务（lib/shared/probe.js）逻辑验证
 *
 * 为什么必须单独验证它：这是三渠道共用的地基，判错后果很严重 ——
 *   · 把"上游不校验"判成 validating → UI 给出根本没用的档位；
 *   · 把"基线失败"判成 non-validating → 掩盖真实故障（凭据/请求形状错）；
 *   · 把"401/502"当成"档位被拒" → 报告出完全不存在的结论。
 *
 * 全部用**假 sender**（无网络、无额度消耗），覆盖三种结论与各类边界。
 * 真实上游行为已由 qoder-effort-probe.mjs（含对照组）与 trae-effort-full.mjs 实测。
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// 插件装在 profile 的 node_modules 下；用 homedir 计算绝对路径，
// 别用相对路径（`../../../.dsh/...` 会多算一层 .dsh，前面就踩过）。
const PROBE_MODULE = join(homedir(), ".dsh", "profiles", "desktop", "node_modules", "dsh-connect", "lib", "shared", "probe.js");
const { ProbeService, ProbeStore, fingerprintModel, probeModel, randomSentinel } = await import(`file:///${PROBE_MODULE.replace(/\\/g, "/")}`);

let pass = 0;
let fail = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`); }
};

/** 测试自用的候选集：档位拼写是「渠道特有」的，所以由调用方提供（与真实用法一致）。 */
const CANDIDATES = ["low", "medium", "high", "xhigh", "max"];

const ACCEPT = (extra = {}) => ({ status: 200, streamed: true, ...extra });
const REJECT = (status = 400) => ({ status, streamed: false });

/** 造一个按脚本回应的 sender；脚本键：基线/sentinel/各档位。 */
function scriptedSender(script, sentinelValue = "sentinel-fixed") {
  const sentinel = () => sentinelValue;
  return {
    sentinel,
    send: async (effort) => {
      const key = effort === undefined ? "__baseline__" : (effort === sentinelValue ? "__sentinel__" : effort);
      const reply = script[key];
      if (typeof reply === "function") return reply(effort);
      return reply ?? ACCEPT();
    },
  };
}

console.log("【1】三种结论判定");

// (a) 上游校验：哨兵被拒 + 部分档位被接受
{
  const s = scriptedSender({ __baseline__: ACCEPT(), __sentinel__: REJECT(), low: ACCEPT(), medium: REJECT(), high: ACCEPT(), xhigh: REJECT(), max: ACCEPT() });
  const r = await probeModel({ send: s.send, sentinel: s.sentinel, candidates: CANDIDATES, isAcceptance: (a) => a.status === 200, isEffortRejection: (a) => a.status === 400 });
  check("(a) 哨兵被拒 → validating", r.validation, "validating");
  check("(a) 收集到被接受的档位", r.efforts, ["low", "high", "max"]);
}

// (b) 上游不校验：哨兵也被接受
{
  const s = scriptedSender({ __baseline__: ACCEPT(), __sentinel__: ACCEPT() });
  const r = await probeModel({ send: s.send, sentinel: s.sentinel, candidates: CANDIDATES, isAcceptance: (a) => a.status === 200, isEffortRejection: (a) => a.status === 400 });
  check("(b) 哨兵被接受 → non-validating", r.validation, "non-validating");
  check("(b) 不给出任何档位", r.efforts, []);
  check("(b) 只发了 2 个请求（不浪费额度扫档位）", r.requests, 2);
}

// (c) 基线失败 → unknown（不掩盖故障）
{
  const s = scriptedSender({ __baseline__: REJECT(401) });
  const r = await probeModel({ send: s.send, sentinel: s.sentinel, candidates: CANDIDATES, isAcceptance: (a) => a.status === 200, isEffortRejection: (a) => a.status === 400 });
  check("(c) 基线 401 → unknown", r.validation, "unknown");
  check("(c) 带归因原因", /baseline/.test(r.reason ?? ""), true);
  check("(c) 只发了 1 个请求", r.requests, 1);
}

console.log("\n【2】边界：非归因类错误不得被当成档位拒绝");
{
  // 哨兵回 502（网关抖动）——不能被当成"确实校验"
  const s = scriptedSender({ __baseline__: ACCEPT(), __sentinel__: REJECT(502) });
  const r = await probeModel({ send: s.send, sentinel: s.sentinel, candidates: CANDIDATES, isAcceptance: (a) => a.status === 200, isEffortRejection: (a) => a.status === 400 });
  check("哨兵 502 → unknown（不是 validating）", r.validation, "unknown");
  check("原因里指明 sentinel", /sentinel/.test(r.reason ?? ""), true);
}
{
  // 扫档位时出现 500 —— 同样不能继续，否则会把"故障"记成"不支持"
  const s = scriptedSender({ __baseline__: ACCEPT(), __sentinel__: REJECT(), low: ACCEPT(), medium: REJECT(500) });
  const r = await probeModel({ send: s.send, sentinel: s.sentinel, candidates: CANDIDATES, isAcceptance: (a) => a.status === 200, isEffortRejection: (a) => a.status === 400 });
  check("扫到 500 → unknown", r.validation, "unknown");
  check("原因里指明 level medium", /level medium/.test(r.reason ?? ""), true);
}
{
  // 传输异常（异常对象）也要归到 unknown，不能崩
  const s = { sentinel: () => "x", send: async () => { throw new Error("ECONNRESET"); } };
  const r = await probeModel({ send: s.send, sentinel: s.sentinel, isAcceptance: () => false, isEffortRejection: () => false });
  check("传输异常 → unknown 且不抛", r.validation, "unknown");
}

console.log("\n【3】哨兵每次都不同（防止被上游「学习」后放行）");
{
  const a = randomSentinel();
  const b = randomSentinel();
  check("两次哨兵不同", a !== b, true);
  check("哨兵是字符串且非空", typeof a === "string" && a.length > 8, true);
}

console.log("\n【4】ProbeStore：指纹不符即失效");
{
  const dir = mkdtempSync(join(tmpdir(), "probe-store-"));
  try {
    const store = new ProbeStore({ path: join(dir, ".probe.json"), version: 1 });
    const info = { id: "m1", isReasoning: true };
    const fp1 = fingerprintModel(info);
    store.put("m1", fp1, "acct", { validation: "validating", efforts: ["low"], requests: 3 });
    check("同指纹可读回", store.get("m1", fp1, "acct")?.efforts, ["low"]);
    // 模型能力变了 → 指纹变 → 旧结论必须失效
    const fp2 = fingerprintModel({ id: "m1", isReasoning: false });
    check("指纹变化后读不到（结论失效）", store.get("m1", fp2, "acct"), undefined);
    check("账号隔离", store.get("m1", fp1, "other"), undefined);
    check("落盘文件存在", existsSync(join(dir, ".probe.json")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n【5】ProbeService：串行 + 去重 + 缓存");
{
  const dir = mkdtempSync(join(tmpdir(), "probe-svc-"));
  try {
    const store = new ProbeStore({ path: join(dir, ".probe.json"), version: 1 });
    let runs = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    const info = { id: "m1", isReasoning: true };
    const svc = new ProbeService({
      consent: () => true,
      catalog: () => [info],
      account: () => "acct",
      store,
      run: async () => {
        runs += 1;
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 30));
        concurrent -= 1;
        return { validation: "validating", efforts: ["low"], requests: 3 };
      },
    });
    // 同一模型并发两次：必须合并成一次运行
    const [r1, r2] = await Promise.all([svc.probe("m1", true), svc.probe("m1", true)]);
    check("并发同一模型只跑一次", runs, 1);
    check("两次都拿到结果", [r1.state, r2.state], ["ok", "ok"]);
    check("最大并发为 1（串行）", maxConcurrent, 1);
    check("结果已落盘可缓存", svc.cached("m1")?.efforts, ["low"]);

    // 未授权时不得运行
    const deny = new ProbeService({ consent: () => false, catalog: () => [info], account: () => "acct", store, run: async () => { runs += 1; return {}; } });
    const denied = await deny.probe("m1", false);
    check("未授权 → unavailable", denied.state, "unavailable");
    check("未授权不触发运行", runs, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

