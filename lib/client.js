/**
 * dsh-connect —— 浏览器侧（**由生成器合成，不要手改**）。
 *
 * 生成器：plugins/history/compose-dsh-connect-client-20260924.py
 *
 * 为什么是生成而不是手写：DSH 的客户端模块系统「一个包 = 一个客户端入口」
 * （`exports["./client"]`，行 id = 包名，见 dsh-client-modules 的 clientExportOf），
 * 所以四个渠道的面板/信息行必须落在**同一个** `window.__ModuleLoader__.load` 里。
 * 四份代码里的 `zh`/`en`/`name`/`inject`/`S` 等同名标识符靠**独立 IIFE 作用域**隔离，
 * 而不是靠手工改名 —— 手工改名是最容易出错的一步。
 *
 * 本文件**不能出现顶层 import/export**：宿主把它原样拼进 combo bundle 用 classic
 * <script> 执行；一旦出现，整批客户端代码都会抛 SyntaxError，浏览器只会报
 * `bundle ... loaded without registering "<某个无辜插件>"`，极难定位。
 */

window.__ModuleLoader__.load({
	id: "dsh-connect",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");

		// ══ dsh-workbuddy-connect 的客户端半侧（原样搬入，独立作用域）══
		const workbuddyClient = (() => {
			var module = { exports: {} };
			var exports = module.exports;
			Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		
		
		
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/status-paths.ts
		/** Node-free constants and types shared by the Host and browser halves. */
		/** Plugin-owned status endpoint consumed by its browser half. */
		const WORKBUDDY_STATUS_PATH = "/plugins/dsh-workbuddy-connect/1/status";
		/**
		* Plugin-owned probe control endpoint.
		*
		* Separate from the status route because it accepts writes: the status route's
		* loopback Host/Origin guard protects against a DNS-rebinding *page*, which is
		* not the same as authorizing a state-changing action. This route therefore
		* also requires the in-process key the browser half receives with the status
		* document.
		*/
		const WORKBUDDY_PROBE_PATH = "/plugins/dsh-workbuddy-connect/1/probe";
		/**
		* The international (WorkBuddy AI) variant's own pair of routes.
		*
		* Kept as separate constants rather than a computed suffix so both halves
		* reference literal strings: the browser bundle and the host bundle are built
		* independently, and a shared expression is one build-config drift away from
		* the desk asking a route the host never mounted.
		*/
		const WORKBUDDY_AI_STATUS_PATH = "/plugins/dsh-workbuddy-connect/2/status";
		const WORKBUDDY_AI_PROBE_PATH = "/plugins/dsh-workbuddy-connect/2/probe";
		/** [本地分支 2026-09-24] 企业版渠道（workbuddy3）的一对路由。 */
		const WORKBUDDY_3_STATUS_PATH = "/plugins/dsh-workbuddy-connect/3/status";
		const WORKBUDDY_3_PROBE_PATH = "/plugins/dsh-workbuddy-connect/3/probe";
		/**
		 * Qoder 的一对路由。探查（`.../probe`）是 2026-10-06 新增的：
		 * Qoder 目录只给 `is_reasoning` 布尔、不声明档位列表，
		 * 所以"这个模型支持哪几档"只能靠探查实测（Trae 相反，由目录声明）。
		 */
		const QODER_STATUS_PATH = "/plugins/dsh-qoder-connect/status";
		const QODER_PROBE_PATH = "/plugins/dsh-qoder-connect/probe";
		//#endregion
		//#region src/client/status-document.ts
		/**
		* Whether a parsed status response really is a status document.
		*
		* A 200 is not a promise about the body: it may be empty, literal `null`, a
		* non-JSON page from a proxy, or an array. Both halves of the browser plugin
		* read the same route, so both must agree on what is valid — storing an
		* unreadable value puts something in state that the next render dereferences.
		*
		* The check is deliberately limited to the discriminator (plus `error`'s
		* `message`, which the error paragraph renders): validating optional fields
		* here would reject documents the host legitimately omits fields from.
		*/
		function isWorkBuddyWebStatus(value) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
			const wrapped = value;
			const status = wrapped["status"];
			if (status === "signed-out" || status === "signed-in") return true;
			return status === "error" && typeof wrapped["message"] === "string";
		}
		//#endregion
		//#region src/client/WorkBuddyPluginCard.tsx
		/**
		* WorkBuddy status card, rendered on whichever settings surface the host
		* provides: dispatched directly by DSH 0.1.5's settings Plugins tab (one card
		* per variant), or mounted by the bundle configuration page DSH 0.1.6+'s
		* Plugins page renders. The component itself is surface-agnostic — its props
		* are only the injected copy and variant.
		*/
		/** [本地分支] 国区账号 1。 */
		const CN_CARD_VARIANT = {
			id: "workbuddy1",
			titleKey: "title1",
			introKey: "intro1",
			signedOutKey: "signedOutHint1",
			statusPath: WORKBUDDY_STATUS_PATH,
			probePath: WORKBUDDY_PROBE_PATH
		};
		/** [本地分支] 国区账号 2。 */
		const AI_CARD_VARIANT = {
			id: "workbuddy2",
			titleKey: "title2",
			introKey: "intro2",
			signedOutKey: "signedOutHint2",
			statusPath: WORKBUDDY_AI_STATUS_PATH,
			probePath: WORKBUDDY_AI_PROBE_PATH
		};
		/** [本地分支 2026-09-24] 国区企业版账号。 */
		const ENTERPRISE_CARD_VARIANT = {
			id: "workbuddy3",
			titleKey: "title3",
			introKey: "intro3",
			signedOutKey: "signedOutHint3",
			statusPath: WORKBUDDY_3_STATUS_PATH,
			probePath: WORKBUDDY_3_PROBE_PATH
		};
		/** Every card, in display order. */
		const CARD_VARIANTS = [CN_CARD_VARIANT, AI_CARD_VARIANT, ENTERPRISE_CARD_VARIANT];
		/**
		 * 探查控件要服务的 provider → 路由映射。
		 *
		 * 为什么不直接往 `CARD_VARIANTS` 里加：那张表同时驱动**设置页的渠道卡片**
		 * （`CARD_VARIANTS.map(...WorkBuddyPluginCard)`）与 WorkBuddy 路由注册，
		 * 把 Qoder 塞进去会让它出现在 WorkBuddy 的设置卡片里。
		 *
		 * 所以探查单独一张表：只要 provider 能映射到 `{statusPath, probePath}`，
		 * 控件就能工作 —— 它本身与渠道无关（哨兵探测、倒计时、结果展示都是通用的）。
		 *
		 * Qoder 的探查请求契约刻意与 WorkBuddy 对齐（同样的 header 名与
		 * `{action, model}` body），所以这里不需要为它写第二套控件逻辑。
		 */
		const PROBE_TARGETS = [
			...CARD_VARIANTS,
			{ id: "qoder1", statusPath: QODER_STATUS_PATH, probePath: QODER_PROBE_PATH }
		];
		const POLL_INTERVAL_MS = 6e4;
		const cardStyle = {
			overflow: "hidden",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 10,
			background: "var(--dsw-alias-bg-module-platform)",
			listStyle: "none"
		};
		const headerStyle = {
			boxSizing: "border-box",
			width: "100%",
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: 16,
			border: 0,
			padding: "13px 14px",
			background: "transparent",
			color: "var(--dsw-alias-label-primary)",
			font: "inherit",
			textAlign: "left",
			cursor: "pointer"
		};
		const headTextStyle = {
			display: "flex",
			minWidth: 0,
			flexDirection: "column",
			gap: 3
		};
		const nameStyle = {
			fontSize: 14,
			lineHeight: "20px",
			fontWeight: 600
		};
		const descriptionStyle = {
			fontSize: 13,
			lineHeight: "18px",
			color: "var(--dsw-alias-label-tertiary)"
		};
		const chevronStyle = {
			flex: "0 0 auto",
			fontSize: 18,
			lineHeight: 1,
			transition: "transform 120ms ease"
		};
		const cardBodyStyle = {
			borderTop: "1px solid var(--dsw-alias-border-l2)",
			padding: "16px 14px 18px"
		};
		const bodyStyle = {
			margin: 0,
			fontSize: 14,
			lineHeight: "22px",
			color: "var(--dsw-alias-label-secondary)"
		};
		const rowStyle = {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			flexWrap: "wrap",
			gap: 12
		};
		const statusStyle = {
			display: "flex",
			alignItems: "center",
			gap: 9,
			fontSize: 15,
			fontWeight: 500,
			color: "var(--dsw-alias-label-primary)"
		};
		const buttonStyle$1 = {
			boxSizing: "border-box",
			minHeight: 34,
			padding: "6px 14px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 18,
			background: "var(--dsw-alias-bg-layer-1)",
			color: "var(--dsw-alias-label-primary)",
			font: "inherit",
			fontSize: 14,
			cursor: "pointer"
		};
		const errorStyle = {
			...bodyStyle,
			color: "var(--dsw-alias-state-error-primary)"
		};
		const quotaListStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 18,
			paddingTop: 2
		};
		const quotaGroupStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 10
		};
		const quotaTitleStyle = {
			margin: 0,
			fontSize: 14,
			lineHeight: "20px",
			fontWeight: 600,
			color: "var(--dsw-alias-label-primary)"
		};
		const quotaLabelStyle = {
			display: "flex",
			justifyContent: "space-between",
			gap: 12,
			fontSize: 13,
			lineHeight: "20px",
			color: "var(--dsw-alias-label-secondary)"
		};
		const modelBadgeStyle = {
			display: "flex",
			alignItems: "center",
			gap: 6,
			flexWrap: "wrap"
		};
		const modelOfferStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 2
		};
		const modelRateStyle = {
			fontSize: 12,
			lineHeight: "18px",
			color: "var(--dsw-alias-label-tertiary)"
		};
		const contextPreferenceStyle = {
			display: "flex",
			alignItems: "flex-start",
			gap: 9,
			padding: "10px 12px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 8,
			color: "var(--dsw-alias-label-primary)",
			fontSize: 13,
			lineHeight: "20px"
		};
		const contextPreferenceCopyStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 2
		};
		/**
		* Left half of one merged context/visibility row: the visibility checkbox (when
		* the account has one) beside the model's name and rate. Kept as a flex span so
		* the capacity column stays flush right no matter how long the name runs.
		*/
		const contextRowMainStyle = {
			display: "flex",
			alignItems: "center",
			gap: 9,
			minWidth: 0
		};
		const modelBadgeChipStyle = {
			padding: "1px 8px",
			borderRadius: 999,
			fontSize: 11,
			lineHeight: "18px",
			background: "var(--dsw-alias-state-success-subtle, rgba(34, 160, 107, 0.12))",
			color: "var(--dsw-alias-state-success-primary, #22a06b)"
		};
		/**
		* Localize an upstream promotional badge label, with an unknown-badge fallback.
		*
		* The CN catalog spells badges in Chinese (`限时免费`, `夜间折扣`); the
		* international document's `modelPromotions` carries English (`Free now`). Both
		* are mapped so the same promotion reads consistently in either UI language,
		* and anything else passes through verbatim — an unrecognized badge is still
		* information the upstream chose to show.
		*/
		function modelBadgeLabel(badge, t) {
			if (badge === "限时免费") return t("badgeLimitedFree");
			if (badge === "夜间折扣") return t("badgeNightDiscount");
			if (badge === "Free now") return t("badgeFreeNow");
			return badge;
		}
		const progressTrackStyle = {
			height: 8,
			overflow: "hidden",
			borderRadius: 999,
			background: "var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.08))"
		};
		/**
		* Inline confirmation box for a paid detection. Replaces the previous
		* `window.confirm`: the decision is one line plus two buttons, and a modal
		* alert for that is heavier than the action it guards.
		*/
		const confirmBoxStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 10,
			padding: "10px 12px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 8,
			background: "var(--dsw-alias-bg-layer-1)"
		};
		const confirmRowStyle$1 = {
			display: "flex",
			justifyContent: "flex-end",
			gap: 8
		};
		/** One probeable model's row: name on the left, state and action on the right. */
		const probeRowStyle = {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: 12
		};
		const probeRowEndStyle = {
			display: "inline-flex",
			alignItems: "center",
			gap: 8,
			flex: "0 0 auto"
		};
		/**
		* Tab strip for the card body. Kept visually light — a full pill would compete
		* with the section headings, and the card is already the densest surface the
		* plugin owns.
		*/
		const tabBarStyle = {
			display: "flex",
			gap: 4,
			marginTop: 4,
			borderBottom: "1px solid var(--dsw-alias-border-l2)"
		};
		const tabStyle = {
			padding: "6px 12px",
			border: 0,
			borderBottom: "2px solid transparent",
			background: "transparent",
			color: "var(--dsw-alias-label-tertiary)",
			font: "inherit",
			fontSize: 13,
			lineHeight: "20px",
			cursor: "pointer"
		};
		const tabActiveStyle = {
			borderBottom: "2px solid var(--dsw-alias-brand-primary)",
			color: "var(--dsw-alias-label-primary)",
			fontWeight: 600
		};
		const tabPanelStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 18,
			paddingTop: 16
		};
		/**
		* Primary action of the inline confirmation. Fill and text colour come from the
		* theme as a pair: `brand-primary` is a light accent here, so pairing it with a
		* hardcoded white would render white-on-white.
		*/
		const primaryButtonStyle$1 = {
			...buttonStyle$1,
			border: "1px solid var(--dsw-alias-button-primary-fill)",
			background: "var(--dsw-alias-button-primary-fill)",
			color: "var(--dsw-alias-label-primary-foreground)"
		};
		function progressFillStyle(percent) {
			return {
				width: `${Math.max(0, Math.min(100, percent))}%`,
				height: "100%",
				borderRadius: "inherit",
				background: "var(--dsw-alias-brand-primary, #1677ff)"
			};
		}
		/**
		* Status dot colour. Takes `'loading'` as well as the document's own states:
		* before the first response the card knows nothing about the account, so it must
		* not borrow the signed-out grey — that would read as "nothing is wrong, nobody
		* is signed in" when the truth is "not read yet".
		*/
		function dotStyle(status) {
			return {
				width: 9,
				height: 9,
				borderRadius: "50%",
				flex: "0 0 auto",
				background: status === "signed-in" ? "var(--dsw-alias-state-success-primary, #22a06b)" : status === "error" ? "var(--dsw-alias-state-error-primary, #d92d20)" : "var(--dsw-alias-label-dimmed, #9aa0a6)"
			};
		}
		function formatNumber(value) {
			return new Intl.NumberFormat(void 0).format(value);
		}
		function formatTime(ms) {
			return new Intl.DateTimeFormat(void 0, {
				dateStyle: "medium",
				timeStyle: "short"
			}).format(new Date(ms));
		}
		function formatCycleReset(time) {
			const parsed = Date.parse(time);
			if (!Number.isNaN(parsed)) return formatTime(parsed);
			return time;
		}
		/**
		* One billing package as a labeled progress bar.
		*
		* A package whose allowance the upstream never reported (`size` not positive)
		* has no percentage to state. It must not fall back to 100%: the plugin would be
		* claiming a full quota it knows nothing about, which is the opposite of the
		* honest "remaining N" line printed below it. Unknown size therefore renders the
		* percent slot as unknown copy and an unfilled, indeterminate track.
		*/
		function CreditBar({ label, remain, size, unlimited, t }) {
			if (unlimited === true) {
				const quotaText = t("unlimitedQuota");
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: quotaGroupStyle,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: quotaLabelStyle,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: quotaText })]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: progressTrackStyle,
							role: "progressbar",
							"aria-label": label,
							"aria-valuetext": quotaText
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: bodyStyle,
							children: quotaText
						})
					]
				});
			}
			const sizeKnown = size > 0;
			const detail = sizeKnown ? t("exactRemaining", {
				remain: formatNumber(remain),
				size: formatNumber(size)
			}) : t("creditPackageUnknownSize", { remain: formatNumber(remain) });
			const percent = sizeKnown ? remain / size * 100 : void 0;
			const display = percent === void 0 ? t("percentUnknown") : t("percentRemaining", { percent: new Intl.NumberFormat(void 0, { maximumFractionDigits: 1 }).format(percent) });
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: quotaGroupStyle,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: quotaLabelStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: display })]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: progressTrackStyle,
						role: "progressbar",
						"aria-label": label,
						...percent === void 0 ? { "aria-valuetext": detail } : {
							"aria-valuemin": 0,
							"aria-valuemax": 100,
							"aria-valuenow": percent
						},
						children: percent === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { style: progressFillStyle(percent) })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: bodyStyle,
						children: detail
					})
				]
			});
		}
		/**
		* One model offer row: name, promotional badges, and the billing rate.
		*
		* The rate sits under the name rather than beside it because the row already
		* spends its horizontal budget on badges; stacking keeps long model names and
		* several badges from squeezing the rate into an ellipsis.
		*/
		function ModelOfferRow({ model, t }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: modelOfferStyle,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: quotaLabelStyle,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: model.name }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: modelBadgeStyle,
						children: [model.badges?.map((badge) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: modelBadgeChipStyle,
							children: modelBadgeLabel(badge, t)
						}, badge)), model.free === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: modelBadgeChipStyle,
							children: t("freeModel")
						}) : null]
					})]
				}), model.credits === void 0 ? model.rateUnknown === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: modelRateStyle,
					children: t("rateUnknown")
				}) : null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: modelRateStyle,
					children: t("rate", { rate: model.credits })
				})]
			});
		}
		/**
		* Context window and model visibility, one row per catalog model.
		*
		* The list is driven by the full current catalog, not by context metadata:
		* hiding a model is a statement about the picker, and a model without a
		* declared window is still hideable — its row just shows an em dash where the
		* capacity would be. Rows with a window keep the original ordering (largest
		* first); rows without one trail at the end in catalog order.
		*
		* Each row is one <label>, so the checkbox is named by its row without a
		* duplicated aria string. The checkbox state comes from the status document
		* only — no optimistic flip — so a save that fails leaves the box where the
		* host's truth says it is, next to the failure notice `control` records.
		* Checkboxes render only when the document carries a visibility section (a
		* signed-in account with a stable user id); a uid-less credential shows the
		* plain capacity list rather than editing a bucket every such account would
		* share.
		*
		* Purely a report of the upstream's own numbers otherwise. The plugin offers
		* no tier picker: the CN catalog declares one capacity per model and publishes
		* no alternatives, so a menu there would mean inventing client-side policy.
		* The international document does declare alternatives (`supportedLengths`),
		* and they are shown as a secondary figure rather than merged into one number —
		* the default is the budget actually requested, while the larger value is a
		* ceiling the upstream would accept.
		*/
		function ContextTable({ models, t, useMaximumContextWindow, contextPreferenceDisabled, onUseMaximumContextWindow, visibility, visibilityControlsDisabled, visibilityToggling, onVisibilityToggle }) {
			const rows = [...models ?? []].sort((a, b) => {
				if (a.contextWindow === void 0) return b.contextWindow === void 0 ? 0 : 1;
				if (b.contextWindow === void 0) return -1;
				return b.contextWindow - a.contextWindow;
			});
			const canSelectMaximum = rows.some((model) => model.maxContextWindow !== void 0 && model.maxContextWindow > (model.defaultContextWindow ?? model.contextWindow ?? 0));
			const showPreference = onUseMaximumContextWindow !== void 0 && (canSelectMaximum || useMaximumContextWindow === true);
			if (rows.length === 0 && !showPreference) return null;
			const hidden = new Set(visibility?.disabled ?? []);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: quotaListStyle,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						style: quotaTitleStyle,
						children: t("contextHeading")
					}),
					showPreference && onUseMaximumContextWindow !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: contextPreferenceStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "checkbox",
							checked: useMaximumContextWindow === true,
							disabled: contextPreferenceDisabled,
							onChange: (event) => {
								onUseMaximumContextWindow(event.currentTarget.checked);
							}
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: contextPreferenceCopyStyle,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("useMaximumContextWindow") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: modelRateStyle,
								children: t("useMaximumContextWindowHint")
							})]
						})]
					}) : null,
					visibility === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: bodyStyle,
						children: t("visibilityIntro")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: quotaGroupStyle,
						children: rows.map((model) => {
							const capacity = model.contextWindow;
							const alternative = capacity !== void 0 && model.maxContextWindow !== void 0 && model.maxContextWindow > capacity ? model.maxContextWindow : void 0;
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								style: quotaLabelStyle,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: contextRowMainStyle,
									children: [visibility === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										checked: !hidden.has(model.id),
										disabled: visibilityControlsDisabled || visibilityToggling.has(model.id),
										onChange: (event) => {
											onVisibilityToggle?.(model.id, event.currentTarget.checked);
										}
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										style: modelOfferStyle,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											style: modelBadgeStyle,
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: model.name }),
												model.badges?.map((badge) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													style: modelBadgeChipStyle,
													children: modelBadgeLabel(badge, t)
												}, badge)),
												model.free === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													style: modelBadgeChipStyle,
													children: t("freeModel")
												}) : null
											]
										}), model.credits === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: modelRateStyle,
											children: model.credits
										})]
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: modelOfferStyle,
									children: [capacity === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: modelRateStyle,
										"aria-label": t("contextUnknown"),
										children: "—"
									}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: { textAlign: "right" },
										children: formatTokens(capacity)
									}), alternative !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: modelRateStyle,
										children: t("contextUpTo", { size: formatTokens(alternative) })
									}) : capacity !== void 0 && model.defaultContextWindow !== void 0 && model.defaultContextWindow < capacity ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: modelRateStyle,
										children: t("contextDefault", { size: formatTokens(model.defaultContextWindow) })
									}) : null]
								})]
							}, model.id);
						})
					})
				]
			});
		}
		/**
		* Compact token count for display: the catalog's own round numbers (`200000`,
		* `1000000`) read better as `200K` / `1M`, and no precision is lost because
		* these values are always whole thousands.
		*/
		function formatTokens(tokens) {
			if (tokens >= 1e6 && tokens % 1e6 === 0) return `${tokens / 1e6}M`;
			if (tokens >= 1e3 && tokens % 1e3 === 0) return `${tokens / 1e3}K`;
			return String(tokens);
		}
		/**
		* Reasoning-effort detection section: consent switches, per-model detection,
		* and the recorded observations.
		*
		* Two deliberate UX rules from the plan (§3.1, §3.2):
		* - the confirmation is shown *before* any request, and its copy states the
		*   credit caveat;
		* - a `non-validating` result is presented as an observation about the
		*   parameter ("this model does not check it"), never as a statement that a
		*   level is unsupported.
		*/
		function ProbeSection({ probe, models, t, onDetect, onClear, busy }) {
			const [pending, setPending] = (0, react.useState)();
			const [runningModel, setRunningModel] = (0, react.useState)();
			(0, react.useEffect)(() => {
				if (pending !== void 0 && !probe.candidates.includes(pending)) setPending(void 0);
			}, [pending, probe.candidates]);
			const runningArmed = (0, react.useRef)(false);
			(0, react.useEffect)(() => {
				if (runningModel === void 0) return;
				if (busy || probe.running) {
					runningArmed.current = true;
					return;
				}
				if (!runningArmed.current) return;
				runningArmed.current = false;
				setRunningModel(void 0);
			}, [
				runningModel,
				busy,
				probe.running
			]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: quotaListStyle,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						style: quotaTitleStyle,
						children: t("probeHeading")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: bodyStyle,
						children: t("probeIntro")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: bodyStyle,
						children: t("probeConsentHint")
					}),
					probe.running ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: bodyStyle,
						children: t("probeRunningGeneric")
					}) : null,
					probe.candidates.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: bodyStyle,
						children: t("probeResultEmpty")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: quotaGroupStyle,
						children: probe.candidates.map((id) => {
							const result = probe.results.find((entry) => entry.id === id);
							const name = models?.find((model) => model.id === id)?.name ?? result?.name ?? id;
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: modelOfferStyle,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: probeRowStyle,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: name }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											style: probeRowEndStyle,
											children: [result === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: modelBadgeChipStyle,
												children: result.validation === "validating" && result.efforts.length > 0 ? result.efforts.join(" / ") : t(result.validation === "non-validating" ? "probeResultNotValidating" : "probeResultUnknown")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												style: buttonStyle$1,
												disabled: probe.running || busy,
												onClick: () => {
													setPending(id);
												},
												children: runningModel === id ? t("probeRunning", { model: name }) : t(result === void 0 ? "probeStart" : "probeRedetect")
											})]
										})]
									}),
									result === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: modelRateStyle,
										children: t("probeResultAt", { time: formatTime(result.probedAt) })
									}),
									pending === id ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: confirmBoxStyle,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											style: bodyStyle,
											children: t("probeConfirmBody", { model: name })
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											style: confirmRowStyle$1,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												style: buttonStyle$1,
												onClick: () => {
													setPending(void 0);
												},
												children: t("cancel")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												style: primaryButtonStyle$1,
												disabled: probe.running || busy,
												onClick: () => {
													setRunningModel(id);
													setPending(void 0);
													onDetect(id);
												},
												children: t("probeConfirmAction")
											})]
										})]
									}) : null
								]
							}, id);
						})
					}),
					probe.results.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						style: buttonStyle$1,
						disabled: busy,
						onClick: () => {
							onClear();
						},
						children: t("probeClear")
					})
				]
			});
		}
		/** Render WorkBuddy sign-in state and credit as one expandable card. */
		function WorkBuddyPluginCard({ t, variant = CN_CARD_VARIANT }) {
			if (t === void 0) throw new Error("WorkBuddy plugin card requires its translation function");
			const [open, setOpen] = (0, react.useState)(false);
			/**
			* The document to render. `undefined` means *not read yet*, which is a
			* distinct state from "signed out": seeding this with a signed-out document
			* told an already-signed-in user they were signed out for the whole first
			* round trip (and forever, if the read never settled).
			*/
			const [status, setStatus] = (0, react.useState)();
			/**
			* Whether the last **successful** read found a usable credential.
			*
			* Kept apart from `status` because the poll's liveness must depend on what the
			* account actually is, not on what the card last displayed: a failed read
			* leaves this untouched, so a transient failure cannot disarm the interval,
			* while a genuine signed-out answer still stops it.
			*
			* `undefined` therefore means "no successful read yet", which is also the
			* condition that decides whether a failed read has anything to preserve.
			*/
			const [signedIn, setSignedIn] = (0, react.useState)();
			/**
			* Why the most recent read failed, when it did. Rendered as a notice beside
			* whatever document is still on screen, rather than replacing it.
			*/
			const [readFailure, setReadFailure] = (0, react.useState)();
			const [busy, setBusy] = (0, react.useState)(false);
			/**
			* The model ids whose visibility writes are in flight, empty when none are.
			* Deliberately NOT the card-wide `busy` (that flag drives the Refresh
			* buttons' labels, which must not claim a refresh the user never pressed)
			* and deliberately per-row rather than whole-list: a visibility write only
			* adds or removes one model's id, so the rows are independent — locking
			* every checkbox for one row's write made the whole list visibly blink for
			* no correctness gain. A set, because two writes can be open at once when
			* the user moves down the list; only the rows being written lock.
			*/
			const [togglingModels, setTogglingModels] = (0, react.useState)(() => /* @__PURE__ */ new Set());
			const [tab, setTab] = (0, react.useState)("status");
			const mounted = (0, react.useRef)(true);
			/**
			* Identity of the newest read that may write. Assigned when a read *starts*,
			* so a response is superseded by anything begun after it — "the response whose
			* request started last wins". Without this, a slow poll begun before a manual
			* action could settle after the action's own refresh and restore the older
			* document.
			*/
			const readSeq = (0, react.useRef)(0);
			/** Manual requests in flight, so unmount can abort them like the poll's. */
			const manualControllers = (0, react.useRef)(/* @__PURE__ */ new Set());
			(0, react.useEffect)(() => {
				mounted.current = true;
				return () => {
					mounted.current = false;
					for (const controller of manualControllers.current) controller.abort();
					manualControllers.current.clear();
				};
			}, []);
			/** Register a manual request's controller so unmount aborts it. */
			const trackController = (0, react.useCallback)(() => {
				const controller = new AbortController();
				manualControllers.current.add(controller);
				return controller;
			}, []);
			/**
			* Read the status document and apply it under the two policies the card's
			* correctness rests on:
			*
			* - a non-document body (empty, `null`, a non-JSON page) is a failed read, not
			*   something to store and then dereference in the render;
			* - a failed read never discards a document already on screen. It is recorded
			*   and shown as a notice beside that document; only when nothing has been
			*   read yet does the failure itself become the rendered state.
			*
			* Returns whether this read produced the current document.
			*/
			const refresh = (0, react.useCallback)(async (signal) => {
				const seq = ++readSeq.current;
				const current = () => mounted.current && signal?.aborted !== true && seq === readSeq.current;
				try {
					const response = await fetch(variant.statusPath, {
						headers: { accept: "application/json" },
						credentials: "same-origin",
						...signal === void 0 ? {} : { signal }
					});
					const value = await response.json().catch(() => void 0);
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					if (!isWorkBuddyWebStatus(value)) throw new Error(t("statusResponseInvalid"));
					if (!current()) return false;
					setStatus(value);
					if (value.status === "signed-in") setSignedIn(true);
					else if (value.status === "signed-out") setSignedIn(false);
					setReadFailure(void 0);
					return true;
				} catch (error) {
					const message = error instanceof Error ? error.message : t("requestFailed");
					if (current()) {
						setReadFailure(message);
						setStatus((previous) => previous === void 0 ? {
							status: "error",
							message
						} : previous);
					}
					return false;
				}
			}, [t, variant.statusPath]);
			(0, react.useEffect)(() => {
				if (!open) return;
				const controller = new AbortController();
				refresh(controller.signal);
				return () => {
					controller.abort();
				};
			}, [open, refresh]);
			(0, react.useEffect)(() => {
				if (!open || signedIn === false) return;
				const controller = new AbortController();
				const timer = window.setInterval(() => {
					refresh(controller.signal);
				}, POLL_INTERVAL_MS);
				return () => {
					window.clearInterval(timer);
					controller.abort();
				};
			}, [
				open,
				refresh,
				signedIn
			]);
			const manualRefresh = async () => {
				setBusy(true);
				const controller = trackController();
				try {
					await refresh(controller.signal);
				} finally {
					manualControllers.current.delete(controller);
					if (mounted.current) setBusy(false);
				}
			};
			/**
			* Ask the host to re-read the credential and re-fetch this variant's catalog.
			*
			* Shares the probe route's key and guards: it is a write that spends an
			* upstream request, so it does not belong on the read-only status GET. A
			* failure is surfaced through the refreshed document's `catalog.error` rather
			* than thrown away, so the reason survives the round trip.
			*/
			const refreshModels = (0, react.useCallback)(async () => {
				const key = status?.status === "signed-in" ? status.probeKey : void 0;
				if (key === void 0) return;
				setBusy(true);
				const controller = trackController();
				try {
					const response = await fetch(variant.probePath, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-WorkBuddy-Probe-Key": key
						},
						credentials: "same-origin",
						signal: controller.signal,
						body: JSON.stringify({ action: "refresh" })
					});
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
				} catch (error) {
					if (mounted.current && controller.signal.aborted !== true) setReadFailure(error instanceof Error ? error.message : t("requestFailed"));
					manualControllers.current.delete(controller);
					return;
				} finally {
					if (mounted.current) setBusy(false);
				}
				try {
					await refresh(controller.signal);
				} finally {
					manualControllers.current.delete(controller);
				}
			}, [
				refresh,
				status,
				t,
				trackController,
				variant.probePath
			]);
			/**
			* Run one control action and refresh the card's state afterwards.
			*
			* The key travels in a header, not the body: it authorizes the write, and
			* the host never accepts a prompt, a sentinel, or a model outside its own
			* catalog from here.
			*/
			const control = (0, react.useCallback)(async (action) => {
				const key = status?.status === "signed-in" ? status.probeKey : void 0;
				if (key === void 0) return;
				const visibility = action.action === "set-model-visibility";
				if (visibility) setTogglingModels((previous) => new Set(previous).add(action.model));
				else setBusy(true);
				const controller = trackController();
				try {
					const response = await fetch(variant.probePath, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-Workbuddy-Probe-Key": key
						},
						credentials: "same-origin",
						signal: controller.signal,
						body: JSON.stringify(action)
					});
					const value = await response.json().catch(() => void 0);
					if (!response.ok) {
						const message = typeof value === "object" && value !== null && "error" in value ? String(value["error"]) : `HTTP ${response.status}`;
						throw new Error(message);
					}
					if ((action.action === "set-maximum-context-window" || action.action === "set-model-visibility") && (typeof value !== "object" || value === null || value["state"] !== "updated")) {
						const state = typeof value === "object" && value !== null ? value["state"] : void 0;
						if (action.action === "set-model-visibility" && state === "stale-account") {
							await refresh(controller.signal);
							throw new Error(t("visibilityStaleAccount"));
						}
						const reason = typeof value === "object" && value !== null && "reason" in value ? String(value["reason"]) : t("requestFailed");
						throw new Error(reason);
					}
					await refresh(controller.signal);
				} catch (error) {
					if (mounted.current && controller.signal.aborted !== true) setReadFailure(error instanceof Error ? error.message : t("requestFailed"));
				} finally {
					manualControllers.current.delete(controller);
					if (!mounted.current) return;
					if (visibility) setTogglingModels((previous) => {
						const next = new Set(previous);
						next.delete(action.model);
						return next;
					});
					else setBusy(false);
				}
			}, [
				refresh,
				status,
				t,
				trackController,
				variant.probePath
			]);
			/**
			* Start a detection. Confirmation happens inline in the section, so this is
			* only ever called after the user has already agreed.
			*/
			const confirmDetect = (0, react.useCallback)((modelId) => {
				control({
					action: "probe",
					model: modelId
				});
			}, [control]);
			const title = t(variant.titleKey);
			const label = status === void 0 ? t("loading") : status.status === "signed-in" ? status.nickname === void 0 ? t("signedInAs", { nickname: "" }).trimEnd().replace(/[:：]$/, "") : t("signedInAs", { nickname: status.nickname }) : status.status === "error" ? t("requestFailed") : t("signedOut");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				style: cardStyle,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					style: headerStyle,
					"aria-expanded": open,
					"aria-label": `${t(open ? "collapse" : "expand")}: ${title}`,
					onClick: () => {
						setOpen(!open);
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: headTextStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: nameStyle,
							children: title
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: descriptionStyle,
							children: t(variant.introKey)
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						"aria-hidden": "true",
						style: {
							...chevronStyle,
							transform: open ? "rotate(180deg)" : "none"
						},
						children: "⌄"
					})]
				}), open ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: cardBodyStyle,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							style: quotaTitleStyle,
							children: t("accountHeading")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: rowStyle,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: statusStyle,
								role: "status",
								"aria-busy": status === void 0,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									"aria-hidden": "true",
									style: dotStyle(status === void 0 ? "loading" : status.status)
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label })]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: buttonStyle$1,
								disabled: busy,
								onClick: () => {
									manualRefresh();
								},
								children: busy ? t("refreshing") : t("refresh")
							})]
						}),
						readFailure === void 0 || signedIn === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: errorStyle,
							children: t("statusRefreshFailed", { message: readFailure })
						}),
						status?.status === "signed-in" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							status.expiresAt === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: bodyStyle,
								children: t("accessTokenExpires", { time: formatTime(status.expiresAt) })
							}),
							status.catalog === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: rowStyle,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: bodyStyle,
									children: [status.catalog.source === "live" && status.catalog.fetchedAt !== void 0 ? t("catalogLive", { time: formatTime(status.catalog.fetchedAt) }) : status.catalog.source === "saved" && status.catalog.fetchedAt !== void 0 ? t("catalogSaved", { time: formatTime(status.catalog.fetchedAt) }) : t("catalogFallback"), status.catalog.appVersion === void 0 ? "" : ` · ${t("catalogAppVersion", { version: status.catalog.appVersion })}`]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: buttonStyle$1,
									disabled: busy,
									onClick: () => {
										refreshModels();
									},
									children: busy ? t("refreshingModels") : t("refreshModels")
								})]
							}),
							status.catalog?.error === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: errorStyle,
								children: t("catalogError", { message: status.catalog.error })
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								role: "tablist",
								style: tabBarStyle,
								children: [
									"status",
									"context",
									"details"
								].map((id) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									role: "tab",
									"aria-selected": tab === id,
									onClick: () => {
										setTab(id);
									},
									style: {
										...tabStyle,
										...tab === id ? tabActiveStyle : {}
									},
									children: t(id === "status" ? "tabStatus" : id === "context" ? "tabContext" : "tabDetails")
								}, id))
							}),
							tab === "status" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: tabPanelStyle,
								children: [
									status.credits === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: quotaListStyle,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											style: rowStyle,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
												style: quotaTitleStyle,
												children: t("creditsHeading")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: bodyStyle,
												children: status.credits.unlimited === true ? t("creditsTotalUnlimited") : t("creditsTotal", { total: formatNumber(status.credits.total) })
											})]
										}), status.credits.cycleResetTime === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											style: descriptionStyle,
											children: t("cycleResetAt", { time: formatCycleReset(status.credits.cycleResetTime) })
										})]
									}),
									status.creditsError === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										style: errorStyle,
										children: t("creditsError", { message: status.creditsError })
									}),
									status.probe === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ProbeSection, {
										probe: status.probe,
										models: status.models,
										t,
										busy,
										onDetect: confirmDetect,
										onClear: () => {
											control({ action: "clear" });
										}
									})
								]
							}) : tab === "context" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: tabPanelStyle,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ContextTable, {
									models: status.models,
									t,
									contextPreferenceDisabled: busy,
									...variant.id === AI_CARD_VARIANT.id && status.useMaximumContextWindow !== void 0 ? {
										useMaximumContextWindow: status.useMaximumContextWindow,
										onUseMaximumContextWindow: (enabled) => {
											control({
												action: "set-maximum-context-window",
												enabled
											});
										}
									} : {},
									visibility: status.visibility,
									visibilityControlsDisabled: busy,
									visibilityToggling: togglingModels,
									onVisibilityToggle: (modelId, visible) => {
										control({
											action: "set-model-visibility",
											model: modelId,
											visible,
											account: status.visibility?.account ?? ""
										});
									}
								})
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: tabPanelStyle,
								children: [status.credits === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: quotaListStyle,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
										style: quotaTitleStyle,
										children: t("creditsDetailHeading")
									}), status.credits.accounts.filter((account) => account.packageName === "enterprise" || account.remain > 0 || account.unlimited === true).map((account, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CreditBar, {
										label: account.packageName === "enterprise" ? t("packageEnterprise") : account.packageName,
										remain: account.remain,
										size: account.size,
										unlimited: account.unlimited,
										t
									}, `${account.packageName}-${String(index)}`))]
								}), status.models === void 0 || status.models.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: quotaListStyle,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
										style: quotaTitleStyle,
										children: t("modelsHeading")
									}), status.models.filter((model) => model.free === true || (model.badges?.length ?? 0) > 0).map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelOfferRow, {
										model,
										t
									}, model.id))]
								})]
							})
						] }) : null,
						status?.status === "signed-out" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: status.reason === void 0 ? bodyStyle : errorStyle,
							children: status.reason ?? t(variant.signedOutKey)
						}) : null,
						status?.status === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: errorStyle,
							children: status.message
						}) : null
					]
				}) : null]
			});
		}
		//#endregion
		//#region src/client/WorkBuddyProbeControl.tsx
		/**
		* Per-model reasoning-effort entry beside the Composer's model selector.
		*
		* Interaction follows the Fast Mode control `dsh-codex-connect` ships in this
		* same seat, which is the established shape for composer chrome here:
		*
		* - a **static inline label** next to the icon names the feature ("Reasoning
		*   levels"), set smaller and dimmer than the surrounding chrome so it reads as
		*   an annotation on the icon. It never carries state: the verified levels
		*   already appear in the model dropdown (the adapter exposes them as
		*   selectable efforts), so repeating them here would duplicate the real answer
		*   and make the label's width jump as results change.
		* - a **hover/focus tooltip** carries the state and the click's purpose, the way
		*   Fast Mode's tooltip explains its current speed.
		* - the **confirmation** is a small bubble anchored to the control, not a
		*   `window.confirm`. Probing spends real credit, so a confirmation stays — but
		*   it belongs next to the thing it acts on, sized to one line plus two small
		*   buttons.
		*
		* @module dsh-workbuddy-connect/client/probe-control
		*/
		/**
		* The routes a selected provider's probe control should talk to.
		*
		* 遍历 {@link PROBE_TARGETS}（WorkBuddy 三卡 + Qoder），拿不到就返回
		* `undefined` —— 那正是"把这个图标从非探查渠道的模型旁边拿掉"的机制。
		* Trae 不在表内：它没有探查需求（档位由目录声明），详见 provider 注释。
		*/
		function cardVariantFor(provider) {
			return PROBE_TARGETS.find((card) => card.id === provider);
		}
		/** How often the control re-checks state when the window regains focus. */
		const RECONCILE_MS = 6e4;
		const wrapperStyle = {
			display: "inline-flex",
			position: "relative",
			alignItems: "center",
			transform: "translateY(2px)",
			marginRight: -8
		};
		const buttonStyle = {
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			gap: 2,
			height: 30,
			padding: "0 6px",
			border: 0,
			borderRadius: 8,
			background: "transparent",
			color: "var(--dsw-alias-label-secondary)",
			font: "inherit",
			whiteSpace: "nowrap",
			cursor: "pointer"
		};
		/**
		* The inline label. Smaller and dimmer than the surrounding chrome on purpose:
		* it names the feature, so it should read as an annotation attached to the icon
		* rather than compete with the adjacent model selector.
		*/
		const labelStyle = {
			fontSize: 11,
			lineHeight: "16px",
			color: "var(--dsw-alias-label-tertiary)"
		};
		/** Tooltip bubble: the Fast Mode shape (nowrap, one line, above the control). */
		const tooltipStyle = {
			position: "absolute",
			left: "50%",
			bottom: "calc(100% + 8px)",
			zIndex: 1e3,
			transform: "translateX(-50%)",
			padding: "4px 8px",
			borderRadius: 6,
			background: "var(--dsw-specific-tip, #1f2329)",
			boxShadow: "var(--dsw-shadow-lv2)",
			color: "var(--dsw-alias-label-primary, #fff)",
			fontSize: 12,
			lineHeight: "18px",
			whiteSpace: "nowrap",
			pointerEvents: "none"
		};
		/** Confirmation bubble: same anchor, but interactive and allowed to wrap. */
		const confirmStyle = {
			position: "absolute",
			right: 0,
			bottom: "calc(100% + 8px)",
			zIndex: 1001,
			display: "flex",
			flexDirection: "column",
			gap: 8,
			width: 260,
			padding: "10px 12px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 8,
			background: "var(--dsw-alias-bg-layer-1, #fff)",
			boxShadow: "var(--dsw-shadow-lv2)",
			color: "var(--dsw-alias-label-primary)",
			fontSize: 12,
			lineHeight: "18px"
		};
		const confirmRowStyle = {
			display: "flex",
			justifyContent: "flex-end",
			gap: 8
		};
		const confirmButtonStyle = {
			padding: "3px 10px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 6,
			background: "transparent",
			color: "inherit",
			font: "inherit",
			fontSize: 12,
			cursor: "pointer"
		};
		/**
		* Primary action inside the confirmation bubble.
		*
		* The fill and its text colour must come as a pair: `brand-primary` resolves to
		* a light accent in this theme, so hardcoding `color: #fff` on top of it renders
		* white-on-white. `button-primary-fill` + `label-primary-foreground` is the
		* theme's own pair for exactly this, and is what `dsh-codex-connect` uses for
		* the same job.
		*/
		const primaryButtonStyle = {
			...confirmButtonStyle,
			border: "1px solid var(--dsw-alias-button-primary-fill)",
			background: "var(--dsw-alias-button-primary-fill)",
			color: "var(--dsw-alias-label-primary-foreground)"
		};
		/**
		* Result note: a single line + a dismiss button, anchored to the control's
		* right side. Smaller than the confirmation bubble because it carries an
		* *outcome*, not a *decision* — the work is done, the user only has to read
		* and dismiss.
		*/
		const noteStyle = {
			position: "absolute",
			right: 0,
			bottom: "calc(100% + 8px)",
			zIndex: 1001,
			display: "flex",
			alignItems: "center",
			gap: 12,
			padding: "6px 10px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 8,
			background: "var(--dsw-alias-bg-layer-1)",
			boxShadow: "var(--dsw-shadow-lv2)",
			color: "var(--dsw-alias-label-primary)",
			fontSize: 12,
			lineHeight: "18px",
			whiteSpace: "nowrap"
		};
		/**
		* The note's dismiss action. Outlined rather than bare text: inside an already
		* bordered bubble, an unbordered word does not read as something you can click.
		* Matches the outlined pill convention the plugin's other secondary actions use.
		*/
		const noteDismissStyle = {
			padding: "2px 8px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 6,
			background: "transparent",
			color: "var(--dsw-alias-label-secondary)",
			font: "inherit",
			fontSize: 12,
			lineHeight: "18px",
			cursor: "pointer"
		};
		/**
		* The feature's static inline label. Deliberately not a state readout — see the
		* module comment.
		*/
		function useLabel(t) {
			return t("probeLabel");
		}
		/** Pick the model's recorded observation out of the probe section. */
		function resultFor(status, model) {
			if (status.status !== "signed-in") return void 0;
			return status.probe?.results.find((result) => result.id === model);
		}
		/**
		* The one-line tooltip: current state first, then what a click does — the same
		* two-part shape Fast Mode uses.
		*
		* A recorded result outranks a remembered failure. `failed` only means "the last
		* run from this control did not complete"; the host can record a result for the
		* same model at any time (a detection started from the settings card, another
		* conversation, or a finished sweep), and the levels the user paid for are the
		* more useful answer than the stale failure. Failure copy is what remains when
		* there is no result to report.
		*/
		function tooltipText(t, model, state) {
			if (state.busy) return t("probeRunning", { model });
			const result = state.result;
			if (result !== void 0) {
				if (result.validation === "validating" && result.efforts.length > 0) return t("probeTooltipVerified", { levels: result.efforts.join(" / ") });
				if (result.validation === "non-validating") return t("probeTooltipNotValidating");
				return t("probeTooltipRetry");
			}
			if (state.failed) return t("probeTooltipRetry");
			return t("probeTooltipIdle", { model });
		}
		/** Model-independent shell: resolves the selection, then delegates per model. */
		/**
		* [本地补丁 2026-09-23] composer 下方的一行：渠道 / 倍率 / 积分余量 + 签到。
		*
		* 动机：这些信息原本跟在 model.name 后缀里（宿主侧 withCatalogDisplay），
		* 而 DSH 核心 composer 底部行 .uV2eYG_row 是 flex-wrap:wrap、右组
		* .uV2eYG_trailing 又是 flex:none 不可收缩 —— 长模型名会把整组挤到第二行。
		* 本地已停用那个后缀（宿主 displaySuffix 直接返回 undefined），座位只留短名，
		* 这三项改在此处渲染（conversation.composer.dock 槽）。
		*
		* 刷新策略：宿主对该状态接口不做缓存，每次请求都会实时打一次 WorkBuddy
		* 账单接口，而插件自己的「推理等级」控件已在按 60 秒轮询。这一行是装饰信息，
		* 所以只在挂载 / 获得焦点 / 标签页重新可见时拉，5 分钟做底，隐藏时不拉。
		*
		* 还原：从 ~/.dsh/dsh-patch-backups/ 取回 client.js.<时间戳>.orig。
		*/
		/** 装饰行的兑底刷新间隔（毫秒）：5 分钟。 */
		const META_REFRESH_MS = 3e5;
		/** 焦点/可见性抖动保护：30 秒内不重复拉。 */
		const META_MIN_GAP_MS = 3e4;
		/** 当天已签到的记忆（`${account}:${day}`）：模块级，跨重挂载保留。 */
		const checkedInByDay = /* @__PURE__ */ new Map();
		const metaLineStyle = {
			color: "var(--dsw-alias-label-tertiary)",
			textAlign: "right",
			width: "100%",
			paddingRight: "8px",
			fontSize: "12px",
			lineHeight: "18px",
			fontVariantNumeric: "tabular-nums",
			whiteSpace: "nowrap",
			overflow: "hidden",
			textOverflow: "ellipsis"
		};
		const metaCheckinButtonStyle = {
			font: "inherit",
			color: "var(--dsw-alias-state-business-primary)",
			background: "0 0",
			border: "none",
			cursor: "pointer",
			padding: "0 2px"
		};
		const metaCheckinDoneStyle = {
			color: "var(--dsw-alias-state-success-primary)"
		};
		/** 本地日期串（YYYY-MM-DD），用作"今天"的键。 */
		function localDayKey() {
			const now = /* @__PURE__ */ new Date();
			return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
		}
		function WorkBuddyMetaLine({ directory, t }) {
			const subscribe = (0, react.useCallback)((listener) => directory.subscribe(listener), [directory]);
			const snapshot = (0, react.useCallback)(() => directory.getSnapshot(), [directory]);
			const selection = (0, react.useSyncExternalStore)(subscribe, snapshot, snapshot).current;
			const variant = selection == null ? void 0 : CARD_VARIANTS.find((card) => card.id === selection.provider);
			const statusPath = variant === void 0 ? void 0 : variant.statusPath;
			const [status, setStatus] = (0, react.useState)();
			const [claim, setClaim] = (0, react.useState)("idle");
			const [claimNote, setClaimNote] = (0, react.useState)();
			const loadRef = (0, react.useRef)();
			(0, react.useEffect)(() => {
				if (statusPath === void 0) return;
				let alive = true;
				let lastAt = 0;
				const controller = new AbortController();
				const load = async (force) => {
					if (!force) {
						if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
						if (Date.now() - lastAt < META_MIN_GAP_MS) return;
					}
					lastAt = Date.now();
					try {
						const response = await fetch(statusPath, {
							credentials: "same-origin",
							headers: { accept: "application/json" },
							signal: controller.signal
						});
						if (!response.ok) return;
						const value = await response.json().catch(() => void 0);
						if (alive && !controller.signal.aborted && isWorkBuddyWebStatus(value)) setStatus(value);
					} catch {
						/* 只读装饰：失败静默，绝不影响输入 */
					}
				};
				loadRef.current = load;
				const onFocus = () => {
					void load(false);
				};
				const onVisibility = () => {
					if (document.visibilityState === "visible") void load(false);
				};
				void load(true);
				const timer = window.setInterval(() => {
					void load(false);
				}, META_REFRESH_MS);
				window.addEventListener("focus", onFocus);
				document.addEventListener("visibilitychange", onVisibility);
				return () => {
					alive = false;
					controller.abort();
					window.clearInterval(timer);
					window.removeEventListener("focus", onFocus);
					document.removeEventListener("visibilitychange", onVisibility);
					loadRef.current = void 0;
				};
			}, [statusPath]);
			/** 账号 + 今天 = 签到记忆的键；换账号或跨天自动重置。 */
			const account = status?.visibility?.account ?? status?.nickname;
			const dayKey = account === void 0 ? void 0 : `${account}:${localDayKey()}`;
			(0, react.useEffect)(() => {
				if (dayKey === void 0) return;
				setClaim(checkedInByDay.has(dayKey) ? "done" : "idle");
				setClaimNote(void 0);
			}, [dayKey]);
			if (variant === void 0 || selection == null) return null;
			const checkinPath = statusPath === void 0 ? void 0 : `${statusPath.slice(0, -"/status".length)}/checkin`;
			const entry = status?.models?.find((model) => model.id === selection.model);
			const rate = entry?.credits === void 0 ? "—" : entry.credits;
			const credits = status?.credits === void 0 ? "—" : status.credits.unlimited === true ? t("unlimitedQuota") : formatNumber(status.credits.total);
			const onCheckin = async () => {
				if (checkinPath === void 0 || claim === "busy") return;
				setClaim("busy");
				setClaimNote(void 0);
				try {
					const response = await fetch(checkinPath, {
						method: "POST",
						credentials: "same-origin",
						headers: { accept: "application/json" }
					});
					const body = await response.json().catch(() => void 0);
					const state = body?.state;
					if (state === "claimed" || state === "already-claimed") {
						setClaim("done");
						if (dayKey !== void 0) checkedInByDay.set(dayKey, true);
						if (loadRef.current !== void 0) void loadRef.current(true);
					} else {
						setClaim("failed");
						setClaimNote(typeof body?.message === "string" && body.message !== "" ? body.message : `HTTP ${response.status}`);
					}
				} catch (error) {
					setClaim("failed");
					setClaimNote(error instanceof Error ? error.message : String(error));
				}
			};
			const checkinTitle = claim === "failed" && claimNote !== void 0 ? t("checkinFailed", { message: claimNote }) : t("checkinHint");
			const checkinNode = claim === "done"
				? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					key: "checkin",
					style: metaCheckinDoneStyle,
					children: ["✓ ", t("checkinDone")]
				})
				: claim === "busy"
					? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						key: "checkin",
						style: metaCheckinDoneStyle,
						children: t("checkinBusy")
					})
					: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						key: "checkin",
						type: "button",
						style: metaCheckinButtonStyle,
						title: checkinTitle,
						onClick: onCheckin,
						children: claim === "failed" ? t("checkinRetry") : t("checkinAction")
					});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: metaLineStyle,
				title: `${selection.provider}/${selection.model}`,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						key: "meta",
						children: t("metaLine", {
							channel: selection.provider,
							rate,
							credits
						})
					}),
					" · ",
					checkinNode
				]
			});
		}
		function WorkBuddyProbeControl({ directory, t }) {
			const subscribe = (0, react.useCallback)((listener) => directory.subscribe(listener), [directory]);
			const snapshot = (0, react.useCallback)(() => directory.getSnapshot(), [directory]);
			const selection = (0, react.useSyncExternalStore)(subscribe, snapshot, snapshot).current;
			// `getSnapshot().current` 在**没有选中模型**时是 `null`，不是 `undefined`。
			// 只判 `void 0` 会让下面读 `.provider` 抛 "Cannot read properties of null"，
			// 整个 `conversation.input.right` 条目被错误边界吃掉（界面上什么都不显示，
			// 控制台才有 "slot entry crashed"）。`== null` 一次覆盖 null 与 undefined。
			const missing = selection == null;
			const card = missing ? void 0 : cardVariantFor(selection.provider);
			const key = missing || card === void 0 ? void 0 : `${card.id}:${selection.model}`;
			return missing || card === void 0 || key === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelProbe, {
				model: selection.model,
				card,
				label: useLabel(t),
				t
			}, key);
		}
		function ModelProbe({ model, card, label, t }) {
			const [status, setStatus] = (0, react.useState)();
			const [busy, setBusy] = (0, react.useState)(false);
			const [confirming, setConfirming] = (0, react.useState)(false);
			const [tooltipVisible, setTooltipVisible] = (0, react.useState)(false);
			const [failed, setFailed] = (0, react.useState)(false);
			const [note, setNote] = (0, react.useState)();
			const inFlight = (0, react.useRef)(false);
			const mounted = (0, react.useRef)(false);
			const readSeq = (0, react.useRef)(0);
			const tooltipId = (0, react.useId)();
			const refresh = (0, react.useCallback)(async (signal) => {
				const seq = ++readSeq.current;
				const response = await fetch(card.statusPath, {
					credentials: "same-origin",
					headers: { accept: "application/json" },
					...signal === void 0 ? {} : { signal }
				});
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const value = await response.json().catch(() => void 0);
				if (!isWorkBuddyWebStatus(value)) throw new Error(t("statusResponseInvalid"));
				if (mounted.current && !signal?.aborted && seq === readSeq.current) setStatus(value);
			}, [card.statusPath, t]);
			(0, react.useEffect)(() => {
				mounted.current = true;
				const controller = new AbortController();
				const load = () => {
					refresh(controller.signal).catch(() => {});
				};
				load();
				const timer = window.setInterval(load, RECONCILE_MS);
				window.addEventListener("focus", load);
				return () => {
					mounted.current = false;
					controller.abort();
					window.clearInterval(timer);
					window.removeEventListener("focus", load);
				};
			}, [refresh]);
			const probe = status?.status === "signed-in" ? status.probe : void 0;
			const key = status?.status === "signed-in" ? status.probeKey : void 0;
			const result = status === void 0 ? void 0 : resultFor(status, model);
			const visible = probe?.candidates.includes(model) === true || result !== void 0;
			(0, react.useEffect)(() => {
				if (result !== void 0) setFailed(false);
			}, [result]);
			(0, react.useEffect)(() => {
				setConfirming(false);
				setNote(void 0);
			}, [model]);
			const detect = async () => {
				if (key === void 0 || inFlight.current || probe?.running === true) return;
				inFlight.current = true;
				setNote(void 0);
				setConfirming(false);
				setBusy(true);
				setFailed(false);
				try {
					const response = await fetch(card.probePath, {
						method: "POST",
						credentials: "same-origin",
						headers: {
							"Content-Type": "application/json",
							"X-WorkBuddy-Probe-Key": key
						},
						body: JSON.stringify({
							action: "probe",
							model
						})
					});
					const body = await response.json();
					if (!response.ok || body.state !== "ok" || body.validation !== "validating" && body.validation !== "non-validating" || !Array.isArray(body.efforts) || !body.efforts.every((effort) => typeof effort === "string")) throw new Error("probe failed");
					if (mounted.current) {
						const completed = {
							id: model,
							name: model,
							validation: body.validation,
							efforts: body.efforts,
							probedAt: Date.now()
						};
						setNote(completed);
					}
					refresh().catch(() => {});
				} catch {
					if (mounted.current) setFailed(true);
				} finally {
					inFlight.current = false;
					if (mounted.current) setBusy(false);
				}
			};
			if (!visible) return null;
			const text = tooltipText(t, model, {
				busy,
				result,
				failed
			});
			const disabled = busy || probe?.running === true || key === void 0;
			const showTooltip = tooltipVisible && !confirming && note === void 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				style: wrapperStyle,
				onMouseEnter: () => {
					setTooltipVisible(true);
				},
				onMouseLeave: () => {
					setTooltipVisible(false);
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						"aria-label": text,
						"aria-describedby": showTooltip ? tooltipId : void 0,
						"aria-busy": busy,
						"aria-expanded": confirming,
						disabled,
						onClick: () => {
							setConfirming(true);
						},
						onFocus: () => {
							setTooltipVisible(true);
						},
						onBlur: () => {
							setTooltipVisible(false);
						},
						style: {
							...buttonStyle,
							opacity: disabled && !confirming ? .6 : 1,
							cursor: disabled ? "default" : "pointer"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
							width: "16",
							height: "16",
							viewBox: "0 0 24 24",
							fill: "none",
							stroke: "currentColor",
							strokeWidth: "1.6",
							"aria-hidden": "true",
							focusable: "false",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
									cx: "12",
									cy: "12",
									r: "9"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
									cx: "12",
									cy: "12",
									r: "4"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M12 12 20 4" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
									cx: "12",
									cy: "12",
									r: "1"
								})
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: labelStyle,
							children: label
						})]
					}),
					showTooltip && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						id: tooltipId,
						role: "tooltip",
						style: tooltipStyle,
						children: text
					}),
					confirming && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: confirmStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("probeBubbleBody") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: confirmRowStyle,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: confirmButtonStyle,
								onClick: () => {
									setConfirming(false);
								},
								children: t("cancel")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: primaryButtonStyle,
								onClick: () => {
									detect();
								},
								children: t("probeConfirmAction")
							})]
						})]
					}),
					note === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						role: "status",
						"aria-live": "polite",
						style: noteStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: noteText(t, note) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: noteDismissStyle,
							onClick: () => {
								setNote(void 0);
							},
							children: t("probeNoteDismiss")
						})]
					})
				]
			});
		}
		/** Compose the one-line outcome string the note bubble shows. */
		function noteText(t, result) {
			if (result.validation === "validating" && result.efforts.length > 0) return t("probeNoteVerified", { levels: result.efforts.join(" / ") });
			if (result.validation === "non-validating") return t("probeNoteNotValidating");
			return t("probeNoteUnknown");
		}
		//#endregion
		//#region src/client/WorkBuddyConfigPage.tsx
		/**
		* The cards' list; the page supplies no other chrome. A semantic `<ul>` —
		* each card below is an `<li>` — with the user-agent list defaults cleared so
		* only the column/gap rhythm remains, keeping the layout identical to the
		* flex column it replaced while giving the page real list semantics.
		*/
		const pageStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 12,
			listStyle: "none",
			margin: 0,
			padding: 0
		};
		/**
		* Render the bundle's configuration: one status card per WorkBuddy variant.
		*
		* Both variants share one page. DSH 0.1.6 replaced the settings section's
		* keyed `settings.plugin.item` slot — dispatched once per served settings
		* namespace, which is why the two variants used to be two cards — with the
		* Plugins page's `plugins.bundle.config`, keyed by the bundle's package name.
		* A bundle therefore carries exactly one configuration entry, so the cards are
		* stacked here instead of being dispatched separately. (The 0.1.5 settings tab
		* and its two dispatched cards still exist on 0.1.5 hosts; this page only
		* mounts where the Plugins page declares its slot.)
		*/
		function WorkBuddyConfigPage({ view, t }) {
			if (view === "summary") return t("intro");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
				style: pageStyle,
				children: CARD_VARIANTS.map((variant) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(WorkBuddyPluginCard, {
					t,
					variant
				}, variant.id))
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/** Plugin-card copy registered under the settings.workbuddy locale namespace. */
		const en = {
			title: "DSH WorkBuddy Connect",
			intro: "Use the models in the WorkBuddy desktop app directly in DSH — zero configuration, ready out of the box.",
			titleAI: "DSH WorkBuddy AI Connect",
			introAI: "Use the models in the WorkBuddy AI international desktop app directly in DSH — zero configuration, ready out of the box.",
			expand: "Expand",
			collapse: "Collapse",
			loading: "Loading account…",
			signedOut: "Not signed in",
			signedOutHint: "Sign in once in the WorkBuddy desktop app; this plugin follows that sign-in automatically.",
			signedOutHintAI: "Sign in once in the WorkBuddy AI desktop app; this plugin follows that sign-in automatically.",
			title1: "WorkBuddy account 1",
			title2: "WorkBuddy account 2",
			intro1: "Models from WorkBuddy account 1 (set WORKBUDDY1_AUTH_FILE to its credential file).",
			intro2: "Models from WorkBuddy account 2 (set WORKBUDDY2_AUTH_FILE to its credential file).",
			signedOutHint1: "Point WORKBUDDY1_AUTH_FILE at account 1's plaintext credential file.",
			signedOutHint2: "Point WORKBUDDY2_AUTH_FILE at account 2's plaintext credential file.",
			title3: "WorkBuddy Enterprise",
			intro3: "Models from the enterprise WorkBuddy account (set WORKBUDDY3_AUTH_FILE to its credential file). Enterprise credit is read from its own quota endpoint.",
			signedOutHint3: "Point WORKBUDDY3_AUTH_FILE at the enterprise account's plaintext credential file.",
			signedInAs: "Signed in as {nickname}",
			accessTokenExpires: "Access token expires {time} (refresh is automatic)",
			creditsHeading: "Remaining credit",
			metaLine: "Channel {channel} · Rate {rate} · Credit {credits}",
			checkinAction: "Check in",
			checkinBusy: "Checking in…",
			checkinDone: "Checked in",
			checkinRetry: "Retry check-in",
			checkinHint: "Claim today’s check-in credit",
			checkinFailed: "Check-in failed: {message}",
			tabStatus: "Status",
			tabContext: "Context window",
			tabDetails: "Credit details",
			creditsDetailHeading: "By package",
			creditsTotal: "Total: {total}",
			creditsTotalUnlimited: "Total: Unlimited",
			unlimitedQuota: "Unlimited",
			packageEnterprise: "Enterprise quota",
			cycleResetAt: "Resets {time}",
			percentRemaining: "{percent}% remaining",
			percentUnknown: "Remaining share unknown",
			exactRemaining: "{remain} / {size} remaining",
			creditPackageUnknownSize: "{remain} remaining",
			creditsError: "Credit unavailable: {message}",
			refresh: "Refresh",
			refreshing: "Refreshing…",
			refreshModels: "Refresh model list",
			refreshingModels: "Refreshing models…",
			catalogLive: "Model list updated {time}",
			catalogSaved: "Showing the saved model list from {time}",
			catalogFallback: "Showing the built-in model list (not yet updated from WorkBuddy)",
			catalogError: "Last update failed: {message}",
			catalogAppVersion: "App version {version}",
			requestFailed: "Request failed",
			statusRefreshFailed: "Refresh failed: {message} — showing the last known state",
			statusResponseInvalid: "WorkBuddy returned an unreadable status reply",
			accountHeading: "Account",
			modelsHeading: "Model offers",
			contextHeading: "Context window",
			contextUpTo: "up to {size}",
			contextDefault: "default {size}",
			contextUnknown: "no declared context window",
			useMaximumContextWindow: "Use the largest declared context window",
			useMaximumContextWindowHint: "Applies to WorkBuddy AI models that offer a larger window.",
			visibilityIntro: "Uncheck a model to hide it from the model picker. Saved per signed-in account; chats already using a hidden model keep working.",
			visibilityStaleAccount: "The signed-in account changed — this change was not saved.",
			freeModel: "Free",
			badgeLimitedFree: "Limited-time free",
			badgeNightDiscount: "Night discount",
			badgeFreeNow: "Free now",
			rate: "{rate} credits per message",
			rateUnknown: "Price unavailable — refresh to update",
			probeLabel: "Reasoning levels",
			probeTooltipIdle: "Detect the reasoning levels {model} accepts",
			probeTooltipVerified: "Accepted levels: {levels} · click to detect again",
			probeTooltipNotValidating: "This model does not check the effort parameter",
			probeTooltipRetry: "Detection did not complete · click to retry",
			probeBubbleBody: "Send test requests to confirm the available reasoning levels. May consume a small amount of credit.",
			probeConfirmAction: "Confirm",
			probeNoteVerified: "Detected: {levels}",
			probeNoteNotValidating: "This model does not check the effort parameter",
			probeNoteUnknown: "Detection did not complete",
			probeNoteDismiss: "Got it",
			probeHeading: "Reasoning effort detection",
			probeResultNoLevels: "No tested levels were accepted.",
			probeIntro: "Some models reason but declare no selectable effort levels. Detecting which levels a model accepts sends a few real requests that may consume credit.",
			probeConsentHint: "Each detection sends test requests to one model to confirm its available reasoning levels, and may consume a small amount of credit.",
			probeStart: "Detect",
			probeRedetect: "Detect again",
			probeRunning: "Detecting {model}…",
			probeRunningGeneric: "Detecting…",
			probeClear: "Clear detected results",
			probeCandidates: "Detectable models: {count}",
			probeConfirmBody: "Send test requests to {model} to confirm its available reasoning levels. May consume a small amount of credit.",
			cancel: "Cancel",
			probeResultVerified: "Verified levels: {levels}",
			probeResultNotValidating: "This model does not check the effort parameter",
			probeResultUnknown: "Detection did not complete",
			probeResultAt: "Detected {time}",
			probeResultEmpty: "No detectable models right now.",
			probeFailed: "Detection failed: {message}"
		};
		const zh = {
			title: "DSH WorkBuddy Connect",
			intro: "在 DSH 中直接使用 WorkBuddy 桌面 App 包含的模型，开箱即用，无需额外配置。",
			titleAI: "DSH WorkBuddy AI Connect",
			introAI: "在 DSH 中直接使用 WorkBuddy AI 国际版桌面 App 包含的模型，开箱即用，无需额外配置。",
			expand: "展开",
			collapse: "收起",
			loading: "正在读取账号…",
			signedOut: "未登录",
			signedOutHint: "在 WorkBuddy 桌面 App 里登录一次即可，插件会自动跟随当前登录的账号。",
			signedOutHintAI: "在 WorkBuddy AI 国际版桌面 App 里登录一次即可，插件会自动跟随当前登录的账号。",
			title1: "WorkBuddy 账号 1",
			title2: "WorkBuddy 账号 2",
			intro1: "使用 WorkBuddy 账号 1 的模型（把 WORKBUDDY1_AUTH_FILE 指向它的凭据文件）。",
			intro2: "使用 WorkBuddy 账号 2 的模型（把 WORKBUDDY2_AUTH_FILE 指向它的凭据文件）。",
			signedOutHint1: "请把 WORKBUDDY1_AUTH_FILE 指向账号 1 的明文凭据文件。",
			signedOutHint2: "请把 WORKBUDDY2_AUTH_FILE 指向账号 2 的明文凭据文件。",
			title3: "WorkBuddy 企业版",
			intro3: "使用企业版 WorkBuddy 账号的模型（把 WORKBUDDY3_AUTH_FILE 指向它的凭据文件）；额度按企业版自己的周期总额读取。",
			signedOutHint3: "请把 WORKBUDDY3_AUTH_FILE 指向企业版账号的明文凭据文件。",
			signedInAs: "已登录：{nickname}",
			accessTokenExpires: "访问令牌 {time} 过期（自动续期）",
			creditsHeading: "剩余积分",
			metaLine: "渠道 {channel} · 倍率 {rate} · 积分余量 {credits}",
			checkinAction: "签到",
			checkinBusy: "签到中…",
			checkinDone: "已签到",
			checkinRetry: "重试签到",
			checkinHint: "领取今日签到积分",
			checkinFailed: "签到失败：{message}",
			tabStatus: "状态",
			tabContext: "上下文窗口",
			tabDetails: "积分详情",
			creditsDetailHeading: "按套餐",
			creditsTotal: "合计：{total}",
			creditsTotalUnlimited: "合计：不限额",
			unlimitedQuota: "不限额",
			packageEnterprise: "企业额度",
			cycleResetAt: "重置时间：{time}",
			percentRemaining: "剩余 {percent}%",
			percentUnknown: "剩余占比未知",
			exactRemaining: "剩余 {remain} / {size}",
			creditPackageUnknownSize: "剩余 {remain}",
			creditsError: "积分查询失败：{message}",
			refresh: "刷新",
			refreshing: "正在刷新…",
			refreshModels: "刷新模型列表",
			refreshingModels: "正在刷新模型…",
			catalogLive: "模型列表更新于 {time}",
			catalogSaved: "当前显示已保存的模型列表，更新于 {time}",
			catalogFallback: "当前显示内置模型列表（尚未从 WorkBuddy 更新）",
			catalogError: "上次更新失败：{message}",
			catalogAppVersion: "App 版本 {version}",
			requestFailed: "请求失败",
			statusRefreshFailed: "刷新失败：{message} — 当前显示的是上次成功获取的状态",
			statusResponseInvalid: "WorkBuddy 返回的状态数据无法识别",
			accountHeading: "账号",
			modelsHeading: "模型优惠",
			contextHeading: "上下文窗口",
			contextUpTo: "最高 {size}",
			contextDefault: "默认 {size}",
			contextUnknown: "未声明上下文窗口",
			useMaximumContextWindow: "使用上游声明的最大上下文窗口",
			useMaximumContextWindowHint: "仅作用于 WorkBuddy AI 中声明了更大窗口的模型。",
			visibilityIntro: "取消勾选即可在模型选择器中隐藏该模型；按当前登录账号分别保存，已在用该模型的会话不受影响。",
			visibilityStaleAccount: "登录账号已切换——本次修改未保存。",
			freeModel: "免费",
			badgeLimitedFree: "限时免费",
			badgeNightDiscount: "夜间折扣",
			badgeFreeNow: "限时免费",
			rate: "{rate} 积分/次",
			rateUnknown: "价格未知 — 刷新后更新",
			probeLabel: "推理等级",
			probeTooltipIdle: "检测 {model} 可用的推理档位",
			probeTooltipVerified: "已接受：{levels} · 点击可重新检测",
			probeTooltipNotValidating: "该模型不校验该参数",
			probeTooltipRetry: "检测未完成 · 点击重试",
			probeBubbleBody: "发送探测请求以确认可用推理档位。可能消耗少量积分。",
			probeConfirmAction: "确认检测",
			probeNoteVerified: "已检测：{levels}",
			probeNoteNotValidating: "该模型不校验该参数",
			probeNoteUnknown: "检测未完成",
			probeNoteDismiss: "知道了",
			probeHeading: "推理档位检测",
			probeResultNoLevels: "本次测试的档位均未被接受。",
			probeIntro: "部分模型具备思考能力，但没有声明可选档位。检测会发送少量真实请求，可能消耗积分。",
			probeConsentHint: "每次检测会向该模型发送探测请求，以确认可用推理档位，可能消耗少量积分。",
			probeStart: "开始检测",
			probeRedetect: "重新检测",
			probeRunning: "正在检测 {model}…",
			probeRunningGeneric: "正在检测…",
			probeClear: "清除已探测结果",
			probeCandidates: "可检测模型：{count} 个",
			probeConfirmBody: "向 {model} 发送探测请求，以确认可用推理档位。可能消耗少量积分。",
			cancel: "取消",
			probeResultVerified: "已验证接受的档位：{levels}",
			probeResultNotValidating: "该模型不校验该参数",
			probeResultUnknown: "检测未完成",
			probeResultAt: "检测于 {time}",
			probeResultEmpty: "当前没有可检测的模型。",
			probeFailed: "检测失败：{message}"
		};
		//#endregion
		//#region src/client/index.tsx
		/** Stable browser-plugin name. */
		const name = "dsh-workbuddy-connect-client";
		/**
		* The bundle's package name, which is also this half's configuration key.
		*
		* The Plugins page dispatches `plugins.bundle.config` by the bundle's package
		* name, so the key has to spell exactly what the profile installs.
		*/
		const BUNDLE_NAME = "dsh-workbuddy-connect";
		/**
		* Client services required by this browser half.
		*
		* DSH 0.1.2 removed `@deepseek-ai/dsh-client-runtime` (the package that used to
		* hold the browser `ClientContext` alias and the `slots` service), so the
		* services come from narrower packages: the `slots` registry lives in
		* `@deepseek-ai/dsh-client-ui-renderer` and `locale` in
		* `@deepseek-ai/dsh-client-locale`. Neither slot owner is named here on
		* purpose: `settings.plugin.item`'s declarer (`…-ui-settings-plugins`) is
		* absent from 0.1.6+ hosts and `plugins.bundle.config`'s declarer
		* (`…-ui-plugin-manager`) is absent from 0.1.5 hosts, and the seam choice is
		* made by slot-declaration lifetime, not by activation order — `ctx.slots.inject`
		* fires whenever the declaring package commits the slot, before or after this
		* fiber starts.
		*/
		const inject = [
			"slots",
			"locale",
			"remote",
			"remote.session"
		];
		/** Prefix every guarded client contribution's degradation logs with this. */
		const CLIENT_CONTRIBUTION_FAILED = "[dsh-workbuddy-connect] client contribution failed to load (host provider unaffected):";
		/** Disposer handed back when a deferred registration degraded: nothing to undo. */
		const NOOP_DISPOSER = () => {};
		/**
		* Run ONE browser-side contribution, degrading its failure to a `console.error`
		* instead of throwing into the DSH loader. Returns the contribution's own
		* value on success, or `undefined` when it degraded — the deferred slot
		* callbacks below substitute `NOOP_DISPOSER` for that, because the slot
		* runtime always expects a disposer back.
		*
		* Every contribution is guarded at BOTH boundaries where it can throw:
		*
		* 1. the eager `ctx.slots.inject(...)` / `ctx.inject(...)` call itself, which
		*    runs synchronously inside `apply()` — e.g. a slot-API shape break such as
		*    the rc.6→rc.7 `id`→`key` rename;
		* 2. the deferred callback, which the slot runtime invokes later — when the
		*    owner commits the slot's declaration, or when the injected services
		*    arrive — long after `apply()` has returned, where no enclosing try/catch
		*    could still catch it.
		*
		* The pair is what makes the contributions independent: a failure in one
		* settings seam, or in the probe control, leaves every other registration
		* intact. Guards are for THIS browser half only; the host half reports its own
		* errors through `ctx.logger`.
		*/
		function guardClientContribution(label, fn) {
			try {
				return fn();
			} catch (error) {
				console.error(`${CLIENT_CONTRIBUTION_FAILED} ${label}`, error);
				return;
			}
		}
		/**
		* Register the card copy and both settings-surface seams, one guarded
		* contribution at a time.
		*
		* A DSH slot-API breaking change degrades to a `console.error` per
		* contribution instead of throwing into the DSH loader and raising the red
		* "Failed to load plugins" banner; because each contribution carries its own
		* guard, one failing registration never takes the others with it (the old
		* settings cards survive a broken Plugins-page seam, and the probe control
		* survives either). The host provider keeps working throughout: the
		* `workbuddy` model channel is unaffected, and `dsh-workbuddy-connect status`
		* reports host health via the heartbeat file.
		*
		* The tests import this function directly (`tests/client-fallback.spec.ts`),
		* so its isolation semantics are pinned against the real entry — keep any
		* change to the guarded structure in sync with that spec.
		*/
		function apply(ctx, options) {
			const namespace = "settings.workbuddy";
			guardClientContribution("settings copy", () => {
				ctx.effect(() => ctx.locale.register(namespace, {
					zh,
					en
				}), "dsh-workbuddy-connect: settings copy");
			});
			const t = ctx.locale.bind(namespace);
			for (const [index, variant] of CARD_VARIANTS.entries()) {
				const label = `settings.plugin.item card "${variant.id}"`;
				guardClientContribution(label, () => {
					ctx.slots.inject("settings.plugin.item", () => guardClientContribution(label, () => ctx.slots.register({
						name: "settings.plugin.item",
						key: variant.id,
						priority: 30 - index,
						inject: () => ({
							t,
							variant
						})
					}, WorkBuddyPluginCard)) ?? NOOP_DISPOSER);
				});
			}
			guardClientContribution("plugins.bundle.config page", () => {
				ctx.slots.inject("plugins.bundle.config", () => guardClientContribution("plugins.bundle.config page", () => ctx.slots.register({
					name: "plugins.bundle.config",
					key: "dsh-workbuddy-connect",
					locale: namespace
				}, WorkBuddyConfigPage)) ?? NOOP_DISPOSER);
			});
			guardClientContribution("conversation probe control", () => {
				ctx.inject(["modelDirectories"], (scope) => {
					guardClientContribution("conversation probe control", () => {
						scope.slots.inject("conversation.input.right", () => guardClientContribution("conversation probe control", () => scope.slots.register({
							name: "conversation.input.right",
							id: "workbuddy-probe",
							order: 10,
							inject: (sessionId) => ({
								directory: scope.modelDirectories.directoryFor(sessionId).store,
								t
							})
						}, WorkBuddyProbeControl)) ?? NOOP_DISPOSER);
					});
				});
			});
			/* [本地补丁 2026-09-23] 把「渠道 · 倍率 · 积分余量 · 签到」挂到 composer 下方的 dock 槽。 */
			/* [dsh-connect 2026-09-24] 三合一后「渠道 · 倍率 · 积分余量 · 签到」这些信息
			 * 已并进统一面板的按钮里，由 lib/index.js 传 options.skipDock 拦掉，
			 * 免得 composer 下方同时出现两行。其余贡献（设置卡片等）照旧。 */
			if (!options || options.skipDock !== true) guardClientContribution("conversation meta line", () => {
				ctx.inject(["modelDirectories"], (scope) => {
					guardClientContribution("conversation meta line", () => {
						scope.slots.inject("conversation.composer.dock", () => guardClientContribution("conversation meta line", () => scope.slots.register({
							name: "conversation.composer.dock",
							id: "workbuddy-meta",
							order: 20,
							inject: (sessionId) => ({
								directory: scope.modelDirectories.directoryFor(sessionId).store,
								t
							})
						}, WorkBuddyMetaLine) ?? NOOP_DISPOSER));
					});
				});
			});
		}
		//#endregion
		exports.BUNDLE_NAME = BUNDLE_NAME;
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		
			return module.exports;
		})();

		// ══ dsh-trae-connect 的客户端半侧（原样搬入，独立作用域）══
		const traeClient = (() => {
			var module = { exports: {} };
			var exports = module.exports;
			Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		
		
		

		/** 只用 createElement，不 require jsx-runtime —— 少一个依赖面。 */
		const react = require("react");

		//#region 常量
		/** 与宿主侧 index.js 里的 TRAE_STATUS_ROUTE / TRAE_CHECKIN_ROUTE 必须逐字一致。 */
		const STATUS_PATH = "/plugins/dsh-trae-connect/status";
		const CHECKIN_PATH = "/plugins/dsh-trae-connect/checkin";
		/** 选中模型所属的 provider id。 */
		const PROVIDER_ID = "trae";

		/** 底刷新间隔：这一行是装饰信息，不值得频繁打上游。 */
		const REFRESH_MS = 300000;
		/** 焦点/可见性抖动的保护间隔。 */
		const MIN_GAP_MS = 30000;

		/**
		 * 当天已签到的记忆，键是 `${账号}:${本地日期}`。
		 *
		 * 模块级而不是组件级：DSH 会在切换会话时重挂载这个组件，放组件里会导致
		 * 「签到完了、切个会话回来又变成未签到」。服务端本来就是幂等的，
		 * 这里只是让界面别闪。
		 */
		const checkedInByDay = new Map();

		const lineStyle = {
			color: "var(--dsw-alias-label-tertiary)",
			textAlign: "right",
			width: "100%",
			paddingRight: "8px",
			fontSize: "12px",
			lineHeight: "18px",
			fontVariantNumeric: "tabular-nums",
			whiteSpace: "nowrap",
			overflow: "hidden",
			textOverflow: "ellipsis",
		};
		const linkStyle = {
			font: "inherit",
			color: "var(--dsw-alias-state-business-primary)",
			background: "0 0",
			border: "none",
			cursor: "pointer",
			padding: "0 2px",
		};
		const doneStyle = { color: "var(--dsw-alias-state-success-primary)" };
		/** 槽契约异常时的空目录：永远没有选中项，组件因此不渲染任何东西。 */
		const EMPTY_DIRECTORY = {
			subscribe: () => () => {},
			getSnapshot: () => ({ current: undefined }),
		};
		//#endregion

		//#region 工具
		/** 本地日期（YYYY-MM-DD）。用本地而不是 UTC，否则时区一偏就跨天。 */
		function localDayKey() {
			const now = new Date();
			return [
				now.getFullYear(),
				String(now.getMonth() + 1).padStart(2, "0"),
				String(now.getDate()).padStart(2, "0"),
			].join("-");
		}

		/** 数字展示：整数不带小数，小数最多两位（顺带加千分位）。 */
		function formatNumber(value) {
			if (typeof value !== "number" || !Number.isFinite(value)) return "—";
			return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
		}

		/** 后端契约的最小校验：形状不对就当没读到，绝不把半成品放进 state。 */
		function isStatusDocument(value) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
			const status = value.status;
			return status === "signed-out" || status === "signed-in";
		}
		//#endregion

		//#region 组件
		/**
		 * composer 下方那一行。
		 *
		 * 刷新策略与 WorkBuddy 那条一致：只在挂载 / 窗口获得焦点 / 标签页重新可见时
		 * 拉，5 分钟兜底，页面隐藏时不拉 —— 宿主对状态接口不做缓存，每次请求都会
		 * 实打实打一次 Trae 的额度接口。
		 */
		function TraeMetaLine(props) {
			/**
			 * `directory` 正常一定由槽的 inject 提供；万一 DSH 换了槽契约，
			 * 这里退化成一个空目录而不是让渲染抛错（渲染期抛错会连累整个 composer）。
			 */
			const directory = props.directory ?? EMPTY_DIRECTORY;
			const t = props.t;

			const subscribe = react.useCallback((listener) => directory.subscribe(listener), [directory]);
			const snapshot = react.useCallback(() => directory.getSnapshot(), [directory]);
			const selection = react.useSyncExternalStore(subscribe, snapshot, snapshot).current;

			const [status, setStatus] = react.useState(undefined);
			const [claim, setClaim] = react.useState("idle");
			const [note, setNote] = react.useState(undefined);

			/** 只有选中 trae 的模型时才需要这些网络请求。 */
			// `getSnapshot().current` 没选中模型时是 `null` 而非 `undefined` ——
			// 用 `!== undefined` 判断会放过 null，下一句读 `.provider` 就抛。
			const active = selection != null && selection.provider === PROVIDER_ID;
			const loadRef = react.useRef(undefined);

			react.useEffect(() => {
				if (!active) {
					setStatus(undefined);
					return undefined;
				}
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
						const response = await fetch(STATUS_PATH, {
							credentials: "same-origin",
							headers: { accept: "application/json" },
							signal: controller.signal,
						});
						if (!response.ok) return;
						const value = await response.json().catch(() => undefined);
						if (alive && !controller.signal.aborted && isStatusDocument(value)) setStatus(value);
					} catch {
						/* 只读装饰：失败静默，绝不影响输入框 */
					}
				};
				loadRef.current = load;
				const onFocus = () => { void load(false); };
				const onVisibility = () => {
					if (document.visibilityState === "visible") void load(false);
				};
				void load(true);
				const timer = window.setInterval(() => { void load(false); }, REFRESH_MS);
				window.addEventListener("focus", onFocus);
				document.addEventListener("visibilitychange", onVisibility);
				return () => {
					alive = false;
					controller.abort();
					window.clearInterval(timer);
					window.removeEventListener("focus", onFocus);
					document.removeEventListener("visibilitychange", onVisibility);
					loadRef.current = undefined;
				};
			}, [active]);
			/** 换账号或跨天要重置签到记忆。 */
			const account = status === undefined ? undefined : status.account;
			const dayKey = account === undefined || account === "" ? undefined : `${account}:${localDayKey()}`;
			react.useEffect(() => {
				if (dayKey === undefined) return;
				setClaim(checkedInByDay.has(dayKey) ? "done" : "idle");
				setNote(undefined);
			}, [dayKey]);

			/** 记住了「今天已签」时，也要让按钮显示成已签（服务端可能还没被重新拉取）。 */
			const checkedInNow =
				(status !== undefined && status.checkin !== undefined && status.checkin.checkedIn === true) ||
				(dayKey !== undefined && checkedInByDay.has(dayKey));

			if (!active) return null;

			const accountLabel = status === undefined ? undefined : status.account;
			const credits = status === undefined ? undefined : status.credits;
			const creditsText =
				status === undefined
					? t("loading")
					: status.creditsError !== undefined
						? t("creditsUnavailable")
						: credits === undefined
							? t("loading")
							: credits.remain !== undefined && credits.total !== undefined
								? t("creditsPair", { remain: formatNumber(credits.remain), total: formatNumber(credits.total) })
								: credits.remain !== undefined
									? t("creditsSolo", { remain: formatNumber(credits.remain) })
									: "—";

			const reward =
				status === undefined || status.checkin === undefined ? undefined : status.checkin.credits;

			const onCheckin = async () => {
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
					const state = body === undefined ? undefined : body.state;
					if (state === "claimed" || state === "already-claimed") {
						setClaim("done");
						if (dayKey !== undefined) checkedInByDay.set(dayKey, true);
						if (loadRef.current !== undefined) void loadRef.current(true);
					} else {
						setClaim("failed");
						const message = body !== undefined && typeof body.message === "string" && body.message !== "" ? body.message : `HTTP ${response.status}`;
						setNote(state === "disabled" ? t("checkinDisabled") : message);
					}
				} catch (error) {
					setClaim("failed");
					setNote(error instanceof Error ? error.message : String(error));
				}
			};

			const checkinTitle =
				claim === "failed" && note !== undefined
					? t("checkinFailed", { message: note })
					: reward !== undefined
						? t("checkinRewardHint", { credits: formatNumber(reward) })
						: t("checkinHint");

			let checkinNode;
			if (checkedInNow && claim !== "busy") {
				checkinNode = react.createElement("span", { key: "checkin", style: doneStyle }, "✓ " + t("checkinDone"));
			} else if (claim === "busy") {
				checkinNode = react.createElement("span", { key: "checkin", style: doneStyle }, t("checkinBusy"));
			} else {
				checkinNode = react.createElement(
					"button",
					{ key: "checkin", type: "button", style: linkStyle, title: checkinTitle, onClick: onCheckin },
					claim === "failed" ? t("checkinRetry") : reward !== undefined ? t("checkinActionWith", { credits: formatNumber(reward) }) : t("checkinAction"),
				);
			}

			const segments = [t("channelLine", { channel: status !== undefined && status.channel ? status.channel : "Trae", credits: creditsText })];
			if (accountLabel !== undefined && accountLabel !== "") segments.push(accountLabel);

			return react.createElement(
				"div",
				{
					style: lineStyle,
					title: `${PROVIDER_ID}/${selection.model} · ${checkinTitle}`,
				},
				react.createElement("span", { key: "meta" }, segments.join(" · ")),
				" · ",
				checkinNode,
			);
		}
		//#endregion

		//#region 文案
		const zh = {
			channelLine: "渠道 {channel} · 剩余积分 {credits}",
			creditsPair: "{remain} / {total}",
			creditsSolo: "{remain}",
			creditsUnavailable: "查询失败",
			loading: "读取中…",
			checkinAction: "签到",
			checkinActionWith: "签到 +{credits}",
			checkinBusy: "签到中…",
			checkinDone: "已签到",
			checkinRetry: "重试签到",
			checkinHint: "领取今日签到积分",
			checkinRewardHint: "领取今日签到积分（+{credits}）",
			checkinDisabled: "Trae 当前未开放签到",
			checkinFailed: "签到失败：{message}",
		};
		const en = {
			channelLine: "Channel {channel} · Credit {credits}",
			creditsPair: "{remain} / {total}",
			creditsSolo: "{remain}",
			creditsUnavailable: "unavailable",
			loading: "loading…",
			checkinAction: "Check in",
			checkinActionWith: "Check in +{credits}",
			checkinBusy: "Checking in…",
			checkinDone: "Checked in",
			checkinRetry: "Retry check-in",
			checkinHint: "Claim today’s check-in credit",
			checkinRewardHint: "Claim today’s check-in credit (+{credits})",
			checkinDisabled: "Trae check-in is not open right now",
			checkinFailed: "Check-in failed: {message}",
		};
		//#endregion

		//#region 插件入口
		/** 稳定浏览器插件名。 */
		const name = "dsh-trae-connect-client";
		const inject = ["slots", "locale"];

		/** 某个贡献抛错时降级成 console.error，不要毒死整个客户端加载器。 */
		const CONTRIBUTION_FAILED = "[dsh-trae-connect] client contribution failed to load (host provider unaffected):";
		function guard(label, fn) {
			try {
				return fn();
			} catch (error) {
				console.error(CONTRIBUTION_FAILED + " " + label, error);
				return undefined;
			}
		}

		function apply(ctx, options) {
			const namespace = "settings.trae";
			guard("copy", () => {
				ctx.effect(() => ctx.locale.register(namespace, { zh, en }), "dsh-trae-connect: copy");
			});
			const t = ctx.locale.bind(namespace);

			/* [dsh-connect 2026-09-24] 三合一后「渠道 · 倍率 · 积分余量 · 签到」这些信息
			 * 已并进统一面板的按钮里，由 lib/index.js 传 options.skipDock 拦掉，
			 * 免得 composer 下方同时出现两行。其余贡献（设置卡片等）照旧。 */
			if (!options || options.skipDock !== true) guard("conversation meta line", () => {
				ctx.inject(["modelDirectories"], (scope) => {
					guard("conversation meta line", () => {
						scope.slots.inject("conversation.composer.dock", () =>
							guard("conversation composer dock", () =>
								scope.slots.register(
									{
										name: "conversation.composer.dock",
										id: "trae-meta",
										order: 21,
										inject: (sessionId) => ({
											directory: scope.modelDirectories.directoryFor(sessionId).store,
											t,
										}),
									},
									TraeMetaLine,
								),
							),
						);
					});
				});
			});
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		
			return module.exports;
		})();

		// ══ dsh-qoder-connect 的客户端半侧（原样搬入，独立作用域）══
		const qoderClient = (() => {
			var module = { exports: {} };
			var exports = module.exports;
			Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		
		
		

		/** 只用 createElement，不 require jsx-runtime —— 少一个依赖面。 */
		const react = require("react");

		//#region 常量
		/** 与宿主侧 index.js 里的 QODER_STATUS_ROUTE / QODER_CHECKIN_ROUTE 必须逐字一致。 */
		const STATUS_PATH = "/plugins/dsh-qoder-connect/status";
		const CHECKIN_PATH = "/plugins/dsh-qoder-connect/checkin";
		/** 选中模型所属的 provider id。 */
		const PROVIDER_ID = "qoder1";

		/** 底刷新间隔：这一行是装饰信息，不值得频繁打上游。 */
		const REFRESH_MS = 300000;
		/** 焦点/可见性抖动的保护间隔。 */
		const MIN_GAP_MS = 30000;

		const lineStyle = {
			color: "var(--dsw-alias-label-tertiary)",
			textAlign: "right",
			width: "100%",
			paddingRight: "8px",
			fontSize: "12px",
			lineHeight: "18px",
			fontVariantNumeric: "tabular-nums",
			whiteSpace: "nowrap",
			overflow: "hidden",
			textOverflow: "ellipsis",
		};
		const linkStyle = {
			font: "inherit",
			color: "var(--dsw-alias-state-business-primary)",
			background: "0 0",
			border: "none",
			cursor: "pointer",
			padding: "0 2px",
		};
		const doneStyle = { color: "var(--dsw-alias-state-success-primary)" };
		const warnStyle = { color: "var(--dsw-alias-state-warning-primary)" };
		//#endregion

		//#region 工具
		/** 数字展示：整数不带小数，小数最多两位（顺带加千分位）。 */
		function formatNumber(value) {
			if (typeof value !== "number" || !Number.isFinite(value)) return "—";
			return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
		}

		/** 后端契约的最小校验：形状不对就当没读到，绝不把半成品放进 state。 */
		function isStatusDocument(value) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
			const status = value.status;
			return status === "signed-out" || status === "signed-in";
		}
		//#endregion

		//#region 组件
		/**
		 * composer 下方那一行。
		 *
		 * 刷新策略与另外两条渠道一致：只在挂载 / 窗口获得焦点 / 标签页重新可见时拉，
		 * 5 分钟兜底，页面隐藏时不拉 —— 宿主对状态接口不做缓存，每次请求都会实打实
		 * 打一次 Qoder 的额度接口。
		 */
		function QoderMetaLine(props) {
			const directory = props.directory;
			const t = props.t;

			const subscribe = react.useCallback((listener) => directory.subscribe(listener), [directory]);
			const snapshot = react.useCallback(() => directory.getSnapshot(), [directory]);
			const selection = react.useSyncExternalStore(subscribe, snapshot, snapshot).current;

			const [status, setStatus] = react.useState(undefined);
			const [claim, setClaim] = react.useState("idle");
			const [note, setNote] = react.useState(undefined);
			const loadRef = react.useRef(undefined);

			/** 只有选中 qoder1 的模型时才需要这些网络请求。 */
			// `getSnapshot().current` 没选中模型时是 `null` 而非 `undefined` ——
			// 用 `!== undefined` 判断会放过 null，下一句读 `.provider` 就抛。
			const active = selection != null && selection.provider === PROVIDER_ID;

			react.useEffect(() => {
				if (!active) {
					setStatus(undefined);
					return undefined;
				}
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
						const response = await fetch(STATUS_PATH, {
							credentials: "same-origin",
							headers: { accept: "application/json" },
							signal: controller.signal,
						});
						if (!response.ok) return;
						const value = await response.json().catch(() => undefined);
						if (alive && !controller.signal.aborted && isStatusDocument(value)) setStatus(value);
					} catch {
						/* 只读装饰：失败静默，绝不影响输入框 */
					}
				};
				loadRef.current = load;
				const onFocus = () => { void load(false); };
				const onVisibility = () => {
					if (document.visibilityState === "visible") void load(false);
				};
				void load(true);
				const timer = window.setInterval(() => { void load(false); }, REFRESH_MS);
				window.addEventListener("focus", onFocus);
				document.addEventListener("visibilitychange", onVisibility);
				return () => {
					alive = false;
					controller.abort();
					window.clearInterval(timer);
					window.removeEventListener("focus", onFocus);
					document.removeEventListener("visibilitychange", onVisibility);
					loadRef.current = undefined;
				};
			}, [active]);

			/** 换账号要重置「刚刚领过」的记忆。 */
			const account = status === undefined ? undefined : status.account;
			react.useEffect(() => {
				setClaim("idle");
				setNote(undefined);
			}, [account]);

			if (!active) return null;

			// —— 倍率：来自目录里当前这个模型的 price_factor（宿主已格式化成 "0.8×"）。——
			const entry = status === undefined || status.models === undefined
				? undefined
				: status.models.find((model) => model.id === selection.model);
			const rate = entry === undefined
				? "—"
				: entry.free === true
					? t("rateFree")
					: entry.rate !== undefined && entry.rate !== null && entry.rate !== ""
						? entry.rate
						: "—";

			// —— 额度余量 ——
			const quota = status === undefined ? undefined : status.quota;
			let quotaText;
			if (status === undefined) {
				quotaText = t("loading");
			} else if (status.status === "signed-out") {
				quotaText = t("signedOut");
			} else if (status.quotaError !== undefined) {
				quotaText = t("quotaUnavailable");
			} else if (quota === undefined) {
				quotaText = t("loading");
			} else if (quota.enterprise === true) {
				quotaText = t("quotaEnterprise");
			} else if (quota.unlimited === true) {
				quotaText = t("quotaUnlimited");
			} else if (quota.remaining !== undefined && quota.total !== undefined) {
				quotaText = t("quotaPair", { remain: formatNumber(quota.remaining), total: formatNumber(quota.total) });
			} else if (quota.used !== undefined) {
				quotaText = t("quotaUsed", { used: formatNumber(quota.used) });
			} else {
				quotaText = "—";
			}

			// —— 签到 ——
			const checkin = status === undefined || status.status !== "signed-in" ? undefined : status.checkin;
			const checkinBroken = status !== undefined && status.status === "signed-in" && status.checkinError !== undefined;
			const claimable = checkin !== undefined && checkin.claimable === true;

			const onCheckin = async () => {
				if (claim === "busy" || !claimable) return;
				setClaim("busy");
				setNote(undefined);
				try {
					const response = await fetch(CHECKIN_PATH, {
						method: "POST",
						credentials: "same-origin",
						headers: { accept: "application/json" },
					});
					const body = await response.json().catch(() => undefined);
					const state = body === undefined ? undefined : body.state;
					if (state === "claimed") {
						setClaim("done");
						if (loadRef.current !== undefined) void loadRef.current(true);
						return;
					}
					if (state === "already-claimed") {
						setClaim("none");
						return;
					}
					// `manual-required` = 有奖可领，但只有桌面 App 能领（正常路径）。
					setClaim("manual");
					const message = body !== undefined && typeof body.message === "string" && body.message !== ""
						? body.message
						: `HTTP ${response.status}`;
					setNote(message);
				} catch (error) {
					setClaim("failed");
					setNote(error instanceof Error ? error.message : String(error));
				}
			};

			let checkinNode;
			let checkinTitle;
			if (checkinBroken) {
				checkinTitle = status.checkinError;
				checkinNode = react.createElement("span", { key: "checkin" }, t("checkinUnavailable"));
			} else if (claim === "busy") {
				checkinTitle = t("checkinBusy");
				checkinNode = react.createElement("span", { key: "checkin" }, t("checkinBusy"));
			} else if (claim === "manual") {
				checkinTitle = note !== undefined ? note : t("checkinManualHint");
				checkinNode = react.createElement("span", { key: "checkin", style: warnStyle }, t("checkinManual"));
			} else if (claim === "failed") {
				checkinTitle = t("checkinFailed", { message: note === undefined ? "" : note });
				checkinNode = react.createElement(
					"button",
					{ key: "checkin", type: "button", style: linkStyle, title: checkinTitle, onClick: onCheckin },
					t("checkinRetry"),
				);
			} else if (status === undefined || status.status !== "signed-in") {
				// 未登录 / 还没读到：不显示签到，免得给出假的可点状态。
				checkinTitle = t("checkinHint");
				checkinNode = react.createElement("span", { key: "checkin" }, t("checkinNone"));
			} else if (checkableNow(checkin, claim)) {
				checkinTitle = t("checkinClaimableHint");
				checkinNode = react.createElement(
					"button",
					{ key: "checkin", type: "button", style: linkStyle, title: checkinTitle, onClick: onCheckin },
					t("checkinAction"),
				);
			} else if (checkin === undefined) {
				checkinTitle = t("checkinHint");
				checkinNode = react.createElement("span", { key: "checkin" }, t("loading"));
			} else if (checkin.supported === false) {
				checkinTitle = checkin.reason !== undefined ? checkin.reason : t("checkinHint");
				checkinNode = react.createElement("span", { key: "checkin" }, t("checkinNone"));
			} else if (checkin.claimable !== true) {
				checkinTitle = checkin.reason !== undefined ? checkin.reason : t("checkinNone");
				checkinNode = react.createElement("span", { key: "checkin", style: doneStyle }, "✓ " + t("checkinNothing"));
			} else {
				checkinTitle = t("checkinHint");
				checkinNode = react.createElement("span", { key: "checkin" }, t("checkinNone"));
			}

			const channel = status !== undefined && typeof status.channel === "string" && status.channel !== ""
				? status.channel
				: PROVIDER_ID;

			const headline = t("metaLine", { channel, rate, quota: quotaText });

			return react.createElement(
				"div",
				{
					style: lineStyle,
					title: `${PROVIDER_ID}/${selection.model} · ${checkinTitle}`,
				},
				react.createElement("span", { key: "meta" }, headline),
				" · ",
				checkinNode,
			);
		}

		/**
		 * 现在能不能点签到。
		 *
		 * `claim === "done"` 是「刚刚这一轮确实领到了」（服务端真的回了 claimed），
		 * 之后按钮变成已领 —— 但 `manual` / `none` 不锁死，因为用户可能刚在 App 里
		 * 领完回来，下一次刷新就会自然变成「今日无可领」。
		 */
		function checkableNow(checkin, claim) {
			if (claim === "done" || claim === "manual") return false;
			return checkin !== undefined && checkin.claimable === true;
		}
		//#endregion

		//#region 文案
		const zh = {
			metaLine: "渠道 {channel} · 倍率 {rate} · 额度余量 {quota}",
			quotaPair: "{remain} / {total}",
			quotaUsed: "已用 {used}",
			quotaUnlimited: "不限量",
			quotaEnterprise: "按组织计量",
			quotaUnavailable: "查询失败",
			signedOut: "未登录",
			loading: "读取中…",
			rateFree: "免费",
			checkinAction: "签到",
			checkinBusy: "查询中…",
			checkinManual: "去 App 领取",
			checkinNothing: "今日无可领",
			checkinNone: "无签到活动",
			checkinUnavailable: "签到不可用",
			checkinRetry: "重试签到",
			checkinHint: "查看今日签到状态",
			checkinClaimableHint: "Qoder CN 今日有可领取的奖励，但领取动作在桌面 App 内嵌页面里，本插件没有可调用的接口。",
			checkinManualHint: "请打开 Qoder CN 的用量面板（左下角礼物图标）领取今日奖励。",
			checkinFailed: "签到失败：{message}",
		};
		const en = {
			metaLine: "Channel {channel} · Rate {rate} · Quota {quota}",
			quotaPair: "{remain} / {total}",
			quotaUsed: "used {used}",
			quotaUnlimited: "unlimited",
			quotaEnterprise: "org-metered",
			quotaUnavailable: "unavailable",
			signedOut: "not signed in",
			loading: "loading…",
			rateFree: "free",
			checkinAction: "Check in",
			checkinBusy: "Checking…",
			checkinManual: "Claim in App",
			checkinNothing: "nothing to claim",
			checkinNone: "no campaign",
			checkinUnavailable: "check-in unavailable",
			checkinRetry: "Retry check-in",
			checkinHint: "Show today’s check-in status",
			checkinClaimableHint: "Qoder CN has a reward to claim today, but claiming happens inside a page hosted by the desktop app — this plugin has no callable endpoint for it.",
			checkinManualHint: "Open Qoder CN’s usage panel (gift icon, bottom-left) to claim today’s reward.",
			checkinFailed: "Check-in failed: {message}",
		};
		//#endregion

		//#region 插件入口
		/** 稳定浏览器插件名。 */
		const name = "dsh-qoder-connect-client";
		const inject = ["slots", "locale"];

		/** 某个贡献抛错时降级成 console.error，不要毒死整个客户端加载器。 */
		const CONTRIBUTION_FAILED = "[dsh-qoder-connect] client contribution failed to load (host provider unaffected):";
		function guard(label, fn) {
			try {
				return fn();
			} catch (error) {
				console.error(CONTRIBUTION_FAILED + " " + label, error);
				return undefined;
			}
		}

		function apply(ctx, options) {
			const namespace = "settings.qoder";
			guard("copy", () => {
				ctx.effect(() => ctx.locale.register(namespace, { zh, en }), "dsh-qoder-connect: copy");
			});
			const t = ctx.locale.bind(namespace);

			/* [dsh-connect 2026-09-24] 三合一后「渠道 · 倍率 · 积分余量 · 签到」这些信息
			 * 已并进统一面板的按钮里，由 lib/index.js 传 options.skipDock 拦掉，
			 * 免得 composer 下方同时出现两行。其余贡献（设置卡片等）照旧。 */
			if (!options || options.skipDock !== true) guard("conversation meta line", () => {
				ctx.inject(["modelDirectories"], (scope) => {
					guard("conversation meta line", () => {
						scope.slots.inject("conversation.composer.dock", () =>
							guard("conversation composer dock", () =>
								scope.slots.register(
									{
										name: "conversation.composer.dock",
										id: "qoder-meta",
										order: 22,
										inject: (sessionId) => ({
											directory: scope.modelDirectories.directoryFor(sessionId).store,
											t,
										}),
									},
									QoderMetaLine,
								),
							),
						);
					});
				});
			});
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		
			return module.exports;
		})();

		// ══ dsh-connect 面板 的客户端半侧（原样搬入，独立作用域）══
		const panelClient = (() => {
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
			/**
			 * 卡片嵌入设置页（layout:"card"）时的**滚动上限**（2026-10-08 加）。
			 *
			 * 设置页外层不归本插件管，内容一高就溢出到可视区外 —— 用户实测：4 个
			 * WorkBuddy 账号时认证区直接画到方框下面，点不到。给卡片本体一个高度
			 * 上限让它**内部滚动**。上限用固定 px 而非 vh：vh 在设置页里量的是整屏，
			 * 会显得过高。弹窗布局不需要（panelBody 自己会滚）。
			 *
			 * 只能放在使用点：`layout` 是 HubPanel 的 prop，S 是外层常量，够不着。
			 */
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
					/**
					 * Trae 的产品标签（`Trae CN（IDE）` / `TRAE SOLO CN（TraeWork）`）。
					 *
					 * 为什么单列一个小 chip 而不是拼进 displayName：displayName 是用户在
					 * 认证页「改名」写的，插件覆盖它等于吃掉用户的命名。两个产品共用同一份
					 * 凭据文件（最后一次导出者赢），界面上没有这一格就看不出当前接的是哪个
					 * 产品 —— 而「模型比预期少」「倍率空白」多半就是导出时选错了产品。
					 */
					row.productLabel != null && row.productLabel !== ""
						? react.createElement(
								"span",
								{
									key: "p",
									style: { ...S.chip, flex: "none" },
									title: t("productHint", { product: row.productLabel }),
								},
								row.productLabel,
							)
						: null,
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
			const { row, t, draft, note, busy, onChange, onSave, onAction, renameDraft, onRenameChange, renaming, onRenameToggle, onRenameCommit } = props;
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
					 * 扫码登录入口已从面板移除：DSH 桌面宿主里点击面板内的外部链接会把
					 * 面板顶掉，弹窗形态整体不可用。WorkBuddy 授权请走 CLI 工作流——
					 * `node scripts/workbuddy-login.mjs workbuddy1`（可让 AI 代跑，
					 * 输出授权链接 → 用户在任意浏览器打开扫码 → 凭据自动写入）。
					 */
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
		 * 扫码登录入口已从面板移除：DSH 桌面宿主里点击面板内的外部链接会把面板
		 * 整体顶掉（window.open 与 <a> 都不可用），弹窗形态在该宿主里无法工作。
		 * WorkBuddy 授权改走 CLI 工作流：
		 *   node scripts/workbuddy-login.mjs workbuddy1            # 出链接并轮询到完成
		 *   node scripts/workbuddy-login.mjs workbuddy1 --url-only # 只输出链接
		 * AI 可直接代跑，把链接交给用户在任意浏览器打开扫码即可。
		 */

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

			// 「+ 添加渠道」展开时把表单滚进视野：scrollIntoView 沿真实 DOM 找
			// 实际可滚的祖先逐层滚动,弹窗 / 设置页 tab / 页面窗口都适用。
			const addRef = react.useRef(null);
			react.useEffect(() => {
				if (adding) addRef.current?.scrollIntoView({ block: "nearest" });
			}, [adding]);

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
							{ ref: addRef, style: { display: "flex", flexDirection: "column", gap: "6px", padding: "8px 10px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "8px" } },
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
					react.createElement("div", { style: { marginTop: "4px" } }, t("authMigrate")),				),
				...group(t("authSectionActive"), rows.filter((row) => row.configured === true)),
				...group(t("authSectionIdle"), rows.filter((row) => row.configured !== true)),
				addForm,
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

			/**
			 * 两种布局的根元素都必须是**有界高度的 flex 列**：panelBody 的
			 * `flex:1 1 auto; minHeight:0` 只在 flex 父级里生效，否则内容撑破
			 * 容器、被 overflow:hidden 裁走，界面上就是「没有滚动、点不到」。
			 *
			 * · card：设置页不给高度，卡片自带 px 上限（vh 在这里量的是整屏，会
			 *   显得过高）+ overflowY，与弹窗同构。
			 * · popover：外壳 S.popover 已有 maxHeight，根 div 被父高钳制即可。
			 */
			return react.createElement(
				"div",
				{
					style:
						layout === "card"
							? { ...S.card, ...S.cardScroll, display: "flex", flexDirection: "column" }
							: { display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0 },
				},
				...body,
			);
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
			productHint: "当前接入的产品：{product}（同一份凭据文件，由宿主导出时选择的产品决定）",
			modelsAllOffHint: "取消全部勾选 = 该渠道的模型不再出现在模型选择器里（仍然可以在这里全部勾回）",
			modelsCaption: "勾选 = 在模型选择器里显示；取消勾选即禁用该模型",
			modelsAllOn: "全选",
			modelsAllOff: "全不选",
			authTitle: "认证",
			authIntro: "怎么认证：把这段话发给 AI ——「请帮我配置 dsh-workbuddy-trae-qoder-connect 插件的渠道凭据，按 README 的 AI 快速启动流程逐渠道执行」。WorkBuddy 由 AI 工作流生成登录链接，在任意浏览器点开登录即可；Trae / Qoder 在自己的客户端导出凭据后点「粘贴」。",
			authSignedIn: "已登录",
			authSignedOut: "未登录",
			authNoTarget: "该渠道的凭据落点不可知（对应环境变量没设），请用导出脚本或改 compose",
			authSave: "保存",
			authSaving: "写入中…",
			authSaved: "已保存",
			authPaste: "粘贴",
			authCollapse: "收起",
			authBack: "返回",
			authMigrate: "凭据统一存 connect-auth/（0600，不进 settings），写入后最多 30 秒生效",
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
			productHint: "Connected product: {product} (one shared credential file — whichever product the host export picked)",
			modelsAllOffHint: "Unchecking all = this channel's models disappear from the model picker (tick them back here)",
			modelsCaption: "Checked = shown in the model picker; uncheck to disable a model",
			modelsAllOn: "All on",
			modelsAllOff: "All off",
			authTitle: "Auth",
			authIntro: "How to sign in: paste this to your AI — \"Set up the dsh-workbuddy-trae-qoder-connect channel credentials by following the AI quick-start in the README\". For WorkBuddy the AI workflow produces a login link — open it in any browser; for Trae / Qoder, export the credential from the client and press Paste.",
			authSignedIn: "signed in",
			authSignedOut: "signed out",
			authNoTarget: "This channel's credential path is unknown (its env var is unset); use the export script or change compose",
			authSave: "Save",
			authSaving: "Writing…",
			authSaved: "Saved",
			authPaste: "Paste",
			authCollapse: "Collapse",
			authBack: "Back",
			authMigrate: "Credentials live in connect-auth/ (0600, never in settings); applies within 30s of writing",
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

			// Plugins 页贡献:0.1.x 宿主派发 `settings.plugin.item` 卡片
			// （key = 宿主 settings 命名空间）;0.2+ 改渲染 `settings.plugins.tab`
			// tab 条目(由 settings.section#plugins 的 children 表声明)。
			// slots.inject 只对已声明插槽触发 —— 两条 seam 并存即自动择路。
			guard("settings card", () => {
				guard("settings card (0.1.x seam)", () =>
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
				guard("settings tab (0.2+ seam)", () =>
					ctx.slots.inject("settings.plugins.tab", () =>
						guard("connect hub settings tab", () =>
							ctx.slots.register(
								{
									name: "settings.plugins.tab",
									id: "dsh-connect",
									order: 10,
									label: () => safeT(t)("panelTitle"),
									locale: namespace,
								},
								/**
								 * 新契约的 renderSlot 传空 props、用 `only: entry.id` 选中
								 * 本条目渲染；`t` 我们自己兜底，宿主若按 `locale` 注入了
								 * 更好的那份就以它为准。
								 */
								guarded(function HubSettingsTab(props) {
									return react.createElement(HubSettingsCard, {
										...(props ?? {}),
										t: typeof props?.t === "function" ? props.t : safeT(t),
									});
								}),
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
		})();

		//#region 合并入口

		/** 四份贡献，按显示顺序：三个渠道各自的信息行在前，面板最后。 */
		const CONTRIBUTIONS = [
			["dsh-workbuddy-connect", workbuddyClient],
			["dsh-trae-connect", traeClient],
			["dsh-qoder-connect", qoderClient],
			["panel", panelClient],
		];

		const name = "dsh-connect-client";
		/** 并集：四份贡献分别用到 slots / locale；modelDirectories 由各自的 inject 处理。 */
		const inject = ["slots", "locale"];

		/**
		 * 逐份 apply。**一份失败不连累其余** —— 面板挂了，三个渠道的信息行照旧。
		 */
		function apply(ctx) {
			for (const [label, contribution] of CONTRIBUTIONS) {
				try {
					const fn = contribution === null || contribution === undefined ? undefined : contribution.apply;
					if (typeof fn !== "function") throw new Error("该半侧没有导出 apply");
					// 三个渠道各自还会往 composer dock 注册一条信息行；三合一后那些信息已经
					// 并进面板按钮里了，用 skipDock 拦掉（只拦 dock，其余贡献照旧）。
					fn(ctx, label === "panel" ? undefined : { skipDock: true });
				} catch (error) {
					console.error(`[dsh-connect] ${label} 的客户端半侧加载失败（其余贡献与宿主不受影响）：`, error);
				}
			}
		}

		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	},
});