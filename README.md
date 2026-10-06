# dsh-workbuddy-trae-qoder-connect

一个 DSH 插件，把 **WorkBuddy / Qoder / Trae** 三个订阅渠道装进同一个会话。

## 核心能力

- **多渠道聚合** —— 三家订阅的模型全部接入 DSH，一个界面用完
- **会话内切换模型** —— 对话中途换渠道、换模型，历史不丢
- **思考强度** —— 每个模型的思考档位可选（轻/中/高/极高）
- **自动签到** —— 打开面板即自动领取各渠道每日积分（可在偏好里关掉），也可手动一键签到
- **大上下文** —— 三渠道均支持 1M 上下文（WorkBuddy / Qoder 为 1M 模型条目，Trae 走 Max 模式）

## 三渠道怎么登录（认证方式一览）

| 渠道 | 登录方式 | 你要做的 |
|---|---|---|
| **WorkBuddy** | 扫码授权（腾讯登录页） | 让 AI 跑登录脚本导出授权链接（见下）→ 任意浏览器打开链接 → 手机扫码/短信登录 → 凭据自动写入。面板不提供扫码入口（宿主限制） |
| **Qoder** | 官方 PAT | 到 <https://qoder.com.cn/account/integrations> 生成 PAT（`pt-…`），存为 `$DSH_HOME/qoder/pat`（0600）或设环境变量 `QODERCN_PAT` |
| **Trae** | 本机凭据导出 | 装 Trae 桌面版并登录一次 → 宿主跑 `node scripts/export-trae-plain.mjs`（解密本机 Trae 的凭据与模型目录到 `~/.dsh/trae/`） |

### AI 快速启动整个流程

如果你是 AI 助手，按这个顺序帮用户把三渠道跑起来：

```bash
# 1) Trae：导出凭据（要求本机装了 Trae 并登录过）
node scripts/export-trae-plain.mjs

# 2) Qoder：写入 PAT（向用户要一个 pt- 开头的 token）
#    Windows PowerShell：
#    New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\qoder" | Out-Null
#    Set-Content "$env:USERPROFILE\.dsh\qoder\pat" "pt-xxxx" -Encoding ascii

# 3) WorkBuddy：导出扫码链接交给用户（推荐——不依赖 GUI 弹窗）
#    只拿链接：
node scripts/workbuddy-login.mjs workbuddy1 --url-only
#    把输出的链接贴进对话发给用户，用户在手机或电脑浏览器打开、扫码/短信
#    登录后，凭据由插件自动写入。也可以让 AI 全程盯着（轮询到登录成功）：
node scripts/workbuddy-login.mjs workbuddy1

# 4) 核对三渠道状态（一个请求扇出全部渠道）
#    GET http://127.0.0.1:<DSH_PORT>/plugins/dsh-connect/status

# 5) 签到：GET /plugins/dsh-connect/status?auto=1 会顺带领取（幂等），
#    或在面板渠道页点「一键签到」。
```

> 面板不提供扫码入口：DSH 桌面宿主里点击外部链接会把面板顶掉（宿主行为），弹窗形态不可用。授权一律走上面的 CLI 工作流。
> 重启 DSH 后所有渠道生效；面板的渠道页能看每家的登录状态、剩余额度。

## 思考强度：来源与边界

各模型可用的档位来自两个途径，**半手动**维护：

1. **上游目录声明**（自动）—— 渠道目录里声明了哪些档位，UI 就直接显示哪些
2. **档位探查**（手动）—— 目录没声明的模型，在渠道页点「检测」按钮实测；探查会消耗真实额度，由你决定何时跑，结果缓存、之后自动生效

边界：探查只对 Qoder 渠道有意义（WorkBuddy / Trae 的目录声明是全的）；上游改了声明时刷新目录即可跟随，改了实际行为但声明没动时需要重探一次。

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
- 带**图片**的会话在渠道间切换会报 `UNSUPPORTED_CONTENT`（DSH 宿主附件服务限制，插件层无法修复）
- 基于 [yembors64632/dsh-connect](https://github.com/yembors64632/dsh-connect)，MIT 许可证
