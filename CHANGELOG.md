# 修复记录

修 bug 是欠账还清，不算卖点，所以单独记在这里。每条都能在 git log 里对上。

## 2026-10

- **Qoder 国际版（`*.qoder.sh`）从未被接通，且 PAT 路径在当前版本走不通**：Qoder 原先只有国区一个 provider，国际版是**另一套独立服务**（账号、额度、模型目录都不互通），插件里没有它的位置；同时 PAT 路径存在一个必现缺陷 —— `fetchUserInfo()` 用 `buildCosyHeaders()` 签名，而那个函数要求 `creds.userID` 非空，可 uid 恰恰是这一步要取的东西。空 uid 在本地直接抛 `cosy: userID 为空`，异常被 `catch` 吞掉后回落成空 uid，最终报成「userinfo 没有返回用户 id（PAT 可能已失效）」——**任何 PAT 都不可能成功**，而文案把锅甩给了 PAT。
  - 国际版的域名不是猜的：`openapi.qoder.com` / `gateway.qoder.com` 实测 **NXDOMAIN**。真实端点在客户端缓存 `~/.qoder/.cache/endpoint-cache.json` 里 —— 推理 `api3.qoder.sh`、OpenAPI `openapi.qoder.sh`、端点发现 `center.qoder.sh`，由客户端从 center 动态拉取，会随服务端调度变化。所以新档案的默认值同时**读这份缓存**（v1 扁平字段与 v2 `endpointSets` 两种形状都认），读不到才回落常量。
  - 协议层实测与国区**完全同构**，因此不需要第二份实现：同一把 COSY RSA 公钥、同一套 `aes-128-cbc + md5` 签名、同样的 `/algo` 前缀与 `Encode=1`、同样的 `dt-` 会话与 `auth.v1.dat`（DPAPI + AES-256-GCM）信封。`Cosy-Version` 1.1.38 与 1.1.69 拉到的目录逐字相同（17 个模型），不敏感。国际版**也有每日签到**（实测 `CLAIMED` / +100 credits），与 WorkBuddy 国际版不同。
  - 修法：把 provider 里写死的单实例常量收成区域档案 `QODER_REGIONS`（端点、会话类型 `qoderclicn`/`qodercli`、provider id `qoder1`/`qoder2`、路由前缀、凭据与运行态文件名），`apply(ctx, { region })` 按档案装配；注册表放开 qoder 多实例（只认 `qoder` / `qoder-global` 两个 id），`channelOf()` 与新增的 `qoderRoutesOf()` **必须算出同一串**——面板按前者 fetch、provider 按后者挂路由，任一处漏改都会静默 404。
  - **PAT 路径一并修好**：userinfo 属 OpenAPI 平面，本就不需要 COSY 签名（裸 `Bearer <jobToken>` 实测 200 且返回 `id`），改用 `openApiHeaders()`。拿到 uid 之后的目录/对话请求仍按原样带 COSY。
  - 国区行为**逐字不变**：`QODER_STATUS_ROUTE` / `CHECKIN_ROUTE` / `PROBE_ROUTE` 三条对外常量一个字没动，provider id 仍是 `qoder1`（用户已选的模型不用重选），凭据与运行态文件名照旧 —— 老注册表（只有 `qoder` 一条、无 `region` 字段）升级后行为不动。
  - 新增 `scripts/qoder-session-export.mjs`：双区域从桌面 App 缓存导出会话（DPAPI 解 os_crypt 密钥 + AES-256-GCM 解 `auth.v1.dat`，`--region cn|global`、`--check`）。发布包里缺的 `qoder-vault.mjs` 功能由它补齐 —— 会话到期时重跑一次即可，不用手工造文件。
  - 新增两个探针：`probes/verify-qoder-global-routing.mjs`（28 项，两区档案/域名/provider id 互不相同、注册表派生 ≡ provider 注册、四条命名空间零重叠、国区常量不变）与 `probes/verify-qoder-cn-no-regression.mjs`（27 项，国区契约 + workbuddy/trae 派生未受牵连）。两者自带 `probes/_qoder-stubs/`（按纪律白名单式声明缺哪 6 个宿主包），**不依赖宿主真包，任何机器可跑**。反向验证各注入一次回归：改坏国区 `routePrefix` → 1 项变红；国际版 `sessionFile` 撞进国区 → 2 项变红，还原后均恢复全绿。
