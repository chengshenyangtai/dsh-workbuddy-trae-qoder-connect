import { A as normalizeCredits, B as chatUserAgent, C as desktopAuthCandidatesFor, D as WorkBuddyUpstreamClient, E as WorkBuddyAtRestKeyProvider, F as PROBE_EFFORT_CANDIDATES, G as WORKBUDDY_APP_VERSION_FILENAME, H as readCliVersion, I as probeModel, J as readBundleVersion, K as appUserAgent, L as randomSentinel, M as prepareChatBody, N as prepareInternationalChatBody, O as classifyUpstreamError, P as regionOf, R as CN_APP_VERSION_FILENAME, S as defaultDesktopAuthPath, T as workbuddyOwnAuthPath, U as resolveChatIdentity, V as fallbackChatIdentity, W as validCliVersion, X as validAppVersion, Y as resolveAppVersion, _ as WorkBuddyCatalog, a as WORKBUDDY_HOST_HEARTBEAT_FILENAME, b as WorkBuddyCredentialStore, c as processStartTimeMs, d as writeHostHeartbeat, f as WORKBUDDY_CONNECT_VERSION, g as FALLBACK_WORKBUDDY_MODELS, h as FALLBACK_WORKBUDDY_AI_MODELS, i as variantFor, j as parseModelCatalog, k as modelWithCurrentPromotion, l as readHostHeartbeat, n as CN_VARIANT, o as clearHostHeartbeat, q as installedAppVersion, r as WORKBUDDY_VARIANTS, s as isHeartbeatProcessAlive, t as AI_VARIANT, u as workbuddyHostHeartbeatPath, v as WORKBUDDY_AUTH_FILENAME, w as parseWorkBuddyAuth, x as defaultDesktopAuthCandidates, y as WORKBUDDY_AUTH_FILE_ENV, z as FALLBACK_CN_APP_VERSION } from "./variants-CnrmSn0Q.js";
import z from "@deepseek-ai/schemastery";
import { dirname, join, resolve } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { hostIsLoopback, loopbackRequest, originIsLoopback, safeMessage, withLegacyImageBudget, writeJson } from "../../shared/http.js";
import { hiddenMatcher } from "../../shared/hidden.js";
//#region src/catalog-store.ts
/**
* The last catalog that actually loaded, kept per variant and per account.
*
* Both the plan (§4 "降级顺序为同版同来源的最近成功目录 → 本版内置保守目录")
* and the README promise this fallback, and without it a restart always drops
* the user to the built-in roster even when a good catalog was fetched minutes
* earlier. The built-in roster is a snapshot taken once; a fetched catalog is
* what the upstream actually serves to this account.
*
* What it deliberately is *not*:
*
* - not a cache with a freshness policy — it never prevents a fetch, it only
*   answers when a fetch cannot;
* - not shared across accounts (a different account can see a different roster
*   and different promotions), nor across variants (the CN and international
*   endpoints disagree about rates and windows for the same model id);
* - not a place for secrets: model metadata only, never a token. The account
*   key is a `uid:enterpriseId` identity already visible in the status document.
*
* @module dsh-workbuddy-connect/catalog-store
*/
/** On-disk format this reader accepts; other versions are discarded. */
const CATALOG_FORMAT_VERSION = 1;
/** Basename of the CN variant's saved catalog inside the Harness home. */
const WORKBUDDY_CATALOG_FILENAME = ".workbuddy-catalog.json";
/** Plugin-owned saved-catalog path inside the Harness home. */
function workbuddyCatalogPath(filename = WORKBUDDY_CATALOG_FILENAME) {
	return join(resolveDshHome(), filename);
}
/** Whether a parsed value is a model row worth keeping. */
function isModel(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const row = value;
	return typeof row["id"] === "string" && row["id"] !== "" && typeof row["name"] === "string" && typeof row["contextWindow"] === "number" && Number.isFinite(row["contextWindow"]) && typeof row["maxTokens"] === "number" && Number.isFinite(row["maxTokens"]) && typeof row["supportsImages"] === "boolean";
}
/** Whether a parsed value is a saved catalog this reader can trust. */
function isSaved$1(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const entry = value;
	if (typeof entry["account"] !== "string" || entry["account"] === "") return false;
	if (typeof entry["source"] !== "string" || entry["source"] === "") return false;
	if (typeof entry["fetchedAtMs"] !== "number" || !Number.isFinite(entry["fetchedAtMs"])) return false;
	const models = entry["models"];
	if (!Array.isArray(models) || models.length === 0) return false;
	return models.every(isModel);
}
/**
* The last successful catalog per account, read once and written atomically.
*
* Malformed content reads as "nothing saved" rather than throwing: this file
* is an optimization for the offline and first-seconds cases, and a corrupt one
* must never be able to stop the plugin from serving models.
*/
var WorkBuddyCatalogStore = class {
	path;
	entries;
	constructor(options = {}) {
		this.path = typeof options === "string" ? options : options.path ?? workbuddyCatalogPath();
	}
	/** Resolved state-file path, for the CLI and tests. */
	filePath() {
		return this.path;
	}
	/**
	 * 读坏缓存 = 「没存过」：目录缓存只是上游目录的本地镜像，坏了就重新拉。
	 * **吞掉是有意为之** —— 缓存损坏不该让渠道挂掉；真正的目录错误会在
	 * `catalog.reload()` 里以 `catalogError` 呈现（状态文件可见），不会在这里静默丢。
	 */
	load() {
		if (this.entries !== void 0) return this.entries;
		const entries = {};
		if (existsSync(this.path)) try {
			const parsed = JSON.parse(readFileSync(this.path, "utf8"));
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
				const document = parsed;
				const raw = document["version"] === CATALOG_FORMAT_VERSION ? document["entries"] : void 0;
				if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
					for (const [key, value] of Object.entries(raw)) if (isSaved$1(value)) entries[key] = value;
				}
			}
		} catch {
			/* 缓存损坏 → 视为空，走上游重拉（见上方说明） */
		}
		this.entries = entries;
		return entries;
	}
	/** The saved catalog for one account, or `undefined` when there is none. */
	get(account) {
		const entry = this.load()[account];
		return entry === void 0 ? void 0 : entry;
	}
	/**
	* Remember a catalog for an account, replacing whatever was saved before.
	*
	* A failed write is swallowed: the plugin has already served these models,
	* and losing the *memory* of them is not worth surfacing.
	*/
	set(account, catalog) {
		const entries = this.load();
		entries[account] = {
			account,
			...catalog
		};
		this.persist();
	}
	/** Forget one account's catalog — used when that account signs out. */
	delete(account) {
		const entries = this.load();
		if (!(account in entries)) return;
		delete entries[account];
		this.persist();
	}
	persist() {
		const directory = dirname(this.path);
		try {
			if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
			const document = {
				version: CATALOG_FORMAT_VERSION,
				entries: this.load()
			};
			const temporary = resolve(`${this.path}.tmp`);
			writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 384 });
			renameSync(temporary, this.path);
		} catch {
			/** 缓存写失败只影响下次启动少一份镜像（本次会话仍用内存值），不能连累聊天主流程 */
		}
	}
};
//#endregion
//#region src/visibility-store.ts
/**
* Per-account model-visibility preferences: which models the signed-in account
* has hidden from the DSH model picker (issue #36).
*
* A disabled *list*, deliberately not an enabled whitelist: a new account and a
* model the upstream adds both start visible, and an id that temporarily
* disappears from the catalog is kept — when the model returns it stays hidden
* until this account says otherwise. Entries are also kept across sign-outs, so
* returning to an account restores exactly what it left.
*
* One file per variant (the two endpoints share model ids but never
* preferences), keyed by the same `uid:enterpriseId` identity the saved
* catalogs and probe records use. Not a place for secrets: model-id strings
* only, never a token, and never written into the desktop auth file or the
* plugin-owned credential copy — hiding a model is a picker preference, not
* credential state.
*
* Why a plugin-owned file rather than a settings section: the settings sections
* are statically-typed schemastery objects, and `settings.yaml` is account-global
* — a per-uid dynamic map fits neither without weakening the schema or mixing
* one account's preferences into another's config. The saved-catalog and probe
* stores already persist per-account data this way, so this store follows them:
* version-tagged document, atomic write with `0o600`, and a malformed file that
* reads as "nothing saved" rather than throwing.
*
* @module dsh-workbuddy-connect/visibility-store
*/
/** On-disk format this reader accepts; other versions are discarded. */
const VISIBILITY_FORMAT_VERSION = 1;
/** Basename of the CN variant's visibility file inside the Harness home. */
const WORKBUDDY_VISIBILITY_FILENAME = ".workbuddy-model-visibility.json";
/** Plugin-owned visibility-file path inside the Harness home. */
function workbuddyVisibilityPath(filename = WORKBUDDY_VISIBILITY_FILENAME) {
	return join(resolveDshHome(), filename);
}
/** Whether a parsed value is a saved preference entry this reader can trust. */
function isSaved(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const entry = value;
	if (typeof entry["account"] !== "string" || entry["account"] === "") return false;
	if (typeof entry["updatedAtMs"] !== "number" || !Number.isFinite(entry["updatedAtMs"])) return false;
	const disabled = entry["disabled"];
	if (!Array.isArray(disabled)) return false;
	return disabled.every((id) => typeof id === "string" && id !== "");
}
/**
* The per-account hidden-model lists, read once and written atomically.
*
* Unlike the saved-catalog store, a failed *write* propagates: the caller
* reports it to the user rather than answering "hidden" for a preference that
* did not persist. Reads stay forgiving — a corrupt or unreadable file is
* "nothing hidden", which only ever shows models the account can still pick.
*/
var WorkBuddyVisibilityStore = class {
	path;
	accounts;
	constructor(options = {}) {
		this.path = typeof options === "string" ? options : options.path ?? workbuddyVisibilityPath();
	}
	/** Resolved state-file path, for the CLI and tests. */
	filePath() {
		return this.path;
	}
	load() {
		if (this.accounts !== void 0) return this.accounts;
		const accounts = {};
		if (existsSync(this.path)) try {
			const parsed = JSON.parse(readFileSync(this.path, "utf8"));
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
				const document = parsed;
				const raw = document["version"] === VISIBILITY_FORMAT_VERSION ? document["accounts"] : void 0;
				if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
					for (const [key, value] of Object.entries(raw)) if (isSaved(value)) accounts[key] = value;
				}
			}
		} catch {
			/* 缓存损坏 → 视为「什么都没隐藏」：只影响面板显示，不影响凭据与请求 */
		}
		this.accounts = accounts;
		return accounts;
	}
	/** The model ids one account has hidden; empty when it never hid any. */
	disabled(account) {
		return this.load()[account]?.disabled ?? [];
	}
	/**
	* Show or hide one model for one account, persisting before committing.
	*
	* Re-enabling (showing) the last hidden model removes the account's entry
	* entirely — an absent entry and an empty list mean the same thing
	* (everything visible), and the file should not accumulate empty buckets.
	* Throws when the write fails, leaving the in-memory state untouched so a
	* re-read cannot lie about what was persisted.
	*/
	setVisible(account, model, visible) {
		const current = this.load()[account]?.disabled ?? [];
		const next = visible ? current.filter((id) => id !== model) : [.../* @__PURE__ */ new Set([...current, model])];
		const accounts = { ...this.load() };
		if (next.length === 0) delete accounts[account];
		else accounts[account] = {
			account,
			disabled: next,
			updatedAtMs: Date.now()
		};
		this.persist(accounts);
		this.accounts = accounts;
	}
	persist(accounts) {
		const directory = dirname(this.path);
		if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
		const document = {
			version: VISIBILITY_FORMAT_VERSION,
			accounts
		};
		const temporary = resolve(`${this.path}.tmp`);
		writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 384 });
		renameSync(temporary, this.path);
	}
};
//#endregion
//#region src/adapter.ts
/**
* The `workbuddy` pi-ai provider: one loopback-backed adapter registered
* into the Harness LLM seam, assembled from public `dsh-llm-pi-ai`
* extension points the way `dsh-codex-connect` assembles its Codex route.
*
* @module dsh-workbuddy-connect/adapter
*/
/** Provider route this bundle owns. */
const WORKBUDDY_PROVIDER = "workbuddy";
/** Provider idle ceiling while one stream read is outstanding. */
const WORKBUDDY_STREAM_IDLE_TIMEOUT_MS = 3e5;
/**
* Image-request budgets at the dsh-llm-pi-ai defaults; the profile type made
* them required in 0.1.1-rc.2. They bound requests to models whose catalog
* entry declares `supportsImages`; text-only models never receive images.
*/
const REQUEST_IMAGE_BUDGETS = {
	maxRequestImageBytes: 20971520,
	requestImagePixelBudget: 4194304,
	requestImageMaxBytes: 1048576
};
/**
* Inert pi-ai auth plane. The workbuddy route authenticates only through the
* shim shared secret resolved per request by `resolveApiKey`, so pi-ai's own
* credential lifecycle and ambient discovery must never manufacture a
* credential for it. `PiAiAdapterOptions.auth` is required since 0.1.1-rc.2;
* every ambient question here answers "nothing stored, nothing set".
*/
const INERT_AUTH = {
	credentials: {
		async read() {},
		async list() {
			return [];
		},
		async modify() {
			throw new Error("dsh-workbuddy-connect: the workbuddy route has no pi-ai credential lifecycle");
		},
		async delete() {}
	},
	authContext: {
		async env() {},
		async fileExists() {
			return false;
		}
	}
};
/** No per-token pricing is knowable for a subscription quota; report zero. */
const NO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
/**
 * 附件契约的跨版本垫片（`withLegacyImageBudget`）现已提到 `../../shared/http.js`。
 *
 * 它原先只在本文件里；Trae / Qoder 两条路 2026-10-07 之前连 `resolveAttachments` 都没往
 * adapter 传，带图请求在进 pi-ai 之前就被 `UNSUPPORTED_CONTENT` 拒掉 —— 症状却像「模型不
 * 支持读图」。统一放 shared，让「哪条路漏了」在源码上一眼可见，并由
 * `probes/verify-attachment-wiring.mjs` 钉住。
 */
