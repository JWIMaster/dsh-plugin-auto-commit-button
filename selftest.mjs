/**
 * Offline harness for the auto-commit-button plugin.
 *
 * Two halves, tested the way each is actually used:
 *
 * 1. **Host** (`index.js`) — a fake Cordis context with only the services the
 *    plugin touches, driving real `git` against throwaway repositories in the
 *    temporary directory. The turn boundary, the HTTP routes the composer
 *    calls, the `/autocommit` command, the guards, and the persisted toggle are
 *    all exercised end to end; the assertions read real commit history with
 *    `git log`, not the plugin's own bookkeeping.
 * 2. **Browser** (`client.js`) — the bundle is loaded exactly as the page loads
 *    it (`window.__ModuleLoader__.load`), its factory is materialized, and the
 *    registered component is rendered with a minimal hook runtime standing in
 *    for React (which has no copy on this machine). The rendered tree, the
 *    tooltip, the click, and the request it sends are all checked from the
 *    outside.
 *
 * Run with `npm test`.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from './index.js';

let failures = 0;
let checks = 0;

/** One assertion. */
const check = (label, condition, extra = '') => {
	checks += 1;
	const ok = Boolean(condition);
	if (!ok) failures += 1;
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
};

/** A heading, so a failure says which area it belongs to. */
const section = (title) => console.log(`\n== ${title}`);

/** Run git, failing loudly when a fixture command breaks. */
const git = (cwd, args) =>
	execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** `git log` subjects for one repository, newest first. */
const subjects = (cwd) => git(cwd, ['log', '--pretty=%s']).split('\n').filter(Boolean);

/** The body of the newest commit in one repository. */
const headBody = (cwd) => git(cwd, ['log', '-1', '--pretty=%b']);

// The plugin inherits this process's environment, so the fixture identity and a
// hermetic git configuration are set here rather than in every command.
process.env.GIT_AUTHOR_NAME = 'dsh selftest';
process.env.GIT_AUTHOR_EMAIL = 'selftest@example.invalid';
process.env.GIT_COMMITTER_NAME = 'dsh selftest';
process.env.GIT_COMMITTER_EMAIL = 'selftest@example.invalid';
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_SYSTEM = '/dev/null';

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-auto-commit-')));
const fakeHome = join(scratch, 'home');
mkdirSync(fakeHome, { recursive: true });
process.env.DSH_HOME = fakeHome;
const originalHome = process.env.HOME;

/** A repository with one baseline commit. */
function makeRepo(name) {
	const root = join(scratch, name);
	mkdirSync(root, { recursive: true });
	git(root, ['init', '--quiet']);
	writeFileSync(join(root, 'README.md'), '# fixture\n');
	git(root, ['add', '-A']);
	git(root, ['commit', '--quiet', '-m', 'baseline']);
	return realpathSync(root);
}

/** A message from the plugin's own log, for assertions about reporting. */
const logged = (state, needle) => state.logs.some(([, message]) => message.includes(needle));

/**
 * A fake Cordis context carrying exactly the services this plugin uses.
 * @param options - `config` for the patch row, and the agents already live.
 * @returns the context, its recorded registrations, and test drivers.
 */
