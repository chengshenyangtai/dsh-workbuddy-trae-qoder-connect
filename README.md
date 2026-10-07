# dsh-workbuddy-trae-qoder-connect

**DSH 插件 · 模型与账号接入（model provider）**：把 **WorkBuddy（个人版多账号 / 企业版）+ Qoder CN + Trae（Trae CN IDE 版 / TRAE SOLO CN）** 的订阅模型接进 DeepSeek Harness，共用一个模型列表、一套对话历史。

> **DSH plugin that brings your WorkBuddy / Qoder / Trae subscriptions into DeepSeek Harness** — one model picker, one conversation history, live credit multipliers, and daily check-in claiming.

同类插件大多只做**单一渠道**（只 WorkBuddy 或只 Trae），本插件把多家聚合进**同一个会话**：换渠道不用换插件、不用重开对话，中途切模型历史不丢。

> 范围说明：Trae 这边接的是**国内两条产品线**（Trae CN / TRAE SOLO CN，一条命令互切，见下文）；**国际版（trae.ai）未实现** —— 需要另一套网关与订阅状态接口，详见末尾「与同类插件的差异」。

### 🔀 多渠道聚合

三家订阅的模型全部接入 DSH，一个下拉列表用完。每个模型旁标注积分倍率（如 `x0.15`），贵不贵一眼可见；剩余额度、登录状态在面板渠道页集中查看。WorkBuddy 支持多账号槽位（workbuddy1/2/3…，面板里可继续添加）。

### 🔁 会话内切换模型

对话中途换渠道、换模型，历史不丢。三家协议完全不同（OpenAI 方言 / 私有 agent 协议），插件在中间做翻译——对 DSH 和你来说它们长得一样。

### 🧠 思考强度

每个模型的思考档位可选（轻/中/高/极高），档位列表来自上游目录声明 + 哨兵探查实测（详见下方"思考强度"一节）。

### 📅 自动签到

打开面板即自动领取各渠道每日积分（幂等，可在偏好里关掉），也可以在渠道页手动「一键签到」。签到结果与剩余额度一并显示。

### 📏 大上下文

三渠道均支持 1M 上下文：WorkBuddy / Qoder 有 1M 模型条目，Trae 通过 Max 模式解锁（200k → 1M）。长会话不再被 200k 截断。

### 🎛️ 模型可以只留自己常用的那几个

下拉列表把渠道的全部模型都列出来，但你未必用得上。渠道中心里点该渠道的「**模型 N**」就是一份勾选清单：**勾上 = 出现在模型选择器，取消 = 不出现**，改完**立刻生效、不用重启**。旁边还有「全选 / 全不选」，可以先清空再只勾常用的那几个。整条渠道都不想要，用「认证 → 停用」更省事（凭据保留，随时启用回来）。

### 🧩 Trae 支持两个产品：Trae CN（IDE）与 TRAE SOLO CN

