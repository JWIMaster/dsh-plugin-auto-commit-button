/**
 * dsh-plugin-auto-commit-button — the Host half.
 *
 * One switch pair in the composer arms automatic Git commits — and optionally
 * pushes — for the repository that holds this session's working directory. At
 * every `agent/turn-stopping` boundary — the point where the model owes no
 * further output — the plugin stages what changed under the working directory
 * and commits it, so the work an agent did is in history as soon as the turn
 * ends instead of waiting for someone to remember.
 *
 * Behaviour
 * ---------
 * 1. A session's working directory is resolved against Git once, and cached;
 *    a directory that is in no repository has nothing to switch, and the
 *    composer control explains that instead of offering a switch that cannot
 *    work.
 * 2. The two switches are properties of the *repository*, not of one session:
 *    every session whose working directory is inside that repository sees the
 *    same pair, and the pair survives a Host restart because it is written to
 *    `$DSH_HOME/auto-commit-button.json`. `commit` decides whether a finished
 *    turn commits at all; `push` decides whether a commit is then pushed, and
 *    the two are stored independently so turning commits off and on again does
 *    not forget the push preference.
 * 3. `scope: workspace` (the default) commits only what changed under the
 *    session's working directory; `scope: repo` commits the repository. The
 *    narrower default is what keeps a workspace that is one package of a large
 *    repository from sweeping up everybody else's unfinished work.
 * 4. Nothing is committed while a merge is unresolved, and a repository whose
 *    root is the home directory or a filesystem root is refused outright: those
 *    are the two ways an "automatic" commit does real damage.
 *
 * Design notes
 * ------------
 * - No dependencies: the Host is reached only through Cordis services
 *   (`agents`, optional `commands` and `webServer`) and Node built-ins, so the
 *   bundle resolves in a profile whose `node_modules` does not contain the
 *   Harness packages.
 * - Git runs through `execFile` with an explicit timeout and
 *   `GIT_TERMINAL_PROMPT=0`, so a missing credential can never leave a turn
 *   waiting on a prompt.
 * - The turn boundary awaits the commit, so the panel shows the commit before
 *   the turn closes. Every failure is recorded on the session and reported to
 *   the composer and to the log; none of them throw into the turn.
 * - The browser talks to this half over two same-origin JSON routes under
 *   `/dsh-autocommit`; POSTs are refused unless their `Origin` matches the
 *   request's `Host`.
 */

