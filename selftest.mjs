/**
 * Offline harness for the auto-commit-button plugin.
 *
 * Two halves, tested the way each is actually used:
 *
 * 1. **Host** (`index.js`) — a fake Cordis context with only the services the
 *    plugin touches, driving real `git` against throwaway repositories in the
 *    temporary directory, including a bare repository standing in for a remote.
 *    The turn boundary, the switches, the HTTP routes the composer calls, the
 *    `/autocommit` command, the guards, and the persisted state are exercised
 *    end to end; the assertions read real commit history with `git log`, not
 *    the plugin's own bookkeeping.
 * 2. **Browser** (`client.js`) — the bundle is loaded exactly as the page loads
 *    it (`window.__ModuleLoader__.load`), its factory is materialized, and the
 *    registered control is rendered with a minimal hook runtime standing in for
 *    React (which has no copy on this machine). The trigger, the menu, its two
 *    switch rows, the keyboard routing, and the requests a click sends are all
 *    checked from the outside.
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

/** Subjects in a bare repository, used as the stand-in for a pushed remote. */
const remoteSubjects = (bare) =>
	execFileSync('git', ['--git-dir', bare, 'log', '--pretty=%s', '--all'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
		.split('\n')
		.filter(Boolean);

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
/** Path of the persisted switch file the plugin owns. */
const stateFile = () => join(fakeHome, 'auto-commit-button.json');

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

/** One live session, shaped the way the Host announces it. */
const session = (id, cwd, extra = {}) => ({ id, session: { header: { cwd, ...extra } } });

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

	const recordEffect = (callback, label) => {
		const disposer = callback();
		state.effects.push({ label, disposer });
		return () => {
			if (typeof disposer === 'function') disposer();
		};
	};

	const webCtx = {
		webServer: {
			register: (route) => {
				state.routes.set(route.path, route);
				return () => state.routes.delete(route.path);
			}
		},
		effect: recordEffect
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

	/** The same-origin headers a browser sends with the control's write. */
	const write = (url, body) => call({
		method: 'POST',
		url,
		headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080', 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});

	/** Read one session's state. */
	const read = async (sessionId) => (await call({ url: `/dsh-autocommit/state?sessionId=${sessionId}` })).json();

	/** Run one registered slash command. */
	const command = async (name, { agent, rawInput = '' } = {}) => {
		const definition = state.commands.get(name);
		if (definition === undefined) throw new Error(`/${name} is not registered`);
		return definition.handler({ agent, rawInput, commandId: 'selftest', attachments: [], signal: new AbortController().signal });
	};

	return { state, emit, call, write, read, command, webCtx };
}

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

const initial = await hostA.read('session-a');
check('a session in a repository reports that repository', initial.repo?.root === repoA, initial.repo?.root ?? 'null');
check('both switches start off', initial.commit === false && initial.push === false);
check('the legacy field mirrors the commit switch', initial.enabled === false);
check('git is reported available', initial.gitAvailable === true);
check('a clean tree reports no changes', initial.dirty?.files === 0);

const armed = await hostA.write('/dsh-autocommit/toggle', { sessionId: 'session-a', commit: true });
check('the commit switch can be set', armed.status === 200 && armed.json().commit === true, `status ${String(armed.status)}`);
check('the answer carries the switch pair', armed.json().push === false);
check('the switch is persisted next to DSH_HOME', readFileSync(stateFile(), 'utf8').includes(repoA));
check('the file records the new format', JSON.parse(readFileSync(stateFile(), 'utf8')).version === 2);

writeFileSync(join(repoA, 'feature.txt'), 'work\n');
await hostA.emit('agent/turn-stopping', { agent: agentA, turn: 7 });

check('the turn produced a commit', subjects(repoA)[0] === 'dsh autocommit: turn 7', subjects(repoA)[0]);
check('the commit body names the session', headBody(repoA).includes('session: session-a'));
check('the commit body counts the change', headBody(repoA).includes('changes: 1'));
check('the commit body lists the file', headBody(repoA).includes('feature.txt'));
check('the repository is clean after the commit', git(repoA, ['status', '--porcelain']).trim() === '');

const afterCommit = await hostA.read('session-a');
check('the control can show the commit it just made', afterCommit.lastCommit?.short.length === 7 && afterCommit.lastCommit?.subject === 'dsh autocommit: turn 7');
check('no error is reported after a good commit', afterCommit.lastError === null);

const commitCount = subjects(repoA).length;
await hostA.emit('agent/turn-stopping', { agent: agentA, turn: 8 });
check('a turn that changed nothing commits nothing', subjects(repoA).length === commitCount);

// ---------------------------------------------------------------------------
section('Host: the switches are independent, and push only follows a commit');
// ---------------------------------------------------------------------------

const pushOnly = await hostA.write('/dsh-autocommit/toggle', { sessionId: 'session-a', push: true });
check('a push-only write leaves the commit switch alone', pushOnly.json().commit === true && pushOnly.json().push === true);
const commitOff = await hostA.write('/dsh-autocommit/toggle', { sessionId: 'session-a', commit: false });
check('turning commits off keeps the push preference', commitOff.json().commit === false && commitOff.json().push === true);
writeFileSync(join(repoA, 'later.txt'), 'later\n');
await hostA.emit('agent/turn-stopping', { agent: agentA, turn: 9 });
check('a disarmed session commits nothing', subjects(repoA).length === commitCount);
check('the uncommitted change is reported to the control', (await hostA.read('session-a')).dirty?.files === 1);

const status = await hostA.command('autocommit', { agent: agentA, rawInput: ' status' });
check('/autocommit status reports both switches', status.kind === 'success' && status.text.includes('Auto-commit is off') && status.text.includes('Auto-push is on'), status.text.split('\n')[1]);
const on = await hostA.command('autocommit', { agent: agentA, rawInput: ' on' });
check('/autocommit on arms commits and leaves push alone', on.kind === 'success' && on.text.includes('Auto-commit is on') && on.text.includes('Auto-push is on'));
const now = await hostA.command('autocommit', { agent: agentA, rawInput: ' now' });
check('/autocommit now commits immediately', now.kind === 'success' && now.text.includes('Committed'), now.text);
check('the manual commit is labelled as one', subjects(repoA)[0] === 'dsh autocommit: manual commit', subjects(repoA)[0]);
check('a push with no remote fails without losing the commit', (await hostA.read('session-a')).lastError?.message.includes('push failed') === true, String((await hostA.read('session-a')).lastError?.message));
const pushOff = await hostA.command('autocommit', { agent: agentA, rawInput: ' push off' });
check('/autocommit push off clears the push switch', pushOff.kind === 'success' && pushOff.text.includes('Auto-push is off'));
const bogus = await hostA.command('autocommit', { agent: agentA, rawInput: ' sideways' });
check('an unknown argument explains the grammar', bogus.kind === 'error' && bogus.text.includes('push on'));
const idle = await hostA.command('autocommit', { agent: agentA, rawInput: ' now' });
check('committing nothing says so instead of failing silently', idle.kind === 'error' && idle.text.includes('Nothing to commit'), idle.text);

// A real remote: the push switch must land the commit on it.
const remoteDir = join(scratch, 'remote.git');
mkdirSync(remoteDir, { recursive: true });
git(remoteDir, ['init', '--bare', '--quiet']);
const repoP = makeRepo('pushy');
const branchP = git(repoP, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
git(repoP, ['remote', 'add', 'origin', remoteDir]);
git(repoP, ['push', '--quiet', '--set-upstream', 'origin', branchP]);
const agentP = session('session-p', repoP);
const hostP = harness({ agents: [agentP] });
await hostP.write('/dsh-autocommit/toggle', { sessionId: 'session-p', commit: true, push: true });
writeFileSync(join(repoP, 'pushed.txt'), 'pushed\n');
await hostP.emit('agent/turn-stopping', { agent: agentP, turn: 1 });
const pushedState = await hostP.read('session-p');
check('a push-enabled turn commits locally', subjects(repoP)[0] === 'dsh autocommit: turn 1', subjects(repoP)[0]);
check('the commit reached the remote', remoteSubjects(remoteDir).includes('dsh autocommit: turn 1'), remoteSubjects(remoteDir).join(' | '));
check('the answer reports the push', pushedState.lastPush?.short === pushedState.lastCommit?.short);
check('a successful push leaves no error', pushedState.lastError === null);

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
check('enabled: true seeds the commit switch', (await hostB.read('session-b')).commit === true);

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
check('the merge is explained to the control', (await hostA.read('session-a')).lastError?.message.includes('Unmerged') === true);
git(repoA, ['merge', '--abort']);
check('the repository is clean after the merge is abandoned', git(repoA, ['status', '--porcelain']).trim() === '');

// A repository at the home directory would commit the whole home.
const homeRepo = makeRepo('home-repo');
process.env.HOME = homeRepo;
const agentC = session('session-c', homeRepo);
const hostC = harness({ agents: [agentC], config: { enabled: true } });
writeFileSync(join(homeRepo, 'stray.txt'), 'stray\n');
await hostC.emit('agent/turn-stopping', { agent: agentC, turn: 1 });
const homeRefusal = await hostC.read('session-c');
process.env.HOME = originalHome;
check('a home-directory repository is refused', subjects(homeRepo).length === 1, subjects(homeRepo).join(' | '));
check('the refusal names the setting that changes it', homeRefusal.blocked?.includes('allowHomeRepo') === true, String(homeRefusal.blocked));

// A directory that is in no repository has nothing to switch.
const plain = join(scratch, 'plain');
mkdirSync(plain, { recursive: true });
const agentD = session('session-d', plain);
const hostD = harness({ agents: [agentD] });
const noRepo = await hostD.read('session-d');
check('a directory outside git reports no repository', noRepo.repo === null);
const refused = await hostD.write('/dsh-autocommit/toggle', { sessionId: 'session-d', commit: true });
check('switching a directory outside git is refused with a reason', refused.status === 409 && refused.json().message.includes('No Git repository'), `status ${String(refused.status)}`);

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
	body: JSON.stringify({ sessionId: 'session-a', commit: true })
});
check('a cross-origin write is refused', crossOrigin.status === 403, `status ${String(crossOrigin.status)}`);
const emptyWrite = await hostA.write('/dsh-autocommit/toggle', { sessionId: 'session-a' });
check('a write with no switch is 400', emptyWrite.status === 400);
const legacyWrite = await hostA.write('/dsh-autocommit/toggle', { sessionId: 'session-a', enabled: false });
check('the pre-menu field name still works', legacyWrite.status === 200 && legacyWrite.json().commit === false);
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
section('Host: the switches survive a restart, and an older file still reads');
// ---------------------------------------------------------------------------

const restarted = harness({ agents: [session('session-f', repoP)] });
const restored = await restarted.read('session-f');
check('a second Host run reads the same switch pair', restored.commit === true && restored.push === true, `commit=${String(restored.commit)} push=${String(restored.push)}`);
check('a write from one instance keeps the switches of another', readFileSync(stateFile(), 'utf8').includes(repoA));

// Version 1 stored one boolean: the commit switch.
const migratedHome = join(scratch, 'home-v1');
mkdirSync(migratedHome, { recursive: true });
writeFileSync(join(migratedHome, 'auto-commit-button.json'), `${JSON.stringify({ version: 1, repos: { [repoB]: true } })}\n`);
process.env.DSH_HOME = migratedHome;
const migrated = harness({ agents: [session('session-g', repoB)] });
const migratedState = await migrated.read('session-g');
check('a version 1 file still means "commits on"', migratedState.commit === true);
check('a version 1 file carries no push preference', migratedState.push === false);
await migrated.write('/dsh-autocommit/toggle', { sessionId: 'session-g', push: true });
const rewritten = JSON.parse(readFileSync(join(migratedHome, 'auto-commit-button.json'), 'utf8'));
check('saving after the migration writes the new format', rewritten.version === 2 && rewritten.repos[repoB].push === true, JSON.stringify(rewritten.repos[repoB]));
process.env.DSH_HOME = fakeHome;

// ---------------------------------------------------------------------------
section('Browser: the bundle registers a composer control');
// ---------------------------------------------------------------------------

/** A React stand-in: element records plus the hooks the control uses. */
function createReactStub() {
	let instance = null;
	const api = {
		createElement(type, props, ...children) {
			const next = { ...(props ?? {}) };
			if (children.length === 1) next.children = children[0];
			else if (children.length > 1) next.children = children;
			return { type, props: next };
		},
		useSyncExternalStore(subscribe, getSnapshot) {
			const hook = (instance.hooks[instance.cursor++] ??= {});
			hook.subscribe = subscribe;
			hook.getSnapshot = getSnapshot;
			return getSnapshot();
		},
		useState(initial) {
			const hook = (instance.hooks[instance.cursor++] ??= { value: typeof initial === 'function' ? initial() : initial });
			if (hook.set === undefined) {
				hook.set = (next) => {
					const value = typeof next === 'function' ? next(hook.value) : next;
					if (value === hook.value) return;
					hook.value = value;
					instance.dirty = true;
				};
			}
			return [hook.value, hook.set];
		},
		useRef(initial) {
			const hook = (instance.hooks[instance.cursor++] ??= { ref: { current: initial } });
			return hook.ref;
		},
		useEffect(effect) {
			const hook = (instance.hooks[instance.cursor++] ??= {});
			hook.effect = effect;
		},
		/** Mount one component instance. */
		mount(component, props) {
			instance = { component, props, hooks: [], cursor: 0, dirty: false, tree: null };
			return api.flush();
		},
		/** Re-render until no hook asked for another pass. */
		flush() {
			let guard = 0;
			do {
				instance.dirty = false;
				instance.cursor = 0;
				instance.tree = instance.component(instance.props);
				for (const hook of instance.hooks) {
					if (hook.effect === undefined || hook.ran === true) continue;
					hook.ran = true;
					hook.cleanup = hook.effect();
				}
			} while (instance.dirty && (guard += 1) < 25);
			return instance.tree;
		},
		/** Run one event handler, then settle the re-render it caused. */
		act(handler) {
			handler();
			return api.flush();
		},
		/** The tree as it stands after the latest render. */
		current: () => instance.tree
	};
	return api;
}

/** Every element in a tree matching a predicate, in document order. */
function collect(node, predicate, found = []) {
	if (Array.isArray(node)) {
		for (const child of node) collect(child, predicate, found);
		return found;
	}
	if (node === null || typeof node !== 'object') return found;
	if (predicate(node)) found.push(node);
	const children = node.props?.children;
	for (const child of Array.isArray(children) ? children : children === undefined ? [] : [children]) collect(child, predicate, found);
	return found;
}

/** Every element with one role. */
const byRole = (tree, role) => collect(tree, (node) => node.props?.role === role);

/** The first element of one type. */
const byType = (tree, type) => collect(tree, (node) => node.type === type)[0] ?? null;

/** Concatenate the text under one node. */
function textOf(node) {
	if (typeof node === 'string') return node;
	if (node === null || typeof node !== 'object') return '';
	const children = node.props?.children;
	const list = Array.isArray(children) ? children : children === undefined ? [] : [children];
	return list.map(textOf).join('');
}

/** Minimal `react-dom`, so the bundle's portal import resolves. */
const reactDomStub = { createPortal: (node) => node };

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
		const payload = {
			sessionId: 'session-1',
			cwd: '/ws',
			gitAvailable: true,
			commit: false,
			push: false,
			dirty: null,
			lastCommit: null,
			lastPush: null,
			lastError: null,
			blocked: null,
			repo: { root: '/ws', name: 'ws', branch: 'main' },
			...state
		};
		if (options.method === 'POST' && state.answer !== undefined) Object.assign(payload, state.answer);
		return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
	};
	const react = createReactStub();
	const exports = registration.factory((specifier) => {
		if (specifier === 'react') return react;
		if (specifier === 'react-dom') return reactDomStub;
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

/**
 * Mount the control, settle its first read, and render it.
 * @param options - the Host state the fake route answers with.
 * @returns the rendered pieces and the drivers the assertions use.
 */
async function mountControl(options = {}) {
	const mounted = await mountClient(options);
	const injected = mounted.entry.options.inject('session-1');
	const stop = injected.store.start();
	await flush();
	stop();
	const t = mounted.locale.bind('autocommit');
	mounted.react.mount(mounted.entry.component, { ...injected, t });
	// Read every query from the stub's live tree: a handler the test invokes
	// directly renders a new tree, and a captured one would go stale.
	const current = () => mounted.react.current();
	const trigger = () => byType(current(), 'button');
	/** Open the menu the way a click does. */
	const openMenu = () => {
		mounted.react.act(() => trigger().props.onClick());
		return current();
	};
	return {
		mounted,
		injected,
		t,
		current,
		trigger,
		openMenu,
		/** Re-render from the store after an awaited request settles. */
		settle: () => mounted.react.flush(),
		menu: () => byRole(current(), 'menu')[0] ?? null,
		rows: () => byRole(current(), 'menuitemcheckbox')
	};
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
section('Browser: the trigger opens a menu of two switches');
// ---------------------------------------------------------------------------

const disarmed = await mountControl({ state: { commit: false, dirty: { files: 2, unmerged: false } } });
check('the trigger is a menu button, not a plain toggle', disarmed.trigger().props['aria-haspopup'] === 'menu');
check('the menu starts closed', disarmed.trigger().props['aria-expanded'] === false && disarmed.menu() === null);
check('the trigger names the feature', textOf(disarmed.trigger()) === 'Auto-commit', textOf(disarmed.trigger()));
check('the trigger is reachable by an accessible name', disarmed.trigger().props['aria-label'] === 'Auto-commit settings');
check('the tooltip states the off state', disarmed.trigger().props.title.includes('Auto-commit is off for ws (main).'), disarmed.trigger().props.title);

disarmed.openMenu();
check('clicking the trigger opens the menu', disarmed.trigger().props['aria-expanded'] === true && disarmed.menu() !== null);
check('the menu is a labelled menu', disarmed.menu().props.role === 'menu' && disarmed.menu().props['aria-label'] === 'Auto-commit settings');
check('the menu anchors itself to the trigger', String(disarmed.menu().props.style?.bottom ?? '').length > 0, JSON.stringify(disarmed.menu().props.style ?? null));
check('the menu offers exactly two switches', disarmed.rows().length === 2);
const [commitRow, pushRow] = disarmed.rows();
check('the first row is the commit switch', textOf(commitRow) === 'Auto-commitCommit this workspace after every turn', textOf(commitRow));
check('the commit switch reports itself unchecked', commitRow.props['aria-checked'] === false);
check('the second row is the push switch', textOf(pushRow).startsWith('Auto-push'), textOf(pushRow));
check('push is disabled while commits are off', pushRow.props['aria-disabled'] === true);
check('the disabled row says how to enable it', textOf(pushRow).includes('Turn on Auto-commit first'), textOf(pushRow));
check('the open row is the only tab stop', disarmed.rows().filter((row) => row.props.tabIndex === 0).length === 1);
check('the footer reports the workspace', textOf(disarmed.menu()).includes('main · 2 uncommitted changes'), textOf(disarmed.menu()));

disarmed.mounted.react.act(() => commitRow.props.onClick());
await flush();
disarmed.settle();
const armRequest = disarmed.mounted.requests.find((request) => request.method === 'POST');
check('clicking the commit row writes both switches', armRequest?.url === '/dsh-autocommit/toggle' && armRequest?.body.commit === true && armRequest?.body.push === false, JSON.stringify(armRequest?.body ?? null));
check('the menu stays open after a switch', disarmed.menu() !== null);

const menuArmed = await mountControl({ state: { commit: true, push: false, dirty: { files: 0, unmerged: false }, lastCommit: { short: '5251968', subject: 'dsh autocommit: turn 4', at: 1 }, lastPush: { short: '5251968', at: 2 } } });
check('an armed repository paints the trigger', menuArmed.trigger().props['data-on'] === 'true');
menuArmed.openMenu();
const [armedCommit, armedPush] = menuArmed.rows();
check('the commit row is checked', armedCommit.props['aria-checked'] === true);
check('push becomes selectable once commits are on', armedPush.props['aria-disabled'] === undefined);
check('the push row explains what it does', textOf(armedPush).includes('Push each commit to the remote'), textOf(armedPush));
check('the footer reports the last commit and its push', textOf(menuArmed.menu()).includes('Last commit: 5251968 dsh autocommit: turn 4 · pushed'), textOf(menuArmed.menu()));

menuArmed.mounted.react.act(() => armedPush.props.onClick());
await flush();
menuArmed.settle();
const pushRequest = menuArmed.mounted.requests.find((request) => request.method === 'POST');
check('clicking the push row writes only that switch', pushRequest?.body.commit === true && pushRequest?.body.push === true, JSON.stringify(pushRequest?.body ?? null));

const keyboard = await mountControl({ state: { commit: true } });
keyboard.openMenu();
check('the first row holds the tab stop when the menu opens', keyboard.rows()[0].props.tabIndex === 0);
keyboard.mounted.react.act(() => keyboard.menu().props.onKeyDown({ key: 'ArrowDown', preventDefault() {} }));
check('ArrowDown moves the tab stop to the next row', keyboard.rows()[1].props.tabIndex === 0 && keyboard.rows()[0].props.tabIndex === -1);
keyboard.mounted.react.act(() => keyboard.menu().props.onKeyDown({ key: 'ArrowUp', preventDefault() {} }));
check('ArrowUp wraps back to the first row', keyboard.rows()[0].props.tabIndex === 0);
keyboard.mounted.react.act(() => keyboard.menu().props.onKeyDown({ key: 'Escape', stopPropagation() {} }));
check('Escape closes the menu', keyboard.menu() === null && keyboard.trigger().props['aria-expanded'] === false);

// ---------------------------------------------------------------------------
section('Browser: the states where the menu explains itself');
// ---------------------------------------------------------------------------

const busy = await mountControl({ state: { commit: true, busy: true } });
check('a commit in flight reports itself', busy.trigger().props.title.includes('Committing changes to ws'), busy.trigger().props.title);
check('the trigger shows a spinner while committing', collect(busy.trigger(), (node) => node.props?.className === 'dsh-autocommit-spinner').length === 1);

const missingRepo = await mountControl({ state: { repo: null } });
missingRepo.openMenu();
check('a workspace outside git disables both rows', missingRepo.rows().every((row) => row.props['aria-disabled'] === true));
check('the menu says how to make it work', textOf(missingRepo.menu()).includes('Run git init in /ws'), textOf(missingRepo.menu()));

const noGit = await mountControl({ state: { gitAvailable: false } });
noGit.openMenu();
check('a Host without git explains itself in the menu', textOf(noGit.menu()).includes('needs Git installed'), textOf(noGit.menu()));

const unreachable = await mountControl({ fail: 'connection refused' });
check('an unreachable Host is reported on the trigger', unreachable.trigger().props.title.includes('connection refused'), unreachable.trigger().props.title);
unreachable.openMenu();
check('an unreachable Host disables both rows', unreachable.rows().every((row) => row.props['aria-disabled'] === true));

const failing = await mountControl({ state: { commit: true, lastError: { message: 'git commit failed: nothing to commit', at: 1 } } });
failing.openMenu();
check('a failed commit is shown in the menu', textOf(failing.menu()).includes('The last auto-commit failed: git commit failed'), textOf(failing.menu()));
check('a failure is also cued on the trigger', collect(failing.trigger(), (node) => node.props?.className === 'dsh-autocommit-dot').length === 1);

const blockedPush = await mountControl({ state: { commit: false } });
blockedPush.openMenu();
blockedPush.mounted.react.act(() => blockedPush.rows()[1].props.onClick());
await flush();
check('clicking a disabled row sends nothing', blockedPush.mounted.requests.filter((request) => request.method === 'POST').length === 0);
check('a disabled row is not tabbable', blockedPush.rows()[1].props.tabIndex === -1);

// ---------------------------------------------------------------------------
console.log(`\n${String(checks - failures)}/${String(checks)} checks passed`);
process.env.HOME = originalHome;
rmSync(scratch, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
