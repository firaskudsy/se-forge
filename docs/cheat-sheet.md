# se-forge cheat sheet

One page for the team. Details: the README, the skills (`core/skills/`), and `docs/decisions.md` for why.

## Step by step, from a new Mac
The team's GitLab is https://git.lightring.dev, group `ai` (https://git.lightring.dev/ai); you need an account there
with access to the group. Every step in detail: GUIDE.md, parts B and C.

The example: a new team member, `user@example.com`, starts the app `demo-app` for the client "Demo Client", whose
requirements are in `~/Downloads/demo-app-requirements.pdf`. For your own app, change those four.

**1. The tools.** Skip the Homebrew line if you have it. Then open Docker Desktop once, and log in to Claude Code
(`claude`, then `/exit`).
```
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install node git jq glab gitleaks
brew install --cask docker
curl -fsSL https://claude.ai/install.sh | bash
```

**2. GitLab access.** Add the SSH key in https://git.lightring.dev (avatar → Edit profile → SSH Keys), and make a
token with the scopes `api` and `write_repository` (Access tokens) for glab.
```
ls ~/.ssh/id_ed25519.pub || ssh-keygen -t ed25519 -C "user@example.com"
pbcopy < ~/.ssh/id_ed25519.pub
ssh -T git@git.lightring.dev                       # "Welcome to GitLab, @your-name!"
glab auth login --hostname git.lightring.dev       # paste the token, choose SSH
glab config set -g host git.lightring.dev
```

**3. forge and the team repo.**
```
mkdir -p ~/code && cd ~/code
git clone git@git.lightring.dev:ai/se-forge-projects.git
npm install -g git+https://github.com/firaskudsy/se-forge.git#v0.2.41
forge setup --team-repo ~/code/se-forge-projects --kit-repo https://github.com/firaskudsy/se-forge.git
forge version                                    # 0.2.41
```
Figma projects: `claude plugin install figma`, then log in through `/plugin` (GUIDE.md, B8).

**4. A new app.** In https://git.lightring.dev/ai → New project → Create blank project: name `demo-app`, private,
with a README. Then:
```
cd ~/code && git clone git@git.lightring.dev:ai/demo-app.git && cd demo-app
forge init --project demo-app --new --client "Demo Client"
git push -u origin dev staging
forge save -m "new project"
forge doctor                                     # ✓ everywhere
```
Protect its branches in GitLab: default branch `dev`; nobody pushes to `dev`, `staging` or `main`; `api-v*` tags by
Maintainers; pipelines must succeed (GUIDE.md, C3).

**5. Plan and build.** Start Claude Code. Auto mode, its default, is fine: routine steps run without prompts, and what the kit needs you to approve still asks you.
```
mkdir -p .forge/project/bootstrap/inputs
cp ~/Downloads/demo-app-requirements.pdf .forge/project/bootstrap/inputs/
claude
```
In Claude Code: `/bootstrap .forge/project/bootstrap/inputs/demo-app-requirements.pdf`, answer its questions, approve
`.forge/project/bootstrap/review.md`, and merge the merge requests it opens. Then `/pipeline next 1`.

**Joining an existing app** (a teammate joining `demo-app` later): steps 1 to 3, then
```
cd ~/code && git clone git@git.lightring.dev:ai/demo-app.git && cd demo-app
forge init --project demo-app
forge doctor
claude
```

