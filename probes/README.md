# probes/ 验证脚本

## 确定性脚本（21 个，283 项断言）

不依赖网络、不需要重启 DSH，任何机器 `node probes/verify-xxx.mjs` 就能跑；断言对象是**装着的那份插件**（`_installed.mjs` 按 profile 依赖键定位，包改名不会让整批探针变红）。输出统一是 `N 通过 / M 失败`，退出码即结果。

```bash
node probes/verify-trae-products.mjs                 # Trae 双产品变体（40）
node probes/verify-probe-service.mjs               # 哨兵探查服务（25）
node probes/verify-trae-effort-chain.mjs             # Trae 档位链路（22）
node probes/verify-qoder-effort-source.mjs           # Qoder 档位来源合并（21）
node probes/verify-trae-tool-calling.mjs             # Trae 工具调用全链路（19）
node probes/verify-trae-output-hygiene.mjs           # Trae 输出净化 / 断流可见性 / parser 交接（17）
node probes/verify-probe-contract.mjs                # 探查契约与 onProbed 接线（17）
node probes/verify-effort-refresh.mjs              # 更新模型的档位差异 + 默认档 + 兜底名单（17）
node probes/verify-qoder-auth-retry.mjs              # Qoder 凭据重试（11）
node probes/verify-trae-parser-handoff.mjs           # 流式残片与收尾（11）
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
- 每条修复对应的探针都做过**反向验证**：把修复删掉，探针必须变红
