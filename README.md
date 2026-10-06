# dsh-workbuddy-trae-qoder-connect

一个 DSH 插件，把 **WorkBuddy / Qoder / Trae** 三个订阅渠道装进同一个会话。

## 核心能力

- **多渠道聚合** —— 三家订阅的模型全部接入 DSH，一个界面用完
- **会话内切换模型** —— 对话中途换渠道、换模型，历史不丢
- **思考强度** —— 每个模型的思考档位可选（轻/中/高/极高）
- **自动签到** —— 支持签到的渠道每日自动完成，积分不掉队
- **大上下文** —— 三渠道均支持 1M 上下文（WorkBuddy/Qoder 为 1M 模型条目，Trae 走 Max 模式）

## 思考强度：来源与边界

各模型可用的档位来自两个途径，**半手动**维护：

1. **上游目录声明**（自动）—— 渠道目录里声明了哪些档位，UI 就直接显示哪些
2. **档位探查**（手动）—— 目录没声明的模型，在渠道页点「检测」按钮实测；探查会消耗真实额度，所以由你决定何时跑，结果缓存、之后自动生效

边界：探查只对 Qoder 渠道有意义（WorkBuddy/Trae 的目录声明是全的）；上游改了声明时刷新目录即可跟随，改了实际行为但声明没动时需要重探一次。

## 快速开始

```bash
# 前置：DSH 桌面版（Windows），Node ≥ 20
# 1. 本仓库放入 DSH 插件目录
# 2. Trae 渠道导出凭据
node scripts/export-trae-plain.mjs
# 3. 重启 DSH
```

## 验证

```bash
node probes/verify-qoder-effort-source.mjs   # 档位来源（21 断言）
node probes/verify-trae-effort-chain.mjs     # Trae 链路（22 断言）
node probes/verify-probe-service.mjs         # 探查服务（25 断言）
node probes/verify-probe-contract.mjs        # 探查契约（17 断言）
node probes/qoder-effort-passthrough.mjs     # 请求透传（24 断言）
```

## 说明

- 凭据与 token 由 `.gitignore` 排除，仓库不含账号数据
- 基于 [yembors64632/dsh-connect](https://github.com/yembors64632/dsh-connect)，MIT 许可证