/**
* The suffix appended to a model's display name so its billing rate is visible
* wherever the name is shown.
*
* The separator is a middle dot rather than a hyphen or colon: model names
* already contain hyphens (`GLM-5.3-Flash`, `Deepseek-V4-Flash`), so a hyphen
* separator would be ambiguous about where the name ends and the rate begins.
*/
const RATE_SEPARATOR = " · ";
/**
* Append the billing rate to one model's display name.
*
* The rate AND the declared promo badges ride the *name* alone: since DSH
* 0.1.2 the composer's model seat (`ModelSelect`) renders `model.name` only —
* `description` is no longer read there at all (the 0.1.1-era client rendered
* it, which is why the badges used to be visible in the seat). The `/model`
* popup renders the name too, so a separate `description` copy would either
* duplicate (rate) or vanish (badges) depending on client generation.
*
* This is display-only and cannot affect routing: the wire request is built
* from `model.id` (pi-ai's completions API sets `model: model.id`), the
* selection a picker submits is `{provider, model: id, reasoningEffort}`, and
* `dsh-llm` validates `name` as a non-empty string without comparing its
* contents. Nothing in the host resolves a model *by* name.
*/
/**
* The catalog display suffix: the billing rate followed by the declared promo
* badges (`限时免费`, `夜间折扣`), or undefined when the row carries neither.
* The badge labels are the upstream's own spellings and the host seam has no
* locale service, so non-Chinese UIs see them verbatim — accepted until the
* picker grows a localized badge slot.
*/
function displaySuffix(info) {
	// ── [本地补丁 2026-09-25] 恢复后缀：倍率回到模型名上 ──────────────────
	// 2026-09-23 这里被改成 `return void 0`：后缀会让 composer 底部行变长（.uV2eYG_row
	// 是 flex-wrap:wrap、.uV2eYG_trailing 是 flex:none），当时的替代方案是让 client 半
	// 把费率与徽章渲染到 conversation.composer.dock（WorkBuddyMetaLine）。
	//
	// 但那条信息行后来被三合一收进了侧栏入口：旧的三条 dock 注册被 skipDock 拦掉，
	// 侧栏条目只显示「渠道中心 + 可签 N」，倍率于是从整个界面上消失。
	//
	// 而 DSH 0.1.5 的模型下拉（dsh-client-ui-model-selection）只渲染 `model.name`
	// （`modelLabel = currentChoice?.model.name`，列表项 `children: model.name`），
	// `description` 根本不读 —— 所以**后缀是唯一能让每个模型都看到倍率的通道**。
	//
	// 权衡：座位与下拉共用同一个 name，座位会跟着变长。若哪天又挤行，先摘徽章
	// （只留倍率）再看；彻底回滚就是恢复 `return void 0`，或取
	// ~/.dsh/dsh-patch-backups/index.js.<时间戳>.orig 里 2026-09-23 之前的版本。
	const parts = [normalizeCredits(info.billing?.credits), ...(info.billing?.badges ?? [])].filter(
		(part) => part !== void 0 && part !== "",
	);
	return parts.length === 0 ? void 0 : parts.join(" · ");
}
/** Append the catalog display suffix to one model's display name. */
function withCatalogDisplay(name, info) {
	const suffix = displaySuffix(info);
	return suffix === void 0 ? name : `${name}${RATE_SEPARATOR}${suffix}`;
}
/**
* Resolve a WorkBuddy model's reasoning capability into pi-ai's
* `thinkingLevelMap` (every level pinned to its wire spelling or `null` for
* unsupported), mirroring `dsh-llm-pi-ai`'s own `resolveModelReasoning`.
*
* Two sources, strictly ordered (`docs/reasoning-effort-probe-plan.md` §5):
*
* 1. **The declared set.** When the upstream declares a non-empty
*    `supportedEfforts`, exactly those values are offered and nothing else.
*    This always wins: an observation never widens or narrows a declared set.
* 2. **A local observation.** Rows without a declared set (the older
*    `{effort, summary}` shape) normally get no control at all — their
*    selectable set is client-side knowledge the catalog does not carry, and
*    the desktop app differs per model there. If the user authorized a probe
*    and it established that the upstream *validates* the parameter, the
*    verified spellings are offered.
*
* A `non-validating` observation deliberately yields no control: the upstream
* accepts values that cannot exist (measured on `glm-5.2`), so every per-level
* acceptance it produced would be a false positive.
*
* `off` is offered only when the upstream declares `canDisableThinking: true`.
* It is never probed — disabling thinking is a separate capability, and the
* per-model acceptance of `off` cannot be inferred from the row's shape.
*
* The offered set is described internally as "verified accepted", never as
* "verified effective": acceptance proves the upstream did not reject the
* spelling, not that it changes what the model does.
*/
function reasoningFields(info, observed) {
	const reasoning = info.reasoning;
	if (reasoning === void 0 || reasoning.supports !== true) return { reasoning: false };
	const declared = reasoning.supportedEfforts;
	const efforts = declared !== void 0 && declared.length > 0 ? declared : observed?.validation === "validating" && observed.efforts.length > 0 ? observed.efforts : void 0;
	if (efforts === void 0) return { reasoning: false };
	return {
		reasoning: true,
		thinkingLevelMap: {
			/**
			 * **`off` 一律不给**（2026-10-08 实测修）。
			 *
			 * 目录里 `canDisableThinking: true` 的模型（如 `deepseek-v4.1-flash`）
			 * 原本会把 `off` 映射成上游字面量 `"off"` 发出去。实测该值**被上游
			 * 拒绝**：`reasoning_effort:"off"` → 400 / code 11133
			 * `extError.code = model_param_invalid`（同模型发 `low/high/max` 均 200）。
			 * 也就是说下拉里选「关思考」会让**整轮请求失败** —— 这是 UI 提供了一个
			 * 上游不接受的档位。
			 *
			 * 同族的 Qoder 上游 `off` 同样 400，那边一直是硬置 `null`（见
			 * `qoder/index.js` 的 thinkingLevelMap 注释与 `docs/CATALOG.md`）。
			 * WorkBuddy 这边此前只按"声明了 canDisableThinking"就放行，属于
			 * **未实测的推断**（原注释自己写明"cannot be inferred from the row's
			 * shape"），现在按实测收口：宁可不提供这一档，也不给一个必然 400 的选项。
			 *
			 * 如果哪天实测确认上游开始接受 `off`，把这里改回映射即可。
			 */
			off: null,
			minimal: null,
			low: efforts.includes("low") ? "low" : null,
			medium: efforts.includes("medium") ? "medium" : null,
			high: efforts.includes("high") ? "high" : null,
			xhigh: efforts.includes("xhigh") ? "xhigh" : null,
			max: efforts.includes("max") ? "max" : null
		}
	};
}
/** Build one pi-ai model descriptor pointing at the loopback shim. */
function toPiModel(info, baseUrl, observed, providerId = WORKBUDDY_PROVIDER) {
	return {
		id: info.id,
		name: info.name,
		api: "openai-completions",
		provider: providerId,
		baseUrl,
		input: info.supportsImages === true ? ["text", "image"] : ["text"],
		...reasoningFields(info, observed),
		cost: NO_COST,
		contextWindow: info.contextWindow,
		maxTokens: info.maxTokens,
		compat: { maxTokensField: "max_tokens" }
	};
}
/**
* Assemble the adapter. The provider's `getModels` reads the live catalog,
* and every model's `baseUrl` is re-resolved per read so the shim's
* ephemeral port applies from the first snapshot after startup.
*
* The profile is constructed by hand rather than through dsh-llm-pi-ai's
* internal `resolveProfiles()`: that helper is not part of the package's
* public export surface (root entry, `lib/` deep imports blocked by the
* exports map, `src/` not shipped), so hand-assembly is the only supported
* path and every newly required field must be adopted here explicitly —
* `modelErrors` since 0.1.5-alpha.2 (#12).
*/
function createWorkBuddyAdapter(options) {
	const { shim, store, catalog, resolveAttachments, observe, hidden } = options;
	const providerId = options.providerId ?? "workbuddy";
	const displayName = options.displayName ?? "WorkBuddy";
	const buildModels = () => {
		const baseUrl = `${shim.baseUrl()}/v1`;
		return catalog.current().map((info) => toPiModel(info, baseUrl, observe?.(info.id), providerId));
	};
	const provider = {
		...createProvider({
			id: providerId,
			name: displayName,
			auth: { apiKey: {
				name: "WorkBuddy OAuth bearer token",
				async resolve({ credential }) {
					const apiKey = credential?.key;
					return apiKey === void 0 || apiKey.length === 0 ? void 0 : {
						auth: { apiKey },
						source: "WorkBuddy"
					};
				}
			} },
			models: buildModels(),
			api: openAICompletionsApi()
		}),
		getModels: () => buildModels()
	};
	const profile = {
		provider: providerId,
		displayName,
		streamIdleTimeoutMs: WORKBUDDY_STREAM_IDLE_TIMEOUT_MS,
		retryPolicy: resolveRetryPolicy(void 0, "dsh-workbuddy-connect retryPolicy"),
		configuredMaxTokens: /* @__PURE__ */ new Map(),
		modelErrors: /* @__PURE__ */ new Map(),
		...REQUEST_IMAGE_BUDGETS,
		piProvider: provider
	};
	let profiles = /* @__PURE__ */ new Map([[providerId, profile]]);
	return {
		adapter: new WorkBuddyPiAiAdapter(catalog, hidden ?? (() => []), {
			profiles: () => profiles,
			auth: INERT_AUTH,
			resolveApiKey: async () => shim.token(),
			...resolveAttachments === void 0 ? {} : { resolveAttachments: () => {
				const store = resolveAttachments();
				return store === void 0 ? void 0 : withLegacyImageBudget(store, REQUEST_IMAGE_BUDGETS.requestImagePixelBudget);
			} }
		}),
		invalidate: () => {
			profiles = /* @__PURE__ */ new Map([[providerId, profile]]);
		}
	};
}
/**
* The WorkBuddy route's adapter: `PiAiAdapter` with the billing rate folded
* into the catalog answers it returns to the DSH model pickers.
*
* `PiAiAdapter.listModels()` and `.resolveModel()` build their answers straight
* from the pi-ai descriptors, which carry no billing fact, so the rate is
* layered on here by looking the model up in the live catalog. Both overrides
* delegate to `super` and then rewrite only the display fields, so streaming,
* capability resolution, and effort mapping stay exactly as `dsh-llm-pi-ai`
* implements them.
*
* A model missing from the catalog (an id the shim would serve but the last
* upstream refresh did not list) falls through with its name untouched rather
* than being dropped: catalog membership is advisory, and the seam tolerates
* serving an unlisted id.
*/
var WorkBuddyPiAiAdapter = class extends PiAiAdapter {
	catalog;
	hidden;
	constructor(catalog, hidden, options) {
		super(options);
		this.catalog = catalog;
		this.hidden = hidden;
	}
	/** Catalog entry for one model id, or undefined when the catalog omits it. */
	infoFor(model) {
		return this.catalog.current().find((entry) => entry.id === model);
	}
	async listModels(provider) {
		const models = await super.listModels(provider);
		const isHidden = hiddenMatcher(this.hidden());
		return models.flatMap((model) => {
			if (isHidden(model.id)) return [];
			const info = this.infoFor(model.id);
			if (info === void 0) return [model];
			return [{
				...model,
				name: withCatalogDisplay(model.name, info)
			}];
		});
	}
	async resolveModel(provider, model, signal) {
		const resolved = await super.resolveModel(provider, model, signal);
		const info = this.infoFor(model);
		if (info === void 0) return resolved;
		return {
			...resolved,
			name: withCatalogDisplay(resolved.name, info)
		};
	}
};
//#endregion
//#region src/shim.ts
/**
 * 修复历史里的工具破损：配对缺失，以及**函数名为空的退化调用**。
 *
 * ## 契约（详证见 docs/IMPLEMENTATION-NOTES.md「WorkBuddy 工具破损修复」）
 *
 * 真实上游（2026-10-08 实测）：
 *   · `function.name === ""` 的调用 → deepseek 系模型整单 400/11133
 *     （`model_param_invalid`），glm 系宽容 —— 与体积、条数、配对均无关，
 *     4 条消息、200 字节即可复现。
 *   · 空名调用由**上游适配层的退化输出**产生（Trae 丢头部片），宿主按
 *     "未知工具"执行并永久记进会话历史 → 之后该会话每轮必失败。
 *
 * ## 修复规则（保守，只处理确定破损的形态）
 *
 *   1. `role:"tool"` 的结果找不到任何 `assistant.tool_calls[].id` 与之配对
 *      → 丢弃该结果（孤儿）；
 *   2. 某个调用**没有任何**后续 tool 结果 → 从 tool_calls 里删掉；
 *   3. 其余一律原样保留 —— 不重写 id、不合并、不重排；
 *   4. **函数名缺失或为空白的调用**（及其配对结果）→ 整对丢弃。
 *
 * 删空 `tool_calls` 后若该 assistant 消息也没有正文，整条消息一并丢弃 ——
 * 与 pi-ai 一致（"either content or tool_calls, but not none"）。
 * 「调用必须紧邻结果」由宿主保证（agent 循环天生如此），这里不强制。
 *
 * @param {string} raw shim 收到的原始请求体（JSON 字符串）
 * @param {{warn?: Function}} [logger]
 * @returns {string} 修复后的请求体；解析失败或无 messages 时原样返回
 */
