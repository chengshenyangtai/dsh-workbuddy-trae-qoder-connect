# dsh-channel-hub

一个 DeepSeek Harness（DSH）插件：把 **WorkBuddy / Qoder / Trae** 三个订阅渠道的模型聚合进同一个会话，补齐它们缺失的**思考档位**与**大上下文**能力。

## 为什么做这个

**问题**：三家 AI 编程订阅各自为政——模型锁在各自客户端里；想用的思考档位有的渠道根本不提供；长任务被 200k 上下文截断。换一个渠道 = 换一套交互、丢掉会话历史。

**分析**：三家的 API 形状完全不同（OpenAI 方言 / 私有 agent 协议），但能力本质上是重叠的：档位三家都有，只是"说不说"的区别；大窗口 Trae 其实支持，只是没有暴露给 API 调用方。差异都发生在**协议边界**上。

**方案**：让插件充当翻译层——DSH 用统一的 OpenAI 形状对话，每个渠道一个 shim 负责把统一形状翻译成各家私有协议。会话历史归 DSH 管，渠道随便切。

## 能力

| | WorkBuddy | Qoder | Trae |
|---|---|---|---|
| 模型接入 | ✅ | ✅ | ✅ |
| 思考档位 | ✅ | ✅ 声明+实测 | ✅ 声明 |
| 大上下文 | 1M | 1M | ✅ Max 200k→1M |
| 签到 | ✅ | ✅ | — |

- **思考档位**：Qoder 用"上游声明 ∪ 哨兵实测"取并集——声明可能比实际窄，实测补全它；无任何写死名单，上游加档位自动跟上。
- **Trae Max**：抓包发现 Trae 客户端的"更大上下文"开关只是改两个请求字段，照抄后 200k → 1M。
- **探查服务**：`lib/shared/probe.js` 哨兵拒绝法测档位，花真实额度所以按钮由你按，结果缓存、指纹失效自动重探。

## 快速开始

```bash
# 前置：DSH 桌面版（Windows），Node ≥ 20
# 1. 本仓库放入 DSH 插件目录
# 2. Trae 渠道先导出凭据
node scripts/export-trae-plain.mjs
# 3. 重启 DSH
```

## 验证

```bash
node probes/verify-qoder-effort-source.mjs   # 21 断言
node probes/qoder-effort-passthrough.mjs     # 24
node probes/verify-probe-contract.mjs        # 17
node probes/verify-probe-service.mjs         # 25
node probes/verify-trae-effort-chain.mjs     # 22
```

109 项确定性断言，不依赖网络。另有 10 个活体脚本用于真实请求实测（消耗额度）。

## 已知限制

带图会话在渠道间切换会报 `UNSUPPORTED_CONTENT`（pi-ai 要求宿主附件服务）。检查发生在宿主层、先于插件，插件侧无法修复。

## 凭据

所有凭据由 `.gitignore` 排除，GitHub token 放本地 `.env`（模板见 `.env.example`）。仓库不含任何账号数据。

---

基于 [yembors64632/dsh-connect](https://github.com/yembors64632/dsh-connect)（PR #3 基线），MIT 许可证。设计细节见 [docs/CATALOG.md](docs/CATALOG.md)。