function harness({ config = {}, agents = [] } = {}) {
	const state = {
		logs: [],
		agents: [...agents],
		listeners: new Map(),
		effects: [],
		commands: new Map(),
		routes: new Map()
	};

	const webCtx = {
		webServer: {
			register: (route) => {
				state.routes.set(route.path, route);
				return () => state.routes.delete(route.path);
			}
		},
		effect: (callback, label) => recordEffect(callback, label)
	};

	const recordEffect = (callback, label) => {
		const disposer = callback();
		state.effects.push({ label, disposer });
		return () => {
			if (typeof disposer === 'function') disposer();
		};
	};

	const ctx = {
		logger: {
			info: (message) => state.logs.push(['info', message]),
			warn: (message) => state.logs.push(['warn', message])
		},
		agents: { list: () => state.agents },
		get: (key) => {
			if (key !== 'commands') return undefined;
			return {
				register: (definition) => {
					state.commands.set(definition.name, definition);
					return () => state.commands.delete(definition.name);
				}
			};
		},
		on: (event, listener) => {
			const set = state.listeners.get(event) ?? new Set();
			set.add(listener);
			state.listeners.set(event, set);
			return () => set.delete(listener);
		},
		effect: recordEffect,
		inject: (dependencies, callback) => {
			callback(webCtx);
			return () => {};
		}
	};

	apply(ctx, config);

	/** Deliver one event to every listener, awaiting them in order. */
	const emit = async (event, payload) => {
		for (const listener of [...(state.listeners.get(event) ?? [])]) await listener(payload);
	};

	/** A request object that hands its body to the handler once it listens. */
	const makeRequest = ({ method = 'GET', url = '/', headers = {}, body = undefined }) => {
		const handlers = { data: [], end: [], error: [] };
		const request = {
			method,
			url,
			headers,
			destroyed: false,
			on: (event, listener) => {
				(handlers[event] ??= []).push(listener);
				return request;
			},
			destroy: () => {
				request.destroyed = true;
			},
			deliver: async () => {
				await Promise.resolve();
				if (body !== undefined) for (const listener of handlers.data) listener(Buffer.from(body));
				for (const listener of handlers.end) listener();
			}
		};
		return request;
	};

	/** Call the plugin's HTTP route and read the response. */
	const call = async (options) => {
		const route = state.routes.get('/dsh-autocommit');
		if (route === undefined) throw new Error('the plugin registered no HTTP route');
		const response = {
			status: 0,
			headers: null,
			body: '',
			writeHead(status, headers) {
				this.status = status;
				this.headers = headers;
				return this;
			},
			end(body) {
				this.body = body ?? '';
			}
		};
		const request = makeRequest(options);
		const done = route.handler(request, response);
		await request.deliver();
		await done;
		return { status: response.status, headers: response.headers, json: () => JSON.parse(response.body) };
	};

	/** Run one registered slash command. */
	const command = async (name, { agent, rawInput = '' } = {}) => {
		const definition = state.commands.get(name);
		if (definition === undefined) throw new Error(`/${name} is not registered`);
		return definition.handler({ agent, rawInput, commandId: 'selftest', attachments: [], signal: new AbortController().signal });
	};

	return { state, emit, call, command, webCtx };
}

/** One live session, shaped the way the Host announces it. */
const session = (id, cwd, extra = {}) => ({ id, session: { header: { cwd, ...extra } } });

const flush = () => new Promise((resolve) => {
	setTimeout(resolve, 0);
});

// ---------------------------------------------------------------------------
section('Host: the turn boundary commits what the turn changed');
// ---------------------------------------------------------------------------

const repoA = makeRepo('a');
const agentA = session('session-a', repoA);
const hostA = harness({ agents: [agentA] });
await hostA.emit('agent/created', { agent: agentA, source: 'startup' });

const initial = await hostA.call({ url: '/dsh-autocommit/state?sessionId=session-a' });
check('a session in a repository reports that repository', initial.json().repo?.root === repoA, initial.json().repo?.root ?? 'null');
check('a repository starts unarmed', initial.json().enabled === false);
check('git is reported available', initial.json().gitAvailable === true);
check('a clean tree reports no changes', initial.json().dirty?.files === 0);

const armed = await hostA.call({
	method: 'POST',
	url: '/dsh-autocommit/toggle',
	headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080', 'content-type': 'application/json' },
	body: JSON.stringify({ sessionId: 'session-a', enabled: true })
});
check('toggling on is accepted', armed.status === 200 && armed.json().enabled === true, `status ${String(armed.status)}`);
check('the toggle is persisted next to DSH_HOME', readFileSync(join(fakeHome, 'auto-commit-button.json'), 'utf8').includes(repoA));

