/**
 * 每个 provider 都必须把附件仓库解析器交给 pi-ai adapter（离线、确定性）。
 *
 * ## 为什么要有这个断言
 *
 * 宿主 `dsh-llm-pi-ai` 在把请求交给 pi-ai **之前**会先问 adapter 要附件仓库：
 *
 * ```js
 * const attachments = containsImage ? this.config.resolveAttachments?.() : undefined;
 * if (containsImage && attachments === undefined)
 *   throw new LlmError("pi-ai image input requires the durable attachment service", "UNSUPPORTED_CONTENT");
 * ```
 *
 * 漏传的表现极具误导性：目录里明明标着 `multimodal: true` / `is_vl: true`，
 * 任何带图的请求却报 `UNSUPPORTED_CONTENT`，读起来像「这个模型不支持读图」。
 * 实际上请求**根本没发到上游** —— 断点在 adapter 入口，与模型能力无关。
 *
 * 真实踩坑（2026-10-07）：WorkBuddy 一路正常，Trae / Qoder 全部带图失败。
 * 原因是 WorkBuddy 建 adapter 时传了这个参数（还顺手套了 withLegacyImageBudget
 * 兼容垫片），另两路两样都漏。现在三家写法统一，本脚本钉住这个不变量。
 *
 * 同类参考实现：dingminhua/dsh-connect-trae `src/index.ts`
 * `resolveAttachments: () => ctx.get('attachments')`。
 *
 * ## 为什么用"源码形状断言"而不是行为断言
 *
 * 真跑一次带图请求需要：已登录的渠道 + 真实上游 + 消耗额度，而且失败信息
 * （UNSUPPORTED_CONTENT）不会告诉你是哪个 provider 漏了参数。这里直接从源码里
 * 校验三条线都在 —— 从 ctx 解析、加兼容垫片、送进 adapter —— 便宜、无副作用、CI 能跑。
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 源码目录：默认读**仓库自身**（相对本脚本），所以它校验的是真正被提交的那份；
 * `--installed` 才去读 `~/.dsh/profiles/desktop/node_modules/dsh-connect` 里跑着的那份。
 *
 * 为什么默认读仓库而不是安装目录：仓库才是事实来源。这个 bug 的本质是
 * 「跑着的那份」和「仓库里的那份」可以长期分叉 —— 装一次、以后手工改
 * node_modules，两者就再也不一样了。先前几个 verify 脚本都硬编码安装目录，
 * 于是它们只能证明「现在跑着的是好的」，证明不了「提交上去的是对的」。
 */
const USE_INSTALLED = process.argv.includes('--installed');
const REPO_ROOT = join(homedir(), '.dsh', 'repos', 'dsh-workbuddy-trae-qoder-connect');
const SRC = USE_INSTALLED
  ? join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-connect', 'lib', 'providers')
  : join(REPO_ROOT, 'lib', 'providers');

let pass = 0;
let fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  OK    ${label}${extra ? '   ' + extra : ''}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${extra ? '   ' + extra : ''}`); }
};

const PROVIDERS = ['trae', 'qoder', 'workbuddy'];

/**
 * 源码里 `new PiAiAdapter(` / `new WorkBuddyPiAiAdapter(` 的实参里是否出现 `resolveAttachments`。
 *
 * 用括号配对而不是正则：实参里必然嵌套箭头函数与对象（`resolveApiKey: async () => …`），
 * 正则遇到嵌套的 `}` 就会提前收尾，于是「明明传了」被判成「没传」。
 * 这类假阴性比没有断言更糟 —— 它让人以为「测过了」，而实际上什么都没测到。
 */
function adapterArgsIncludeResolveAttachments(src) {
  const open = /new\s+(?:WorkBuddy)?PiAiAdapter\s*\(/g;
  let m;
  while ((m = open.exec(src)) !== null) {
    let i = m.index + m[0].length;
    let depth = 1;
    let inStr = false;
    let esc = false;
    for (; i < src.length && depth > 0; i += 1) {
      const ch = src[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"' || ch === "'") inStr = false;
        continue;
      }
      if (ch === '"' || ch === "'") { inStr = true; continue; }
      if (ch === '(' || ch === '{' || ch === '[') depth += 1;
      else if (ch === ')' || ch === '}' || ch === ']') depth -= 1;
    }
    const args = src.slice(m.index + m[0].length, i);
    if (/resolveAttachments/.test(args)) return true;
  }
  return false;
}

for (const p of PROVIDERS) {
  const file = join(SRC, p, 'index.js');
  let src;
  try {
    src = readFileSync(file, 'utf8');
  } catch {
    console.log(`  FAIL  ${p} 读不到 ${file}`);
    fail += 1;
    continue;
  }

  // 1) 必须从 ctx 解析 attachments —— 这是整条链的唯一入口。
  //    两种写法都认：内联（WorkBuddy：`() => ctx.get("attachments")`）与
  //    先取再加工（Trae/Qoder：`() => { const store = ctx.get("attachments"); … }`）。
  const fromCtx = /resolveAttachments:\s*\(\)\s*=>\s*(?:ctx\.get\(\s*["']attachments["']\s*\)|\{[\s\S]{0,200}?ctx\.get\(\s*["']attachments["']\s*\))/m.test(src);

  // 2) 必须套上兼容垫片：pi-ai 与宿主附件服务的两代契约在 readImageRequest 的
  //    第二个参数上不一致，漏掉垫片在跨版本安装下会再次以 UNSUPPORTED_CONTENT 失败。
  //    （同代 store 上垫片是 no-op，所以恒定套用是安全的。）
  //    垫片本体现在住在 lib/shared/http.js，这里只要求**被当成函数调用**——
  //    只在注释里提一句不算数。
  const shimmed = /withLegacyImageBudget\(\s*(?!`)/.test(src);

  // 3) 必须真的送进 adapter 的构造实参。两种合法写法都认，但都必须是**实参位置**：
  //      · Trae/Qoder：`new PiAiAdapter({ ..., resolveAttachments: options.resolveAttachments })`
  //      · WorkBuddy：`...resolveAttachments === void 0 ? {} : { resolveAttachments: … }`
  //    这里按**括号配对**取出 `new PiAiAdapter(` 之后的实参块，而不是用正则贪匹配 ——
  //    实参里含嵌套箭头函数与对象，正则会在嵌套的 `}` 上提前收尾，
  //    漏判成「没接线」（假阴性）。假阴性比没有断言更糟：它让人以为「测过了」。
  const intoAdapter = adapterArgsIncludeResolveAttachments(src);

  ok(`${p}：从 ctx 解析 attachments`, fromCtx);
  ok(`${p}：套了 withLegacyImageBudget 垫片`, shimmed);
  ok(`${p}：resolveAttachments 送到了 adapter`, intoAdapter);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