import { execFile, execFileSync } from 'node:child_process';
import { accessSync, appendFileSync, constants, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';

/** Stable Cordis plugin name, which is also the client bundle's module id. */
export const name = 'dsh-plugin-auto-commit-button';

/** Services that must exist before the plugin can watch sessions. */
export const inject = ['agents'];

/** Path prefix the browser half calls. */
const ROUTE_PREFIX = '/dsh-autocommit';
/** Largest accepted request body; the toggle payload is tiny. */
const MAX_BODY_BYTES = 16384;
/** Porcelain status codes that mean "this path needs a human". */
const UNMERGED = /^(?:DD|AU|UD|UA|DU|AA|UU)$/u;
/** Bytes of Git output retained per command. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * Defaults; every one of them can be overridden by the patch row's `config`.
 *
 * `scope` and the two guards are deliberately conservative. An automatic
 * commit is a write nobody reviews, so the default is the smallest change that
 * still captures the turn's work.
 */
const DEFAULTS = {
	// What a repository that was never switched in the composer does. The
	// persisted per-repository pair wins over both of these.
	enabled: false,
	// 'workspace' stages the session's working directory; 'repo' stages the repository.
	scope: 'workspace',
	push: false,
	noVerify: false,
	subject: 'dsh autocommit: {summary}',
	// Pathspecs never staged, e.g. ['CURRENT_PROGRESS.md'].
	exclude: [],
	maxFilesListed: 24,
	timeoutMs: 20000,
	pushTimeoutMs: 60000,
	allowHomeRepo: false,
	statusTtlMs: 3000,
	traceFile: ''
};

/**
 * Mount the plugin.
 * @param ctx - Host plugin context.
 * @param config - optional `config` object from the bundle patch row.
 */
export function apply(ctx, config = {}) {
	const cfg = resolveConfig(config, warn);
	/** Live sessions, keyed by session id. */
	const sessions = new Map();
	/** Repository root → the stored switch pair. The whole switchable surface. */
	const toggles = loadToggles();
	/** Resolved once: the Xcode stub on macOS must not be executed. */
	const gitPath = resolveGitExecutable();
	/** Aborted when the plugin unloads, so in-flight Git work stops being used. */
	const lifetime = new AbortController();

	/** Log one warning without letting logging itself break a session. */
	function warn(message) {
		const logger = ctx.logger ?? console;
		try {
			(logger.warn ?? console.warn).call(logger, `${name}: ${message}`);
		} catch {
			/* logging must never break a session */
		}
	}

	/** Log one ordinary line, for the decisions worth keeping in the Host log. */
	function note(message) {
		const logger = ctx.logger ?? console;
		try {
			(logger.info ?? console.log).call(logger, `${name}: ${message}`);
		} catch {
			/* ignore */
		}
	}

	// ---------------------------------------------------------------- sessions

	/**
	 * Register one live agent when it is a real session.
	 *
	 * Subagent sessions are skipped: their turns end at the same boundary, and
	 * a child that shares its parent's directory must not commit separately.
	 *
	 * @param agent - live agent announced by the registry.
	 * @param source - why this runtime was created (diagnostics only).
	 */
	const adopt = (agent, source) => {
		const header = agent?.session?.header;
		if (header === undefined || header === null) return;
		if (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0) return;
		const cwd = header.cwd;
		if (typeof cwd !== 'string' || cwd.length === 0) return;
		const previous = sessions.get(agent.id);
		if (previous !== undefined && previous.cwd === cwd) return;
		sessions.set(agent.id, {
			sessionId: agent.id,
			cwd,
			busy: null,
			repo: null,
			repoCheckedAt: 0,
			dirty: null,
			lastCommit: null,
			lastPush: null,
			lastError: null
		});
		trace(cfg, agent.id, `adopted (${source}) cwd=${cwd}`);
	};

	ctx.effect(() => {
		const offs = [
			ctx.on('agent/created', ({ agent, source }) => adopt(agent, source ?? 'created')),
			ctx.on('agent/disposed', ({ agent }) => sessions.delete(agent.id))
		];
		// A plugin (re)loaded while sessions are already live adopts them, so the
		// control works without waiting for the next session.
		for (const agent of ctx.agents.list()) adopt(agent, 'startup');
		return () => {
			for (const off of offs) {
				try {
					off();
				} catch (error) {
					warn(`could not remove a session registration: ${describe(error)}`);
				}
			}
			lifetime.abort(new Error('plugin unloaded'));
		};
	}, `${name}: session registry`);

	// ------------------------------------------------------------ turn boundary

	ctx.effect(() => ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
		const record = sessions.get(agent?.id);
		if (record === undefined) return;
		try {
			const repo = await resolveRepo(record, false);
			if (!switchesFor(record, repo).commit) return;
			await commitNow(record, { turn, trigger: 'turn' });
		} catch (error) {
			// The turn boundary is serial: a throw here would be the plugin's fault,
			// not the session's, so it is reported and swallowed.
			warn(`turn ${String(turn)} could not be committed: ${describe(error)}`);
		}
	}), `${name}: turn boundary`);

	// ----------------------------------------------------------------- switches

	/**
	 * The two switches in force for one session's repository.
	 *
	 * `commit` decides whether a finished turn commits at all; `push` decides
	 * whether a commit is then pushed. A repository's stored pair wins over the
	 * profile defaults, and the two are stored independently so turning commits
	 * off and on again does not silently forget the push preference.
	 *
	 * @param record - the session.
	 * @param repo - its resolved repository, or null.
	 * @returns the effective pair.
	 */
	function switchesFor(record, repo) {
		const stored = repo === null ? undefined : toggles.get(repo.root);
		return {
			commit: stored?.commit ?? cfg.enabled,
			push: stored?.push ?? cfg.push
		};
	}

	/**
	 * Set either switch for one session's repository and persist the pair.
	 * @param record - the session whose repository is being changed.
	 * @param patch - `commit` and/or `push`; omitted members keep their value.
	 * @returns whether the change was accepted, with the reason when it was not.
	 */
	async function setSwitches(record, patch) {
		const repo = await resolveRepo(record, false);
		if (repo === null) return { ok: false, message: `No Git repository contains ${record.cwd}.` };
		const blocked = repoBlocked(repo.root);
		if (blocked !== null) return { ok: false, message: blocked };
		const current = switchesFor(record, repo);
		const next = {
			commit: typeof patch.commit === 'boolean' ? patch.commit : current.commit,
			push: typeof patch.push === 'boolean' ? patch.push : current.push
		};
		toggles.set(repo.root, next);
		saveToggles(toggles);
		note(`${repo.root}: commit=${String(next.commit)} push=${String(next.push)}`);
		return { ok: true };
	}

	// --------------------------------------------------------------------- git

	/**
	 * Run one Git command.
	 * @param args - arguments after the executable.
	 * @param cwd - directory the command runs in.
	 * @param timeoutMs - milliseconds before the child is killed.
	 * @returns stdout, stderr, and whether the command exited zero.
	 */
	function runGit(args, cwd, timeoutMs) {
		return new Promise((resolvePromise) => {
			execFile(gitPath ?? 'git', args, {
				cwd,
				timeout: timeoutMs,
				maxBuffer: MAX_OUTPUT_BYTES,
				windowsHide: true,
				env: {
					...process.env,
					// A missing credential must fail the command, never wait for a prompt.
					GIT_TERMINAL_PROMPT: '0',
					// `status` refreshing the index is what leaves lock files behind.
					GIT_OPTIONAL_LOCKS: '0'
				}
			}, (error, stdout, stderr) => {
				resolvePromise({ ok: error === null, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error });
			});
		});
	}

	/**
	 * Read a Git failure as the one line a person needs.
	 * @param result - what {@link runGit} returned.
	 * @returns a single-line message.
	 */
	function failureText(result) {
		const text = (result.stderr.trim().length > 0 ? result.stderr : result.stdout)
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.slice(0, 2)
			.join(' ');
		if (text.length > 0) return text.slice(0, 300);
		return describe(result.error ?? 'git failed');
	}

	/**
	 * Resolve the repository holding one session, with a short cache.
	 * @param record - the session.
	 * @param refresh - whether to ignore the cached answer.
	 * @returns the repository, or null when the directory is in none.
	 */
	async function resolveRepo(record, refresh) {
		const now = Date.now();
		if (!refresh && record.repoCheckedAt !== 0 && now - record.repoCheckedAt < cfg.statusTtlMs) return record.repo;
		record.repoCheckedAt = now;
		if (gitPath === null) {
			record.repo = null;
			return null;
		}
		const top = await runGit(['rev-parse', '--show-toplevel'], record.cwd, cfg.timeoutMs);
		const root = top.ok ? top.stdout.trim() : '';
		if (root.length === 0) {
			record.repo = null;
			return null;
		}
		const branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], root, cfg.timeoutMs);
		record.repo = { root, name: basename(root), branch: branch.ok ? branch.stdout.trim() : '' };
		trace(cfg, record.sessionId, `repository ${record.repo.root} branch=${record.repo.branch}`);
		return record.repo;
	}

	/**
	 * Whether a repository is one this plugin refuses to commit on its own.
	 * @param root - resolved repository root.
	 * @returns the reason, or null when the repository is acceptable.
	 */
	function repoBlocked(root) {
		if (cfg.allowHomeRepo) return null;
		if (root === homedir()) return `Refusing to auto-commit ${root}: that is your home directory. Set allowHomeRepo to allow it.`;
		if (dirname(root) === root) return `Refusing to auto-commit ${root}: that is a filesystem root. Set allowHomeRepo to allow it.`;
		return null;
	}

	/** Directory a command stages from: the workspace, or the whole repository. */
	const scopeCwd = (record, repo) => (cfg.scope === 'repo' ? repo.root : record.cwd);

	/**
	 * Read porcelain status for one directory.
	 * @param cwd - directory to read.
	 * @returns the change count and whether unmerged paths are present, or null.
	 */
	async function readStatus(cwd) {
		const result = await runGit(['status', '--porcelain', '--untracked-files=all'], cwd, cfg.timeoutMs);
		if (!result.ok) return null;
		const lines = result.stdout.split('\n').filter((line) => line.length > 0);
		return { files: lines.length, unmerged: lines.some((line) => UNMERGED.test(line.slice(0, 2))) };
	}

	/**
	 * Parse `git diff --cached --name-status -z --no-renames`.
	 * @param text - NUL-separated status/path pairs.
	 * @returns one entry per staged path.
	 */
	function parseNameStatus(text) {
		const parts = text.split('\0').filter((part) => part.length > 0);
		const files = [];
		for (let index = 0; index + 1 < parts.length; index += 2) {
			files.push({ status: parts[index], path: parts[index + 1] });
		}
		return files;
	}

	/**
	 * Commit now, or join the commit already running for this session.
	 * @param record - the session.
	 * @param options - the turn being closed, and what asked for the commit.
	 * @returns a description of what happened.
	 */
	function commitNow(record, options) {
		if (record.busy !== null) return record.busy;
		const task = runCommit(record, options)
			.catch((error) => {
				warn(`commit failed: ${describe(error)}`);
				return fail(record, describe(error));
			})
			.finally(() => {
				record.busy = null;
				record.repoCheckedAt = 0;
			});
		record.busy = task;
		return task;
	}

	/**
	 * Record one failure on the session, for the composer control to show.
	 * @param record - the session.
	 * @param message - what went wrong, in the words the UI will show.
	 * @returns the outcome handed back to the caller.
	 */
	function fail(record, message) {
		record.lastError = { message, at: Date.now() };
		return { kind: 'failed', message };
	}

	/**
	 * Stage and commit one session's directory.
	 * @param record - the session.
	 * @param options - `turn` when a turn closed, `trigger` for diagnostics.
	 * @returns the outcome: `committed`, `clean`, `blocked`, or `failed`.
	 */
	async function runCommit(record, { turn, trigger }) {
		if (lifetime.signal.aborted) return { kind: 'blocked', message: 'The plugin is unloading.' };
		if (gitPath === null) return fail(record, 'Git is not installed, or it is not on PATH.');
		const repo = await resolveRepo(record, true);
		if (repo === null) return fail(record, `No Git repository contains ${record.cwd}.`);
		const blocked = repoBlocked(repo.root);
		if (blocked !== null) return fail(record, blocked);

		const cwd = scopeCwd(record, repo);
		const status = await readStatus(cwd);
		if (status !== null && status.unmerged) {
			return fail(record, 'Unmerged paths are present. Resolve the merge, then commit.');
		}

		const pathspecs = ['--', '.', ...cfg.exclude.map((entry) => `:(exclude)${entry}`)];
		const added = await runGit(['add', '-A', ...pathspecs], cwd, cfg.timeoutMs);
		if (!added.ok) return fail(record, `git add failed: ${failureText(added)}`);

		const staged = await runGit(['diff', '--cached', '--name-status', '-z', '--no-renames'], cwd, cfg.timeoutMs);
		if (!staged.ok) return fail(record, `git diff failed: ${failureText(staged)}`);
		const files = parseNameStatus(staged.stdout);
		if (files.length === 0) {
			record.lastError = null;
			record.dirty = { files: 0, unmerged: false };
			trace(cfg, record.sessionId, `trigger=${trigger} nothing staged`);
			return { kind: 'clean', message: 'Nothing to commit.' };
		}

		const message = composeMessage(record, repo, files, turn);
		const commitArgs = ['commit', '--message', message.subject, '--message', message.body];
		if (cfg.noVerify) commitArgs.push('--no-verify');
		const committed = await runGit(commitArgs, cwd, cfg.timeoutMs);
		if (!committed.ok) return fail(record, `git commit failed: ${failureText(committed)}`);

		const head = await runGit(['rev-parse', '--short', 'HEAD'], cwd, cfg.timeoutMs);
		const short = head.ok ? head.stdout.trim() : '';
		record.lastCommit = { short, subject: message.subject, files: files.length, turn: turn ?? null, at: Date.now() };
		record.lastError = null;
		record.dirty = { files: 0, unmerged: false };
		note(`committed ${short} (${String(files.length)} file${files.length === 1 ? '' : 's'}) in ${repo.root} [${trigger}]`);
		trace(cfg, record.sessionId, `trigger=${trigger} committed ${short} files=${String(files.length)}`);

		if (switchesFor(record, repo).push) {
			const pushed = await runGit(['push'], cwd, cfg.pushTimeoutMs);
			if (!pushed.ok) {
				record.lastError = { message: `Committed ${short}, but the push failed: ${failureText(pushed)}`, at: Date.now() };
			} else {
				record.lastPush = { short, at: Date.now() };
			}
		}
		return { kind: 'committed', short, subject: message.subject, files: files.length, repo: repo.root };
	}

	/**
	 * Render the commit subject and body for one commit.
	 * @param record - the session.
	 * @param repo - the repository.
	 * @param files - staged paths with their status letters.
	 * @param turn - the turn being closed, or undefined for a manual commit.
	 * @returns the two commit fields.
	 */
	function composeMessage(record, repo, files, turn) {
		const summary = turn === undefined || turn === null ? 'manual commit' : `turn ${turn}`;
		const subject = renderTemplate(cfg.subject, {
			summary,
			turn: turn === undefined || turn === null ? '' : String(turn),
			files: String(files.length),
			repo: repo.name,
			branch: repo.branch,
			session: record.sessionId
		}).replace(/\s+/gu, ' ').trim();
		const listed = files.slice(0, cfg.maxFilesListed).map((file) => `${file.status}\t${file.path}`);
		if (files.length > listed.length) listed.push(`… and ${String(files.length - listed.length)} more`);
		const body = [
			`session: ${record.sessionId}`,
			`repo: ${repo.root}`,
			`branch: ${repo.branch.length > 0 ? repo.branch : '(detached)'}`,
			`changes: ${String(files.length)}`,
			'',
			...listed
		].join('\n');
		return { subject: subject.length > 0 ? subject.slice(0, 200) : `dsh autocommit: ${summary}`, body };
	}

	// ------------------------------------------------------------------ reports

	/**
	 * Project one session into the shape the browser and the command read.
	 * @param record - the session.
	 * @param options - `refresh` re-reads the repository and its change count.
	 * @returns the state payload.
	 */
	async function snapshotOf(record, options = {}) {
		const repo = await resolveRepo(record, options.refresh === true);
		if (options.refresh === true && repo !== null) record.dirty = await readStatus(scopeCwd(record, repo));
		const switches = switchesFor(record, repo);
		return {
			sessionId: record.sessionId,
			cwd: record.cwd,
			repo,
			blocked: repo === null ? null : repoBlocked(repo.root),
			gitAvailable: gitPath !== null,
			// `enabled` mirrors `commit` for a browser bundle cached before the
			// control grew its second switch.
			enabled: switches.commit,
			commit: switches.commit,
			push: switches.push,
			busy: record.busy !== null,
			scope: cfg.scope,
			dirty: record.dirty,
			lastCommit: record.lastCommit,
			lastPush: record.lastPush,
			lastError: record.lastError
		};
	}

	/**
	 * Render one state payload as the text `/autocommit status` answers with.
	 * @param snapshot - what {@link snapshotOf} returned.
	 * @returns plain text, one fact per line.
	 */
	function describeState(snapshot) {
		if (!snapshot.gitAvailable) return 'Git is not installed, or it is not on PATH.';
		if (snapshot.repo === null) return `No Git repository contains ${snapshot.cwd}.`;
		const lines = [
			`Auto-commit is ${snapshot.commit ? 'on' : 'off'} for ${snapshot.repo.name} (${snapshot.repo.branch.length > 0 ? snapshot.repo.branch : 'detached HEAD'}) at ${snapshot.repo.root}.`,
			`Auto-push is ${snapshot.push ? 'on' : 'off'}.`,
			`Scope: ${snapshot.scope === 'repo' ? 'the whole repository' : 'this working directory'}.`
		];
		if (snapshot.blocked !== null) lines.push(snapshot.blocked);
		if (snapshot.dirty !== null) lines.push(snapshot.dirty.files === 0 ? 'Nothing is uncommitted.' : `${String(snapshot.dirty.files)} uncommitted change${snapshot.dirty.files === 1 ? '' : 's'}.`);
		if (snapshot.lastCommit !== null && snapshot.lastCommit.short.length > 0) lines.push(`Last commit: ${snapshot.lastCommit.short} ${snapshot.lastCommit.subject}`);
		if (snapshot.lastError !== null) lines.push(`Last error: ${snapshot.lastError.message}`);
		return lines.join('\n');
	}

	// ---------------------------------------------------------------- commands

	/**
	 * Register `/autocommit`, when this profile has a command service.
	 * @returns the disposer of the registration, if any.
	 */
	function registerCommands() {
		const commands = ctx.get('commands');
		if (commands === undefined || typeof commands.register !== 'function') {
			note('no command service in this profile; /autocommit is unavailable');
			return () => {};
		}
		let off;
		try {
			off = commands.register({
				name: 'autocommit',
				description: 'Turn automatic Git commits and pushes on or off, or commit now (/autocommit on|off|push on|push off|now|status)',
				handler: (invocation) => runAutocommitCommand(invocation)
			});
		} catch (error) {
			warn(`could not register /autocommit: ${describe(error)}`);
			return () => {};
		}
		return typeof off === 'function' ? off : () => {};
	}

	/**
	 * Serve one `/autocommit` invocation.
	 * @param invocation - the command invocation, whose agent decides the session.
	 * @returns the outcome shown in the conversation.
	 */
	async function runAutocommitCommand(invocation) {
		const record = sessions.get(invocation?.agent?.id);
		if (record === undefined) return { kind: 'error', text: 'This session has no working directory, so there is nothing to commit.' };
		const verb = String(invocation?.rawInput ?? '').trim().toLowerCase();
		try {
			if (verb === '' || verb === 'status') {
				return { kind: 'success', text: describeState(await snapshotOf(record, { refresh: true })) };
			}
			if (verb === 'on' || verb === 'off') {
				const changed = await setSwitches(record, { commit: verb === 'on' });
				if (!changed.ok) return { kind: 'error', text: changed.message };
				return { kind: 'success', text: describeState(await snapshotOf(record, { refresh: true })) };
			}
			const pushVerb = /^push\s+(on|off)$/u.exec(verb);
			if (pushVerb !== null) {
				const changed = await setSwitches(record, { push: pushVerb[1] === 'on' });
				if (!changed.ok) return { kind: 'error', text: changed.message };
				return { kind: 'success', text: describeState(await snapshotOf(record, { refresh: true })) };
			}
			if (verb === 'now') {
				const outcome = await commitNow(record, { turn: undefined, trigger: 'command' });
				if (outcome.kind === 'committed') return { kind: 'success', text: `Committed ${outcome.short} in ${outcome.repo} (${String(outcome.files)} file${outcome.files === 1 ? '' : 's'}).` };
				return { kind: 'error', text: outcome.message ?? 'Nothing to commit.' };
			}
			return { kind: 'error', text: 'Use /autocommit on, off, push on, push off, now, or status.' };
		} catch (error) {
			return { kind: 'error', text: `Auto-commit failed: ${describe(error)}` };
		}
	}

	ctx.effect(() => registerCommands(), `${name}: /autocommit`);

	// ------------------------------------------------------------- HTTP routes

	/**
	 * Answer one request under {@link ROUTE_PREFIX}.
	 * @param req - incoming request.
	 * @param res - response owned here.
	 */
	async function handleRequest(req, res) {
		let url;
		try {
			url = new URL(req.url ?? '/', 'http://dsh.invalid');
		} catch {
			sendJson(res, 400, { message: 'Malformed request URL.' });
			return;
		}
		const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/u, '') : url.pathname;
		if (pathname !== ROUTE_PREFIX && !pathname.startsWith(`${ROUTE_PREFIX}/`)) {
			sendJson(res, 404, { message: 'Not found.' });
			return;
		}
		const route = pathname.slice(ROUTE_PREFIX.length);

		if (req.method === 'GET' && (route === '' || route === '/state')) {
			const record = sessions.get(url.searchParams.get('sessionId') ?? '');
			if (record === undefined) {
				sendJson(res, 404, { message: 'Unknown session.' });
				return;
			}
			sendJson(res, 200, await snapshotOf(record, { refresh: true }));
			return;
		}

		if (req.method === 'POST' && route === '/toggle') {
			if (!sameOrigin(req)) {
				sendJson(res, 403, { message: 'Cross-origin requests are refused.' });
				return;
			}
			let body;
			try {
				body = await readJsonBody(req);
			} catch (error) {
				sendJson(res, 400, { message: describe(error) });
				return;
			}
			const record = sessions.get(typeof body?.sessionId === 'string' ? body.sessionId : '');
			if (record === undefined) {
				sendJson(res, 404, { message: 'Unknown session.' });
				return;
			}
			// `enabled` is the pre-dropdown name of the commit switch, still
			// accepted so a cached browser bundle keeps working.
			const patch = {};
			if (typeof body?.commit === 'boolean') patch.commit = body.commit;
			else if (typeof body?.enabled === 'boolean') patch.commit = body.enabled;
			if (typeof body?.push === 'boolean') patch.push = body.push;
			if (patch.commit === undefined && patch.push === undefined) {
				sendJson(res, 400, { message: 'A boolean "commit" or "push" is required.' });
				return;
			}
			const changed = await setSwitches(record, patch);
			if (!changed.ok) {
				sendJson(res, 409, { message: changed.message });
				return;
			}
			sendJson(res, 200, await snapshotOf(record, { refresh: true }));
			return;
		}

		sendJson(res, 405, { message: `${req.method ?? 'That method'} is not supported here.` });
	}

	ctx.inject(['webServer'], (webCtx) => {
		webCtx.effect(() => webCtx.webServer.register({
			kind: 'prefix',
			path: ROUTE_PREFIX,
			handler: handleRequest
		}), `${name}: HTTP routes`);
	});

	// -------------------------------------------------------------- environment

	/**
	 * Whether a state-changing request came from the page this Host is serving.
	 * @param req - incoming request.
	 * @returns true when the request is same-origin, or carries no Origin at all.
	 */
	function sameOrigin(req) {
		const origin = req.headers.origin;
		if (typeof origin !== 'string' || origin.length === 0) return true;
		try {
			return new URL(origin).host === req.headers.host;
		} catch {
			return false;
		}
	}

	/**
	 * Read and parse a bounded JSON request body.
	 * @param req - incoming request.
	 * @returns the parsed body.
	 * @throws when the body is too large, is not JSON, or the stream fails.
	 */
	function readJsonBody(req) {
		return new Promise((resolvePromise, rejectPromise) => {
			const chunks = [];
			let size = 0;
			req.on('data', (chunk) => {
				size += chunk.length;
				if (size > MAX_BODY_BYTES) {
					rejectPromise(new Error('Request body is too large.'));
					req.destroy();
					return;
				}
				chunks.push(chunk);
			});
			req.on('error', (error) => rejectPromise(error));
			req.on('end', () => {
				const text = Buffer.concat(chunks).toString('utf8');
				try {
					const parsed = JSON.parse(text);
					resolvePromise(typeof parsed === 'object' && parsed !== null ? parsed : {});
				} catch {
					rejectPromise(new Error('Request body is not JSON.'));
				}
			});
		});
	}

	/**
	 * Write one JSON response.
	 * @param res - response to own.
	 * @param status - HTTP status code.
	 * @param payload - JSON-serializable body.
	 */
	function sendJson(res, status, payload) {
		const body = JSON.stringify(payload);
		res.writeHead(status, {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
			'content-length': Buffer.byteLength(body)
		});
		res.end(body);
	}

	/** Path of the persisted toggle file. */
	function stateFile() {
		const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh');
		return join(home, 'auto-commit-button.json');
	}

	/**
	 * Read the persisted per-repository switches.
	 * @returns repository root → the stored switch pair; empty when nothing was
	 *   ever switched.
	 */
	function loadToggles() {
		return readSwitches(stateFile());
	}

	/**
	 * Persist the per-repository switches.
	 *
	 * The file is shared — another Host process, another profile, or a previous
	 * generation of this plugin may hold entries this instance never loaded — so
	 * this instance's view is merged onto what is on disk rather than replacing
	 * it. Replacing it silently drops every switch made elsewhere, which is how
	 * a write here once disarmed a repository switched in another window.
	 *
	 * @param map - the current switches; updated with everything the file holds.
	 */
	function saveToggles(map) {
		try {
			const path = stateFile();
			const merged = readSwitches(path);
			for (const [root, pair] of map) merged.set(root, pair);
			for (const [root, pair] of merged) map.set(root, pair);
			mkdirSync(dirname(path), { recursive: true });
			const temporary = `${path}.tmp`;
			writeFileSync(temporary, `${JSON.stringify({ version: 2, repos: Object.fromEntries(merged) }, null, '\t')}\n`);
			renameSync(temporary, path);
		} catch (error) {
			warn(`could not save the toggle state: ${describe(error)}`);
		}
	}
}

