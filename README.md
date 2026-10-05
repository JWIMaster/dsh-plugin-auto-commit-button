<p align="center">
  <img src="icon.svg" alt="The auto-commit button icon" width="72" height="72">
</p>

# dsh-plugin-auto-commit-button

A DeepSeek Harness plugin that puts one menu in the composer. Switch
**Auto-commit** on and every finished turn is committed to the Git repository
that holds the session's workspace, so the work an agent did lands in history as
it happens instead of waiting for someone to remember. Switch **Auto-push** on as
well and each of those commits is pushed too.

## Behaviour

1. **The control.** A chip labelled *Auto-commit* sits in the composer tool row,
   next to the permission and mode controls. It reads the Host state on a short
   timer, so a second window on the same repository shows the same thing.
2. **The menu.** Clicking the chip opens two switches. *Auto-commit* commits what
   a finished turn changed; *Auto-push* pushes each of those commits. Auto-push
   needs something to push, so it stays disabled until Auto-commit is on, and
   says why.
3. **Every turn.** At the `agent/turn-stopping` boundary — the point where the
   model owes no further output — the changes under the working directory are
   staged and committed, and then pushed if Auto-push is on. A turn that changed
   nothing commits nothing.
4. **The report.** The chip's tooltip carries the state and the change count; the
   menu's footer carries the repository and branch, the change count, the last
   commit (and whether it was pushed), and the reason whenever something did not
   work.

Both switches belong to the repository, keyed by its root, so every session
whose working directory is inside it sees the same pair, and every one of them
commits. They survive a Host restart: they are written to
`$DSH_HOME/auto-commit-button.json`, one entry per repository.

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

A workspace that is in no repository has nothing to switch: both rows of the menu
are disabled and the footer says to run `git init`. Hooks still run, so a
repository that gates commits on a pre-commit check keeps gating them;
`noVerify: true` turns that off if you want it off.

Auto-push is off until you turn it on. It runs a plain `git push`, so it follows
your `push.default` and upstream configuration; a branch with no upstream fails
there rather than guessing a remote, the commit still stands, and the menu shows
the failure.

## Commands

| Command | Does |
| --- | --- |
| `/autocommit` or `/autocommit status` | Report the repository, the branch, both switches, the change count, and the last commit or the last error. |
| `/autocommit on` / `/autocommit off` | Turn Auto-commit on or off for this session's repository. The same switch the menu flips, for anyone who prefers typing. |
| `/autocommit push on` / `/autocommit push off` | Turn Auto-push on or off. |
| `/autocommit now` | Commit immediately, without waiting for the next turn. |

Turning Auto-commit off keeps the Auto-push preference, so switching commits
back on restores the pair you had. Without a `commands` service in the profile
the plugin still watches turns; it just cannot be asked to do these four things,
and says so once in the log.

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
patch layer.

An upgrade has two halves, and they do not land together. The browser half is
read from the installed package per request, so a reloaded page can pick up a new
version immediately — while the Host half is a module the running process
imported once, and only a restart replaces it. Between the two, a new control
talks to the previous Host and reports the mismatch it gets back, so **restart
the Host after upgrading** (`restart-required` in the plugin manager, or relaunch
`dsh web`), and reload the page.

## Configuration

Every value in the patch row's `config` is optional.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | What the commit switch starts at for a repository that was never switched in the composer. `true` commits every repository a session opens. |
| `scope` | `workspace` | `workspace` stages the session's working directory; `repo` stages the whole repository. |
| `push` | `false` | What the push switch starts at for a repository that was never switched. Both switches in force are the stored pair when there is one, and these defaults when there is not. |
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
  written as a module-loader bundle with no build step: `react` and `react-dom`
  are platform seed modules and everything else is browser API. The menu is
  portaled to the document body and positioned from the trigger's rect, so the
  composer's own stacking and overflow cannot crop it; the store behind the
  control polls only while the control is on screen.

| Route | Does |
| --- | --- |
| `GET /dsh-autocommit/state?sessionId=…` | The repository, branch, both switches, change count, last commit, last push, and last error for one session. |
| `POST /dsh-autocommit/toggle` | `{ sessionId, commit?, push? }` — set either switch, and return the new state. `enabled` is still accepted as the pre-menu name of `commit`. Refused unless the request's `Origin` matches the Host's. |

## Development

```sh
npm test        # node --check on both halves, then selftest.mjs
```

`selftest.mjs` runs both halves the way they are actually used: the Host half
against real `git` in throwaway repositories in the temporary directory —
including a bare repository standing in for a remote, so the push switch is
proved by reading the remote's history — doing the turn boundary, the switches,
the routes, the command, the guards, the state file, and a restart; and the
browser half by loading `client.js` through a stand-in module loader and
rendering the registered control with a minimal hook runtime, so the trigger,
the menu, its two rows, the keyboard routing, and the requests a click sends are
all driven for real. Nothing needs the Harness running.

## Publishing (maintainers)

```sh
npm pack --dry-run      # the files that ship
npm publish             # unscoped name, public by default (publishConfig.access)
git push --tags
```

## Licence

MIT — see [LICENSE](LICENSE).
