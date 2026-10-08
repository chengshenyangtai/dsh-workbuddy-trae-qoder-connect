# 实现备注（从代码注释中收编的长文）

> 这些内容原先以多行注释形式写在代码里。代码里现在只保留 2–4 行的
> 结论与契约；完整背景移到这里。**改代码前先查对应小节。**

## Qoder 渠道总览（原 lib/providers/qoder/index.js 头注释）

`dsh-qoder-connect` 把 Qoder CN（阿里 Qoder 国内版桌面 App）订阅里的模型接入
DeepSeek Harness。要点：

- 凭据两条路：桌面 App 登录态（`connect-auth/qoder-session.json`，优先）与
  官方 PAT（`connect-auth/qoder.pat`）。App 会话 token（`dt-` 前缀）在
  OpenAPI 与推理两个平面都是有效 Bearer，不必走 PAT 交换。
- 请求签名是 COSY 风格：`buildCosyHeaders(body, url, creds)`，
  **只有要发出去的字节才参与签名**（先 encode 后 sign，顺序不能反）。
- 网关/OpenAPI/对话路径都有内置默认，见模块内 `DEFAULT_*` 常量。
- 错误有两层：HTTP 层与 SSE 信封里的 `statusCodeValue`（HTTP 200 也可能带
  业务错误）。**403 ≠ 凭据失效**：`code:110 "Billing daily count exceeded"`
  是当日次数超限。
- 额度：`[EXCEED_QUOTA]` 哨兵表示用尽；`[NOT_EXCEED_QUOTA]` 是正常心跳。

## Trae 渠道总览（原 lib/providers/trae/index.js 头注释）

`dsh-trae-connect` 把 Trae 订阅里的模型接入 DeepSeek Harness。要点：

- 双产品线（CN / SOLO）共用同一推理端点与 appId，差别在 function 名单、
  buildId、倍率注册表；全部差异收在 `TRAE_PRODUCTS` 一张表里。
- 凭据 = 从 Trae 客户端解密导出的明文快照，30 秒轮询 `product` 字段以跟随
  产品切换（CN↔SOLO 时 function 白名单、目录路径、req_source 必须整套换）。
- 推理网关默认 `https://trae-api-cn.mchost.guru`；账号/计费默认
  `https://api.trae.cn`。
- 思考档位是 `light/high/extra_high`，映射到 pi-ai 的 `low/high/xhigh`。

## WorkBuddy 工具破损修复（原 repairToolPairing 长注释，2026-10-08）

事故：会话中途用 `deepseek-v4.1-flash` 每轮 400/11133；同一份历史
`glm-5.3-flash` 200；换 workbuddy2 账号同样 400 —— 变量是模型。

排障路径（按请求数最小化）：

1. 重建 1499 条消息：686 组工具往返、0 孤儿、0 未应答 → **配对完好**，
   推翻"修复配对"的早期假设。
2. 尾部二分：1255 条（2048 KB）200 / 1259 条（2051 KB）400；把 1259 条
   压到 940 KB 仍 400 → **体积不是变量**。
3. 把 1259 条的 tool 结构摊平（仍 1259 条）→ 200 → 变量在**工具结构**里。
4. 两条尾部逐条对齐：多出的恰好是那条 `function.name === ""` 的调用
   及其 `Error: unknown tool ""` 结果。
5. 最小复现（4 条消息、约 200 字节）：`name=""` → 400/11133
   （`extError.code = model_param_invalid`）；`name="pwsh"` → 200。
6. 反向：从 1259 条里只删那两条 → 200。

根因：**空函数名的退化调用**会让 deepseek 系上游整单拒绝，glm 系宽容。
记录来自 Trae 适配层在丢头部片时产出的无名调用。修复分两层：

- Trae：首事件预读后把**同一个** SSE parser 交给 translate（原先新建
  parser 丢弃残片，正是头部片丢失的来源）；
- WorkBuddy：shim 转发前摘掉空名/缺名调用及其结果（repairToolPairing 规则 4）。

## 附件契约垫片（两个 provider 的同名长注释）

pi-ai 调附件服务的 `readImageRequest(ref, policyOrTarget, signal)` 时，
第二参在两代宿主附件服务间语义不同：

- `dsh-attachment-local` ≤0.1.5：收到路由策略 `{ maxPixels, maxBytes }`，
  缺 `maxPixels` 会被 `validatePolicy` 拒收；
- 0.1.6+：收到单图目标 `{ width, height, maxBytes }`，没有 `maxPixels`。

于是「0.1.6 编的 pi-ai 装在 0.1.5 宿主上」每个带图请求在发出前就失败。
`withLegacyImageBudget(store, pixelBudget)` 用一层 Proxy 把路由算好的像素
预算补进缺 `maxPixels` 的调用，两代宿主都能正确读图。

## WorkBuddy 登录路由（原 login 路由长注释）

`POST …/login/start` 返回授权 URL（`--url-only` 同源）；`GET …/login/poll?state=`
轮询登录结果。状态是一次性消费的：poll 成功即销毁，防止重复消费同一次授权。
**面板内不提供扫码入口**：DSH 宿主里点外部链接会把面板顶掉，授权链接
由用户复制到浏览器打开。凭据写盘 0600。

## WorkBuddy 可见性存储（原 WorkBuddyVisibilityStore 长注释）

按 `<渠道 id>.model-visibility.json` 存每个账号隐藏了哪些模型。
格式版本不匹配 = 视为不存在（只多显示模型，不会少显示）。
读写失败均回落到「没隐藏」：显示偏好损坏只影响面板勾选框，不影响凭据。
写盘走 tmp+rename，防崩溃留下半份文档被读成"什么都没隐藏"。

## WorkBuddy 账号身份解析（原 adoptIdentity 长注释）

`variant × account` 的身份变化必须作废旧缓存：账号换了人（扫码换绑）、
企业域变了，旧目录/旧探查记录都不可信。`identityOf(variant.id)` 作为
缓存的指纹来源；每次凭据巡检现算现比，变了就 invalidate。