## A project
| You want to | Run |
|---|---|
| Start a new project | `/bootstrap <requirements>` in Claude Code (discovery, stories, architecture, screens, contract, tickets, the panel's review, your one review, then the build) |
| The skeleton for a new repo | `forge new --backend fastapi --db postgresql --frontend react` (or nestjs/mysql, dotnet/sqlserver, nestjs/mongodb); a mobile app: `--mobile flutter --app-id com.client.app` |
| Take over an existing repo | `forge init --project <slug> --new`, then skill `onboard-repo` |
| Take over an existing system of several repos | write `system.json`, `forge system check system.json`, `forge system init --system <slug> --from system.json`, fill each repo's gate in `repos/<repo>/project.json`, `forge save`, then `claude` in `~/code/<slug>` (GUIDE.md, part F) |
| Join a project | `forge init --project <slug>`, `forge doctor` |
| Get the team's changes to plans and settings | `git pull` in `se-forge-projects`, `forge sync` |
| Share your plans and reports | `forge save -m "<what>"` (the lead is reminded when it forgets) |
| Run the agents on your own model server | once: `forge llm add <name> --url <address> --model <model> --key-file <file>`; then in the app, at a `/pause`: `forge llm use <name>` (`forge llm use claude` back). The server needs Anthropic's `/v1/messages` with tool calls (GUIDE.md, H) |

## Every day
| You want to | Run |
|---|---|
| Run the app | `forge app up` (builds, starts, waits until healthy, opens it); `forge app` what runs; `forge app down` stops it; `--fresh` after a dependency change. The dashboard's Run the app tab has the steps |
| Run the gate | `forge gates` (the same command CI runs, inside the dev container) |
| One ticket, one agent | `/ticket <id>` |
| The queue, agents in lanes | `/pipeline next` |
| Merge a finished ticket into dev | `forge merge <ticket>` (the lead; it checks gates, reviews and the contract). In a system: in the ticket's repository; exit 3 `READY FOR A PERSON` when that branch deploys |
| In a system: an agent's worktree | `forge lane open <ticket>` (`--review` for reviewers and QA), `forge lane close <path>` (the lead) |
| Ask about the API contract | `forge api check`, `forge api generate` (after a person tags `api-vX.Y.Z`) |
| The tracker | `forge tracker list ready`, `forge tracker get <id>` |
| A ticket's AI cost | `forge metrics <id> --record` |
| Where a ticket's time and tokens went | `forge timeline <id>` (`--days 7`, `--csv`, `--json`; cost with `project.prices`) |
| The project in charts | `forge dashboard` (`--days 14`, `--ticket 11,12`, `--offline`; `--watch` keeps the open page current until Ctrl+C); history first: `forge timeline import` |
| Where the project stands, as text | `forge dashboard --text` (its `Step:` line: where the project is; `Waiting for you:` what is yours to do); the lead's report: `/progress-report` (saved in `progress/`) |
| A merged ticket doesn't work | tell the lead; it files a `[Bug]` naming the ticket (merged tickets close by themselves) |
| Stop for the day, close the laptop, or go offline | `/pause` until it says "Safe to close"; `/resume` in a fresh session later |
| See what the agents left behind | `forge worktrees` (`--clean` removes the finished ones) |
| Answer the kit | Every question comes as choices: pick in the session, or reply like `1A 2B 3[31]` to a written list; your own words always work too. What you answered before, the owner-assistant answers for you; the progress report lists it under "Decided for you" to change |
| A ticket parked at its limit | `forge limits` shows each open ticket's lanes, review rounds with blockers and QA fails (4, 2, 2 by default); `forge limits lift 12` gives it one more allowance (a person only) |

## Branches
`feat|fix|chore/<ticket>-<slug>` from `dev` → merge request into `dev` (the lead merges with `forge merge`)
→ `staging` → `main` by merge requests **a person** merges. Releases: skill `release`, tag `vX.Y.Z` on main; any released ticket still open closes.

## What asks you first, and what is refused
- **Asks:** a new or updated dependency or container image, CI files, ADRs, project.json, security-sensitive paths, the network outside the allowed hosts, remote databases, deletions of folders, `forge new`, contract edits and `api-v` tags.
- **Refused:** pushes to dev, staging or main; force pushes; reading or writing secrets (`.env`); editing generated code, applied migrations, the stories file or the kit's own files; merges other than `forge merge`; load tests against anything but the local stack.
- A refusal says why and what to do instead; don't work around it.

## When something is off
| Symptom | Look at |
|---|---|
| `forge doctor` shows ✗ | the line says the fix (often `forge sync`) |
| The app doesn't start | skill `dev-environment`, "When it misbehaves" |
| CI is red | skill `pipeline-debug` |
| An agent was sent back | its message: gates failed, a test missing, a review blocker |
| Plan usage nearly out | pacing (`forge pacing`): agents hand over, `/resume` after the reset |

## After a release
Skill `retro`: numbers from `metrics.md` (guide: `docs/metrics.md`), what went well, what to change.
