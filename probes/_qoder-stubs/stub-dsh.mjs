/** DSH 宿主包替身：只实现 provider 在加载/派生路径上用到的几个符号。 */
import { homedir } from "node:os";
import { join } from "node:path";

/** dsh-home-paths：与宿主一致，优先 DSH_HOME，回落到 ~/.dsh。 */
export function resolveDshHome() {
  const configured = process.env.DSH_HOME?.trim();
  return configured === undefined || configured === "" ? join(homedir(), ".dsh") : configured;
}

/** dsh-llm-pi-ai 的适配器：本探针不注册 provider，给个能构造的空壳。 */
export class PiAiAdapter {
  constructor(options) {
    this.options = options;
  }
}

/** dsh-llm 的重试策略：返回最小结构即可。 */
export function resolveRetryPolicy() {
  return { attempts: 1 };
}
