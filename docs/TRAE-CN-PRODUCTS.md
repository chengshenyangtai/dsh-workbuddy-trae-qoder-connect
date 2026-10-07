# Trae 双产品接入实测（Trae CN / TRAE SOLO CN）

2026-10-07 把 Trae 渠道从 **TRAE SOLO CN**（办公向，旧称 TraeWork）切到 **Trae CN**（IDE 版）时做的实测记录。
结论都落成了 `providers/trae/index.js` 里的 `TRAE_PRODUCTS` 变体表与 `scripts/export-trae-plain.mjs` 的 `--app` 开关。

## 1. 两个产品在协议层是同构的

这是能把它们收进**一张表**而不是分叉两份代码的前提：

| 共用的部分 | 值 |
|---|---|
| 推理端点 | `POST https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat` |
| 账号/计费网关 | `https://api.trae.cn`（`/trae/api/v2/**`） |
| 倍率注册表 | `POST <gateway>/api/ide/v1/batch_get_detail_param` |
| `appId` | `6eefa01c-1036-4c7e-9ca5-d891f63bfcd8`（两个产品的 `bootConfig.agent.appId` 完全相同） |
| 凭据信封 | 同一套 byteCrypto（`dGMF` 头，见 `scripts/trae-vault.mjs`），`unseal()` 通用 |
| 凭据键名 | 都是 `iCubeAuthInfo://icube.cloudide`；设备号都在 `iCubeAuthInfo://icube-dc:<deviceId>` 键名里 |

**不共用的只有四组数据**：

| 维度 | `cn` | `solo` |
|---|---|---|
| `packageType` | `TRAE_CN` | `SOLO_CN` |
| `buildId`（= `X-Ide-Version-Code`） | `1232067209986` | `1227681842690` |
| 可推理 function 集 | `solo_agent` / `chat_v3` / `builder_v3` / … | `solo_agent_lite` / `solo_coder` / `solo_work_lite` / … |
| 签到 `req_source` | 1 | 2 |

`buildId` 必须**各用各的**：它是倍率注册表的筛选键而不是版本校验头，用错产品的值**不报错**，只回一份没有 `function_configs` 的空壳 → 界面上倍率整列静默空白。

## 2. 两个 App 各存一份独立 token（这才是「切换」的真正含义）

同一账号（`userId` 相同）在两个产品里分别登录、分别落盘：

```
%APPDATA%\Trae CN\User\globalStorage\storage.json         → token A（到期日 X）
%APPDATA%\TRAE SOLO CN\User\globalStorage\storage.json    → token B（到期日 Y）
```

两份 token **内容不同、到期时间不同**。所以：

- 换产品 = 换一份导出的快照，**不是**换个请求头；
- `~/.dsh/connect-auth/trae.json` 是**两个产品共用的同一个文件**，最后一次导出者赢；
- 插件靠文件里的 `product` 字段（`export-trae-plain.mjs` 写入）整套换线：function 白名单、默认槽位、`models.json` 目录、倍率查询集、`req_source`。

**判定优先级**（`resolveProduct`）：配置 `product` > 快照 `product` > `packageType` 嗅探 > `appVersionCode` 嗅探 > **SOLO 兜底**。
兜底刻意选 SOLO：那是所有老快照应有的行为，升级插件不会悄悄换掉别人已经在用的渠道。

## 3. function 白名单实测矩阵（Trae CN，2026-10-07）

每个候选各发一条 4-token 请求，模型优先取该 function **自己分组里**的第一个 preset（避免用「分组里没有的模型」得出「function 无效」的假阴性）：

| function | 结果 |
|---|---|
| `solo_agent` | ✅ OK（默认槽位） |
| `chat_v3` | ✅ OK |
| `builder_v3` | ✅ OK |
| `solo_agent_lite` / `solo_work_lite` / `solo_agent_remote` / `solo_work_remote` | ✅ OK（同 appId 所以 SOLO 的名字在 CN 上也能用） |
| `refactor` / `multimodal` / `assistant` | ✅ OK |
| `builder` | ❌ `4001 param is invalid` |
| `chat` | ❌ `4023 model is unknown` |

`builder` / `chat` 只出现在**倍率注册表**里（`solo_agent` 的注册表条目实测 66 个、覆盖 22/22 模型），不是可推理的 function，所以 `functions` 白名单里没有它们，而 `rateExtraFunctions` 里有。

> **CN 的账号能打通 SOLO 的 function，反过来不行。** SOLO 的 `model_list_map` 里没有 CN 独占的 `glm-5.3-flash` / `glm-5.3-flashx` / `kimi-k2.8-preview` / `qwen3.8-flash`。这正是「CN 模型更全」的技术成因。

## 4. 模型目录：CN 22 个 / SOLO 26 个，是差集不是子集

`state.vscdb` 的 `model_list_map` 按分组下发，两个产品的**分组名不同**：

- Trae CN：`solo_agent` / `chat_v3` / `builder_v3`（可推理且该出现在选择器里）+ `builder` / `code_reviewer` / `code_review_summary` / `refactor`（后四组里是 `refactor_scoper`、`code-review-judge` 这类**内部流水线小模型**，导出时按 `catalogGroups` 白名单跳过，不污染界面）
- TRAE SOLO CN：`solo_agent_lite` / `solo_coder` / `solo_work_lite` / `solo_*_remote` / `solo_design_*` / `agent` / `assistant`

