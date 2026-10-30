# se-forge rules for every agent

These rules apply to every session and every agent on a se-forge project. The project's own `CLAUDE.md` / `AGENTS.md` (if any) adds to them and never relaxes them. The "Project facts" block that follows names the project's branch, gate command, stack, stories, Figma file and API client.

## Sources of truth
1. **User stories**: read only the story a ticket cites (page ranges, `grep -n` + `sed -n`), never the whole document.
2. **Figma**: match the frame exactly. Something with no frame is built anyway, in the project's existing design language, in the feature and route of the role that uses it, behind the authorization layer. List it under "Built without a design" in the plan (skill `figma-align`).
3. **API**: use the generated client only. Never hand-edit it, never hand-write a type the spec defines (skill `api-sync`).
4. **Earlier plans** in `.forge/project/plans/` model the format and record decisions already made.

Sources that disagree are never reconciled quietly: stop, put the conflict among the plan's questions, and raise a tracker task (`[Story conflict] …` or `[Backend request] …`; skill `tracker`).

## How work runs
- **Light mode** (`/ticket`, the default): one agent plans, builds and runs the gates. Separate read-only reviewers check the work (skill `review-pass`), then a pull/merge request is opened. **Full mode** (`/pipeline`, large features): the lead plans the queue and runs parallel lanes.
- **Plan before code** (skill `plan-ticket`): `.forge/project/plans/<ticket>-<slug>.md`, with `Areas:`, `Contract:`, `Branch:` and `Gates:` lines, files, tests, risks, and questions with a recommended default each.
- **Decision register.** In a bootstrapped project `.forge/project/bootstrap/decisions.md` answers questions first (cite the D-id); only what it does not cover goes to the owner. Only the leader and the project-manager mark issues `ai::ready`; other agents file problems with skill `report-issue`.
- **Contract first.** The OpenAPI spec is the source of truth for every API. A contract change is drafted by the `contract-analyst`, then the lead's `forge api apply` and `forge merge` (which tags `api-v<semver>`; a breaking one needs the owner); only then does the API work start, and the UI generates its client from that version.
- **Gates need a human.** `Gates: security` (auth, permissions, payments, personal data) and `Gates: architecture` (stack or structure) questions are decided by a human, never by a default. Promotions to staging and main, production and infrastructure changes are always for a human.
- One ticket per lane, one behaviour per commit, exact files. Tests are part of the change.
- Different agents write and review; no one approves work they wrote.
- Waiting on a product decision: it goes into the plan as a question; work that does not depend on it goes on.

## The safety hooks
They stop you, with a `[rule]` reason; don't try to work around them. They cover:
- Pushes to dev, staging and main, force pushes, merges (except `forge merge` by the lead) and approvals.
- Secrets: reading or committing them.
- Edits to generated code, stories, applied migrations, lock files, Terraform state, and the kit's own files.
- Infrastructure applies, production targets, dropping tables.
- Lane budgets and the done gate.

They ask a human first for:
- dependency changes;
- outside network calls;
- non-local databases;
- remote writes;
- deploys;
- deleting folders;
- CI files, ADRs, config, and security-sensitive paths.

Read-only roles (reviewers, scout) may only inspect and write their report.

## Done means
- [ ] The gate command passes on a clean, pushed feature branch (`forge gates` checks it). Lanes cannot finish, and ready PRs/MRs and done ticket states are refused, until it does.
- [ ] Tests (decision 50): every side whose code changed (web, mobile, backend) has new or changed unit tests; when the plan's `E2E:` line names a flow, an end-to-end test changed and passes. The done check enforces both.
- [ ] The UI matches the Figma frame; anything built without a design is listed in the plan.
- [ ] API calls go through the generated client.
- [ ] The plan is updated (done / remaining / decisions); the ticket is moved with a comment (branch, commit, how to test).
- [ ] Code, tests, docs and logs hold no secret, token or test password.

## Git
- Branches (decision 74): `dev` (integration), `staging`, `main` (production). Work on `feat|fix|chore/<ticket>-<slug>` branches from `dev`.
- Conventional Commits, one behaviour per commit; the co-author line follows the project facts.
- Stage explicit paths only (`git add path`, dotfiles included); never `git add .` or `-A`.
- Open a pull/merge request into `dev` and link the ticket. The lead merges it with `forge merge` once the gates and every review pass; promotions to `staging` and `main` are a person's.
- Never commit `.env*` (except `.env.example`), keys or credentials.

## Tracker
All tracker calls go through `forge tracker <get|list|create|status|comment|statuses>` (skill `tracker`). Credentials come from the environment by variable name. Never print, copy or commit a token.

## Context
- Redirect heavy command output to a file and read a summary.
- Read large, generated or PDF files by ranges.
- At the context warning, hand over (skill `handover`): commit, push, write `.forge/handoffs/<name>-handover.md`, stop.
- Only the lead spawns agents; a lane never does.

Agents:
- `planner`, `architect`, `contract-analyst`, `product-analyst`, `designer`;
- `db-engineer`, `backend-engineer`, `frontend-engineer`, `mobile-engineer`, `devops-engineer`, `qa-engineer` (lanes run db → api → ui → mobile → infra);
- `code-reviewer`, `security-reviewer` and `spec-checker` on every PR/MR; `db-reviewer` (db), `infra-reviewer` (infra), `performance-reviewer` (`Gates: performance`) and `figma-ui-reviewer` (ui, mobile) when they apply;
- `project-manager` (triages the board for the leader), `scout`, `tracker-clerk`.

Skills are listed with their descriptions; load the stack guide (`stack-*`) and database guide (`db-*`) the project facts name. The app, its tests and its gate run in Docker Compose (skill `dev-environment`). Started by a person only: `/ticket`, `/pipeline`, `/bootstrap` (a new project), `/backend-change`.
