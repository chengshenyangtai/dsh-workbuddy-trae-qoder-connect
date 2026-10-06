# Trae 思考档位（reasoning effort）协议实证

> 2026-10-06 采集。所有结论都有可复现来源，不靠猜。
> 采集手段：客户端源码（`@byted-icube/ai-modules-chat`）、客户端日志（renderer.log
> 真实请求体）、`state.vscdb` 目录配置、以及带对照组的上游实测。

## 1. 事实清单

| # | 事实 | 来源 |
|---|---|---|
| F1 | 档位**按 (模型 × function) 配对下发**，不是模型级全局属性 | `state.vscdb` → `model_list_map` |
| F2 | 只有 `solo_agent_lite` / `solo_agent_remote` 两个槽位有档位；`solo_work_lite` 下**全部为 0** | 同上，逐槽位统计 |
| F3 | 同一模型在两个槽位的配置不同 | 同上 |
| F4 | 字段名是 **`reasoning_effort_level`**（文档层叫 `reasoning_effort`，客户端二选一） | 客户端源码 + 真实日志 |
| F5 | 档位放在 `custom_model` **子对象**里，不是顶层 | 真实日志请求体 |
| F6 | **`config_source` 必须是数字 `1`**，字符串会导致档位只部分生效 | 实测对照（见 §3） |
| F7 | Trae 的档位值分两族：internal `none/low/medium/high/xhigh/max`、external `light/high/extra_high` | 客户端 i18n + 目录 options |
| F8 | 上游**静默忽略**非法档位值（不返回 4xx） | 实测：乱填值 → 200 |
| F9 | 判据在 SSE 首个 chunk 的 `statusCodeValue` | 客户端源码 |

## 2. 各 function 槽位的档位支持（本账号实测）

| function | 模型数 | 支持档位 | 三档齐全 |
|---|---|---|---|
| **solo_agent_lite** | 18 | **11** | **6** |
| solo_agent_remote | 18 | 11 | 6 |
| solo_work_lite（旧默认） | 17 | 0 | 0 |
| solo_coder | 14 | 0 | 0 |
| 其余 4 个 | 2–10 | 0 | 0 |

切换代价：`solo_work_lite` 的 17 个模型**全部**在 `solo_agent_lite` 的 18 个里，
且多出一个 `Seed-Code` → **零丢失**。

## 3. 关键对照实验：`config_source` 类型

同一 `deepseek-v4.1-flash`、同一 function（`solo_agent_lite`）、同一 prompt：

| `config_source` | 档位 | 耗时 | 思考链字符 |
|---|---|---|---|
| `"trae"`（字符串） | light | 176.2s | 6,453 |
| **`1`（数字）** | **light** | **62.4s** | **1,984** |
| `1`（数字） | extra_high | 153.3s | 4,924 |

**结论**：字符串让服务端认不出模型来源，档位只被"部分"接受；
改成数字后 light/extra_high 差距拉开到 **2.5 倍**，与 Trae App 内选档位一致。

## 4. 为什么"哨兵拒绝法"对 Trae 无效

WorkBuddy 那套探查依赖"上游拒绝非法值"（哨兵被 400 → 说明确实校验）。
Trae 实测**乱填值同样 200**（F8），所以：

- 哨兵法在 Trae 上会得出 `non-validating`，但**这不等于档位无效**；
- Trae 的档位真相在**目录声明**里（F1），不需要探查。

因此三渠道的探查策略必须分开：

| 渠道 | 档位来源 | 探查 |
|---|---|---|
| Trae | 目录声明（per model × function） | **不做**，声明即权威 |
| Qoder | 目录只有 `isReasoning` 布尔 | **必须做**（哨兵法可用：乱填→400） |
| WorkBuddy | 部分声明 `supportedEfforts` | 已实现（哨兵法） |

## 5. 实现要点（本插件）

1. `buildModels()` 按当前 function 取 `reasoningByGroup[fn].options` → 生成
   `thinkingLevelMap`（`light→low`、`high→high`、`extra_high→xhigh`）；
2. shim 从 `request.reasoning_effort` 反查 Trae 线上值；
3. `chatStream` 带 `custom_model`，其 `config_source` 固定为数字 `1`；
4. 默认 function 改为 `solo_agent_lite`。

## 6. 复现脚本

| 脚本 | 用途 |
|---|---|
| `rank-trae-functions.py` | 统计各 function 的档位支持 |
| `extract-real-trae-request.py` / `print-raw-descriptor.py` | 从日志提取真实请求结构 |
| `trae-effort-full.mjs` | 按真实结构发请求，验证档位实效（含 config_source 对照）|
| `verify-trae-effort-chain.mjs` | 离线验证「声明 + 映射 + payload 形状」|
