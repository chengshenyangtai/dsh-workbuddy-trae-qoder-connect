# dsh-workbuddy-trae-qoder-connect

**一个插件，把你三家 AI 订阅的模型全部接进 DeepSeek Harness。**
WorkBuddy（个人版多账号 / 企业版）· Qoder CN · Trae CN（IDE 版 / TRAE SOLO CN），
共用一个模型下拉、一套对话历史、一个状态面板 —— 换模型不用换插件、不用重开会话。

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **English** — One DSH plugin that aggregates WorkBuddy (multi-account + enterprise),
> Qoder CN and Trae CN / TRAE SOLO CN into a single model picker with one shared
> conversation history. Switch channels mid-conversation without losing context,
> with live credit multipliers, per-model reasoning effort, daily check-in and image input.

---

## 为什么用它

同类插件基本都是**单渠道**：只接 WorkBuddy 的、只接 Trae 的、只接 Qoder 的各一个包，
装三份、开三个面板、维护三套凭据。本插件把三家聚合进**同一个** provider 层：

| | 单渠道插件 ×3 | **本插件** |
|---|---|---|
| 模型下拉 | 三块，各管各的 | **一个列表**，按渠道分组 |
| 换模型 | 换插件 / 重开会话 | **对话中途直接换**，历史不丢 |
| 看状态 | 三个面板分别看 | 一个渠道中心看全部 |
| 每日签到 | 点三次 | **一次全领**（幂等） |
| 装几个包 | 三个 | **一个** |

## 核心能力

- **🔀 三家订阅，一个列表** — 三个渠道（WorkBuddy 支持多账号槽位，企业版独立计费）汇成一个模型下拉，每个模型旁标注积分倍率，贵不贵一眼可见
- **🔁 会话内换模型** — 三家协议完全不同（OpenAI 方言 / 私有 agent 协议），插件在中间做翻译；对 DSH 和你来说它们长得一样
- **🛠️ Agent 工具调用** — 能真正"干活"而不只是聊天：读文件、跑命令、改代码。Trae 已端到端实测（真实上游返回结构化工具调用、参数分片正确拼接、`finish_reason` 正确改写）
- **🧠 每个模型的思考档位** — 按模型真实能力给档位（轻/中/高/极高），不是一刀切；上游没声明的模型可以一键**实测**出来
- **🖼️ 读图** — 接通 DSH 附件服务，按各模型的上游标注开放
- **📏 百万级上下文** — 主力模型普遍支持 1M 上下文，长会话不被 200k 截断
- **📅 打开面板自动签到** — 各渠道每日积分一次领完，幂等，可关
- **🎛️ 模型列表只留常用的** — 渠道行点「模型 N」勾选，改完立刻生效、不用重启
- **🧩 Trae 两个产品都支持** — Trae CN 与 TRAE SOLO CN 一条命令互切，凭据独立、模型目录分存

## 支持哪些渠道

| 渠道 | 能接入什么 | 登录方式 |
|---|---|---|
| **WorkBuddy** | 个人版多账号（槽位数不限）+ 企业版 | 扫码授权（腾讯登录页） |
| **Qoder CN** | 官方 PAT，或直接用桌面 App 的登录态 | 二选一 |
| **Trae CN / TRAE SOLO CN** | 两个产品各自的全部模型 | 本机客户端凭据导出 |

**Trae CN 模型最全**，独占 `glm-5.3-flash` / `glm-5.3-flashx` / `kimi-k2.8-preview` / `qwen3.8-flash` 等；
TRAE SOLO CN 有自己的 8 个（`glm-5` / `kimi-k2.5` / `qwen-3.5` / 非正式版 `DeepSeek-V4` 等）。
两个产品**协议同构**，同一套代码用一张变体表支持，**没有分叉代码**。

```bash
node scripts/export-trae-plain.mjs --app cn     # 接 Trae CN（IDE）
node scripts/export-trae-plain.mjs --app solo   # 接 TRAE SOLO CN
node scripts/export-trae-plain.mjs --list       # 看两个产品各自的登录态
```

切换就是重跑一次导出，插件 30 秒内自动换线，**不用重启**。

## 安装

**前置**：DSH 桌面版、Node ≥ 20。

在 DSH 的插件页**粘贴仓库地址**即可安装（或在插件市场中搜索本插件）：

```
https://github.com/chengshenyangtai/dsh-workbuddy-trae-qoder-connect
```

装完**重启一次 DSH**，再配凭据。

