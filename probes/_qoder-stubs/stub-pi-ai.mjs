/**
 * pi-ai 替身：覆盖 provider 顶层 import 用到的两个形状。
 *
 * ⚠️ `openAICompletionsApi` 必须是**函数**：shim 启动时会调它建 adapter，
 * 早先写成 `{}` 导致回环 shim 启动失败（"openAICompletionsApi is not a function"）。
 * 本探针不断言推理，只要求模块能加载、路由能派生。
 */
export function createProvider() {
  return { createAdapter: () => ({}) };
}

export function openAICompletionsApi() {
  return {};
}

export default { createProvider, openAICompletionsApi };
