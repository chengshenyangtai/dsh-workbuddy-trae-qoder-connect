/**
 * dsh-connect —— 唯一的 connect 插件（宿主侧编排）。
 *
 * ## 为什么是"编排"而不是"重写"
 *
 * 三个渠道（WorkBuddy ×3 / Trae / Qoder）的实现各自成熟：凭据生命周期、
 * 目录缓存、回环 shim、协议怪癖都已在线上跑顺。三合一的目的是**一个插件、一处接线、
 * 一个面板**，不是把三份实现揉成一份 —— 所以这里把它们作为**子模块**在本进程内
 * `apply(ctx)`，各自的作用域、状态文件、路由路径、provider id 全部保持不变。
 *
 * 好处：
 * - 三个渠道的代码零改动（只有"禁用模型"那一处小钩子）→ 风险最小，日后仍可与上游对照；
 * - provider id（workbuddy1/2/3、trae、qoder1）不变 → 用户已选的模型不用重选；
 * - 状态文件路径不变（`$DSH_HOME/.workbuddy*-catalog.json` 等）→ 不丢缓存；
 * - 一个 `try/catch` 一层 → 某个渠道挂了不会连累其余，也不影响面板。
 *
 * ## 路由（都挂在同一个 webServer 上，路径沿用各自的历史前缀）
 *
 *   渠道：/plugins/dsh-workbuddy-connect/{1,2,3}/{status,checkin,probe}
 *         /plugins/dsh-trae-connect/{status,checkin}
 *         /plugins/dsh-qoder-connect/{status,checkin}
 *   面板：/plugins/dsh-connect/{status,checkin,checkin/<id>,settings,models}
 *
 * 面板走 HTTP 扇出去聚合上面那些路由 —— 这条缝已经在线上验证过，见 panel.js 的头部注释。
 *
 * ## 禁用模型怎么生效
 *
 * 面板把"要隐藏的模型"存在自己的设置段（`<provider id>/<模型 id>` 字符串数组）；
 * 这里在**渠道启动之前**把 {@link disabledModelsFor} 注入三个 provider，它们在构建模型
 * 列表时现读现用 —— 所以在面板里勾一下，模型选择器里立刻就没了。
 */

import * as workbuddy from "./providers/workbuddy/index.js";
import * as trae from "./providers/trae/index.js";
import * as qoder from "./providers/qoder/index.js";
import { registerPanel, disabledModelsFor, HUB_SECTION } from "./panel.js";
import { readRegistry } from "./channel-registry.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * 跑一遍 Trae 凭据/目录导出脚本（等价于用户在终端手动跑 export-trae-plain.mjs）。
 *
 * 脚本纯本地：读 Trae 桌面端的 storage.json / state.vscdb（trae-vault.mjs 用
 * node:crypto 自包含解密），再写 ~/.dsh/trae-cn/models.json 与 connect-auth/trae.json。
 * Electron 下要用它自带的二进制 + ELECTRON_RUN_AS_NODE 才是 node 运行时。
 */
function runTraeExport() {
  return new Promise((resolve) => {
    const script = join(PACKAGE_DIR, "..", "scripts", "export-trae-plain.mjs");
    const env = { ...process.env };
    if (process.versions?.electron !== undefined) env.ELECTRON_RUN_AS_NODE = "1";
    const child = spawn(process.execPath, [script], {
      env,
      cwd: PACKAGE_DIR,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, code: -1, output: (out + "\n" + err).slice(-1200), error: "导出超时（90 秒）" });
    }, 90000);
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, output: String(error), error: String(error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, output: (out + "\n" + err).slice(-1200) });
    });
  });
}

/** cordis 插件名，必须与 cordis.patch.yml 里的 `- id:` 逐字一致。 */
export const name = "dsh-connect";

/**
 * 本插件的配置 schema（= 面板偏好段）。
 *
 * ## 为什么必须导出它
 *
 * DSH 0.1.7-rc.2 把 `ctx.settings` 从 `SettingsProvider`（插件用
 * `register(ns, schema, {base})` **自建**一个设置命名空间）换成了 `SettingsForms`
 * ——**插件自己导出的 `Config` 就是那张设置表单**：`describe()` 按 profile 条目
 * 遍历，`entry.fiber.runtime.Config` 就是该条目的 schema，且只有带 `.volatile()`
 * 的字段算「可编辑」。
 *
 * 所以这里不导出 `Config`，就会：
 *   - `update('dsh-connect', …)` → `No configurable plugin entry "dsh-connect"`；
 *   - 设置页看不到本插件的卡片；
 *   - 面板的 `/settings`、`/models` 写入全 503。
 *
 * 命名空间（= profile 条目 id）就是 `name`（`dsh-connect`），与
 * panel.js 的 `HUB_SETTINGS_NS` 逐字一致 —— 这两处必须同源，改一处即改两处。
 */
export const Config = HUB_SECTION;

/** 三个渠道都要注册模型 provider，所以硬依赖 `llm`。 */
export const inject = ["llm"];

