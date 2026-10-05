/**
 * dsh-plugin-auto-commit-button — the browser half.
 *
 * One control in the composer tool row: a toggle that arms automatic Git
 * commits for the repository holding this session's working directory. It is
 * registered into `conversation.input.left`, so it sits with the other compact
 * composer controls and disappears with the session.
 *
 * The two Host facts this needs — "is this workspace inside a repository?" and
 * "is it armed?" — live on the Host half. The control reads them from
 * `/dsh-autocommit/state` on a timer and writes the toggle to
 * `/dsh-autocommit/toggle`; the optimistic update paints the click immediately
 * and the response is the truth that follows it.
 *
 * This file is a client bundle: it registers a factory with the page's module
 * loader and is deliberately dependency-free. `react` is the platform seed
 * module; everything else is plain browser APIs.
 */
window.__ModuleLoader__.load({
	id: 'dsh-plugin-auto-commit-button',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const React = require('react');
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

		/** English copy. */
		const en = {
			label: 'Auto-commit',
			loading: 'Checking this workspace for a Git repository…',
			off: 'Commit changes in {repo} after every turn.',
			on: 'Auto-commit is on: changes in {repo} are committed after every turn.',
			busy: 'Committing changes to {repo}…',
			detached: 'detached HEAD',
			state: '{branch} · {changes}',
			clean: 'working tree clean',
			changedOne: '1 uncommitted change',
			changedMany: '{count} uncommitted changes',
			lastCommit: 'Last commit: {short} {subject}',
			failed: 'The last auto-commit failed: {message}',
			noGit: 'Auto-commit needs Git installed and on your PATH.',
			noRepo: 'Auto-commit needs a Git repository. Run git init in {cwd} to enable it.',
			blocked: 'Auto-commit is unavailable here: {reason}',
			unavailable: 'Auto-commit cannot reach the Host: {message}',
			toggleFailed: 'Auto-commit could not be turned on: {message}'
		};

		/** Chinese copy, the same keys. */
		const zh = {
			label: '自动提交',
			loading: '正在检查此工作区是否为 Git 仓库…',
			off: '每轮结束后提交 {repo} 中的更改。',
			on: '自动提交已开启：每轮结束后提交 {repo} 中的更改。',
			busy: '正在提交 {repo} 中的更改…',
			detached: '游离 HEAD',
			state: '{branch} · {changes}',
			clean: '工作区无未提交更改',
			changedOne: '1 处未提交更改',
			changedMany: '{count} 处未提交更改',
			lastCommit: '上次提交：{short} {subject}',
			failed: '上次自动提交失败：{message}',
			noGit: '自动提交需要已安装 Git 并在 PATH 中可用。',
			noRepo: '自动提交需要 Git 仓库。请在 {cwd} 中运行 git init。',
			blocked: '此处无法使用自动提交：{reason}',
			unavailable: '自动提交无法连接宿主：{message}',
			toggleFailed: '无法开启自动提交：{message}'
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
.dsh-autocommit{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 8px;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary,#81858c);font:inherit;font-size:13px;font-weight:500;line-height:20px;cursor:pointer;transition:background-color .12s ease-out,color .12s ease-out,transform .08s ease-out}
.dsh-autocommit:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,#16181d)}
.dsh-autocommit:active:not(:disabled){transform:scale(.96)}
.dsh-autocommit:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe))}
.dsh-autocommit:disabled{cursor:default;color:var(--dsw-alias-label-dimmed,#b3b6bd)}
.dsh-autocommit[data-on="true"]{color:var(--dsw-alias-state-business-primary,#4d6bfe);background:var(--dsw-alias-state-business-tertiary,rgba(77,107,254,.12))}
.dsh-autocommit[data-on="true"]:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-business-tertiary,rgba(77,107,254,.12)),var(--dsw-alias-state-business-primary,#4d6bfe) 6%)}
.dsh-autocommit-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-autocommit-icon{flex:none;display:block}
.dsh-autocommit-dot{flex:none;display:grid;place-items:center;width:12px;height:12px;color:var(--dsw-alias-state-idle-primary,#c6c9cf)}
.dsh-autocommit-dot::after{content:"";width:6px;height:6px;border-radius:50%;corner-shape:round;background:currentColor}
.dsh-autocommit[data-on="true"] .dsh-autocommit-dot{color:currentColor}
.dsh-autocommit[data-state="error"] .dsh-autocommit-dot{color:var(--dsw-alias-state-error-primary,#e5484d)}
.dsh-autocommit[data-loading="true"] .dsh-autocommit-dot{opacity:.4}
.dsh-autocommit-dot[data-busy="true"]::after{display:none}
.dsh-autocommit-spinner{flex:none;display:block;color:var(--dsw-alias-label-tertiary,#9a9ea6);transform-origin:center;animation:dsh-autocommit-spin 1.5s linear infinite}
.dsh-autocommit-spinner circle{fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}
.dsh-autocommit-spinner .track{opacity:.25}
.dsh-autocommit-spinner .arc{stroke-dasharray:12 150;animation:dsh-autocommit-dash 1.5s ease-in-out infinite}
@keyframes dsh-autocommit-spin{to{transform:rotate(360deg)}}
@keyframes dsh-autocommit-dash{0%{stroke-dasharray:12 150;stroke-dashoffset:0}50%{stroke-dasharray:24 150;stroke-dashoffset:-6}100%{stroke-dasharray:12 150;stroke-dashoffset:0}}
@media (prefers-reduced-motion:reduce){.dsh-autocommit{transition:none}.dsh-autocommit:active:not(:disabled){transform:none}.dsh-autocommit-spinner,.dsh-autocommit-spinner .arc{animation:none}.dsh-autocommit-spinner .arc{stroke-dasharray:18 150;stroke-dashoffset:-3}}
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
		 * control is actually on screen. `pending` carries the optimistic toggle
		 * until the Host's answer replaces it.
		 *
		 * @param sessionId - the session whose repository is toggled.
		 * @returns the store: subscribe, read, start, stop, toggle.
		 */
		function createStore(sessionId) {
			let snapshot = {
				phase: 'loading',
				enabled: false,
				pending: null,
				repo: null,
				cwd: '',
				blocked: null,
				gitAvailable: true,
				busy: false,
				dirty: null,
				lastCommit: null,
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
				enabled: state.enabled === true,
				pending: null,
				repo: state.repo ?? null,
				cwd: typeof state.cwd === 'string' ? state.cwd : '',
				blocked: typeof state.blocked === 'string' ? state.blocked : null,
				gitAvailable: state.gitAvailable !== false,
				busy: state.busy === true,
				dirty: state.dirty ?? null,
				lastCommit: state.lastCommit ?? null,
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

			/** Ask the Host to arm or disarm this session's repository. */
			async function toggle() {
				if (snapshot.phase !== 'ready' || snapshot.repo === null || snapshot.blocked !== null || !snapshot.gitAvailable) return;
				const next = !(snapshot.pending ?? snapshot.enabled);
				publish({ pending: next });
				try {
					const state = await request('POST', '/toggle', { sessionId, enabled: next });
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
				toggle
			};
		}

		/**
		 * The composer control.
		 * @param props - the slot's composed props plus the injected store and `t`.
		 * @returns the toggle, or nothing when the composer has no session identity.
		 */
		function AutoCommitButton(props) {
			const store = props.store;
			const t = props.t;
			const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
			React.useEffect(() => store.start(), [store]);

			const enabled = state.pending ?? state.enabled;
			const ready = state.phase === 'ready' && state.repo !== null && state.blocked === null && state.gitAvailable;
			const repo = state.repo;
			const branch = repo !== null && repo.branch.length > 0 ? repo.branch : t('detached');

			/**
			 * Why the control cannot be used, when it cannot.
			 * @returns the sentence shown in the tooltip, or null when it works.
			 */
			const reason = () => {
				if (state.phase === 'loading') return t('loading');
				if (state.phase === 'unavailable') return format(t('unavailable'), { message: state.clientError ?? '' });
				if (!state.gitAvailable) return t('noGit');
				if (state.blocked !== null) return format(t('blocked'), { reason: state.blocked });
				if (state.repo === null) return format(t('noRepo'), { cwd: state.cwd });
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

			/** Every line of the tooltip, in reading order. */
			const tooltip = () => {
				if (!ready) return reason();
				const lines = [
					state.busy
						? format(t('busy'), { repo: repo.name })
						: enabled
							? format(t('on'), { repo: repo.name })
							: format(t('off'), { repo: repo.name })
				];
				const summary = status();
				if (summary !== null) lines.push(summary);
				if (state.lastCommit !== null && state.lastCommit.short.length > 0) {
					lines.push(format(t('lastCommit'), { short: state.lastCommit.short, subject: state.lastCommit.subject }));
				}
				if (state.lastError !== null) lines.push(format(t('failed'), { message: state.lastError.message }));
				if (state.clientError !== null) lines.push(format(t('toggleFailed'), { message: state.clientError }));
				return lines.join('\n');
			};

			const icon = h(
				'svg',
				{
					className: 'dsh-autocommit-icon',
					width: 14,
					height: 14,
					viewBox: '0 0 16 16',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.7,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					'aria-hidden': true,
					focusable: false
				},
				h('path', { d: 'M4 2v10' }),
				h('circle', { cx: 12, cy: 4, r: 2 }),
				h('circle', { cx: 4, cy: 12, r: 2 }),
				h('path', { d: 'M12 6a6 6 0 0 1-6 6' })
			);

			const indicator = state.busy
				? h(
						'span',
						{ className: 'dsh-autocommit-dot', 'data-busy': 'true' },
						h(
							'svg',
							{ className: 'dsh-autocommit-spinner', width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': true, focusable: false },
							h('circle', { className: 'track', cx: 6, cy: 6, r: 5 }),
							h('circle', { className: 'arc', cx: 6, cy: 6, r: 5 })
						)
					)
				: h('span', { className: 'dsh-autocommit-dot' });

			return h(
				'span',
				{ className: 'dsh-autocommit-wrap', title: tooltip() },
				h(
					'button',
					{
						type: 'button',
						className: 'dsh-autocommit',
						'aria-pressed': ready ? enabled : undefined,
						'aria-label': t('label'),
						disabled: !ready,
						'data-on': enabled ? 'true' : 'false',
						'data-state': state.clientError !== null || state.lastError !== null ? 'error' : 'idle',
						'data-loading': state.phase === 'loading' ? 'true' : 'false',
						onClick: () => {
							void store.toggle();
						}
					},
					icon,
					h('span', { className: 'dsh-autocommit-label' }, t('label')),
					indicator
				)
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
			}, AutoCommitButton));
		}

		exports.name = 'dsh-plugin-auto-commit-button';
		exports.inject = inject;
		exports.apply = apply;
		exports.createStore = createStore;
		return module.exports;
	}
});
