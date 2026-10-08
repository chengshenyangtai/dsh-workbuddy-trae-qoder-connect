/**
 * 「隐藏哪些模型」的共享契约 —— 面板（写偏好）与三个 provider（读偏好）共用。
 *
 * ## 为什么单开一个文件
 *
 * 这段逻辑既不属于 `shared/http.js`（HTTP 守卫），也不属于 `shared/node.js`
 * （fs/stream 工具），而且 provider 与 panel 都要 import 它。放这里可以避免
 * provider 反向依赖 panel.js（那会把整个面板拖进渠道的模块图）。
 *
 * ## 它解决的问题（2026-10-08 用户反馈）
 *
 * 用户勾选了部分常用模型，然后**临时禁用整个渠道**，再启用 —— 结果**所有模型
 * 又变回勾选状态**，逐模型的偏好"没有记忆"。
 *
 * 根因是两件事被塞进同一个存储 `disabledModels`：
 *
 *   · 旧的"禁用渠道"实现：先 `dropProviderModels()` 清空该 provider 的条目，
 *     再把**当前全部模型**逐个写进去；
 *   · 旧的"启用渠道"实现：把该 provider 的条目**全部删掉**。
 *
 * 覆盖式写入必然互相踩：禁用的一刻用户的勾选就被抹掉了，启用时自然恢复不了。
 *
 * 现在把两者拆开：
 *   · `disabledModels` ← **只**由用户逐个勾选驱动，渠道开关永不触碰；
 *   · `disabledChannels` ← 渠道级开关，在**读取时**叠加成"整渠道隐藏"。
 *
 * 叠加靠 {@link HIDE_ALL_SENTINEL} 表达，provider 侧用 {@link hiddenMatcher}
 * 统一解释 —— 于是不必为了"禁用渠道"先去探一次上游凑全量 id
 * （旧做法里探测失败会导致禁用不彻底）。
 *
 * @module dsh-connect/shared/hidden
 */

/**
 * 「本渠道所有模型都隐藏」的哨兵值。
 *
 * 值以 NUL 开头：上游模型 id 都是可打印字符，不可能撞上。
 */
export const HIDE_ALL_SENTINEL = "\u0000dsh-connect:hide-all";

/**
 * 把偏好里读到的隐藏列表变成"某个模型 id 是否隐藏"的判定。
 *
 * 三个 provider 的 `listModels` 原先都是 `new Set(hidden()).has(id)`；
 * 哨兵语义必须在这一处统一解释，否则漏掉一家的表现就是
 * "禁用这个渠道后它的模型还在选择器里"。
 *
 * @param {string[]} hiddenIds 偏好读出的隐藏列表（可能含 {@link HIDE_ALL_SENTINEL}）
 * @returns {(id: string) => boolean}
 */
export function hiddenMatcher(hiddenIds) {
  const list = Array.isArray(hiddenIds) ? hiddenIds : [];
  if (list.includes(HIDE_ALL_SENTINEL)) return () => true;
  const set = new Set(list);
  return (id) => set.has(id);
}
