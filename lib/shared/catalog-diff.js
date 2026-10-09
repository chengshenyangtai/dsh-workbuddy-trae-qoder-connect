/**
 * 「更新模型」的差异计算：模型 id 之外，把**思考档位**的变化也算出来。
 *
 * 用户点「更新模型」时最关心的两件事：有没有新模型、已有模型的档位变没变。
 * 早先三家的 forceRefresh 都只比 id 差集，上游给模型加档位/收档位时面板
 * 回「没有变化」—— 而档位恰恰是目录里变得最频繁的部分（上游调默认档、
 * 上下架 thinking_config 都会动它）。
 *
 * 档位的"签名"取目录里档位相关字段的拼接（各家字段名不同，由调用方通过
 * `effortsOf` 提取成统一的字符串数组），签名变化即记入 `changed`。
 * 三种状态互不相同：`undefined`（该模型连档位概念都没有，签名为哨兵值）、
 * `[]`（声明了但为空）、非空集合。计算是纯函数：给前后两份快照，返回差异
 * 文档，不做任何 IO。
 */

/**
 * 一家渠道的档位签名：把该模型声明的档位集合变成可比较的字符串。
 *
 * `undefined`（该模型连档位概念都没有）与 `[]`（声明了但为空）是**不同**的
 * 签名 —— 前者变成"支持思考了/没了"这类实质变化，后者只是声明清空。
 */
export function effortSignature(efforts) {
  if (!Array.isArray(efforts)) return "\u0000none";
  return efforts.length === 0 ? "" : [...efforts].sort().join(",");
}

/**
 * 算两份目录快照的差异。
 *
 * @param before 刷新前的模型条目数组（至少含 id）
 * @param after  刷新后的模型条目数组
 * @param effortsOf `(entry) => string[] | undefined`，从条目提取档位集合
 * @returns `{ added, removed, count, efforts: { changed, gained, lost } }`
 *   · changed: [{ id, from, to }]，签名变化且前后都存在（含"从无到有"）
 *   · gained/lost: 仅"变成支持/不再支持"的 id（签名从 "" 到非空、或反之）
 */
export function diffCatalog(before, after, effortsOf) {
  const beforeIds = before.map((entry) => entry.id);
  const afterIds = after.map((entry) => entry.id);
  const beforeById = new Map(before.map((entry) => [entry.id, entry]));
  const afterById = new Map(after.map((entry) => [entry.id, entry]));
  const changed = [];
  const gained = [];
  const lost = [];
  for (const [id, entry] of afterById) {
    const old = beforeById.get(id);
    if (old === undefined) continue; // 新增模型走 added，不重复报档位
    const from = effortSignature(effortsOf(old));
    const to = effortSignature(effortsOf(entry));
    if (from === to) continue;
    changed.push({ id, from, to });
    if (from === "" && to !== "") gained.push(id);
    if (from !== "" && to === "") lost.push(id);
  }
  return {
    added: afterIds.filter((id) => !beforeIds.includes(id)),
    removed: beforeIds.filter((id) => !afterIds.includes(id)),
    count: afterIds.length,
    efforts: { changed, gained, lost },
  };
}