- **国际版每条消息都被上游拦下：`400 code 11128 conversation id missing`**（用户报，用了好几天之后突然全灭）：WorkBuddy AI 5.7 起，国际版 `/v2/chat/completions` 对出站请求做**抽样渠道校验**，要求携带官方桌面客户端那套会话头（`X-Conversation-ID` / `-Request-ID` / `-Message-ID` / `X-Root-Request-ID`），缺一个被抽到的请求就直接 400，`displayTips` 写的是「这次调用没通过渠道校验，可能不是官方客户端发出的」。插件的 `chatHeaders` 一个都没带。
  - 不是插件自己的退化：同期所有第三方反代都在报同一条（workbuddy2api-hub 的 #380 / #383 / #388 / #392），上游侧的对策是把这四个头补齐（PR #381，已被仓库合并）。我们做同一件事。
  - 修法：`chatHeaders` 在国际版（`regionOf(domain) === "global"`）时多带这四个头。插件没有自己的会话（DSH 每条消息都是新会话），所以每个请求**现编一套 id**、不重放旧值 —— 上游关联的正是请求 id，复用才是它要抓的谎。四个 id 都由 `randomUUID()` 生成，互不相同。
  - **CN 不加**：该校验只在国际版网关观测到过，给国区也编一个头是用没验证过的偏差换已经验证过的偏差。
  - 新增 `probes/verify-bugfix-conversation-headers.mjs`（8 项）：用打桩的 `fetch` 抓真实的 `chatStream` 出站头，断言国际版带齐四个 UUID、两次请求的 id 互不相同、国区一个都不带、原有身份/产品块一个不少。反向验证新增 4 处撤回（C/1–C/4）。
- **国际版模型的 1M 上下文在 DSH 里被砍成 300K**（用户报）：上游对同一个模型同时声明多档窗口（实测 `deepseek-v4.1-flash` 是 `contextWindow 300000` + `supportedContextWindows [300000, 1000000]`），而适配器只广告一档。三个独立缺陷叠在一起，缺一个都不会表现出来：
  1. 偏好读的是 `config.useMaximumContextWindow`，而 `lib/index.js` 用 `apply(ctx, {})` 调子模块、第二个参数恒为空对象 —— 读到的**永远**是 false。偏好现在挂在面板/插件自己的 `Config`（`HUB_SECTION`，宿主唯一会投影的那份）上，由 `lib/index.js` 通过 `workbuddy.setPreferences(hubPreferences)` 把读写通道注入子模块；`catalog` 改成**惰性读源**（每次 `current()` 现读），所以面板里改完立刻生效，不用重启。
  2. 状态路由只在 `legacySettingsAvailable` 时才下发 `useMaximumContextWindow`，而那个条件要求宿主有 `settings.installSection` —— 本机 DSH 没有，于是字段从不出现、复选框根本不渲染。现在按 `region === "global"` 下发（写通道不可用时仍返回 `undefined`，界面就不显示一个存不下去的开关）。
  3. 前端又把复选框钉在 `variant.id === AI_CARD_VARIANT.id`（= `workbuddy2`），所以 `workbuddy4/5` 这些国际版槽位即使拿到字段也永远看不到。现在只看后端给不给这个字段。
  - **这个开关从设置卡片搬到了面板渠道行**（用户要求）：它原先只藏在 workbuddy 设置卡片的 Context 页里，而面板才是用户管渠道的地方 —— 不搜就找不到。现在做成模型数旁边的一个 chip（`1M 上下文` / `默认窗口`），点一下就切。**实测可随时切换、不用重启**：POST 之后 `deepseek-v4.1-flash` 的 `contextWindow` 在 `1000000` 与 `300000` 之间即时来回。
    - ⚠️ 它是**全局**偏好（settings 里只有一个键）：在一个槽位上点，所有国际版槽位一起变 —— tooltip 里写明了，免得以为是单槽位设置。
    - 顺带修了一个自相矛盾：偏好确实是惰性读的，但**宿主对各 provider 的模型列表有缓存**，写完不广播就会出现"面板行显示新值、模型选择器里还是旧窗口"。现在写完 `onModelsChanged()` 广播一次。
    - 另外说明为什么做不到"所有模型都 1M"：实测本机目录 25 个模型里 **17 个已经 1M**，剩下 8 个（`grok-4.7`=500K、`gpt-5.4`/`primary-model`=272K、`balanced-model`/`kimi-k2.6`=256K、`fast-model`=200K、`hy3`=192K、`default-model`=176K）是上游自己只声明那么大，硬报 1M 会让 DSH 往上游塞超限上下文换来 400。
