# dsh-workbuddy-trae-qoder-connect

![三家免费额度，一个模型下拉](assets/social-preview.png)

**三家平台都在发免费额度和每日签到积分。别再开三个窗口、装三个插件、维护三套历史了。**

这一个插件把 **WorkBuddy（个人版多账号 / 企业版）· Qoder CN · Trae CN（IDE 版 / TRAE SOLO CN）**
的免费额度**聚合成一个入口** —— 一个模型下拉、一套对话历史、一个状态面板。
**打开面板自动把当天的签到积分领了**，然后在一个列表里选模型、调思考档位、让 AI 真正动手干活。

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **English** — All three platforms hand out free quota and daily check-in credits.
> This one DSH plugin pools them into a single model picker with one shared conversation
> history. It claims each day's check-in for you when the panel opens, then lets you pick a
> model, set the reasoning effort, and let the agent actually do the work — with live credit
> multipliers and image input.

---

## 这个根

这个插件只有一条根：**把三家平台正在发的免费额度，聚合成一个能真正用起来的入口。**

我们每一次改动 —— 更新目录、优化链路、修复报错 —— 都是围着这条根长的，没有一个是"为了改而改"：

| 根的需要 | 对应的活 |
|---|---|
| 免费额度要用得上 | 三渠道各自注册模型来源 + 本地中转，把三种私有协议翻成同一种格式 |
| 额度得一直有 | **自动签到**（重复领不扣分、不报错）+ 额度/倍率实时刷新 |
| 用好每个模型 | **逐模型思考档位**（声明 ∪ 实测）+ 百万上下文 |
| 不只是聊天 | **Agent 工具调用**（读文件 / 跑命令 / 改代码） |
| 别让人费劲 | **AI 一键认证工作流** + 面板增删改名 + 模型勾选即时生效 |

---

## 你为什么想要它

三家平台都在发免费额度和签到积分 —— 但**额度散在三个客户端里**：
WorkBuddy 一个、Qoder 一个、Trae 一个（Trae 还分 CN 与 SOLO 两套）。

要在它们之间切换，你得装三个插件、开三个面板、维护三套凭据，
而且**一换渠道，对话历史就断了**。同类插件基本都是**单渠道**的，各管各的，
于是这个"散"一直没人解决。

| | 单渠道插件 ×3 | **本插件** |
|---|---|---|
| 免费额度 | 三处，分别看 | **聚合**，一处看全部 |
| 模型下拉 | 三块，各管各的 | **一个列表**，按渠道分组 |
| 换模型 | 换插件 / 重开会话 | **对话中途直接换**，历史不丢 |
| 每日签到 | 点三次 | **一次全领**（重复领无害） |
| 装几个包 | 三个 | **一个** |

三家协议完全不同（OpenAI 方言 / 私有 agent 协议 / 带自定义编码的流式响应），
插件在中间当翻译 —— 对 DSH 和你来说，它们长得一样。

## 核心优势

### 1. 三家免费额度，一个入口

| | 三个单渠道插件 | **本插件** |
|---|---|---|
| 免费额度 | 三处，各看各的 | **聚合**，一处看全部 |
| 模型下拉 | 三块，互不相通 | **一个列表**，按渠道分组 |
| 换模型 | 换插件 / 重开会话 | **对话中途直接换**，历史不丢 |
| 每日签到 | 点三次 | **一次全领**（重复无害） |
| 装几个包 | 三个 | **一个** |

三家协议完全不同（OpenAI 方言 / 私有 agent 协议 / 带自定义编码的流式响应），
插件在中间当翻译 —— 对 DSH 和你来说，它们长得一样。

### 2. 自动签到，把额度续上

打开面板自动领各渠道当日积分。**重复打开也只领一次，不重复扣分、不报错**，
不用你记着"今天签没签"。可在设置里关掉。

### 3. 额度余量看得见

每个渠道剩多少积分、按套餐拆分、什么时候重置，面板里直接看。
模型旁还标了**积分倍率** —— 哪个贵一眼可见，省着点用。

### 4. 思考档位，逐模型给真的

不是给所有模型发同一套档位。每个模型能选什么，来自**上游目录的声明**（自动）
∪ **实测探查**（手动点一下）。比如 Qoder 的 `dfmodel`（DeepSeek-Flash）：
上游标它"不是专用思考模型"，却声明了 3 个档位 —— 这个插件认后者。