⚠️ **`model_list_map` 的键分隔符两个产品不一样**（实测）：

```
Trae CN          →  <userId>_AI.agent.model.model_list_map     ← 下划线
TRAE SOLO CN     →  <userId>:AI.agent.model.model_list_map     ← 冒号
```

必须用 `LIKE '<userId>%…'` 匹配。拼死冒号的后果：CN 侧永远查不到行，导出**看似成功**但 `models.json` 是空的，插件静默退回内置兜底名单。

## 5. 切换时挖出的两个真 bug（都不是「切换」本身的问题）

### 5a. `maxTokens` 越界会**静默开 Max、5× 计费**

shim 判「要不要带 Max 标记」用的是：

```
maxMode = 请求的 max_tokens > 该模型在当前 function 下的 dev 窗口
```

CN 目录里模型的 `prompt_max_tokens` 存的是 **Max 模式下的值**（`936000` ≈ 1M × 0.936），而 dev 窗口只有 200000/116000 —— 照抄导出就让**每一个请求**都被判成开了 Max。实测 `glm-5.3` 的倍率 x0.46 → **x2.3**，表现为「额度掉得莫名其妙快」，而且界面上没有任何地方说它开了 Max。

SOLO 侧没暴露纯属巧合：它的 dev 200000、pmt 168000，天然 `168000 < 200000`。

修法：导出时把 `maxTokens` 封顶到该模型**所有分组里最小的 dev 窗口**（现在 CN 是 116000）。默认任何 function 下都不触发 Max；想要 1M 的人显式把 `max_tokens` 调大，那时 Max 才跟着开 —— 那才是用户知道自己在要什么。宁可不给 1M，也不要静默 5×。

### 5b. python stdout 的代码页把中文名写乱码

Windows 上 python 的 `sys.stdout` 默认按控制台代码页（cp936）编码，而 Node 侧用 `encoding:'utf8'` 解 → `DeepSeek-V4-Flash 正式版` 变成 `DeepSeek-V4-Flash ʽ`，并且**一路写进 models.json、显示进模型选择器**。

修法：不要用 `print`，直接 `sys.stdout.buffer.write(...encode("utf-8"))`。`PYTHONIOENCODING=utf-8` 有时被宿主策略覆盖，写 fd 最稳。

## 6. 倍率接口的 `functions` 长度延迟是**非线性**的

同一份凭据、同一批模型，实测响应时间：

| functions 个数 | 耗时 | 覆盖 |
|---|---|---|
| 3 | 2.4 s | 22/22 |
| 5 | 8.1 s | 22/22 |
| 7 | 7.2 s | 22/22 |
| 9 | 10.2 s | 22/22 |
| **12** | **>60 s，超时** | — |
| **17** | **超时** | — |

不是慢，是整条请求被上游掐住。这就是以前「Trae 倍率偶尔整列空白」的根因。

对策：
- **插件运行时**按 `RATE_QUERY_CHUNK = 9` 分批顺序合并；单批失败只丢那批的模型，**第一批都没成才整体抛**（否则界面会显示「没有倍率」而不是「沿用上一次的值」）。
- **导出脚本**按 `RATE_CHUNK = 6` 分批（一次性动作，多花十几秒无所谓）。
- 别再为了「覆盖率」往查询集里堆名字：倍率对同一模型跨 function 取值一致，多查只是多花一次往返，**不会多出一个模型的价**。CN 实测 3 个 `catalogGroups` 就已 22/22。

## 7. 一个差点造成的功能回退（记录以免重犯）

`.gitignore` 里为了挡住宿主导出的凭据目录写了 `trae/` —— **不带前导斜杠的规则匹配任意层级**，于是把插件的 `lib/providers/trae/index.js` 也吞了。后果：

- `lib/index.js` 一直 `import * as trae from "./providers/trae/index.js"`，而那个文件**从未被提交** → 别人 clone 下来直接 `ERR_MODULE_NOT_FOUND`，仓库里的 Trae 渠道是空的；
- `git status` 也永远不提示这个文件，所以本地能跑、推上去是坏的，很难发现。

修法：改成锚定的 `/trae/` + `/trae-cn/`（只忽略仓库根那层），并顺手补上 `package.json` 的 `dsh.bundle.patch` 指向却同样缺失的 `cordis.patch.yml`。

> 教训：拿上游的**已发布产物**去和本机的安装副本对照时，看到的「功能缺失」可能是本仓库自己的有意删除（本项目 `cb46b8d` 就主动删掉了面板扫码入口）。合并前必须确认差异方向，否则会静默把别人删掉的东西推回来。

## 8. 切换操作步骤（给以后重看）

```bash
node scripts/export-trae-plain.mjs --list      # 看两个产品各自登录态/到期时间
node scripts/export-trae-plain.mjs --app cn    # 接 IDE 版（默认：装了就选它）
node scripts/export-trae-plain.mjs --app solo  # 接办公版
```

生效检查（不用重启 DSH，等一轮 30 秒巡检）：

```bash
curl http://127.0.0.1:<DSH_PORT>/plugins/dsh-trae-connect/status
# 看 product / productLabel / catalogFile / function / modelCount

cat ~/.dsh/.trae-connect-state.json      # 插件落盘的运行态，排查第一眼看这个
```