- **刚添加、还没认证的国际版槽位会把模型漏进模型选择器**（用户报）：新建槽位的用途是多账号，而国际版槽位的默认读法是"直接读桌面 App 的登录态"，于是空槽位立刻借到 App 里那份凭据、看起来已登录（实测借到的还是**另一个槽位**的账号），`adoptIdentity` 据此把 catalog 置为可见，一整套不属于它的模型进入选择器。修复分四处：
  - 注册表新增 `followDesktop`，**缺失按 true**（旧条目逐字保持原行为，升级不会突然"未登录"）；面板新增的国际版槽位显式写 `false`，表单里也能勾选"跟随桌面 App"。
  - provider 侧 `configuredAuthFile` 与 store 侧 `resolveDesktopCandidates` **两侧**都按它分流：不跟随的槽位只认 `connect-auth/<id>.json`（通常不存在 ⇒ 干净地未登录），绝不落到平台默认探测。两侧都改是因为 CLI（`bin.js doctor`）与其它调用方不会经过 provider。
  - 认证页一度给国际版槽位显示一个「跟随桌面 App」chip，**现已删掉**（用户要求）：它显示的是「**允许**回落桌面凭据」这条策略，tooltip 却写成"该槽位的凭据直接读桌面客户端的登录态"—— 实测在已扫码的槽位上是**错的**（`workbuddy4/5` 用的是各自扫码登录的号，`signedInBy === "scan"` 优先，与桌面 App 那份凭据无关），而它要解释的现象正是本次修复消掉的东西。判定逻辑保留，只是不再透到界面。
  - 新增 `probes/verify-bugfix-intl-window-and-empty-slot.mjs`（40 项），并配 `scripts/reverse-verify-bugfix.mjs`：把 14 处修复逐个撤回，对应断言必须变红（已实测全部按预期变红）。
- **TRAE SOLO CN 已被厂商并入 Trae CN IDE**（用户报）：本机实测卸载表里只剩 `TRAE CN 3.4.2`，`D:\TRAE SOLO CN\TRAE SOLO CN.exe` 已不存在，残留 `product.json` 的 `commit`/`buildId` 与 Trae CN **逐字节相同**。所以代码与文案里"两个产品"的说法全面收口：
  - 插件侧 `TRAE_DEFAULT_PRODUCT` 从 `solo` 翻成 `cn`；`cn` 的 `functions`/`rateFunctions`/`catalogGroups` 统一成 IDE 自己的三个分组（`solo_agent` / `chat_v3` / `builder_v3`）。理由不止是省一次往返：`reasoningByGroup` / `contextWindowByGroup` 只带这三组的数据，真用旧 SOLO 槽位名去请求会让思考档位静默失效、窗口退回兜底值。
  - `solo` 那条**逐字冻结**（白名单、倍率查询集、目录分组、兜底名单、目录子目录全部保持并入前的值）：手里拿着 SOLO 快照的人没有重导的机会（独立客户端装不回来了），任何一项跟着 CN 改都会让他们在某次重启后突然掉模型、掉倍率、掉档位。`resolveProduct` 仍按 buildId / `packageType` 把无标注的旧快照嗅探成 solo。
  - 导出脚本：`cn` 的兜底 `buildId`/`appVersion` 更新为本机实测的 `1238630385922` / `3.4.2`；`cn` 的倍率查询集收成三个分组名（实测 250 ms / 24 个模型全覆盖，带旧名要 962 ms 且一条不多）；头部与用法改成"在用的产品只有一个，`solo` 是历史兼容"。
  - README / docs 里"两个产品互切""SOLO 有自己的 8 个模型"之类的说法全部改写。