- **跟目录一起刷新**：点「更新模型」，档位连同模型目录一起重取，上游加了/收了档位立即反映，气泡里告诉你「N 个模型的思考档位已更新」
- **新会话用上游默认档**：没手动选时，用这个模型目录声明的默认档（`dmodel` 是最高档 `max`，`qmodel_38max` 是 `medium`），不拍脑袋定
- **不给必然报错的选项**：「关思考」一律不提供 —— 实测两家上游都直接返回 400。要关思考走另一条已验证的路径（Qoder 用模型名后缀 `@nothink`）

### 5. 能干活，不只是聊天

- **🛠️ Agent 工具调用** —— 读文件、跑命令、改代码。Trae 已端到端实测（真实上游返回结构化工具调用、参数分片正确拼接、结束标记正确改写）
- **🖼️ 读图** —— 接通 DSH 附件服务，按各模型的上游标注开放
- **📏 百万级上下文** —— 主力模型普遍 1M，长会话不被 200k 截断

### 6. 管理不费劲

- **➕ 渠道增删改名** —— 注册表里加槽位、就地改名、删除（凭据文件一并清理）
- **🎛️ 模型只留常用的** —— 渠道行点「已选 X / 共 N」，去掉不用的，**改完立刻生效、不用重启**
- **🔄 每个渠道独立「更新模型」** —— 重抓该渠道最新目录；Trae 会**现场跑导出脚本**从桌面端重新导出
- **🧩 Trae 两个产品都支持** —— Trae CN 与 TRAE SOLO CN 一条命令互切，凭据独立、目录分存
- **👁️ 隐藏渠道** —— 停用的模型不可见、不参与签到，凭据保留，随时能开回来

### 7. 凭据不进配置、不回显

凭据只存 `connect-auth/`（0600），**不写入 settings.yaml，界面上也从不回显**。
面板只显示"有没有"，不显示"是什么"。

## 支持哪些渠道

| 渠道 | 能接入什么 | 免费额度怎么来 | 登录方式 |
|---|---|---|---|
| **WorkBuddy** | 个人版多账号（槽位数不限）+ 企业版 | 每日签到领积分 | AI 工作流 / 脚本生成登录链接，浏览器点开登录 |
| **Qoder CN** | 订阅账号下的全部模型 | 每日签到活动 | 官方 PAT，或直接用桌面 App 的登录态（二选一） |
| **Trae CN / TRAE SOLO CN** | 两个产品各自的全部模型 | 每日签到领积分 | 本机客户端凭据导出 |

**Trae CN 模型最全**，独占 `glm-5.3-flash` / `glm-5.3-flashx` / `kimi-k2.8-preview` / `qwen3.8-flash` 等；
TRAE SOLO CN 有自己的 8 个（`glm-5` / `kimi-k2.5` / `qwen-3.5` / 非正式版 `DeepSeek-V4` 等）。
两个产品**协议同构**，同一套代码用一张产品表支持，**没有分叉代码**。

```bash
node scripts/export-trae-plain.mjs --app cn     # 接 Trae CN（IDE）
node scripts/export-trae-plain.mjs --app solo   # 接 TRAE SOLO CN
node scripts/export-trae-plain.mjs --list        # 看两个产品各自的登录态
```

切换就是重跑一次导出，插件 30 秒内自动换线，**不用重启**。

## 安装

**前置**：DSH 桌面版、Node ≥ 20。

在 DSH 的插件页**粘贴仓库地址**即可安装（或在插件市场中搜索本插件）：

```
https://github.com/chengshenyangtai/dsh-workbuddy-trae-qoder-connect
```

装完**重启一次 DSH**，再配凭据。

## 让 AI 帮你启动

复制这段给 AI：

```text
跑 scripts/ 下的脚本配好 dsh-workbuddy-trae-qoder-connect 三个渠道的凭据，
WorkBuddy 登录要轮询到成功为止。完成后汇报各渠道状态与模型数，提醒我重启 DSH。
```

| 渠道 | 跑什么 |
|---|---|
| **Trae** | `node scripts/export-trae-plain.mjs`（`--app cn\|solo` 选产品，`--list` 看登录态） |
| **WorkBuddy** | `node scripts/workbuddy-login.mjs workbuddy1`（加账号换成 `workbuddy2` / `workbuddy3`…） |
| **Qoder** | 用桌面 App 登录态；没有才要 PAT，写到 `$DSH_HOME/qoder/pat` |

WorkBuddy 登录要点：**必须轮询到成功**。授权链接只是入口，凭据在 `login/poll` 拿到
`ready` 时才落盘；`state` 是进程内存（有效期 15 分钟），拿完链接就退出 = 这场授权作废。
所以要么跑不带 `--url-only` 的版本，要么取链接后持续轮询。

