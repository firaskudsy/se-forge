# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
A project pins an exact version in its `project.json`; `forge upgrade --to <version>` moves it.

## [Unreleased]

### Changed
- **Auto mode works with the kit** (decision 141). The hooks turned every "ask first" into a refusal in auto mode, on
  the belief that nobody would see the prompt, so in auto mode, Claude Code's default since 2.1.283, every approval
  the kit needs was refused and its ticket stalled. A hook's ask still prompts in auto mode, and the classifier can
  deny the call but never approve it silently: auto mode now asks, like the other modes a person watches, and the
  person's approval is recorded for the gates. `dontAsk` and `bypassPermissions` still refuse, as nobody is asked
  there. The cheat sheet and GUIDE.md no longer warn against auto mode.
- `forge llm use` also writes `CLAUDE_CODE_AUTO_MODE_SERVER=0`: only Anthropic's API makes auto mode's checks
  itself, and without it auto mode holds the session on a notice about them.

### Fixed
- `forge timeline` listed Claude Code's own short helpers, which report a stop with no role, no start and no
  transcript, as hundreds of agents "running or cut off" (`agent ×447`). They are counted apart now ("and 451 of
  Claude Code's own helpers, which nobody spawned"), and the dashboard leaves them out of every agent count.

## [0.2.38] - 2026-10-26

### Added
- **`forge llm`: agents on a self-hosted model server instead of Claude** (decision 140, GUIDE.md H). `forge llm add
  <name> --url <address> --model <model> [--key-file <file>]` keeps a server in this machine's settings (never in the
  team repo) and checks it: reachable with the key, serving the model, its context, a tool call. `forge llm use
  <name>` in an app's checkout points Claude Code there from the next session: `forge sync` writes the address, the
  server's model for `opus`, `sonnet` and `haiku`, no attribution block, and a key helper into
  `.claude/settings.local.json`; `forge llm use claude` switches back. The key stays in the Keychain, the Linux
  keyring or a private file, and Claude Code loads it through `core/cli/llm-key.mjs`. The server needs Anthropic's
  `/v1/messages` with tool calls (vLLM, Ollama 0.14+, llama.cpp's server).
- `forge doctor` checks the checkout's model server; the dashboard's kit line names it; pacing is off on it (a
  self-hosted server has no plan windows).
- New rules: agents never read a model server's key or run its key helper (`[llm:key]`), and never choose the server
  (`[llm:person]`).

### Changed
- `project.prices` accepts model names with a `/` (`"Qwen/Qwen3.8-27B"`), as self-hosted servers name them.

## [0.2.37] - 2026-10-26

### Changed
- **`forge dashboard` splits the tokens three ways:** under the Tokens total (and the API cost, when `project.prices`
  is set) the page shows what was **re-read** from the cache, what was **new** (input and cache writes) and the
  **output**, with the re-read share, e.g. `98.7M re-read (93%) · 5.7M new · 2.2M output`. Every reply sends the
  conversation so far again, so cache reads are most of a project's tokens but a small part of its cost. `forge
  dashboard --text` prints the same split (`Tokens: 106.6M = 98.7M re-read (93%) + 5.7M new + 2.2M output`), and
  chart 9's legend uses the same words.

## [0.2.36] - 2026-10-25

### Added
- **OpenProject tracker adapter** (`core/tracker/adapters/openproject.sh`): `project.tracker: "openproject"` runs every
  `forge tracker` command against OpenProject's REST API v3 with curl and jq. OpenProject has no labels:
  `--source`/`--area`/`--repo` go into a `Labels:` line, and `ready` is a status.
- **`project.openproject`** in project.json: `url`, `project` (identifier, id or address), `boards` (name → basic board
  id), `board` (one board's shorthand), `defaultBoard` and `readyStatus`, validated by `forge config check`. Forge passes
  them to the adapter as `OPENPROJECT_*`; a variable already set wins.
- **The API key never in project.json** (`core/tracker/openproject-key.sh`): taken from `OPENPROJECT_API_KEY`, the macOS
  Keychain, the Linux keyring (secret-tool) or a key file readable by its owner only, in that order (GUIDE.md, G). It
  reaches curl on a file descriptor, never in its arguments or output; `forge doctor` names its source, not its value.
- **Several boards:** `list board [<name|id|all>]`; `status` moves the card on every configured board it sits on, to the
  column named like the status, else by a default mapping (In Development → In Process, Done → Complete, …). A board
  OpenProject does not have is named in one line and skipped. With no board configured, status mode: `list board`
  groups by status and no card moves, and `forge doctor` says so.
- `forge init --tracker openproject`; `project.tracker` is validated (gitlab, github or openproject); `forge doctor`
  checks curl, jq, the URL and project settings, the key's source and the boards.
- **Assignees:** `forge tracker create … --assignee "<name>"` (else `TRACKER_ASSIGNEE`) and `forge tracker assign <id>
  "<name>"`, on OpenProject (the user's name, checked against the project's assignable users), GitLab and GitHub
  (the username). Tickets stay unassigned unless the owner names someone.
- **Agents cannot read the OpenProject key** (`[openproject:key]`): not its file, script, keyring entry or
  `OPENPROJECT_API_KEY`. Keyring password prints for any service (`[keychain:password]`), keychain dumps and env dumps
  through `/proc/*/environ`, `ps e`, `declare -p` or interpreters are denied too.

### Changed
- The dashboard has no issue history for OpenProject (it says so) and links a ticket only to the address the tracker gave.
- `docs/cheat-sheet.md` starts with a step by step from a new Mac to a running build, worked through for an example app
  (`demo-app`): the tools, GitLab access, `forge` installed from the kit's GitHub repository, a new app, then
  `/bootstrap` and `/pipeline`.

## [0.2.35] - 2026-10-22

### Fixed
- Questions asked and not answered are no longer lost with the session that asked them (decision 139). Before the lead asks a plan's questions, the plan's status line says `waiting for the owner: Q4, Q6 (asked <date>)` until the answers are recorded; `forge dashboard --text` lists the ticket under "Look at", and the progress report asks its questions again under "Needs the owner". Before, a report written in a new session said "nothing".

## [0.2.34] - 2026-10-22

### Added
- An owner-assistant answers before the owner is asked (decision 138). Before a plan's or an agent's questions go to the owner, the lead spawns `owner-assistant` (read-only, standard tier): it answers what the owner has already decided (the register, an accepted ADR, the story, the contract, the owner's earlier answer), what the owner always took the default on before (3 times or more, never changed), and what the sources leave one way to answer, each with its source. Gate questions, dependencies, cost, scope, new product questions and actions only a person can take always go to the owner. Every answer goes into the new answer log, `.forge/project/owner-answers.md`, and the progress report lists what was answered for the owner under "Decided for you" to change. New skill `owner-answers` with the rules and the log's format.

### Changed
- The planner decides the technical choices inside a ticket's own areas (where a test goes, a helper's shape, a retry count) and lists them under "Decided by the planner" in the plan, instead of asking the owner. The register keeps only decisions that bind later tickets; one-ticket answers go in the plan and the answer log.

## [0.2.33] - 2026-10-17

### Added
- Agents preload their skills (decision 137). Each role names the playbooks every run of it needs (`skills:` in its file; `@backend`, `@frontend`, `@mobile` and `@database` stand for the project's stack guides, from `project.stack`), and `forge sync` writes them into the agent file, so Claude Code loads them before the agent's first turn: an engineer starts with its stack and database guides, a code reviewer with the guides it checks against. In lunch-pool's history only the planning roles had ever opened a skill. A missing skill, a person-only skill or an unknown placeholder stops the sync.
- The dashboard's **Agents & skills** tab: when sub-agents ran and the skills each had (preloaded, or opened itself), by day, by role and by skill; the skills a role's instructions name and it never used; the skills never used, with other stacks' guides apart; and what the lead did itself, including the app's own files it edited. The Tickets tab names each agent's skills, `forge dashboard --text` has a Skills line, and the hook records each agent's preloads on its start line.

## [0.2.32] - 2026-10-17

### Added
- Every question, approval or action the kit needs from the owner comes as a short choice, in every phase: pick one (lettered, the recommended first), tick any (`[ ]`), yes/no, or free text only when nothing fits. The lead asks with AskUserQuestion in the session, and written lists (progress report, board digest, plan questions, panel summary) number the questions so the owner replies `1A 2B`. New `core/LEAD.md`, injected into the main session only, and skill `ask-owner` with the formats; the pipeline, bootstrap, discovery, progress report, triage, plan, panel, spec, ticket, release, onboarding and architecture skills and `/next-ticket` follow it (decision 136).

## [0.2.31] - 2026-10-16

### Changed
- The dashboard's Tickets tab lists every ticket, the ones nobody has picked yet too: the bootstrap's, and the board's issues filed since (follow-ups, bugs; epics left out), with a Status column from the board (`Todo`, `In Progress`, `Done`, `Closed`; from the records when the board has not been read). With `--days`, every ticket still to do stays in the table. `dashboard.csv` has the same rows and a `status` column after `title`, and `forge dashboard --text` lists the board's unpicked tickets under Not started (decision 135).

## [0.2.30] - 2026-10-15

### Changed
- `docs/` holds what a user needs: the cheat sheet, the metrics reference, every numbered decision (`docs/decisions.md`) and the system mode plan. The phase records and the audit of the original template are gone.

## [0.2.29] - 2026-10-15

### Added
- The MIT license (`LICENSE`).

### Changed
- README.md: what se-forge is and how it works, with its flow (and the whole flow from GUIDE.md under it), the agents, skills, safety layer, quality bar and stacks, a quick start for a new app and for an existing system, the commands and the dashboard's tabs.
- The guide and the examples are ready for a public repository: `gitlab.example.com` stands for your GitLab server and `~/code/se-forge` for the kit's folder; no machine paths or personal names.

### Removed
- The local team demo (`demo/`); the live trials keep its users portal workspace (`tests/live/portal.mjs`).

## [0.2.28] - 2026-10-15

### Added
- System mode, phase S1 (decisions 130-134): an existing system of several repositories, built in by one lead.
  - `forge system check [<system.json>]`: the system's description (its repositories with their own base, release and deploying branches, the board, databases, services, environment variable names), checked; a value is refused.
  - `forge system init --system <slug> --from <system.json>`: every repository cloned side by side into `~/code/<slug>` (its `origin`, branches, CI and deploys unchanged; nothing of the kit committed to it), each linked to the system's team folder with its own settings (`repos/<repo>/project.json`), and the workspace root made the lead's home.
  - `forge lane open <ticket> [--review]` / `forge lane close <path>`: the lead's worktree for one agent in the repository the plan's `Repo:` line names. The hooks judge every call by the repository it acts on, refuse an engineer without a lane, and keep agents out of a member's main checkout; a lane's gates are its repository's.
  - `forge merge <ticket>` from the workspace root merges in the ticket's repository and closes the issue on the system's board; into a branch that deploys it stops with `READY FOR A PERSON` (exit 3) unless the description says `"merge": "lead"` (decision 133).
  - `forge doctor` at the root checks the description and each repository (in the workspace, linked, its gate, its branches on origin) instead of the root's own gate and branches; `forge worktrees` there lists every repository's lanes.
  - `forge tracker create --repo <name>` (the `repo::<name>` label); `forge dashboard` at the root reads every repository's merges, with a Repo column and filter in the Tickets tab, and the board's issues.
  - GUIDE.md part F; the pipeline and plan-ticket skills' system rules.

### Changed
- GUIDE.md: the whole flow shows an existing system (part F), a ticket parked at its limit and lifted by you, and the merge into a deploying branch you make.

## [0.2.27] - 2026-10-15

### Fixed
- The dashboard's Tickets tab: Tokens, Cost, Agents and Rounds come right after the title, a long title is cut to one line (the whole of it on hover), and ▸ is a visible button. Before, long titles pushed Tokens off the screen, behind a sideways scroll macOS hides. The Agents column, the CSV and `forge dashboard --text` count the agents ▸ lists (the ones with a job or tokens), not every agent id a ticket's lines mention (lunch-pool's #2: 20, not 95).

## [0.2.26] - 2026-10-15

### Added
- The dashboard's Tickets tab: ▸ opens a ticket's agents one by one, each with the job its spawn named, its model, tokens, cost, time and start, and the lead's own turns for the ticket last (decision 129). They add up to the ticket's tokens, and sorting keeps them under their ticket.
- The dashboard's Tickets tab: a ticket's number opens its issue on GitLab or GitHub, at the address the tracker gave for it, else one made from the repository's `origin` remote (decision 128).

## [0.2.25] - 2026-10-15

### Added
- The circuit breaker (decision 127): every ticket has limits, by default 4 engineer lanes, 2 review rounds with blockers and 2 QA fails (`policy.limits`). The hook counts them for the ticket an engineer spawn names (its description, or the plan its prompt names), from the spawn records and the team repo's review history, unsaved reports included, and refuses the next engineer lane at a limit: the lead parks the ticket (Blocked, with the reason), tells the owner and takes the next one. An engineer lane that names no ticket asks the person. Only a person lifts a limit, with `forge limits lift <ticket>` (one more allowance of each); the hook refuses it from Claude. `forge limits` shows each open ticket's use, and the dashboard's Look at names a ticket at its limit.

## [0.2.24] - 2026-10-15

### Added
- `forge dashboard --watch` (decision 126): a new page every 5 minutes (`--every <minutes>`, at least 1) until Ctrl+C. The open page reloads itself after each build, on the same tab, with the same sections open and at the same place: it checks a stamp written next to it every 10 seconds, reloads only for a newer one and only once per build, and says when the watch has stopped. A failed build is reported and tried again at the next round.

## [0.2.23] - 2026-10-14

### Fixed
- Screenshots for projects whose end-to-end tests predate them (decision 125): `forge doctor` warns when a Playwright config (or a Flutter app's integration tests) cannot keep pictures for the dashboard, and counts the pictures kept. At its start the lead files the one-line fix as a chore whose QA records every screen, or, when the tests can take pictures but none were kept after UI work, has the QA engineer record them once from `dev`. QA says so when a run records nothing instead of passing in silence.

## [0.2.22] - 2026-10-14

### Added
- The dashboard's **Architecture** tab (decision 124): the components as designed (the architecture overview's C4 diagrams) and as they run (the Compose file's services); the requirements (the client's, the roles, the stories) with **Download the SRS**, which puts every part into one document in the usual SRS order; the architecture overview, the decision records, the non-functional requirements and the evaluations from the base branch (a newer or never-approved draft is marked); the API's operations at the pinned contract; and the standards from the project's settings and the register's overrides. Every document is readable in the page and downloads as Markdown. Mermaid diagrams are drawn with Docker when the page is built, all new ones in one run, and kept by their text.

## [0.2.21] - 2026-10-14

### Added
- `forge app` (decision 123): the project's app on this Mac. It finds the app's Compose file (the one no other includes: the root, or `frontend/` with the backend's, `backend/`, `mobile/` and so on) and reads its services and ports with `docker compose config`; `forge app` shows what runs and where to open it, `forge app up` builds, starts, waits until healthy and opens the app (`--fresh` after a dependency change), `forge app down` stops it and keeps the data. It says when Docker is not running.
- The dashboard's **Run the app** tab: whether the app answers now (the page checks its address every 5 seconds), the steps with a Copy button for each command, the services with their addresses, and the code the app is built from.

## [0.2.20] - 2026-10-14

### Added
- The dashboard's chart 3, **Issues over time** (decision 122): every issue in the tracker by its status from its creation to now, stacked as open, in progress, In Testing and closed (epics left out), with the counts at any moment on hover. `forge dashboard` reads each issue's label and state history from GitLab (resource events) or GitHub (issue events), eight at a time, and keeps it in `.forge/state/issues.json`, so later builds fetch only the issues that changed; when the tracker cannot be reached, the chart is the last read and says why. `--offline` skips the read. `forge dashboard --text` prints the counts as its `Issues:` line, which the progress report copies. The charts after it are renumbered (4 to 12).

## [0.2.19] - 2026-10-14

### Fixed
- After a kit upgrade, `/resume` carried on from the lead's handover, which still held the old kit's rules ("never move or close them"), and never read the new pipeline skill: lunch-pool's lead, upgraded to 0.2.18, still asked its owner to accept 21 merged tickets. Now `/resume` for the lead re-reads the pipeline skill and runs its start-up checks first; the lead's handover starts with `Kit: <version>`, and when that is not the active kit the session briefing says the kit changed, points to `.forge/kit/CHANGELOG.md` (now part of the kit copy) and has the lead follow the skills where the handover disagrees (decision 121).

## [0.2.18] - 2026-10-14

### Changed
- Finished tickets close by themselves (decision 118, revising 88): once `forge merge` has merged a ticket into `dev`, it moves the ticket to Done with a comment naming the merge, which closes its issue. The owner checks the app when promoting `dev` to `staging` and `main`. At start-up the lead also moves tickets still "In Testing" after their merge to Done. The hook allows a done status from `dev` when the ticket's own branch passed the gates on a commit merged into `dev`, and checks every done status in a command, not only the first (decision 116).
- Work with no branch of its own (only the team repo or a setting changed) closes once every review report for it approves (decision 120); with no approving report, the hook asks the person instead of refusing. An agent is still refused.
- Follow-ups join by themselves (decision 119, revising 115): when the build's own tickets are merged, the lead takes the follow-ups the project manager rates P1 or P2 and the decision register covers, in one round. P3, new scope and fixes to the kit itself wait for the owner, one line in the progress report. A follow-up's review still files nothing, so the build ends.
- What waits for the owner is a list of questions answered in the session; the lead never sends the owner to GitLab or GitHub for a step it can take (pipeline step 7).
- Released tickets close (decision 117): the `staging` → `main` merge request carries one `Closes #<id>` line per open ticket of the release, and after the tag the release moves any still open to Done. Moving an already closed issue to a done status changes only its label.

### Fixed
- The hook no longer takes the team repo for the project. After a `cd` into the team repo, the rules, the config and the state stayed the team repo's, so a done claim found no branches and asked the person for every ticket in the command at once (a live run closed an unmerged ticket that way). A repository with no forge setup now keeps the session's project, and a done claim is checked in the folder its command `cd`s into (an unreadable `cd` is refused). Docs roles started in the team repo can write the project's documents again.
- `glab issue close`, `gh issue close` and a done status label set through the host's CLI are checked like `forge tracker status <id> Done`; before, they went around the check.
- `forge tracker status` exits non-zero when it cannot read, relabel or close an issue; before, it reported success.

## [0.2.17] - 2026-10-14

### Added
- The requirements panel (decision 114): a new bootstrap stage 7, before the owner's single review (now stage 8; after approval is stage 9). Seats for the backend, frontend, mobile, database, security, QA, architecture, tickets, devops and performance read the drafts at once, each through its own checklist (skill `requirements-panel`). The lead decides each finding (apply, owner, reject), reruns only the stages it touches, once, and opens the owner's review with the panel's result. The new read-only role `requirements-reviewer` takes the engineering seats; the security reviewer, the architect, the project manager and the performance reviewer take their own. Read-only roles may now write `.forge/project/bootstrap/panel/`, and their panel reports are handed over from their worktrees.

### Changed
- Follow-ups (decision 115): a review finding that is not a blocker is fixed in a blocker round's fix lane when it is in the branch's own code, and otherwise stays in the report. A finding elsewhere becomes a `[Follow-up]` issue, but never from the review of a ticket that is itself a follow-up. Follow-ups join the build only when the owner names them, from one line in the progress report; the rest wait until the build's own tickets are merged.

## [0.2.16] - 2026-10-13

### Added
- The dashboard page (under its title) and `forge dashboard --text` (its `Kit:` line) name the se-forge version the checkout runs, with the project's pin when it differs (`forge sync`) and the `forge` command's version when it differs. The lead's progress report copies the line.

## [0.2.15] - 2026-10-13

### Added
- The lead reports progress to the owner after each merge into `dev`, and on `/progress-report` (skill `progress-report`, decision 113). The report covers what was merged since the last one, what is open and where its time went, what waits for the owner, what the lead is watching and what it does about it, and the forecast. It is shown in the session and saved in the team repo as `progress/<YYYY-MM-DD-HHmm>.md`.
- `forge dashboard --text`: the dashboard's numbers as text, writing no file. It shows the KPIs, the forecast, the scope, the open tickets with their plan's status line and time split, the merged tickets, the waits for the owner, and a "Look at" list. That list flags repeated review blockers, a ticket past its estimate, a blocked plan, a lane stopped with GATES-FAILED and not passed since, and nothing happening for 15 minutes while tickets are open. The lead's settings allow it without a prompt.

## [0.2.14] - 2026-10-12

### Changed
- The files that still carried text from the AI-orchestration template se-forge started from are written in the kit's own words: the tracker scripts (now with the shared parts in `core/tracker/lib.sh`), the handover script, template and skill, the skills `figma-align`, `tracker`, `api-sync`, `review-pass`, `pipeline`, `plan-ticket` and `backend-change`, eleven roles, the `/review`, `/qa`, `/figma-check`, `/resume` and `/next-ticket` commands, six lines of `core/AGENTS.md` and the lane's context-budget warning. What they do is unchanged:
  - the tracker commands, labels and output are the same; `forge tracker help` and the error messages are new;
  - a new handover has new section names (Where things stand, Done so far, Remaining, Decisions, Gates on the last commit); the "Remaining" list, the header and the git facts are as before;
  - a plan's second line now starts with `Status:`; the lines tools read (`Areas:`, `Contract:`, `E2E:`, `Branch:`, `Gates:`, `Sources:`, `## Estimate`) are unchanged.

## [0.2.13] - 2026-10-12

### Fixed
- `forge new` with a web app and a mobile app (`--frontend react --mobile flutter`) kept only the mobile app's client command, so `forge api generate` never regenerated the web app's client and agents could edit it. The proposed `project.api.generate` now runs both, each in its own folder, and `policy.paths.generated` protects both.
- `forge new` with several folders gives every folder's `compose.yaml` the same `name:`, the repository's. Unnamed, each folder was its own Compose project named after the folder (`backend`, `frontend`, `mobile`):
  - the web app's and the mobile app's end-to-end tests each started their own database and API on the same ports, so the second failed;
  - a migration run from `backend/` started a second database;
  - every other repository with a `backend/` folder shared the project.
  Projects started before this add `name: <repository>` at the top of each folder's `compose.yaml` (skill `dev-environment`).

## [0.2.12] - 2026-10-12

### Added
- Mobile apps in Flutter (decisions 101-112). The stack guide `stack-flutter` covers Flutter 3.47.7 with Dart 3.13.5, the API client generated from the contract by `forge api generate` (swagger_parser: Retrofit on Dio, freezed), Riverpod 3, go_router, Material 3, gen-l10n in English and Arabic (right-to-left), `Form` validators from the contract, widget and golden tests, and integration tests. It was written from a sample in `tests/stacks/flutter` that really runs (`tests/stacks/run.sh flutter`, against the FastAPI sample):
  - the kit's own dev image, built from Flutter's release tag for arm64 and amd64;
  - integration tests on the Linux build, headless under Xvfb, in a phone-sized window, against the real API;
  - with `FORGE_SHOTS=1`, each flow keeps a picture of its last screen and its record.
- The `mobile-engineer` agent and the plan area `mobile`, wired like `ui`:
  - the engineer runs on its tier, only on an approved contract version, after the ui lane (db → api → ui → mobile → infra);
  - the reviewers check mobile changes: the code reviewer, the security reviewer (secure storage, no secrets in the app, HTTPS only, deep links checked) and the UI reviewer (golden and test pictures);
  - on PASS of a mobile ticket, the QA engineer runs its integration tests with pictures on and records them with the new `forge shot --dir build/forge-shots`;
  - discovery asks about the mobile app (platforms, store accounts, push, offline).
- Skills `new-screen`, `flutter-form`, `figma-to-widget`, `write-flutter-tests` and `mobile-release` (versions and build numbers, store notes, Android from CI, iOS signed by a person on a Mac, the test tracks first). `rtl-i18n-check`, `api-sync`, `dev-environment`, `dockerize` and `write-unit-tests` cover the Flutter app.
- `forge new --mobile flutter --app-id <id>`: the Flutter starter (a home screen in English and Arabic, the shell and language menu, widget, golden and integration tests, the dev image, Compose with the backend's file included), alone or next to `backend/` and `frontend/` in one repository. `tests/starter/run.sh flutter | mobile-fullstack` checks it. CI gets an `android` job for it:
  - the app bundle from the Dockerfile's `android` target (Java 17, Android SDK 36), built for `linux/amd64`;
  - debug-signed on merge requests; on a release tag `vX.Y.Z`, signed with the upload key from protected variables (GitHub: the `release` environment);
  - set up per host in `core/server/<host>.md`, section 4b.
  The Android SDK's licence is accepted in the image (the owner's decision).
- The dashboard's totals show the **working time**: the AI at work over the whole project (agents, gates, the lead's turns, each moment once), without the waits for you and without the stretches of 15 minutes with nothing happening, such as a laptop asleep or a closed session. It is chart 1's top lane, added up.

### Fixed
- The Flutter dev image holds the source, so CI's gate runs on it.
- `forge new` copies binary files (app icons, golden pictures) byte for byte.

## [0.2.11] - 2026-10-11

### Added
- `forge shot` keeps a picture of the app with its time, ticket, branch, commit and what it shows, in the project's folder in the team repo (`shots/`): `forge shot <image> "<what>"`, or `forge shot --playwright <report.json>` for the last screen of each passed end-to-end test. Large pictures become a JPEG 1280 px wide (decision 100).
- When a ticket whose plan includes `ui` passes QA, the QA engineer runs its end-to-end specs once more in Chromium with `FORGE_SHOTS=1` and records the pictures with `forge shot --playwright`. The React starter's `playwright.config.ts` takes a picture of each test's last screen when `FORGE_SHOTS` is set; projects started before this add `screenshot: process.env.FORGE_SHOTS ? 'on' : 'off'` under `use` (skill `write-e2e`).
- `forge dashboard` shows the pictures: a camera under the day on the project over time, at the time each was taken, links to it in a new **Screens** tab, where they are by day with their time, ticket and what they show. They are inside the page, so it stays one file.

### Changed
- `forge dashboard` shows every time on the 12-hour clock (`2:05 PM`, axis hours `8 AM`), in this Mac's time zone.

## [0.2.10] - 2026-10-11

### Added
- `forge dashboard` puts its charts in five tabs: Overview, Time, Cost, Quality and Tickets. The totals stay on top, and the page remembers the open tab in its address (`dashboard.html#cost`).
- A new first chart, **the project over time**. It has one row per day from the bootstrap on. The AI's lane (agents, gates, the lead) sits above your lane, which shows each wait for you by kind: your reply after the lead stopped, a question, a forge rule's approval, a permission prompt. Merges are marked.
- A **Waiting for you** card: the waits by kind (how many, how long, the longest), and the eight longest waits with the tickets running then. These used to sit under chart 1.
- `forge timeline` gives each wait its kind (`reply`, `question`, `approval`, `permission`).

### Changed
- The dashboard's "Waiting for you" total is now the whole project's, bootstrap included, with each wait counted once. It used to add up each ticket's waits.

## [0.2.9] - 2026-10-10

### Added
- Cost charts in `forge dashboard`: cost per ticket by stage (planning, building, reviews, QA, lead), who spends it on which model (each role split by model, with the cost of one spawn), what each model's cost is made of (input, cache writes, cache reads, output) and spend per day. They show dollars with `project.prices`, tokens until then. The KPIs add the Opus share, and the CSV adds tokens per stage.
- `GUIDE.md` part E, "Measure and improve": what the timeline records, the import, `forge timeline`, the dashboard's charts and what to look for, and setting prices. Part C explains how a pipeline run behaves now (normal permission mode, estimates, models, no `/clear`, `/pause`); upgrading installs the matching `forge` first.

## [0.2.8] - 2026-10-10

### Added
- `forge dashboard`: one local page with six charts and a ticket table, plus a CSV. The charts: where each ticket's time goes, tokens or cost per ticket by model, who spends the tokens, rework after the first blocker, a friction map of refusals and failures by role, and progress against the stories with a forecast. It joins the timeline with the bootstrap's stories and tickets, the plans, `metrics.md`, the review rounds in the team repo's history and the merges into `dev`; no library, no network.
- `forge timeline import`: the history before the timeline, from Claude Code's own session logs and the recorded gate results, with every reply's exact tokens.

### Fixed
- Timeline tokens: a reply whose first tool call started before Claude Code logged it lost its tokens, and a reply counted while it streamed had a partial output count. A reply's tokens now go on the first line that finds it complete, and the end of each turn and agent counts any reply still missing.
- `forge metrics` counts each reply's final output tokens (it took the first, partial line of a streamed reply).
- Plans get their estimate: the planner writes the Estimate section and the ticket's `metrics.md` row as part of the plan, starting from the bootstrap draft's estimate. Before, the pipeline left it to the lead after planning, and clinic-booking's plans had none.

## [0.2.7] - 2026-10-10

### Added
- Tokens and models in the timeline: each model reply, the lead's and every agent's, once, with its model and its input, 5-minute and 1-hour cache-write, cache-read and output tokens, from Claude Code's own session log. It sits on the reply's first tool call, or on the line that ends the turn. `forge timeline` shows tokens by model and by who and the five costliest steps; the CSV gains `model`, `input`, `cacheWrite5m`, `cacheWrite1h`, `cacheRead`, `output`, `tokens` and `cost`.
- `project.prices` in `project.json`: US dollars per million tokens by model family or name, set by a person. `forge timeline` then shows what the work would cost on the API. Prices apply when the timeline is read, so they can be set later.

### Changed
- Timeline fields: an agent's context size at its end is `context` (was `tokens`); a spawn's model is `agentModel` on its result and `askedModel` for a `model=` given (was `model`), since `model` now names the model of the reply on every line.

## [0.2.6] - 2026-10-10

### Added
- A timeline of every session: the hooks append one line per event to `.forge/state/timeline-<YYYY-MM>.jsonl` in the checkout. Each tool call's start and end with its run time, or its error; the kit's refusals and asks with their rule and reason; agents starting, finishing and being sent back by the gates; gate runs; your messages (only their length); the lead's turn ending; compaction, API errors and sessions; and `forge` commands run in a terminal. Every line says who (the lead, the agent's role, you or the kit) and the ticket. No prompts, file contents or command output; secrets are masked. It costs no tokens and never blocks a call.
- `forge timeline [<ticket>] [--days <n>] [--json | --csv]`: where a ticket's time went. It shows how long you were waited for (after the lead stopped, at permission prompts, on questions), the agents' time by role, gate runs and why checks were not ready, refusals by rule, failed calls, API errors, compactions and the slowest calls.

## [0.2.5] - 2026-10-09

### Fixed
- A plan's gates are the names on its `Gates:` line, not words in its notes: "performance (… `docs/architecture/nfr.md` …)" asked a person for an architecture approval before every engineer started (clinic-booking #15). Notes in parentheses, nested ones included, no longer count, for the security gate either.

## [0.2.4] - 2026-10-09

### Fixed
- The end-to-end command (`tests.e2e.command`) runs from the repo root in its own shell after the gate command. Before, it ran in the same shell, so a gate that ended in another folder (as `forge new` writes it for a backend and a frontend: `… && cd ../frontend && …`) made the e2e command's own `cd frontend` fail, and no branch with an end-to-end flow could pass its gates.

## [0.2.3] - 2026-10-09

### Added
- `/pause`: stops the pipeline safely before the laptop closes or goes offline. No new agents, running ones finish and hand over, the agents' worktrees are checked and cleaned, the lead's handover is brought up to date and saved, and it ends with "Safe to close" or what still blocks it.
- `forge worktrees [--clean]`: each agent worktree as running (its agent's process is alive), done (clean, everything pushed), handed over, or unfinished, with the exact handover command; exit 0 when it is safe to close. `--clean` removes only the done ones, unlocking those whose agent was cut off.

### Security
- `git worktree remove --force` asks a person first: it deletes uncommitted work with the worktree.

## [0.2.2] - 2026-10-09

### Changed
- The engineers (database, backend, frontend, devops, QA) always run on their tier's model, Sonnet by default: the hook refuses a spawn that passes another `model` (rule `models:tier`), and the roles and the pipeline no longer suggest Opus for them. Opus stays with the planner, the analysts, the designer and the security reviewer.
- The lead no longer stops for `/clear`. At its handover line it brings `lead-handover.md` up to date and keeps working; `forge init` and `forge sync` set Claude Code's `autoCompactWindow` 100k past that line, so the conversation compacts there and the session briefing points the lead back to its handover.
- The project manager runs only before each ticket is picked; the 30-minute board check timer is gone (it doubled with every new session).

### Security
- Client projects no longer load the person's claude.ai connectors (mail, documents, calendars and the like): `forge init` and `forge sync` set `disableClaudeAiConnectors` in `.claude/settings.local.json`, and `forge doctor` fails without it.
- The hook refuses every MCP tool except Figma's (`project.figma.toolPrefix`) and the prefixes in the new `policy.mcp.allow`, including reading another server's resources (rule `mcp:not-allowed`). The safety rules cannot see what an MCP call does.

### Added
- `forge doctor` checks Figma's MCP server (installed and logged in) when the project's screens are in Figma.

### Fixed
- Reviewers, QA, the architect and lanes handing over could no longer save their documents: since Claude Code 2.1.295 an agent in its own worktree may not write the main checkout. They now write at the usual `.forge/…` path inside their worktree, and the `subagent-stop` hook copies the files to the main checkout: handovers from every lane, reports from reviewers and QA, and `.forge/project/` documents from docs-only roles, never `project.json`, the kit overrides or over a newer copy. An engineer cannot hand over a review report. `forge handover` run in a lane's worktree scaffolds the file there.
- The default Figma tool prefix is now `mcp__plugin_figma_figma__`, the names Figma's Claude Code plugin (`claude plugin install figma`, server `plugin:figma:figma`) gives its tools; `mcp__figma__` matched only a server added by hand as `figma`. Set `project.figma.toolPrefix` for such a server.

## [0.2.1] - 2026-10-08

### Added
- `GUIDE.md`: from a new MacBook and GitLab to an app built from client requirements, with two ways to install `forge` (the local kit folder or GitLab).

### Fixed
- `forge new` from a forge installed with npm wrote no `.gitignore`: npm leaves every `.gitignore` out of an installed package, so `.env` and dependency folders could be committed. The templates keep it as `_gitignore`, written as `.gitignore`.

## [0.2.0] - 2026-10-08

### Added
- Full-stack roles: `backend-engineer`, `db-engineer`, `security-reviewer` (OWASP ASVS Level 2), `db-reviewer`, `spec-checker`.
- Ticket areas (ui, api, db, infra) in the plan's `Areas:` line pick the engineers, in the order db → api → ui, and the reviewers.
- Contract first: OpenAPI 3.1 in the backend repo, approved in its own merge request and tagged `api-v<semver>` by a person. Editing the spec and creating `api-v` tags ask a person; API and UI lanes start only on a tagged or pinned version.
- `forge api check | fetch | generate` (Redocly CLI 2.59.0, oasdiff 1.33.0) and a `contract` CI job for GitLab and GitHub.
- Skills: `api-contract-design` (with the team API style), `data-model-design`, `threat-model`, `new-endpoint`, `add-entity`, `db-migration`, `integrate-api`.
- `project.api.{spec,contractRepo,pin}` and `project.db` in `project.json`; `forge doctor` reports the contract.
- Stack guides `stack-dotnet` (.NET 10), `stack-nestjs` (NestJS 12, Node 24) and `stack-fastapi`, and database guides `db-postgresql`, `db-sqlserver`, `db-mysql`, `db-mongodb`, each with a `project.json` snippet, a Dockerfile and examples copied from running samples.
- `tests/stacks/`: the samples and `run.sh` (gate, migrations up/down/up on a fresh database container, the image answering requests), and a React sample for Vitest + Testing Library and Playwright.
- Skills: `spec-writer`, `estimate` (hours as a range), `write-unit-tests`, `write-e2e` (Playwright), `fix-failing-test`, `commit-pr`.
- Every skill ends with a definition of done; a test checks the shape of every skill and that guide examples match their samples.

- Frontend (phase 5a): the `stack-react` guide, verified on a React sample tested end to end against the FastAPI sample in three browsers; skills `figma-to-component`, `new-page`, `form-builder`, `rtl-i18n-check`; `forge design sample` for exact colours from provided screens.
- `project.models`: the model per role tier, per project (`forge sync` renders the agents with it); `forge config check` validates a project.json or a proposal; `forge sync` refuses an invalid one.
- Discovery-first `/bootstrap` (skills `discovery`, `design-intake`), the `project-manager` role (skill `triage`), `report-issue`, the `ai::ready` queue, register-approved libraries (`policy.deps.approved`), and done-needs-tests (`policy.tests`).
- `commands.wrappers`: a project's wrapper scripts (e.g. a toolchain container) are seen through by the safety rules.
- Live end-to-end scenario: a full-stack ticket built by agents and judged by a hidden acceptance test (`tests/live`, `fullstack`).
- Live trials: bootstrap stage 8 after the owner's approval (`afterapproval`), and `/pipeline` through two tickets merged into `dev` one after the other (`pipeline2`), on a stateful fake GitLab (`tests/live/fixtures/fake-gitlab`).
- Containers and CI (phase 5b):
  - local development in Docker Compose with hot reload, the gate, tests and migrations run inside the dev containers (decisions 70-72); every stack sample has a `dev` Dockerfile target and a `compose.yaml` (`tests/stacks/run.sh <stack> dev`); React includes the backend's compose file;
  - CI templates for GitLab and GitHub: `secret-scan`, `gates` in the dev image, `build-image` on every MR/PR and pushed from `dev` tagged with the commit (decision 73); `tests/ci/run.sh` runs them on a Docker-in-Docker machine with a local registry;
  - roles `devops-engineer` and `infra-reviewer`; skills `dev-environment`, `dockerize`, `env-config`, `ci-pipeline`, `pipeline-debug`;
  - branches `dev`, `staging`, `main` in every project (decision 74): `forge init` creates `dev` and `staging`; `forge doctor` reports them and Docker Compose;
  - `forge merge <ticket>`: the lead merges into `dev` when the gates, the tests rule and every review report pass for the branch head and the contract is untouched (decision 75); reviewer reports start with `Verdict:` and `Commit:`.

- Architecture and quality (phase 5c): roles `architect` and `performance-reviewer`; skills `architecture-design`, `adr-writer` (MADR 4.0.0), `c4-diagrams` (Mermaid), `nfr-checklist` (targets and capacity math), `tech-evaluation`, `load-test` (k6 against the local stack only; `k6 cloud` refused); `forge docs check`; an architecture stage in `/bootstrap`; `Gates: performance` on plans (decisions 76-77).
- The starter and the team's routines (phase 6): `forge new` writes a working skeleton for FastAPI + PostgreSQL, NestJS + MySQL, .NET + SQL Server or NestJS + MongoDB, and React (decisions 78-81), checked by `tests/starter/run.sh`; `forge metrics` counts a ticket's tokens from the local session logs (decision 84); skills `release` (decision 82), `dependency-update` (decision 83), `retro` (decision 85), `debug-issue`, `onboard-repo`, `handover-docs`; `docs/cheat-sheet.md` and `docs/metrics.md`.
- A Stop hook sends the lead back once to `forge save` plans and reports it left unsaved.
- Per-file edit and commit checks may name their folder (`"dir"`), for a repository holding several services.

- A local team demo (`demo/`): `setup.mjs` builds a workspace with the users portal, ready tickets on a fake GitLab, an empty repository for `forge new` and, with `--discovery`, a project for `/bootstrap`; `teardown.mjs` removes it and only the Docker resources it made; `README.md` is the script.

### Changed
- **Breaking:** the policy setting `branches.main` is now `branches.base` (default `dev`), with `branches.promote` (`staging`, `main`); all three are protected. `forge init` no longer takes `--main`.
- Stack guides run the gate, per-file checks and migrations through `docker compose run` in the dev container.
- CI templates: the `gates` job runs inside the service's dev image instead of a toolchain image set by hand; the server guides add `build-image` to the required checks, Docker-in-Docker runners and the registry.
- `plan-ticket`, `review-pass`, `pipeline`, `/ticket` and `api-sync` route by area and follow the contract; the client is generated from the pinned version.
- `security-reviewer` and `spec-checker` review every PR/MR (opus for the security review of gated or sensitive changes).
- `backend-change` and `bootstrap` work from the pinned contract version instead of a live spec URL.
- Edit checks receive `{file}` repo-relative, so they work inside a toolchain container.
- The stack samples' test setups migrate up, all the way down and up again on every gate run.

### Fixed
- Variables set in front of a container command (`BASE_URL=… docker compose run k6`, `DATABASE_URL=… docker compose run api …`) reach the container through compose interpolation but were not checked; a service run with no command was not checked at all (found rehearsing the demo).
- A path through a symlink to the repository (macOS `/var`, a `~/code` link) fell outside every repo-relative rule: writing the stories file, an applied migration or generated code through it was allowed.
- `[Story conflict]` and `[Backend request]` issues filed by agents now carry `source::ai` (decision 46); the planner's commands left it out (found in the pipeline trial).
- A container run without a command (`docker compose run -e DATABASE_URL=… api`) hid its `-e` values from the rules.
- Commands run in containers (`docker compose exec|run`, `docker exec|run`, podman, nerdctl) were not checked by the safety rules: `docker compose exec api uv add x` changed dependencies without asking.
- Changing a container image (a Dockerfile's `FROM`, a compose file's `image:`) did not ask, unlike other dependency changes.
- `glab ci get --with-variables` could print pipeline variables; it is refused.
- Commands inside shell loops, conditions and `{ }` groups were not checked by the safety rules (`for …; do git push origin main; done`).
- A done ticket status set through `forge tracker status` skipped the done gate (only the tracker script was caught).
- Read-only reviewers can write their reports again (the policy still limits them to `paths.reports`).

## [0.1.0] - 2026-10-07

The first version of se-forge, built from a single developer's frontend-only Claude Code template.
Its decisions: `docs/decisions.md`.

### Added
- Policy engine (`core/policy/`, Node.js 22+, no dependencies), wired as Claude Code hooks. It fails closed and parses shell commands, so all 23 bypasses found in the audit are closed.
- Lanes: a context budget, no sub-agents, and a stop after too many calls without an edit.
- Done gate: an engineer lane can't finish, a PR/MR can't be marked ready, and a ticket can't move to a done status without green gates on the pushed commit.
- Approval gates: merges, production and infrastructure are refused. Security-sensitive changes, CI and config ask a person, and the approval is recorded per branch. An ask becomes a refusal when no person can answer.
- Secret scan on `git commit` (gitleaks, or built-in patterns); format, lint and type-check rules after edits; read-only reviewer roles.
- `forge` CLI:
  - `setup`, `init`, `sync`, `upgrade`, `doctor`, `save`, `gates`, `tracker`, `handover`, `pacing`, `version`;
  - copy-per-checkout delivery, with every kit file excluded from git;
  - a version pin per project and overrides per project in the team repo;
  - rules injected at session and lane start.
- Git hooks for people and agents: no kit files, no secrets, the project's commit checks, Conventional Commits, and the co-author line as the project decides (Claude Code's own attribution included). An existing hooks path (husky, lefthook) still runs.
- `/ticket`: light mode, the default. One agent goes from plan to a ready PR/MR, with separate read-only reviewers.
- GitLab tracker adapter (`glab`), with status labels, issue links and board columns.
- Opt-in pacing per developer on a subscription. New agents are paused near the plan's limit, and work resumes at the reset.
- The project's folder in the team repo is an additional working directory for Claude Code, so plans and reports need no prompt per file; the hooks treat its real paths as `.forge/project`.
- Server checklists and CI jobs for GitHub and GitLab; the kit's own GitLab CI.

### Changed
- Tool-neutral roles in `core/roles/`, rendered into Claude agents. Shared rules are 5 KB (were 15 KB).
- Plans, reviews and bootstrap artefacts live in the team repo (`.forge/project/`), not in the client repo.
- `review-pass` can be loaded by the lead and by `/ticket`. The `bootstrap-project` skill is now `bootstrap`.
- The pacing status line is Node, needs no jq, and writes to `.forge/state/`.
- Writes to a project's kit overrides (`.forge/project/kit/**`) ask a person.

### Removed
- `init.sh` and the bash hooks, replaced by `forge` and the policy engine.
- OpenProject adapter and Jira stub (GitHub and GitLab only).
- Commands that never ran because a skill of the same name took precedence: `pipeline`, `backend-change`, `plan-ticket`, `handover`.
- `frontend-engineer-complex` (spawn `frontend-engineer` with `model=opus`), the original author's `.omc/` state, and the budget text repeated in every role.

### Fixed
- GitHub tracker adapter crash on macOS's bash 3.2; a dry run that still created labels.
- `/bootstrap` and `/review` invoked skills that only a person can start, so they did nothing.
- Handover script failing when `.forge/handoffs/` did not exist.
- `forge tracker help` without the tracker's CLI installed.
