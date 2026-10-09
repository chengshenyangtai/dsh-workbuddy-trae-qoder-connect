# dsh-workbuddy-trae-qoder-connect

![三家免费额度，一个模型下拉](assets/social-preview.png)

**WorkBuddy、Qoder CN、Trae CN 每天都在发免费额度和签到积分。这一个插件把三家接进 DeepSeek Harness：一个模型下拉、一份对话历史、打开面板自动签到。**

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **English** — WorkBuddy, Qoder CN and Trae CN all hand out free quota and daily check-in credits. This one DSH plugin pools all three into a single model picker with one shared conversation history, and claims the day's check-in for you when the panel opens. Switch channels mid-conversation without losing context, with live credit multipliers, per-model reasoning effort and image input.

---

## 它解决什么

三家的额度散在三个客户端里。想都在 DSH 里用起来，就得装三个插件、开三个面板、维护三套凭据——而且每换一个渠道，对话历史就断一次。同类插件都是单渠道的，这个"散"一直没人收。

| | 三个单渠道插件 | **本插件** |
|---|---|---|
| 免费额度 | 三处分别看 | 一个面板看全部 |
| 模型下拉 | 三块，互不相通 | **一个列表**，按渠道分组，旁标积分倍率 |
| 中途换渠道 | 换插件 / 重开会话 | **直接换**，历史不丢 |
| 每日签到 | 点三次 | **打开面板一次全领** |
| 安装包 | 三个 | **一个** |

三家协议完全不同（OpenAI 方言、私有 agent 协议、带自定义编码的流式响应），插件在中间做翻译，对 DSH 和你来说它们长得一样。

## 你会得到什么

**一个下拉装下三家。** 模型按渠道分组，每个模型旁标着积分倍率，哪个贵一眼可见。Trae CN 的目录最全，独占 `glm-5.3-flash`、`kimi-k2.8-preview`、`qwen3.8-flash` 等。

**对话中途换渠道，历史不断。** 从 Trae 的模型换到 WorkBuddy 的接着聊，上下文原样带过去。

**签到不用记。** 打开面板自动领当天三家的积分，重复打开也只领一次、不重复扣分。可以在设置里关掉。

**额度看得见。** 每个渠道剩多少积分、按套餐怎么拆、什么时候重置，面板直接显示。

**思考档位是按模型给的。** 每个模型能选哪些档，来自上游目录的声明。点「更新模型」，档位连同目录一起刷新，哪些模型变了会直接告诉你；没手动选档时，新会话自动用该模型声明的默认档。上游没给的档位不硬造——实测「关思考」在两家上游直接返回 400，就不提供这个选项。少数老模型上游不声明档位，设置里留了一键实测补上（消耗少量额度，结果缓存）。

**能干活，不只是聊天。** Agent 工具调用（读文件、跑命令、改代码，Trae 渠道端到端实测过）、按模型开放读图、主力模型普遍 1M 上下文。

**管理和凭据省心。** 渠道就地增删改名，模型勾选即时生效、不用重启；凭据只写进 0600 权限的本地文件，界面从不回显，仓库里没有任何账号数据。

## 渠道一览

| 渠道 | 接入内容 | 免费额度 | 登录方式 |
|---|---|---|---|
| **WorkBuddy** | 个人版多账号（槽位不限）+ 企业版 | 每日签到领积分 | 脚本生成授权链接，浏览器登录 |
| **Qoder CN** | 账号下全部模型 | 每日签到活动 | 官方 PAT，或直接用桌面 App 的登录态 |
| **Trae CN / TRAE SOLO CN** | 两个产品各自的全部模型 | 每日签到领积分 | 本机客户端凭据导出 |

TRAE SOLO CN 有自己的 8 个模型（`glm-5` / `kimi-k2.5` / `qwen-3.5` 等）。两个产品一条命令互切、凭据独立、目录分存，切换 30 秒内热生效，不用重启：