同一套代码接两个 Trae 产品，靠**导出的凭据快照**切换，不用改配置、不用重启：Trae CN（IDE 版）模型更全，TRAE SOLO CN（办公向，旧称 TraeWork）走 work/agent 那套 function。详见下面的 [Trae：两个产品怎么切](#trae两个产品怎么切)。

## 安装

```bash
# 前置：DSH 桌面版（Windows），Node ≥ 20
# 1. 本仓库放入 DSH 插件目录
# 2. 三渠道凭据（见下表）
# 3. 重启 DSH
```

## 三渠道怎么登录

| 渠道 | 登录方式 | 你要做的 |
|---|---|---|
| **WorkBuddy** | 扫码授权（腾讯登录页） | 让 AI 跑登录脚本导出授权链接（见下）→ 任意浏览器打开 → 手机扫码/短信登录 → 凭据自动写入 |
| **Qoder** | 官方 PAT | 到 <https://qoder.com.cn/account/integrations> 生成 PAT（`pt-…`），存为 `$DSH_HOME/qoder/pat`（0600）或设环境变量 `QODERCN_PAT` |
| **Trae** | 本机凭据导出 | 装 Trae 桌面版（**Trae CN** 或 **TRAE SOLO CN** 都行）并登录一次 → 跑 `node scripts/export-trae-plain.mjs`（解密本机 Trae 的凭据与模型目录）。省略 `--app` 时优先选 Trae CN；换产品只要重跑一次脚本，30 秒内生效 |

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

# 4) 核对三渠道状态（一个请求扇出全部渠道，含登录态/额度/倍率）
#    GET http://127.0.0.1:<DSH_PORT>/plugins/dsh-connect/status

# 5) 签到：GET /plugins/dsh-connect/status?auto=1 会顺带领取（幂等），
#    或在面板渠道页点「一键签到」。
```

> 面板不提供扫码入口：DSH 桌面宿主里点击外部链接会把面板顶掉（宿主行为），弹窗形态不可用。授权一律走上面的 CLI 工作流。
> 重启 DSH 后所有渠道生效；面板的渠道页能看每家的登录状态、剩余额度。

## Trae：两个产品怎么切

字节有两个 Trae 桌面产品，订阅里的模型不一样：

| | **Trae CN**（IDE 版） | **TRAE SOLO CN**（办公向，旧称 TraeWork） |
|---|---|---|
| `packageType` | `TRAE_CN` | `SOLO_CN` |
| 数据根目录 | `%APPDATA%\Trae CN` | `%APPDATA%\TRAE SOLO CN` |
| 快照目录 | `~/.dsh/trae-cn/` | `~/.dsh/trae/` |
| 模型 | 更全：多 `glm-5.3-flash` / `glm-5.3-flashx` / `kimi-k2.8-preview` / `qwen3.8-flash` 等 | 有自己的 8 个（`glm-5` / `kimi-k2.5` / `qwen-3.5` / `DeepSeek-V4-Flash`·`Pro` 非正式版等） |

两个产品**协议同构**——同一个 `appId`、同一个推理端点、同一个账号网关、同一套信封加密，差别只在 `packageType` / `buildId` / function 白名单 / 签到 `req_source` 这几组数据上，所以插件里用一张 `TRAE_PRODUCTS` 变体表同时支持，**没有分叉代码**。

**切换就是重跑一次导出**（两个 App 各存一份独立 token，所以换产品=换快照）：

```bash
node scripts/export-trae-plain.mjs --app cn     # 接 Trae CN（IDE）
node scripts/export-trae-plain.mjs --app solo   # 接 TRAE SOLO CN
node scripts/export-trae-plain.mjs --list       # 看两个产品各自的登录态与到期时间
```

插件按 30 秒一轮巡检重读快照，**不用重启 DSH**；面板渠道行旁边会显示当前接入的产品标签。两个产品的 `models.json` 分目录存（`trae-cn/` 与 `trae/`），换回去各自的数据都还在。

> ⚠️ 已选中的模型不会因为切换产品而丢：两个产品共用同一个 provider id（`trae`）。
> 但**插件代码本身**的改动要重启 DSH 才加载（跑着的进程还是旧模块）。

## 面板能配置什么

渠道中心弹窗 → 设置页（或 `settings` 路由）：

- **自动签到**：打开面板时顺带领取（默认开）
- **隐藏渠道** / **禁用渠道**：不看的渠道收起来；禁用的渠道模型不可见、不参与签到（凭据保留）
- **模型勾选**：渠道行上点「**模型 N**」展开勾选清单——勾上就出现在模型选择器，取消就不出现，**改完立刻生效**；「全不选」可以先清空再只留常用的那几个（条目在设置里形如 `<provider>/<模型 id>`）
- **侧栏入口**：渠道中心在左侧栏的图标开关

## 思考强度：来源与边界

各模型可用的档位来自两个途径，**半手动**维护：

1. **上游目录声明**（自动）—— 渠道目录里声明了哪些档位，UI 就直接显示哪些
2. **档位探查**（手动）—— 目录没声明的模型，在渠道页点「检测」按钮实测；探查会消耗真实额度，由你决定何时跑，结果缓存（指纹失效自动重探）、之后自动生效

边界：探查只对 Qoder 渠道有意义（WorkBuddy / Trae 的目录声明是全的）；上游改了声明时刷新目录即可跟随，改了实际行为但声明没动时需要重探一次。目录字段对照与探查 SOP 见 [docs/CATALOG.md](docs/CATALOG.md)。

## 验证

```bash
# 10 个确定性脚本，193 项断言（宿主 profile 在场时 +1），不依赖网络：
node probes/verify-qoder-effort-source.mjs   # 档位来源（21）
node probes/verify-trae-effort-chain.mjs     # Trae 档位链路（22）
node probes/verify-probe-service.mjs         # 探查服务（25）
node probes/verify-probe-contract.mjs        # 探查契约（17）
node probes/qoder-effort-passthrough.mjs     # 请求透传（24）
node probes/verify-trae-products.mjs         # Trae 双产品变体（40）
node probes/verify-attachment-wiring.mjs     # 三家 provider 的附件接线（9）
node probes/verify-provider-config-schema.mjs # 配置 schema 契约：真模块可求值（7，--installed 时 8）
node probes/verify-schemastery-field-shapes.mjs # 字段形状逐个对宿主真包核验（9）
node probes/verify-trae-tool-calling.mjs     # Trae 工具调用全链路（19）
```

`verify-trae-tool-calling.mjs` 是工具调用事故的回归探针。事故：Trae provider **从不向上游发送 `tools`**，消息转换又丢弃 `assistant.tool_calls` / `role:"tool"`，响应侧还把上游的 `function_call` 形状原样透传（下游认的是 `function`）。后果是 DSH 的 agent 回合在 Trae 下必然失败 —— 模型看不到任何工具定义，于是自造原生文本标记 `<|FunctionCallBegin|>[{"name":...}]<|FunctionCallEnd|>` 漏成正文（表现为"回复里一堆怪东西"），或者干脆空回合（表现为"思考后直接断了、没有回复"）。探针用**实测抓到的真实分片形态**做输入，覆盖请求/消息/响应三段加接线，并做过四路反向验证（漏传 tools、payload 不带 tools、初始事件丢批次、`finish_reason` 不改写，各自必须变红）。

`verify-provider-config-schema.mjs` / `verify-schemastery-field-shapes.mjs` 是另一起事故的回归探针：某次给 Trae 配置加「产品线」字段时写成 `z.enum(["cn","solo"])`，而宿主的 `@deepseek-ai/schemastery` 没有 `z.enum`（可选值要用 `z.union([z.const(...), ...])` 表达），于是 provider 模块在**求值阶段**抛 TypeError，整个 bundle 连 WorkBuddy / Qoder 一起加载失败，表现为「重启后一个渠道都不显示」。教训：**对宿主契约 API 的断言必须拿真包跑**，沙箱把 peer 依赖 stub 掉时，这类错误恰好会被 stub 吞掉。两个探针都做过反向验证（把 `z.enum` 塞回源码，必须变红）。

`verify-trae-products.mjs` 里依赖真实快照的那一组（`~/.dsh/trae-cn/models.json` 等）在**没装 Trae 的机器上自动跳过**并注明原因，所以它在任何机器上都该是绿的。加 `--installed` 可以改测已安装的那份，用于确认「装上的代码 = 仓库里的代码」。

`probes/` 下另有 11 个活体脚本（`qoder-one.mjs`、`trae-one.mjs`、`trae-cn-model-callability.mjs`、`verify-qoder-probe-live.mjs` 等），发真实请求做单点实测，消耗额度，按需使用。

```bash
# Trae CN 独占模型到底能不能调（6 条 × 16 token，输出已脱敏，可直接贴 issue）
node probes/trae-cn-model-callability.mjs
```

## 与同类插件的差异

GitHub/npm 上的同类大多是**单渠道**插件（只接 WorkBuddy，或只接 Trae）。本插件的差异化在于**聚合**：三家渠道进同一个模型选择器、同一套对话历史、同一个状态面板，并且 WorkBuddy 支持**多账号槽位 + 企业版**（企业版走自己的额度接口，个人版接口对企业号会返回空表，界面上就成了「0 积分」）。

范围边界（诚实说明，别按名字猜）：

| | 本插件 | 备注 |
|---|---|---|
| WorkBuddy 个人版 ×N / 企业版 | ✅ | 多账号靠渠道注册表，槽位数不限 |
| Qoder CN | ✅ | PAT 或 App 会话两种凭据 |
| Trae CN（IDE 版）/ TRAE SOLO CN | ✅ | `--app cn\|solo` 一条命令互切 |
| **Trae 国际版（trae.ai）** | ❌ **未实现** | 需要另一套网关与订阅状态接口 |

> 关于 `glm-5.3-flash` / `kimi-k2.8-preview` / `qwen3.8-flash` 这几个「只在 Trae IDE 目录里、SOLO 通道未必有」的模型：能不能调用**主要取决于账号档位**，不是插件能力。实测（2026-10-07，付费账号，`probes/trae-cn-model-callability.mjs`）6 个用例全部返回可用 —— 包括用 SOLO 的 `solo_work_lite` 和 CN 的 `chat_v3` 调 `glm-5.3-flash`；而免费账号侧同类插件的取证记录是 `4001 param is invalid`。所以本插件的做法是**默认切到 Trae CN 产品、按 IDE 目录导出模型**，让这几个模型进入可选列表，调用失败时如实报错而不是静默隐藏。
>
> 判据教训（脚本里也记了）：**`reasoning_content` 也算「上游在服务这个模型」**。第一版只数 `response`，于是 thinking 模型全被判成「无响应」，差点得出「这几个模型不可用」的反向错误结论。

## 已知限制

- 带**图片**的会话在渠道间切换会报 `UNSUPPORTED_CONTENT`（DSH 宿主附件服务限制，插件层无法修复）
- 面板内不可点击外部链接（宿主会把面板顶掉）——WorkBuddy 授权链接请复制到浏览器打开，或直接走上面的 CLI
- Trae 国际版未实现（见上方差异表）
- 倍率接口对 `functions` 数量延迟非线性（9 个 ≈10s、12 个直接超时），所以运行时和导出都分批查；单批失败只影响那批模型的倍率显示

## 说明

- 凭据与 token 由 `.gitignore` 排除，仓库不含账号数据
- 基于 [yembors64632/dsh-connect](https://github.com/yembors64632/dsh-connect)（PR #3 基线），MIT 许可证；上游致谢详见 [NOTICE](NOTICE)（LICENSE 保持纯 MIT 模板，GitHub 才能识别出许可证）
- 设计细节：[docs/CATALOG.md](docs/CATALOG.md)（目录字段与探查 SOP）· [docs/TRAE-REASONING-EFFORT.md](docs/TRAE-REASONING-EFFORT.md)（Trae 档位四条件实测）· [docs/TRAE-CN-PRODUCTS.md](docs/TRAE-CN-PRODUCTS.md)（Trae 双产品接入实测：变体表、function 矩阵、两个计费/乱码坑、倍率分批）