writeFileSync(join(repoA, 'feature.txt'), 'work\n');
await hostA.emit('agent/turn-stopping', { agent: agentA, turn: 7 });

check('the turn produced a commit', subjects(repoA)[0] === 'dsh autocommit: turn 7', subjects(repoA)[0]);
check('the commit body names the session', headBody(repoA).includes('session: session-a'));
check('the commit body counts the change', headBody(repoA).includes('changes: 1'));
check('the commit body lists the file', headBody(repoA).includes('feature.txt'));
check('the repository is clean after the commit', git(repoA, ['status', '--porcelain']).trim() === '');

const afterCommit = await hostA.call({ url: '/dsh-autocommit/state?sessionId=session-a' });
check('the control can show the commit it just made', afterCommit.json().lastCommit?.short.length === 7 && afterCommit.json().lastCommit?.subject === 'dsh autocommit: turn 7');
check('no error is reported after a good commit', afterCommit.json().lastError === null);

const commitCount = subjects(repoA).length;
await hostA.emit('agent/turn-stopping', { agent: agentA, turn: 8 });
check('a turn that changed nothing commits nothing', subjects(repoA).length === commitCount);

// ---------------------------------------------------------------------------
section('Host: disarming, commands, and the scope of a commit');
// ---------------------------------------------------------------------------

const disarmed = await hostA.call({
	method: 'POST',
	url: '/dsh-autocommit/toggle',
	headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' },
	body: JSON.stringify({ sessionId: 'session-a', enabled: false })
});
check('toggling off is accepted', disarmed.status === 200 && disarmed.json().enabled === false);
writeFileSync(join(repoA, 'later.txt'), 'later\n');
await hostA.emit('agent/turn-stopping', { agent: agentA, turn: 9 });
check('a disarmed session commits nothing', subjects(repoA).length === commitCount);
check('the uncommitted change is reported to the control', (await hostA.call({ url: '/dsh-autocommit/state?sessionId=session-a' })).json().dirty?.files === 1);

const status = await hostA.command('autocommit', { agent: agentA, rawInput: ' status' });
check('/autocommit status reports the armed state', status.kind === 'success' && status.text.includes('Auto-commit is off'), status.text.split('\n')[0]);
const on = await hostA.command('autocommit', { agent: agentA, rawInput: ' on' });
check('/autocommit on arms the repository', on.kind === 'success' && on.text.includes('Auto-commit is on'));
const now = await hostA.command('autocommit', { agent: agentA, rawInput: ' now' });
check('/autocommit now commits immediately', now.kind === 'success' && now.text.includes('Committed'), now.text);
check('the manual commit is labelled as one', subjects(repoA)[0] === 'dsh autocommit: manual commit', subjects(repoA)[0]);
const bogus = await hostA.command('autocommit', { agent: agentA, rawInput: ' sideways' });
check('an unknown argument explains the grammar', bogus.kind === 'error' && bogus.text.includes('on, off, now, or status'));
const idle = await hostA.command('autocommit', { agent: agentA, rawInput: ' now' });
check('committing nothing says so instead of failing silently', idle.kind === 'error' && idle.text.includes('Nothing to commit'), idle.text);

// A workspace inside a repository: only its own directory is committed.
const repoB = makeRepo('b');
const workspaceB = join(repoB, 'packages', 'app');
mkdirSync(workspaceB, { recursive: true });
writeFileSync(join(workspaceB, 'inside.txt'), 'inside\n');
git(repoB, ['add', '-A']);
git(repoB, ['commit', '--quiet', '-m', 'add package']);
const agentB = session('session-b', workspaceB);
const hostB = harness({ agents: [agentB], config: { subject: 'auto {summary} ({files} files)', enabled: true } });
writeFileSync(join(repoB, 'outside.txt'), 'outside\n');
writeFileSync(join(workspaceB, 'inside.txt'), 'inside changed\n');
await hostB.emit('agent/turn-stopping', { agent: agentB, turn: 1 });
check('the configured subject template is rendered', subjects(repoB)[0] === 'auto turn 1 (1 files)', subjects(repoB)[0]);
check('only the working directory is committed', git(repoB, ['status', '--porcelain']).includes('outside.txt'));
check('the workspace change is committed', !git(repoB, ['status', '--porcelain']).includes('inside.txt'));
check('enabled: true arms a repository without the control', (await hostB.call({ url: '/dsh-autocommit/state?sessionId=session-b' })).json().enabled === true);

