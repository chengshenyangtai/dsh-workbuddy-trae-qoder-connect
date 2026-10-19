# probes/ 验证脚本

## 确定性脚本（28 个）

不依赖网络、不需要重启 DSH，任何机器 `node probes/verify-xxx.mjs` 就能跑；断言对象是**装着的那份插件**（`_installed.mjs` 按 profile 依赖键定位，包改名不会让整批探针变红）。输出统一是 `N 通过 / M 失败`，退出码即结果。加 `--installed` 则改测 profile 里跑着的那份。

> ⚠️ 其中一部分探针要 import **宿主真包**（`@deepseek-ai/schemastery` 等，见 `probes/README.md` 的探针纪律）。桌面版把依赖打进 `app.asar` 后，`~/.dsh/profiles/desktop/node_modules/@deepseek-ai/` 可能是空的，这类探针会以
> `找不到宿主真包 … —— 本探针需要装过 dsh 桌面版的机器` + **exit=2** 退出。这不是断言失败，是环境缺件。
> 带 `_qoder-stubs/` 的两个探针（见下）不依赖宿主包，任何机器都能跑。

```bash
node probes/verify-trae-products.mjs                 # Trae 产品变体（56）
node probes/verify-bugfix-conversation-headers.mjs     # 国际版会话头族：上游 11128 渠道校验（8）
node probes/verify-bugfix-intl-window-and-empty-slot.mjs  # 国际版最大窗口（含面板开关）+ 空槽位不显示模型（40）
node probes/verify-workbuddy-intl.mjs               # WorkBuddy 国际版接入（含真实凭据解密）
node probes/verify-probe-service.mjs               # 哨兵探查服务（25）
node probes/verify-trae-effort-chain.mjs             # Trae 档位链路（22）
node probes/verify-qoder-effort-source.mjs           # Qoder 档位来源合并（21）
node probes/verify-trae-tool-calling.mjs             # Trae 工具调用全链路（19）
node probes/verify-effort-refresh.mjs              # 更新模型的档位差异 + 默认档 + 兜底名单（18）
node probes/verify-trae-output-hygiene.mjs           # Trae 输出净化 / 断流可见性 / parser 交接（17）
node probes/verify-probe-contract.mjs                # 探查契约与 onProbed 接线（17）
node probes/verify-install-peers.mjs                # 安装分发契约：peer 必须 optional（14）
node probes/verify-qoder-auth-retry.mjs              # Qoder 凭据重试（11）
node probes/verify-trae-parser-handoff.mjs           # 流式残片与收尾（11）
node probes/verify-workbuddy-intl-checkin.mjs        # 国际版"没有签到活动"不被谎报成已签（10）
node probes/verify-qoder-stream-fixes.mjs            # Qoder 首事件批 / 返回形状 / 取消接线（9）
node probes/verify-workbuddy-tool-pairing.mjs        # 跨渠道工具配对（9）
node probes/verify-attachment-wiring.mjs             # 三家附件接线（9）
node probes/verify-channel-disable-effect.mjs        # 禁用渠道真的隐藏模型（9）
node probes/verify-channel-disable-memory.mjs        # 禁用/启用不丢模型勾选（8）
node probes/verify-probe-account-wiring.mjs          # 探查账号接线（8）
node probes/verify-qoder-error-classification.mjs    # 额度错误不再冒充"API 密钥无效"（8）
node probes/verify-provider-config-schema.mjs        # 渠道配置 schema（7）
node probes/verify-schemastery-field-shapes.mjs      # 宿主 schema 调用形状（7）
node probes/verify-shim-cancel-wiring.mjs            # Qoder 499 取消根因回归（5）
node probes/verify-workbuddy-reasoning-levels.mjs    # 档位映射（"关思考"恒为不提供）（4）
node probes/verify-qoder-global-routing.mjs          # Qoder 双区域路由/凭据落点一致（28，自带 stub）
node probes/verify-qoder-cn-no-regression.mjs        # 加国际版未改国区契约（27，自带 stub）
```

## 活体脚本（3 个）

打真实上游、消耗额度，只在做协议级核对时手动跑：

- `verify-qoder-probe-live.mjs` —— Qoder 探查端到端（真实上游，含对照组）
- `qoder-raw-catalog.mjs` —— 拉线上 Qoder 目录核对字段（`docs/CATALOG.md` 的核对工具）
- `trae-cn-model-callability.mjs` —— Trae CN 独占模型可调用性（每模型 1 个 token 级请求）

## 探针纪律

- 断言拿**真实宿主 peer 包**跑，契约错误不能被沙箱 stub 吞掉（宿主独有依赖用 stub loader 的，stub 必须显式声明缺哪个包）
- 断言**值**而非键名；钉行为，不钉实现写法——实现换掉时探针该红的红、该绿的绿
- 异步用例 `await` 且串行：共享全局 `fetch` 的用例并发跑会互相串味
- 接线类修复走完整链路端到端测——单组件单测是"永远绿"的
- 每条修复对应的探针都做过**反向验证**：把修复删掉，探针必须变红（当前 18 处，见 `scripts/reverse-verify-bugfix.mjs`）