新增的渠道槽位（如 `workbuddy3`）重启 DSH 后才会装载；面板内不放扫码入口，因为
DSH 宿主点外部链接会把面板顶掉。

## 面板能做什么

渠道中心 → 设置页：

- **自动签到**（默认开）
- **隐藏 / 停用渠道** —— 停用的模型不可见、不参与签到，凭据保留
- **模型勾选** —— 渠道行点「已选 X / 共 N」，勾上即出现，**改完立刻生效**
- **推理档位检测** —— 对上游没声明档位的模型一键实测（消耗少量额度，结果缓存）
- **侧栏入口开关**

## 思考档位：声明与实测取并集

各模型可用的档位来自两处，**取并集**（谁也不压谁）：

1. **上游声明**（自动）—— 目录声明了哪些就显示哪些，是保底
2. **档位探查**（手动点）—— 没声明的模型点「检测」实测出来，是扩展

探查用**哨兵拒绝法**，三步顺序有意义，不是优化：
**基线**（证明凭据/请求形状本身可用，否则后续拒绝无法归因）→
**哨兵**（随机值，回答"上游到底校不校验这个字段"）→
**逐档扫描**（只在确证"会拒绝"之后才做）。

所以它不会把"传什么都收"误判成"支持所有档位"，也不会白烧额度 ——
实测 `qfmodel` 只用 2 个请求就得出「不校验」的结论，没有继续扫。

各家情况不同（**都是实测，别按渠道名想当然**）：

| 渠道 | 档位的真值来源 | 需要手动检测吗 |
|---|---|---|
| **Trae** | 目录按 (模型 × 功能槽位) **精确声明** | 不需要 |
| **WorkBuddy** | 一部分有声明，其余需实测 | 需要 |
| **Qoder** | `thinking_config` 部分声明 + 探查兜底 | 需要 |

⚠️ 一个反复踩到的坑：**「是否支持档位」不能看「是否专用思考模型」**。
Qoder 的 `dfmodel`（DeepSeek-Flash）标 `is_reasoning: false` 却声明了 3 个档位 ——
那个布尔说的是"是否**专用**思考模型"，不是"能否调档"。
真正的档位声明在 `thinking_config.enabled.efforts` 里，**逐模型不同**。

## 目录、额度与签到怎么更新

三家刷新的东西各不相同，但**「更新模型」一个按钮全带走**
（Qoder / WorkBuddy 实时拉上游，Trae 现场跑导出脚本后再重读快照）：

| 渠道 | 模型目录 | 额度余量 | 每日签到 |
|---|---|---|---|
| **Qoder** | 实时拉上游 | 实时（`quota`） | 自动领（真实领取接口） |
| **WorkBuddy** | 实时拉上游 | 实时（`credits`，按套餐求和） | 自动领（需额外探一次看板） |
| **Trae** | 本机快照（脚本导出） | 实时（`credits.remain/total`） | 自动领（状态文档自带） |

Trae 之所以特殊：凭据在客户端的加密存储里，且目录接口要三个特定请求头才回全量数据
（少一个会**静默降级**成不含功能配置的空壳）。所以走「导出一次 → 本地读」，
重跑一次脚本就刷新；其余两家都是直接取上游。

⚠️ 签到的判据：**「自动签到那一趟的返回」才是唯一可靠来源**。
WorkBuddy 的签到看板在活动未开放时整份都是默认值，据此断言「今天没签」会误判；
而 `10001 / 已签` 与 `claimed / 刚领到` 是可信的。这也是为什么「打开面板自动签到」
同时是**签到状态的来源**，不是一个装饰。

## 修复记录（不是优点，是欠账还清）

一个聊天插件本来就不该中断、不该报错不准、不该丢内容 ——
所以下面这些**不该当作卖点**，列在这里只是为了交代坑的来历与现状：

- 修了 Qoder 每轮都报 `499 客户端已取消`：错把「请求体读完」当成「用户取消」
- 修了档位探查一律答「无凭据」：有凭据却测不了
- 修了跨渠道历史里的工具调用破损（空函数名 / 孤儿结果）：换渠道续聊会突然 400
- 修了「额度超限」被误报成「API 密钥无效」：报错与真实原因对不上
- 修了流式响应被静默截断、残片丢失：长回复缺头少尾却不报错
- 修了 Trae 渠道完全跑不了 Agent 回合：工具调用当时根本没接上
- 修了模型按钮看不出已选几个、改名时按钮文字被挤成竖排

**上面的「核心优势」才是我们真正给你的东西 —— 别家插件做不到的那部分。**

## 边界（诚实说明）