## 让 AI 帮你一键启动

**把下面整段复制给你的 AI 助手**，它会按顺序把三个渠道都跑起来（每一步都有现成脚本，
不需要你记命令）：

````text
请帮我配置 dsh-workbuddy-trae-qoder-connect 插件的三个渠道凭据，按顺序执行：

1) Trae：本机已装 Trae 桌面版并登录过，请运行
   node scripts/export-trae-plain.mjs
   然后确认输出里显示导出了哪个产品（Trae CN / TRAE SOLO CN）和多少个模型。

2) WorkBuddy：请运行
   node scripts/workbuddy-login.mjs workbuddy1 --url-only
   把打印出来的授权链接发给我，我会在浏览器里扫码/短信登录。
   登录完成后凭据由插件自动写入，你不需要做别的。
   （如果要加第二个账号，把 workbuddy1 换成 workbuddy2，重复这一步。）

3) Qoder：请向我要一个 pt- 开头的官方 PAT（在
   https://qoder.com.cn/account/integrations 生成），
   然后写到 $DSH_HOME/qoder/pat。我也可以改用 Qoder 桌面 App 的登录态，
   如果你发现本机已登录，优先用那个，不必问我要 PAT。

4) 全部完成后，请 GET http://127.0.0.1:<DSH_PORT>/plugins/dsh-connect/status
   把每个渠道的登录状态、模型数量、剩余额度汇报给我。
   如果有渠道报未登录，告诉我卡在哪一步。

5) 最后提醒我重启一次 DSH 让插件加载。
````

## 自己动手（不想用 AI）

| 渠道 | 命令 / 操作 |
|---|---|
| **WorkBuddy** | `node scripts/workbuddy-login.mjs workbuddy1` —— 拿到授权链接，浏览器打开扫码/短信登录；不带 `--url-only` 会一直轮询到登录成功 |
| **Qoder** | 到 <https://qoder.com.cn/account/integrations> 生成 `pt-…`，存为 `$DSH_HOME/qoder/pat`；或让插件直接用桌面 App 的登录态 |
| **Trae** | 装 Trae 桌面版并登录一次 → `node scripts/export-trae-plain.mjs` |

> 面板内**不提供扫码入口**：DSH 宿主里点击外部链接会把面板顶掉，所以授权一律走上面的命令行脚本。

## 面板能做什么

渠道中心 → 设置页：

- **自动签到**（默认开）
- **隐藏 / 停用渠道** —— 停用的模型不可见、不参与签到，凭据保留
- **模型勾选** —— 渠道行点「模型 N」，勾上即出现，**改完立刻生效**
- **推理档位检测** —— 对上游没声明档位的模型一键实测（消耗少量额度，结果缓存）
- **侧栏入口开关**

## 档位：两条路径，一个结果

各模型可用的思考档位来自两处，**取并集**：

1. **上游声明**（自动）—— 目录声明了哪些就显示哪些
2. **档位探查**（手动点）—— 没声明的模型点「检测」实测

探查用**哨兵拒绝法**，三步顺序有意义：**基线**（证明凭据/请求形状可用）→
**哨兵**（随机值，回答"上游到底校不校验这个字段"）→ **逐档扫描**（只在确证会校验后才做）。
所以它不会把"传什么都收"误判成"支持所有档位"，也不会白烧额度 ——
实测 `qfmodel` 只用 2 个请求就得出「不校验」的结论，没有继续扫。

各家情况不同（实测，别按渠道名想当然）：

| 渠道 | 档位来源 | 需要手动检测吗 |
|---|---|---|
| **Trae** | 目录按 (模型 × function) **精确声明** | 不需要 |
| **WorkBuddy** | 一部分有声明，其余需实测 | 需要 |
| **Qoder** | 部分声明 + 探查兜底 | 需要 |

## 目录与凭据怎么更新

| 渠道 | 模型目录 | 凭据 |
|---|---|---|
| **Qoder** | **实时从上游拉取** | PAT 或 App 会话，自动刷新 |
| **WorkBuddy** | **实时从上游拉取** | 扫码写入，30 秒巡检 |
| **Trae** | **本机快照**：脚本从客户端解密导出 | 同左（重跑导出即换产品/续期） |

Trae 之所以特殊：凭据在客户端的加密存储里，且目录接口要三个特定请求头才回全量数据
（少一个会**静默降级**成不含 function 配置的空壳）。所以走"导出一次 → 本地读"，
重跑一次脚本就刷新；其余两家都是直接取上游。

