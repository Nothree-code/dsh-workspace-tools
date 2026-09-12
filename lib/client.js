/**
 * dsh-workspace-tools — browser half（原三个插件的合并版）
 *
 * 一个插件，三件事，各自带开关（开关即时生效，不需要重启）：
 *   cover  工作区封面：给每个工作区配一张行背景图（上传 / 裁剪 / 暗化 / 自动适配对比度 / 统一行高）
 *   fold   一键折叠：把侧栏「工作区」小标题变成按钮，点一下折叠全部、再点恢复
 *   groups 会话分组：给同一个工作区下的会话再分一层（彩色标头 + 整组折叠），入口在工作区行的「⋯」菜单里
 *
 * 统一铁律（三个功能都遵守）：只往已有 DOM 上加 class / data-* / 内联 CSS 变量，
 * **从不增删 React 管理的节点**——插节点会让 React 下次 diff 时崩
 * （folder-tree-sh 那个「新建文件夹」就是这么把页面搞崩的）。
 * 唯一的例外是工作区菜单里那个由它 cloneNode 出来、本来就不在 React 树里的项，
 * 我们把它改造成「会话分组」并接管点击。
 */
window.__ModuleLoader__.load({
	id: "dsh-workspace-tools",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const h = react.createElement;

		const name = "dsh-workspace-tools";
		const inject = ["slots"];

		/* ---------------- 常量 ---------------- */
		const STYLE_ID = "dsh-workspace-tools-style";
		const TOGGLES_KEY = "dsh.workspace.tools.v1";     // 三个开关
		const GROUPS_KEY = "dsh.sidebar.groups.v1";       // 分组数据（沿用旧的 key，老数据不丢）
		const COVER_API = {
			list: "/dsh-cover-list", save: "/dsh-cover-save", del: "/dsh-cover-delete",
			img: "/dsh-cover-img", src: "/dsh-cover-src", global: "/dsh-cover-global",
			preset: "/dsh-cover-preset"
		};
		// 内置默认图集：同一套风格骨架生成的 8 个主题（深石墨蓝基调 + 一个低饱和强调色）
		const PRESETS = [
			{ id: "life", label: "生活" },
			{ id: "study", label: "学习" },
			{ id: "paper", label: "论文 · 学术" },
			{ id: "tech", label: "科技知识" },
			{ id: "health", label: "健康知识" },
			{ id: "leisure", label: "休闲娱乐" },
			{ id: "video", label: "视频 · AI 创作" },
			{ id: "engineering", label: "工程" }
		];
		const ROW_SEL = '[class*="projectRow"]';
		const SESS_SEL = '[class*="sessionRow"]';
		const SEC_SEL = '[class*="groupSection"]';
		const TEXT_SEL = '[class*="projectText"]';
		const TITLE_SEL = '[class*="title"]';
		const LABEL_SEL = '[class*="_sectionLabel"]';
		const SIDEBAR_SEL = '[class*="sidebarCol"]';
		const PREVIEW_W = 768;
		const HEAD_H = 26;
		const COVER_H = 21;                                // 分组标头占会话行的高度
		const COLORS = ["#4D7BFE", "#12B5A5", "#F6A821", "#E26DC2", "#9B6BFF", "#2ECC71", "#FF7A45", "#5AC8FA"];
		const COVER_DEFAULTS = {
			zoom: 1, panX: 0, panY: 0,
			brightness: 0.78, saturate: 0.85, contrast: 1, blur: 0, localBlur: 3,
			mask: 0.36, maskMid: 0.42
		};

		/* ---------------- 开关 ---------------- */
		let toggles = { cover: true, fold: true, groups: true };
		function loadToggles() {
			try {
				const raw = window.localStorage.getItem(TOGGLES_KEY);
				if (raw) toggles = Object.assign({ cover: true, fold: true, groups: true }, JSON.parse(raw) || {});
			} catch (_) { /* 隐私模式等：用默认全开 */ }
		}
		function saveToggles() {
			try { window.localStorage.setItem(TOGGLES_KEY, JSON.stringify(toggles)); } catch (_) { /* ignore */ }
		}
		function setToggle(k, v) {
			toggles[k] = !!v;
			saveToggles();
			applyAll();
			emit();
		}

		/* ---------------- 通用小工具 ---------------- */
		const textOf = (el) => (el ? (el.textContent || "").trim() : "");
		function wsNameOf(row) {
			const t = row.querySelector(TEXT_SEL);
			return textOf(t || row).replace(/\s+/g, " ").slice(0, 80);
		}
		function sessNameOf(row) {
			const t = row.querySelector(TITLE_SEL);
			return textOf(t || row).replace(/\s+/g, " ").slice(0, 120);
		}
		function findRowByName(nm) {
			const rows = document.querySelectorAll(ROW_SEL);
			for (let i = 0; i < rows.length; i++) if (wsNameOf(rows[i]) === nm) return rows[i];
			return null;
		}
		function scanWorkspaces() {
			const out = [];
			Array.prototype.forEach.call(document.querySelectorAll(ROW_SEL), (r) => {
				const n = wsNameOf(r);
				if (n && out.indexOf(n) < 0) out.push(n);
			});
			return out;
		}
		function activeWorkspace() {
			const expanded = Array.prototype.filter.call(document.querySelectorAll(ROW_SEL),
				(r) => r.getAttribute("aria-expanded") === "true");
			if (expanded.length) return wsNameOf(expanded[0]);
			const all = scanWorkspaces();
			return all.length ? all[0] : "";
		}
		function sectionOf(wsRow) {
			let p = wsRow.parentElement, n = 0;
			while (p && n < 5) {
				if (p.matches && p.matches(SEC_SEL)) return p;
				const found = p.querySelector ? p.querySelector(SEC_SEL) : null;
				if (found && found.contains(wsRow)) return found;
				p = p.parentElement; n++;
			}
			return wsRow.closest ? wsRow.closest(SEC_SEL) : null;
		}
		function sessionsOf(section) {
			if (!section) return [];
			return Array.prototype.filter.call(section.querySelectorAll(SESS_SEL), (r) => !r.matches(ROW_SEL));
		}

		let listeners = new Set();
		function emit() { listeners.forEach((fn) => { try { fn(); } catch (_) { /* keep others */ } }); }
		function subscribe(fn) { listeners.add(fn); fn(); return () => listeners.delete(fn); }

		/* ---------------- 样式 ---------------- */
		const CSS_TEXT = [
			/* ===== cover：工作区行封面 ===== */
			".dsh-ws-cover{position:relative;background-image:var(--dsh-ws-cover);background-size:cover;",
			"background-position:center;background-repeat:no-repeat;isolation:isolate}",
			".dsh-ws-cover::before{content:'';position:absolute;inset:0;border-radius:inherit;pointer-events:none;z-index:0;",
			"background:linear-gradient(90deg,rgba(15,16,20,.90) 0%,rgba(15,16,20,.62) 45%,rgba(15,16,20,.18) 100%)}",
			".dsh-ws-cover>*{position:relative;z-index:1}",
			".dsh-ws-cover [class*='projectText']{color:#fff;text-shadow:0 1px 6px rgba(0,0,0,.55)}",
			".dsh-ws-cover [class*='folder']{color:#fff;opacity:.92}",
			".dsh-ws-cover [class*='chevron']{color:#fff;opacity:.8}",
			".dsh-ws-cover [class*='rowActions']{color:#fff}",
			/* ===== fold：工作区小标题按钮 ===== */
			".dsh-fold-label{cursor:pointer;user-select:none;display:inline-flex;align-items:center;gap:5px;",
			"padding:2px 7px;margin-left:-7px;border-radius:6px;transition:background .12s ease,color .12s ease}",
			".dsh-fold-label:hover{background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary)}",
			".dsh-fold-label:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4D7BFE);outline-offset:1px}",
			".dsh-fold-label::after{content:'';width:0;height:0;flex:none;opacity:.55;",
			"border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid currentColor;",
			"transition:opacity .12s ease,border-color .12s ease}",
			".dsh-fold-label:hover::after{opacity:1}",
			".dsh-fold-label[data-fold-state='collapsed']::after{border-top-color:transparent;border-bottom:5px solid currentColor}",
			".dsh-fold-label[data-fold-state='collapsed']{color:var(--dsw-alias-label-secondary)}",
			/* ===== groups：会话分组标头 ===== */
			".dsh-grp-first{position:relative !important;padding-top:" + COVER_H + "px !important}",
			".dsh-grp-first::before{content:attr(data-dsh-grp);position:absolute;left:0;right:0;top:0;height:20px;",
			"display:flex;align-items:center;padding:0 6px;font-size:10.5px;font-weight:700;letter-spacing:.08em;",
			"color:var(--dsh-grp-color,#8fa8d8);cursor:pointer;",
			"border-bottom:1px solid color-mix(in srgb, var(--dsh-grp-color,#8fa8d8) 24%, transparent)}",
			".dsh-grp{position:relative}",
			".dsh-grp-hide{display:none !important}",
			/* ===== 设置栏 ===== */
			".dsh-wt-wrap{padding:2px 0 8px;font-size:13px}",
			".dsh-wt-title{font-size:14px;font-weight:600;margin-bottom:8px}",
			".dsh-wt-hint{font-size:12px;line-height:1.7;opacity:.66;margin-bottom:14px}",
			".dsh-wt-switches{border:1px solid rgba(127,127,127,.28);border-radius:10px;overflow:hidden;margin-bottom:16px}",
			".dsh-wt-sw{display:flex;align-items:center;gap:10px;padding:10px 12px;",
			"border-bottom:1px solid rgba(127,127,127,.18)}",
			".dsh-wt-sw:last-child{border-bottom:0}",
			".dsh-wt-sw.sel{background:rgba(77,123,254,.10)}",
			".dsh-wt-sw .t{flex:1;min-width:0}",
			".dsh-wt-sw .t b{display:block;font-weight:600;margin-bottom:2px}",
			".dsh-wt-sw .t span{font-size:11.5px;opacity:.62;line-height:1.6}",
			".dsh-wt-track{width:38px;height:21px;border-radius:20px;background:rgba(127,127,127,.34);flex:none;",
			"position:relative;cursor:pointer;transition:background .16s ease}",
			".dsh-wt-track::after{content:'';position:absolute;top:2.5px;left:2.5px;width:16px;height:16px;border-radius:50%;",
			"background:#fff;transition:transform .16s ease;box-shadow:0 1px 3px rgba(0,0,0,.35)}",
			".dsh-wt-track[data-on='1']{background:#4D7BFE}",
			".dsh-wt-track[data-on='1']::after{transform:translateX(17px)}",
			".dsh-wt-sec{font-size:11px;letter-spacing:.06em;opacity:.66;margin:14px 0 8px}",
			".dsh-wt-off{padding:12px;font-size:12px;opacity:.6;border:1px dashed rgba(127,127,127,.3);border-radius:9px}",
			/* ===== 封面设置（沿用 dsh-wc- 前缀） ===== */
			".dsh-wc-global{display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap}",
			".dsh-wc-global label{font-size:11.5px;opacity:.7;display:flex;align-items:center;gap:6px}",
			".dsh-wc-global label b{font-weight:600;font-variant-numeric:tabular-nums;opacity:1}",
			".dsh-wc-global input[type=range]{flex:1;max-width:340px;accent-color:#4D7BFE}",
			".dsh-wc-list{border:1px solid rgba(127,127,127,.28);border-radius:10px;overflow:hidden;margin-bottom:14px}",
			".dsh-wc-item{border-bottom:1px solid rgba(127,127,127,.18)}",
			".dsh-wc-item:last-child{border-bottom:0}",
			".dsh-wc-row{display:flex;align-items:center;gap:10px;padding:8px 12px}",
			".dsh-wc-thumb{width:96px;height:22px;flex:none;border-radius:5px;background:rgba(127,127,127,.14);",
			"background-size:cover;background-position:center;border:1px solid rgba(127,127,127,.24)}",
			".dsh-wc-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:inherit}",
			".dsh-wc-btns{display:flex;gap:6px;flex:none}",
			".dsh-wc-btn{font:inherit;font-size:12px;padding:5px 10px;border-radius:7px;cursor:pointer;flex:none;",
			"background:rgba(127,127,127,.14);border:1px solid rgba(127,127,127,.34);color:inherit;opacity:.92}",
			".dsh-wc-btn:hover{opacity:1;border-color:#4D7BFE}",
			".dsh-wc-btn.primary{background:linear-gradient(92deg,#4D7BFE,#7a6bff);border:0;color:#fff;font-weight:600;opacity:1}",
			".dsh-wc-btn:disabled{opacity:.4;cursor:default}",
			".dsh-wc-editor{border-top:1px dashed rgba(127,127,127,.3);padding:14px;background:rgba(127,127,127,.05)}",
			".dsh-wc-editor-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}",
			".dsh-wc-editor-title{font-size:13px;font-weight:600}",
			".dsh-wc-stage{width:100%;max-width:768px;border-radius:8px;overflow:hidden;background:#0f1116;",
			"border:1px solid rgba(127,127,127,.3);cursor:grab;user-select:none;touch-action:none}",
			".dsh-wc-stage canvas{display:block;width:100%;height:auto}",
			".dsh-wc-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 20px;margin-top:12px}",
			".dsh-wc-ctl label{display:flex;justify-content:space-between;font-size:11.5px;opacity:.7;margin-bottom:5px}",
			".dsh-wc-ctl label b{font-weight:600;opacity:1;font-variant-numeric:tabular-nums}",
			".dsh-wc-ctl input[type=range]{width:100%;accent-color:#4D7BFE}",
			".dsh-wc-nudge{display:grid;grid-template-columns:repeat(3,32px);grid-template-rows:repeat(3,28px);gap:4px;margin-top:6px}",
			".dsh-wc-nudge button{font:inherit;font-size:13px;background:rgba(127,127,127,.14);",
			"border:1px solid rgba(127,127,127,.34);border-radius:6px;cursor:pointer;padding:0;color:inherit}",
			".dsh-wc-nudge button:hover{border-color:#4D7BFE}",
			".dsh-wc-presets{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:12px}",
			".dsh-wc-presets-label{font-size:11.5px;opacity:.66;margin-right:2px}",
			".dsh-wc-preset{width:58px;height:21px;border-radius:5px;cursor:pointer;padding:0;flex:none;",
			"background-size:cover;background-position:center;border:1px solid rgba(127,127,127,.4)}",
			".dsh-wc-preset:hover{border-color:#4D7BFE}",
			".dsh-wc-foot{display:flex;align-items:center;gap:10px;margin-top:14px;flex-wrap:wrap}",
			".dsh-wc-msg{font-size:12px;opacity:.66}",
			".dsh-wc-empty{padding:16px 12px;font-size:12.5px;opacity:.66}",
			/* ===== 分组管理面板（沿用 dsh-sg- 前缀，实色不透明 + color-scheme） ===== */
			"@keyframes dsh-sg-in{from{opacity:0;transform:translateY(-50%) translateX(-6px)}to{opacity:1;transform:translateY(-50%) translateX(0)}}",
			".dsh-sg-panel{position:fixed;left:calc(var(--dsh-sidebar-width,280px) + 10px);top:50%;",
			"transform:translateY(-50%);animation:dsh-sg-in .18s ease-out;width:380px;",
			"max-height:66vh;display:flex;flex-direction:column;gap:10px;padding:14px;border-radius:12px;",
			"background:#ffffff;color:#1a2230;color-scheme:light;border:1px solid rgba(0,0,0,.16);",
			"box-shadow:0 18px 48px rgba(0,0,0,.42);z-index:60;font-size:13px}",
			"body[data-ds-dark-theme] .dsh-sg-panel{background:#1c1f26;color:#e8ecf3;color-scheme:dark;",
			"border-color:rgba(255,255,255,.13)}",
			".dsh-sg-head{display:flex;align-items:center;gap:8px;font-weight:600}",
			".dsh-sg-head .ws{opacity:.62;font-weight:400;font-size:12px}",
			".dsh-sg-close{margin-left:auto;font:inherit;font-size:12px;border-radius:7px;padding:3px 9px;cursor:pointer;",
			"background:transparent;border:1px solid currentColor;color:inherit;opacity:.7}",
			".dsh-sg-close:hover{opacity:1}",
			".dsh-sg-sec{font-size:11px;letter-spacing:.06em;opacity:.66;margin-top:2px}",
			".dsh-sg-list{overflow:auto;max-height:34vh;border-radius:9px;background:rgba(127,127,127,.08);",
			"border:1px solid rgba(127,127,127,.3)}",
			".dsh-sg-row{display:flex;align-items:center;gap:8px;padding:7px 10px;border-bottom:1px solid rgba(127,127,127,.18)}",
			".dsh-sg-row:last-child{border-bottom:0}",
			".dsh-sg-dot{width:12px;height:8px;border-radius:3px;flex:none}",
			".dsh-sg-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:inherit}",
			".dsh-sg-btn{font:inherit;font-size:11.5px;padding:3px 8px;border-radius:6px;cursor:pointer;flex:none;",
			"background:rgba(127,127,127,.14);border:1px solid rgba(127,127,127,.34);color:inherit;opacity:.92}",
			".dsh-sg-btn:hover{opacity:1;border-color:#4D7BFE}",
			".dsh-sg-btn.p{background:linear-gradient(92deg,#4D7BFE,#7a6bff);border:0;color:#fff;font-weight:600;opacity:1}",
			".dsh-sg-btn:disabled{opacity:.4;cursor:default}",
			".dsh-sg-sel{font:inherit;font-size:11.5px;padding:3px 6px;border-radius:6px;max-width:150px;flex:none;",
			"background:#ffffff;color:#1a2230;border:1px solid rgba(127,127,127,.36)}",
			"body[data-ds-dark-theme] .dsh-sg-sel{background:#272b34;color:#e8ecf3;border-color:rgba(255,255,255,.2)}",
			".dsh-sg-sel option{background:#ffffff;color:#1a2230}",
			"body[data-ds-dark-theme] .dsh-sg-sel option{background:#272b34;color:#e8ecf3}",
			".dsh-sg-new{display:flex;gap:8px}",
			".dsh-sg-new input{flex:1;font:inherit;font-size:12px;padding:6px 9px;border-radius:7px;",
			"background:#ffffff;color:#1a2230;border:1px solid rgba(127,127,127,.36)}",
			"body[data-ds-dark-theme] .dsh-sg-new input{background:#272b34;color:#e8ecf3;border-color:rgba(255,255,255,.2)}",
			".dsh-sg-new input::placeholder{color:currentColor;opacity:.45}",
			".dsh-sg-empty{padding:12px;font-size:12px;opacity:.66}",
			".dsh-sg-tip{font-size:11px;line-height:1.7;opacity:.66}"
		].join("\n");

		function ensureStyle() {
			if (document.getElementById(STYLE_ID)) return;
			const tag = document.createElement("style");
			tag.id = STYLE_ID;
			tag.textContent = CSS_TEXT;
			(document.head || document.documentElement).appendChild(tag);
		}

		/* ============================================================
		 * 模块一：工作区封面（cover）
		 * ============================================================ */
		let coverMap = {};
		let coverGlobal = { rowHeight: 34 };

		function clearCovers() {
			Array.prototype.forEach.call(document.querySelectorAll(ROW_SEL), (row) => {
				row.classList.remove("dsh-ws-cover");
				row.style.removeProperty("--dsh-ws-cover");
				row.style.removeProperty("height");
				row.removeAttribute("data-dsh-preview");
			});
		}

		function applyCovers() {
			if (!toggles.cover) return;      // 关闭时由 applyAll 负责清理
			const hp = Math.max(28, Math.min(120, Number(coverGlobal.rowHeight) || 34));
			Array.prototype.forEach.call(document.querySelectorAll(ROW_SEL), (row) => {
				const key = rowNameSafe(row);
				const it = key ? coverMap[key] : null;
				const previewing = row.getAttribute("data-dsh-preview") === "1";
				// 同样走幂等写入：这里以前每次重算都无条件 setProperty / 改 height，
				// 15 个工作区行乘起来就是每轮几十次真实样式写入（实测占了大头）。
				if ((it && it.key) || previewing) {
					setClassIf(row, "dsh-ws-cover", true);
					if (!previewing && it && it.key) {
						setStyleIf(row, "--dsh-ws-cover",
							'url("' + COVER_API.img + "?k=" + it.key + "&t=" + (it.updatedAt || 0) + '")');
					}
					if (hp !== 34) setStyleIf(row, "height", hp + "px");
					else delStyleIf(row, "height");
				} else {
					setClassIf(row, "dsh-ws-cover", false);
					delStyleIf(row, "--dsh-ws-cover");
					delStyleIf(row, "height");
				}
			});
		}
		const rowNameSafe = (row) => wsNameOf(row);

		function pushCoverPreview(nm, dataUrl) {
			const row = findRowByName(nm);
			if (!row) return;
			setAttrIfChanged(row, "data-dsh-preview", "1");
			setClassIf(row, "dsh-ws-cover", true);
			setStyleIf(row, "--dsh-ws-cover", 'url("' + dataUrl + '")');
			const hp = Math.max(28, Math.min(120, Number(coverGlobal.rowHeight) || 34));
			if (hp !== 34) setStyleIf(row, "height", hp + "px");
			else delStyleIf(row, "height");
		}
		function clearCoverPreview(nm) {
			const row = findRowByName(nm);
			if (row) row.removeAttribute("data-dsh-preview");
			applyCovers();
		}

		async function refreshCovers() {
			try {
				const r = await fetch(COVER_API.list, { cache: "no-store" });
				const d = await r.json();
				const map = {};
				((d && d.items) || []).forEach((it) => { map[it.name] = it; });
				coverMap = map;
			} catch (_) { /* 路由不可用时保持空表 */ }
			applyCovers();
			emit();
		}
		async function refreshCoverGlobal() {
			try {
				const r = await fetch(COVER_API.global, { cache: "no-store" });
				const d = await r.json();
				if (d && d.ok) coverGlobal = { rowHeight: Math.max(28, Math.min(120, Number(d.rowHeight) || 34)) };
			} catch (_) { /* 用默认 */ }
			applyCovers();
			emit();
		}
		async function saveCoverGlobal(rowHeight) {
			coverGlobal = { rowHeight: Math.max(28, Math.min(120, Number(rowHeight) || 34)) };
			applyCovers(); emit();
			try {
				await fetch(COVER_API.global, {
					method: "POST", headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ rowHeight: coverGlobal.rowHeight })
				});
			} catch (_) { /* 仅本地生效 */ }
		}

		/* ---- 封面渲染算法（与 uploader.html 同一套） ---- */
		function filterStr(p, k) {
			let f = "brightness(" + p.brightness + ") saturate(" + p.saturate + ") contrast(" + p.contrast + ")";
			if (p.blur > 0.05) f += " blur(" + (p.blur * k).toFixed(2) + "px)";
			return f;
		}
		function paintCover(ctx, W, H, p, img) {
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.filter = "none";
			ctx.clearRect(0, 0, W, H);
			ctx.fillStyle = "#0f1116";
			ctx.fillRect(0, 0, W, H);
			if (img && img.width) {
				const k = W / PREVIEW_W;
				const pad = (p.blur > 0.05 || p.localBlur > 0.1) ? 1.06 : 1.0;
				const sc = Math.max(W / img.width, H / img.height) * p.zoom * pad;
				const dw = img.width * sc, dh = img.height * sc;
				const dx = (W - dw) / 2 + p.panX * W;
				const dy = (H - dh) / 2 + p.panY * H;
				ctx.save(); ctx.filter = filterStr(p, k); ctx.drawImage(img, dx, dy, dw, dh); ctx.restore();
				ctx.filter = "none";
				if (p.localBlur > 0.1) {
					ctx.save();
					ctx.beginPath(); ctx.rect(0, 0, W * 0.62, H); ctx.clip();
					ctx.filter = filterStr(p, k) + " blur(" + (p.localBlur * k).toFixed(2) + "px)";
					ctx.drawImage(img, dx, dy, dw, dh);
					ctx.restore(); ctx.filter = "none";
				}
			}
			const m = p.mask;
			const g = ctx.createLinearGradient(0, 0, W, 0);
			g.addColorStop(0, "rgba(15,16,20," + m + ")");
			g.addColorStop(p.maskMid, "rgba(15,16,20," + (m * 0.55).toFixed(3) + ")");
			g.addColorStop(Math.min(0.96, p.maskMid + 0.34), "rgba(15,16,20," + (m * 0.20).toFixed(3) + ")");
			g.addColorStop(1, "rgba(15,16,20," + (m * 0.30).toFixed(3) + ")");
			ctx.fillStyle = g;
			ctx.fillRect(0, 0, W, H);
		}
		function toLinear(v) { return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
		function zoneLum(ctx, W, H, q) {
			const bw = Math.max(1, Math.round(W * 0.52)), bh = Math.max(1, Math.round(H * 0.64));
			const y0 = Math.round(H * 0.22);
			let d;
			try { d = ctx.getImageData(0, y0, bw, bh).data; } catch (_) { return 0; }
			const gw = 12, gh = 3, cw = Math.max(1, Math.floor(bw / gw)), ch = Math.max(1, Math.floor(bh / gh));
			const cells = [];
			for (let gy = 0; gy < gh; gy++) {
				for (let gx = 0; gx < gw; gx++) {
					let sum = 0, n = 0;
					for (let y = gy * ch; y < Math.min((gy + 1) * ch, bh); y += 2) {
						for (let x = gx * cw; x < Math.min((gx + 1) * cw, bw); x += 2) {
							const i = (y * bw + x) * 4;
							sum += toLinear(d[i] / 255) * 0.2126 + toLinear(d[i + 1] / 255) * 0.7152 + toLinear(d[i + 2] / 255) * 0.0722;
							n++;
						}
					}
					if (n) cells.push(sum / n);
				}
			}
			if (!cells.length) return 0;
			cells.sort((a, b) => a - b);
			return cells[Math.min(cells.length - 1, Math.round((q || 0.9) * (cells.length - 1)))];
		}

		/* ============================================================
		 * 模块二：一键折叠全部工作区（fold）
		 * ============================================================ */
		let foldMemory = [];
		let foldLabel = null;
		const foldHandler = {};
		function foldRows() {
			const sb = document.querySelector(SIDEBAR_SEL);
			return sb ? Array.prototype.slice.call(sb.querySelectorAll('[role="treeitem"][aria-expanded]')) : [];
		}
		const foldIsOpen = (r) => r.getAttribute("aria-expanded") === "true";

		function setAttrIfChanged(el, k, v) {
			if (el.getAttribute(k) !== v) el.setAttribute(k, v);
		}
		function foldSync() {
			if (!foldLabel || !foldLabel.isConnected) return;
			const open = foldRows().filter(foldIsOpen).length;
			// 注意：这里必须"值没变就不写"。写 aria-expanded 会命中可能存在的属性观察器，
			// 无脑写会把自己触发成死循环（合并版第一版就是这么把页面卡死的）。
			setAttrIfChanged(foldLabel, "data-fold-state", open > 0 ? "expanded" : "collapsed");
			setAttrIfChanged(foldLabel, "aria-expanded", open > 0 ? "true" : "false");
			const tip = open > 0 ? "折叠全部工作区（当前 " + open + " 个展开）" : "恢复之前展开的工作区";
			setAttrIfChanged(foldLabel, "title", tip);
			setAttrIfChanged(foldLabel, "aria-label", tip);
		}
		function foldToggle() {
			if (!toggles.fold) return;
			const open = foldRows().filter(foldIsOpen);
			if (open.length) {
				foldMemory = open.map(wsNameOf);
				open.forEach((r) => r.click());
			} else {
				const all = foldRows();
				const want = foldMemory.length ? all.filter((r) => foldMemory.indexOf(wsNameOf(r)) >= 0) : all.slice(0, 1);
				want.forEach((r) => r.click());
			}
			setTimeout(foldSync, 80);
			setTimeout(foldSync, 450);
		}
		function mountFold() {
			if (!toggles.fold) return;
			const sb = document.querySelector(SIDEBAR_SEL);
			if (!sb) return;
			const el = sb.querySelector(LABEL_SEL);
			if (!el) return;
			if (el.__dshFoldMounted) { foldLabel = el; foldSync(); return; }
			el.__dshFoldMounted = true;
			el.classList.add("dsh-fold-label");
			el.setAttribute("role", "button");
			el.setAttribute("tabindex", "0");
			foldHandler.click = (e) => { e.preventDefault(); e.stopPropagation(); foldToggle(); };
			foldHandler.key = (e) => {
				if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
					e.preventDefault(); e.stopPropagation(); foldToggle();
				}
			};
			el.addEventListener("click", foldHandler.click, true);
			el.addEventListener("keydown", foldHandler.key);
			foldLabel = el;
			foldSync();
		}
		function unmountFold() {
			const el = foldLabel || document.querySelector(".dsh-fold-label");
			if (el) {
				try {
					if (foldHandler.click) el.removeEventListener("click", foldHandler.click, true);
					if (foldHandler.key) el.removeEventListener("keydown", foldHandler.key);
				} catch (_) { /* ignore */ }
				el.classList.remove("dsh-fold-label");
				el.removeAttribute("role");
				el.removeAttribute("tabindex");
				el.removeAttribute("title");
				el.removeAttribute("aria-label");
				el.removeAttribute("aria-expanded");
				el.removeAttribute("data-fold-state");
				delete el.__dshFoldMounted;
			}
			foldLabel = null;
		}

		/* ============================================================
		 * 模块三：工作区内的会话分组（groups）
		 * ============================================================ */
		let groups = { byWs: {} };
		let panelOpen = false;
		let panelWs = "";

		function loadGroups() {
			try {
				const raw = window.localStorage.getItem(GROUPS_KEY);
				groups = raw ? JSON.parse(raw) : { byWs: {} };
			} catch (_) { groups = { byWs: {} }; }
			if (!groups || typeof groups !== "object") groups = { byWs: {} };
			if (!groups.byWs) groups.byWs = {};
		}
		function saveGroups() { try { window.localStorage.setItem(GROUPS_KEY, JSON.stringify(groups)); } catch (_) { /* ignore */ } }
		// 会话在还没内容时标题是占位文本（DSH 中文环境是「新会话」）。
		// 这类标题**不参与分组记账**：否则用户每次新建会话，它都会自动继承
		// 上一次分给「新会话」这个标题的那个组。
		const PLACEHOLDER_SESSION_TITLES = /^(新会话|新对话|未命名|New session|New chat|Untitled)$/i;
		function assignedGroupOf(cfg, name) {
			if (!cfg || !name) return null;
			if (PLACEHOLDER_SESSION_TITLES.test(String(name).trim())) return null;
			return (cfg.assign && cfg.assign[name]) || null;
		}

		function cfgOf(ws, create) {
			if (!ws) return null;
			if (!groups.byWs[ws] && create) groups.byWs[ws] = { groups: [], assign: {}, collapsed: {} };
			const c = groups.byWs[ws];
			if (c) {
				if (!Array.isArray(c.groups)) c.groups = [];
				if (!c.assign) c.assign = {};
				if (!c.collapsed) c.collapsed = {};
			}
			return c || null;
		}

		/* ---- 幂等写入助手 ----
		   稳态下**一次 DOM 写入都不做**，这是这个插件不吃性能的关键：
		   每次点击会话，React 都会产生成百上千次 DOM 变更，若每次都重写样式，
		   浏览器就要反复重算样式与布局，页面会卡到必须刷新。 */
		function setStyleIf(el, prop, val) {
			if (el.style.getPropertyValue(prop) !== val) el.style.setProperty(prop, val);
		}
		function delStyleIf(el, prop) {
			if (el.style.getPropertyValue(prop)) el.style.removeProperty(prop);
		}
		function setClassIf(el, cls, on) {
			if (on) { if (!el.classList.contains(cls)) el.classList.add(cls); }
			else if (el.classList.contains(cls)) el.classList.remove(cls);
		}

		function clearGrouping() {
			Array.prototype.forEach.call(document.querySelectorAll(SESS_SEL), (r) => {
				setClassIf(r, "dsh-grp", false);
				setClassIf(r, "dsh-grp-first", false);
				setClassIf(r, "dsh-grp-hide", false);
				if (r.hasAttribute("data-dsh-grp")) r.removeAttribute("data-dsh-grp");
				delStyleIf(r, "--dsh-grp-color");
				const wrap = r.parentElement;
				if (wrap) {
					delStyleIf(wrap, "order");
					if (wrap.dataset) delete wrap.dataset.dshSgOrder;
				}
				const box = wrap && wrap.parentElement;
				if (box && box.dataset && box.dataset.dshSgFlex === "1") {
					delStyleIf(box, "display");
					delStyleIf(box, "flex-direction");
					delete box.dataset.dshSgFlex;
					Array.prototype.forEach.call(box.children, (c) => { if (c.style) delStyleIf(c, "order"); });
				}
			});
		}

		function applyGrouping() {
			if (!toggles.groups) return;
			Array.prototype.forEach.call(document.querySelectorAll(SEC_SEL), (sec) => {
				const wsRow = sec.querySelector(ROW_SEL);
				if (!wsRow) return;
				const rows = sessionsOf(sec);
				if (!rows.length) return;
				const cfg = cfgOf(wsNameOf(wsRow), false);
				const active = !!(cfg && cfg.groups && cfg.groups.length);

				// 目标顺序：**未归组的排最上方**，然后按分组在管理面板里的次序聚拢（组内保持原生先后）。
				// 「新会话」是 DSH 的占位标题 —— 每个新建的会话都叫这个名字，若按标题记账，
				// 新会话就会自动落进上一次分给「新会话」的那个组里，所以一律按「未归组」处理。
				const order = {};
				let seq = 0;
				if (active) {
					rows.forEach((r) => {
						const n = sessNameOf(r);
						if (!assignedGroupOf(cfg, n)) order[n] = seq++;
					});
					cfg.groups.forEach((g) => {
						rows.forEach((r) => {
							const n = sessNameOf(r);
							if (assignedGroupOf(cfg, n) === g.id) order[n] = seq++;
						});
					});
				}

				const firstWrap = rows[0].parentElement;
				const box = firstWrap ? firstWrap.parentElement : null;
				if (box) {
					if (active) {
						setStyleIf(box, "display", "flex");
						setStyleIf(box, "flex-direction", "column");
						if (box.dataset) box.dataset.dshSgFlex = "1";
						Array.prototype.forEach.call(box.children, (c) => {
							if (!c.style || !c.querySelector) return;
							// 工作区行**不是** box 的直接子元素，而是被一层容器包着（实测 groupSection 的直接子只有 1 个），
							// 所以必须用 querySelector 判断，否则会把工作区行推到列表最后。
							if (c.querySelector(ROW_SEL)) setStyleIf(c, "order", "-1");
							else if (c.querySelector(SESS_SEL)) { /* 会话 wrapper，下面统一设 */ }
							else setStyleIf(c, "order", "9999");
						});
					} else if (box.dataset && box.dataset.dshSgFlex === "1") {
						delStyleIf(box, "display");
						delStyleIf(box, "flex-direction");
						delete box.dataset.dshSgFlex;
						Array.prototype.forEach.call(box.children, (c) => { if (c.style) delStyleIf(c, "order"); });
					}
				}

				const firstDone = {};
				rows.forEach((r) => {
					const name = sessNameOf(r);
					const wrap = r.parentElement;
					const gid = active ? assignedGroupOf(cfg, name) : null;
					const g = gid ? cfg.groups.filter((x) => x.id === gid)[0] : null;
					const isFirst = !!g && !firstDone[gid];
					if (g) firstDone[gid] = true;

					if (wrap) {
						if (active) {
							if (wrap.dataset) wrap.dataset.dshSgOrder = "1";
							setStyleIf(wrap, "order", String(order[name] === undefined ? 999 : order[name]));
						} else {
							if (wrap.dataset) delete wrap.dataset.dshSgOrder;
							delStyleIf(wrap, "order");
						}
					}

					setClassIf(r, "dsh-grp", !!g);
					setClassIf(r, "dsh-grp-first", isFirst);
					setClassIf(r, "dsh-grp-hide", !!g && !isFirst && !!cfg.collapsed[gid]);
					if (g) {
						setStyleIf(r, "--dsh-grp-color", g.color || COLORS[0]);
						if (isFirst) setAttrIfChanged(r, "data-dsh-grp", (cfg.collapsed[gid] ? "▸ " : "▾ ") + g.name);
					} else {
						delStyleIf(r, "--dsh-grp-color");
						if (r.hasAttribute("data-dsh-grp")) r.removeAttribute("data-dsh-grp");
					}
				});
			});
		}

		function toggleGroup(ws, groupName) {
			const cfg = cfgOf(ws, true);
			const g = cfg.groups.filter((x) => x.name === groupName)[0];
			if (!g) return;
			cfg.collapsed[g.id] = !cfg.collapsed[g.id];
			saveGroups(); applyGrouping(); emit();
		}

		/* 点分组标头（会话行上半部）折叠 */
		document.addEventListener("click", (e) => {
			if (!toggles.groups) return;
			const row = e.target && e.target.closest ? e.target.closest(SESS_SEL) : null;
			if (!row || !row.classList.contains("dsh-grp-first")) return;
			const rect = row.getBoundingClientRect();
			if (e.clientY - rect.top > HEAD_H) return;
			const label = row.getAttribute("data-dsh-grp") || "";
			const groupName = label.replace(/^[▸▾]\s*/, "");
			e.preventDefault();
			e.stopImmediatePropagation();
			toggleGroup(activeWorkspace(), groupName);
		}, true);

		/* ---- 工作区菜单：把「新建文件夹」就地换成「会话分组」 ----
		   那一项是 folder-tree-sh 用 cloneNode 插的、不在 React 树里，改它安全；
		   点击在捕获阶段接管，既实现我们的入口，也顺带避开它原来的崩溃路径。 */
		let lastWsName = "";
		const GROUP_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">'
			+ '<path fill="currentColor" d="M2.7 2.9h1.5v1.5H2.7V2.9Zm3.3 0h7.3v1.5H6V2.9ZM2.7 7.25h1.5v1.5H2.7v-1.5Zm3.3 0h5.3v1.5H6v-1.5ZM2.7 11.6h1.5v1.5H2.7v-1.5Zm3.3 0h6.5v1.5H6v-1.5Z"/></svg>';

		function rememberWs(target) {
			const row = target && target.closest ? target.closest(ROW_SEL) : null;
			if (row) lastWsName = wsNameOf(row);
		}
		document.addEventListener("contextmenu", (e) => rememberWs(e.target), true);
		document.addEventListener("click", (e) => rememberWs(e.target), true);

		function enhanceWsMenu() {
			if (!toggles.groups) return;
			Array.prototype.forEach.call(document.querySelectorAll('[role="menu"]'), (menu) => {
				// 已处理过且我的项还在 → 跳过；处理过但项被 React 清掉了 → 重新插入
				if (menu.dataset.dshSgPatched === "1" && menu.querySelector('[data-dsh-sg-item="1"]')) return;
				const items = Array.prototype.slice.call(menu.querySelectorAll('[role="menuitem"]'));
				const isWsMenu = items.some((i) => (i.textContent || "").indexOf("删除工作区") >= 0);
				if (!isWsMenu) return;
				menu.dataset.dshSgPatched = "1";

				// 1) folder-tree-sh 在场时，优先把它的「新建文件夹」就地改造成「会话分组」（避免出现两项）
				let target = items.filter((i) => (i.textContent || "").indexOf("新建文件夹") >= 0)[0];

				// 2) 它不在场（干净的原生环境）→ 自己克隆一项插进去。
				//    克隆节点不属于 React 树，React 不会去动它，所以是安全的；真正危险的是
				//    往 React 的**列表容器**里插节点（folder-tree-sh 就是那样把页面搞崩的）。
				if (!target) {
					const anchor = items.filter((i) => (i.textContent || "").indexOf("重命名") >= 0)[0] || items[0];
					if (!anchor || !anchor.parentElement) return;
					const clone = anchor.cloneNode(true);
					clone.removeAttribute("aria-label");
					try { anchor.parentElement.insertBefore(clone, anchor.nextSibling); } catch (_) { return; }
					target = clone;
				}
				target.setAttribute("data-dsh-sg-item", "1");

				// 与兄弟项同款：克隆/被清洗过的节点可能拿不到菜单项样式，直接沿用「重命名」的类名
				const sibling = items.filter((i) => i !== target && (i.textContent || "").indexOf("重命名") >= 0)[0]
					|| items.filter((i) => i !== target)[0];
				if (sibling && sibling.className) {
					try { target.className = sibling.className; } catch (_) { /* 保底 */ }
				}
				const spans = target.querySelectorAll("span");
				(spans.length ? spans[spans.length - 1] : target).textContent = "会话分组";
				try { target.querySelector("svg").outerHTML = GROUP_ICON; } catch (_) { /* 图标换不掉不影响功能 */ }
			});
		}
		function removeGroupMenuItem() {
			Array.prototype.forEach.call(document.querySelectorAll('[data-dsh-sg-item="1"]'), (el) => {
				try { el.remove(); } catch (_) { /* 不在 React 树里，删掉是安全的 */ }
			});
		}

		function openPanelFor(ws) {
			panelWs = ws || lastWsName || activeWorkspace();
			panelOpen = true;
			applyGrouping();
			emit();
		}

		document.addEventListener("click", (e) => {
			if (!toggles.groups) return;
			const item = e.target && e.target.closest ? e.target.closest('[data-dsh-sg-item="1"]') : null;
			if (!item) return;
			e.preventDefault();
			e.stopImmediatePropagation();
			try {
				const menu = item.closest('[role="menu"]');
				if (menu) menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
			} catch (_) { /* 菜单关不掉也不影响面板 */ }
			openPanelFor(lastWsName);
		}, true);

		/* ---- 分组管理面板 ---- */
		function Panel() {
			const [, force] = react.useState(0);
			const [ws, setWs] = react.useState(panelWs || activeWorkspace());
			const [draft, setDraft] = react.useState("");
			const [, tickState] = react.useState(0);

			react.useEffect(() => subscribe(() => force((n) => n + 1)), []);
			react.useEffect(() => {
				const t = setInterval(() => tickState((n) => n + 1), 2000);
				return () => clearInterval(t);
			}, []);

			if (panelOpen && panelWs && panelWs !== ws) setWs(panelWs);
			if (!panelOpen || !toggles.groups) return null;

			const workspaces = scanWorkspaces();
			const cfg = cfgOf(ws, false) || { groups: [], assign: {}, collapsed: {} };
			let sessions = [];
			Array.prototype.forEach.call(document.querySelectorAll(SEC_SEL), (sec) => {
				const wsRow = sec.querySelector(ROW_SEL);
				if (!wsRow || wsNameOf(wsRow) !== ws) return;
				sessions = sessionsOf(sec).map((r) => sessNameOf(r));
			});

			const addGroup = () => {
				const nm = draft.trim();
				if (!nm) return;
				const c = cfgOf(ws, true);
				if (c.groups.some((g) => g.name === nm)) { alert("这个工作区已经有同名分组了"); return; }
				c.groups.push({ id: "g" + Date.now().toString(36), name: nm, color: COLORS[c.groups.length % COLORS.length] });
				saveGroups(); applyGrouping(); emit(); setDraft("");
			};
			const delGroup = (gid) => {
				const c = cfgOf(ws, true);
				c.groups = c.groups.filter((g) => g.id !== gid);
				Object.keys(c.assign).forEach((k) => { if (c.assign[k] === gid) delete c.assign[k]; });
				delete c.collapsed[gid];
				saveGroups(); applyGrouping(); emit();
			};
			const flip = (gid) => {
				const c = cfgOf(ws, true);
				c.collapsed[gid] = !c.collapsed[gid];
				saveGroups(); applyGrouping(); emit();
			};
			const assign = (sess, gid) => {
				const c = cfgOf(ws, true);
				if (!gid) delete c.assign[sess]; else c.assign[sess] = gid;
				saveGroups(); applyGrouping(); emit();
			};

			return h("div", { className: "dsh-sg-panel" },
				h("div", { className: "dsh-sg-head" },
					"会话分组",
					h("span", { className: "ws" }, ws || "（未识别到工作区）"),
					h("button", { className: "dsh-sg-close", type: "button", onClick: () => { panelOpen = false; emit(); } }, "关闭")
				),
				h("div", { className: "dsh-sg-tip" }, "给同一个工作区里的会话再分一层。标记只加在会话行上（不加节点），所以不会像旧的「新建文件夹」那样把页面搞崩。"),
				workspaces.length > 1 ? h("select", {
					className: "dsh-sg-sel", value: ws, style: { maxWidth: "100%" },
					onChange: (e) => { setWs(e.target.value); panelWs = e.target.value; }
				}, workspaces.map((w) => h("option", { key: w, value: w }, w))) : null,
				h("div", { className: "dsh-sg-sec" }, "分组"),
				h("div", { className: "dsh-sg-list" },
					cfg.groups.length === 0
						? h("div", { className: "dsh-sg-empty" }, "还没有分组。在下面输入名字建一个。")
						: cfg.groups.map((g) => h("div", { className: "dsh-sg-row", key: g.id },
							h("span", { className: "dsh-sg-dot", style: { background: g.color } }),
							h("span", { className: "dsh-sg-name" }, g.name),
							h("span", { className: "dsh-sg-name", style: { flex: "none", opacity: .6, fontSize: "11px" } },
								Object.keys(cfg.assign).filter((k) => cfg.assign[k] === g.id).length + " 个"),
							h("button", { className: "dsh-sg-btn", type: "button", onClick: () => flip(g.id) },
								cfg.collapsed[g.id] ? "展开" : "折叠"),
							h("button", { className: "dsh-sg-btn", type: "button", onClick: () => delGroup(g.id) }, "删除")
						))
				),
				h("div", { className: "dsh-sg-new" },
					h("input", {
						value: draft, placeholder: "新分组名字，例如「侧栏 UI」",
						onChange: (e) => setDraft(e.target.value),
						onKeyDown: (e) => { if (e.key === "Enter") addGroup(); }
					}),
					h("button", { className: "dsh-sg-btn p", type: "button", onClick: addGroup, disabled: !draft.trim() }, "新建分组")
				),
				h("div", { className: "dsh-sg-sec" }, "把这个工作区的会话归到组里" + (sessions.length ? "" : "（先展开该工作区）")),
				h("div", { className: "dsh-sg-list" },
					sessions.length === 0
						? h("div", { className: "dsh-sg-empty" }, "没读到会话行 —— 请先在侧栏展开对应工作区。")
						: sessions.map((s) => h("div", { className: "dsh-sg-row", key: s },
							h("span", { className: "dsh-sg-name", title: s }, s),
							h("select", {
								className: "dsh-sg-sel", value: cfg.assign[s] || "",
								onChange: (e) => assign(s, e.target.value)
							},
								h("option", { value: "" }, "未分组"),
								cfg.groups.map((g) => h("option", { key: g.id, value: g.id }, g.name))
							)
						))
				)
			);
		}

		/* ============================================================
		 * 封面编辑器（就地展开在工作区行下面）
		 * ============================================================ */
		function Editor(props) {
			const item = props.item;
			const [params, setParams] = react.useState(() => Object.assign({}, COVER_DEFAULTS, (item && item.params) || {}));
			const [loaded, setLoaded] = react.useState(false);
			const [busy, setBusy] = react.useState(false);
			const [msg, setMsg] = react.useState("");
			const [contrast, setContrast] = react.useState(0);
			const imgRef = react.useRef(null);
			const canvasRef = react.useRef(null);
			const fileRef = react.useRef(null);
			const dragRef = react.useRef(null);
			const previewTimer = react.useRef(null);

			const W = PREVIEW_W;
			const H = Math.round((props.rowHeight || 34) * 3);

			const redraw = react.useCallback(() => {
				const cv = canvasRef.current;
				if (!cv) return;
				const ctx = cv.getContext("2d");
				paintCover(ctx, W, H, params, imgRef.current);
				try { setContrast(1.05 / (zoneLum(ctx, W, H, 0.9) + 0.05)); } catch (_) { /* 跳过体检 */ }
				if (imgRef.current) {
					if (previewTimer.current) clearTimeout(previewTimer.current);
					previewTimer.current = setTimeout(() => {
						try { pushCoverPreview(props.name, cv.toDataURL("image/png")); } catch (_) { /* ignore */ }
					}, 160);
				}
			}, [params, W, H, props.name, props.rowHeight]);

			react.useEffect(() => { redraw(); }, [redraw]);
			react.useEffect(() => () => {
				if (previewTimer.current) clearTimeout(previewTimer.current);
				clearCoverPreview(props.name);
			}, [props.name]);

			react.useEffect(() => {
				if (!item || !item.key) { setLoaded(true); return; }
				const im = new Image();
				im.onload = () => { imgRef.current = im; setLoaded(true); redraw(); };
				im.onerror = () => {
					const im2 = new Image();
					im2.onload = () => { imgRef.current = im2; setLoaded(true); redraw(); };
					im2.src = COVER_API.img + "?k=" + item.key + "&t=" + (item.updatedAt || 0);
				};
				im.src = COVER_API.src + "?k=" + item.key + "&t=" + (item.updatedAt || 0);
			}, [item && item.key]);

			const loadFile = (file) => {
				if (!file || String(file.type).indexOf("image/") !== 0) return;
				const fr = new FileReader();
				fr.onload = (e) => {
					const im = new Image();
					im.onload = () => {
						imgRef.current = im;
						setParams((p) => Object.assign({}, p, { panX: 0, panY: 0 }));
						setMsg("已载入图片 · 拖拽选位置，滚轮缩放");
						setLoaded(true); redraw();
					};
					im.src = e.target.result;
				};
				fr.readAsDataURL(file);
			};

			/* 从内置默认图集载入（载进来之后照样可以调位置/暗化，与自传图完全同一条路） */
			const loadPreset = (id) => {
				setMsg("载入默认图…");
				const im = new Image();
				im.onload = () => {
					imgRef.current = im;
					setParams((p) => Object.assign({}, p, { panX: 0, panY: 0, zoom: 1 }));
					setLoaded(true);
					setMsg("已载入默认图 · 可继续调位置与暗化，然后点保存");
					redraw();
				};
				im.onerror = () => setMsg("默认图载入失败（宿主路由没起来？重启 dsh web 后再试）");
				im.src = COVER_API.preset + "?id=" + id;
			};

			const onWheel = (e) => {
				if (!imgRef.current) return;
				e.preventDefault();
				setParams((p) => Object.assign({}, p, { zoom: Math.min(3, Math.max(0.6, p.zoom * (e.deltaY > 0 ? 0.94 : 1.06))) }));
			};
			const onDown = (e) => {
				if (!imgRef.current) return;
				dragRef.current = { x: e.clientX, y: e.clientY };
				if (e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId);
			};
			const onMove = (e) => {
				const d = dragRef.current;
				if (!d) return;
				const rect = e.currentTarget.getBoundingClientRect();
				const dx = (e.clientX - d.x) / rect.width;
				const dy = (e.clientY - d.y) / rect.height;
				dragRef.current = { x: e.clientX, y: e.clientY };
				setParams((p) => Object.assign({}, p, { panX: p.panX + dx, panY: p.panY + dy }));
			};
			const onUp = () => { dragRef.current = null; };
			const nudge = (dir, mult) => {
				const s = 0.012 * (mult || 1);
				setParams((p) => {
					const q = Object.assign({}, p);
					if (dir === "up") q.panY -= s;
					else if (dir === "down") q.panY += s;
					else if (dir === "left") q.panX -= s;
					else if (dir === "right") q.panX += s;
					else { q.panX = 0; q.panY = 0; }
					return q;
				});
			};

			const autoFit = () => {
				const im = imgRef.current;
				if (!im) { setMsg("先选择一张图片"); return; }
				const cv = document.createElement("canvas");
				cv.width = W; cv.height = H;
				const ctx = cv.getContext("2d");
				let lo = 0, hi = 0.98, mid = 0.36;
				for (let i = 0; i < 10; i++) {
					mid = (lo + hi) / 2;
					paintCover(ctx, W, H, Object.assign({}, params, { mask: mid }), im);
					if (1.05 / (zoneLum(ctx, W, H, 0.9) + 0.05) >= 7) hi = mid; else lo = mid;
				}
				const mask = Math.min(0.98, hi + 0.03);
				setParams((p) => Object.assign({}, p, { mask: Math.round(mask * 100) / 100 }));
				setMsg("已自动适配：蒙版 " + mask.toFixed(2));
			};

			const save = async () => {
				const im = imgRef.current;
				if (!im) { setMsg("先选择一张图片"); return; }
				setBusy(true); setMsg("保存中…");
				try {
					const cv = document.createElement("canvas");
					cv.width = W; cv.height = H;
					paintCover(cv.getContext("2d"), W, H, params, im);
					const dataUrl = cv.toDataURL("image/png");
					const sw = Math.min(1024, im.width);
					const sh = Math.max(1, Math.round(im.height * (sw / im.width)));
					const sc = document.createElement("canvas");
					sc.width = sw; sc.height = sh;
					sc.getContext("2d").drawImage(im, 0, 0, sw, sh);
					const r = await fetch(COVER_API.save, {
						method: "POST", headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							name: props.name, dataUrl: dataUrl, srcDataUrl: sc.toDataURL("image/png"),
							params: {
								zoom: params.zoom, panX: params.panX, panY: params.panY,
								brightness: params.brightness, saturate: params.saturate, contrast: params.contrast,
								blur: params.blur, localBlur: params.localBlur, mask: params.mask, maskMid: params.maskMid
							}
						})
					});
					const d = await r.json();
					if (!d || !d.ok) throw new Error((d && d.error) || "保存失败");
					setMsg("已保存（" + Math.round((d.bytes || 0) / 1024) + " KB）");
					const row = findRowByName(props.name);
					if (row) row.removeAttribute("data-dsh-preview");
					await refreshCovers();
				} catch (err) {
					setMsg("保存失败：" + (err && err.message ? err.message : String(err)));
				} finally { setBusy(false); }
			};

			const clear = async () => {
				setBusy(true);
				try {
					await fetch(COVER_API.del, {
						method: "POST", headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ name: props.name })
					});
					imgRef.current = null;
					setMsg("已清除该工作区的封面");
					clearCoverPreview(props.name);
					await refreshCovers();
					if (props.onClose) props.onClose();
				} catch (_) { setMsg("清除失败"); } finally { setBusy(false); }
			};

			const ctl = (id, label, min, max, step, fmt) => h("div", { className: "dsh-wc-ctl", key: id },
				h("label", null, label, h("b", null, fmt(params[id]))),
				h("input", {
					type: "range", min: min, max: max, step: step, value: params[id],
					onChange: (e) => {
						const v = parseFloat(e.target.value);
						setParams((p) => Object.assign({}, p, { [id]: v }));
					}
				})
			);

			return h("div", { className: "dsh-wc-editor" },
				h("div", { className: "dsh-wc-editor-head" },
					h("span", { className: "dsh-wc-editor-title" }, "编辑封面 · " + props.name),
					h("span", { className: "dsh-wc-msg" }, loaded ? (imgRef.current ? "图片已载入" : "还没有图片") : "载入中…")
				),
				h("div", {
					className: "dsh-wc-stage",
					onDragOver: (e) => e.preventDefault(),
					onDrop: (e) => { e.preventDefault(); if (e.dataTransfer && e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); },
					onWheel: onWheel, onPointerDown: onDown, onPointerMove: onMove, onPointerUp: onUp, onPointerLeave: onUp
				}, h("canvas", { ref: canvasRef, width: W, height: H })),
				h("div", { className: "dsh-wc-presets" },
					h("span", { className: "dsh-wc-presets-label" }, "默认图集："),
					PRESETS.map((p) => h("button", {
						key: p.id, type: "button", className: "dsh-wc-preset", title: p.label,
						style: { backgroundImage: 'url("' + COVER_API.preset + "?id=" + p.id + '")' },
						onClick: () => loadPreset(p.id)
					}))
				),
				h("div", { className: "dsh-wc-grid" },
					h("div", null,
						ctl("zoom", "缩放", 0.6, 3, 0.01, (v) => v.toFixed(2) + "×"),
						ctl("panX", "水平位置", -0.5, 0.5, 0.005, (v) => (v * 100).toFixed(1) + "%"),
						ctl("panY", "垂直位置", -0.5, 0.5, 0.005, (v) => (v * 100).toFixed(1) + "%"),
						h("div", { className: "dsh-wc-nudge" },
							h("span", null), h("button", { type: "button", onClick: (e) => nudge("up", e.shiftKey ? 5 : 1) }, "↑"), h("span", null),
							h("button", { type: "button", onClick: (e) => nudge("left", e.shiftKey ? 5 : 1) }, "←"),
							h("button", { type: "button", onClick: () => nudge("center") }, "·"),
							h("button", { type: "button", onClick: (e) => nudge("right", e.shiftKey ? 5 : 1) }, "→"),
							h("span", null), h("button", { type: "button", onClick: (e) => nudge("down", e.shiftKey ? 5 : 1) }, "↓"), h("span", null)
						)
					),
					h("div", null,
						ctl("brightness", "整体亮度", 0.3, 1.2, 0.01, (v) => v.toFixed(2)),
						ctl("saturate", "饱和度", 0, 1.6, 0.01, (v) => v.toFixed(2)),
						ctl("localBlur", "文字区柔化（景深）", 0, 14, 0.5, (v) => v.toFixed(1) + "px"),
						ctl("mask", "文字区压暗", 0, 0.98, 0.01, (v) => v.toFixed(2)),
						ctl("maskMid", "压暗收尾位置", 0.2, 0.95, 0.01, (v) => (v * 100).toFixed(0) + "%"),
						ctl("blur", "整体模糊", 0, 6, 0.1, (v) => v.toFixed(1) + "px")
					)
				),
				h("div", { className: "dsh-wc-foot" },
					h("button", { type: "button", className: "dsh-wc-btn primary", onClick: () => fileRef.current && fileRef.current.click() },
						item && item.key ? "换一张图片" : "选择图片"),
					h("input", {
						ref: fileRef, type: "file", accept: "image/*", style: { display: "none" },
						onChange: (e) => { loadFile(e.target.files && e.target.files[0]); e.target.value = ""; }
					}),
					h("button", { type: "button", className: "dsh-wc-btn", onClick: autoFit, disabled: !loaded }, "自动适配"),
					h("button", { type: "button", className: "dsh-wc-btn primary", onClick: save, disabled: busy || !loaded }, "保存"),
					h("button", { type: "button", className: "dsh-wc-btn", onClick: clear, disabled: busy }, "清除封面"),
					h("button", { type: "button", className: "dsh-wc-btn", onClick: () => props.onClose && props.onClose() }, "收起"),
					h("span", { className: "dsh-wc-msg" }, contrast > 0 ? ("标题对比度 " + contrast.toFixed(2) + ":1" + (contrast >= 4.5 ? " · 达标" : " · 偏弱")) : ""),
					h("span", { className: "dsh-wc-msg" }, msg)
				)
			);
		}

		/* ============================================================
		 * 设置里的一栏「工作区」：三个开关 + 封面设置
		 * ============================================================ */
		function SettingsSection() {
			const [, force] = react.useState(0);
			const [editing, setEditing] = react.useState(null);
			const [, tickState] = react.useState(0);

			react.useEffect(() => {
				const un = subscribe(() => force((n) => n + 1));
				ensureStyle();
				refreshCovers();
				refreshCoverGlobal();
				const t = setInterval(() => tickState((n) => n + 1), 4000);
				return () => { un(); clearInterval(t); };
			}, []);

			const names = scanWorkspaces();
			Object.keys(coverMap).forEach((n) => { if (names.indexOf(n) < 0) names.push(n); });

			const sw = (key, title, desc) => h("div", { className: "dsh-wt-sw" + (toggles[key] ? " sel" : ""), key: key },
				h("div", { className: "t" }, h("b", null, title), h("span", null, desc)),
				h("div", {
					className: "dsh-wt-track", role: "switch",
					"data-on": toggles[key] ? "1" : "0",
					"aria-checked": toggles[key] ? "true" : "false",
					title: toggles[key] ? "点击关闭" : "点击开启",
					onClick: () => setToggle(key, !toggles[key])
				})
			);

			return h("div", { className: "dsh-wt-wrap" },
				h("div", { className: "dsh-wt-title" }, "工作区"),
				h("p", { className: "dsh-wt-hint" },
					"这块管左侧工作区列表的样子与用法。三个开关即时生效（不用重启、不用刷新）；开关状态与分组数据写在本机浏览器，封面图存在 ",
					h("code", null, "~/.dsh/storages/workspace-covers/"),
					"。给某个工作区点「设置封面」后，编辑区里会多出一排内置的「默认图集」可以直接挑；也随时可以上传自己的图片。"),
				h("div", { className: "dsh-wt-switches" },
					sw("cover", "工作区背景", "给每个工作区配一张行背景图：上传、裁剪、暗化，并自动保证工作区名读得清"),
					sw("fold", "工作区名展开 / 收缩", "把「工作区」小标题变成按钮：有展开时点一下全部折叠，再点恢复之前那几个"),
					sw("groups", "工作区下的会话分组", "给同一个工作区里的会话再分一层，入口在工作区行的「⋯」菜单里")
				),
				toggles.cover
					? h("div", null,
						h("div", { className: "dsh-wt-sec" }, "封面设置"),
						h("div", { className: "dsh-wc-global" },
							h("label", null, "封面行高度（统一）", h("b", null, coverGlobal.rowHeight + "px")),
							h("input", {
								type: "range", min: 28, max: 120, step: 1, value: coverGlobal.rowHeight,
								onChange: (e) => saveCoverGlobal(parseFloat(e.target.value))
							}),
							h("span", { className: "dsh-wc-msg" }, "所有封面行一起变高变矮，文字保持上下居中")
						),
						h("div", { className: "dsh-wc-list" },
							names.length === 0
								? h("div", { className: "dsh-wc-empty" }, "还没读到工作区列表 —— 打开侧栏或新建一个工作区后再回来。")
								: names.map((nm) => {
									const it = coverMap[nm];
									const open = editing === nm;
									return h("div", { className: "dsh-wc-item", key: nm },
										h("div", { className: "dsh-wc-row" },
											h("span", {
												className: "dsh-wc-thumb",
												style: it && it.key
													? { backgroundImage: 'url("' + COVER_API.img + "?k=" + it.key + "&t=" + (it.updatedAt || 0) + '")', borderColor: "transparent" }
													: null
											}),
											h("span", { className: "dsh-wc-name" }, nm),
											h("span", { className: "dsh-wc-btns" },
												h("button", {
													type: "button", className: "dsh-wc-btn",
													onClick: () => setEditing(open ? null : nm)
												}, open ? "收起" : (it && it.key ? "调整" : "设置封面"))
											)
										),
										open ? h(Editor, {
											key: nm, name: nm, item: it || null,
											rowHeight: coverGlobal.rowHeight, onClose: () => setEditing(null)
										}) : null
									);
								})
						)
					)
					: h("div", { className: "dsh-wt-off" }, "「工作区背景」已关闭，侧栏工作区行已还原成原生外观；重新打开开关即可继续用之前存好的封面。")
			);
		}

		/* 渲染兜底：设置面板里万一出错，显示原因而不是白屏 */
		class Boundary extends react.Component {
			constructor(props) { super(props); this.state = { err: null }; }
			static getDerivedStateFromError(e) { return { err: e }; }
			render() {
				if (this.state.err) {
					return h("div", { className: "dsh-wt-wrap" },
						h("div", { className: "dsh-wt-title" }, "工作区"),
						h("div", { className: "dsh-wt-off" }, "面板渲染出错：" + String((this.state.err && this.state.err.message) || this.state.err))
					);
				}
				return this.props.children;
			}
		}

		/* ============================================================
		 * 装配：三个开关各自 apply / revert
		 * ============================================================ */
		function applyAll() {
			ensureStyle();
			if (toggles.fold) mountFold(); else unmountFold();
			if (toggles.groups) { applyGrouping(); enhanceWsMenu(); }
			else { clearGrouping(); removeGroupMenuItem(); panelOpen = false; }
			if (toggles.cover) applyCovers(); else clearCovers();
		}

		function apply(ctx) {
			loadToggles();
			loadGroups();
			applyAll();
			refreshCovers();
			refreshCoverGlobal();

			const pass = () => {
				if (toggles.fold) mountFold();
				if (toggles.groups) { applyGrouping(); enhanceWsMenu(); }
				if (toggles.cover) applyCovers();
			};
			// 去抖：**不要**把 pass 直接当 MutationObserver 回调。React 一次交互（比如点击会话）
			// 会产生成百上千次 DOM 变更，逐个同步跑全量重算会把页面拖死（表现为必须刷新才能恢复）。
			let passTimer = 0;
			const schedulePass = () => {
				if (passTimer) return;
				passTimer = setTimeout(() => { passTimer = 0; pass(); }, 80);
			};
			const obs = new MutationObserver(schedulePass);
			// 只观察结构变化：**不要**加 attributes 监听——我们的 pass 自己就会写
			// aria-expanded / class / style，监听属性会把自己触发成死循环。
			obs.observe(document.documentElement, { childList: true, subtree: true });
			const timer = setInterval(pass, 2000);

			const disposers = [];
			try {
				if (ctx.slots && typeof ctx.slots.inject === "function") {
					disposers.push(ctx.slots.inject("settings.section", () => ctx.slots.register(
						{ name: "settings.section", id: "workspace-tools", order: 420, label: "工作区" },
						() => react.createElement(Boundary, null, react.createElement(SettingsSection, null))
					)));
					disposers.push(ctx.slots.inject("shell.overlay", () => ctx.slots.register(
						{ name: "shell.overlay", id: "workspace-tools-panel", order: 45 },
						() => react.createElement(Panel, null)
					)));
				}
			} catch (e) {
				try { console.warn("[workspace-tools] slot 注入失败", e); } catch (_) { /* ignore */ }
			}

			return () => {
				obs.disconnect();
				clearInterval(timer);
				disposers.forEach((d) => { try { if (typeof d === "function") d(); } catch (_) { /* ignore */ } });
			};
		}

		exports.name = name;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

