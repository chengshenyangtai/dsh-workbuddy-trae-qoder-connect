/**
 * 渠道无关的「推理等级探查」基础设施。
 *
 * ## 为什么要有它
 *
 * WorkBuddy 那套探查完整（哨兵法、存储、串行服务），但整套埋在它的 provider 里，
 * 且写入的是 WorkBuddy 专属格式（含 `pluginVersion` 指纹与变体文件名）。
 * Qoder 的目录**不声明档位**（只有 `is_reasoning` 布尔），因此同样需要探查 ——
 * 这时要么复制一份 WorkBuddy 的实现，要么抽出这里这份渠道无关的最小版本。
 *
 * ⚠️ **WorkBuddy 那条路径保持原样、不迁到这里**：它已在线上验证，且其存储格式、
 * 指纹算法都与之耦合；为了"统一"去改一条稳定路径，风险大于收益。
 * 本模块服务的是**新接入的渠道**。
 *
 * ## 三家的差异（不要一刀切）
 *
 * | 渠道 | 档位来源 | 探查 |
 * |---|---|---|
 * | Trae | 目录**按 (模型 × function) 声明** `options` | 不做，声明即权威 |
 * | Qoder | 目录只有 `is_reasoning` 布尔 | **哨兵拒绝法** |
 * | WorkBuddy | 部分声明，其余靠探查 | 已有实现（同法）|
 *
 * ## 探测方法论：哨兵拒绝法
 *
 * 顺序有意义、不是优化：
 *
 * 1. **基线**（不带档位）：证明模型/凭据/请求形状本身可用，否则后续拒绝无法归因；
 * 2. **哨兵**（随机且不可能撞上的值）：回答"上游到底校不校验这个字段" ——
 *    接受哨兵 = 传什么都收，那么逐档扫描的"接受"全是假阳性；
 * 3. **逐档扫描**：只在前两步确立"确实校验"之后才做。
 *
 * ⚠️ 本法**要求上游会拒绝非法值**。Trae 会静默忽略（实测乱填同样 200），
 * 对它无效 —— 幸好它靠目录声明就够了。
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** 每次调用都新生成，避免固定值被上游「学习」后放行。 */
export function randomSentinel() {
  return `zz-${randomUUID()}`;
}

/**
 * 探查一个模型的档位支持情况。
 *
 * `send(effort | undefined, signal)` 由调用方提供，返回 `{ status }`（HTTP 或业务码）；
 * 判定完全交给调用方的两个谓词（`isAcceptance` / `isEffortRejection`）——
 * "什么算拒绝"是渠道特有的（Qoder 认 400，WorkBuddy 认 `invalid_reasoning_effort`）。
 *
 * 返回 `{ validation, efforts, requests, reason? }`：
 *   · `validating`     —— 上游校验该字段，`efforts` 是被接受的档位；
 *   · `non-validating` —— 上游不校验（传什么都收），`efforts` 为空；
 *   · `unknown`        —— 无法归因（基线失败/哨兵出现意外错误），**不当结论用**。
 */
export async function probeModel(options) {
  const sentinel = options.sentinel ?? randomSentinel;
  // `candidates` 必填：档位拼写是渠道特有的（Qoder 认 low/medium/high/max，
  // Trae 认 light/high/extra_high），给一个"看起来通用的默认值"只会掩盖配错。
  const candidates = options.candidates;
  const timeoutMs = options.timeoutMs ?? 30000;
  const isAcceptance = options.isAcceptance;
  const isEffortRejection = options.isEffortRejection;
  let requests = 0;

  const attempt = async (effort) => {
    requests += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await options.send(effort, controller.signal);
    } catch (error) {
      return { status: 0, detail: `transport error: ${String(error)}` };
    } finally {
      clearTimeout(timer);
    }
  };

  // 1) 基线必须在，否则任何拒绝都无法归因。
  const baseline = await attempt(undefined);
  if (!isAcceptance(baseline)) {
    return { validation: "unknown", efforts: [], requests, reason: `baseline: ${describe(baseline)}` };
  }

  // 2) 哨兵：接受它 ⇒ 上游不校验，逐档扫描没有意义。
  const sentinelAttempt = await attempt(sentinel());
  if (isAcceptance(sentinelAttempt)) {
    return { validation: "non-validating", efforts: [], requests };
  }
  if (!isEffortRejection(sentinelAttempt)) {
    return { validation: "unknown", efforts: [], requests, reason: `sentinel: ${describe(sentinelAttempt)}` };
  }

  // 3) 逐档扫描：只有确证"会拒绝"之后才做。
  const accepted = [];
  for (const effort of candidates) {
    const result = await attempt(effort);
    if (isAcceptance(result)) {
      accepted.push(effort);
      continue;
    }
    if (isEffortRejection(result)) continue;
    return { validation: "unknown", efforts: [], requests, reason: `level ${effort}: ${describe(result)}` };
  }
  return { validation: "validating", efforts: accepted, requests };
}

/** 失败归因用的一句话描述（进了 `reason`，便于排查"为什么判成 unknown"）。 */
function describe(result) {
  const parts = [`status=${result?.status ?? "?"}`];
  if (result?.detail !== undefined) parts.push(String(result.detail).slice(0, 120));
  return parts.join(" ");
}

