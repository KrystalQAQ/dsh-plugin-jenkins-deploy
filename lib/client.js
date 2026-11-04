// 部署发布插件 —— Client 半边（在浏览器中运行）
//
// 该文件是 DSH 客户端插件的“自注册包”格式：window.__ModuleLoader__.load({ id, factory })。
// factory 内可用 require(...) 加载共享模块（react / react/jsx-runtime 等），最后 return module.exports。
// 客户端注册两类插槽：
//   - sidebar.panellist：左侧栏入口图标（id = PANEL_ID）
//   - main：点击图标后主区域显示的页面（key = PANEL_ID）
//
// 样式策略：优先使用 DSH 主题 token（--dsw-alias-* / --dsw-radius-* / --dsw-shadow-*），
// 保证浅色/深色主题自动适配；:hover、滚动条、焦点等无法用内联样式表达的，注入一小段 CSS。
window.__ModuleLoader__.load({
	id: "dsh-plugin-jenkins-deploy",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;
		const { useState, useEffect, useRef, useCallback, useMemo } = React;

		// 主面板标识：sidebar.panellist 的 id 与 main 的 key 必须一致。
		const PANEL_ID = "jenkins-deploy";
		// 国际化命名空间。
		const NS = "jenkinsDeploy";
		// 主机路由前缀（与 Host 半边一致）。
		const API = "/x-jenkins-deploy";
		// 客户端依赖的运行时服务。
		const inject = ["slots", "locale"];

		// ==================================================================
		// 主题 token 快捷引用（带兜底，兼容无 token 的老组合）
		// ==================================================================
		const T = {
			bg: "var(--dsw-alias-bg-base, #fff)",
			layer1: "var(--dsw-alias-bg-layer-1, #fafafa)",
			layer2: "var(--dsw-alias-bg-layer-2, #f3f4f6)",
			overlay: "var(--dsw-alias-bg-overlay, #fff)",
			mask: "var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.45))",
			b1: "var(--dsw-alias-border-l1, rgba(0,0,0,0.06))",
			b2: "var(--dsw-alias-border-l2, rgba(0,0,0,0.12))",
			t1: "var(--dsw-alias-label-primary, #111827)",
			t2: "var(--dsw-alias-label-secondary, #4b5563)",
			t3: "var(--dsw-alias-label-tertiary, #9ca3af)",
			brand: "var(--dsw-alias-brand-primary, #2563eb)",
			brandFg: "var(--dsw-alias-label-primary-foreground, #fff)",
			success: "var(--dsw-alias-state-success-primary, #16a34a)",
			error: "var(--dsw-alias-state-error-primary, #dc2626)",
			warn: "var(--dsw-alias-state-warn-label, #d97706)",
			hover: "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.04))",
			r4: "var(--dsw-radius-xs, 6px)",
			r6: "var(--dsw-radius-sm, 8px)",
			r8: "var(--dsw-radius-md, 12px)",
			r12: "var(--dsw-radius-lg, 16px)",
			s1: "var(--dsw-shadow-lv1, 0 1px 3px rgba(0,0,0,0.08))",
			s2: "var(--dsw-shadow-lv2, 0 6px 24px rgba(0,0,0,0.14))",
			mono: "var(--dsh-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)"
		};

		// 注入一次性全局 CSS：伪类状态、滚动条、动画、focus。
		const STYLE_ID = "jenkins-deploy-plugin-style";
		function ensureStyle() {
			if (typeof document === "undefined") return;
			if (document.getElementById(STYLE_ID)) return;
			const el = document.createElement("style");
			el.id = STYLE_ID;
			el.textContent = `
.jdp-scroll::-webkit-scrollbar{width:10px;height:10px}
.jdp-scroll::-webkit-scrollbar-thumb{background:var(--dsh-scrollbar-thumb,rgba(0,0,0,.15));border-radius:8px;border:2px solid transparent;background-clip:padding-box}
.jdp-scroll::-webkit-scrollbar-thumb:hover{background:var(--dsh-scrollbar-thumb-hover,rgba(0,0,0,.28));background-clip:padding-box}
.jdp-card{transition:box-shadow .18s ease, border-color .18s ease, transform .18s ease}
.jdp-card:hover{box-shadow:var(--dsw-shadow-lv2,0 6px 24px rgba(0,0,0,.14));border-color:var(--dsw-alias-border-l3,rgba(0,0,0,.18))}
.jdp-row-hover:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.jdp-btn{transition:background .15s ease,border-color .15s ease,opacity .15s ease,filter .15s ease}
.jdp-btn:not(:disabled):hover{filter:brightness(.96)}
.jdp-btn:not(:disabled):active{transform:translateY(1px)}
.jdp-primary:not(:disabled):hover{filter:brightness(1.06)}
.jdp-tab{transition:color .15s ease,background .15s ease}
.jdp-tab:hover{color:var(--dsw-alias-label-primary,#111)}
.jdp-link:hover{text-decoration:underline}
.jdp-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#2563eb);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary,#2563eb) 18%,transparent)}
.jdp-fade{animation:jdpFade .18s ease}
@keyframes jdpFade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.jdp-spin{animation:jdpSpin .8s linear infinite}
@keyframes jdpSpin{to{transform:rotate(360deg)}}
`;
			document.head.appendChild(el);
		}

		// ==================================================================
		// 内联样式（结构/间距/排版）
		// ==================================================================
		const S = {
			page: { display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", background: T.bg, color: T.t1, fontSize: 13 },

			// 顶栏
			header: { padding: "16px 24px 0", display: "flex", flexDirection: "column", gap: 14, borderBottom: `1px solid ${T.b1}` },
			headerTop: { display: "flex", alignItems: "center", gap: 12 },
			brandIcon: { width: 34, height: 34, borderRadius: T.r6, display: "flex", alignItems: "center", justifyContent: "center", background: `color-mix(in srgb, ${T.brand} 14%, transparent)`, color: T.brand, flex: "none" },
			titleWrap: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
			title: { fontSize: 16, fontWeight: 650, letterSpacing: .2, lineHeight: 1.2 },
			subtitle: { fontSize: 12, color: T.t3, lineHeight: 1.2 },
			spacer: { flex: 1 },

			// 分段控件（tabs）
			segmented: { display: "inline-flex", padding: 3, borderRadius: T.r6, background: T.layer2, gap: 2 },
			segBtn: (active) => ({
				border: "none", cursor: "pointer", padding: "6px 16px", borderRadius: T.r4, fontSize: 13, fontWeight: 550,
				background: active ? T.overlay : "transparent", color: active ? T.t1 : T.t2,
				boxShadow: active ? T.s1 : "none", lineHeight: 1.2
			}),
			toolbar: { display: "flex", alignItems: "center", gap: 10, paddingBottom: 12 },

			body: { flex: 1, overflow: "auto", padding: "20px 24px 40px" },

			// 分组
			group: { marginBottom: 26 },
			groupHead: { display: "flex", alignItems: "center", gap: 8, marginBottom: 12 },
			groupDot: (color) => ({ width: 8, height: 8, borderRadius: 999, background: color, flex: "none" }),
			groupTitle: { fontSize: 12.5, fontWeight: 650, color: T.t2, letterSpacing: .3 },
			groupCount: { fontSize: 12, color: T.t3, fontWeight: 500 },

			// 项目卡片
			card: { position: "relative", display: "flex", alignItems: "center", gap: 16, padding: "14px 16px 14px 18px", marginBottom: 10, borderRadius: T.r8, border: `1px solid ${T.b1}`, background: T.layer1, overflow: "hidden" },
			cardAccent: (color) => ({ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: color }),
			cardMain: { display: "flex", flexDirection: "column", gap: 7, minWidth: 0, flex: 1 },
			cardLine: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 },
			jobName: { fontFamily: T.mono, fontSize: 13, fontWeight: 600, color: T.t1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
			metaLine: { display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", fontSize: 12, color: T.t3 },
			metaItem: { display: "inline-flex", alignItems: "center", gap: 5 },

			// 药丸标签
			pill: (color, solid) => ({
				display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 600, lineHeight: 1,
				padding: "4px 9px", borderRadius: 999,
				background: solid ? color : `color-mix(in srgb, ${color} 14%, transparent)`,
				color: solid ? "#fff" : color,
				border: solid ? "none" : `1px solid color-mix(in srgb, ${color} 30%, transparent)`
			}),
			stateDot: (color) => ({ width: 7, height: 7, borderRadius: 999, background: color, flex: "none" }),

			// 操作区
			actions: { display: "flex", alignItems: "center", gap: 8, flex: "none" },

			// 按钮
			btn: (kind, size) => {
				const pad = size === "sm" ? "6px 11px" : "7px 14px";
				const base = { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, cursor: "pointer", padding: pad, borderRadius: T.r4, fontSize: 12.5, fontWeight: 550, lineHeight: 1.2, whiteSpace: "nowrap", border: `1px solid ${T.b2}`, background: "transparent", color: T.t1 };
				if (kind === "primary") return { ...base, border: "none", background: T.brand, color: T.brandFg };
				if (kind === "danger") return { ...base, border: "none", background: T.error, color: "#fff" };
				if (kind === "ghost") return { ...base, border: "1px solid transparent", color: T.t2 };
				return base;
			},
			btnDisabled: { opacity: .5, cursor: "not-allowed", filter: "none" },

			select: { padding: "6px 10px", borderRadius: T.r4, border: `1px solid ${T.b2}`, background: T.overlay, color: T.t1, fontSize: 12.5, cursor: "pointer" },

			// 设置表单
			form: { maxWidth: 600, display: "flex", flexDirection: "column", gap: 18 },
			field: { display: "flex", flexDirection: "column", gap: 7 },
			label: { fontSize: 12.5, fontWeight: 600, color: T.t2 },
			input: { padding: "9px 12px", borderRadius: T.r4, border: `1px solid ${T.b2}`, background: T.overlay, color: T.t1, fontSize: 13, width: "100%", boxSizing: "border-box" },
			hint: { fontSize: 11.5, color: T.t3, lineHeight: 1.5 },
			formActions: { display: "flex", alignItems: "center", gap: 12, marginTop: 4 },

			// 状态提示
			msgOk: { color: T.success, fontSize: 12.5, display: "inline-flex", alignItems: "center", gap: 6 },
			msgErr: { color: T.error, fontSize: 12.5, display: "inline-flex", alignItems: "center", gap: 6 },

			// 空/加载
			center: (minH) => ({ minHeight: minH || 240, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, color: T.t3, textAlign: "center" }),
			bigIcon: { width: 56, height: 56, borderRadius: T.r12, display: "flex", alignItems: "center", justifyContent: "center", background: T.layer2, color: T.t3 },

			// 模态
			mask: { position: "fixed", inset: 0, background: T.mask, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999, backdropFilter: "blur(2px)" },
			modal: { background: T.overlay, color: T.t1, borderRadius: T.r12, padding: 24, maxWidth: 468, width: "92%", boxShadow: T.s2, border: `1px solid ${T.b1}` },
			modalHead: { display: "flex", alignItems: "center", gap: 12, marginBottom: 14 },
			modalIconDanger: { width: 40, height: 40, borderRadius: T.r6, display: "flex", alignItems: "center", justifyContent: "center", background: `color-mix(in srgb, ${T.error} 14%, transparent)`, color: T.error, flex: "none" },
			modalTitle: { fontSize: 15, fontWeight: 650 },
			modalBody: { fontSize: 13, color: T.t2, lineHeight: 1.6, marginBottom: 20 },
			modalFoot: { display: "flex", justifyContent: "flex-end", gap: 10 },

			consoleModal: { background: T.overlay, color: T.t1, borderRadius: T.r12, padding: 20, maxWidth: 880, width: "92%", maxHeight: "84vh", display: "flex", flexDirection: "column", boxShadow: T.s2, border: `1px solid ${T.b1}` },
			console: { fontFamily: T.mono, fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-word", background: T.layer2, color: T.t1, padding: 14, borderRadius: T.r6, flex: 1, overflow: "auto", lineHeight: 1.6, marginTop: 4 },

			// toast
			toast: (ok) => ({ position: "fixed", right: 24, bottom: 24, zIndex: 10000, display: "flex", alignItems: "center", gap: 9, padding: "11px 16px", borderRadius: T.r6, background: T.overlay, color: T.t1, boxShadow: T.s2, border: `1px solid ${ok ? "color-mix(in srgb, " + T.success + " 40%, transparent)" : "color-mix(in srgb, " + T.error + " 40%, transparent)"}`, fontSize: 13, maxWidth: 420 })
		};

		// ==================================================================
		// HTTP
		// ==================================================================
		async function apiGet(path) {
			const res = await fetch(API + path, { headers: { accept: "application/json" } });
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
			return data;
		}
		async function apiPost(path, body) {
			const res = await fetch(API + path, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body || {}) });
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
			return data;
		}

		// ==================================================================
		// 工具
		// ==================================================================
		function formatTime(ts) {
			if (!ts) return "-";
			const d = new Date(ts), p = (n) => String(n).padStart(2, "0");
			return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
		}
		function resultColor(result, building) {
			if (building) return "#2563eb";
			if (result === "SUCCESS") return T.success;
			if (result === "FAILURE") return T.error;
			if (result === "ABORTED") return T.warn;
			return T.t3;
		}
		function resultText(result, building) {
			if (building) return "构建中";
			if (result === "SUCCESS") return "成功";
			if (result === "FAILURE") return "失败";
			if (result === "ABORTED") return "已中止";
			return result || "无记录";
		}
		// 内联小图标（stroke currentColor）
		function Icon({ name, size }) {
			const s = size || 16;
			const paths = {
				rocket: h("g", null, h("path", { d: "M12 3c3 2 4 5 4 8 0 2-1 3-2 4H10c-1-1-2-2-2-4 0-3 1-6 4-8z" }), h("circle", { cx: 12, cy: 9, r: 1.6 }), h("path", { d: "M8 15l-2 4 3-1M16 15l2 4-3-1" })),
				refresh: h("g", null, h("path", { d: "M4 12a8 8 0 0 1 13.7-5.7L20 8M20 3v5h-5" }), h("path", { d: "M20 12a8 8 0 0 1-13.7 5.7L4 16M4 21v-5h5" })),
				terminal: h("g", null, h("rect", { x: 3, y: 4, width: 18, height: 16, rx: 2 }), h("path", { d: "M7 9l3 3-3 3M13 15h4" })),
				external: h("g", null, h("path", { d: "M14 4h6v6M20 4l-9 9M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6" })),
				warn: h("g", null, h("path", { d: "M12 3l9 16H3z" }), h("path", { d: "M12 9v5M12 16.5v.5" })),
				check: h("path", { d: "M4 12.5l5 5L20 6" }),
				close: h("path", { d: "M6 6l12 12M18 6L6 18" }),
				chevron: h("path", { d: "M9 6l6 6-6 6" })
			};
			return h("svg", { width: s, height: s, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" }, paths[name] || null);
		}

		// 左侧栏图标（尺寸由侧栏传入）
		function DeployIcon({ size }) {
			const s = typeof size === "number" ? size : 20;
			return h("svg", { width: s, height: s, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" },
				h("path", { d: "M12 3c3 2 4 5 4 8 0 2-1 3-2 4H10c-1-1-2-2-2-4 0-3 1-6 4-8z" }),
				h("circle", { cx: 12, cy: 9, r: 1.6 }),
				h("path", { d: "M8 15l-2 4 3-1M16 15l2 4-3-1" })
			);
		}

		// 环境颜色
		// 环境语义色：开发=蓝、测试=琥珀、生产=红（独立于单色的 brand token，保证可辨识）。
		function envColor(env) { return env === "prod" ? "#dc2626" : env === "test" ? "#d97706" : env === "dev" ? "#2563eb" : T.t3; }

		// ==================================================================
		// 生产确认弹窗
		// ==================================================================
		function ConfirmModal({ job, params, onCancel, onConfirm }) {
			return h("div", { style: S.mask, className: "jdp-fade", onClick: onCancel },
				h("div", { style: S.modal, onClick: (e) => e.stopPropagation() },
					h("div", { style: S.modalHead },
						h("div", { style: S.modalIconDanger }, h(Icon, { name: "warn", size: 22 })),
						h("div", { style: S.modalTitle }, "生产环境部署确认")
					),
					h("div", { style: S.modalBody },
						"你即将部署生产环境任务 ",
						h("strong", { style: { fontFamily: T.mono, color: T.t1 } }, job.name),
						params && params.build_branch ? h("span", null, "（分支 ", h("code", null, params.build_branch), "）") : null,
						"。",
						h("br"),
						h("span", { style: { color: T.t3 } }, "生产部署会影响线上服务，请确认已完成测试并准备回滚方案。")
					),
					h("div", { style: S.modalFoot },
						h("button", { className: "jdp-btn", style: S.btn("ghost"), onClick: onCancel }, "取消"),
						h("button", { className: "jdp-btn", style: S.btn("danger"), onClick: onConfirm }, "确认部署到生产")
					)
				)
			);
		}

		// ==================================================================
		// 项目卡片
		// ==================================================================
		function JobCard({ job, status, onDeploy, onShowConsole, deploying }) {
			const [branch, setBranch] = useState("dev");
			const [paramInfo, setParamInfo] = useState(null);
			const [paramLoading, setParamLoading] = useState(true);

			useEffect(() => {
				let alive = true;
				apiGet("/job/" + encodeURIComponent(job.name) + "/params")
					.then((info) => { if (alive) setParamInfo(info.parameters || []); })
					.catch(() => { if (alive) setParamInfo([]); })
					.finally(() => { if (alive) setParamLoading(false); });
				return () => { alive = false; };
			}, [job.name]);

			const branchParam = (paramInfo || []).find((p) => p.name === "build_branch" || /branch/i.test(p.name));
			const needsBranch = !!branchParam;
			const branchChoices = branchParam && Array.isArray(branchParam.choices) && branchParam.choices.length ? branchParam.choices : ["dev", "master"];

			const lb = status && status.lastBuild ? status.lastBuild : null;
			const accent = lb ? resultColor(lb.result, lb.building) : T.b2;

			return h("div", { className: "jdp-card", style: S.card },
				h("div", { style: S.cardAccent(accent) }),
				h("div", { style: S.cardMain },
					h("div", { style: S.cardLine },
						h("span", { style: S.jobName, title: job.name }, job.name),
						h("span", { style: S.pill(envColor(job.env), false) }, job.envLabel),
						h("span", { style: S.pill(job.kind === "frontend" ? "#7c3aed" : "#0ea5e9", false) }, job.kindLabel)
					),
					h("div", { style: S.metaLine },
						lb
							? h("span", { style: S.metaItem },
								h("span", { style: S.stateDot(resultColor(lb.result, lb.building)) }),
								h("span", null, "#" + lb.number + " · " + resultText(lb.result, lb.building)),
								h("span", { style: { color: T.t3 } }, "· " + formatTime(lb.timestamp))
							)
							: h("span", { style: { color: T.t3 } }, "暂无构建记录")
					)
				),
				h("div", { style: S.actions },
					needsBranch && !paramLoading
						? h("select", { style: S.select, value: branch, onChange: (e) => setBranch(e.target.value), title: "选择分支" },
							branchChoices.map((c) => h("option", { key: c, value: c }, c)))
						: null,
					lb ? h("button", { className: "jdp-btn", style: S.btn("ghost", "sm"), onClick: () => onShowConsole(job, lb.number), title: "查看日志" }, h(Icon, { name: "terminal", size: 15 }), "日志") : null,
					lb && lb.url ? h("a", { className: "jdp-btn jdp-link", href: lb.url, target: "_blank", rel: "noreferrer", style: { ...S.btn("ghost", "sm"), textDecoration: "none" }, title: "在 Jenkins 中打开" }, h(Icon, { name: "external", size: 15 })) : null,
					h("button", {
						className: job.env === "prod" ? "jdp-btn" : "jdp-btn jdp-primary",
						style: { ...(job.env === "prod" ? S.btn("danger") : S.btn("primary")), ...(deploying ? S.btnDisabled : {}) },
						disabled: deploying,
						onClick: () => onDeploy(job, needsBranch ? { build_branch: branch } : {})
					}, deploying ? "触发中..." : (job.env === "prod" ? "部署到生产" : "部署"))
				)
			);
		}

		// ==================================================================
		// 设置面板
		// ==================================================================
		function SettingsPanel({ onSaved }) {
			const [url, setUrl] = useState("");
			const [user, setUser] = useState("");
			const [token, setToken] = useState("");
			const [hasToken, setHasToken] = useState(false);
			const [loading, setLoading] = useState(true);
			const [saving, setSaving] = useState(false);
			const [msg, setMsg] = useState(null);

			useEffect(() => {
				apiGet("/config")
					.then((c) => { setUrl(c.url || ""); setUser(c.user || ""); setHasToken(!!c.hasToken); })
					.catch((e) => setMsg({ err: true, text: e.message }))
					.finally(() => setLoading(false));
			}, []);

			const save = async () => {
				setSaving(true); setMsg(null);
				try {
					const r = await apiPost("/config", { url, user, token });
					setHasToken(!!r.hasToken); setToken("");
					setMsg({ ok: true, text: "已保存" });
					onSaved && onSaved();
				} catch (e) { setMsg({ err: true, text: e.message }); }
				finally { setSaving(false); }
			};

			if (loading) return h("div", { style: S.center(200) }, h("div", { style: S.hint }, "加载中..."));

			return h("div", { style: S.form, className: "jdp-fade" },
				h("div", { style: S.field },
					h("label", { style: S.label }, "Jenkins 地址"),
					h("input", { className: "jdp-input", style: S.input, value: url, placeholder: "http://jenkins.dev.sczlcq.com", onChange: (e) => setUrl(e.target.value) })
				),
				h("div", { style: S.field },
					h("label", { style: S.label }, "用户名"),
					h("input", { className: "jdp-input", style: S.input, value: user, placeholder: "tanyu", onChange: (e) => setUser(e.target.value) })
				),
				h("div", { style: S.field },
					h("label", { style: S.label }, "API Token"),
					h("input", { className: "jdp-input", style: S.input, type: "password", value: token, placeholder: hasToken ? "已配置（留空则不修改）" : "请输入 Jenkins API Token", onChange: (e) => setToken(e.target.value) }),
					h("div", { style: S.hint }, "Token 仅保存在服务端本地文件（权限 600），不会下发到浏览器。")
				),
				h("div", { style: S.formActions },
					h("button", { className: "jdp-btn jdp-primary", style: { ...S.btn("primary"), ...(saving ? S.btnDisabled : {}) }, disabled: saving, onClick: save }, saving ? "保存中..." : "保存"),
					msg ? h("span", { style: msg.err ? S.msgErr : S.msgOk }, h(Icon, { name: msg.err ? "warn" : "check", size: 14 }), msg.text) : null
				)
			);
		}

		// ==================================================================
		// 主页面
		// ==================================================================
		function JenkinsDeployPage() {
			ensureStyle();
			const [tab, setTab] = useState("jobs");
			const [jobs, setJobs] = useState([]);
			const [statusMap, setStatusMap] = useState({});
			const [loading, setLoading] = useState(true);
			const [error, setError] = useState(null);
			const [deploying, setDeploying] = useState({});
			const [confirm, setConfirm] = useState(null);
			const [consoleInfo, setConsoleInfo] = useState(null);
			const [toast, setToast] = useState(null);
			const pollRef = useRef(null);
			const toastTimer = useRef(null);

			const showToast = (ok, text) => {
				setToast({ ok, text });
				if (toastTimer.current) clearTimeout(toastTimer.current);
				toastTimer.current = setTimeout(() => setToast(null), 3800);
			};

			const loadJobs = useCallback(async () => {
				setLoading(true); setError(null);
				try { const data = await apiGet("/jobs"); setJobs(data.jobs || []); }
				catch (e) { setError(e.message); }
				finally { setLoading(false); }
			}, []);

			const loadStatus = useCallback(async (jobName) => {
				try { const data = await apiGet("/status/" + encodeURIComponent(jobName)); setStatusMap((p) => ({ ...p, [jobName]: data })); }
				catch (_e) { /* 静默 */ }
			}, []);

			useEffect(() => { if (tab === "jobs") loadJobs(); }, [tab, loadJobs]);
			useEffect(() => { if (jobs.length === 0) return; jobs.forEach((j) => loadStatus(j.name)); /* eslint-disable-next-line */ }, [jobs.length]);
			useEffect(() => {
				if (pollRef.current) clearInterval(pollRef.current);
				pollRef.current = setInterval(() => {
					const building = Object.values(statusMap).some((s) => s && s.lastBuild && s.lastBuild.building);
					if (building) Object.keys(statusMap).forEach((n) => loadStatus(n));
				}, 4000);
				return () => { if (pollRef.current) clearInterval(pollRef.current); };
				/* eslint-disable-next-line */
			}, [statusMap]);

			const doDeploy = async (job, params) => {
				setDeploying((p) => ({ ...p, [job.name]: true }));
				try {
					await apiPost("/build/" + encodeURIComponent(job.name), { params });
					showToast(true, "已触发部署：" + job.name);
					setTimeout(() => loadStatus(job.name), 1500);
				} catch (e) { showToast(false, "部署失败：" + e.message); }
				finally { setDeploying((p) => ({ ...p, [job.name]: false })); }
			};
			const onDeployClick = (job, params) => {
				if (job.env === "prod") setConfirm({ job, params }); else doDeploy(job, params);
			};
			const showConsole = async (job, build) => {
				setConsoleInfo({ job: job.name, build, log: "", loading: true });
				try { const data = await apiGet("/console/" + encodeURIComponent(job.name) + "/" + encodeURIComponent(build)); setConsoleInfo({ job: job.name, build, log: data.log || "(空)", loading: false }); }
				catch (e) { setConsoleInfo({ job: job.name, build, log: "读取日志失败：" + e.message, loading: false }); }
			};

			const groups = useMemo(() => {
				const byEnv = {};
				for (const j of jobs) (byEnv[j.env] = byEnv[j.env] || []).push(j);
				const order = ["dev", "test", "prod", "other"];
				const label = { dev: "开发环境", test: "测试环境", prod: "生产环境", other: "其他" };
				return order.filter((e) => byEnv[e] && byEnv[e].length).map((e) => ({ env: e, label: label[e], jobs: byEnv[e] }));
			}, [jobs]);

			// 头部
			const header = h("div", { style: S.header },
				h("div", { style: S.headerTop },
					h("div", { style: S.brandIcon }, h(Icon, { name: "rocket", size: 20 })),
					h("div", { style: S.titleWrap },
						h("span", { style: S.title }, "部署发布"),
						h("span", { style: S.subtitle }, "通过 Jenkins 查看前后端项目并一键部署")
					),
					h("span", { style: S.spacer }),
					h("div", { style: S.segmented },
						h("button", { className: "jdp-tab", style: S.segBtn(tab === "jobs"), onClick: () => setTab("jobs") }, "项目"),
						h("button", { className: "jdp-tab", style: S.segBtn(tab === "settings"), onClick: () => setTab("settings") }, "设置")
					)
				),
				h("div", { style: S.toolbar },
					h("span", { style: { fontSize: 12, color: T.t3 } }, tab === "jobs" && !loading && !error ? "共 " + jobs.length + " 个可部署项目" : ""),
					h("span", { style: S.spacer }),
					tab === "jobs" ? h("button", { className: "jdp-btn", style: S.btn("ghost", "sm"), onClick: loadJobs }, h(Icon, { name: "refresh", size: 15 }), "刷新") : null
				)
			);

			// 主体
			let body;
			if (tab === "settings") {
				body = h("div", { style: S.body }, h(SettingsPanel, { onSaved: () => {} }));
			} else if (loading) {
				body = h("div", { style: S.body }, h("div", { style: S.center(280) },
					h("div", { className: "jdp-spin", style: { color: T.brand } }, h(Icon, { name: "refresh", size: 22 })),
					h("div", { style: S.hint }, "加载 Jenkins 项目...")
				));
			} else if (error) {
				body = h("div", { style: S.body }, h("div", { style: S.center(280) },
					h("div", { style: S.bigIcon }, h(Icon, { name: "warn", size: 26 })),
					h("div", { style: { fontSize: 14, fontWeight: 600, color: T.t1 } }, "加载失败"),
					h("div", { style: S.hint }, error),
					h("button", { className: "jdp-btn jdp-primary", style: S.btn("primary"), onClick: () => setTab("settings") }, "去设置")
				));
			} else if (jobs.length === 0) {
				body = h("div", { style: S.body }, h("div", { style: S.center(280) },
					h("div", { style: S.bigIcon }, h(Icon, { name: "rocket", size: 26 })),
					h("div", { style: S.hint }, "没有可部署的项目")
				));
			} else {
				body = h("div", { style: S.body, className: "jdp-scroll" },
					groups.map((g) => h("div", { key: g.env, style: S.group },
						h("div", { style: S.groupHead },
							h("span", { style: S.groupDot(envColor(g.env)) }),
							h("span", { style: S.groupTitle }, g.label),
							h("span", { style: S.groupCount }, "· " + g.jobs.length)
						),
						g.jobs.map((job, i) => h(JobCard, {
							key: job.name,
							job,
							status: statusMap[job.name] || null,
							deploying: !!deploying[job.name],
							onDeploy: onDeployClick,
							onShowConsole: showConsole
						}))
					))
				);
			}

			return h("div", { style: S.page },
				header,
				body,
				confirm ? h(ConfirmModal, {
					job: confirm.job, params: confirm.params,
					onCancel: () => setConfirm(null),
					onConfirm: () => { const c = confirm; setConfirm(null); doDeploy(c.job, c.params); }
				}) : null,
				consoleInfo ? h("div", { style: S.mask, className: "jdp-fade", onClick: () => setConsoleInfo(null) },
					h("div", { style: S.consoleModal, onClick: (e) => e.stopPropagation() },
						h("div", { style: { display: "flex", alignItems: "center", gap: 10, marginBottom: 12 } },
							h("span", { style: { color: T.t2 } }, h(Icon, { name: "terminal", size: 18 })),
							h("span", { style: { fontWeight: 650, fontFamily: T.mono, fontSize: 13 } }, consoleInfo.job + " #" + consoleInfo.build),
							h("span", { style: S.spacer }),
							h("button", { className: "jdp-btn", style: S.btn("ghost", "sm"), onClick: () => setConsoleInfo(null), title: "关闭" }, h(Icon, { name: "close", size: 15 }), "关闭")
						),
						h("div", { style: { ...S.console, flex: 1, overflow: "auto" }, className: "jdp-scroll" }, consoleInfo.loading ? "加载中..." : consoleInfo.log)
					)
				) : null,
				toast ? h("div", { style: S.toast(toast.ok), className: "jdp-fade" },
					h("span", { style: { color: toast.ok ? T.success : T.error, display: "flex" } }, h(Icon, { name: toast.ok ? "check" : "warn", size: 16 })),
					h("span", null, toast.text)
				) : null
			);
		}

		// ==================================================================
		// 插件入口
		// ==================================================================
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh: { panel: "部署发布", title: "部署发布" },
				en: { panel: "Deploy", title: "Deploy" }
			}), "jenkins-deploy: dictionaries");
			const t = ctx.locale.bind(NS);

			ctx.slots.inject("main", () => ctx.slots.register({
				name: "main",
				key: PANEL_ID,
				locale: NS
			}, JenkinsDeployPage));

			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: 20,
				locale: NS,
				label: () => t("panel")
			}, DeployIcon));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