- **Trae 国际版（trae.ai）未实现** —— 它走的是另一套网关与订阅/额度状态接口，本插件的三个渠道都不覆盖
- **面板内不能点外部链接**（DSH 宿主会把面板顶掉）—— WorkBuddy 授权链接请复制到浏览器，或走命令行脚本
- **插件代码改动需重启 DSH** —— 只有凭据/产品切换是 30 秒内热生效
- **部分模型的档位需要你手点一次检测** —— 上游不声明就无法自动得知（会消耗少量额度）
- 少数模型不是 1M 上下文（如 `kimi-k2.6`、`minimax-m2.7` 等较老的条目），以模型选择器里显示的为准
- 倍率数据从上游注册表拉取，上游响应会变慢，所以分批查询；单批失败只影响那批模型的倍率显示

## 质量

自带 **20 个确定性验证脚本（257 项断言）**，不依赖网络、任何机器都能跑，当前**全绿**；
另有 2 个活体脚本做真实请求单点实测。每条探针都对应一个真实修过的 bug，
**且都做过反向验证**（把修复删掉，探针必须变红）：

```bash
node probes/verify-trae-products.mjs                 # Trae 双产品（40）
node probes/verify-probe-service.mjs                 # 哨兵探查服务（25）
node probes/verify-trae-effort-chain.mjs             # Trae 档位链路离线验证（22）
node probes/verify-qoder-effort-source.mjs           # Qoder 档位来源合并（21）
node probes/verify-trae-tool-calling.mjs             # Trae 工具调用全链路（19）
node probes/verify-trae-output-hygiene.mjs           # Trae 输出净化 / 断流可见性 / parser 交接（17）
node probes/verify-effort-refresh.mjs                # 更新模型的档位差异 + 默认档 + 兜底名单（17）
node probes/verify-probe-contract.mjs                # 探查契约与 onProbed 接线（17）
node probes/verify-qoder-auth-retry.mjs             # Qoder 凭据重试（11）
node probes/verify-trae-parser-handoff.mjs           # 流式残片与收尾（11）
node probes/verify-qoder-stream-fixes.mjs            # Qoder 首事件批 / 返回形状 / 取消接线（9）
node probes/verify-workbuddy-tool-pairing.mjs        # 工具破损修复（9）
node probes/verify-attachment-wiring.mjs             # 三家附件接线（9）
node probes/verify-channel-disable-memory.mjs         # 禁用/启用渠道不丢模型勾选（8）
node probes/verify-probe-account-wiring.mjs          # 探查账号接线（8）
node probes/verify-qoder-error-classification.mjs    # 额度错误不再冒充"API 密钥无效"（8）
node probes/verify-provider-config-schema.mjs        # 渠道配置 schema（7）
node probes/verify-schemastery-field-shapes.mjs       # 宿主 schema 调用形状（7）
node probes/verify-shim-cancel-wiring.mjs             # Qoder 499 取消根因回归（5）
node probes/verify-workbuddy-reasoning-levels.mjs     # 档位映射（"关思考"恒为不提供）（4）
```

探针纪律：断言拿**真实宿主 peer 包**跑，契约错误不能被沙箱 stub 吞掉；断言**值**而非键名；异步用例 await 且串行（共享全局 `fetch` 的用例并发会互相串味）；接线类修复走完整链路端到端测 —— 单组件单测是"永远绿"的。

## 项目结构

```
lib/providers/{workbuddy,trae,qoder}/   三渠道（各自注册模型来源 + 本地中转 + 路由）
lib/shared/probe.js                     渠道无关的档位探查（哨兵拒绝法）
lib/shared/catalog-diff.js              「更新模型」的模型 + 档位差异计算
lib/panel.js · lib/client.js            统一面板：状态 / 签到 / 设置 / 模型勾选
scripts/                                Trae 凭据导出 · WorkBuddy 登录链接 · Trae 解密
probes/                                 22 个脚本：20 确定性 + 2 活体
docs/                                   目录字段手册 · Trae 双产品接入 · 档位协议实证
```

## 说明

- 凭据与 token 由 `.gitignore` 排除，**仓库不含任何账号数据**
- 基于 [yembors64632/dsh-connect](https://github.com/yembors64632/dsh-connect)，MIT 许可证；上游致谢见 [NOTICE](NOTICE)
- 设计细节：[docs/CATALOG.md](docs/CATALOG.md) · [docs/TRAE-CN-PRODUCTS.md](docs/TRAE-CN-PRODUCTS.md) · [docs/TRAE-REASONING-EFFORT.md](docs/TRAE-REASONING-EFFORT.md)

## License

[MIT](LICENSE)
