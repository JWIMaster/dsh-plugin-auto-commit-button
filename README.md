# dsh-plugin-auto-commit-button

A DeepSeek Harness plugin that puts one toggle in the composer. Turn it on and
every finished turn is committed to the Git repository that holds the session's
workspace, so the work an agent did lands in history as it happens instead of
waiting for someone to remember.

![The control in the composer tool row](icon.svg)

## Behaviour

1. **The control.** A chip labelled *Auto-commit* sits in the composer tool row,
   next to the permission and mode controls. It reads the Host state on a short
   timer, so a second window on the same repository shows the same thing.
2. **Arming.** Clicking it arms the repository. The armed state belongs to the
   repository, not to one session: every session whose working directory is
   inside it sees the same state, and every one of them commits.
3. **Every turn.** At the `agent/turn-stopping` boundary — the point where the
   model owes no further output — the changes under the working directory are
   staged and committed. A turn that changed nothing commits nothing.
4. **The tooltip.** Hovering the control shows the repository and branch, the
   current change count, the last commit it made, and the reason whenever
   something did not work.

The toggle survives a Host restart: it is written to
`$DSH_HOME/auto-commit-button.json`, keyed by repository root.

## What it commits, and what it refuses

`scope: workspace` (the default) stages the session's working directory only.
That is what keeps a workspace that happens to be one package of a large
repository from sweeping up everybody else's unfinished work; `scope: repo`
stages the repository instead.

Two states are never committed through, because an automatic commit is a write
nobody reviews:

- **Unresolved merges.** If any path is unmerged, the turn is skipped and the
  control says so. Resolve the merge and the next turn commits.
- **A repository rooted at your home directory or at a filesystem root.** Such a
  repository would make one click commit everything you own. It is refused
  outright unless you set `allowHomeRepo: true`.

A workspace that is in no repository has nothing to arm: the control renders
disabled and its tooltip says to run `git init`. Hooks still run, so a repository
that gates commits on a pre-commit check keeps gating them; `noVerify: true`
turns that off if you want it off.

Nothing is ever pushed. `push: true` pushes after each commit, which adds a
network round trip to the turn boundary and is not what most people mean by
"auto-commit".

## Commands

| Command | Does |
| --- | --- |
| `/autocommit` or `/autocommit status` | Report the repository, the branch, the armed state, the change count, and the last commit or the last error. |
| `/autocommit on` / `/autocommit off` | Arm or disarm this session's repository. The same switch the control flips, for anyone who prefers typing. |
| `/autocommit now` | Commit immediately, without waiting for the next turn. |

Without a `commands` service in the profile the plugin still watches turns; it
just cannot be asked to do these three things, and says so once in the log.

## Install

From npm, into any profile:

```sh
dsh plugin --profile web add dsh-plugin-auto-commit-button
```

From a local checkout (development):

```sh
dsh plugin --profile web add /path/to/dsh-plugin-auto-commit-button
```

Either way the bundle patch (`cordis.patch.yml`) inserts the Host row and
carries the default configuration; override any of it from the profile's own
patch layer. Installing into a running Harness takes effect on reload; a profile
that reports `restart-required` needs the app restarted to load the new package
generation — the browser half is served from the composed boot graph, so the
page has to be reloaded with it.

## Configuration

Every value in the patch row's `config` is optional.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Arm every repository as soon as a session opens, instead of waiting for the control. |
| `scope` | `workspace` | `workspace` stages the session's working directory; `repo` stages the whole repository. |
| `push` | `false` | Push after each commit. |
| `noVerify` | `false` | Pass `--no-verify`, skipping pre-commit and commit-msg hooks. |
| `subject` | `dsh autocommit: {summary}` | Commit subject. Placeholders: `{summary}` (`turn 4`, or `manual commit`), `{turn}`, `{files}`, `{repo}`, `{branch}`, `{session}`. |
| `exclude` | `[]` | Pathspecs never staged, e.g. `['CURRENT_PROGRESS.md']`. |
| `maxFilesListed` | `24` | Files named in the commit body before the rest are counted instead. |
| `timeoutMs` | `20000` | Milliseconds one git command may run before it is killed. |
| `pushTimeoutMs` | `60000` | Milliseconds a push may run. |
| `allowHomeRepo` | `false` | Permit a repository rooted at the home directory or a filesystem root. |
| `statusTtlMs` | `3000` | How long a resolved repository and its change count are reused while the control polls. |
| `traceFile` | *unset* | Diagnostics: append one line per decision (adoption, repository resolution, commit outcome) to this file. Off when unset. |

A commit made by the plugin reads like this:

```
dsh autocommit: turn 12

session: session-b7f7f71e-7990-4a64-94dd-c6e83c6da0c3
repo: /Users/you/code/thing
branch: main
changes: 3

M	src/a.ts
A	src/b.ts
D	src/old.ts
```

## How it is built

Two halves, held together by three same-origin JSON routes.

- **`index.js` — the Host half.** Resolves each live session's working directory
  against `git`, watches `agent/turn-stopping`, and commits through `execFile`
  with an explicit timeout and `GIT_TERMINAL_PROMPT=0`, so a missing credential
  can never leave a turn waiting on a prompt. Subagent sessions are ignored, and
  it depends on nothing but Node built-ins and the `agents` service.
- **`client.js` — the browser half.** One registration into the
  `conversation.input.left` slot from `@deepseek-ai/dsh-client-ui-conversation`,
  written as a module-loader bundle with no build step: `react` is the platform
  seed module and everything else is browser API. The store behind the control
  polls only while the control is on screen.

| Route | Does |
| --- | --- |
| `GET /dsh-autocommit/state?sessionId=…` | The repository, branch, armed state, change count, last commit, and last error for one session. |
| `POST /dsh-autocommit/toggle` | `{ sessionId, enabled }` — arm or disarm, and return the new state. Refused unless the request's `Origin` matches the Host's. |

## Development

```sh
npm test        # node --check on both halves, then selftest.mjs
```

`selftest.mjs` runs both halves the way they are actually used: the Host half
against real `git` in throwaway repositories in the temporary directory (doing
the turn boundary, the routes, the command, the guards, and the restart), and
the browser half by loading `client.js` through a stand-in module loader and
rendering the registered component. Nothing needs the Harness running.

## Publishing (maintainers)

```sh
npm pack --dry-run      # the files that ship
npm publish             # unscoped name, public by default (publishConfig.access)
git push --tags
```

## Licence

MIT — see [LICENSE](LICENSE).
