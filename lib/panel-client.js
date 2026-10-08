/**
 * 面板的**客户端半侧源码**（dsh-connect 的一部分）。
 *
 * ⚠️ 这个文件不会被直接加载 —— 它与其他三份客户端半侧一起，被
 * `plugins/history/compose-dsh-connect-client-20260924.py` 合成为
 * `lib/client.js`（DSH 一个包只能有一个客户端入口）。改这里之后要重跑生成器。
 */
window.__ModuleLoader__.load({
	id: "dsh-connect-hub",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		/** `createPortal` 在 react-dom 上，不在 react 上 —— 写成 react.createPortal 是 undefined。 */
		const reactDom = require("react-dom");

		//#region 常量

		/** 与宿主侧 index.js 的字面量必须逐字一致。 */
		const STATUS_PATH = "/plugins/dsh-connect/status";
		const CHECKIN_PATH = "/plugins/dsh-connect/checkin";
		const SETTINGS_PATH = "/plugins/dsh-connect/settings";
		const MODELS_PATH = "/plugins/dsh-connect/models";
		const AUTH_PATH = "/plugins/dsh-connect/auth";
		/**
		 * 渠道管理动作（禁用 / 启用 / 删除）**共用 `/auth` 端点** ——
		 * 独立路由在 DSH 里注册不生效（详见宿主 panel.js 里那段说明）。
		 */
		const CHANNELS_PATH = AUTH_PATH;
		/** 渠道管理动作的协议字段名（不能用 `action`，见下）。 */
		const CHANNELS_OP_FIELD = "op";

		/**
		 * WorkBuddy 槽位 id（`workbuddy1`/`2`/`3`…）→ 它自己的**扫码登录**路由前缀。
		 *
		 * 只有 workbuddy 有这套登录协议（Trae/Qoder 没有），所以非 workbuddy 返回
		 * undefined —— 调用方据此决定显不显示「扫码」按钮。
		 *
		 * 前缀由**渠道 id 里的数字**推导，与宿主侧 `variants-CnrmSn0Q.js` 的
		 * `statusPath: /plugins/dsh-workbuddy-connect/${n}/status` 逐字同源。
		 * 两处必须一起改。
		 */
		function workbuddyLoginPath(channelId) {
			const match = /^workbuddy(\d+)$/.exec(String(channelId ?? ""));
			return match === null ? undefined : `/plugins/dsh-workbuddy-connect/${match[1]}/login`;
		}

		/** 弹窗打开时的刷新间隔。面板关着时**不轮询** —— 一次扇出会打 5 个上游额度接口。 */
		const OPEN_REFRESH_MS = 120000;
		/** 焦点/可见性抖动的保护间隔。 */
		const MIN_GAP_MS = 15000;

		const CHECKIN_STATES = {
			busy: { key: "checkinBusy", tone: "muted" },
			claimable: { key: "checkinClaim", tone: "action" },
			claimed: { key: "checkinClaimed", tone: "ok" },
			done: { key: "checkinDone", tone: "ok" },
			manual: { key: "checkinManual", tone: "warn" },
			/**
			 * 渠道**明确**不支持签到（企业版账号、活动未开放）—— 与 `unavailable`
			 * （现在问不到，重试可能就好）分开：这一态不给动作入口，只给一个灰色说明。
			 */
			unsupported: { key: "checkinUnsupported", tone: "muted" },
			unavailable: { key: "checkinUnavailable", tone: "muted" },
			"signed-out": { key: "checkinNone", tone: "muted" },
			unknown: { key: "checkinUnknown", tone: "muted" },
			failed: { key: "checkinRetry", tone: "error" },
		};

		//#endregion

		//#region 样式

		/**
		 * 侧栏条目的样式表。
		 *
		 * 侧栏里已有的条目（用量统计 / 上下文洞察 / 设置）都是「图标 + 文字」的整行
		 * 无边框行，hover 只换一层底色 —— 这里照抄宿主菜单项的语言：`gap: 8px`、
		 * `padding: 7px 10px`、`border-radius: 8px`、hover 用 `-interactive-bg-hover`；
		 * 「可签 N」用宿主 tag 的 warning 配色（12% 底色 + warn 前景）。
		 *
		 * 内联样式写不了 `:hover` / `:focus-visible`，所以这一块走 <style>，
		 * 布局之外的东西仍按本文件惯例内联。
		 */
		const HUB_CSS = [
			".dshc-side{display:flex;align-items:center;gap:8px;box-sizing:border-box;width:100%;padding:7px 10px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:var(--dsh-content-font-size-secondary, 13px);line-height:18px;text-align:left;cursor:pointer;transition:background .12s ease,color .12s ease}",
			".dshc-side:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".dshc-side:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}",
			".dshc-side__ico{display:inline-flex;flex:none;align-items:center;justify-content:center;width:16px;height:16px;color:inherit}",
			".dshc-side__ico svg{width:16px;height:16px}",
			".dshc-side__label{flex:1 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}",
			".dshc-side__tag{flex:none;padding:1px 8px;border-radius:999px;font-size:11px;line-height:17px;font-weight:500;font-variant-numeric:tabular-nums;color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent)}",
			".dshc-side__count{flex:none;font-size:12px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}",
			".dshc-side--rail{position:relative;justify-content:center;padding:7px 0}",
			".dshc-side--rail .dshc-side__label,.dshc-side--rail .dshc-side__tag,.dshc-side--rail .dshc-side__count{display:none}",
			".dshc-side__badge{position:absolute;top:4px;right:calc(50% - 10px);width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-warn-primary)}",
		].join("");

		/**
		 * `<style>` 只注入一次：条目会随侧栏折叠态重新渲染，重复注入没意义。
		 * 放在 head 而不是组件里，是为了让它不参与条目的 diff。
		 */
		let hubStyleInjected = false;
		function ensureHubStyle() {
			if (hubStyleInjected || typeof document === "undefined") return;
			hubStyleInjected = true;
			const node = document.createElement("style");
			node.setAttribute("data-dsh-connect", "sidebar-entry");
			node.textContent = HUB_CSS;
			document.head.appendChild(node);
		}

		/** 侧栏图标：中心节点 + 三个卫星 —— 一个"渠道汇聚"的记号，跟随文字色。 */
		const HUB_ICON = react.createElement(
			"svg",
			{
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.3,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
			},
			react.createElement("circle", { cx: "8", cy: "8", r: "2.1" }),
			react.createElement("circle", { cx: "8", cy: "2.9", r: "1.5" }),
			react.createElement("circle", { cx: "3.6", cy: "12.1", r: "1.5" }),
			react.createElement("circle", { cx: "12.4", cy: "12.1", r: "1.5" }),
			react.createElement("path", { d: "M8 4.4v1.5M6.4 9.6 4.6 10.9M9.6 9.6l1.8 1.3" }),
		);

		const S = {
			scrim: { position: "fixed", inset: 0, zIndex: 9998, background: "transparent" },
			/**
			 * 弹窗骨架：竖向三段 —— **头部固定 / 内容滚动 / 底部固定**。
			 *
			 * 这是这次布局调整的要点：改之前所有东西（标题、摘要、五行渠道、一键签到、
			 * 认证区、偏好区）堆在一个滚动体里，渠道一多就得滚到底才能按"一键签到"，
			 * 而那个按钮看起来又不属于底部。现在它钉在底部，内容区自己滚。
			 *
			 * `overflow: hidden` 是为了让内部滚动条被圆角裁掉；`maxHeight` 用 vh + px 双上限，
			 * 小窗口时仍留出页面边距。
			 */
			popover: {
				position: "fixed",
				zIndex: 9999,
				boxSizing: "border-box",
				display: "flex",
				flexDirection: "column",
				width: "min(560px, calc(100vw - 32px))",
				maxHeight: "min(68vh, 640px)",
				overflow: "hidden",
				borderRadius: "12px",
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-bg-layer-1)",
				boxShadow: "var(--dsw-shadow-lv2, 0 8px 28px rgba(0,0,0,.18))",
				color: "var(--dsw-alias-label-primary)",
				fontSize: "13px",
			},
			/** 头部：标题在左，操作按钮在右。 */
			panelHead: { display: "flex", alignItems: "center", gap: "6px", flex: "none", padding: "12px 14px 10px" },
			/** 摘要行：贴在头部下方、**不参与滚动**，滚多远都能看见总数。 */
			panelMeta: {
				flex: "none",
				padding: "0 14px 10px",
				color: "var(--dsw-alias-label-tertiary)",
				fontSize: "12px",
				lineHeight: "18px",
				fontVariantNumeric: "tabular-nums",
			},
			/** 内容区：唯一可滚动的部分。 */
			panelBody: { flex: "1 1 auto", minHeight: "0", overflowY: "auto", overflowX: "hidden", padding: "0 14px 6px" },
			card: {
				boxSizing: "border-box",
				padding: "12px",
				borderRadius: "10px",
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-bg-module-platform)",
				color: "var(--dsw-alias-label-primary)",
				fontSize: "13px",
			},
			/** 卡片布局的滚动上限（同 client.js；layout 是 HubPanel 的 prop，S 够不着）。 */
			cardScroll: { maxHeight: "560px", overflowY: "auto" },
			/** 一条渠道。行间靠 borderTop 分隔，第一行由 rowFirst 去掉顶线。 */
			row: { display: "flex", flexDirection: "column", gap: "6px", padding: "10px 0", borderTop: "1px solid var(--dsw-alias-border-l2)" },
			rowFirst: { borderTop: "none", paddingTop: "2px" },
			rowHead: { display: "flex", alignItems: "center", gap: "8px", minHeight: "24px" },
			/** 第二行：额度 / 重置时间 / 模型数。允许换行，窄窗口不挤成一条。 */
			rowSub: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
			name: { fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
			account: { color: "var(--dsw-alias-label-tertiary)", fontVariantNumeric: "tabular-nums" },
			spacer: { marginLeft: "auto" },
			quota: { color: "var(--dsw-alias-label-secondary)", fontVariantNumeric: "tabular-nums" },
			muted: { color: "var(--dsw-alias-label-tertiary)", fontSize: "12px" },
			/**
			 * 说明块：整块浅底 + 内边距。用于"这一页是干什么的"（认证页顶部）——
			 * 一行灰字压不住导语的分量，看起来会像注释而不是说明。
			 */
			hint: {
				padding: "8px 10px",
				borderRadius: "8px",
				background: "var(--dsw-alias-bg-module-platform, rgba(127,127,127,.08))",
				color: "var(--dsw-alias-label-tertiary)",
				fontSize: "12px",
				lineHeight: "18px",
			},
			/** 单行省略：落点路径很长，别把行撑破。 */
			ellipsis: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			chip: {
				font: "inherit",
				fontSize: "12px",
				lineHeight: "20px",
				height: "22px",
				padding: "0 8px",
				borderRadius: "6px",
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "transparent",
				color: "var(--dsw-alias-label-secondary)",
				cursor: "pointer",
			},
			modelList: {
				display: "flex",
				flexDirection: "column",
				gap: "2px",
				maxHeight: "180px",
				overflowY: "auto",
				marginTop: "2px",
				paddingLeft: "10px",
				borderLeft: "2px solid var(--dsw-alias-border-l2)",
			},
			modelItem: { display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "12px", lineHeight: "20px" },
			modelName: { color: "var(--dsw-alias-label-secondary)" },
			modelId: { color: "var(--dsw-alias-label-tertiary)", fontVariantNumeric: "tabular-nums" },
			textarea: {
				flex: "1 1 auto",
				minWidth: "0",
				font: "inherit",
				fontSize: "12px",
				lineHeight: "16px",
				padding: "5px 8px",
				borderRadius: "6px",
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "transparent",
				color: "var(--dsw-alias-label-primary)",
				resize: "vertical",
			},
			bar: { height: "4px", borderRadius: "2px", background: "var(--dsw-alias-border-l2)", overflow: "hidden" },
			barFill: { height: "100%", background: "var(--dsw-alias-brand-primary)" },
			/** 行内次要按钮（签到 / 认证）。统一 26px 高，与 chip 形成两级尺寸。 */
			linkBtn: {
				font: "inherit",
				fontSize: "12px",
				lineHeight: "20px",
				minHeight: "26px",
				padding: "2px 12px",
				borderRadius: "6px",
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "transparent",
				color: "var(--dsw-alias-state-business-primary)",
				cursor: "pointer",
			},
			/** 主按钮：底部的"一键签到"。整行撑满，是这张弹窗唯一的强调动作。 */
			primaryBtn: {
				font: "inherit",
				fontSize: "13px",
				fontWeight: 600,
				lineHeight: "20px",
				minHeight: "32px",
				padding: "5px 14px",
				borderRadius: "8px",
				border: "none",
				background: "var(--dsw-alias-button-primary-fill)",
				color: "var(--dsw-alias-label-primary-foreground)",
				cursor: "pointer",
			},
			disabledBtn: { opacity: 0.55, cursor: "default" },
			/** 底部动作条：钉在弹窗底部，不随内容滚动。 */
			footer: {
				display: "flex",
				alignItems: "center",
				gap: "8px",
				flexWrap: "wrap",
				flex: "none",
				padding: "10px 14px 12px",
				borderTop: "1px solid var(--dsw-alias-border-l2)",
			},
			title: { fontWeight: 600, fontSize: "14px", lineHeight: "20px", marginRight: "auto" },
		};

		const TONE = {
			ok: "var(--dsw-alias-state-success-primary)",
			warn: "var(--dsw-alias-state-warning-primary)",
			error: "var(--dsw-alias-state-error-primary)",
			action: "var(--dsw-alias-state-business-primary)",
			muted: "var(--dsw-alias-label-tertiary)",
		};

		const DOT = { signed: "#2ea043", warn: "#d29922", off: "#8b949e" };

		//#endregion

		//#region 工具

		/**
		 * 文案函数兜底：locale 未绑定时 `ctx.locale.bind()` 拿到的可能不是函数，
		 * 取不到就回落到 key。绝不让"翻不出文案"升级成"渲染期抛错"。
		 */
		function safeT(t) {
			return (key, vars) => {
				try {
					const value = typeof t === "function" ? t(key, vars) : undefined;
					return typeof value === "string" && value !== "" ? value : key;
				} catch {
					return key;
				}
			};
		}

		/** 后端契约的最小校验；形状不对就当没读到，绝不把半成品放进 state。 */
		function isStatusDocument(value) {
			return (
				typeof value === "object" &&
				value !== null &&
				Array.isArray(value.channels) &&
				typeof value.summary === "object" &&
				value.summary !== null
			);
		}

		function stateDot(row) {
			if (row.state === "signed-in") {
				if (row.checkin !== undefined && row.checkin.state === "claimable") return DOT.warn;
				return DOT.signed;
			}
			return DOT.off;
		}

		/** 把一条签到结果并回它所在的行（只改 checkin，不动额度）。 */
		function mergeClaim(rows, result) {
			return rows.map((row) =>
				row.id === result.id
					? {
							...row,
							checkin: {
								state: result.state,
								...(result.note === undefined ? {} : { note: result.note }),
								...(result.campaignUrl === undefined ? {} : { campaignUrl: result.campaignUrl }),
							},
						}
					: row,
			);
		}

		//#endregion

		//#region 数据

		/**
		 * 状态拉取。
		 *
		 * `live` 为 true（弹窗打开）时定时刷新；关着时只在挂载/焦点/可见性变化时拉一次 ——
		 * 一次状态请求会在宿主侧扇出 5 个渠道，其中 4 个要打上游额度接口，不能当装饰随便轮询。
		 *
		 * ⚠️ `live` **只管刷新节奏**，不再决定要不要自动签到：所有调用点一律带 `auto=1`，
		 * 是否真的领取由宿主的 `autoCheckin` 偏好门控。原因见下面 `load()` 里那段注释。
		 */
		function useHubStatus(live) {
			const [status, setStatus] = react.useState(undefined);
			const [loadedAt, setLoadedAt] = react.useState(0);
			const loadRef = react.useRef(undefined);

			react.useEffect(() => {
				let alive = true;
				let lastAt = 0;
				const controller = new AbortController();
				const load = async (force) => {
					if (!force) {
						if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
						if (Date.now() - lastAt < MIN_GAP_MS) return;
					}
					lastAt = Date.now();
					try {
						/**
						 * **一律带 `auto=1`**，由宿主按 `autoCheckin` 偏好决定要不要顺带领取
						 * （见 panel.js 的 `HUB_STATUS_ROUTE`）——客户端这边不分叉。
						 *
						 * ## 为什么这里不能分叉（2026-09-27 用户报障）
						 *
						 * 曾经：只有弹窗那份（`live === true`）带 auto，角标那份不带，
						 * 于是**角标恒显示「可签 2」，而同一时刻弹窗里显示「已签」** ——
						 * 侧栏和面板互相矛盾，用户看到的就是"角标显示不准"。
						 *
						 * 根因是 **workbuddy 的「今天签没签」没有任何只读来源**：
						 * 它的签到看板（`POST /v2/billing/meter/checkin-status`）在活动未开放时
						 * 整份都是默认值，实测**当天已签到也依然如此** ——
						 * 上游返回 `{active:false, today_checked_in:false, streak_days:0,
						 * week_progress:[false×7], total_credits:0, theme_name:"", season:0}`，
						 * 而同一账号 `daily-checkin`（幂等 POST）明确回
						 * `10001 / "今天已签到，请明天再来"`。
						 * ⇒ 只读路径**在原理上**判不出来，只能猜；猜出来的 `claimable`
						 * 不是"可签"，是"不知道"。既然唯一可靠来源是 POST，那条路就
						 * 必须能发 POST，而不能只在弹窗里发。
						 *
						 * 两条路同源之后两种偏好下都自洽：
						 * - `autoCheckin` 开着（默认）：都自动签、都拿真实状态 ⇒ 角标 = 面板；
						 * - 关掉：都不签、都显示提示性的「可签」⇒ 也一致。
						 *
						 * `live` 只再控制**轮询节奏**（面板开着才定时刷新），不再影响是否自动签到。
						 */
						const response = await fetch(`${STATUS_PATH}?auto=1`, {
							credentials: "same-origin",
							headers: { accept: "application/json" },
							signal: controller.signal,
						});
						if (!response.ok) return;
						const value = await response.json().catch(() => undefined);
						if (alive && !controller.signal.aborted && isStatusDocument(value)) {
							setStatus(value);
							setLoadedAt(Date.now());
						}
					} catch {
						/* 只读装饰：失败静默，绝不影响输入框 */
					}
				};
				loadRef.current = load;
				void load(true);
				const onFocus = () => void load(false);
				const onVisibility = () => {
					if (document.visibilityState === "visible") void load(false);
				};
				window.addEventListener("focus", onFocus);
				document.addEventListener("visibilitychange", onVisibility);
				let timer;
				if (live === true) timer = window.setInterval(() => void load(false), OPEN_REFRESH_MS);
				return () => {
					alive = false;
					controller.abort();
					if (timer !== undefined) window.clearInterval(timer);
					window.removeEventListener("focus", onFocus);
					document.removeEventListener("visibilitychange", onVisibility);
					loadRef.current = undefined;
				};
			}, [live]);

			const reload = react.useCallback(() => {
				const fn = loadRef.current;
				if (fn !== undefined) void fn(true);
			}, []);

			return { status, setStatus, loadedAt, reload };
		}

		//#endregion

		//#region 组件

		/** 小按钮的"激活"态：brand 色文字 + 同色边框。 */
		const ON = { color: "var(--dsw-alias-brand-primary, currentColor)", borderColor: "var(--dsw-alias-brand-primary, currentColor)" };

		/** 单条渠道行。 */
		function ChannelRow(props) {
			const { row, t, busy, onCheckin, onToggleModel, onToggleAll, busyAll, first } = props;
			const checkin = row.checkin === undefined ? { state: "unknown" } : row.checkin;
			const meta = CHECKIN_STATES[checkin.state] ?? CHECKIN_STATES.unknown;
			const credits = row.credits;

			/** 模型清单及其禁用状态（勾选 = 在模型选择器里显示）。 */
			const models = Array.isArray(row.models) ? row.models : [];
			const disabledCount = models.filter((model) => model.disabled === true).length;
			const [showModels, setShowModels] = react.useState(false);
			const [busyModel, setBusyModel] = react.useState(undefined);
			const toggleModel = async (model) => {
				if (busyModel !== undefined) return;
				setBusyModel(model.id);
				try {
					await onToggleModel(row, model.id, model.disabled !== true);
				} finally {
					setBusyModel(undefined);
				}
			};

			const right =
				meta.tone === "action" || meta.tone === "error" ? (
					react.createElement(
						"button",
						{
							key: "act",
							type: "button",
							style: { ...S.linkBtn, ...(busy === true ? S.disabledBtn : {}) },
							disabled: busy === true,
							title: t(meta.key),
							onClick: () => onCheckin(row),
						},
						busy === true ? t("checkinBusy") : t(meta.key),
					)
				) : checkin.campaignUrl !== undefined ? (
					react.createElement(
						"a",
						{
							key: "act",
							href: checkin.campaignUrl,
							target: "_blank",
							rel: "noreferrer",
							style: { ...S.linkBtn, textDecoration: "none", color: TONE[meta.tone] },
							title: checkin.note === undefined ? t(meta.key) : checkin.note,
						},
						t(meta.key),
					)
				) : (
					react.createElement(
						"span",
						{
							key: "act",
							/**
							 * 不支持做成**虚边标签**而不是一行灰字：它和"已签/未知"不是一类东西
							 * —— 那两个是状态，这个是"这个渠道压根没有这个动作"，需要一眼看出
							 * 是"有意如此"而不是"没渲染出来"。虚线边框是"不可操作"的通用暗示。
							 */
							style:
								checkin.state === "unsupported"
									? { ...S.chip, cursor: "default", color: TONE[meta.tone], borderStyle: "dashed" }
									: { color: TONE[meta.tone], fontSize: "12px" },
							title: checkin.note,
						},
						t(meta.key),
					)
				);

			const quotaText =
				credits === undefined
					? row.creditsError !== undefined
						? t("creditsUnavailable")
						: row.state === "signed-out"
							? t("signedOut")
							: "—"
					: credits.label !== undefined
						? `${t("creditsLabel")} ${credits.label}`
						: t("creditsUnknown");

			const sub =
				row.state === "signed-in"
					? [
							react.createElement("span", { key: "q", style: S.quota }, quotaText),
							credits !== undefined && typeof credits.resetAt === "string"
								? react.createElement("span", { key: "r", style: S.muted }, t("resetAt", { time: credits.resetAt }))
								: null,
							// 个人版的额度是几十个"裂变包"加起来的，点明包数免得这个数字显得来历不明。
							credits !== undefined && typeof credits.packages === "number"
								? react.createElement(
										"span",
										{ key: "pk", style: S.muted },
										t("creditsPackages", { count: String(credits.packages) }),
									)
								: null,
							models.length > 0
								? react.createElement(
										"button",
										{
											key: "m",
											type: "button",
											/**
											 * 有模型被隐藏时换成警示色。
											 *
											 * "模型选择器里没有模型"最常见的成因就是这里的隐藏名单被写满了，
											 * 而它原来和普通 chip 长得一模一样，很容易被当成装饰忽略掉。
											 */
											style: disabledCount === 0 ? S.chip : { ...S.chip, color: TONE.warn, borderColor: TONE.warn },
											title: t("modelsHint"),
											onClick: () => setShowModels((value) => !value),
										},
										disabledCount === 0
											? t("models", { count: String(models.length) })
											: t("modelsWithDisabled", { count: String(models.length), disabled: String(disabledCount) }),
									)
								: row.modelCount !== undefined
									? react.createElement("span", { key: "m", style: S.muted }, t("models", { count: String(row.modelCount) }))
									: null,
						].filter(Boolean)
					: [
							react.createElement(
								"span",
								{ key: "e", style: S.muted },
								row.state === "signed-out"
									? `${t("signedOut")} · ${row.credentialHint ?? ""}`
									: row.error ?? t("unavailable"),
							),
						];

			return react.createElement(
				"div",
				{ style: first === true ? { ...S.row, ...S.rowFirst } : S.row },
				react.createElement(
					"div",
					{ style: S.rowHead },
					react.createElement("span", {
						style: {
							width: "8px",
							height: "8px",
							borderRadius: "50%",
							// 被禁用的渠道连状态点都该是灰的 —— 它已经不参与任何动作了
							background: row.disabled === true ? DOT.off : stateDot(row),
							flex: "none",
						},
					}),
					react.createElement("span", { style: S.name }, row.displayName),
					row.disabled === true
						? react.createElement(
								"span",
								{
									style: { ...S.chip, cursor: "default", color: TONE.muted, borderStyle: "dashed" },
									title: t("authDeleteWarn"),
								},
								t("channelDisabled"),
							)
						: null,
					row.account === undefined ? null : react.createElement("span", { style: S.account }, row.account),
					react.createElement("span", { style: S.spacer }),
					right,
				),
				react.createElement("div", { style: S.rowSub }, ...sub),
				credits !== undefined && typeof credits.progress === "number"
					? react.createElement(
							"div",
							{ style: S.bar },
							react.createElement("div", {
								style: { ...S.barFill, width: `${Math.max(0, Math.min(1, credits.progress)) * 100}%` },
							}),
						)
					: null,
				// —— 模型配置：勾选 = 在模型选择器里显示；取消勾选即"禁用" ——
				showModels && models.length > 0
					? react.createElement(
							"div",
							{ style: S.modelList },
							react.createElement(
							"div",
							{ key: "cap", style: { ...S.modelItem, justifyContent: "space-between", cursor: "default" } },
							react.createElement("span", { style: S.muted }, t("modelsCaption")),
							react.createElement(
								"span",
								{ style: { display: "inline-flex", gap: "6px", flex: "none" } },
								react.createElement(
									"button",
									{ type: "button", style: { ...S.chip, ...(busyAll === true ? S.disabledBtn : {}) }, disabled: busyAll === true, onClick: () => onToggleAll(row, false) },
									t("modelsAllOn"),
								),
								react.createElement(
									"button",
									{
										type: "button",
										style: { ...S.chip, ...(busyAll === true ? S.disabledBtn : {}) },
										disabled: busyAll === true,
										title: t("modelsAllOffHint"),
										onClick: () => onToggleAll(row, true),
									},
									t("modelsAllOff"),
								),
							),
						),
							...models.map((model) =>
								react.createElement(
									"label",
									{ key: model.id, style: S.modelItem, title: model.id },
									react.createElement("input", {
										type: "checkbox",
										checked: model.disabled !== true,
										disabled: busyModel !== undefined,
										onChange: () => void toggleModel(model),
									}),
									react.createElement("span", { style: S.modelName }, model.name),
									/**
									 * 倍率（消耗乘数）。
									 *
									 * 宿主早就把它放进 `models[].rate` 了（workbuddy 形如 `x0.79`、
									 * qoder 形如 `0.5×`），但客户端一直没渲染 —— 所以面板里从来
									 * 看不到倍率，容易让人以为"没取到"。这里补上；没这个字段的
									 * 渠道（如 trae，上游本地缓存里就没有）就不显示，不占位。
									 */
									typeof model.rate === "string" && model.rate !== ""
										? react.createElement("span", { style: { ...S.muted, flex: "none" } }, model.rate)
										: null,
									react.createElement("span", { style: S.modelId }, model.id),
								),
							),
						)
					: null,
			);
		}

		/** 偏好区（弹窗底部 / 卡片底部共用）。 */
		function Preferences(props) {
			const { prefs, t, onPatch, busy } = props;
			const box = (key, labelKey) =>
				react.createElement(
					"label",
					{ key, style: { display: "inline-flex", alignItems: "center", gap: "6px", cursor: "pointer" } },
					react.createElement("input", {
						type: "checkbox",
						checked: prefs[key] === true,
						disabled: busy === true,
						onChange: (event) => onPatch({ [key]: event.target.checked }),
					}),
					react.createElement("span", null, t(labelKey)),
				);
			return react.createElement(
				"div",
				{ style: { display: "flex", gap: "16px", flexWrap: "wrap", paddingTop: "8px" } },
				box("autoCheckin", "prefAutoCheckin"),
				box("showDockButton", "prefShowDock"),
			);
		}

		/** 面板主体：渠道列表 + 汇总 + 一键签到 + 偏好。 */
		/**
		 * 认证区：各渠道的凭据落点 + 粘贴框。
		 *
		 * 安全约定：**密钥只写文件（0600），不回显、不进 settings.json**。
		 * 页面只拿得到"落点路径 + 当前登录状态"，读不回密钥内容。
		 */
		/**
		 * 认证页里的一行。
		 *
		 * **默认折叠**：只露"是谁 / 登没登 / 落点在哪 / 一个[粘贴]按钮"。
		 * 以前五行各自常驻一个 textarea，一屏塞不下、必须整体滚动 —— 而绝大多数时间
		 * 用户只是想看"哪个渠道掉了"，并不需要看到输入框。
		 *
		 * 折叠起来还有个副作用好处：长文本粘贴框只在需要时才占据滚动高度，
		 * 滚轮就不会在"到底该滚谁"上打结。
		 */
		function AuthRow(props) {
			const { row, t, draft, note, busy, onChange, onSave, onAction, onScan, renameDraft, onRenameChange, renaming, onRenameToggle, onRenameCommit } = props;
			const [open, setOpen] = react.useState(false);
			/**
			 * 删除分两步：先变"确认删除"，再点才真删。
			 * 不用 `window.confirm` —— 在 DSH 的 webview 里它未必弹出，而"点两次"在哪都可靠。
			 */
			const [confirming, setConfirming] = react.useState(false);
			const signedIn = row.state === "signed-in";
			const configured = row.configured === true;
			const disabled = row.disabled === true;
			const canWrite = row.writable === true;
			/**
			 * 这个渠道的**扫码**能不能用。
			 *
			 * `workbuddyLoginPath` 只说明"它属于哪一类渠道"，不代表这个槽位已经在跑：
			 * `WORKBUDDY_VARIANTS` 是**模块加载时**按注册表生成的，而面板的行来自
			 * `connect-channels.json`（每读一次都是最新的）—— 所以**刚新增的槽位会立刻
			 * 出现在认证页，但它的 `<n>/status`、`<n>/login` 全都不存在**，
			 * 点扫码只会拿到宿主返回的 405「失败：HTTP 405」（实测踩到）。
			 *
			 * 判据用 `state === "unavailable"`：那是 hub 扇出到该渠道 status 路由失败时
			 * 的取值 —— 对空闲槽位来说，它的唯一含义就是"provider 侧还没装载"。
			 * 已配置的渠道若临时问不到也是这个值，禁用同样合理（重启是共同的第一步）。
			 */
			const scanPath = workbuddyLoginPath(row.id);
			const scanReady = scanPath !== undefined && row.state !== "unavailable";
			const path = row.targetPath === null || row.targetPath === undefined ? row.source ?? "" : row.targetPath;
			return react.createElement(
				"div",
				{ style: S.row },
				react.createElement(
					"div",
					{ style: S.rowHead },
					react.createElement("span", {
						style: { width: "8px", height: "8px", borderRadius: "50%", background: signedIn ? DOT.signed : DOT.off, flex: "none" },
					}),
					react.createElement("span", { style: S.name }, renaming === true ? "" : row.displayName),
					// 改名：点「改名」就地展开输入框，确认提交（op=update）。
					renaming === true
						? react.createElement(
								"span",
								{ style: { display: "inline-flex", gap: "4px", flex: "1 1 auto", minWidth: "0" } },
								react.createElement("input", {
									value: renameDraft,
									style: { ...S.chip, flex: "1 1 auto", minWidth: "0" },
									autoFocus: true,
									onChange: (event) => onRenameChange(event.target.value),
									onKeyDown: (event) => {
										if (event.key === "Enter") onRenameCommit();
										if (event.key === "Escape") onRenameToggle();
									},
								}),
								react.createElement(
									"button",
									{
										type: "button",
										style: { ...S.chip, ...(renameDraft.trim() === "" ? S.disabledBtn : {}) },
										disabled: renameDraft.trim() === "" || busy === true,
										onClick: onRenameCommit,
									},
									t("authRenameOk"),
								),
								react.createElement(
									"button",
									{ type: "button", style: S.chip, onClick: onRenameToggle },
									t("authCancel"),
								),
							)
						: react.createElement("span", { style: S.spacer }),
					renaming === true
						? null
						: react.createElement(
								"button",
								{ type: "button", style: S.chip, onClick: onRenameToggle, title: t("authRename") },
								t("authRename"),
							),
					react.createElement(
						"span",
						{ style: { ...S.muted, color: disabled ? TONE.muted : signedIn ? TONE.ok : TONE.muted } },
						configured
							? disabled
								? t("channelDisabled")
								: signedIn
									? t("authSignedIn")
									: t("authSignedOut")
							: t("authIdle"),
					),
					canWrite
						? react.createElement(
								"button",
								{ type: "button", style: { ...S.chip, ...(open ? ON : {}) }, onClick: () => setOpen((value) => !value) },
								open ? t("authCollapse") : configured ? t("authPaste") : t("authAdd"),
							)
						: null,
					/**
					 * 扫码登录：只有 workbuddy 有这个协议（见 {@link workbuddyLoginPath}）。
					 *
					 * **不看 `canWrite`**：扫码写的是插件**自己的副本**
					 * （`$DSH_HOME/.<渠道 id>-auth.json`），与 `[粘贴]` 写的那个"落点"
					 * 是两份文件。所以即便落点不可知（`authNoTarget`），扫码依然有用；
					 * 空闲槽位也照扫 —— 这正是"把另一个号加进来"的做法。
					 *
					 * 但**要看这个槽位装载了没有**（`scanReady`）：没装载时按钮置灰并说明
					 * 原因，而不是留一个点了必然 405 的按钮。
					 */
					scanPath === undefined
						? null
						: scanReady
							? react.createElement(
									"button",
									{ type: "button", style: S.chip, onClick: () => onScan(row), title: t("scanTitle") },
									t("scanAction"),
								)
							: react.createElement(
									"button",
									{ type: "button", style: { ...S.chip, ...S.disabledBtn }, disabled: true, title: t("scanNeedsRestart") },
									t("scanAction"),
								),
					// 禁用 / 启用：只对已配置的槽位有意义
					configured
						? react.createElement(
								"button",
								{ type: "button", style: S.chip, onClick: () => onAction(disabled ? "enable" : "disable", row) },
								disabled ? t("channelEnable") : t("channelDisable"),
							)
						: null,
					// 空槽位同样支持删除注册表条目。
					react.createElement(
								"button",
								{
									type: "button",
									style: { ...S.chip, ...(confirming ? { color: TONE.error, borderColor: TONE.error } : {}) },
									title: t("authDeleteWarn"),
									onClick: () => {
										if (!confirming) {
											setConfirming(true);
											return;
										}
										setConfirming(false);
										onAction("delete", row);
									},
								},
								confirming ? t("authConfirmDelete") : t("authDelete"),
							),
				),
				react.createElement(
					"div",
					{ style: { ...S.muted, ...S.ellipsis }, title: path },
					configured ? path : t("authSlotHint"),
				),
				canWrite ? null : react.createElement("div", { style: { ...S.muted, color: TONE.warn } }, t("authNoTarget")),
				scanPath !== undefined && !scanReady
					? react.createElement("div", { style: { ...S.muted, color: TONE.warn } }, t("scanNeedsRestart"))
					: null,
				open && canWrite
					? react.createElement(
							"div",
							{ style: { display: "flex", gap: "6px", alignItems: "flex-start" } },
							react.createElement("textarea", {
								value: draft,
								placeholder: row.hint ?? "",
								rows: 3,
								style: S.textarea,
								onChange: (event) => onChange(event.target.value),
							}),
							react.createElement(
								"button",
								{
									type: "button",
									style: { ...S.chip, flex: "none", ...(busy || draft.trim() === "" ? S.disabledBtn : {}) },
									disabled: busy === true || draft.trim() === "",
									onClick: onSave,
								},
								busy === true ? t("authSaving") : t("authSave"),
							),
						)
					: null,
				note === undefined ? null : react.createElement("div", { style: S.muted }, note),
			);
		}

		/**
		 * 扫码登录弹窗。
		 *
		 * 这个组件**不碰凭据**：授权链接由宿主侧的 `<n>/login/start` 下发，
		 * 结果由 `<n>/login/poll` 报回来 —— 那条路只回 uid / 昵称，**永不回传令牌**。
		 * 所以就算这段渲染被别的脚本读到，也拿不到任何凭据。
		 *
		 * 授权链接是腾讯的登录页，**页面自带二维码**（也支持手机号 + 短信验证码），
		 * 因此这里不做二维码编码 —— 「打开 / 复制」两个动作就够。
		 *
		 * 轮的节奏与生命周期：只在 `waiting` 时轮询，2 秒一次；弹窗关掉即停
		 * （effect 清理）。**过期由宿主侧判**（腾讯那边 waiting 与"码不存在"回包一模一样），
		 * 这里只如实转述。
		 */
		function ScanDialog(props) {
			const { t, row, onClose, onSignedIn } = props;
			const loginPath = workbuddyLoginPath(row.id);
			/** starting → waiting → signed-in / blocked / failed / expired */
			const [phase, setPhase] = react.useState("starting");
			const [authUrl, setAuthUrl] = react.useState("");
			const [note, setNote] = react.useState("");
			const [copied, setCopied] = react.useState(false);
			/** 重试计数：自增即重跑"取链接"那个 effect。 */
			const [attempt, setAttempt] = react.useState(0);
			/**
			 * 放进 ref 的值不参与渲染：轮询回调必须读**最新**的 phase/state，
			* 否则一次 setInterval 里会拿着关闭前的旧值继续写状态。
			 * `onSignedIn` 同理走 ref —— 父组件传的是内联函数，进依赖数组会让
			 * interval 每次渲染都被重建。
			 */
			const phaseRef = react.useRef(phase);
			const stateRef = react.useRef("");
			const signedInRef = react.useRef(onSignedIn);
			signedInRef.current = onSignedIn;

			const settle = (next, why) => {
				phaseRef.current = next;
				setPhase(next);
				if (why !== undefined && why !== "") setNote(why);
			};

			react.useEffect(() => {
				let cancelled = false;
				phaseRef.current = "starting";
				setPhase("starting");
				setNote("");
				setCopied(false);
				setAuthUrl("");
				stateRef.current = "";
				(async () => {
					try {
						const response = await fetch(`${loginPath}/start`, {
							method: "POST",
							credentials: "same-origin",
							headers: { accept: "application/json" },
						});
						const body = await response.json().catch(() => undefined);
						if (cancelled) return;
						if (response.ok !== true || body?.ok !== true || typeof body.authUrl !== "string") {
							/**
							 * 404/405 不是"上游拒绝"，而是**这个槽位根本没装载** ——
							 * 它的 `<n>/login` 路由压根没注册，响应来自宿主的兜底处理。
							 * 直接把 405 抛给用户看不懂，所以换成能照做的说明。
							 */
							settle("failed", response.status === 404 || response.status === 405 ? t("scanNeedsRestart") : body?.error ?? `HTTP ${response.status}`);
							return;
						}
						stateRef.current = String(body.state ?? "");
						setAuthUrl(body.authUrl);
						settle("waiting");
					} catch (error) {
						if (!cancelled) settle("failed", String(error));
					}
				})();
				return () => {
					cancelled = true;
				};
			}, [loginPath, attempt]);

			react.useEffect(() => {
				if (phase !== "waiting") return undefined;
				const timer = setInterval(async () => {
					if (phaseRef.current !== "waiting") return;
					try {
						const response = await fetch(
							`${loginPath}/poll?state=${encodeURIComponent(stateRef.current)}`,
							{ credentials: "same-origin", headers: { accept: "application/json" } },
						);
						const body = await response.json().catch(() => undefined);
						// 等回包的这几百毫秒里弹窗可能已被关掉 —— 关掉就什么都不写。
						if (phaseRef.current !== "waiting") return;
						const status = body?.status;
						if (status === "signed-in") {
							/**
							 * 换了人时把"替换了谁"如实说出来：原凭据文件**没有被删**，
							 * 所以这是可逆的 —— 不说的话用户会以为旧账号被覆盖掉了。
							 */
							const replaced = body?.replaced;
							settle("signed-in", replaced === undefined ? undefined : t("scanReplaced").replace("{uid}", String(replaced.uid ?? "").slice(0, 8)));
							signedInRef.current?.();
							return;
						}
						if (status === "blocked") {
							settle("blocked", body?.reason ?? body?.error ?? "");
							return;
						}
						if (status === "failed") {
							settle("failed", body?.error ?? "");
							return;
						}
						if (status === "expired" || status === "unknown") {
							settle("expired");
							return;
						}
						if (response.ok !== true) settle("failed", response.status === 404 || response.status === 405 ? t("scanNeedsRestart") : body?.error ?? `HTTP ${response.status}`);
					} catch {
						/* 网络抖动：下一轮再来，不把它当失败 —— 一次抖动不该终止一次登录 */
					}
				}, 2000);
				return () => clearInterval(timer);
			}, [phase, loginPath]);

			const openUrl = () => {
				try {
					window.open(authUrl, "_blank", "noopener,noreferrer");
				} catch {
					/* 弹窗被拦：下面还有"复制"，用户可手动打开 */
				}
			};
			const copyUrl = async () => {
				try {
					await navigator.clipboard.writeText(authUrl);
					setCopied(true);
				} catch {
					setCopied(false);
				}
			};

			const statusText =
				phase === "starting"
					? t("scanStarting")
					: phase === "waiting"
						? t("scanWaiting")
						: phase === "signed-in"
							? `${t("scanSignedIn")}${note === "" ? "" : ` — ${note}`}`
							: phase === "blocked"
								? `${t("scanBlocked")}${note === "" ? "" : `：${note}`}`
								: phase === "expired"
									? t("scanExpired")
									: `${t("scanFailed")}${note === "" ? "" : `：${note}`}`;
			const statusTone = phase === "signed-in" ? TONE.ok : phase === "failed" || phase === "blocked" ? TONE.error : phase === "expired" ? TONE.warn : TONE.muted;

			return reactDom.createPortal(
				react.createElement(
					react.Fragment,
					null,
					react.createElement("div", { style: S.scrim, onClick: onClose }),
					react.createElement(
						"div",
						{
							style: {
								...S.popover,
								left: "50%",
								top: "50%",
								transform: "translate(-50%, -50%)",
								maxHeight: "min(70vh, 560px)",
							},
						},
						react.createElement(
							"div",
							{ style: S.panelHead },
							react.createElement("strong", null, `${t("scanTitle")} · ${row.displayName}`),
							react.createElement("span", { style: S.spacer }),
							react.createElement("button", { type: "button", style: S.chip, onClick: onClose }, t("authCancel")),
						),
						react.createElement(
							"div",
							{ style: { ...S.panelBody, display: "flex", flexDirection: "column", gap: "8px" } },
							react.createElement("div", { style: S.muted }, t("scanHint")),
							authUrl === ""
								? null
								: react.createElement(
										"div",
										{
											style: {
												...S.card,
												fontFamily: "var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, monospace)",
												fontSize: "12px",
												wordBreak: "break-all",
												userSelect: "all",
												maxHeight: "96px",
												overflowY: "auto",
											},
										},
										authUrl,
									),
							authUrl === ""
								? null
								: react.createElement(
										"div",
										{ style: { display: "flex", gap: "6px", flexWrap: "wrap" } },
										react.createElement("button", { type: "button", style: S.chip, onClick: openUrl }, t("scanOpen")),
										react.createElement("button", { type: "button", style: S.chip, onClick: () => void copyUrl() }, copied ? t("scanCopied") : t("scanCopy")),
									),
							react.createElement("div", { style: { color: statusTone } }, statusText),
							phase === "waiting"
								? react.createElement("div", { style: S.muted }, t("scanKeepOpen"))
								: null,
							phase === "failed" || phase === "blocked" || phase === "expired"
								? react.createElement(
										"div",
										{ style: { display: "flex", gap: "6px" } },
										react.createElement(
											"button",
											{ type: "button", style: S.chip, onClick: () => setAttempt((value) => value + 1) },
											t("scanRetry"),
										),
									)
								: null,
						),
					),
				),
				document.body,
			);
		}

		/** 认证区主体：拉 /auth，逐渠道一行。 */
		function AuthSection(props) {
			const { t } = props;
			const [rows, setRows] = react.useState(undefined);
			const [drafts, setDrafts] = react.useState({});
			const [notes, setNotes] = react.useState({});
			const [busy, setBusy] = react.useState(undefined);
			/** 添加渠道表单（受控）：kind / id / displayName。 */
			const [adding, setAdding] = react.useState(false);
			const [nextSlot, setNextSlot] = react.useState(undefined);
			const [newKind, setNewKind] = react.useState("workbuddy");
			const [newId, setNewId] = react.useState("");
			const [newName, setNewName] = react.useState("");
			const [formNote, setFormNote] = react.useState(undefined);
			/** 行内改名的草稿：channelId → 输入值。 */
			const [renames, setRenames] = react.useState({});
			const [renaming, setRenaming] = react.useState(undefined);
			/**
			 * 正在扫码的那一行（`undefined` = 没开弹窗）。
			 *
			 * 状态放在这里而不是 AuthRow 里：弹窗要 portal 到 `document.body`，
			 * 而且同一时刻只该有一个 —— 每行各自持有一个弹窗的话，
			 * 用户点两行就会叠出两个在同时轮询同一份会话表。
			 */
			const [scanning, setScanning] = react.useState(undefined);

			const load = react.useCallback(async () => {
				try {
					const response = await fetch(AUTH_PATH, { credentials: "same-origin", headers: { accept: "application/json" } });
					const body = await response.json().catch(() => undefined);
					if (body !== undefined && Array.isArray(body.channels)) {
						setRows(body.channels);
						if (typeof body.nextWorkbuddySlot === "number") setNextSlot(body.nextWorkbuddySlot);
					}
				} catch {
					/* 只读装饰：失败静默 */
				}
			}, []);
			react.useEffect(() => {
				void load();
			}, [load]);

			const save = async (row, secret) => {
				setBusy(row.id);
				try {
					const response = await fetch(AUTH_PATH, {
						method: "POST",
						credentials: "same-origin",
						headers: { accept: "application/json", "content-type": "application/json" },
						body: JSON.stringify({ channel: row.id, secret }),
					});
					const body = await response.json().catch(() => undefined);
					const message = response.ok
						? body?.note ?? t("authSaved")
						: body?.message ?? body?.error ?? `HTTP ${response.status}`;
					setNotes((prev) => ({ ...prev, [row.id]: message }));
					if (response.ok) {
						setDrafts((prev) => ({ ...prev, [row.id]: "" }));
						void load();
					}
				} catch (error) {
					setNotes((prev) => ({ ...prev, [row.id]: String(error) }));
				} finally {
					setBusy(undefined);
				}
			};

			/**
			 * 渠道管理动作：create / update / disable / enable / delete。
			 *
			 * 统一形状：`{ op, ...payload }`。disable / enable / delete 的 payload 是
			 * `{ channel: 渠道 id }`；create 是 `{ kind, id, displayName }`；
			 * update 是 `{ channel, displayName }`。
			 */
			const act = async (action, payload) => {
				const key =
					action === "create"
						? "__form"
						: action === "update"
							? `__rename:${payload.channel}`
							: payload.channel;
				setBusy(key);
				try {
					const response = await fetch(CHANNELS_PATH, {
						method: "POST",
						credentials: "same-origin",
						headers: { accept: "application/json", "content-type": "application/json" },
						// 字段名是 `op` 不是 `action`：`action` 被 DSH 当保留字段吃掉（详见宿主 panel.js 的说明）。
						body: JSON.stringify({ op: action, ...payload }),
					});
					const body = await response.json().catch(() => undefined);
					const message = response.ok
						? body?.note
						: body?.message ?? body?.error ?? `HTTP ${response.status}`;
					if (action === "create") {
						setFormNote(message);
						if (response.ok) {
							setAdding(false);
							setNewId("");
							setNewName("");
						}
					} else if (action === "update") {
						setNotes((prev) => ({ ...prev, [payload.channel]: message }));
						if (response.ok) setRenaming(undefined);
					} else {
						setNotes((prev) => ({ ...prev, [key]: response.ok ? undefined : message }));
					}
					void load();
				} catch (error) {
					if (action === "create") setFormNote(String(error));
					else setNotes((prev) => ({ ...prev, [key]: String(error) }));
				} finally {
					setBusy(undefined);
				}
			};

			if (rows === undefined) return react.createElement("div", { style: S.muted }, t("loading"));
			/**
			 * 分成两组：已配置的（能登录/粘贴/禁用/删除/改名）与空闲槽位（同样一套操作）。
			 *
			 * 分组是为了让"加渠道"这件事**看得见** —— 以前失败的地方不是缺功能，而是
			 * 空闲槽位根本不出现在界面上，用户不知道还能再加。
			 */
			const group = (title, list) =>
				list.length === 0
					? []
					: [
							react.createElement("div", { key: `h:${title}`, style: { ...S.muted, paddingTop: "6px" } }, title),
							...list.map((row) =>
								react.createElement(AuthRow, {
									key: row.id,
									row,
									t,
									draft: drafts[row.id] ?? "",
									note: notes[row.id],
									busy: busy === row.id || busy === `__rename:${row.id}`,
									onChange: (value) => setDrafts((prev) => ({ ...prev, [row.id]: value })),
									onSave: () => void save(row, drafts[row.id] ?? ""),
									onAction: (action, target) => void act(action, { channel: target.id }),
									onScan: (target) => setScanning(target),
									// 改名（update）：行内展开一个小输入框，确认后提交。
									renameDraft: renames[row.id] ?? row.displayName,
									onRenameChange: (value) => setRenames((prev) => ({ ...prev, [row.id]: value })),
									renaming: renaming === row.id,
									onRenameToggle: () => {
										if (renaming === row.id) {
											setRenaming(undefined);
											return;
										}
										setRenames((prev) => ({ ...prev, [row.id]: row.displayName }));
										setRenaming(row.id);
									},
									onRenameCommit: () => {
										const value = (renames[row.id] ?? "").trim();
										if (value === "" || value === row.displayName) {
											setRenaming(undefined);
											return;
										}
										void act("update", { channel: row.id, displayName: value });
									},
								}),
							),
						];

			/** 添加渠道表单：kind 下拉 + id 预填 + 显示名。 */
			const addForm =
				adding === false
					? react.createElement(
							"button",
							{ type: "button", style: { ...S.chip, alignSelf: "flex-start", marginTop: "4px" }, onClick: () => {
								setNewKind("workbuddy");
								setNewId(nextSlot === undefined ? "" : `workbuddy${nextSlot}`);
								setNewName("");
								setFormNote(undefined);
								setAdding(true);
							} },
							t("authAddChannel"),
						)
					: react.createElement(
							"div",
							{ style: { display: "flex", flexDirection: "column", gap: "6px", padding: "8px 10px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "8px" } },
							react.createElement(
								"label",
								{ style: { display: "flex", alignItems: "center", gap: "8px" } },
								react.createElement("span", { style: S.muted }, t("authFormKind")),
								react.createElement(
									"select",
									{
										value: newKind,
										style: S.chip,
										onChange: (event) => {
											const kind = event.target.value;
											setNewKind(kind);
											// trae / qoder 单例：id 钉死为 kind，用户不用填。
											if (kind === "workbuddy") setNewId(nextSlot === undefined ? "" : `workbuddy${nextSlot}`);
											else setNewId(kind);
										},
									},
									react.createElement("option", { value: "workbuddy" }, "WorkBuddy"),
									react.createElement("option", { value: "trae" }, "Trae"),
									react.createElement("option", { value: "qoder" }, "Qoder"),
								),
							),
							newKind === "workbuddy"
								? react.createElement(
										"label",
										{ style: { display: "flex", alignItems: "center", gap: "8px" } },
										react.createElement("span", { style: S.muted }, t("authFormId")),
										react.createElement("input", {
											value: newId,
											style: { ...S.chip, flex: "1 1 auto" },
											placeholder: "workbuddy4",
											onChange: (event) => setNewId(event.target.value.trim()),
										}),
									)
								: null,
							react.createElement(
								"label",
								{ style: { display: "flex", alignItems: "center", gap: "8px" } },
								react.createElement("span", { style: S.muted }, t("authFormName")),
								react.createElement("input", {
									value: newName,
									style: { ...S.chip, flex: "1 1 auto" },
									placeholder: newKind === "workbuddy" ? "WorkBuddy 账号 4" : newKind === "trae" ? "Trae" : "Qoder CN",
									onChange: (event) => setNewName(event.target.value),
								}),
							),
							react.createElement(
								"div",
								{ style: { display: "flex", gap: "6px" } },
								react.createElement(
									"button",
									{
										type: "button",
										style: { ...S.linkBtn, ...(newId === "" || busy === "__form" ? S.disabledBtn : {}) },
										disabled: newId === "" || busy === "__form",
										onClick: () => void act("create", { kind: newKind, id: newId, displayName: newName }),
									},
									busy === "__form" ? t("authSaving") : t("authCreate"),
								),
								react.createElement(
									"button",
									{ type: "button", style: S.chip, onClick: () => setAdding(false) },
									t("authCancel"),
								),
							),
							formNote === undefined
								? null
								: react.createElement("div", { style: { ...S.muted, whiteSpace: "pre-wrap" } }, formNote),
						);

			return react.createElement(
				"div",
				{ style: { display: "flex", flexDirection: "column", gap: "6px" } },
				react.createElement(
					"div",
					{ style: S.hint },
					react.createElement("div", null, t("authIntro")),
					react.createElement("div", { style: { marginTop: "4px" } }, t("authMigrate")),
				),
				...group(t("authSectionActive"), rows.filter((row) => row.configured === true)),
				...group(t("authSectionIdle"), rows.filter((row) => row.configured !== true)),
				addForm,
				/**
				 * 扫码弹窗挂在**认证区根部**（portal 到 body），不在那一行内部：
				 * 行本身会随列表重排/折叠，弹窗跟着行走就会闪。
				 *
				 * 登录成功后重新拉一次 `/auth` —— 状态点、落点、"已登录"文案都来自它。
				 * 渠道状态弹窗是另一套轮询（`useHubStatus`），它下次刷新时自然跟上。
				 */
				scanning === undefined
					? null
					: react.createElement(ScanDialog, {
							t,
							row: scanning,
							onClose: () => setScanning(undefined),
							onSignedIn: () => void load(),
						}),
			);
		}

		function HubPanel(props) {
			const { t, status, setStatus, reload, layout } = props;
			const [claim, setClaim] = react.useState("idle");
			const [busyId, setBusyId] = react.useState(undefined);
			const [note, setNote] = react.useState(undefined);
			const [patchBusy, setPatchBusy] = react.useState(false);
			const [busyAll, setBusyAll] = react.useState(undefined);
			/**
			 * 弹窗分两页：`channels`（渠道状态 + 一键签到）与 `auth`（认证）。
			 *
			 * 为什么不是"在同一页往下堆"：两者共用一条滚动流时，认证区一展开就把渠道行
			 * 顶下去、整页都得滚；而且滚轮落在 textarea 上还会被吃掉，手感就是"滚不动"。
			 * 拆成两页后各自独占滚动区，谁也不挤谁。
			 */
			const [view, setView] = react.useState("channels");

			const rows = status === undefined ? [] : status.channels;
			const summary = status === undefined ? undefined : status.summary;
			const prefs = status === undefined ? undefined : status.preferences;

			/** 一键签到：先落每行结果，再整体刷一次（顺带把新额度带回来）。 */
			const onCheckinAll = async () => {
				if (claim === "busy") return;
				setClaim("busy");
				setNote(undefined);
				try {
					const response = await fetch(CHECKIN_PATH, {
						method: "POST",
						credentials: "same-origin",
						headers: { accept: "application/json" },
					});
					const body = await response.json().catch(() => undefined);
					if (body === undefined || !Array.isArray(body.results)) {
						setClaim("failed");
						setNote(`HTTP ${response.status}`);
						return;
					}
					if (status !== undefined) {
						let next = status.channels;
						for (const result of body.results) next = mergeClaim(next, result);
						setStatus({ ...status, channels: next, summary: { ...status.summary } });
					}
					setClaim("done");
					reload();
				} catch (error) {
					setClaim("failed");
					setNote(error instanceof Error ? error.message : String(error));
				}
			};

			const onCheckinOne = async (row) => {
				if (busyId !== undefined) return;
				setBusyId(row.id);
				try {
					const response = await fetch(`${CHECKIN_PATH}/${encodeURIComponent(row.id)}`, {
						method: "POST",
						credentials: "same-origin",
						headers: { accept: "application/json" },
					});
					const body = await response.json().catch(() => undefined);
					if (body !== undefined && status !== undefined) {
						setStatus({ ...status, channels: mergeClaim(status.channels, body) });
					}
					reload();
				} catch {
					/* 单渠道失败：下一次刷新会自然纠正 */
				} finally {
					setBusyId(undefined);
				}
			};

			/** 全选 / 全不选：让宿主一次写完该渠道的所有模型条目。 */
			const onToggleAll = async (row, disabled) => {
				if (busyAll !== undefined) return;
				setBusyAll(row.id);
				try {
					const response = await fetch(MODELS_PATH, {
						method: "POST",
						credentials: "same-origin",
						headers: { accept: "application/json", "content-type": "application/json" },
						body: JSON.stringify({ channel: row.provider, all: true, disabled }),
					});
					if (!response.ok) return;
					if (status !== undefined) {
						setStatus({
							...status,
							channels: status.channels.map((channel) =>
								channel.id === row.id
									? { ...channel, models: (channel.models ?? []).map((model) => ({ ...model, disabled })) }
									: channel,
							),
						});
					}
				} catch {
					/* 写失败就不动 UI，用户重试即可 */
				} finally {
					setBusyAll(undefined);
				}
			};

			/** 勾选/取消一个模型：写回面板设置，并就地更新这一行（避免整份重拉）。 */
			const onToggleModel = async (row, modelId, disabled) => {
				try {
					const response = await fetch(MODELS_PATH, {
						method: "POST",
						credentials: "same-origin",
						headers: { accept: "application/json", "content-type": "application/json" },
						body: JSON.stringify({ channel: row.provider, model: modelId, disabled }),
					});
					if (!response.ok) return;
					if (status !== undefined) {
						setStatus({
							...status,
							channels: status.channels.map((channel) =>
								channel.id === row.id
									? {
											...channel,
											models: (channel.models ?? []).map((model) =>
												model.id === modelId ? { ...model, disabled } : model,
											),
										}
									: channel,
							),
						});
					}
				} catch {
					/* 写失败就不动 UI，用户重试即可 */
				}
			};

			const onPatch = async (patch) => {
				setPatchBusy(true);
				try {
					const response = await fetch(SETTINGS_PATH, {
						method: "POST",
						credentials: "same-origin",
						headers: { accept: "application/json", "content-type": "application/json" },
						body: JSON.stringify(patch),
					});
					const body = await response.json().catch(() => undefined);
					if (response.ok && body !== undefined && status !== undefined) {
						setStatus({ ...status, preferences: body });
					}
				} catch {
					/* 写失败就保持原值，用户重试即可 */
				} finally {
					setPatchBusy(false);
				}
			};

			const claimable = summary === undefined ? 0 : summary.claimable;
			const claimLabel =
				claim === "busy"
					? t("checkinAllBusy")
					: claimable === 0
						? t("checkinAllNone")
						: t("checkinAll", { count: String(claimable) });

			const summaryLine =
				summary === undefined
					? t("loading")
					: t("summaryLine", {
							signedIn: String(summary.signedIn),
							total: String(summary.total),
							done: String(summary.done),
							manual: String(summary.manual),
							// [dsh-connect 2026-09-27] 模板里有 {unsupported}，漏传会让汇总行
							// 原样显示出「不适用 {unsupported}」。
							unsupported: String(summary.unsupported),
						});

			const inAuth = view === "auth";
			const body = [
				// ① 头部（固定）：标题在左，动作在右。认证页里把它换成「返回」。
				react.createElement(
					"div",
					{ key: "head", style: S.panelHead },
					react.createElement("span", { style: S.title }, inAuth ? t("authTitle") : t("panelTitle")),
					inAuth
						? react.createElement(
								"button",
								{ key: "back", type: "button", style: S.linkBtn, onClick: () => setView("channels") },
								t("authBack"),
							)
						: react.createElement(
								"button",
								{ key: "auth", type: "button", style: S.linkBtn, onClick: () => setView("auth") },
								t("authTitle"),
							),
					react.createElement(
						"button",
						{
							key: "refresh",
							type: "button",
							style: S.linkBtn,
							onClick: () => reload(),
						},
						t("refresh"),
					),
				),
				// 摘要行只在渠道页有意义（认证页讲的是凭据，不是登录态汇总）。
				inAuth ? null : react.createElement("div", { key: "summary", style: S.panelMeta }, summaryLine),
				// ② 内容区（唯一可滚动）：两页共用同一个滚动容器，但各自独占内容。
				react.createElement(
					"div",
					{ key: "body", style: S.panelBody },
					inAuth
						? react.createElement(AuthSection, { t })
						: react.createElement(
								react.Fragment,
								null,
								...rows.map((row, index) =>
									react.createElement(ChannelRow, {
										key: row.id,
										row,
										t,
										first: index === 0,
										busy: busyId === row.id || claim === "busy",
										onCheckin: onCheckinOne,
										onToggleModel,
										onToggleAll,
										busyAll: busyAll === row.id,
									}),
								),
								rows.length === 0 ? react.createElement("div", { key: "empty", style: S.muted }, t("loading")) : null,
								prefs === undefined
									? null
									: react.createElement(Preferences, { key: "prefs", prefs, t, onPatch, busy: patchBusy }),
							),
				),
				// ③ 底部动作条（固定）：只有渠道页有动作，认证页不摆按钮。
				inAuth
					? null
					: react.createElement(
							"div",
							{ key: "footer", style: S.footer },
							react.createElement(
								"button",
								{
									type: "button",
									style: {
										...S.primaryBtn,
										flex: "1 1 auto",
										...(claim === "busy" || claimable === 0 ? S.disabledBtn : {}),
									},
									disabled: claim === "busy" || claimable === 0,
									onClick: onCheckinAll,
								},
								claimLabel,
							),
							note === undefined
								? null
								: react.createElement(
										"span",
										{ style: { color: TONE.error, fontSize: "12px", flexBasis: "100%" } },
										t("checkinFailed", { message: note }),
									),
						),
			];

			return react.createElement("div", { style: layout === "card" ? { ...S.card, ...S.cardScroll } : null }, ...body);
		}

		/**
		 * 左侧栏的「渠道中心」入口 —— 三合一后的**唯一**常驻入口。
		 *
		 * 它原来挂在 `conversation.composer.dock`（composer 下方居中那枚胶囊），和
		 * cost-meter 的角落芯片挤在同一条线上；而侧栏本来就是「用量统计 / 上下文洞察 /
		 * 记忆」这一列状态入口的老家，收进这里就不必再看 composer 下面那一排。
		 *
		 * 侧栏是 root 作用域：拿不到 sessionId，也就拿不到"当前选中的模型"，所以这里
		 * 只做汇总（N 渠道 / 可签 M），点开才是完整面板。原来胶囊右半那枚"直接给当前
		 * 渠道签到"依赖模型目录 —— 只有会话作用域才有 —— 那份能力在面板里按渠道逐条
		 * 保留，不再占着 composer 的位置。
		 *
		 * 状态只在挂载 / 窗口焦点变化时拉一次（角标是提示，不是承诺）；弹窗打开后由
		 * HubPanel 接管，按 OPEN_REFRESH_MS 刷新。
		 *
		 * ⚠️ 角标那份**也必须带 `auto=1`**（统一写在 `useHubStatus` 里，别在这里加分支）：
		 * 否则它与弹窗那份不同源，就会出现「角标说可签 2、弹窗说已签」这种自相矛盾
		 * （2026-09-27 用户报障）。两份 state 仍是各自独立的（弹窗开关不该重置角标），
		 * 但**取值来源相同**，所以显示结果一致。
		 */
		function HubSidebarEntry(props) {
			const t = typeof props.t === "function" ? props.t : (key) => key;
			/** 侧栏折叠成图标条时 `wide === false`。 */
			const wide = props.wide !== false;
			const { status } = useHubStatus(false);
			const [open, setOpen] = react.useState(false);
			const [pos, setPos] = react.useState(undefined);
			const buttonRef = react.useRef(null);
			/** 弹窗内独立维护一份 state（避免和条目那份互相覆盖）；**数据来源与它相同**。 */
			const panel = useHubStatus(open);

			ensureHubStyle();

			/** 沿用原来那枚胶囊的开关：偏好关掉整条就不渲染。 */
			const preferences = status === undefined ? undefined : status.preferences;
			const hidden = preferences !== undefined && preferences.showDockButton === false;

			/**
			 * 把条目的坐标算出来给弹层用。
			 *
			 * 必须在**打开之前**先算：首帧若没有 left/bottom，`position: fixed` 的元素会停在它
			 * 的 static 位置（通常在视口外），看起来就是"点了没反应"。
			 *
			 * 条目贴在视口左下角（侧栏底部），所以弹层朝**右上**长：左边贴在条目右缘外
			 * 10px，`bottom` 与条目底边对齐 —— 面板越高越往上顶，不会盖住侧栏本身，也
			 * 不会被视口下沿切掉。右边界仍按弹层宽度回收，避免溢出。
			 */
			const place = react.useCallback(() => {
				const node = buttonRef.current;
				if (node === null || node === undefined || typeof node.getBoundingClientRect !== "function") return;
				const rect = node.getBoundingClientRect();
				const width = Math.min(560, Math.max(320, window.innerWidth - 32));
				setPos({
					left: Math.min(rect.right + 10, Math.max(8, window.innerWidth - width - 12)),
					bottom: Math.max(8, window.innerHeight - rect.bottom),
				});
			}, []);

			react.useEffect(() => {
				if (!open) return undefined;
				place();
				const onDown = (event) => {
					const node = buttonRef.current;
					const panelNode = document.getElementById("dsh-connect-panel");
					if (node !== null && node.contains(event.target)) return;
					if (panelNode !== null && panelNode.contains(event.target)) return;
					setOpen(false);
				};
				const onKey = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				document.addEventListener("mousedown", onDown);
				document.addEventListener("keydown", onKey);
				window.addEventListener("resize", place);
				return () => {
					document.removeEventListener("mousedown", onDown);
					document.removeEventListener("keydown", onKey);
					window.removeEventListener("resize", place);
				};
			}, [open, place]);

			const onToggle = () => {
				place();
				setOpen((value) => !value);
			};

			/**
			 * 右侧尾标：有可签的就亮一枚 warning 标签（宿主 tag 的配色），
			 * 否则退回灰字"N 渠道" —— 两种状态都让这一行看得出内容量。
			 */
			const summary = status === undefined ? undefined : status.summary;
			const claimable = summary === undefined ? 0 : summary.claimable;
			const tail =
				summary === undefined
					? null
					: claimable > 0
						? react.createElement(
								"span",
								{ className: "dshc-side__tag" },
								t("sideTag", { claimable: String(claimable) }),
							)
						: react.createElement(
								"span",
								{ className: "dshc-side__count" },
								t("sideCount", { count: String(summary.total) }),
							);

			// 偏好关掉就整条消失 —— 放在所有 hook 之后，钩子顺序不受影响。
			if (hidden) return null;

			return react.createElement(
				react.Fragment,
				null,
				react.createElement(
					"button",
					{
						ref: buttonRef,
						type: "button",
						className: wide ? "dshc-side" : "dshc-side dshc-side--rail",
						title: t("triggerHint"),
						"aria-label": t("nav"),
						"aria-expanded": open ? "true" : "false",
						onClick: onToggle,
					},
					react.createElement("span", { className: "dshc-side__ico" }, HUB_ICON),
					wide ? react.createElement("span", { className: "dshc-side__label" }, t("nav")) : null,
					wide ? tail : null,
					// 折叠成图标条时没有文字，用右上角一个小圆点替代"可签"提示。
					wide || claimable === 0 ? null : react.createElement("span", { className: "dshc-side__badge" }),
				),
				open
					? reactDom.createPortal(
							react.createElement(
								react.Fragment,
								null,
								react.createElement("div", { style: S.scrim, onClick: () => setOpen(false) }),
								react.createElement(
									"div",
									{
										id: "dsh-connect-panel",
										style: pos === undefined ? S.popover : { ...S.popover, left: `${pos.left}px`, bottom: `${pos.bottom}px` },
									},
									react.createElement(HubPanel, {
										t,
										status: panel.status,
										setStatus: panel.setStatus,
										reload: panel.reload,
										layout: "popover",
									}),
								),
							),
							document.body,
						)
					: null,
			);
		}

		/** 宿主设置页的卡片形态：同一份面板，只是不弹层。 */
		function HubSettingsCard(props) {
			const { status, setStatus, reload } = useHubStatus(false);
			return react.createElement(HubPanel, { t: props.t, status, setStatus, reload, layout: "card" });
		}

		//#endregion

		//#region 文案

		const zh = {
			panelTitle: "渠道中心",
			nav: "渠道中心",
			sideTag: "可签 {claimable}",
			sideCount: "{count} 渠道",
			triggerHint: "查看各渠道额度与签到状态，可一键签到",
			refresh: "刷新",
			loading: "读取中…",
			summaryLine: "已登录 {signedIn}/{total} · 已签 {done} · 不适用 {unsupported} · 待手动 {manual}",
			creditsLabel: "额度",
			creditsPackages: "{count} 个包",
			creditsUnknown: "额度未知",
			creditsUnavailable: "额度查询失败",
			resetAt: "重置 {time}",
			models: "{count} 个模型",
			modelsWithDisabled: "模型 {count} · 已禁 {disabled}",
			modelsHint: "点开配置该渠道在模型选择器里显示的模型",
			modelsAllOffHint: "取消全部勾选 = 该渠道的模型不再出现在模型选择器里（仍然可以在这里全部勾回）",
			modelsCaption: "勾选 = 在模型选择器里显示；取消勾选即禁用该模型",
			modelsAllOn: "全选",
			modelsAllOff: "全不选",
			authTitle: "认证",
			authIntro: "凭据只写入文件（0600），不会显示回显、也不进 settings。改动最多 30 秒生效。",
			authSignedIn: "已登录",
			authSignedOut: "未登录",
			authNoTarget: "该渠道的凭据落点不可知（对应环境变量没设），请用导出脚本或改 compose",
			authSave: "保存",
			authSaving: "写入中…",
			authSaved: "已保存",
			authPaste: "粘贴",
			authCollapse: "收起",
			authBack: "返回",
			authMigrate: "五个渠道统一存在 connect-auth/；迁移用 export-connect-credentials.mjs bundle",
			channelDisabled: "已禁用",
			channelDisable: "禁用",
			channelEnable: "启用",
			authIdle: "空闲",
			authAdd: "添加",
			authDelete: "删除",
			authConfirmDelete: "确认删除",
			authSlotHint: "粘贴凭据即可启用这个槽位",
			authDeleteWarn: "删除会移除该槽位的凭据文件；不可撤销，但随时可以重新粘贴。",
			authSectionActive: "已配置",
			authSectionIdle: "空闲槽位（粘贴凭据即可添加渠道）",
			authAddChannel: "+ 添加渠道",
			authFormKind: "类型",
			authFormId: "渠道 ID",
			authFormName: "显示名称",
			authCreate: "创建槽位",
			authCancel: "取消",
			authRename: "改名",
			authRenameOk: "保存名称",
			scanAction: "扫码",
			scanTitle: "扫码登录",
			scanHint: "用手机微信/QQ 扫码，或直接用浏览器打开下面的链接 —— 那个页面自带二维码，也支持手机号 + 短信验证码。不需要装桌面 App。",
			scanStarting: "正在获取授权链接…",
			scanWaiting: "等待扫码授权…",
			scanSignedIn: "✓ 已登录，凭据已写入",
			scanBlocked: "没有写入",
			scanExpired: "授权码已失效，请重新获取",
			scanFailed: "失败",
			scanOpen: "打开链接",
			scanCopy: "复制链接",
			scanCopied: "已复制",
			scanKeepOpen: "保持本窗口开着；授权完成后会自动写入，无需再点任何按钮。",
			scanRetry: "重新获取",
			scanNeedsRestart: "该渠道尚未装载：它的路由还不存在，重启 DSH 后可用",
			scanReplaced: "已接管该槽位（原账号 {uid}… 的凭据文件没被改动，删掉插件副本即可退回）",
			signedOut: "未登录",
			unavailable: "不可用",
			checkinClaim: "签到",
			checkinClaimed: "✓ 已领取",
			checkinDone: "✓ 已签到",
			checkinManual: "去 App 领取",
			checkinUnsupported: "不适用",
			checkinUnavailable: "无签到活动",
			checkinUnknown: "签到状态未知",
			checkinNone: "—",
			checkinBusy: "签到中…",
			checkinRetry: "重试签到",
			checkinAll: "一键签到（{count}）",
			checkinAllBusy: "签到中…",
			checkinAllNone: "今日无可签",
			checkinFailed: "签到请求失败：{message}",
			prefAutoCheckin: "打开面板时自动签到（也是 workbuddy 签到状态的来源）",
			prefShowDock: "在左侧栏显示渠道中心入口",
		};

		const en = {
			panelTitle: "Connect Hub",
			nav: "Connect Hub",
			sideTag: "{claimable} to claim",
			sideCount: "{count} channels",
			triggerHint: "See every channel's credit and check-in state; one-click check-in",
			refresh: "Refresh",
			loading: "Loading…",
			summaryLine: "Signed in {signedIn}/{total} · checked in {done} · n/a {unsupported} · manual {manual}",
			creditsLabel: "Credit",
			creditsPackages: "{count} packages",
			creditsUnknown: "credit unknown",
			creditsUnavailable: "credit unavailable",
			resetAt: "resets {time}",
			models: "{count} models",
			modelsWithDisabled: "Models {count} · {disabled} off",
			modelsHint: "Pick which models this channel shows in the model picker",
			modelsAllOffHint: "Unchecking all = this channel's models disappear from the model picker (tick them back here)",
			modelsCaption: "Checked = shown in the model picker; uncheck to disable a model",
			modelsAllOn: "All on",
			modelsAllOff: "All off",
			authTitle: "Auth",
			authIntro: "Credentials are written to files (0600) only — never echoed back, never stored in settings. Takes up to 30s to apply.",
			authSignedIn: "signed in",
			authSignedOut: "signed out",
			authNoTarget: "This channel's credential path is unknown (its env var is unset); use the export script or change compose",
			authSave: "Save",
			authSaving: "Writing…",
			authSaved: "Saved",
			authPaste: "Paste",
			authCollapse: "Collapse",
			authBack: "Back",
			authMigrate: "All five channels live in connect-auth/; migrate with export-connect-credentials.mjs bundle",
			channelDisabled: "disabled",
			channelDisable: "Disable",
			channelEnable: "Enable",
			authIdle: "idle",
			authAdd: "Add",
			authDelete: "Delete",
			authConfirmDelete: "Confirm delete",
			authSlotHint: "Paste a credential to use this slot",
			authDeleteWarn: "Delete removes this slot's credential file. Not reversible, but you can paste it again anytime.",
			authSectionActive: "Configured",
			authSectionIdle: "Idle slots (paste a credential to add a channel)",
			authAddChannel: "+ Add channel",
			authFormKind: "Type",
			authFormId: "Channel ID",
			authFormName: "Display name",
			authCreate: "Create slot",
			authCancel: "Cancel",
			authRename: "Rename",
			authRenameOk: "Save name",
			scanAction: "Scan",
			scanTitle: "Scan to sign in",
			scanHint: "Scan with WeChat/QQ on your phone, or just open the link below in a browser — that page carries its own QR code and also accepts a phone number + SMS code. No desktop app needed.",
			scanStarting: "Requesting an authorization link…",
			scanWaiting: "Waiting for you to authorize…",
			scanSignedIn: "✓ Signed in, credential written",
			scanBlocked: "Nothing written",
			scanExpired: "The authorization code expired — request a new one",
			scanFailed: "Failed",
			scanOpen: "Open link",
			scanCopy: "Copy link",
			scanCopied: "Copied",
			scanKeepOpen: "Keep this window open; the credential is written automatically once you authorize.",
			scanRetry: "Request a new link",
			scanNeedsRestart: "This channel is not loaded yet — its routes do not exist until DSH is restarted",
			scanReplaced: "This slot now uses the scanned account ({uid}…). The previous credential file is untouched — delete the plugin-owned copy to switch back.",
			signedOut: "Not signed in",
			unavailable: "unavailable",
			checkinClaim: "Check in",
			checkinClaimed: "✓ Claimed",
			checkinDone: "✓ Checked in",
			checkinManual: "Claim in App",
			checkinUnsupported: "not applicable",
			checkinUnavailable: "no campaign",
			checkinUnknown: "check-in state unknown",
			checkinNone: "—",
			checkinBusy: "Checking…",
			checkinRetry: "Retry",
			checkinAll: "Check in all ({count})",
			checkinAllBusy: "Checking in…",
			checkinAllNone: "nothing to claim",
			checkinFailed: "Check-in request failed: {message}",
			prefAutoCheckin: "Auto check-in when the panel opens (also how WorkBuddy's state is read)",
			prefShowDock: "Show the Connect Hub entry in the left sidebar",
		};

		//#endregion

		//#region 插件入口

		const name = "dsh-connect-panel-client";
		const inject = ["slots", "locale"];

		/** 贡献失败时的统一前缀（加载期与渲染期共用）。 */
		const CONTRIBUTION_FAILED = "[dsh-connect] client contribution failed to load (host routes unaffected):";

		/**
		 * 贡献级错误边界。
		 *
		 * 槽位里的组件一旦渲染抛错，DSH 侧不一定有兜底 —— 而 composer 是输入区，
		 * 绝不能因为一个只读装饰挂掉。所以每个贡献都套一层：出错就渲染 null 并打日志。
		 * （与三个渠道插件"只读装饰：失败静默，绝不影响输入框"的约定一致。）
		 */
		class ContributionBoundary extends react.Component {
			constructor(props) {
				super(props);
				this.state = { failed: false };
			}
			static getDerivedStateFromError() {
				return { failed: true };
			}
			componentDidCatch(error) {
				console.error(CONTRIBUTION_FAILED + " render", error);
			}
			render() {
				return this.state.failed ? null : this.props.children;
			}
		}

		/** 把组件包进错误边界，再交给槽位。 */
		function guarded(Component) {
			function Guarded(props) {
				return react.createElement(ContributionBoundary, null, react.createElement(Component, props));
			}
			Guarded.displayName = `Guarded(${Component.name || "Contribution"})`;
			return Guarded;
		}

		/** 注册期抛错则降级成 console.error，不要毒死整个客户端加载器。 */
		function guard(label, fn) {
			try {
				return fn();
			} catch (error) {
				console.error(CONTRIBUTION_FAILED + " " + label, error);
				return undefined;
			}
		}

		function apply(ctx) {
			const namespace = "dsh-connect";
			guard("copy", () => {
				ctx.effect(() => ctx.locale.register(namespace, { zh, en }), "dsh-connect: copy");
			});
			const t = ctx.locale.bind(namespace);

			/**
			 * 左侧栏的常驻入口。
			 *
			 * 原来这一条挂在 `conversation.composer.dock`（composer 下方居中那枚胶囊），
			 * 和 cost-meter 的角落芯片挤在同一条线上；侧栏本来就是「用量统计 / 上下文洞察 /
			 * 记忆」这一列状态入口的老家，收进来 composer 下面就干净了。
			 *
			 * 槽位契约（抄自 memory-eternal / dsh-context）：`order` 决定它在侧栏里的位置
			 * —— 0/1/2 是 cost-meter 的额度块，10 是「用量统计」和「上下文洞察」，
			 * 100 是「记忆」，所以这里用 20，落在中间那组之后、记忆之前。
			 */
			guard("sidebar entry", () => {
				guard("sidebar entry", () =>
					ctx.slots.inject("sidebar.footer.action", () =>
						guard("connect hub sidebar entry", () =>
							ctx.slots.register(
								{
									name: "sidebar.footer.action",
									id: "connect-hub",
									order: 20,
									label: () => safeT(t)("nav"),
									locale: namespace,
								},
								/**
								 * 只透传 `wide`，翻译自己兜底：宿主按 `locale` 注入 `t`，
								 * 注入不到时用我们自己 bind 过的那份，绝不落到 key 上。
								 */
								guarded(function HubSidebarSlot(props) {
									return react.createElement(HubSidebarEntry, {
										wide: props === undefined ? undefined : props.wide,
										t: props !== undefined && typeof props.t === "function" ? props.t : safeT(t),
									});
								}),
							),
						),
					),
				);
			});

			// DSH 0.1.5 的 Plugins 页按「宿主在服务哪些命名空间」派发卡片，
			// key 必须等于宿主 settings 命名空间字符串（宿主侧 HUB_SETTINGS_NS）。
			guard("settings card", () => {
				guard("settings card", () =>
					ctx.slots.inject("settings.plugin.item", () =>
						guard("connect hub settings card", () =>
							ctx.slots.register(
								{
									name: "settings.plugin.item",
									key: "dsh-connect",
									priority: 25,
									inject: () => ({ t: safeT(t) }),
								},
								guarded(HubSettingsCard),
							),
						),
					),
				);
			});
		}

		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	},
});