/**
 * Read one switch file.
 *
 * Version 1 stored one boolean per repository — the commit switch — so a file
 * written before the control grew its second switch still reads as what it
 * meant: commits armed, push at the profile default.
 *
 * @param path - the file to read.
 * @returns repository root → the stored switch pair; empty when there is none.
 */
function readSwitches(path) {
	const map = new Map();
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8'));
		const repos = parsed?.repos;
		if (typeof repos === 'object' && repos !== null) {
			for (const [root, stored] of Object.entries(repos)) {
				if (typeof stored === 'boolean') map.set(root, { commit: stored, push: false });
				else if (typeof stored === 'object' && stored !== null) map.set(root, { commit: stored.commit === true, push: stored.push === true });
			}
		}
	} catch {
		/* A missing or unreadable state file simply means nothing is switched. */
	}
	return map;
}

// --------------------------------------------------------------------- helpers

/** Resolve the plugin's own configuration; every unusable value falls back. */
function resolveConfig(config, warn) {
	const cfg = {};
	for (const [key, fallback] of Object.entries(DEFAULTS)) {
		const value = config?.[key];
		if (value === undefined) {
			cfg[key] = Array.isArray(fallback) ? [...fallback] : fallback;
			continue;
		}
		if (Array.isArray(fallback)) {
			const list = Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.length > 0) : [];
			if (list.length !== (Array.isArray(value) ? value.length : -1)) {
				warn(`ignoring unusable entries in "${key}"`);
			}
			cfg[key] = list;
			continue;
		}
		if (typeof fallback === 'boolean') {
			cfg[key] = typeof value === 'boolean' ? value : fallback;
			continue;
		}
		if (typeof fallback === 'number') {
			cfg[key] = Number.isSafeInteger(value) && value > 0 ? value : fallback;
			continue;
		}
		cfg[key] = typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
	}
	if (cfg.scope !== 'workspace' && cfg.scope !== 'repo') {
		warn(`unknown scope "${cfg.scope}"; committing this working directory only`);
		cfg.scope = DEFAULTS.scope;
	}
	return cfg;
}

