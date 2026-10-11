/**
 * Global prompt — 客户端半边（自注册 bundle）。
 *
 * 投递契约：宿主把本文件原样作为 `<script>` 发出，因此它必须先向
 * `window.__ModuleLoader__` 注册自己，再以 CommonJS 形式导出 `apply` / `inject`。
 * 模块身份由 `id`（必须等于包名）决定，不导出 `name`。
 *
 * 只 require("react")：react / react-dom / react/jsx-runtime 是平台 seed（基线模块），
 * 无需在 dsh.client.external 里声明。
 *
 * 界面：在设置页注册一个一级分区。多行输入框没有官方原语可用，所以直接用原生
 * <textarea> + <button> + 主题 CSS 变量自绘。
 */
window.__ModuleLoader__.load({
	id: "dsh-global-prompt",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const { useCallback, useEffect, useMemo, useRef, useState } = React;
		const h = React.createElement;

		const API_PATH = "/global-prompt/api";
		const LOCALE_NS = "global-prompt";
		const WARN_BYTES = 65536;

		const ZH = {
			nav: "全局提示词",
			heading: "全局提示词",
			hint: "此处内容写入用户级全局指令文件，DSH 会在会话开始时把它注入 Agent 上下文，用于规范 Agent 的行为。",
			placeholder: "在这里输入全局提示词…",
			save: "保存",
			cancel: "取消",
			saving: "保存中…",
			loading: "读取中…",
			dirty: "有未保存的修改",
			targetLabel: "目标文件",
			missing: "（不存在，保存后创建）",
			warnLarge: "内容超过 64 KB，注入时可能被截断。",
			tooLarge: "内容过大，最多 1 MiB。",
			loadFailed: "读取失败",
			saveFailed: "保存失败",
			retry: "重试",
		};

		const EN = {
			nav: "Global Prompt",
			heading: "Global Prompt",
			hint: "This text is written to the user-level instructions file. DSH injects it into every agent session to steer the agent's behaviour.",
			placeholder: "Write your global prompt here…",
			save: "Save",
			cancel: "Cancel",
			saving: "Saving…",
			loading: "Loading…",
			dirty: "Unsaved changes",
			targetLabel: "Target file",
			missing: "(missing — created on save)",
			warnLarge: "Content exceeds 64 KB and may be truncated when injected.",
			tooLarge: "Content is too large; the limit is 1 MiB.",
			loadFailed: "Failed to load",
			saveFailed: "Failed to save",
			retry: "Retry",
		};

		/** 当前语言的兜底字典；locale 服务缺失时也能渲染。 */
		let fallback = ZH;

		/**
		 * 取出可用的 locale 服务，但绝不因它缺失或行为不符预期而让插件失效。
		 *
		 * @param {object} ctx - 客户端插件上下文。
		 * @returns {object|undefined} locale 服务。
		 */
		function localeService(ctx) {
			const service = typeof ctx.get === "function" ? ctx.get("locale") : ctx.locale;
			return service !== null && typeof service === "object" ? service : undefined;
		}

		/**
		 * 构建翻译函数：优先使用 locale 服务的命名空间绑定，失败则回退到内置字典。
		 *
		 * @param {object|undefined} locale - locale 服务。
		 * @returns {(key: string) => string} 翻译函数。
		 */
		function translator(locale) {
			if (locale !== undefined && typeof locale.bind === "function") {
				try {
					const bound = locale.bind(LOCALE_NS);
					if (typeof bound === "function") {
						return (key) => {
							const value = bound(key);
							return typeof value === "string" && value.length > 0 ? value : fallback[key] ?? key;
						};
					}
				} catch (error) {
					/* 回退到内置字典 */
				}
			}
			return (key) => fallback[key] ?? key;
		}

		/**
		 * 订阅 locale 变化以触发重渲染。
		 *
		 * @param {object|undefined} locale - locale 服务。
		 * @returns {number} 自增的 tick。
		 */
		function useLocaleTick(locale) {
			const [tick, setTick] = useState(0);
			useEffect(() => {
				if (locale === undefined || typeof locale.subscribe !== "function") return undefined;
				let active = true;
				const unsubscribe = locale.subscribe(() => {
					if (active) setTick((n) => n + 1);
				});
				return () => {
					active = false;
					if (typeof unsubscribe === "function") unsubscribe();
				};
			}, [locale]);
			return tick;
		}

		/**
		 * 发起一次 API 调用并归一化错误。
		 *
		 * @param {string} method - HTTP 方法。
		 * @param {object} [body] - 请求体。
		 * @returns {Promise<object>} 解析后的载荷。
		 */
		async function callApi(method, body) {
			const init = { method, headers: { accept: "application/json" }, credentials: "same-origin" };
			if (body !== undefined) {
				init.headers["content-type"] = "application/json";
				init.body = JSON.stringify(body);
			}
			const response = await fetch(API_PATH, init);
			let data = undefined;
			try {
				data = await response.json();
			} catch (error) {
				data = undefined;
			}
			if (!response.ok || data === undefined || data.ok !== true) {
				const detail = data !== undefined && typeof data.error === "string" ? data.error : `HTTP ${response.status}`;
				throw new Error(detail);
			}
			return data;
		}

		const COLOR = {
			label: "var(--dsw-alias-label-primary)",
			muted: "var(--dsw-alias-label-tertiary)",
			secondary: "var(--dsw-alias-label-secondary)",
			field: "var(--dsw-alias-bg-base)",
			border: "var(--dsw-alias-border-l2, var(--dsw-alias-border-l, rgba(127,127,127,0.35)))",
			primaryFill: "var(--dsw-alias-button-primary-fill)",
			primaryText: "var(--dsw-alias-label-primary-foreground, #fff)",
			danger: "var(--dsw-alias-state-business-primary, #e5484d)",
		};

		const FOCUS_RING = "0 0 0 2px var(--dsw-alias-interactive-bg-hover-accent, rgba(120,170,255,0.45))";

		/**
		 * 分区组件：一个长宽都大的输入框 + 下方保存/取消。
		 *
		 * @param {{locale?: object, close?: () => void}} props - 分区属性。
		 * @returns {object} React 元素。
		 */
		function GlobalPromptSection(props) {
			const locale = props.locale;
			const tick = useLocaleTick(locale);
			// tick 进依赖是有意的：换语言时重算翻译函数，其余渲染保持同一标识，
			// 否则 load 的身份会随每次渲染变化并触发取数死循环。
			const t = useMemo(() => translator(locale), [locale, tick]);
			const textareaRef = useRef(null);
			const rowRef = useRef(null);

			const [content, setContent] = useState("");
			const [saved, setSaved] = useState("");
			const [meta, setMeta] = useState(undefined);
			const [busy, setBusy] = useState(false);
			const [loading, setLoading] = useState(true);
			const [error, setError] = useState(undefined);
			const [focused, setFocused] = useState(false);
			const [loaded, setLoaded] = useState(false);

			const load = useCallback(async () => {
				setLoading(true);
				setError(undefined);
				try {
					const data = await callApi("GET");
					setContent(data.content);
					setSaved(data.content);
					setMeta(data);
					setLoaded(true);
				} catch (cause) {
					setError(`${t("loadFailed")}：${cause.message ?? cause}`);
				} finally {
					setLoading(false);
				}
			}, [t]);

			useEffect(() => {
				void load();
			}, [load]);

			const dirty = loaded && content !== saved;

			// 收起底部两侧的保存信息，并把焦点从输入框上摘掉（保存或取消后的收尾动作）。
			const collapse = useCallback(() => {
				const active = typeof document === "undefined" ? null : document.activeElement;
				if (active !== null && typeof active.blur === "function") active.blur();
				setFocused(false);
			}, []);

			const save = useCallback(async () => {
				const bytes = new TextEncoder().encode(content).length;
				if (bytes > 1024 * 1024) {
					setError(t("tooLarge"));
					return;
				}
				setBusy(true);
				setError(undefined);
				try {
					const data = await callApi("POST", { content });
					setSaved(data.content);
					setMeta(data);
					collapse();
				} catch (cause) {
					// 失败时保持展开，否则错误提示会随焦点一起消失。
					setError(`${t("saveFailed")}：${cause.message ?? cause}`);
				} finally {
					setBusy(false);
				}
			}, [content, t, collapse]);

			const cancel = useCallback(() => {
				setContent(saved);
				setError(undefined);
				collapse();
			}, [saved, collapse]);

			useEffect(() => {
				const onKeyDown = (event) => {
					if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.key === "s" || event.key === "S")) {
						event.preventDefault();
						void save();
					}
				};
				window.addEventListener("keydown", onKeyDown);
				return () => window.removeEventListener("keydown", onKeyDown);
			}, [save]);

			const bytes = new TextEncoder().encode(content).length;
			const status = (() => {
				if (loading) return { text: t("loading"), color: COLOR.muted };
				if (error !== undefined) return { text: error, color: COLOR.danger };
				if (busy) return { text: t("saving"), color: COLOR.secondary };
				if (bytes > WARN_BYTES) return { text: t("warnLarge"), color: COLOR.secondary };
				if (dirty || focused) return { text: t("dirty"), color: COLOR.secondary };
				return { text: "", color: COLOR.muted };
			})();

			// 只在编辑（聚焦输入框）或出错时露出底部两侧的保存信息；其余时候只留目标文件提示。
			const expanded = focused || busy || error !== undefined;

			const targetLine = meta === undefined
				? undefined
				: `${t("targetLabel")}：${meta.displayPath}${meta.exists ? "" : ` ${t("missing")}`}`;

			const textareaStyle = {
				flex: "1 1 auto",
				width: "100%",
				minHeight: "260px",
				boxSizing: "border-box",
				resize: "vertical",
				padding: "12px 14px",
				borderRadius: "var(--dsw-radius-md, 8px)",
				border: `1px solid ${COLOR.border}`,
				background: COLOR.field,
				color: COLOR.label,
				fontSize: "13px",
				lineHeight: "1.6",
				fontFamily: "var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)",
				outline: "none",
				tabSize: 2,
			};

			const buttonStyle = (variant) => ({
				appearance: "none",
				cursor: busy && variant === "primary" ? "default" : "pointer",
				height: "32px",
				padding: "0 16px",
				borderRadius: "var(--dsw-radius-md, 8px)",
				border: variant === "primary" ? "1px solid transparent" : `1px solid ${COLOR.border}`,
				background: variant === "primary" ? COLOR.primaryFill : "transparent",
				color: variant === "primary" ? COLOR.primaryText : COLOR.secondary,
				fontSize: "13px",
				fontWeight: variant === "primary" ? 500 : 400,
				opacity: busy ? 0.6 : 1,
				transition: "background 120ms ease, opacity 120ms ease",
			});

			return h(
				"div",
				{ style: { display: "flex", flexDirection: "column", gap: "10px", height: "100%", minHeight: 0, padding: "4px 0 0" } },
				h("div", { style: { fontSize: "14px", fontWeight: 600, color: COLOR.label } }, t("heading")),
				h("div", { style: { fontSize: "12px", color: COLOR.muted, lineHeight: "1.6" } }, t("hint")),
				h("textarea", {
					ref: textareaRef,
					value: content,
					disabled: loading,
					spellCheck: false,
					placeholder: t("placeholder"),
					onChange: (event) => {
						setContent(event.target.value);
					},
					onFocus: (event) => {
						event.target.style.boxShadow = FOCUS_RING;
						setFocused(true);
					},
					onBlur: (event) => {
						event.target.style.boxShadow = "none";
						// 焦点移到本行按钮（键盘 Tab）时保持展开，否则按钮会在点击生效前被卸载。
						const next = event.relatedTarget;
						if (next !== null && rowRef.current !== null && rowRef.current.contains(next)) return;
						setFocused(false);
					},
					style: textareaStyle,
					"aria-label": t("heading"),
				}),
				h(
					"div",
					{
						ref: rowRef,
						style: {
							display: "flex",
							alignItems: "center",
							gap: "12px",
							marginTop: "2px",
							paddingBottom: "22px",
						},
					},
					expanded
						? h(
							"div",
							{
								title: error !== undefined && !loading ? error : status.text,
								style: {
									flex: "0 1 auto",
									display: "flex",
									alignItems: "center",
									gap: "6px",
									maxWidth: "40%",
									fontSize: "12px",
									color: status.color,
									whiteSpace: "nowrap",
									overflow: "hidden",
									textOverflow: "ellipsis",
								},
							},
							error !== undefined && !loading
								? h("span", { style: { overflow: "hidden", textOverflow: "ellipsis" } }, error,
									h("button", {
										type: "button",
										onMouseDown: (event) => event.preventDefault(),
										onClick: () => void load(),
										style: { ...buttonStyle("ghost"), height: "22px", padding: "0 8px", marginLeft: "6px" },
									}, t("retry")))
								: h("span", { style: { overflow: "hidden", textOverflow: "ellipsis" } }, status.text),
						)
						: null,
					targetLine === undefined
						? null
						: h(
							"div",
							{
								title: targetLine,
								style: {
									flex: "1 1 auto",
									minWidth: 0,
									textAlign: "center",
									fontSize: "11px",
									color: COLOR.muted,
									whiteSpace: "nowrap",
									overflow: "hidden",
									textOverflow: "ellipsis",
								},
							},
							targetLine,
						),
					expanded
						? h(
							"div",
							{
								style: {
									flex: "0 0 auto",
									marginLeft: "auto",
									display: "flex",
									alignItems: "center",
									gap: "10px",
								},
							},
							h(
								"button",
								{
									type: "button",
									disabled: busy || loading,
									// 不让按钮抢走输入框焦点，否则按钮会在本次点击生效前被卸载。
									onMouseDown: (event) => event.preventDefault(),
									onClick: cancel,
									style: buttonStyle("ghost"),
								},
								t("cancel"),
							),
							h(
								"button",
								{
									type: "button",
									disabled: busy || loading,
									onMouseDown: (event) => event.preventDefault(),
									onClick: () => void save(),
									style: buttonStyle("primary"),
								},
								busy ? t("saving") : t("save"),
							),
						)
						: null,
				),
			);
		}

		/**
		 * 设置导航图标几何：官方 IconContextInjectionOutline 的路径（16px 网格、stroke 1.3、
		 * currentColor），逐个抄自 dsh-client-ui-primitives 的同名 artwork，与官方图标族同描边同网格。
		 */
		const NAV_ICON_PATHS = [
			"M5 2.5H3.5C3.23478 2.5 2.98043 2.60536 2.79289 2.79289C2.60536 2.98043 2.5 3.23478 2.5 3.5V13.5C2.5 13.7652 2.60536 14.0196 2.79289 14.2071C2.98043 14.3946 3.23478 14.5 3.5 14.5H12.5C12.7652 14.5 13.0196 14.3946 13.2071 14.2071C13.3946 14.0196 13.5 13.7652 13.5 13.5V3.5C13.5 3.23478 13.3946 2.98043 13.2071 2.79289C13.0196 2.60536 12.7652 2.5 12.5 2.5H11",
			"M8 0.5V7.5",
			"M5.5 5L8 7.5L10.5 5",
			"M5.5 11H10.5",
		];

		/**
		 * 生成导航图标的 SVG 标记。
		 *
		 * @param {string|null} className - 被替换元素上的 class（继承 shell 的布局约束，如 flex:none）。
		 * @returns {string} SVG 标记。
		 */
		function navIconMarkup(className) {
			const paths = NAV_ICON_PATHS.map((d) => `<path d="${d}" stroke="currentColor"/>`).join("");
			const cls = className === null || className === "" ? "" : ` class="${className}"`;
			return `<svg${cls} width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke-width="1.3">${paths}</svg>`;
		}

		/**
		 * 把设置导航里本分区那一格的兜底齿轮换成上面的图标。
		 *
		 * 官方设置导航的图标是 shell 里 `navIcon(id)` 的硬编码映射，第三方 section 一律拿兜底
		 * 齿轮，注册参数里没有图标位，只能做 DOM 补丁。锚点是本分区自己注册的 label 文本
		 * （随语言变，所以匹配时现取）；补丁失败（结构变了 / 找不到按钮）的语义是保留齿轮，
		 * 不抛、不重试。
		 *
		 * @param {() => string} label - 当前分区标签。
		 * @returns {(() => void)|undefined} 卸载函数；装不上时返回 undefined。
		 */
		function installNavIcon(label) {
			if (typeof document === "undefined" || !document.body) return undefined;
			if (typeof MutationObserver !== "function") return undefined;
			const patched = new WeakSet();
			const patchIn = (root) => {
				if (!root || typeof root.querySelectorAll !== "function") return;
				let buttons = [];
				try {
					buttons = root.querySelectorAll('[role="dialog"] nav button');
				} catch (error) {
					return;
				}
				const want = String(label()).trim();
				for (const button of buttons) {
					try {
						if (patched.has(button)) continue;
						if ((button.textContent || "").trim() !== want) continue;
						// 结构异常（图标与标签没分成两个子元素）= 放弃这枚按钮，保齿轮。
						const iconElement = button.firstElementChild;
						if (iconElement === null || button.childElementCount < 2) continue;
						const host = document.createElement("div");
						host.innerHTML = navIconMarkup(iconElement.getAttribute("class"));
						const icon = host.firstElementChild;
						if (icon === null) continue;
						button.replaceChild(icon, iconElement);
						patched.add(button);
					} catch (error) {
						/* 单个按钮失败不影响其它 */
					}
				}
			};
			// 设置对话框可能已经开着（插件热重载）：先补一次现况。
			patchIn(document.body);
			// 对话框 overlay 是 body 的直接子节点，只盯 body 的一层 childList。
			const observer = new MutationObserver((records) => {
				for (const record of records) {
					for (const node of record.addedNodes) {
						if (node.nodeType === 1) patchIn(node);
					}
				}
			});
			try {
				observer.observe(document.body, { childList: true });
			} catch (error) {
				return undefined;
			}
			return () => {
				try {
					observer.disconnect();
				} catch (error) {
					/* ignore */
				}
			};
		}

		/**
		 * 插件入口：注册设置页一级分区。
		 *
		 * @param {object} ctx - 客户端插件上下文。
		 * @returns {void}
		 */
		function apply(ctx) {
			const locale = localeService(ctx);
			if (locale !== undefined && typeof locale.register === "function") {
				try {
					ctx.effect(() => locale.register(LOCALE_NS, { zh: ZH, en: EN }), "global-prompt:dictionaries");
				} catch (error) {
					/* 字典注册失败不影响功能 */
				}
			}
			const t = translator(locale);
			// 导航标签随语言变；注册与 DOM 图标补丁共用同一个 thunk。
			const label = () => t("nav");
			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{
						name: "settings.section",
						id: "global-prompt",
						order: 600,
						label,
					},
					() => h(GlobalPromptSection, { locale }),
				),
			);
			ctx.effect(() => installNavIcon(label), "global-prompt:nav-icon");
		}

		exports.apply = apply;
		exports.inject = ["slots"];
		return module.exports;
	},
});
