# Policy engine

One Node.js program (22+, no dependencies) that Claude Code runs as a hook on every tool call. `forge sync` copies it into each checkout (`.forge/kit/`) and wires it in `.claude/settings.local.json`. It is the fast, local enforcement layer; the server (branch protection, required checks, protected environments; see `core/server/`) is the layer that cannot be switched off.

## Events

`bin/forge-hook.mjs <event>` reads the hook input on stdin and prints the hook's JSON answer.

| Event | What it does |
|---|---|
| `pre-tool-use` | Checks the call and answers deny, ask, allow (project commands only) or nothing. **Fails closed**: unreadable input or a crash exits 2, and the hook command adds `\|\| exit 2` in case Node itself is missing. On Node older than 22, or when the checkout's kit differs from the version the project pins, it allows reading only. |
| `post-tool-use` | Runs the project's format, lint and type-check rules on an edited file and hands failures back to the agent; counts lane calls and edits, warns past the budget line, records human approvals. |
| `subagent-start` | Injects `core/AGENTS.md`, `core/LANES.md` and the project facts into every lane, also inside a worktree. |
| `subagent-stop` | Copies the documents a lane wrote in its own worktree to the main checkout (Claude Code lets a worktree agent write only there): handovers from every lane, reports from reviewers and QA, `.forge/project/` documents from docs-only roles, never `project.json` or the kit overrides, and never over a newer copy (decision 92). Then an engineer lane may only finish with green gates. |
| `session-start` | Injects `core/AGENTS.md`, `core/LEAD.md` (the main session's rules: how it asks the owner, decision 136) and the project facts, plus budgets, pending handovers and configuration problems (each injection stays under the 10,000-character hook limit). |
| `stop` | The lead's turn ends: sends it back once to `forge save` when the team repo has unsaved plans or reports. |
| `post-tool-use-failure`, `user-prompt-submit`, `pre-compact`, `post-compact`, `session-end`, `stop-failure`, `permission-denied` | Write the timeline only, and print nothing. |
| `gates` | Not a hook: runs the done check on the current branch by hand. |

**Timeline** (`lib/timeline.mjs`, decision 96). Every event above also appends one JSON line to `.forge/state/timeline-<YYYY-MM>.jsonl`: who (`lead`, the agent's role, `human`, `kit`), the agent's id, the ticket (from the spawn's description, else the branch), and for a tool call its start (or the kit's refusal or ask, with the rule and reason) and its end with the tool's own run time, or its error; each model reply's model and tokens, once it is complete, claimed by the first line that finds it so (decision 97). Gate runs and terminal `forge` commands are logged too. No prompt text, file contents or command output; commands and paths are cut to 120 characters, errors to 300, secrets masked. It goes into the session's project (`CLAUDE_PROJECT_DIR`) even when the shell has moved into another repo. Writing it never fails a hook. `forge timeline` reads it.

## Rules

Every Bash command is parsed (`lib/shell.mjs`) into the simple commands that actually run, through wrappers (`sudo`, `env`, `timeout`, `xargs`, `bash -c`, `eval`, `find -exec`) and substitutions. Findings carry a rule id, shown to the agent as `[rule] reason`.

| Area | Deny | Ask first |
|---|---|---|
| git (`rules/git.mjs`) | push to protected branches (any refspec form), force push (`-f`, `+ref`, lease), `--mirror`, `--all`, `--prune`, `ci.skip`, `--no-verify`/`commit -n`, `core.hooksPath` changes, `git add .`/`-A`/`-u`, `commit -a`, deleting or moving protected branches | creating, moving or deleting an `api-v*` tag, `reset --hard`, `clean -f`, `checkout -- .`, `restore`, `stash drop`, `branch -D`, `worktree remove --force`, pushing tags, `add -f`, history rewrites, `rm -r` |
| hosts (`rules/hosts.mjs`) | merge, approve, secrets and variables, repo settings, printing tokens, API calls to merge/approval/protection/secret endpoints; `forge limits lift` and `forge llm add`/`use`/`remove`, which are a person's | releases, workflow and pipeline runs, other changing API calls |
| secrets (`rules/secrets.mjs`) | any command naming a secret file (except `ls`, `stat` and the like), secret names in interpreter code, env dumps (also `/proc/*/environ`, `ps e`/`-E`, `declare -p`, interpreters dumping the environment), printing secret variables, `curl \| sh`, `docker compose config` | |
| keys (`rules/keys.mjs`) | the OpenProject key file, the key script, `OPENPROJECT_API_KEY` references; a model server's key file and running its key helper (`llm-key.mjs`, decision 140); keyring password prints for any service, keychain dumps | |
| ops (`rules/ops.mjs`) | `terraform apply`/`destroy`/state, `DROP`/`TRUNCATE`, `prisma migrate reset`, production targets, credential-printing cloud commands | dependency changes, hosts outside `network.allowHosts`, non-local databases, ssh/scp/rsync writes, kubectl/helm changes, cloud changes, deploy tools and deploy scripts, docker remote/push/volume deletes, deleting repo folders |
| writes (`rules/targets.mjs`, shared by Bash writers and file tools) | hooks, settings, approvals state, `.git/`, secrets, Terraform state, lock files, generated code, protected documents, migrations already on main | CI files, ADRs, agent config and the project's kit overrides, the policy config, `.gitleaksignore`/`.gitleaks.toml`, security-sensitive paths and the API contract's spec (each once per branch, see approvals) |
| files (`files.mjs`) | Read/Grep of secrets, the OpenProject key file and a model server's key file; writes to them | manifest edits that change dependencies |
| lanes (`lanes.mjs`) | sub-agents from lanes; any call but handing over past `budget.block`; an engineer lane past 25 calls with no edit | |
| done (`gates.mjs`) | ready PR/MR, done ticket status, or an engineer lane finishing, unless the gates passed on that commit | |
| models (`handlers.mjs`) | spawning an engineer (`budget.engineers`) with a `model` other than the one forge sync rendered for it: implementation stays on its tier (decision 94) | |
| contract (`handlers.mjs`) | spawning `backend-engineer`, `frontend-engineer` or `mobile-engineer` on a plan whose `Contract:` is pending or names a version that is neither an `api-v` tag here nor `project.api.pin` | |
| output (`rules/output.mjs`) | heavy test/build commands without redirect, filter or quiet flag | |
| commit scan (`scan.mjs`) | a `git commit` that would add a secret, including files staged by the same command (gitleaks when installed, else built-in patterns) | |
| pacing (`pacing.mjs`) | the lead spawning agents while the plan's usage is red (only with pacing on, and never on a self-hosted model server; see the `pacing` skill) | |
| mcp (`mcp.mjs`) | any MCP tool but Figma's (`project.figma.toolPrefix`) and the prefixes in `mcp.allow`, and reading another server's resources: the rules cannot see what an MCP call does | |
| roles (`roles.mjs`) | read-only roles (reviewers, scout) writing anything but their report; docs-only roles (planner, analysts, designer, tracker clerk) writing outside `.forge/`; either running anything but inspection and `forge` commands | |

**Approvals.** An ask resolved by a person in `default`, `acceptEdits` or `plan` mode is recorded per branch for the security gate (`.forge/state/approvals.json`). In `bypassPermissions`, `dontAsk` and `auto` modes asks become denials, because nobody may see them.

**Auto-approval.** A Bash call made only of the project's own commands (the gate commands, `commands.allow`), output redirected to `/tmp`, and `tail`/`grep`-style plumbing is approved without a prompt, so unattended lanes can run the gates even before a folder is trusted. It applies only when no rule objected; settings deny and ask rules still apply.

## Configuration

The project's `.forge/project/project.json` (a link into the team repo; `$FORGE_CONFIG` overrides it). Its `policy` key holds the rules below, `project` the facts injected into sessions, and `kit.version` the exact kit version the project pins. Values merge over the defaults in `lib/config.mjs`; unknown keys or wrong types make the engine refuse everything but reading until a human fixes the file.

`branches.{main,protected}` · `paths.{generated,protected,migrations,sensitive,adr,contract,ci,cleanable,reports,docs}` (repo-relative globs) · `secrets.{allow,extra,scanner}` · `roles.{readOnly,readOnlyCommands}` · `edits.{timeoutSec,format,lint,typecheck}` · `commands.{allow,wrappers}` · `network.allowHosts` · `mcp.allow` (tool-name prefixes, `mcp__<server>__`) · `databases.localHosts` · `gates.{full,affected,timeoutSec,agents,maxAttempts,requirePushed,doneStatuses}` · `budget.{warn,block,leadWarn,maxCallsWithoutEdit,engineers}` · `output.heavy` · `commit.checks` · `tests.{sides,e2e}` · `deps.approved` · `kit.{configPath,codePaths}`

`edits` rules are `{ "glob": "...", "command": "..." }`; `{file}` is the edited file's repo-relative path, and commands run from the repo root (so they also work inside a toolchain container). They are per project, decided with its stack. Examples:

```json
"edits": {
  "format":    [{ "glob": "**/*.{ts,tsx}", "command": "npx prettier --write {file}" }],
  "lint":      [{ "glob": "**/*.{ts,tsx}", "command": "npx eslint {file}" }],
  "typecheck": [{ "glob": "**/*.{ts,tsx}", "command": "npx tsc --noEmit -p ." }]
}
```

.NET: `dotnet format --include {file}`. Python: `ruff format {file}`, `ruff check {file}`, `mypy {file}`. Whole-project type checks can be slow on every edit; the gates run them anyway.

`tests` (decision 50): `sides` is a list of `{ "name", "code": [globs], "tests": [globs], "ignore": [globs] }`; a branch that changes a side's code without changing one of its tests is not done. `e2e.tests` (globs) and `e2e.command`: when the plan's `E2E:` line names a flow, an end-to-end test must change and the command runs after the gate command; "not applicable (<reason>)" needs the reason. The stack guides give the values.

`commit.checks` use the same shape, with `{files}` for all staged files that match the glob (quoted). The pre-commit git hook runs them, for people and agents alike:

```json
"commit": { "checks": [{ "glob": "**/*.{ts,tsx}", "command": "npx eslint {files}" }] }
```

## Git hooks

`core/githooks/` (wired by `forge sync` through the checkout's local `core.hooksPath`; a previous hooks path is remembered and runs after the kit's checks):
- **pre-commit:** no kit files staged (not even with `git add -f`), no secrets in the staged changes, the project's `commit.checks`.
- **commit-msg:** Conventional Commits (`build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`); git's own merge, revert and fixup messages pass. With `project.coAuthor: false` an AI `Co-Authored-By` line is removed.

## State

`<main worktree>/.forge/state/`, shared by all lanes and protected from agents:
- policy: `approvals.json`, `gates.json` (result per commit) and `gates/<sha>.log`, `lanes/<agent_id>.json`, `lead.json`, `stop-attempts.json`, `gates-failed.json`, `debug.log` (only with `FORGE_DEBUG=1`);
- timeline: `timeline-<YYYY-MM>.jsonl` (one line per event), `timeline-import.jsonl` (`forge timeline import`), `spawns/<agent_id>.json` (the ticket each spawn named), `replies/<id>` (a reply's tokens already counted; kept 3 days), `dashboard.html` and `dashboard.csv` (`forge dashboard`);
- pacing: `pacing.json` (on or off, written by `forge sync`), `usage.json` (written by the status line), `pacing-notes.json`;
- `forge sync`: `sync-manifest.json`, `settings-managed.json`, `roles.json`.

## Tests

- `npm test`: parser, every rule (all 23 bypasses of the original template's guard among them), file tools, budgets, the done gate, the commit scan, checks after edits, read-only roles, auto-approval, pacing, the git hooks with real commits, the tracker adapters, `forge`, and the entry point end to end. It runs on macOS and Linux (CI: `.gitlab-ci.yml`).
- `node tests/live/live-harness.mjs`: real `claude -p` sessions in a throwaway project, including a person's approval or refusal (an MCP stand-in answers the prompt). Manual, about $0.80 per full run.

## Limits

- **Scripts.** The engine sees commands, not the contents of scripts they run (`bash deploy.sh`, `npm run x`). Script names that look like deploys are asked about; the server catches the rest. A project's own wrapper scripts that run their arguments as a command (for example a toolchain container) are listed in `commands.wrappers`, and the rules then check the command inside.
- **Computed names.** A program that builds a secret file name at run time (`open("." + "env")`) is not caught. The settings' Read rules and the server are the backstop; the sandbox (`sandbox.enabled`) is the OS-level option.
- **Transcript format.** A lane's context size is read from its transcript, whose format Claude Code does not document. If it cannot be read, the call-count limit and the agents' `maxTurns` still apply.
- **Windows.** Not supported yet: tested on macOS and Linux only.