- **两个活体探针写死了旧包名 `dsh-connect`**：`verify-qoder-probe-live.mjs` 与 `qoder-raw-catalog.mjs` 直接拼 `node_modules/dsh-connect/lib/...`，包改名后每次都以 ENOENT 变红，而报错看起来像断言失败、实际只是路径没了。改走 `probes/_installed.mjs`（按 profile 依赖键定位），与其余探针一致。
- **国际版"没有签到活动"被谎报成"今天已签到"**：WorkBuddy AI 账号打 `daily-checkin` 回 `10001 签到活动未开启或已过期`，国区个人号同期回 `10001 今天已签到，请明天再来` —— **同一个 code、含义相反**，而代码只按「不支持」关键词分流，于是国际版被判成 `already-claimed`，面板显示"已签到"（纯属谎报）。同时只读路径把国际版的看板默认值（`active:false`/`today_checked_in:false`）当成"今天还没签"，返回 `claimable`，界面给出一个**可点的『签到』按钮**，点下去才发现什么都没有 —— 正是同文件企业号那段注释明令避免的"假动作入口"。现在 `10001` 按文案分成三态（已签 / 无活动 / 不支持），且区域兜底直接判国际版为不适用。实测确认：国际版与 `hy3` 的 `deepseek-v4.1-flash` 倍率为 `x0.00`（免费），这是它的免费额度来源。
- **从插件市场装不上（issue #2）**：用户点安装，失败，市场把原因归为 `plugin-side install failure` —— 这次归类是**对的**，问题在我们自己的 `package.json`。11 个宿主 peer 依赖一个都没标 optional，于是 pnpm 要往用户 profile 里拖进 **164 个传递依赖**（`@earendil-works/pi-ai` 全家桶、`@aws-sdk/*` 等），并撞上 pnpm 的构建脚本拦截门 `[ERR_PNPM_IGNORED_BUILDS]` 直接 exit 1。实测对比：不标 = 装 165 个包 + 失败；全标 + 装 1 个包 + 997 ms 成功。这些包本来就由宿主进程提供、进不了 profile 的 node_modules，标 optional 不影响运行。同生态的干净插件全都这么做（`dsh-free-search` 8/8、`dsh-rewind-plugin` 16/16）。
  - 新增 `probes/verify-install-peers.mjs`：钉住「每个 peer 都必须 optional」+ `dependencies` 必须为空，并在本地复刻插件市场的入口校验（`resolvePackageEntry` → 入口文件必须真实存在），让这类分发缺漏不可能再装到一半才被发现。
- **国际版（WorkBuddy AI）从未被真正接通**（issue #1）：上游原版本来就是「国区 + 国际版」双变体，`GLOBAL_BASE`、`regionOf`、`resolveGlobalIdentity`、`WORKBUDDY_AI_*` 路由一行没删，是本地分支把 `workbuddyVariantOf` 的 `appName` / `region` / `desktopFilename` 写死成国区，于是没有任何变体能走到那条分支（`region: "cn"` 让国际版凭据在 `WorkBuddyCredentialStore.current()` 里直接被判为「区域不匹配」抛错）。现在区域由注册表条目声明（`region: cn | global`），认不出的值回落国区。
  - 顺带修掉两个 **Windows 上必然踩** 的坑：① 解封加密凭据的 Electron 助手路径原先只在 macOS 有默认值，Windows 上不设 `WORKBUDDY_ELECTRON_BIN` 就永远解不开凭据 —— 现在从 App 自己写的 `settings.json` 里读回它自己的 exe；② app 版本号来源同样是 macOS-only，Windows 上会一直是编译期常量 `5.5.2`（实际装的是 `5.7.6`），现在读 App 自己的 `last-launch.json`。
  - 国际版的默认读法是直接读桌面 App 的登录态（与国区版共用 `CodeBuddyExtension/Data/Public/auth/`，只差 basename `workbuddy-desktop-ai.info`）。因此**不能**像国区槽位那样无条件回落到 `connect-auth/<id>.json`：那个路径不存在时会把 App 里能用的凭据彻底挡住，表现为「App 明明登录了、DSH 里却一直未登录」。（这条后来被 `followDesktop` 收紧了默认值 —— 见上面「刚添加、还没认证的国际版槽位」那条；老部署的既有条目行为不变。）
