/**
 * probes/_qoder-stubs/loader.mjs
 *
 * Qoder provider 的顶层 import 里有 5 个**宿主 peer 包**，裸 node 解析不到：
 *
 *   @deepseek-ai/schemastery                      配置 schema（z.object…）
 *   @earendil-works/pi-ai                         createProvider
 *   @earendil-works/pi-ai/api/openai-completions.lazy   openAICompletionsApi
 *   @deepseek-ai/dsh-llm-pi-ai                    PiAiAdapter
 *   @deepseek-ai/dsh-llm                          resolveRetryPolicy
 *   @deepseek-ai/dsh-home-paths                   resolveDshHome
 *
 * 按 probes/README.md 的纪律：**stub 必须显式声明缺哪个包** —— 所以这张表是
 * 白名单式的，未列出的 specifier 一律走真实解析（解析不到就照常报错，
 * 不会被悄悄吞掉）。替身只满足模块加载期用到的形状，不模拟任何行为。
 *
 * 只在 `scripts/qoder-global-selftest/`（已删）与本探针里使用；
 * 断言的正确性不依赖替身实现 —— 见 verify-qoder-global-routing.mjs 的注释。
 */
const STUBS = {
  "@deepseek-ai/schemastery": "./stub-schemastery.mjs",
  "@earendil-works/pi-ai": "./stub-pi-ai.mjs",
  "@earendil-works/pi-ai/api/openai-completions.lazy": "./stub-pi-ai.mjs",
  "@deepseek-ai/dsh-llm-pi-ai": "./stub-dsh.mjs",
  "@deepseek-ai/dsh-llm": "./stub-dsh.mjs",
  "@deepseek-ai/dsh-home-paths": "./stub-dsh.mjs",
};

export async function resolve(specifier, context, nextResolve) {
  const stub = STUBS[specifier];
  if (stub !== undefined) {
    return { url: new URL(stub, import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