## 边界（诚实说明）

- **Trae 国际版（trae.ai）未实现** —— 需要另一套网关与订阅状态接口
- **面板内不能点外部链接**（DSH 宿主会把面板顶掉）—— WorkBuddy 授权链接请复制到浏览器，或走命令行脚本
- **插件代码改动需重启 DSH** —— 只有凭据/产品切换是 30 秒内热生效
- **部分模型的档位需要你手点一次检测** —— 上游不声明就无法自动得知（会消耗少量额度）
- 少数模型不是 1M 上下文（如 `kimi-k2.6`、`minimax-m2.7` 等较老的条目），以模型选择器里显示的为准
- 倍率数据从上游注册表拉取，`functions` 数量多时上游响应会变慢，所以分批查询；单批失败只影响那批模型的倍率显示

## 质量

自带 **15 个确定性验证脚本（216 项断言）**，不依赖网络、任何机器都能跑；
另有 11 个活体脚本做真实请求单点实测。每条探针都对应一个真实修过的 bug，
**且都做过反向验证**（把修复删掉，探针必须变红）：

```bash
node probes/verify-trae-tool-calling.mjs             # Trae 工具调用全链路（19）
node probes/verify-trae-products.mjs                 # Trae 双产品变体（40）
node probes/verify-probe-service.mjs                 # 哨兵探查服务（25）
node probes/verify-trae-output-hygiene.mjs           # Trae 输出净化 / 断流可见性 / parser 交接（17）
node probes/verify-qoder-effort-source.mjs           # Qoder 档位来源合并（21）
node probes/verify-qoder-auth-retry.mjs              # Qoder 凭据重试（11）
node probes/verify-trae-parser-handoff.mjs           # SSE 残片与收尾（11）
node probes/verify-workbuddy-tool-pairing.mjs        # 工具破损修复（9）
node probes/verify-attachment-wiring.mjs             # 三家附件接线（9）
node probes/verify-qoder-error-classification.mjs    # 额度错误不再冒充"API 密钥无效"（8）
node probes/verify-workbuddy-reasoning-levels.mjs    # 档位映射（off 恒为 null）（4）
```

四条写进骨头的教训：

- **对宿主契约 API 的断言必须拿真包跑** —— 沙箱 stub 掉 peer 依赖时，`z.enum` 这类错误恰好被 stub 吞掉：测试全绿，而插件在真实宿主里加载即崩
- **断言要检查值，不能只匹配键名** —— 第一版接线断言写 `/\btools\s*:/`，于是 `tools: undefined` 也通过；假阴性比没有断言更糟
- **异步用例必须 await，且要串行** —— 第一版探针的 `ok()` 不 await，所有失败都变成未处理的 promise rejection，`try/catch` 抓不到，测试永远"全绿"；而且这些用例共享全局 `fetch`，并发会互相串味。两处都修正后才真正抓到回归
- **接线缺陷要端到端测，读源码字符串测不出来** —— "首事件预读后把 parser 交给 translate" 这类修复，单独 new 一个 parser 做单元测试**永远是绿的**（反向验证时就是这样漏掉的）；只有让假的 TCP 分片切在事件中间、走完整 `chatStream` 才抓得住。同理，"函数写对了但没人调用"也只能靠接线断言发现

## 项目结构

```
lib/providers/{workbuddy,trae,qoder}/   三渠道（各自注册 provider + 回环 shim + 路由）
lib/shared/probe.js                     渠道无关的档位探查（哨兵拒绝法）
lib/panel.js · lib/client.js            统一面板：状态 / 签到 / 设置 / 模型勾选
scripts/                                Trae 凭据导出 · WorkBuddy 扫码登录 · Trae 解密
probes/                                 26 个脚本：15 确定性 + 11 活体
docs/                                   目录字段手册 · Trae 双产品接入 · 档位协议实证
```

## 说明

- 凭据与 token 由 `.gitignore` 排除，**仓库不含任何账号数据**
- 基于 [yembors64632/dsh-connect](https://github.com/yembors64632/dsh-connect)，MIT 许可证；上游致谢见 [NOTICE](NOTICE)
- 设计细节：[docs/CATALOG.md](docs/CATALOG.md) · [docs/TRAE-CN-PRODUCTS.md](docs/TRAE-CN-PRODUCTS.md) · [docs/TRAE-REASONING-EFFORT.md](docs/TRAE-REASONING-EFFORT.md)

## License

[MIT](LICENSE)