function repairToolPairing(raw, logger) {
	let body;
	try {
		body = JSON.parse(raw);
	} catch {
		return raw;
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) return raw;
	const messages = body.messages;
	if (!Array.isArray(messages)) return raw;

	/** assistant 消息按顺序展开的全部调用 id（同一 id 可能多次出现，全部登记）。 */
	const callIds = new Set();
	/** 函数名缺失/为空的调用 id —— 规则 4 的清理对象（见函数头注释的实测证据）。 */
	const degenerateIds = new Set();
	for (const m of messages) {
		if (m === null || typeof m !== "object" || Array.isArray(m)) continue;
		const calls = m.tool_calls;
		if (!Array.isArray(calls)) continue;
		for (const c of calls) {
			if (c === null || typeof c !== "object") continue;
			if (typeof c.id === "string" && c.id !== "") callIds.add(c.id);
			/**
			 * **缺 name 键与空串同样算退化**：下游（pi-ai）建工具调用块时以 name 为准，
			 * 没有名字的调用最终就是"未知工具"，与空串的结果完全一样。OpenAI 流式
			 * 契约里首片必定带 name，所以"有 id 但无 name"只可能是首片丢失后的残片。
			 */
			const fn = c.function;
			const name = fn !== null && typeof fn === "object" ? fn.name : c.name;
			if ((typeof name !== "string" || name.trim() === "") && typeof c.id === "string" && c.id !== "") degenerateIds.add(c.id);
		}
	}

	let orphanResults = 0;
	let danglingCalls = 0;
	let degenerateResults = 0;
	const repaired = [];
	for (const m of messages) {
		if (m === null || typeof m !== "object" || Array.isArray(m)) {
			repaired.push(m);
			continue;
		}
		if (m.role === "tool") {
			const id = m.tool_call_id;
			// 规则 1：孤儿结果 → 丢弃
			if (typeof id === "string" && id !== "" && !callIds.has(id)) {
				orphanResults++;
				continue;
			}
			// 规则 4 的配套结果：调用都要删了，结果留着只会变成孤儿 → 一起丢弃
			if (typeof id === "string" && degenerateIds.has(id)) {
				degenerateResults++;
				continue;
			}
			repaired.push(m);
			continue;
		}
		if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
			// 规则 2：没有结果回应的调用 → 删掉；规则 4：函数名为空的调用 → 删掉
			const kept = m.tool_calls.filter((c) => {
				if (c === null || typeof c !== "object") return false;
				if (typeof c.id !== "string" || c.id === "") return false;
				if (degenerateIds.has(c.id)) return false;
				return messages.some((x) => x !== null && typeof x === "object" && x.role === "tool" && x.tool_call_id === c.id);
			});
			if (kept.length !== m.tool_calls.length) danglingCalls += m.tool_calls.length - kept.length;
			if (kept.length === 0) {
				/**
				 * 删空后**不能**留下「无正文 + 无 tool_calls」的 assistant 消息：
				 * pi-ai 自己转换时会跳过这种消息（源码注释写明「有的上游要求
				 * either content or tool_calls, but not none」），说明它对上游是
				 * 非法形状。这里与 pi-ai 对齐：没有正文就整条丢弃。
				 */
				const content = m.content;
				const hasContent =
					typeof content === "string" ? content.length > 0 : Array.isArray(content) ? content.length > 0 : content !== undefined && content !== null;
				if (hasContent) {
					const { tool_calls, ...rest } = m;
					repaired.push(rest);
				}
				continue;
			}
			repaired.push(kept.length === m.tool_calls.length ? m : { ...m, tool_calls: kept });
			continue;
		}
		repaired.push(m);
	}

	if (orphanResults > 0 || danglingCalls > 0 || degenerateResults > 0) {
		logger?.warn?.(
			`dsh-workbuddy-connect: 修复历史里的工具破损 —— 孤儿结果 ${orphanResults} 条、` +
				`空名/未应答调用 ${danglingCalls} 条（含结果 ${degenerateResults} 条）已移除` +
				`（空名调用会被上游判为非法参数、直接 400/11133）`,
		);
		return JSON.stringify({ ...body, messages: repaired });
	}
	return raw;
}
/**
* Loopback OpenAI-compatible endpoint. The pi-ai provider points here; the
* shim applies the WorkBuddy wire quirks (forced streaming, string
* `tool_choice`, CLI-shaped headers) and forwards to the real upstream.
* It binds 127.0.0.1 only and never serves another interface.
*
* Inbound hardening: the loopback bind alone is not a trust boundary (any
* local process or a DNS-rebinding page can reach 127.0.0.1), so every
* request must carry a loopback Host header, browser-sent Origins must be
* loopback, chat POSTs must be application/json, and the Authorization
* header must carry the shim's per-process shared secret. The plugin's
* own client satisfies all four by construction; local attackers cannot
* read the secret out of the plugin process's memory.
*
* @module dsh-workbuddy-connect/shim
*/
const REQUEST_BODY_LIMIT = 67108864;
/** Chat-completion POSTs must carry a JSON body type (simple-request CSRF drops here). */
function isJsonContentType(req) {
	const type = req.headers["content-type"];
	return typeof type === "string" && type.trim().toLowerCase().startsWith("application/json");
}
/** HTTP status each upstream failure class surfaces as. */
const KIND_STATUS = {
	hard_credit: 402,
	soft_rate: 429,
	session_dead: 401,
	not_found: 502,
	server: 502,
	client: 400
};
function writeOpenAIError(res, status, kind, message) {
	writeJson(res, status, { error: {
		message,
		type: kind,
		code: kind
	} });
}
/** Read a request body with a size cap; over-limit bodies fail the request. */
function readBody$1(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > REQUEST_BODY_LIMIT) {
				reject(/* @__PURE__ */ new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}
/**
* Start the loopback endpoint. Requests carry any bearer; the loopback bind
* is the boundary, and the upstream credential comes from the store alone.
*/
function createWorkBuddyShim(options) {
	const { store, client, catalog } = options;
	const logger = options.logger;
	const SHARED_SECRET = randomBytes(32).toString("base64url");
	/** Constant-time bearer check; absent or mismatched bearers are rejected. */
	function bearerOk(req) {
		const header = req.headers.authorization;
		if (typeof header !== "string") return false;
		const match = /^Bearer\s+(.+)$/i.exec(header.trim());
		if (match === null) return false;
		const presented = match[1];
		const expected = SHARED_SECRET;
		const a = Buffer.from(presented);
		const b = Buffer.from(expected);
		if (a.length !== b.length) return false;
		return timingSafeEqual(a, b);
	}
	const server = createServer((req, res) => {
		handle(req, res);
	});
	const ready = new Promise((resolve, reject) => {
		server.once("listening", () => resolve());
		server.once("error", reject);
	});
	server.listen(0, "127.0.0.1");
	const baseUrl = () => {
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("workbuddy shim has no listening address");
		return `http://127.0.0.1:${address.port}`;
	};
	async function handle(req, res) {
		try {
			if (!hostIsLoopback(req.headers.host)) {
				writeOpenAIError(res, 403, "host_not_allowed", "Host header must name the loopback interface");
				return;
			}
			if (!originIsLoopback(req.headers.origin)) {
				writeOpenAIError(res, 403, "origin_not_allowed", "Origin must be a loopback origin");
				return;
			}
			if (!bearerOk(req)) {
				writeOpenAIError(res, 401, "unauthorized", "missing or invalid Authorization bearer");
				return;
			}
			const url = req.url ?? "/";
			if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
				writeJson(res, 200, { ok: true });
				return;
			}
			if (req.method === "GET" && (url === "/v1/models" || url === "/v1/models/")) {
				writeJson(res, 200, {
					object: "list",
					data: catalog.current().map((model) => ({
						id: model.id,
						object: "model",
						created: 0,
						owned_by: "workbuddy"
					}))
				});
				return;
			}
			if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/v1/chat/completions/")) {
				await chatCompletions(req, res);
				return;
			}
			writeOpenAIError(res, 404, "not_found", `no such route: ${req.method} ${url}`);
		} catch (error) {
			if (!res.headersSent) writeOpenAIError(res, 500, "internal", String(error));
			else res.end();
		}
	}
	async function chatCompletions(req, res) {
		if (!isJsonContentType(req)) {
			writeOpenAIError(res, 415, "unsupported_media_type", "Content-Type must be application/json");
			return;
		}
		let credential;
		try {
			credential = await store.resolve();
		} catch (error) {
			/**
			 * 凭据解析失败的原因也会送回浏览器，同样要洗 ——
			 * `store.resolve()` 的报错里可能带 token / 文件路径片段。
			 */
			writeOpenAIError(res, 401, "not_signed_in", safeMessage(error));
			return;
		}
		const raw = (await readBody$1(req)).toString("utf8");
		const prepared = prepareChatBody(repairToolPairing(raw, logger));
		const controller = new AbortController();
		req.on("close", () => controller.abort());
		const result = await client.chatStream(credential, prepared, controller.signal);
		if (!result.ok) {
			/**
			 * **上游原文必须洗过再送出去**（2026-10-08 补接线）。
			 *
			 * `result.message` 是上游响应体的切片，会经 `/status` 一路回到浏览器，
			 * 里面可能夹着 JWT 或 `?token=`。`safeMessage` 就是为此写的
			 * （见 shared/http.js 的注释），但此前**没有任何调用点** ——
			 * 函数存在却没接线，等于这道防线不存在。
			 */
			writeOpenAIError(
				res,
				KIND_STATUS[result.kind],
				result.kind,
				safeMessage(`workbuddy upstream ${result.kind} (http ${result.status}): ${result.message}`, 400),
			);
			return;
		}
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive",
			"X-Accel-Buffering": "no"
		});
		let sawDone = false;
		const body = Readable.fromWeb(result.response.body);
		body.on("data", (chunk) => {
			if (chunk.includes("[DONE]")) sawDone = true;
		});
		body.on("error", (error) => {
			logger?.warn("dsh-workbuddy-connect: upstream stream failed mid-flight", error);
			if (!sawDone && res.writable) res.end("data: [DONE]\n\n");
		});
		body.pipe(res);
	}
	return {
		ready,
		baseUrl,
		token: () => SHARED_SECRET,
		close: () => new Promise((resolve, reject) => {
			server.close(() => resolve());
			server.closeAllConnections();
			server.once("error", reject);
		})
	};
}
//#endregion
//#region src/probe-store.ts
/**
* Local record of reasoning-effort probes.
*
* What this stores is an *observation*, never a claim about the upstream: a
* model's row is only consulted when the catalog carries no explicit
* `supportedEfforts` set, and it always loses to a declared set. The plan this
* implements (`docs/reasoning-effort-probe-plan.md` §5) requires that a result
* is invalidated whenever the model's catalog row changes, so every record
* carries a fingerprint of the fields the probe depended on.
*
* The file lives beside the plugin's own credential copy under `$DSH_HOME`,
* never in the desktop app's files, and carries no token, prompt, or response
* body — only model ids, effort spellings, and timestamps.
*
* @module dsh-workbuddy-connect/probe-store
*/
/** Basename of the probe record inside the Harness home. */
const WORKBUDDY_PROBE_FILENAME = ".workbuddy-probe.json";
/**
* On-disk format this reader accepts; other versions are discarded.
*
* Version 2 nested the records under the account that produced them
* (`records[account][modelId]`), so two accounts no longer overwrite each
* other's observations for the same model. Version 1 files (flat, one record
* per model) are deliberately not migrated: they read as empty and the
* affected models are re-probed on demand, which keeps the reader free of
* half-understood compatibility paths.
*/
const PROBE_FORMAT_VERSION = 2;
/**
* How long an observation stays usable. Conservative on purpose: the plan's
* whole argument is that upstream metadata moves fast, so a result that has
* outlived its fingerprint's usefulness should not quietly keep granting a
* picker entry.
*/
const DEFAULT_TTL_MS = 12096e5;
/**
* Plugin-owned probe record path inside the Harness home.
*
* One file per variant. Same-named models exist on both endpoints (the
* international catalog repeats `glm-5.3`, `glm-5.2`, `hy3`, `kimi-k2.6`), and
* {@link fingerprintModel} covers only `id`/`reasoning`/`supportsImages` —
* never the provider — so a single shared file would let one variant's
* observation answer for the other. The paths differ; the format does not.
*/
function workbuddyProbePath(filename = WORKBUDDY_PROBE_FILENAME) {
	return join(resolveDshHome(), filename);
}
/**
* Fingerprint the catalog fields a probe depends on.
*
* Deliberately excludes display-only fields (`name`, `billing`, `contextWindow`)
* so a rename or a promo badge does not throw away a valid observation, and
* deliberately includes the whole reasoning object so any change to the
* declared shape re-probes.
*/
function fingerprintModel(info) {
	const basis = JSON.stringify({
		id: info.id,
		reasoning: info.reasoning ?? null,
		supportsImages: info.supportsImages ?? null
	});
	return createHash("sha256").update(basis).digest("hex").slice(0, 16);
}
/** Read-and-validate the documents on disk; anything malformed reads as empty. */
function readDocument(path) {
	if (!existsSync(path)) return void 0;
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const wrapped = parsed;
	if (wrapped["version"] !== PROBE_FORMAT_VERSION) return void 0;
	const records = wrapped["records"];
	if (typeof records !== "object" || records === null || Array.isArray(records)) return void 0;
	return parsed;
}
/** One record's shape check; a bad row is dropped rather than trusted. */
function isRecord(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const wrapped = value;
	const validation = wrapped["validation"];
	if (validation !== "validating" && validation !== "non-validating" && validation !== "unknown") return false;
	if (typeof wrapped["fingerprint"] !== "string") return false;
	if (typeof wrapped["probedAtMs"] !== "number" || !Number.isFinite(wrapped["probedAtMs"])) return false;
	if (typeof wrapped["pluginVersion"] !== "string") return false;
	if (typeof wrapped["account"] !== "string" || wrapped["account"] === "") return false;
	const efforts = wrapped["efforts"];
	if (!Array.isArray(efforts) || efforts.some((effort) => typeof effort !== "string")) return false;
	return true;
}
/**
* The plugin's probe records: read once, written atomically, keyed by the
* account that produced each observation, and never trusted across a
* fingerprint change or past the TTL.
*/
var WorkBuddyProbeStore = class {
	path;
	ttlMs;
	pluginVersion;
	now;
	records;
	constructor(options) {
		const opts = typeof options === "string" ? {
			path: options,
			pluginVersion: "0.0.0"
		} : options;
		this.path = opts.path ?? workbuddyProbePath();
		this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
		this.pluginVersion = opts.pluginVersion;
		this.now = opts.now ?? (() => Date.now());
	}
	/** Resolved state-file path, for the CLI and tests. */
	filePath() {
		return this.path;
	}
	load() {
		if (this.records === void 0) {
			const document = readDocument(this.path);
			const records = {};
			for (const [account, bucket] of Object.entries(document?.records ?? {})) {
				if (typeof bucket !== "object" || bucket === null || Array.isArray(bucket)) continue;
				const parsed = {};
				for (const [modelId, record] of Object.entries(bucket)) if (isRecord(record)) parsed[modelId] = record;
				records[account] = parsed;
			}
			this.records = records;
		}
		return this.records;
	}
	/**
	* The usable record for one account and model, or `undefined` when there is
	* none, it is expired, it was taken against a different catalog row, or it
	* belongs to a different account.
	*
	* @param account - the account in effect, as `uid:enterpriseId`. Records are
	*   only returned for the account that produced them.
	*/
	get(modelId, fingerprint, account) {
		const record = this.load()[account]?.[modelId];
		if (record === void 0) return void 0;
		if (record.fingerprint !== fingerprint) return void 0;
		if (record.account !== account) return void 0;
		if (this.now() - record.probedAtMs > this.ttlMs) return void 0;
		return record;
	}
	/**
	* Store one observation under the account stamped on it. Only a decisive
	* answer (`validating` / `non-validating`) replaces an existing decisive
	* record *of the same account*: a transient `unknown` must not erase
	* knowledge the user already paid for.
	*/
	set(modelId, record) {
		const records = this.load();
		const bucket = records[record.account] ?? (records[record.account] = {});
		const existing = bucket[modelId];
		if (record.validation === "unknown" && existing !== void 0 && existing.fingerprint === record.fingerprint && existing.validation !== "unknown") return;
		bucket[modelId] = record;
		this.persist();
	}
	/** Drop every record of every account; used by the card's explicit "clear" action. */
	clear() {
		this.records = {};
		this.persist();
	}
	/** Every record currently held, grouped by account, for status display. */
	all() {
		const records = this.load();
		return Object.fromEntries(Object.entries(records).map(([account, bucket]) => [account, { ...bucket }]));
	}
	/** Build a record stamped with this store's clock, version, and account. */
	record(fingerprint, validation, efforts, account) {
		return {
			fingerprint,
			validation,
			efforts: validation === "validating" ? [...efforts] : [],
			probedAtMs: this.now(),
			pluginVersion: this.pluginVersion,
			account
		};
	}
	/**
	* Write through a temporary file and rename, so a crash mid-write cannot
	* leave a half-parsed document that reads as "no records" and silently drops
	* every observation.
	*/
	persist() {
		const directory = dirname(this.path);
		try {
			if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
			const document = {
				version: PROBE_FORMAT_VERSION,
				records: this.load()
			};
			const temporary = resolve(`${this.path}.tmp`);
			writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 384 });
			renameSync(temporary, this.path);
		} catch {
			/** 探查记录写失败：本次结果已返回调用方（UI 照常显示），只是重启后丢缓存、可能要重探 */
		}
	}
};
/**
* Order observations newest-first for display.
*
* The store keeps insertion order so the file reads chronologically, but the
* card wants the most recent detection at the top: a sweep the user just ran
* should not appear below every earlier one, which is what appending to an
* insertion-ordered list does.
*/
function newestFirst(records) {
	return [...records].sort((a, b) => b.probedAt - a.probedAt);
}
//#endregion
//#region src/probe-service.ts
/**
* Serial probe runner. One instance is shared by the manual API and any
* future automatic trigger, so the two can never overlap.
*/
var WorkBuddyProbeService = class {
	options;
	queue = Promise.resolve();
	pending = /* @__PURE__ */ new Map();
	running = false;
	constructor(options) {
		this.options = options;
	}
	/** Whether a sweep is in flight right now. */
	isRunning() {
		return this.running;
	}
	/**
	* The record the adapter may use for this model, or `undefined`.
	*
	* Applies the plan's precedence (§5): a declared set always wins, so a model
	* that declares `supportedEfforts` is never answered from an observation.
	*/
	recordFor(modelId) {
		const info = this.options.catalog.current().find((model) => model.id === modelId);
		if (info === void 0) return void 0;
		if (info.reasoning?.supportedEfforts !== void 0 && info.reasoning.supportedEfforts.length > 0) return;
		const account = this.options.account();
		if (account === void 0) return void 0;
		return this.options.store.get(modelId, fingerprintModel(info), account);
	}
	/**
	* Probe one model, serially.
	*
	* The authenticated manual route supplies one-request consent after UI
	* confirmation. Other callers must pass the configured consent gate.
	* Manual consent never changes the automatic-probing configuration.
	* Explicit requests bypass historical results, but share an ongoing run.
	*/
	async probe(modelId, manualConsent = false) {
		if (!manualConsent && !this.options.consent()) return {
			state: "unavailable",
			reason: "probing is not authorized"
		};
		if (this.options.catalog.current().find((model) => model.id === modelId) === void 0) return {
			state: "unavailable",
			reason: `unknown model: ${modelId}`
		};
		const account = this.options.account();
		if (account === void 0) return {
			state: "unavailable",
			reason: "no WorkBuddy credential"
		};
		const pendingKey = JSON.stringify([account, modelId]);
		const pending = this.pending.get(pendingKey);
		if (pending !== void 0) return pending;
		const run = this.queue.then(async () => {
			const current = this.options.catalog.current().find((model) => model.id === modelId);
			if (current === void 0) return {
				state: "unavailable",
				reason: `unknown model: ${modelId}`
			};
			if (!manualConsent && !this.options.consent()) return {
				state: "unavailable",
				reason: "probing is not authorized"
			};
			if (current.reasoning?.supports !== true || (current.reasoning.supportedEfforts?.length ?? 0) > 0) return {
				state: "unavailable",
				reason: "model does not need detection"
			};
			const cached = this.recordFor(modelId);
			if (!manualConsent && cached !== void 0 && cached.validation !== "unknown") return {
				state: "ok",
				validation: cached.validation,
				efforts: cached.efforts,
				requests: 0
			};
			if (this.options.account() !== account) return {
				state: "unavailable",
				reason: "account changed before detection"
			};
			const credential = await this.options.credentials.current();
			if (credential === void 0) return {
				state: "unavailable",
				reason: "no WorkBuddy credential"
			};
			const send = this.options.send === void 0 ? (effort, signal) => this.options.client.probeEffort(credential, modelId, effort, signal) : this.options.send(modelId);
			this.running = true;
			try {
				const outcome = await probeModel({
					send,
					...this.options.sentinel === void 0 ? {} : { sentinel: this.options.sentinel }
				});
				if (this.options.account() !== account) return {
					state: "unavailable",
					reason: "account changed during detection"
				};
				const record = this.options.store.record(fingerprintModel(current), outcome.validation, outcome.efforts, account);
				this.options.store.set(modelId, record);
				if (outcome.validation === "unknown") return {
					state: "unavailable",
					reason: outcome.reason
				};
				return {
					state: "ok",
					validation: outcome.validation,
					efforts: record.efforts,
					requests: outcome.requests
				};
			} finally {
				this.running = false;
			}
		});
		this.queue = run.catch(() => void 0);
		this.pending.set(pendingKey, run);
		try {
			return await run;
		} finally {
			this.pending.delete(pendingKey);
		}
	}
};
//#endregion
//#region src/web-status.ts
/**
* Assemble the card's status document. Sign-in state is read-only; credit is
* a live billing answer whose failure degrades to `creditsError` rather than
* failing the whole document.
*/
async function workBuddyWebStatus(deps) {
	const authStatus = await deps.store.status();
	if (authStatus.state !== "signed-in") return {
		status: "signed-out",
		...authStatus.reason === void 0 ? {} : { reason: authStatus.reason }
	};
	const status = {
		status: "signed-in",
		...authStatus.nickname === void 0 ? {} : { nickname: authStatus.nickname },
		...authStatus.domain === void 0 || authStatus.domain === "" ? {} : { domain: authStatus.domain },
		...authStatus.source === void 0 ? {} : { source: authStatus.source },
		...authStatus.expiresAtMs === void 0 ? {} : { expiresAt: authStatus.expiresAtMs }
	};
	const modelsField = deps.models().map((model) => {
		const rate = normalizeCredits(model.billing?.credits);
		const supported = model.supportedContextWindows ?? [];
		const maxContextWindow = supported.length > 0 ? Math.max(...supported) : void 0;
		const defaultContextWindow = model.defaultContextWindow ?? model.contextWindow;
		return {
			id: model.id,
			name: model.name,
			...model.billing?.free === true ? { free: true } : {},
			...model.billing?.badges !== void 0 && model.billing.badges.length > 0 ? { badges: model.billing.badges } : {},
			...rate === void 0 ? {} : { credits: rate },
			...model.billing?.rateUnknown === true ? { rateUnknown: true } : {},
			...typeof model.contextWindow === "number" && model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {},
			...typeof defaultContextWindow === "number" && defaultContextWindow > 0 && defaultContextWindow < model.contextWindow ? { defaultContextWindow } : {},
			...maxContextWindow === void 0 || maxContextWindow <= defaultContextWindow ? {} : { maxContextWindow },
			...typeof model.maxInputTokens === "number" && model.maxInputTokens > 0 ? { maxInputTokens: model.maxInputTokens } : {}
		};
	});
	const catalog = deps.catalog?.();
	const withCatalog = catalog === void 0 ? status : {
		...status,
		catalog
	};
	const visibility = deps.visibility?.();
	const withVisibility = visibility === void 0 ? withCatalog : {
		...withCatalog,
		visibility
	};
	const statusWithModels = modelsField.length > 0 ? {
		...withVisibility,
		models: modelsField
	} : withVisibility;
	let probed = statusWithModels;
	if (deps.probe !== void 0) {
		const maximumContextWindow = deps.useMaximumContextWindow?.();
		probed = {
			...statusWithModels,
			probe: deps.probe(),
			...deps.probeKey === void 0 ? {} : { probeKey: deps.probeKey },
			...maximumContextWindow === void 0 ? {} : { useMaximumContextWindow: maximumContextWindow }
		};
	}
	try {
		const credential = await deps.store.current();
		if (credential !== void 0) {
			const credits = await deps.client.fetchCredits(credential);
			return {
				...probed,
				credits
			};
		}
	} catch (error) {
		return {
			...probed,
			creditsError: safeMessage(error)
		};
	}
	return probed;
}
/** The status route's request handler, extracted so tests can mount it on a bare server. */
function workBuddyStatusHandler(deps) {
	return async (req, res) => {
		if (req.method !== "GET") {
			writeJson(res, 405, { error: "method not allowed" });
			return;
		}
		if (!loopbackRequest(req)) {
			writeJson(res, 403, { error: "request-not-trusted" });
			return;
		}
		try {
			writeJson(res, 200, await workBuddyWebStatus(deps));
		} catch (error) {
			writeJson(res, 500, { error: safeMessage(error) });
		}
	};
}
/** Mount the GET status route on an optional webServer context. */
function registerWorkBuddyStatusRoute(ctx, deps) {
	const path = deps.path ?? "/plugins/dsh-workbuddy-connect/status";
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "exact",
			path,
			handler: workBuddyStatusHandler(deps)
		});
		return () => {
			dispose();
		};
	}, "dsh-workbuddy-connect: Web status route");
}
//#endregion
//#region src/probe-route.ts
/**
* Probe control route: the only state-changing endpoint the plugin exposes.
*
* Two guards, because they stop different things (see `docs/reasoning-effort-probe-plan.md`
* §6.4 and the v0.3.1 note in AGENTS.md about their exact scope):
*
* 1. **Loopback Host + Origin**, shared with the status route. This drops
*    DNS-rebinding pages, whose requests arrive addressed to the attacker's
*    domain.
* 2. **An in-process random key**, minted per process and handed only to the
*    same-origin card. Loopback alone is *not* authentication — any local
*    process can write `Host: 127.0.0.1` — so a route that spends the user's
*    credit must prove the caller was told the key.
*
* A probe request is never accepted with a prompt, a model id outside the
* live catalog, or a sentinel from the browser: it is assembled entirely
* host-side. (Scope: the `probe` action only — `set-model-visibility`
* deliberately accepts a model id the current catalog no longer lists, since
* a hidden id is kept for when the model returns.)
*
* @module dsh-workbuddy-connect/probe-route
*/
/** Largest control body accepted; these payloads are a few dozen bytes. */
const MAX_BODY_BYTES = 4096;
/** Mint the per-process control key. */
function createProbeKey() {
	return randomBytes(24).toString("hex");
}
/**
* Constant-time key comparison; a length mismatch is a failure, not a crash.
*/
function keyMatches(expected, presented) {
	if (presented === void 0 || presented.length !== expected.length) return false;
	const a = Buffer.from(expected);
	const b = Buffer.from(presented);
	return a.length === b.length && timingSafeEqual(a, b);
}
/** Read the request body with a hard ceiling. */
async function readBody(req) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.length;
		if (total > MAX_BODY_BYTES) return void 0;
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}
/** Parse and shape-check an action; unknown fields are ignored, not trusted. */
function parseAction(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const wrapped = parsed;
	const action = wrapped["action"];
	if (action === "clear") return { action: "clear" };
	if (action === "refresh") return { action: "refresh" };
	if (action === "set-maximum-context-window") return typeof wrapped["enabled"] === "boolean" ? {
		action: "set-maximum-context-window",
		enabled: wrapped["enabled"]
	} : void 0;
	if (action === "set-model-visibility") {
		const model = wrapped["model"];
		const account = wrapped["account"];
		if (typeof model !== "string" || model.trim() === "") return void 0;
		if (typeof wrapped["visible"] !== "boolean") return void 0;
		if (typeof account !== "string" || account === "") return void 0;
		return {
			action: "set-model-visibility",
			model: model.trim(),
			visible: wrapped["visible"],
			account
		};
	}
	if (action === "probe") {
		const model = wrapped["model"];
		if (typeof model !== "string" || model.trim() === "") return void 0;
		return {
			action: "probe",
			model: model.trim()
		};
	}
}
/**
* The control route's handler, extracted so tests can mount it on a bare
* server with a known key.
*/
function workBuddyProbeHandler(deps, key) {
	return async (req, res) => {
		if (req.method !== "POST") {
			writeJson(res, 405, { error: "method not allowed" });
			return;
		}
		if (!loopbackRequest(req)) {
			writeJson(res, 403, { error: "request-not-trusted" });
			return;
		}
		if (!keyMatches(key, req.headers["x-workbuddy-probe-key"])) {
			writeJson(res, 403, { error: "invalid-probe-key" });
			return;
		}
		const body = await readBody(req);
		if (body === void 0) {
			writeJson(res, 413, { error: "body too large" });
			return;
		}
		const action = parseAction(body);
		if (action === void 0) {
			writeJson(res, 400, { error: "invalid action" });
			return;
		}
		try {
			if (action.action === "clear") {
				deps.clear();
				writeJson(res, 200, { state: "cleared" });
				return;
			}
			if (action.action === "refresh") {
				if (deps.refresh === void 0) {
					writeJson(res, 404, { error: "refresh-not-supported" });
					return;
				}
				writeJson(res, 200, await deps.refresh());
				return;
			}
			if (action.action === "set-maximum-context-window") {
				if (deps.setMaximumContextWindow === void 0) {
					writeJson(res, 404, { error: "context-window-setting-not-supported" });
					return;
				}
				writeJson(res, 200, await deps.setMaximumContextWindow(action.enabled === true));
				return;
			}
			if (action.action === "set-model-visibility") {
				if (deps.setModelVisibility === void 0) {
					writeJson(res, 404, { error: "visibility-setting-not-supported" });
					return;
				}
				writeJson(res, 200, await deps.setModelVisibility(action.model, action.visible === true, action.account));
				return;
			}
			writeJson(res, 200, await deps.probe(action.model));
		} catch (error) {
			writeJson(res, 500, { error: safeMessage(error) });
		}
	};
}
/** Mount the POST probe-control route on an optional webServer context. */
function registerWorkBuddyProbeRoute(ctx, deps, key) {
	const path = deps.path ?? "/plugins/dsh-workbuddy-connect/probe";
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "exact",
			path,
			handler: workBuddyProbeHandler(deps, key)
		});
		return () => {
			dispose();
		};
	}, "dsh-workbuddy-connect: probe control route");
}
/**
* [本地补丁 2026-09-23] 签到控制路由：GET 读状态（只读），POST 执行签到。
*
* 与状态路由同样只服务 loopback（Host/Origin 都必须是本机），
* 避免任意页面借同源请求替用户去领积分。
*/
function workBuddyCheckinHandler(deps) {
	return async (req, res) => {
		if (!loopbackRequest(req)) {
			writeJson(res, 403, { error: "request-not-trusted" });
			return;
		}
		if (req.method !== "GET" && req.method !== "POST") {
			writeJson(res, 405, { error: "method not allowed" });
			return;
		}
		try {
			const credential = await deps.store.current();
			if (credential === void 0) {
				writeJson(res, 200, { state: "signed-out" });
				return;
			}
			writeJson(res, 200, req.method === "GET" ? await readCheckin(credential) : await deps.client.claimDailyCheckin(credential));
		} catch (error) {
			writeJson(res, 500, { error: safeMessage(error) });
		}
	};
	/**
	* 只读路径。
	*
	* 企业账号要走短路：它的活动看板同样返回 200/active:false 的默认值，照原样回给上层会
	* 被渲染成一个可点的「签到」按钮，用户点一下才发现不支持。这里**明说**不支持，
	* 让上层能显示「不适用」而不是给一个假的动作入口。
	*/
	async function readCheckin(credential) {
		if (credential.enterpriseId !== void 0 && credential.enterpriseId !== "") return {
			ok: true,
			data: {
				unsupported: true,
				message: "企业账号不支持每日签到"
			}
		};
		return await deps.client.fetchCheckinStatus(credential);
	}
}
/** Mount the check-in route on an optional webServer context. */
function registerWorkBuddyCheckinRoute(ctx, deps) {
	const path = deps.path ?? "/plugins/dsh-workbuddy-connect/checkin";
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "exact",
			path,
			handler: workBuddyCheckinHandler(deps)
		});
		return () => {
			dispose();
		};
	}, "dsh-workbuddy-connect: check-in route");
}
//#endregion
//#region src/plugin-login-route.ts
/**
* Sign-in route: `POST …/login/start` then `GET …/login/poll`.
*
* ## Why this exists
*
* Until now the plugin could only read a credential the WorkBuddy **desktop app**
* had already produced — so a container without that app installed had no way to
* sign in at all. The plugin's own sign-in flow (`/v2/plugin/auth/state` →
* `/v2/plugin/auth/token`) needs no desktop app and no password: it hands out an
* ordinary HTTPS page that renders its own QR / phone-number sign-in, and the
* authorized account comes back as a token pair. Measured live 2026-09-27.
*
* ## Guards and shape
*
* Loopback Host + Origin, the same guard the status and check-in routes use.
* The probe route additionally demands an in-process key because it *spends*
* credit; this one does not spend anything, and its only outcome a local
* attacker could force is… a credential for whoever scanned the code. The
* token pair therefore never travels back out: the response reports the account
* (`uid` / `nickname`) and nothing else.
*
* ## The clock is ours, not Tencent's
*
* The token endpoint answers `200 {"code":11217,"msg":"…login ing…"}` while
* authorization is pending **and** for a state that does not exist — a random
* UUID answers identically (measured). So expiry cannot be read off the wire;
* {@link LOGIN_STATE_TTL_MS} is the only clock, and a session is dropped when it
* runs out. That TTL matches the desktop flow's own 15 minutes.
*
* @module dsh-workbuddy-connect/plugin-login-route
*/
/** How long a started sign-in stays pollable. Tencent's own state TTL is 15 min. */
const LOGIN_STATE_TTL_MS = 15 * 60 * 1e3;
/**
* Live sign-ins, keyed by state, oldest first.
*
* Bounded because the route is reachable from any local process: without a cap
* a loop of `login/start` calls would grow this without end for 15 minutes.
* Eight is far more than the one or two a human has open.
*/
const LOGIN_SESSIONS = /* @__PURE__ */ new Map();
const LOGIN_SESSION_CAP = 8;
/** State shape we are willing to put in a query string. */
const LOGIN_STATE_RE = /^[0-9A-Za-z_-]{8,64}$/u;
function pruneLoginSessions(now) {
	for (const [state, session] of LOGIN_SESSIONS) {
		if (now - session.at > LOGIN_STATE_TTL_MS) LOGIN_SESSIONS.delete(state);
	}
	while (LOGIN_SESSIONS.size >= LOGIN_SESSION_CAP) {
		const oldest = LOGIN_SESSIONS.keys().next().value;
		if (oldest === void 0) break;
		LOGIN_SESSIONS.delete(oldest);
	}
}
/** The sign-in route pair's handlers, extracted so tests can mount them on a bare server. */
function workBuddyLoginHandlers(deps) {
	return {
		async start(req, res) {
			if (req.method !== "POST") {
				writeJson(res, 405, { error: "method not allowed" });
				return;
			}
			if (!loopbackRequest(req)) {
				writeJson(res, 403, { error: "request-not-trusted" });
				return;
			}
			try {
				const started = await deps.client.startLogin(deps.region);
				const now = Date.now();
				pruneLoginSessions(now);
				LOGIN_SESSIONS.set(started.state, { at: now });
				writeJson(res, 200, {
					ok: true,
					state: started.state,
					authUrl: started.authUrl,
					expiresInMs: LOGIN_STATE_TTL_MS
				});
			} catch (error) {
				writeJson(res, 502, {
					ok: false,
					error: safeMessage(error)
				});
			}
		},
		async poll(req, res) {
			if (req.method !== "GET") {
				writeJson(res, 405, { error: "method not allowed" });
				return;
			}
			if (!loopbackRequest(req)) {
				writeJson(res, 403, { error: "request-not-trusted" });
				return;
			}
			let state = "";
			try {
				state = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("state") ?? "";
			} catch {
				state = "";
			}
			if (!LOGIN_STATE_RE.test(state)) {
				writeJson(res, 400, {
					ok: false,
					status: "invalid",
					error: "missing or malformed state"
				});
				return;
			}
			const session = LOGIN_SESSIONS.get(state);
			if (session === void 0) {
				writeJson(res, 200, {
					ok: true,
					status: "unknown"
				});
				return;
			}
			if (Date.now() - session.at > LOGIN_STATE_TTL_MS) {
				LOGIN_SESSIONS.delete(state);
				writeJson(res, 200, {
					ok: true,
					status: "expired"
				});
				return;
			}
			let result;
			try {
				result = await deps.client.pollLogin(state, deps.region);
			} catch (error) {
				writeJson(res, 502, {
					ok: false,
					status: "failed",
					error: safeMessage(error)
				});
				return;
			}
			if (result.status !== "ready") {
				writeJson(res, 200, {
					ok: true,
					status: "waiting"
				});
				return;
			}
			/**
			* One shot: the state is consumed whether or not the write succeeds, so a
			* retry cannot replay an authorization the user already granted. A failed
			* write is reported, and the user starts a new sign-in — which costs one
			* more scan, but never a duplicate credential.
			*/
			LOGIN_SESSIONS.delete(state);
			try {
				writeJson(res, 200, await deps.signIn(result));
			} catch (error) {
				writeJson(res, 500, {
					ok: false,
					status: "failed",
					error: safeMessage(error)
				});
			}
		}
	};
}
/** Mount the sign-in route pair on an optional webServer context. */
function registerWorkBuddyLoginRoutes(ctx, deps) {
	const prefix = deps.path ?? "/plugins/dsh-workbuddy-connect/login";
	const handlers = workBuddyLoginHandlers(deps);
	ctx.effect(() => {
		const disposers = [ctx.webServer.register({
			kind: "exact",
			path: `${prefix}/start`,
			handler: handlers.start
		}), ctx.webServer.register({
			kind: "exact",
			path: `${prefix}/poll`,
			handler: handlers.poll
		})];
		return () => {
			for (const dispose of disposers) dispose();
		};
	}, "dsh-workbuddy-connect: sign-in routes");
}
//#endregion
//#region src/index.ts
/**
 * [dsh-connect] 面板下发的"禁用模型"钩子：`(providerId) => 要隐藏的模型 id[]`。
 *
 * provider 自己不知道面板的存在；lib/index.js 在启动时用 setExternalHidden 注入，
 * 未注入时视为"不隐藏"。每次构建模型列表时重新调用，所以用户在面板里改完立即生效。
 */
