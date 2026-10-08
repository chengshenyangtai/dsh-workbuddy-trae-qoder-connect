/**
 * 渠道侧（Node 进程内）的小工具 —— trae 与 qoder 共用的**唯一一份**实现。
 *
 * ## 为什么要有这个文件
 *
 * 这三个函数在 trae 与 qoder 里各有一份**逐字相同**的副本：
 *
 *   · `readBody`      读干回环请求体 → `Buffer`
 *   · `pollInterval`  把配置里的轮询间隔夹到合法区间
 *   · `writeState`    把渠道状态写进 `$DSH_HOME/.<渠道>-connect-state.json`
 *
 * 两份副本此前一字不差，但没有任何机制保证它们继续一致 —— 改一处漏一处是这类
 * 重复的必然结局（本仓库已经踩过一次：两个 SSE reader 从相同起点漂移成了不同实现）。
 *
 * ## 与 `shared/http.js` 的分工
 *
 * `http.js` 是**宿主侧**工具（回环守卫、`writeJson`、凭据洗白），面板也会 import。
 * 这里的三个函数只服务渠道 provider，且都依赖 Node API（`Buffer`/`fs`），
 * 所以单独一个文件，避免把 Node 依赖带进浏览器半侧会 import 的模块。
 *
 * ## `readBody` 的两个契约（别合并）
 *
 * 面板侧也有一个 `readBody`，但那个返回 `string` 且带 64KB 上限；渠道侧这个返回
 * `Buffer` 且不设上限（要自己 `JSON.parse`）。两者语义不同，**故意不合并** ——
 * 与 `http.js` 顶部注释里"readBody 没有放进来"是同一个理由。
 *
 * @module dsh-connect/shared/node
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";

/** 读干请求体。返回 `Buffer`（调用方自己 decode/parse）。 */
export async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** 凭据巡检的默认间隔：30 秒。 */
const CREDENTIAL_POLL_MS = 30000;
/** 允许的最小间隔：100ms（再小就是在空转）。 */
const MIN_POLL_MS = 100;
/** 允许的最大间隔：1 天。 */
const MAX_POLL_MS = 86400000;

/**
 * 配置里的 `pollIntervalMs` 夹到合法区间。
 *
 * 非数字或小于下限一律回落到默认 30s；大于上限按上限截断 ——
 * 上限存在的意义是"别设成一周，那样凭据轮换后渠道会长时间不可用"。
 */
export function pollInterval(config) {
  const override = config?.pollIntervalMs;
  if (!Number.isFinite(override) || override < MIN_POLL_MS) return CREDENTIAL_POLL_MS;
  return Math.min(override, MAX_POLL_MS);
}

/**
 * 把渠道状态写进 `$DSH_HOME/<filename>`，附一个 ISO 时间戳。
 *
 * 两个渠道此前各有一份逐字相同的实现，唯一差别是文件名 —— 所以文件名是参数，
 * 其余（时间戳格式、缩进、落盘失败的处理）只有这一份。
 *
 * **落盘失败不抛**：这个文件是诊断用的，写不进去不该让渠道本身失败。
 * 但也**不静默**：以前是空 `catch {}`，于是"状态文件过期"这种最容易被误判成
 * "渠道没在跑"的现象没有任何线索。现在至少留一行日志。
 *
 * @param {{filename: string, patch: object, logger?: {warn?: Function}}} options
 */
export function writeState(options) {
  const { filename, patch, logger } = options;
  try {
    const path = join(resolveDshHome(), filename);
    writeFileSync(path, `${JSON.stringify({ ...patch, at: new Date().toISOString() }, null, 2)}\n`, "utf8");
  } catch (error) {
    logger?.warn?.(`dsh-connect: 状态文件 ${filename} 写入失败（渠道本身不受影响）`, error);
  }
}