```bash
node scripts/export-trae-plain.mjs --app cn     # Trae CN（IDE 版）
node scripts/export-trae-plain.mjs --app solo   # TRAE SOLO CN
node scripts/export-trae-plain.mjs --list       # 看两个产品各自的登录态
```

## 安装

前置：DSH 桌面版、Node ≥ 20。在 DSH 插件页粘贴仓库地址，重启一次 DSH，再配凭据：

```
https://github.com/chengshenyangtai/dsh-workbuddy-trae-qoder-connect
```

## 配凭据：把一句话发给 AI

把下面这段复制给你的 AI 助手，剩下的它全包——生成 WorkBuddy 授权链接发到对话里、你浏览器点开授权、它轮询到成功落盘、导出 Trae 凭据、接上 Qoder 登录态，最后汇报各渠道状态与模型数：

```text
跑 scripts/ 下的脚本配好 dsh-workbuddy-trae-qoder-connect 三个渠道的凭据，
WorkBuddy 登录要轮询到成功为止。完成后汇报各渠道状态与模型数，提醒我重启 DSH。
```

想自己跑也行：`scripts/export-trae-plain.mjs`（Trae）、`scripts/workbuddy-login.mjs workbuddy1`（WorkBuddy，第二个账号换 `workbuddy2`，会持续轮询到授权成功）、Qoder 用桌面 App 登录态或把 `pt-…` PAT 存到 `$DSH_HOME/qoder/pat`。新建的账号槽位（如 `workbuddy3`）重启 DSH 后装载。

## 面板

渠道中心 → 设置页：自动签到开关；停用渠道（模型隐藏、不参与签到，凭据保留，随时开回来）；模型勾选「已选 X / 共 N」（改完即生效）；档位实测入口（上游不声明的少数模型用）；侧栏入口开关。「更新模型」按钮按渠道独立刷新。

## 背后怎么做的

不关心可以整段跳过，这里只讲三件值得知道的：

**协议翻译。** 每个渠道在本地起一个中转，把各自的私有协议翻成 OpenAI 方言喂给 DSH。Trae 的 IDE 版和 SOLO 版接口规则相同，用一张产品变体表支持，一份代码。

**档位的真值来源。** 上游声明 ∪ 实测。实测用哨兵拒绝法：先证明请求本身能通，再拿一个随机值探"上游到底校不校验这个字段"，确证它会拒绝才逐档扫描——所以不会把"传什么都收"误判成"所有档位都支持"。一个值得知道的坑：Qoder 的 `dfmodel` 标着"非专用思考模型"，却声明了 3 个档位。**能不能调档看 `thinking_config` 的声明，别看那个布尔。**

**Trae 走本地快照。** Trae 的凭据在客户端加密存储里，目录接口又挑请求头（少给一个就静默返回空壳），所以导出一次、本地读，重跑脚本即刷新。

## 暂不支持

- 插件代码改动需重启 DSH；凭据与产品切换是热生效
- 少数老模型不是 1M 上下文（如 `kimi-k2.6`），以模型列表里显示的为准

## 开发与验证

- **21 个确定性验证脚本、283 项断言**，不依赖网络、离线可跑，当前全绿；另有 3 个活体脚本做真实上游单点实测。清单与探针纪律见 [probes/README.md](probes/README.md)
- 历次 bug 修复记在 [CHANGELOG.md](CHANGELOG.md)，不当卖点用
- 设计细节：[docs/CATALOG.md](docs/CATALOG.md) · [docs/TRAE-CN-PRODUCTS.md](docs/TRAE-CN-PRODUCTS.md) · [docs/TRAE-REASONING-EFFORT.md](docs/TRAE-REASONING-EFFORT.md)

## 来源与许可

基于 [yembors64632/dsh-connect](https://github.com/yembors64632/dsh-connect)（MIT），致谢见 [NOTICE](NOTICE)。本插件 MIT 许可。