let externalHidden = () => [];
export function setExternalHidden(fn) {
  externalHidden = typeof fn === "function" ? fn : () => [];
}

/** Stable Cordis plugin name. */
const name = "llm-workbuddy";
/** The model registry required before the provider can register. */
const inject = ["llm"];
/**
* Settings namespace owning the CN card's section.
*
* DSH 0.1.2 dropped the `settingsNamespace()` branding function: a namespace is
* now a nominal string, validated by the type system where it is used rather
* than at runtime by a function call. The brand is compile-time only, so this
* stays the plain string it always was — every comparison, descriptor lookup,
* and `dsh` config file still sees `'workbuddy'`. It is cast once here so the
* public constant carries the seam's type without pulling the brand helper
* into this package (upstream DSH plugins, `dsh-llm-pi-ai` included, pass
* their namespaces as plain string literals).
*/
const WORKBUDDY_SETTINGS_NS = "workbuddy1";
/**
* Settings namespace owning the international section.
*
* One namespace per variant, not one shared: each section owns only its own
* fields (`authFile` vs `authFileAI` and `useMaximumContextWindow`), and the
* sections are what `settings.yaml` and the TUI `/settings` read. On DSH 0.1.5
* they carry one more duty — the settings Plugins tab dispatches a card by
* rendering `settings.plugin.item` with `entryKey = ns` for each namespace the
* Host serves, so each variant's card needs a served section whose namespace
* equals its id. DSH 0.1.6+ ignores that pairing (its Plugins page renders the
* bundle's single `plugins.bundle.config` entry, keyed by package name), which
* costs nothing: a section that names no card renders no duplicate.
*/
const WORKBUDDY_AI_SETTINGS_NS = "workbuddy2";
/**
 * [本地分支 2026-09-24] 企业版渠道（workbuddy3）的设置命名空间。
 *
 * 必须是它自己的命名空间：DSH 0.1.5 的设置 Plugins 页按「宿主在服务哪些命名空间」
 * 逐个派发 settings.plugin.item 卡片，所以第三张卡片要靠这个段才存在。
 */