/**
 * Substitute `{name}` placeholders.
 * @param text - template.
 * @param values - placeholder values.
 * @returns the rendered text, with unknown placeholders left as written.
 */
function renderTemplate(text, values) {
	return text.replace(/\{([a-z]+)\}/gu, (match, key) => (Object.hasOwn(values, key) ? String(values[key]) : match));
}

/**
 * Find a usable Git executable.
 *
 * On macOS `/usr/bin/git` is a stub that opens an installer dialog instead of
 * running, so it only counts when the developer tools are actually selected:
 * executing it would hang a turn behind a GUI prompt nobody asked for.
 *
 * @returns the executable path, or null when Git is unavailable.
 */
function resolveGitExecutable() {
	const executable = process.platform === 'win32' ? 'git.exe' : 'git';
	for (const directory of (process.env.PATH ?? '').split(delimiter)) {
		if (directory.length === 0) continue;
		const candidate = join(directory, executable);
		try {
			if (!statSync(candidate).isFile()) continue;
			accessSync(candidate, constants.X_OK);
		} catch {
			continue;
		}
		if (process.platform === 'darwin' && candidate === '/usr/bin/git') {
			try {
				execFileSync('/usr/bin/xcode-select', ['-p'], { stdio: 'ignore', timeout: 2000 });
			} catch {
				continue;
			}
		}
		return candidate;
	}
	return null;
}

/** Render an unknown error for a log line. */
function describe(error) {
	return error instanceof Error ? `${error.message}${error.code === undefined ? '' : ` [${String(error.code)}]`}` : String(error);
}

/**
 * Append one diagnostic line, when the `traceFile` option names a file.
 *
 * The Host log goes to whatever stream the process was started with, which is
 * not always reachable from the session asking why a turn committed nothing;
 * this channel is. Off unless configured, and it never throws.
 *
 * @param cfg - resolved plugin configuration.
 * @param subject - session id the line belongs to.
 * @param message - what happened.
 */
function trace(cfg, subject, message) {
	if (cfg.traceFile.length === 0) return;
	try {
		appendFileSync(cfg.traceFile, `${new Date().toISOString()} [${subject}] ${message}\n`);
	} catch {
		cfg.traceFile = '';
	}
}