// ---------------------------------------------------------------------------
section('Host: the guards');
// ---------------------------------------------------------------------------

// An unresolved merge is a state a machine must not "resolve" by committing.
const branchA = git(repoA, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
writeFileSync(join(repoA, 'conflict.txt'), 'ours\n');
git(repoA, ['add', '-A']);
git(repoA, ['commit', '--quiet', '-m', 'ours']);
git(repoA, ['checkout', '--quiet', '-b', 'other', 'HEAD~1']);
writeFileSync(join(repoA, 'conflict.txt'), 'theirs\n');
git(repoA, ['add', '-A']);
git(repoA, ['commit', '--quiet', '-m', 'theirs']);
git(repoA, ['checkout', '--quiet', branchA]);
let conflicted = false;
try {
	git(repoA, ['merge', '--no-edit', 'other']);
} catch {
	conflicted = true;
}
const unmergedNow = () => git(repoA, ['status', '--porcelain']).split('\n').some((line) => /^(?:DD|AU|UD|UA|DU|AA|UU) /.test(line));
check('the conflict fixture is in place', conflicted && unmergedNow(), git(repoA, ['status', '--porcelain']).trim());
const beforeConflictTurn = subjects(repoA).length;
await hostA.emit('agent/turn-stopping', { agent: agentA, turn: 10 });
check('an unresolved merge is not committed through', subjects(repoA).length === beforeConflictTurn);
check('the merge is explained to the control', (await hostA.call({ url: '/dsh-autocommit/state?sessionId=session-a' })).json().lastError?.message.includes('Unmerged') === true);
git(repoA, ['merge', '--abort']);
check('the repository is clean after the merge is abandoned', git(repoA, ['status', '--porcelain']).trim() === '');

// A repository at the home directory would commit the whole home.
const homeRepo = makeRepo('home-repo');
process.env.HOME = homeRepo;
const agentC = session('session-c', homeRepo);
const hostC = harness({ agents: [agentC], config: { enabled: true } });
writeFileSync(join(homeRepo, 'stray.txt'), 'stray\n');
await hostC.emit('agent/turn-stopping', { agent: agentC, turn: 1 });
const homeRefusal = (await hostC.call({ url: '/dsh-autocommit/state?sessionId=session-c' })).json();
process.env.HOME = originalHome;
check('a home-directory repository is refused', subjects(homeRepo).length === 1, subjects(homeRepo).join(' | '));
check('the refusal names the setting that changes it', homeRefusal.blocked?.includes('allowHomeRepo') === true, String(homeRefusal.blocked));

// A directory that is in no repository has nothing to arm.
const plain = join(scratch, 'plain');
mkdirSync(plain, { recursive: true });
const agentD = session('session-d', plain);
const hostD = harness({ agents: [agentD] });
const noRepo = await hostD.call({ url: '/dsh-autocommit/state?sessionId=session-d' });
check('a directory outside git reports no repository', noRepo.json().repo === null);
const refused = await hostD.call({
	method: 'POST',
	url: '/dsh-autocommit/toggle',
	headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' },
	body: JSON.stringify({ sessionId: 'session-d', enabled: true })
});
check('arming a directory outside git is refused with a reason', refused.status === 409 && refused.json().message.includes('No Git repository'), `status ${String(refused.status)}`);

// Subagents share their parent's directory and must not commit separately.
const agentE = session('session-e', repoA, { origin: 'subagent' });
const hostE = harness({ agents: [agentE], config: { enabled: true } });
writeFileSync(join(repoA, 'child.txt'), 'child\n');
const beforeChild = subjects(repoA).length;
await hostE.emit('agent/turn-stopping', { agent: agentE, turn: 1 });
check('a subagent session is not adopted', subjects(repoA).length === beforeChild);
rmSync(join(repoA, 'child.txt'));

// ---------------------------------------------------------------------------
section('Host: the HTTP surface');
// ---------------------------------------------------------------------------

const unknown = await hostA.call({ url: '/dsh-autocommit/state?sessionId=nope' });
check('an unknown session is 404', unknown.status === 404);
const crossOrigin = await hostA.call({
	method: 'POST',
	url: '/dsh-autocommit/toggle',
	headers: { origin: 'https://evil.example', host: '127.0.0.1:3080' },
	body: JSON.stringify({ sessionId: 'session-a', enabled: true })
});
check('a cross-origin write is refused', crossOrigin.status === 403, `status ${String(crossOrigin.status)}`);
const badBody = await hostA.call({
	method: 'POST',
	url: '/dsh-autocommit/toggle',
	headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' },
	body: JSON.stringify({ sessionId: 'session-a' })
});
check('a write without a boolean is 400', badBody.status === 400);
const notJson = await hostA.call({
	method: 'POST',
	url: '/dsh-autocommit/toggle',
	headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' },
	body: 'not json'
});
check('a body that is not JSON is 400', notJson.status === 400);
const wrongMethod = await hostA.call({ method: 'DELETE', url: '/dsh-autocommit/state' });
check('an unsupported method is 405', wrongMethod.status === 405);
const elsewhere = await hostA.call({ url: '/dsh-autocommit/nonsense' });
check('an unknown route under the prefix is 405, not a silent success', elsewhere.status === 405);
check('every response is JSON', unknown.headers['content-type'].startsWith('application/json'));

// ---------------------------------------------------------------------------
section('Host: the toggle survives a restart');
// ---------------------------------------------------------------------------

const restarted = harness({ agents: [session('session-f', repoA)] });
const restored = await restarted.call({ url: '/dsh-autocommit/state?sessionId=session-f' });
check('a second Host run reads the same toggle state', restored.json().enabled === true, String(restored.json().enabled));
check('the state file is valid JSON with a version', JSON.parse(readFileSync(join(fakeHome, 'auto-commit-button.json'), 'utf8')).version === 1);

// ---------------------------------------------------------------------------
section('Browser: the bundle registers a composer control');
// ---------------------------------------------------------------------------

/** A React stand-in: element records plus the three hooks the component uses. */
function createReactStub() {
	let slots = [];
	let cursor = 0;
	return {
		createElement(type, props, ...children) {
			const next = { ...(props ?? {}) };
			if (children.length === 1) next.children = children[0];
			else if (children.length > 1) next.children = children;
			return { type, props: next };
		},
		useSyncExternalStore(subscribe, getSnapshot) {
			const slot = (slots[cursor++] ??= {});
			slot.subscribe = subscribe;
			slot.getSnapshot = getSnapshot;
			return getSnapshot();
		},
		useEffect(effect) {
			const slot = (slots[cursor++] ??= {});
			slot.effect = effect;
		},
		/** Render once and run the effects, returning their cleanups. */
		render(component, props) {
			slots = [];
			cursor = 0;
			const tree = component(props);
			const cleanups = [];
			for (const slot of slots) {
				if (slot.effect === undefined) continue;
				const cleanup = slot.effect();
				if (typeof cleanup === 'function') cleanups.push(cleanup);
			}
			return { tree, cleanups, hooks: slots };
		}
	};
}

/** Find the first element of one type in a rendered tree. */
function findByType(node, type) {
	if (node === null || typeof node !== 'object') return null;
	if (node.type === type) return node;
	const children = node.props?.children;
	for (const child of Array.isArray(children) ? children : children === undefined ? [] : [children]) {
		const found = findByType(child, type);
		if (found !== null) return found;
	}
	return null;
}

/** Concatenate the text under one node. */
function textOf(node) {
	if (typeof node === 'string') return node;
	if (node === null || typeof node !== 'object') return '';
	const children = node.props?.children;
	const list = Array.isArray(children) ? children : children === undefined ? [] : [children];
	return list.map(textOf).join('');
}

const bundleSource = readFileSync(new URL('./client.js', import.meta.url), 'utf8');

/**
 * Load the client bundle the way the page does and mount it.
 * @param options - `state` answers the Host route; `fail` makes it unreachable.
 * @returns the registered slot entry, the render helper, and the request log.
 */
async function mountClient({ state = {}, fail = null } = {}) {
	const registrations = [];
	// eslint-disable-next-line no-new-func -- the bundle is a script, not a module.
	new Function('window', bundleSource)({ __ModuleLoader__: { load: (registration) => registrations.push(registration) } });
	const registration = registrations[0];
	const requests = [];
	globalThis.fetch = async (url, options = {}) => {
		requests.push({ url, method: options.method ?? 'GET', body: options.body === undefined ? null : JSON.parse(options.body) });
		if (fail !== null) throw new Error(fail);
		const payload = { sessionId: 'session-1', cwd: '/ws', gitAvailable: true, enabled: false, dirty: null, lastCommit: null, lastError: null, blocked: null, repo: { root: '/ws', name: 'ws', branch: 'main' }, ...state };
		if (options.method === 'POST' && state.toggled !== undefined) Object.assign(payload, state.toggled);
		return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
	};
	const react = createReactStub();
	const exports = registration.factory((specifier) => {
		if (specifier === 'react') return react;
		throw new Error(`the bundle required an unexpected module: ${specifier}`);
	});
	const dictionaries = [];
	const slots = [];
	const locale = {
		register: (namespace, dictionary) => {
			dictionaries.push({ namespace, dictionary });
			return () => {};
		},
		bind: () => (key, params) => {
			const template = dictionaries[0]?.dictionary.en[key] ?? key;
			return params === undefined ? template : template.replace(/\{([a-z]+)\}/gu, (match, name) => (name in params ? String(params[name]) : match));
		}
	};
	exports.apply({
		locale,
		slots: {
			inject: (name, callback) => callback(),
			register: (options, component) => {
				slots.push({ options, component });
				return () => {};
			}
		},
		effect: (callback) => {
			const disposer = callback();
			return () => {
				if (typeof disposer === 'function') disposer();
			};
		}
	});
	return { registration, exports, entry: slots[0], react, locale, requests, dictionaries };
}

const client = await mountClient();
check('the bundle registers the package id the loader expects', client.registration.id === 'dsh-plugin-auto-commit-button');
check('the plugin face is complete', client.exports.name === 'dsh-plugin-auto-commit-button' && typeof client.exports.apply === 'function');
check('the plugin waits for the services it uses', Array.isArray(client.exports.inject) && client.exports.inject.join(',') === 'slots,locale');
check('the control is registered in the composer tool row', client.entry?.options.name === 'conversation.input.left');
check('the control has a stable id and leads the row', client.entry?.options.id === 'auto-commit-button' && client.entry?.options.order === 10);
check('the control declares its dictionary namespace', client.entry?.options.locale === 'autocommit');
const dictionary = client.dictionaries[0]?.dictionary;
check('both dictionaries are registered', dictionary !== undefined && dictionary.en !== undefined && dictionary.zh !== undefined);
check('both dictionaries carry the same keys', dictionary !== undefined && Object.keys(dictionary.zh).every((key) => key in dictionary.en) && Object.keys(dictionary.en).length === Object.keys(dictionary.zh).length);

// ---------------------------------------------------------------------------
section('Browser: what the control renders and what a click sends');
// ---------------------------------------------------------------------------

/** Drive one mounted control through a state and return its rendered button. */
async function renderButton(options) {
	const mounted = await mountClient(options);
	const entry = mounted.entry;
	const injected = entry.options.inject('session-1');
	const stop = injected.store.start();
	await flush();
	stop();
	const { tree } = mounted.react.render(entry.component, { ...injected, t: mounted.locale.bind('autocommit') });
	const button = findByType(tree, 'button');
	return { mounted, injected, tree, button, wrap: findByType(tree, 'span'), title: tree.props.title, label: textOf(button) };
}

const off = await renderButton({ state: { enabled: false, dirty: { files: 2, unmerged: false } } });
check('a disarmed repository renders an unpressed toggle', off.button.props['aria-pressed'] === false && off.button.props['data-on'] === 'false');
check('the toggle is never disabled while it can work', off.button.props.disabled === false);
check('the label names the feature', off.label === 'Auto-commit', off.label);
check('the tooltip says what turning it on does', off.title.includes('Commit changes in ws after every turn'), off.title);
check('the tooltip carries the branch and the pending change count', off.title.includes('main · 2 uncommitted changes'), off.title);
check('the icon is decorative', findByType(off.button, 'svg')?.props['aria-hidden'] === true);

const armedRender = await renderButton({ state: { enabled: true, dirty: { files: 0, unmerged: false }, lastCommit: { short: 'abc1234', subject: 'dsh autocommit: turn 3', at: 1 } } });
check('an armed repository renders a pressed toggle', armedRender.button.props['aria-pressed'] === true && armedRender.button.props['data-on'] === 'true');
check('the tooltip states the armed behaviour', armedRender.title.includes('Auto-commit is on: changes in ws are committed after every turn'), armedRender.title);
check('the tooltip carries the last commit', armedRender.title.includes('Last commit: abc1234 dsh autocommit: turn 3'), armedRender.title);
check('a clean tree is spelled out', armedRender.title.includes('main · working tree clean'), armedRender.title);

const busy = await renderButton({ state: { enabled: true, busy: true } });
check('a commit in flight shows a spinner instead of the dot', findByType(busy.button, 'svg') !== null && busy.title.includes('Committing changes to ws'), busy.title);

const missingRepo = await renderButton({ state: { repo: null } });
check('a workspace outside git disables the control', missingRepo.button.props.disabled === true);
check('the tooltip says how to make it work', missingRepo.title.includes('Run git init in /ws'), missingRepo.title);

const noGit = await renderButton({ state: { gitAvailable: false } });
check('a Host without git disables the control', noGit.button.props.disabled === true && noGit.title.includes('needs Git installed'));

const unreachable = await renderButton({ fail: 'connection refused' });
check('an unreachable Host disables the control', unreachable.button.props.disabled === true);
check('the tooltip names the failure', unreachable.title.includes('connection refused'), unreachable.title);

const clickable = await renderButton({ state: { enabled: false, toggled: { enabled: true } } });
check('the control reads the state once on mount', clickable.mounted.requests[0].url === '/dsh-autocommit/state?sessionId=session-1');
clickable.button.props.onClick();
await flush();
const post = clickable.mounted.requests.find((request) => request.method === 'POST');
check('a click asks the Host to arm the repository', post?.url === '/dsh-autocommit/toggle' && post?.body.sessionId === 'session-1' && post?.body.enabled === true);
check('the Host answer becomes the control state', clickable.injected.store.getSnapshot().enabled === true);
check('the optimistic update is cleared by the answer', clickable.injected.store.getSnapshot().pending === null);

// ---------------------------------------------------------------------------
console.log(`\n${String(checks - failures)}/${String(checks)} checks passed`);
process.env.HOME = originalHome;
rmSync(scratch, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