/**
 * 模型指纹：目录里但凡影响探查结论的字段一变，旧结果就该作废。
 *
 * 只取与档位相关的字段（参考 WorkBuddy 的做法），不把整个目录塞进来 ——
 * 否则倍率一变就会误判成"模型变了"。
 */
export function fingerprintModel(info) {
  const basis = JSON.stringify({
    id: info?.id ?? "",
    reasoning: info?.reasoning ?? null,
    isReasoning: info?.isReasoning ?? null,
  });
  return createHash("sha256").update(basis).digest("hex").slice(0, 16);
}

/**
 * 探查结果存储：`$DSH_HOME/<filename>`。
 *
 * 一条记录只描述"观测到的接受集合"，**不是**对上游的承诺；因此读取方永远
 * 让"目录声明"优先于"观测结果"（见各渠道的单文件说明）。
 */
export class ProbeStore {
  constructor(options) {
    this.path = options.path;
    this.version = options.version ?? 1;
    this.logger = options.logger;
  }

  read() {
    try {
      if (!existsSync(this.path)) return { version: this.version, records: {} };
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      if (parsed?.version !== this.version || typeof parsed.records !== "object" || parsed.records === null) {
        return { version: this.version, records: {} };
      }
      return parsed;
    } catch {
      return { version: this.version, records: {} };
    }
  }

  /** 读取一条记录；指纹不符即视为不存在（模型变过，结论失效）。 */
  get(modelId, fingerprint, account) {
    const record = this.read().records?.[account]?.[modelId];
    if (record === undefined) return undefined;
    if (record.fingerprint !== fingerprint) return undefined;
    return record;
  }

  put(modelId, fingerprint, account, result) {
    const doc = this.read();
    doc.records[account] ??= {};
    doc.records[account][modelId] = {
      fingerprint,
      validation: result.validation,
      efforts: Array.isArray(result.efforts) ? [...result.efforts] : [],
      requests: result.requests ?? 0,
      // 毫秒时间戳：前端的结果提示直接 `formatTime(probedAt)` 用它（与 WorkBuddy
      // 的 `probedAtMs` 同形状）。写 ISO 字符串会让那一处显示异常。
      probedAt: Date.now(),
    };
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, this.path);
    } catch (error) {
      this.logger?.warn?.(`probe: 写结果失败（${this.path}）：${String(error)}`);
    }
    return doc.records[account][modelId];
  }
}

/**
 * 串行执行器：同一时刻只跑一个探查，重复请求合并到同一次运行。
 *
 * 为什么必须串行：探查会**花真实额度**，而且逐档扫描是多个连续请求；
 * 并发跑会互相限流、也会让"失败归因"变得不可能（这正是我早前批量跑
 * Qoder 探针时踩的坑：4 档 × 3 轮连发，后面的请求全超时）。
 */
export class ProbeService {
  constructor(options) {
    this.options = options;
    this.queue = Promise.resolve();
    this.pending = new Map();
    this.running = false;
  }

  isRunning() {
    return this.running;
  }

  /** 已有可用记录就返回它，避免重复花额度；`force` 可绕过。 */
  cached(modelId) {
    const info = this.options.catalog().find((m) => m.id === modelId);
    if (info === undefined) return undefined;
    const account = this.options.account();
    if (account === undefined) return undefined;
    return this.options.store.get(modelId, fingerprintModel(info), account);
  }

  async probe(modelId, manualConsent = false) {
    if (!manualConsent && this.options.consent?.() !== true) {
      return { state: "unavailable", reason: "probing is not authorized" };
    }
    const info = this.options.catalog().find((m) => m.id === modelId);
    if (info === undefined) return { state: "unavailable", reason: `unknown model: ${modelId}` };
    const account = this.options.account();
    if (account === undefined) return { state: "unavailable", reason: "no credential" };

    const key = `${account}\u0000${modelId}`;
    const inflight = this.pending.get(key);
    if (inflight !== undefined) return inflight;

    const run = this.queue.then(async () => {
      this.running = true;
      try {
        const result = await this.options.run(modelId);
        if (result.validation !== "unknown") {
          this.options.store.put(modelId, fingerprintModel(info), account, result);
          /**
           * 探查改变了"这个模型支持哪些档位"，而档位是写在**模型描述符**里的 ——
           * 不通知宿主重建模型列表，用户就会看到"探测成功但档位没变"。
           * 各渠道把它接到自己的 `llm/adapters-updated` 上。
           */
          try {
            this.options.onProbed?.(modelId, result);
          } catch (error) {
            this.options.logger?.warn?.(`probe: onProbed 回调失败：${String(error)}`);
          }
        }
        return { state: "ok", ...result };
      } catch (error) {
        return { state: "failed", reason: String(error?.message ?? error).slice(0, 200) };
      } finally {
        this.running = false;
      }
    });
    this.pending.set(key, run);
    this.queue = run.then(() => undefined, () => undefined);
    try {
      return await run;
    } finally {
      this.pending.delete(key);
    }
  }
}
