/**
 * dsh-plugin-auto-commit-button — the browser half.
 *
 * One control in the composer tool row: a menu button labelled *Auto-commit*.
 * Opening it offers two independent switches — **Auto-commit** (commit what a
 * finished turn changed, in the repository holding this session's working
 * directory) and **Auto-push** (push each of those commits). Auto-push needs
 * something to push, so it stays disabled until Auto-commit is on.
 *
 * It is registered into `conversation.input.left`, so it sits with the other
 * compact composer controls and disappears with the session.
 *
 * The Host owns the truth: the control reads `/dsh-autocommit/state` on a timer
 * and writes switches to `/dsh-autocommit/toggle`. A click paints immediately
 * and the Host's answer replaces that optimistic state. The menu is portaled to
 * the document body and positioned from the trigger's rect, so the composer's
 * own stacking and overflow cannot crop it.
 *
 * This file is a client bundle: it registers a factory with the page's module
 * loader and is deliberately dependency-free. `react` and `react-dom` are
 * platform seed modules; everything else is plain browser API.
 */
window.__ModuleLoader__.load({
	id: 'dsh-plugin-auto-commit-button',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const React = require('react');
		const ReactDOM = require('react-dom');
		const h = React.createElement;

		/** Locale namespace owned by this plugin. */
		const NS = 'autocommit';
		/** Route prefix served by the Host half. */
		const ENDPOINT = '/dsh-autocommit';
		/** How often the control re-reads the Host state while it is on screen. */
		const POLL_MS = 5000;
		/** Longest a single request may take before it is treated as a failure. */
		const REQUEST_TIMEOUT_MS = 8000;
		/** Id of the single `<style>` element this plugin owns. */
		const STYLE_ID = 'dsh-autocommit-styles';
		/** Menu card width; fixed so placement needs no second measuring pass. */
		const MENU_WIDTH = 248;
		/** Gap between the trigger and its menu, matching the app's own menus. */
		const MENU_GAP = 4;
		/** Clearance the menu keeps from the viewport edges. */
		const MENU_MARGIN = 12;

		/** English copy. */
		const en = {
			label: 'Auto-commit',
			menuTitle: 'Auto-commit settings',
			commitHint: 'Commit this workspace after every turn',
			pushLabel: 'Auto-push',
			pushHint: 'Push each commit to the remote',
			pushBlocked: 'Turn on Auto-commit first',
			loading: 'Checking this workspace for a Git repository…',
			titleOn: 'Auto-commit is on for {repo} ({branch}).',
			titleOff: 'Auto-commit is off for {repo} ({branch}).',
			detached: 'detached HEAD',
			state: '{branch} · {changes}',
			clean: 'working tree clean',
			changedOne: '1 uncommitted change',
			changedMany: '{count} uncommitted changes',
			busy: 'Committing changes to {repo}…',
			lastCommit: 'Last commit: {short} {subject}',
			pushed: 'pushed',
			failed: 'The last auto-commit failed: {message}',
			switchFailed: 'The switch could not be changed: {message}',
			noGit: 'Auto-commit needs Git installed and on your PATH.',
			noRepo: 'Auto-commit needs a Git repository. Run git init in {cwd} to enable it.',
			blocked: 'Auto-commit is unavailable here: {reason}',
			unavailable: 'Auto-commit cannot reach the Host: {message}'
		};

		/** Chinese copy, the same keys. */
		const zh = {
			label: '自动提交',
			menuTitle: '自动提交设置',
			commitHint: '每轮结束后提交此工作区的改动',
			pushLabel: '自动推送',
			pushHint: '把每次提交推送到远端',
			pushBlocked: '请先开启自动提交',
			loading: '正在检查此工作区是否为 Git 仓库…',
			titleOn: '{repo}（{branch}）的自动提交已开启。',
			titleOff: '{repo}（{branch}）的自动提交已关闭。',
			detached: '游离 HEAD',
			state: '{branch} · {changes}',
			clean: '工作区无未提交更改',
			changedOne: '1 处未提交更改',
			changedMany: '{count} 处未提交更改',
			busy: '正在提交 {repo} 中的更改…',
			lastCommit: '上次提交：{short} {subject}',
			pushed: '已推送',
			failed: '上次自动提交失败：{message}',
			switchFailed: '无法切换该开关：{message}',
			noGit: '自动提交需要已安装 Git 并在 PATH 中可用。',
			noRepo: '自动提交需要 Git 仓库。请在 {cwd} 中运行 git init。',
			blocked: '此处无法使用自动提交：{reason}',
			unavailable: '自动提交无法连接宿主：{message}'
		};

		/**
		 * Fill `{name}` placeholders.
		 * @param text - template.
		 * @param values - placeholder values.
		 * @returns the rendered text.
		 */
		function format(text, values) {
			return text.replace(/\{([a-z]+)\}/gu, (match, key) => (key in values ? String(values[key]) : match));
		}

		/** Render an unknown error for a tooltip. */
		function describe(error) {
			return error instanceof Error ? error.message : String(error);
		}

		/** Install the plugin's stylesheet once. */
		function installStyles() {
			if (typeof document === 'undefined') return;
			if (document.getElementById(STYLE_ID) !== null) return;
			const style = document.createElement('style');
			style.id = STYLE_ID;
			style.textContent = `
.dsh-autocommit-wrap{display:inline-flex;min-width:0}
.dsh-autocommit{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 6px 0 8px;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary,#81858c);font:inherit;font-size:13px;font-weight:500;line-height:20px;cursor:pointer;transition:background-color .12s ease-out,color .12s ease-out,transform .08s ease-out}
.dsh-autocommit:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,#16181d)}
.dsh-autocommit:active{transform:scale(.96)}
.dsh-autocommit:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe))}
.dsh-autocommit[data-on="true"]{color:var(--dsw-alias-state-business-primary,#4d6bfe);background:var(--dsw-alias-state-business-tertiary,rgba(77,107,254,.12))}
.dsh-autocommit[data-on="true"]:hover{background:color-mix(in srgb,var(--dsw-alias-state-business-tertiary,rgba(77,107,254,.12)),var(--dsw-alias-state-business-primary,#4d6bfe) 6%)}
.dsh-autocommit-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-autocommit-icon{flex:none;display:block}
.dsh-autocommit-chevron{flex:none;display:block;transition:transform .12s ease-out}
.dsh-autocommit[aria-expanded="true"] .dsh-autocommit-chevron{transform:rotate(180deg)}
.dsh-autocommit-push{flex:none;display:block;color:var(--dsw-alias-state-business-primary,#4d6bfe)}
.dsh-autocommit-dot{flex:none;width:6px;height:6px;margin:0 1px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-state-error-primary,#e5484d)}
.dsh-autocommit[data-loading="true"] .dsh-autocommit-spinner{opacity:.5}
.dsh-autocommit-spinner{flex:none;display:block;color:var(--dsw-alias-label-tertiary,#9a9ea6);transform-origin:center;animation:dsh-autocommit-spin 1.5s linear infinite}
.dsh-autocommit-spinner circle{fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}
.dsh-autocommit-spinner .track{opacity:.25}
.dsh-autocommit-spinner .arc{stroke-dasharray:12 150;animation:dsh-autocommit-dash 1.5s ease-in-out infinite}
.dsh-autocommit-menu{position:fixed;z-index:1100;display:flex;flex-direction:column;box-sizing:border-box;padding:4px;border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-menu-surface-fill,var(--dsw-alias-bg-layer-3,#fff));backdrop-filter:var(--dsw-menu-backdrop-filter,blur(24px));box-shadow:var(--dsw-elevation-prominent,0 8px 32px rgba(0,0,0,.16));--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);overflow-y:auto;animation:dsh-autocommit-menu-in .12s ease-out}
.dsh-autocommit-row{display:flex;align-items:flex-start;gap:6px;box-sizing:border-box;width:100%;min-height:34px;padding:6px 8px;border:none;border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-primary,#16181d);font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer;transition:background-color .1s ease-out}
.dsh-autocommit-row:hover:not([aria-disabled="true"]),.dsh-autocommit-row:focus-visible{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));outline:none}
.dsh-autocommit-row[aria-disabled="true"]{color:var(--dsw-alias-label-dimmed,#b3b6bd);cursor:default}
.dsh-autocommit-check{flex:none;display:grid;place-items:center;width:16px;height:16px;margin-top:2px;color:var(--dsw-alias-state-business-primary,#4d6bfe)}
.dsh-autocommit-row[aria-disabled="true"] .dsh-autocommit-check{color:inherit}
.dsh-autocommit-copy{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsh-autocommit-hint{color:var(--dsw-alias-label-tertiary,#9a9ea6);font-size:12px;line-height:18px}
.dsh-autocommit-row[aria-disabled="true"] .dsh-autocommit-hint{color:inherit}
.dsh-autocommit-foot{display:flex;flex-direction:column;gap:2px;margin-top:3px;padding:6px 8px 4px;border-top:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary,#9a9ea6);font-size:12px;line-height:18px}
.dsh-autocommit-foot-line{overflow-wrap:anywhere}
.dsh-autocommit-foot-error{color:var(--dsw-alias-state-error-primary,#e5484d)}
@keyframes dsh-autocommit-spin{to{transform:rotate(360deg)}}
@keyframes dsh-autocommit-dash{0%{stroke-dasharray:12 150;stroke-dashoffset:0}50%{stroke-dasharray:24 150;stroke-dashoffset:-6}100%{stroke-dasharray:12 150;stroke-dashoffset:0}}
@keyframes dsh-autocommit-menu-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.dsh-autocommit,.dsh-autocommit-row{transition:none}.dsh-autocommit:active{transform:none}.dsh-autocommit-chevron{transition:none}.dsh-autocommit-spinner,.dsh-autocommit-spinner .arc,.dsh-autocommit-menu{animation:none}.dsh-autocommit-spinner .arc{stroke-dasharray:18 150;stroke-dashoffset:-3}}
`;
			document.head.appendChild(style);
		}

		/**
		 * Read one Host route.
		 * @param method - HTTP method.
		 * @param path - path under {@link ENDPOINT}.
		 * @param body - request body for writes.
		 * @param signal - cancellation from the caller.
		 * @returns the parsed JSON body.
		 */
		async function request(method, path, body, signal) {
			const timer = new AbortController();
			const timeout = setTimeout(() => timer.abort(new Error('the Host did not answer in time')), REQUEST_TIMEOUT_MS);
			const abort = () => timer.abort(signal?.reason);
			signal?.addEventListener('abort', abort, { once: true });
			try {
				const response = await fetch(ENDPOINT + path, {
					method,
					signal: timer.signal,
					headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
					body: body === undefined ? undefined : JSON.stringify(body)
				});
				const text = await response.text();
				let parsed = null;
				try {
					parsed = JSON.parse(text);
				} catch {
					parsed = null;
				}
				if (!response.ok) throw new Error(typeof parsed?.message === 'string' ? parsed.message : `the Host answered ${String(response.status)}`);
				if (parsed === null || typeof parsed !== 'object') throw new Error('the Host answered with a malformed body');
				return parsed;
			} finally {
				clearTimeout(timeout);
				signal?.removeEventListener('abort', abort);
			}
		}

		/**
		 * One session's view of the Host state.
		 *
		 * The store owns the polling lifetime, so the Host is asked only while a
		 * control is actually on screen. `pending` carries the optimistic switch
		 * pair until the Host's answer replaces it.
		 *
		 * @param sessionId - the session whose repository is switched.
		 * @returns the store: subscribe, read, start, setSwitches.
		 */
		function createStore(sessionId) {
			let snapshot = {
				phase: 'loading',
				commit: false,
				push: false,
				pending: null,
				repo: null,
				cwd: '',
				blocked: null,
				gitAvailable: true,
				busy: false,
				dirty: null,
				lastCommit: null,
				lastPush: null,
				lastError: null,
				clientError: null
			};
			const listeners = new Set();
			let references = 0;
			let timer = null;
			let controller = null;

			const emit = () => {
				for (const listener of [...listeners]) {
					try {
						listener();
					} catch {
						/* one bad listener must not stop the others */
					}
				}
			};

			const publish = (patch) => {
				let changed = false;
				for (const key of Object.keys(patch)) {
					if (snapshot[key] !== patch[key]) {
						changed = true;
						break;
					}
				}
				if (!changed) return;
				snapshot = Object.assign({}, snapshot, patch);
				emit();
			};

			/** Turn one Host payload into the store's fields. */
			const accept = (state) => ({
				phase: 'ready',
				// `enabled` is the pre-menu name of the commit switch.
				commit: state.commit === true || state.enabled === true,
				push: state.push === true,
				pending: null,
				repo: state.repo ?? null,
				cwd: typeof state.cwd === 'string' ? state.cwd : '',
				blocked: typeof state.blocked === 'string' ? state.blocked : null,
				gitAvailable: state.gitAvailable !== false,
				busy: state.busy === true,
				dirty: state.dirty ?? null,
				lastCommit: state.lastCommit ?? null,
				lastPush: state.lastPush ?? null,
				lastError: state.lastError ?? null,
				clientError: null
			});

			/** Read the Host state once. */
			async function load() {
				controller?.abort(new Error('superseded'));
				controller = new AbortController();
				const own = controller;
				try {
					const state = await request('GET', `/state?sessionId=${encodeURIComponent(sessionId)}`, undefined, own.signal);
					if (own.signal.aborted) return;
					publish(accept(state));
				} catch (error) {
					if (own.signal.aborted) return;
					publish({ phase: 'unavailable', clientError: describe(error) });
				}
			}

			/**
			 * Change one or both switches on the Host.
			 * @param patch - `commit` and/or `push`.
			 */
			async function setSwitches(patch) {
				if (snapshot.phase !== 'ready' || snapshot.repo === null || snapshot.blocked !== null || !snapshot.gitAvailable) return;
				const current = snapshot.pending ?? { commit: snapshot.commit, push: snapshot.push };
				const next = {
					commit: typeof patch.commit === 'boolean' ? patch.commit : current.commit,
					push: typeof patch.push === 'boolean' ? patch.push : current.push
				};
				publish({ pending: next });
				try {
					const state = await request('POST', '/toggle', { sessionId, commit: next.commit, push: next.push });
					publish(accept(state));
				} catch (error) {
					publish({ pending: null, clientError: describe(error) });
				}
			}

			/** Refresh when the page becomes visible again. */
			const onVisibility = () => {
				if (document.visibilityState === 'visible') void load();
			};

			return {
				subscribe: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				getSnapshot: () => snapshot,
				start: () => {
					references += 1;
					if (references === 1) {
						void load();
						timer = setInterval(() => {
							if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void load();
						}, POLL_MS);
						if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
					}
					return () => {
						references -= 1;
						if (references > 0) return;
						if (timer !== null) clearInterval(timer);
						timer = null;
						if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
						controller?.abort(new Error('unmounted'));
						controller = null;
					};
				},
				setSwitches
			};
		}

		/**
		 * Fixed-position box for the menu, measured from the trigger.
		 *
		 * The menu opens upward: the composer sits at the bottom of the window,
		 * so above the trigger is the side with room.
		 *
		 * @param trigger - the trigger element, when it has been mounted.
		 * @returns the box, or null outside a browser.
		 */
		function placementFor(trigger) {
			if (typeof window === 'undefined') return null;
			// A page always has both; the fallbacks only cover a host object that
			// is not a real window (an embedded runtime, or a test global).
			const viewportWidth = Number.isFinite(window.innerWidth) ? window.innerWidth : 1280;
			const viewportHeight = Number.isFinite(window.innerHeight) ? window.innerHeight : 800;
			const rect = typeof trigger?.getBoundingClientRect === 'function'
				? trigger.getBoundingClientRect()
				: { left: MENU_MARGIN, top: viewportHeight - 160 };
			const maxLeft = Math.max(MENU_MARGIN, viewportWidth - MENU_WIDTH - MENU_MARGIN);
			return {
				width: MENU_WIDTH,
				left: Math.min(Math.max(MENU_MARGIN, rect.left), maxLeft),
				bottom: viewportHeight - rect.top + MENU_GAP,
				maxHeight: Math.max(160, rect.top - MENU_GAP - MENU_MARGIN)
			};
		}

		/**
		 * The composer control: a menu button carrying the two switches.
		 * @param props - the slot's composed props plus the injected store and `t`.
		 * @returns the control, or nothing when the composer has no session.
		 */
		function AutoCommitControl(props) {
			const store = props.store;
			const t = props.t;
			const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
			const [open, setOpen] = React.useState(false);
			const [active, setActive] = React.useState(0);
			const [anchor, setAnchor] = React.useState(null);
			const triggerRef = React.useRef(null);
			const menuRef = React.useRef(null);
			const rowRefs = React.useRef([]);
			React.useEffect(() => store.start(), [store]);

			const commit = state.pending !== null ? state.pending.commit : state.commit;
			const push = state.pending !== null ? state.pending.push : state.push;
			const repo = state.repo;
			const ready = state.phase === 'ready' && repo !== null && state.blocked === null && state.gitAvailable;
			const branch = repo !== null && repo.branch.length > 0 ? repo.branch : t('detached');

			/**
			 * Why the control cannot be used, when it cannot.
			 * @returns the sentence shown in the menu, or null when it works.
			 */
			const reason = () => {
				if (state.phase === 'loading') return t('loading');
				if (state.phase === 'unavailable') return format(t('unavailable'), { message: state.clientError ?? '' });
				if (!state.gitAvailable) return t('noGit');
				if (state.blocked !== null) return format(t('blocked'), { reason: state.blocked });
				if (repo === null) return format(t('noRepo'), { cwd: state.cwd });
				return null;
			};

			/** The repository-and-changes line, when there is one to show. */
			const status = () => {
				if (repo === null) return null;
				const changes =
					state.dirty === null
						? null
						: state.dirty.files === 0
							? t('clean')
							: state.dirty.files === 1
								? t('changedOne')
								: format(t('changedMany'), { count: state.dirty.files });
				return changes === null ? branch : format(t('state'), { branch, changes });
			};

			/** The two switchable rows, in menu order. */
			const rows = [
				{ key: 'commit', label: t('label'), hint: t('commitHint'), checked: commit, enabled: ready },
				{ key: 'push', label: t('pushLabel'), hint: commit ? t('pushHint') : t('pushBlocked'), checked: push, enabled: ready && commit }
			];

			/** Every line of the menu footer: why it is unavailable, or the report. */
			const footLines = () => {
				if (!ready) return [{ text: reason(), error: state.phase === 'unavailable' || state.clientError !== null }];
				const lines = [];
				const summary = status();
				if (summary !== null) lines.push({ text: summary, error: false });
				if (state.lastCommit !== null && state.lastCommit.short.length > 0) {
					const pushed = state.lastPush !== null && state.lastPush.short === state.lastCommit.short ? ` · ${t('pushed')}` : '';
					lines.push({ text: `${format(t('lastCommit'), { short: state.lastCommit.short, subject: state.lastCommit.subject })}${pushed}`, error: false });
				}
				if (state.lastError !== null) lines.push({ text: format(t('failed'), { message: state.lastError.message }), error: true });
				if (state.clientError !== null) lines.push({ text: format(t('switchFailed'), { message: state.clientError }), error: true });
				return lines;
			};

			/** The trigger's hover tooltip: the state, and nothing the menu already says. */
			const tooltip = () => {
				if (!ready) return reason();
				const lines = [
					state.busy
						? format(t('busy'), { repo: repo.name })
						: format(commit ? t('titleOn') : t('titleOff'), { repo: repo.name, branch })
				];
				const summary = status();
				if (summary !== null) lines.push(summary);
				return lines.join('\n');
			};

			const close = (restoreFocus) => {
				setOpen(false);
				if (restoreFocus) triggerRef.current?.focus?.();
			};

			const openMenu = () => {
				setAnchor(placementFor(triggerRef.current));
				setActive(ready ? 0 : -1);
				setOpen(true);
			};

			/** Move the focused row through the enabled ones, wrapping at the ends. */
			const move = (step) => {
				const enabled = rows.map((row, index) => (row.enabled ? index : -1)).filter((index) => index >= 0);
				if (enabled.length === 0) return;
				const position = enabled.indexOf(active);
				const next = enabled[(position + step + enabled.length) % enabled.length];
				setActive(next);
				rowRefs.current[next]?.focus?.();
			};

			/** Flip one row's switch through the Host. */
			const activate = (index) => {
				const row = rows[index];
				if (row === undefined || !row.enabled) return;
				void store.setSwitches({ [row.key]: !row.checked });
			};

			const onMenuKeyDown = (event) => {
				if (event.key === 'Escape') {
					event.stopPropagation();
					close(true);
					return;
				}
				if (event.key === 'Tab') {
					close(false);
					return;
				}
				if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
					event.preventDefault();
					move(event.key === 'ArrowDown' ? 1 : -1);
					return;
				}
				if (event.key === 'Home' || event.key === 'End') {
					event.preventDefault();
					const enabled = rows.map((row, index) => (row.enabled ? index : -1)).filter((index) => index >= 0);
					const next = event.key === 'Home' ? enabled[0] : enabled[enabled.length - 1];
					if (next !== undefined) {
						setActive(next);
						rowRefs.current[next]?.focus?.();
					}
					return;
				}
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					activate(active);
				}
			};

			// Dismissal and following: while the menu is open, a pointer press
			// outside it, Escape, a resize, or a scroll closes or re-anchors it.
			React.useEffect(() => {
				if (!open || typeof document === 'undefined') return undefined;
				const inside = (target) => Boolean(menuRef.current?.contains?.(target) || triggerRef.current?.contains?.(target));
				const onPointerDown = (event) => {
					if (!inside(event.target)) setOpen(false);
				};
				const onKeyDown = (event) => {
					if (event.key !== 'Escape') return;
					event.stopPropagation();
					close(true);
				};
				const reposition = () => setAnchor(placementFor(triggerRef.current));
				document.addEventListener('pointerdown', onPointerDown, true);
				document.addEventListener('keydown', onKeyDown, true);
				window.addEventListener('resize', reposition);
				window.addEventListener('scroll', reposition, true);
				rowRefs.current[active]?.focus?.();
				return () => {
					document.removeEventListener('pointerdown', onPointerDown, true);
					document.removeEventListener('keydown', onKeyDown, true);
					window.removeEventListener('resize', reposition);
					window.removeEventListener('scroll', reposition, true);
				};
			}, [open]);

			const svg = (className, size, children, viewBox = '0 0 16 16') => h(
				'svg',
				{
					className,
					width: size,
					height: size,
					viewBox,
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.7,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					'aria-hidden': true,
					focusable: false
				},
				children
			);

			const branchIcon = svg('dsh-autocommit-icon', 14, [
				h('path', { key: 'trunk', d: 'M4 2v10' }),
				h('circle', { key: 'top', cx: 12, cy: 4, r: 2 }),
				h('circle', { key: 'bottom', cx: 4, cy: 12, r: 2 }),
				h('path', { key: 'curve', d: 'M12 6a6 6 0 0 1-6 6' })
			]);
			const spinner = svg('dsh-autocommit-spinner', 12, [
				h('circle', { key: 'track', className: 'track', cx: 6, cy: 6, r: 5 }),
				h('circle', { key: 'arc', className: 'arc', cx: 6, cy: 6, r: 5 })
			], '0 0 12 12');
			const chevron = svg('dsh-autocommit-chevron', 14, [h('path', { key: 'chevron', d: 'M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6' })]);

			const trigger = h(
				'button',
				{
					type: 'button',
					ref: triggerRef,
					className: 'dsh-autocommit',
					'aria-haspopup': 'menu',
					'aria-expanded': open,
					'aria-label': t('menuTitle'),
					title: tooltip(),
					'data-on': commit ? 'true' : 'false',
					'data-push': push ? 'true' : 'false',
					'data-loading': state.phase === 'loading' ? 'true' : 'false',
					onClick: () => {
						if (open) close(false);
						else openMenu();
					},
					onKeyDown: (event) => {
						if (event.key === 'ArrowDown') {
							event.preventDefault();
							openMenu();
						}
					}
				},
				state.busy ? spinner : branchIcon,
				h('span', { className: 'dsh-autocommit-label' }, t('label')),
				push && ready
					? svg('dsh-autocommit-push', 12, [h('path', { key: 'up', d: 'M8 13.5V2.5M8 2.5L4 6.5M8 2.5L12 6.5' })])
					: null,
				state.clientError !== null || state.lastError !== null ? h('span', { className: 'dsh-autocommit-dot' }) : null,
				chevron
			);

			const menu = open
				? h(
						'div',
						{
							ref: menuRef,
							role: 'menu',
							'aria-label': t('menuTitle'),
							className: 'dsh-autocommit-menu',
							style: anchor === null
								? undefined
								: { left: `${anchor.left}px`, bottom: `${anchor.bottom}px`, width: `${anchor.width}px`, maxHeight: `${anchor.maxHeight}px` },
							onKeyDown: onMenuKeyDown
						},
						rows.map((row, index) => h(
							'div',
							{
								key: row.key,
								ref: (node) => {
									rowRefs.current[index] = node;
								},
								role: 'menuitemcheckbox',
								'aria-checked': row.checked,
								'aria-disabled': row.enabled ? undefined : true,
								tabIndex: row.enabled && active === index ? 0 : -1,
								className: 'dsh-autocommit-row',
								onClick: () => activate(index),
								onMouseEnter: () => {
									if (row.enabled) setActive(index);
								}
							},
							h('span', { className: 'dsh-autocommit-check' }, row.checked ? svg('dsh-autocommit-check-icon', 16, [h('path', { key: 'check', d: 'M3.5 8.4L6.6 11.5L12.5 4.5' })]) : null),
							h(
								'span',
								{ className: 'dsh-autocommit-copy' },
								h('span', { className: 'dsh-autocommit-row-label' }, row.label),
								h('span', { className: 'dsh-autocommit-hint' }, row.hint)
							)
						)),
						h(
							'div',
							{ className: 'dsh-autocommit-foot' },
							footLines().map((line, index) => h(
								'div',
								{ key: String(index), className: line.error ? 'dsh-autocommit-foot-line dsh-autocommit-foot-error' : 'dsh-autocommit-foot-line' },
								line.text
							))
						)
					)
				: null;

			return h(
				'span',
				{ className: 'dsh-autocommit-wrap' },
				trigger,
				menu === null ? null : typeof document === 'undefined' ? menu : ReactDOM.createPortal(menu, document.body)
			);
		}

		/** Required client services; activation waits for them. */
		const inject = ['slots', 'locale'];

		/**
		 * Mount the browser half.
		 * @param ctx - client plugin context carrying `slots` and `locale`.
		 */
		function apply(ctx) {
			installStyles();
			ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'auto-commit: dictionaries');
			const t = ctx.locale.bind(NS);
			/** One store per session, so polling follows the mounted control. */
			const stores = new Map();
			ctx.effect(() => () => stores.clear(), 'auto-commit: session stores');

			ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
				name: 'conversation.input.left',
				id: 'auto-commit-button',
				order: 10,
				label: () => t('label'),
				locale: NS,
				inject: (sessionId) => {
					if (!stores.has(sessionId)) stores.set(sessionId, createStore(sessionId));
					return { store: stores.get(sessionId) };
				}
			}, AutoCommitControl));
		}

		exports.name = 'dsh-plugin-auto-commit-button';
		exports.inject = inject;
		exports.apply = apply;
		exports.createStore = createStore;
		return module.exports;
	}
});