const WORKBUDDY_3_SETTINGS_NS = "workbuddy3";
/**
* How often the credential files are re-checked, in milliseconds.
*
* A startup-only catalog fetch cannot notice a sign-in that happens while DSH
* is already running, so the model group would not appear until a restart. This
* poll is a cheap existence/parse read of at most a few local files: it never
* contacts the network and never runs a reasoning probe.
*
* `DSH_WORKBUDDY_POLL_MS` overrides it. That exists so the sweep can be
* exercised end to end in tests and shortened while diagnosing a slow sign-in
* on a real machine; it is not a product setting and no UI exposes it. The
* value is clamped to a sane range so a mistaken override cannot turn the poll
* into a busy loop.
*/
const CREDENTIAL_POLL_MS = 3e4;
/** Floor and ceiling for the overridable poll interval. */
const MIN_POLL_MS = 100;
const MAX_POLL_MS = 864e5;
/** Resolve the sweep interval, honoring the override when it is usable. */
function credentialPollMs() {
	const override = Number(process.env["DSH_WORKBUDDY_POLL_MS"]);
	if (!Number.isFinite(override) || override < MIN_POLL_MS) return CREDENTIAL_POLL_MS;
	return Math.min(override, MAX_POLL_MS);
}
/**
* How long to wait before retrying a catalog fetch that failed.
*
* A *failed* fetch must never be treated like a good one: without a retry, one
* transient network blip at startup would leave the group on the built-in
* fallback roster until the user noticed and pressed refresh. This bound keeps
* that recovery automatic while still honoring the "not every round" rule.
*
* Expressed as a multiple of the sweep rather than a fixed duration so the two
* stay in proportion under the `DSH_WORKBUDDY_POLL_MS` override.
*/
const CATALOG_RETRY_SWEEPS = 10;
/**
* How long a **successful** catalog stays fresh.
*
* [2026-09-25] This used to be "forever": as long as the credential identity did
* not change, a live catalog was never re-fetched. That was justified as "a
* same-identity token rotation carries no new model information" — true for the
* *roster*, but the catalog also carries each model's **billing rate**
* (`row.credits`, the `x0.79` shown next to the model name) and the promo
* badges, both of which are upstream-side facts that change without any local
* signal. The visible symptom was a rate frozen at whatever it was when the
* plugin last signed in.
*
* So a live catalog now expires too. The default is deliberately much longer
* than the sweep: a WorkBuddy catalog fetch costs two requests per account
* (`/v3/config` plus the console badge read), and pricing moves on the scale of
* hours. Override with `DSH_WORKBUDDY_CATALOG_TTL_MS`.
*/
const CATALOG_TTL_MS = 900000;
/** Resolve the live-catalog TTL, honoring the override when it is usable. */
function catalogTtlMs() {
	const override = Number(process.env["DSH_WORKBUDDY_CATALOG_TTL_MS"]);
	if (!Number.isFinite(override) || override < MIN_POLL_MS) return CATALOG_TTL_MS;
	return Math.min(override, MAX_POLL_MS);
}
/** Explicit CN desktop auth-file path (shared by the plugin schema and its section). */
const AUTH_FILE_FIELD = z.string().description("WorkBuddy desktop auth file (defaults to the app's own location)");
/** Explicit international desktop auth-file path (shared by the plugin schema and its section). */
const AUTH_FILE_AI_FIELD = z.string().description("WorkBuddy 账号 2 的凭据文件（留空则用平台默认位置）");
/** [本地分支] 企业版账号（渠道 3）的凭据文件。留空则退回 WORKBUDDY3_AUTH_FILE 环境变量。 */
const AUTH_FILE_3_FIELD = z.string().description("WorkBuddy 账号 3（企业版）的凭据文件（留空则用平台默认位置）");
/** Probe authorization (shared by the plugin schema and the CN section). */
const PROBE_CONSENT_FIELD = z.boolean().default(false).description("Authorize reasoning-effort probes (each probe sends real requests that may consume credit)");
const MAXIMUM_CONTEXT_WINDOW_FIELD = z.boolean().default(true).description("Use the largest context window declared by WorkBuddy AI when alternatives are available (on by default)");
const Config = z.object({
	authFile: AUTH_FILE_FIELD,
	authFileAI: AUTH_FILE_AI_FIELD,
	authFile3: AUTH_FILE_3_FIELD,
	probeConsent: PROBE_CONSENT_FIELD,
	useMaximumContextWindow: MAXIMUM_CONTEXT_WINDOW_FIELD
});
/**
* The CN side's settings section: only the fields that side edits.
*
* The section's namespace is what serves these fields to `settings.yaml` and
* the TUI `/settings`, and it keeps them apart from the international side's.
* `probeConsent` lives here because it predates the second variant; it gates no
* current code path (only manual, per-click-confirmed probes run), so it is left
* where existing users set it rather than moved and re-asked.
*/
const CN_SECTION = z.object({
	authFile: AUTH_FILE_FIELD,
	probeConsent: PROBE_CONSENT_FIELD
});
/** The international card's settings section and its context-window preference. */
const AI_SECTION = z.object({
	authFileAI: AUTH_FILE_AI_FIELD,
	useMaximumContextWindow: MAXIMUM_CONTEXT_WINDOW_FIELD
});
/**
* [本地分支 2026-09-24] 企业版渠道的设置段：只承载它自己的凭据路径。
*
* 与前两段分开，是因为 `configuredAuthFile` 按变体取字段 —— 共用 authFile
* 会让「在第三张卡片里改路径」实际改到账号 1 的渠道上去。
*/
const ACCOUNT3_SECTION = z.object({
	authFile3: AUTH_FILE_3_FIELD
});
/** Stable identity key used by credentials, probe records, and catalog entries. */
function credentialIdentity(credential) {
	return `${credential.uid}:${credential.enterpriseId ?? ""}`;
}
/**
* The account key model-visibility preferences are stored under: the stable
* identity, but only when it carries a uid.
*
* A credential whose desktop document carried no `account.uid` normalizes to
* an empty string; keying preferences on the resulting `":enterpriseId"` would
* silently share one bucket between every such account. Those accounts get no
* per-account preferences at all — everything stays visible and the control
* route explains the refusal — which is the only honest degradation: it never
* applies one account's hidden list to another.
*/
function visibilityAccountOf(credential) {
	return credential.uid === "" ? void 0 : credentialIdentity(credential);
}
/**
* Read the configured explicit auth-file path for one variant.
*
* 按 id 精确匹配，而不是「不是 CN 就用 AI 那份」：后者在有第三个变体时会把
* workbuddy3 和 workbuddy2 绑到同一个字段上，两段设置互相覆盖。认不出的变体
* 返回 undefined —— store 于是回落到自己的 WORKBUDDY{N}_AUTH_FILE 环境变量。
*/
function configuredAuthFile(config, variant) {
	// 旧 settings 卡片优先，保留已有部署的显式路径配置。
	if (variant.id === "workbuddy1" && typeof config.authFile === "string" && config.authFile.trim() !== "") return config.authFile;
	if (variant.id === "workbuddy2" && typeof config.authFileAI === "string" && config.authFileAI.trim() !== "") return config.authFileAI;
	if (variant.id === "workbuddy3" && typeof config.authFile3 === "string" && config.authFile3.trim() !== "") return config.authFile3;
	// 环境变量其次：兼容 compose 或原生部署的自定义凭据路径。
	if (/^workbuddy\d+$/.test(variant.id)) {
		const envPath = process.env[variant.env]?.trim();
		return envPath || join(resolveDshHome(), "connect-auth", `${variant.id}.json`);
	}
	return undefined;
}
/**
* The static catalog a variant serves before its first successful fetch.
*
* Each variant has its own roster: the two endpoints share several model ids
* but not their billing, context windows, or reasoning sets, so one shared
* fallback would misdescribe whichever variant it was not captured from.
*/
function fallbackFor(variant) {
	return variant.region === "cn" ? FALLBACK_WORKBUDDY_MODELS : FALLBACK_WORKBUDDY_AI_MODELS;
}
/** Build one variant's stores and probe state. */
function createVariantRuntime(config, variant, current, identityOf, accountOf, keyProvider) {
	const client = new WorkBuddyUpstreamClient();
	const configured = configuredAuthFile(config, variant);
	const store = new WorkBuddyCredentialStore({
		variant,
		...configured === void 0 ? {} : { desktopPath: configured },
		...keyProvider === void 0 ? {} : { keyProvider },
		refresh: (credential) => client.refreshToken(credential)
	});
	const fallback = fallbackFor(variant);
	const catalog = new WorkBuddyCatalog(fallback);
	if (variant.region === "global") catalog.setUseMaximumContextWindow(config.useMaximumContextWindow === true);
	catalog.setVisible(false);
	const probeStore = new WorkBuddyProbeStore({
		pluginVersion: WORKBUDDY_CONNECT_VERSION,
		path: workbuddyProbePath(variant.probeFilename)
	});
	const savedCatalogs = new WorkBuddyCatalogStore(workbuddyCatalogPath(variant.catalogFilename));
	const visibilityStore = new WorkBuddyVisibilityStore(workbuddyVisibilityPath(variant.visibilityFilename));
	return {
		variant,
		store,
		client,
		catalog,
		probeStore,
		probeService: new WorkBuddyProbeService({
			store: probeStore,
			catalog,
			credentials: store,
			client,
			consent: () => current().probeConsent === true,
			account: () => identityOf(variant.id)
		}),
		savedCatalogs,
		visibilityStore,
		account: () => accountOf(variant.id),
		fallback,
		catalogSource: "fallback",
		catalogFetchedAtMs: void 0,
		catalogError: void 0,
		lastFetchAtMs: 0,
		catalogGeneration: 0,
		inflightFetch: void 0,
		invalidate: () => {},
		registered: false
	};
}
/** The catalog provenance the card displays. */
function catalogSection(runtime) {
	const fetch = runtime.client.lastCatalog;
	return {
		source: runtime.catalogSource,
		...runtime.catalogFetchedAtMs === void 0 ? {} : { fetchedAt: runtime.catalogFetchedAtMs },
		...fetch?.appVersion === void 0 ? {} : { appVersion: fetch.appVersion.version },
		...runtime.catalogError === void 0 ? {} : { error: runtime.catalogError }
	};
}
/**
* Whether a model can be probed by hand: it reasons and the upstream declares
* no effort set for it.
*
* Deliberately *not* filtered by whether a result already exists. Dropping a
* model once it has been detected made the list shrink with use, so
* re-detecting one model — after an upstream change, say — meant clearing every
* other result first. The list stays stable and the card marks which entries
* already have an answer.
*/
function isProbeCandidate(info) {
	if (info.reasoning?.supports !== true) return false;
	return (info.reasoning.supportedEfforts?.length ?? 0) === 0;
}
/** Compact probe state for one card: consent, candidates, observations. */
function probeSection(runtime, consent) {
	const models = runtime.catalog.current();
	const results = models.flatMap((info) => {
		const record = runtime.probeService.recordFor(info.id);
		if (record === void 0) return [];
		return [{
			id: info.id,
			name: info.name,
			validation: record.validation,
			efforts: record.efforts,
			probedAt: record.probedAtMs
		}];
	});
	return {
		consent,
		running: runtime.probeService.isRunning(),
		candidates: models.filter(isProbeCandidate).map((info) => info.id),
		results: newestFirst(results)
	};
}
/**
* Start one variant: its loopback endpoint, provider registration, and
* configuration-card wiring.
*
* Registration waits for the shim to hold a port, because the provider's
* models read the shim origin at construction time. A failure here is
* contained to this variant: the caller logs it and the other keeps working.
*
* @returns whether the provider registered.
*/
async function startVariant(ctx, runtime) {
	const { variant, store, client, catalog, probeService } = runtime;
	const shim = createWorkBuddyShim({
		store,
		client,
		catalog,
		logger: ctx.logger
	});
	try {
		await shim.ready;
	} catch (error) {
		ctx.logger.error(`dsh-workbuddy-connect: ${variant.displayName} loopback endpoint failed to start`, error);
		return false;
	}
	try {
		const workbuddy = createWorkBuddyAdapter({
			providerId: variant.id,
			displayName: variant.displayName,
			shim,
			store,
			catalog,
			resolveAttachments: () => ctx.get("attachments"),
			observe: (modelId) => probeService.recordFor(modelId),
			hidden: () => {
				const account = runtime.account();
				const own = account === void 0 ? [] : runtime.visibilityStore.disabled(account);
				// [dsh-connect] 并上面板下发的禁用列表（面板的存在对 provider 透明）。
				return [...own, ...externalHidden(runtime.variant.id)];
			}
		});
		runtime.invalidate = () => {
			workbuddy.invalidate();
			ctx.emit("llm/adapters-updated");
		};
		const releaseAdapter = ctx.llm.registerAdapter([variant.id], workbuddy.adapter);
		try {
			ctx.effect(() => () => {
				releaseAdapter();
				shim.close();
			});
		} catch {
			releaseAdapter();
			shim.close();
		}
		runtime.registered = true;
		return true;
	} catch (error) {
		ctx.logger.error(`dsh-workbuddy-connect: ${variant.displayName} provider registration failed`, error);
		shim.close();
		return false;
	}
}
/**
* Start both variants: their loopback endpoints, the `workbuddy` and
* `workbuddy-ai` providers, their configuration cards, and their
* credential-driven catalog lifecycles.
*
* Each variant registers unconditionally; what varies is whether its catalog is
* *visible*. An empty catalog is how DSH hides a model group (the host filters
* out groups with no models), which keeps a sign-in that happens after startup
* working without re-registering the provider.
*/
function apply(ctx, config) {
	let current = () => config;
	/** Timers and in-flight work belonging to this plugin instance. */
	let stopped = false;
	const timers = [];
	/**
	* The account identity each variant last published a catalog for. Keeps a
	* same-identity token rotation from re-fetching, and lets a late response
	* from a previous identity be discarded instead of overwriting a newer one.
	*/
	const lastIdentities = /* @__PURE__ */ new Map();
	/**
	* The visibility account key each variant last adopted, parallel to
	* {@link lastIdentities}: same credential, second key — undefined both when
	* signed out and when the credential carried no uid, which is exactly the
	* case that must not fall back to a shared preference bucket.
	*/
	const lastAccounts = /* @__PURE__ */ new Map();
	const atRestKeys = new WorkBuddyAtRestKeyProvider();
	const runtimes = WORKBUDDY_VARIANTS.map((variant) => createVariantRuntime(config, variant, () => current(), (id) => lastIdentities.get(id), (id) => lastAccounts.get(id), atRestKeys));
	const probeKey = createProbeKey();
	let setMaximumContextWindow;
	/**
	* Whether this host's settings service carries the 0.1.2-era section API.
	* Decided once, inside the `settings` inject: DSH 0.1.7 removed
	* `installSection` (and `update`) with no replacement this plugin can drive.
	* The maximum-context getter answers `undefined` while this is false, and a
	* status document without the field is what keeps the card from rendering a
	* checkbox that could not be saved.
	*/
	let legacySettingsAvailable = false;
	/**
	* Point a variant at an account identity, invalidating whatever the previous
	* one left behind.
	*
	* One helper for all four transitions (sweep sign-in, sweep sign-out, manual
	* refresh, manual refresh sign-out) because each of them used to do its own
	* partial version, and the manual path forgot pieces the sweep did. Every
	* transition bumps {@link VariantRuntime.catalogGeneration}, which is what
	* makes an in-flight request from before the change refuse to write back.
	*
	* Probe observations are kept across an account change: the store nests them
	* per account, so the departing account's records simply stop being served
	* (every read is account-scoped) and are found intact if that account
	* returns. The "signed out, then in as someone else" sequence that used to
	* look like a first sighting is still safe — a record only ever answers for
	* the account stamped on it, so the new account inherits nothing. Visibility
	* preferences are kept for the same reason, and read through the new
	* account's key immediately: the picker re-lists after the invalidate below
	* and a returning account finds its own hidden list back in force.
	*
	* @param identity - the account now in effect, or `undefined` when signed out.
	* @param account - the visibility key for that same credential (`undefined`
	* also when the credential carries no uid); stored alongside the identity so
	* preference reads never guess it from the identity string.
	*/
	const adoptIdentity = (runtime, identity, account) => {
		const id = runtime.variant.id;
		const known = lastIdentities.get(id);
		if (known === identity) return;
		const hadCredential = known !== void 0;
		if (identity === void 0) lastIdentities.delete(id);
		else lastIdentities.set(id, identity);
		if (account === void 0) lastAccounts.delete(id);
		else lastAccounts.set(id, account);
		runtime.catalogGeneration += 1;
		runtime.inflightFetch?.controller.abort();
		runtime.inflightFetch = void 0;
		if (hadCredential && known !== identity) runtime.invalidate();
		if (identity === void 0) {
			if (known !== void 0) runtime.savedCatalogs.delete(known);
			runtime.catalog.set(runtime.fallback);
			runtime.catalogSource = "fallback";
			runtime.catalogFetchedAtMs = void 0;
			runtime.catalogError = void 0;
			if (runtime.catalog.setVisible(false)) runtime.invalidate();
			return;
		}
		const saved = runtime.savedCatalogs.get(identity);
		if (saved !== void 0) {
			runtime.catalog.set([...saved.models]);
			runtime.catalogSource = "saved";
			runtime.catalogFetchedAtMs = saved.fetchedAtMs;
		} else {
			runtime.catalog.set(runtime.fallback);
			runtime.catalogSource = "fallback";
			runtime.catalogFetchedAtMs = void 0;
		}
		runtime.catalogError = void 0;
		runtime.catalog.setVisible(true);
		runtime.invalidate();
	};
	ctx.inject(["webServer"], (webCtx) => {
		for (const runtime of runtimes) {
			registerWorkBuddyCheckinRoute(webCtx, {
				path: `${runtime.variant.statusPath.slice(0, -"/status".length)}/checkin`,
				store: runtime.store,
				client: runtime.client
			});
			registerWorkBuddyStatusRoute(webCtx, {
				path: runtime.variant.statusPath,
				store: runtime.store,
				client: runtime.client,
				models: () => runtime.catalog.current(),
				catalog: () => catalogSection(runtime),
				probe: () => probeSection(runtime, current().probeConsent === true),
				probeKey,
				visibility: () => {
					const account = runtime.account();
					return account === void 0 ? void 0 : {
						account,
						disabled: runtime.visibilityStore.disabled(account)
					};
				},
				...runtime.variant.region === "cn" ? {} : { useMaximumContextWindow: () => legacySettingsAvailable ? current().useMaximumContextWindow === true : void 0 }
			});
			registerWorkBuddyLoginRoutes(webCtx, {
				path: `${runtime.variant.statusPath.slice(0, -"/status".length)}/login`,
				region: runtime.variant.region,
				client: runtime.client,
				signIn: async (result) => {
					/**
					* 读一次当前凭据**只为如实告诉用户"替换了谁"** —— 它不再构成拒绝理由。
					*
					* 早先这里在"已有的那份是另一个账号"时直接拒绝，理由是
					* `current()` 会偏好用户配置的那份、写进去也读不到。结果是把
					* **"换一个号"变成界面上无路可走**（用户只能去手工删文件）。
					* 现在改成：扫码写下的副本带 `signedInBy: "scan"`，
					* `current()` 对它有明确的优先级（见 `WorkBuddyCredentialStore.current`），
					* 于是"扫完即生效"，且**不删**原文件 ⇒ 删掉插件副本就能退回。
					*
					* 唯一仍然拒绝的情形是**配置本身不可用**：那份文件属于另一个地区
					* （比如往国内版槽位塞了国际版凭据），此时读它会抛错，得先由人修。
					*/
					let previous;
					try {
						previous = await runtime.store.current();
					} catch (error) {
						return {
							ok: false,
							status: "blocked",
							reason: `该槽位现有的凭据文件不可用，先处理它再扫码：${safeMessage(error)}`
						};
					}
					/**
					* `domain` decides which region the credential belongs to
					* (`regionOf`), and the store rejects a copy that disagrees with its
					* variant — so a missing or foreign domain would make the account
					* unusable rather than merely mislabelled. Keep the response's value
					* when it maps to this variant's region, otherwise use the region's
					* own base.
					*/
					const domain = regionOf(result.domain) === runtime.variant.region ? result.domain : runtime.variant.region === "global" ? "www.workbuddy.ai" : "copilot.tencent.com";
					const credential = {
						accessToken: result.accessToken,
						refreshToken: result.refreshToken,
						expiresAtMs: typeof result.expiresInSec === "number" ? Date.now() + result.expiresInSec * 1e3 : 0,
						domain,
						uid: result.uid,
						...result.enterpriseId === "" ? {} : { enterpriseId: result.enterpriseId },
						...result.nickname === "" ? {} : { nickname: result.nickname },
						/**
						* 标记"这是扫码授权写下的"：`current()` 据此让它优先于
						* 用户配置的那份（账号不同时）。少了这个标记，
						* 换号在界面上就是"扫码成功但状态没变"。
						*/
						signedInBy: "scan",
						source: "dsh"
					};
					await runtime.store.saveOwn(credential);
					const identity = credentialIdentity(credential);
					adoptIdentity(runtime, identity, visibilityAccountOf(credential));
					await fetchCatalog(runtime, identity);
					return {
						ok: true,
						status: "signed-in",
						uid: result.uid,
						...result.nickname === "" ? {} : { nickname: result.nickname },
						...result.enterpriseId === "" ? {} : { enterpriseId: result.enterpriseId },
						domain,
						source: "dsh",
						/** 只有"换了人"时才回，前端据此说明原账号的去向（文件还在，可退回）。 */
						...previous === void 0 || previous.uid === result.uid ? {} : {
							replaced: {
								uid: previous.uid,
								...previous.nickname === void 0 || previous.nickname === "" ? {} : { nickname: previous.nickname },
								...previous.source === void 0 ? {} : { source: previous.source }
							}
						}
					};
				}
			});
			registerWorkBuddyProbeRoute(webCtx, {
				path: runtime.variant.probePath,
				probe: async (modelId) => {
					const result = await runtime.probeService.probe(modelId, true);
					if (result.state === "ok") runtime.invalidate();
					return result;
				},
				clear: () => {
					runtime.probeStore.clear();
					runtime.invalidate();
				},
				refresh: async () => {
					if (stopped) return {
						state: "failed",
						reason: "plugin is stopping"
					};
					let credential;
					try {
						credential = await runtime.store.current();
					} catch (error) {
						return {
							state: "failed",
							reason: error instanceof Error ? error.message.slice(0, 300) : String(error)
						};
					}
					if (credential === void 0) {
						adoptIdentity(runtime, void 0, void 0);
						return { state: "signed-out" };
					}
					const identity = credentialIdentity(credential);
					adoptIdentity(runtime, identity, visibilityAccountOf(credential));
					await fetchCatalog(runtime, identity);
					return runtime.catalogError === void 0 ? {
						state: "refreshed",
						reason: `${runtime.catalog.current().length} models`
					} : {
						state: "failed",
						reason: runtime.catalogError
					};
				},
				...runtime.variant.region === "cn" ? {} : { setMaximumContextWindow: async (enabled) => {
					if (setMaximumContextWindow === void 0) return {
						state: "failed",
						reason: "settings are unavailable"
					};
					return setMaximumContextWindow(enabled);
				} },
				setModelVisibility: async (modelId, visible, expectedAccount) => {
					const account = runtime.account();
					if (account === void 0) return {
						state: "failed",
						reason: "model visibility needs a signed-in account with a stable user id"
					};
					if (expectedAccount !== account) return {
						state: "stale-account",
						reason: "the signed-in account changed"
					};
					try {
						runtime.visibilityStore.setVisible(account, modelId, visible);
					} catch (error) {
						return {
							state: "failed",
							reason: error instanceof Error ? error.message.slice(0, 300) : String(error)
						};
					}
					runtime.invalidate();
					return { state: "updated" };
				}
			}, probeKey);
		}
	});
	ctx.inject(["settings"], (settingsCtx) => {
		if (typeof settingsCtx.settings.installSection !== "function") {
			ctx.logger.warn("dsh-workbuddy-connect: host settings service has no installSection API; per-variant settings and the maximum-context preference are unavailable");
			return;
		}
		legacySettingsAvailable = true;
		/** Section sources; each falls back to its own slice when its side unloads. */
		const sources = {
			cn: () => config,
			ai: () => config,
			account3: () => config
		};
		/** Merge both sections into the whole config the rest of the plugin reads. */
		const merged = () => ({
			...sources.cn().authFile === void 0 ? {} : { authFile: sources.cn().authFile },
			...sources.cn().probeConsent === void 0 ? {} : { probeConsent: sources.cn().probeConsent },
			...sources.ai().authFileAI === void 0 ? {} : { authFileAI: sources.ai().authFileAI },
			...sources.account3().authFile3 === void 0 ? {} : { authFile3: sources.account3().authFile3 },
			...sources.ai().useMaximumContextWindow === void 0 ? {} : { useMaximumContextWindow: sources.ai().useMaximumContextWindow }
		});
		const applyMaximumContextWindow = (next) => {
			const runtime = runtimes.find((candidate) => candidate.variant.region === "global");
			if (runtime?.catalog.setUseMaximumContextWindow(next.useMaximumContextWindow === true)) runtime.invalidate();
		};
		const repointStores = () => {
			const next = merged();
			applyMaximumContextWindow(next);
			for (const runtime of runtimes) runtime.store.setDesktopPath(configuredAuthFile(next, runtime.variant));
		};
		settingsCtx.settings.installSection(ctx, WORKBUDDY_SETTINGS_NS, CN_SECTION, config, {
			setSource(source) {
				sources.cn = source;
				current = merged;
			},
			onChange: repointStores
		});
		settingsCtx.settings.installSection(ctx, WORKBUDDY_AI_SETTINGS_NS, AI_SECTION, config, {
			setSource(source) {
				sources.ai = source;
				current = merged;
			},
			onChange: repointStores
		});
		settingsCtx.settings.installSection(ctx, WORKBUDDY_3_SETTINGS_NS, ACCOUNT3_SECTION, config, {
			setSource(source) {
				sources.account3 = source;
				current = merged;
			},
			onChange: repointStores
		});
		setMaximumContextWindow = async (enabled) => {
			await settingsCtx.settings.update(WORKBUDDY_AI_SETTINGS_NS, { useMaximumContextWindow: enabled });
			return { state: "updated" };
		};
	});
	ctx.effect(() => () => {
		stopped = true;
		for (const timer of timers) clearInterval(timer);
		timers.length = 0;
		clearHostHeartbeat();
	});
	/**
	* Fetch one variant's catalog for the current credential.
	*
	* Shared by the credential sweep and the card's manual refresh, and written
	* so that concurrent callers cost one request and cannot interleave badly:
	*
	* - **One request at a time.** A second caller joins the in-flight fetch
	*   instead of starting its own (spec §5: one catalog request per variant at
	*   a time).
	* - **Generation-checked write-back.** The request records the generation it
	*   started under and writes nothing if the generation moved on — which is
	*   what a slow answer from a superseded account must not do. Checking only
	*   the *identity* was not enough: two refreshes for the same account can
	*   still finish out of order, and the older one would win.
	* - **`resolve()`, not `current()`.** Only `resolve()` performs the locked,
	*   single-flight token renewal. Reading `current()` meant an expired token
	*   made every catalog request fail until something else happened to refresh
	*   it, leaving the group on the fallback roster.
	*/
	const fetchCatalog = async (runtime, identity) => {
		const inflight = runtime.inflightFetch;
		const generation = runtime.catalogGeneration;
		if (inflight !== void 0 && inflight.identity === identity && inflight.generation === generation) return inflight.promise;
		inflight?.controller.abort();
		const controller = new AbortController();
		let run;
		run = (async () => {
			let models;
			try {
				const credential = await runtime.store.resolve();
				const resolvedIdentity = credentialIdentity(credential);
				if (resolvedIdentity !== identity) {
					adoptIdentity(runtime, resolvedIdentity, visibilityAccountOf(credential));
					await fetchCatalog(runtime, resolvedIdentity);
					return;
				}
				models = await runtime.client.fetchModels(credential, controller.signal);
				const latest = await runtime.store.current();
				const latestIdentity = latest === void 0 ? void 0 : credentialIdentity(latest);
				if (latestIdentity !== identity) {
					adoptIdentity(runtime, latestIdentity, latest === void 0 ? void 0 : visibilityAccountOf(latest));
					if (latestIdentity !== void 0) await fetchCatalog(runtime, latestIdentity);
					return;
				}
			} catch (error) {
				if (stopped || runtime.catalogGeneration !== generation) return;
				runtime.lastFetchAtMs = Date.now();
				runtime.catalogError = error instanceof Error ? error.message.slice(0, 300) : String(error);
				ctx.logger.warn(`dsh-workbuddy-connect: ${runtime.variant.displayName} catalog unavailable; serving the fallback list`, error);
				runtime.invalidate();
				return;
			}
			if (stopped || runtime.catalogGeneration !== generation) return;
			runtime.lastFetchAtMs = Date.now();
			runtime.catalog.set([...models]);
			runtime.catalogSource = "live";
			runtime.catalogFetchedAtMs = runtime.client.lastCatalog?.fetchedAtMs ?? Date.now();
			runtime.catalogError = void 0;
			if (lastIdentities.get(runtime.variant.id) === identity) runtime.savedCatalogs.set(identity, {
				source: runtime.client.lastCatalog?.source ?? "unknown",
				fetchedAtMs: runtime.client.lastCatalog?.fetchedAtMs ?? Date.now(),
				models: [...models],
				...runtime.client.lastCatalog?.appVersion === void 0 ? {} : { appVersion: runtime.client.lastCatalog.appVersion.version }
			});
			runtime.invalidate();
		})().finally(() => {
			if (runtime.inflightFetch?.promise === run) runtime.inflightFetch = void 0;
		});
		runtime.inflightFetch = {
			identity,
			generation,
			controller,
			promise: run
		};
		return run;
	};
	/**
	* Reconcile one variant with its credentials.
	*
	* Four transitions matter, and each is a different action:
	*
	* - **none → some** (first sighting): reveal the group and fetch a catalog.
	* - **none → some, identity changed**: additionally drop the previous
	*   account's observations, so another user's probe answers cannot be read as
	*   the new account's.
	* - **some → none**: hide the group and stop serving its models.
	* - **same identity**: nothing to do — the store refreshes tokens on demand,
	*   and re-fetching on every rotation would hit the catalog endpoint for no
	*   new information.
	*/
	const syncVariant = async (runtime) => {
		if (stopped || !runtime.registered) return;
		const credential = await runtime.store.current().catch((error) => {
			ctx.logger.warn(`dsh-workbuddy-connect: ${runtime.variant.displayName} credential read failed`, error);
		});
		if (stopped) return;
		if (credential === void 0) {
			adoptIdentity(runtime, void 0, void 0);
			return;
		}
		const identity = credentialIdentity(credential);
		if (lastIdentities.get(runtime.variant.id) === identity && runtime.catalog.isVisible()) {
			/**
			 * Two different clocks, and conflating them was the bug:
			 *   - a catalog that never landed is *retried* quickly (10 sweeps);
			 *   - a catalog that landed successfully just *expires* (its own TTL).
			 * The second clock is what keeps the billing rates live — see
			 * {@link CATALOG_TTL_MS}.
			 */
			const ttl = runtime.catalogSource === "live" ? catalogTtlMs() : credentialPollMs() * CATALOG_RETRY_SWEEPS;
			if (Date.now() - runtime.lastFetchAtMs >= ttl) await fetchCatalog(runtime, identity);
			return;
		}
		adoptIdentity(runtime, identity, visibilityAccountOf(credential));
		await fetchCatalog(runtime, identity);
	};
	/** Run one reconcile sweep across both variants. */
	const syncAll = async () => {
		for (const runtime of runtimes) await syncVariant(runtime);
	};
	Promise.all(runtimes.map(async (runtime) => startVariant(ctx, runtime))).then(() => {
		if (stopped) return;
		if (runtimes.some((runtime) => runtime.registered)) writeHostHeartbeat();
		syncAll();
		const timer = setInterval(() => {
			syncAll();
		}, credentialPollMs());
		timer.unref?.();
		timers.push(timer);
	});
}
//#endregion
export { AI_VARIANT, CN_APP_VERSION_FILENAME, CN_VARIANT, Config, FALLBACK_CN_APP_VERSION, FALLBACK_WORKBUDDY_AI_MODELS, FALLBACK_WORKBUDDY_MODELS, PROBE_EFFORT_CANDIDATES, WORKBUDDY_AI_SETTINGS_NS, WORKBUDDY_APP_VERSION_FILENAME, WORKBUDDY_AUTH_FILENAME, WORKBUDDY_AUTH_FILE_ENV, WORKBUDDY_CATALOG_FILENAME, WORKBUDDY_HOST_HEARTBEAT_FILENAME, WORKBUDDY_PROBE_FILENAME, WORKBUDDY_PROVIDER, WORKBUDDY_SETTINGS_NS, WORKBUDDY_STREAM_IDLE_TIMEOUT_MS, WORKBUDDY_VARIANTS, WORKBUDDY_VISIBILITY_FILENAME, WorkBuddyCatalog, WorkBuddyCatalogStore, WorkBuddyCredentialStore, WorkBuddyProbeService, WorkBuddyProbeStore, WorkBuddyUpstreamClient, WorkBuddyVisibilityStore, appUserAgent, apply, chatUserAgent, classifyUpstreamError, clearHostHeartbeat, createWorkBuddyAdapter, createWorkBuddyShim, defaultDesktopAuthCandidates, defaultDesktopAuthPath, desktopAuthCandidatesFor, fallbackChatIdentity, fingerprintModel, inject, installedAppVersion, isHeartbeatProcessAlive, modelWithCurrentPromotion, name, normalizeCredits, parseModelCatalog, parseWorkBuddyAuth, prepareChatBody, prepareInternationalChatBody, probeModel, processStartTimeMs, randomSentinel, readBundleVersion, readCliVersion, readHostHeartbeat, regionOf, resolveAppVersion, resolveChatIdentity, validAppVersion, validCliVersion, variantFor, visibilityAccountOf, workbuddyCatalogPath, workbuddyHostHeartbeatPath, workbuddyOwnAuthPath, workbuddyProbePath, workbuddyVisibilityPath };