- **Trae 默认思考档位只对 `high` 生效，其余模型全丢**（`dfb8fa5`）：回退默认档时把 `default_level` 又过了一次反查表 —— 那张表的键是 pi-ai 档位（`low/high/xhigh`），而快照里的 `default_level` 本来就是 Trae 线上拼写（`light/high/extra_high`）。只有 `high` 因为两边同名侥幸生效，默认档为 `extra_high` 的 GLM-5.3 系 / Kimi-K2.8 / Kimi-K3 与 `light` 的模型全部静默丢掉默认档。现在直接用线上拼写，并校验它确在该模型声明的 options 里（不在就不发）。用户手选的档位仍走反查表，那才是它该用的地方。
  - 同一提交修了探针的一处误红：`verify-trae-products` 把快照 buildId 钉成「必须等于变体表」，而运行时优先级本就是 `配置 ?? 快照 ?? 表值` —— 厂商一升级就误判成故障。改为钉「快照带了可用 buildId」+「优先级没被写反」（实测新旧 buildId 打倍率接口返回逐字节相同，815552 B / 194 处倍率）。
- **禁用渠道后模型还能选**（`50273f0`）：面板写着「已禁用」，模型照常可见。写入 `disabledChannels` 的是渠道 id（`qoder`），隐藏判定查的却是 provider id（`qoder1`），只在 Qoder 上不一致，静默失效。现在两种 id 都认，注册表读不到时判「没禁用」——宁可漏隐藏，不误隐藏。
- **Qoder 每轮对话都报 `499 客户端已取消`**（`a0d8ed2`）：把「请求体读完」当成了「用户取消」。Node ≥16 里 `IncomingMessage` 的 `close` 在 body 读完就触发，不是断连信号；改挂到 `res` 上用 `writableEnded` 区分。Trae / WorkBuddy 的反向潜伏 bug（取消不中止上游、白烧额度）一并修掉。
- **档位探查一律答「无凭据」**：有凭据却测不了，账号接线漏传。
- **跨渠道历史里的工具调用破损**：换渠道续聊时空函数名 / 孤儿结果导致突然 400。
- **「额度超限」被误报成「API 密钥无效」**：报错文案与真实原因对不上。
- **流式响应被静默截断、残片丢失**：长回复缺头少尾却不报错。
- **Trae 渠道跑不了 Agent 回合**：工具调用当时根本没接上；现已端到端实测（结构化工具调用、参数分片拼接、`finish_reason` 改写）。
- **模型按钮看不出已选几个、改名时按钮文字挤成竖排**：常显「已选 X / 共 N」；按钮加 `flex:none` + `nowrap`。

## 2026-09 及更早

- 三渠道聚合的初版实现（基于 yembors64632/dsh-connect 收编合并）
- 包名从 `dsh-connect` 改为 `dsh-workbuddy-trae-qoder-connect`；探针的安装目录解析同步修正（旧硬编码会让 12 个探针在 `--installed` 模式下读空路径，报错看着像断言失败，实际只是路径没了）。2026-10 又把最后两个漏网的硬编码（`verify-qoder-probe-live` / `qoder-raw-catalog`）一起改走 `_installed.mjs`。