/** 渠道清单：`[标签, 子模块]`。加载顺序即此顺序（互不依赖，只是日志顺序）。 */
const PROVIDERS = [
  ["workbuddy", workbuddy],
  ["trae", trae],
  ["qoder", qoder],
];

export function apply(ctx, config) {
  // —— 0) 渠道注册表快照 ——
  // provider 拓扑（变体表、路由、provider id）在模块加载时已按注册表生成；
  // 这里只打一条日志，把"本次启动装载了哪些渠道"留在 dsh 日志里，方便核对
  // 面板即时视图（registryChannels）与 provider 实际拓扑的差异。
  const registry = readRegistry();
  ctx.logger?.info?.(
    `dsh-connect: 注册表装载 ${registry.channels.length} 条渠道（${registry.explicit ? "显式" : "默认+孤儿收纳"}）：${registry.channels.map((entry) => entry.id).join(", ")}`,
  );

  // —— 0.5) 先注入"禁用模型"钩子 ——
  // 必须在渠道 apply 之前：它们在 apply 时就会构建首次模型列表。
  for (const [label, mod] of PROVIDERS) {
    if (typeof mod.setExternalHidden !== "function") {
      ctx.logger?.warn?.(`dsh-connect: ${label} 子模块没有 setExternalHidden，禁用模型对它不生效`);
      continue;
    }
    try {
      mod.setExternalHidden(disabledModelsFor);
    } catch (error) {
      ctx.logger?.warn?.(`dsh-connect: ${label} 注入禁用模型钩子失败`, error);
    }
  }

  // —— 1) 三个渠道的宿主半侧 ——
  // 传空 config：这三个渠道的实际配置从不走插件 config（凭据走环境变量/文件，
  // 偏好走各自的 settings 段），传 {} 即取各自的内置默认值。
  const handles = new Map();
  for (const [label, mod] of PROVIDERS) {
    if (!registry.channels.some((entry) => entry.kind === label)) continue;
    try {
      if (typeof mod.apply !== "function") throw new Error("子模块没有导出 apply");
      handles.set(label, mod.apply(ctx, {}));
    } catch (error) {
      ctx.logger?.error?.(`dsh-connect: ${label} 渠道加载失败（其余渠道与面板不受影响）`, error);
    }
  }

  /**
   * 面板「更新模型」的渠道调度：
   * · trae    —— 先跑导出脚本重抓桌面端目录，再让 provider 立刻 reload；
   * · 其余    —— 直接强制重取（workbuddy 句柄按渠道实例 id 分派）。
   */
  const refreshChannel = async (channelId) => {
    const entry = registry.channels.find((item) => item.id === channelId);
    if (entry === undefined) return { ok: false, error: `未知渠道 ${channelId}` };
    if (entry.kind === "trae") {
      const exported = await runTraeExport();
      if (!exported.ok) {
        return { ok: false, stage: "export", code: exported.code, output: exported.output, error: exported.error ?? "导出脚本失败" };
      }
      const diff = await handles.get("trae")?.forceRefresh?.();
      return { ok: true, exported: exported.output, ...(diff ?? {}) };
    }
    if (entry.kind === "workbuddy") {
      const diff = await handles.get("workbuddy")?.forceRefresh?.(channelId);
      return { ok: diff !== undefined, ...(diff ?? {}) };
    }
    if (entry.kind === "qoder") {
      const diff = await handles.get("qoder")?.forceRefresh?.();
      return { ok: diff !== undefined, ...(diff ?? {}) };
    }
    return { ok: false, error: `渠道类型 ${entry.kind} 暂不支持更新` };
  };

  // —— 2) 面板与聚合（渠道表 / 状态归一化 / 一键签到 / 偏好 / 禁用模型）——
  try {
    registerPanel(ctx, {
      // 先摊开 profile 里的配置，再压上我们自己的回调（避免被 config 里的同名键盖掉）。
      //
      // ⚠️ 这个展开是**有意为之且必须保留**：`config` 里标了 `.volatile()` 的字段是
      // **引用对象**（不是快照），展开后仍是同一个引用 —— panel.js 靠 `config.<字段>.get()`
      // 现读现值，从而免疫"写入 → profile patch 变更 → 本插件热重载"的窗口。
      // 千万不要改成 `structuredClone`/`JSON.parse(JSON.stringify(...))` 之类，
      // 那会把引用拍平成快照，偏好就会变成"改了不生效 / 重载后回退"。
      ...(config ?? {}),
      // 模型列表变了要让宿主重新问各 provider 要列表，否则模型选择器里还是旧的。
      // 与 workbuddy 改可见性时的做法一致：发一次 adapters-updated。
      onModelsChanged: () => {
        try {
          ctx.emit("llm/adapters-updated");
        } catch (error) {
          ctx.logger?.warn?.("dsh-connect: 广播模型列表更新失败（重启后生效）", error);
        }
      },
      // 面板「更新模型」：按渠道重抓目录（trae 先跑导出脚本），返回前后差异。
      refreshChannel,
    });
  } catch (error) {
    ctx.logger?.warn?.("dsh-connect: 面板加载失败（各渠道不受影响）", error);
  }
}
