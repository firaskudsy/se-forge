---
name: tracker
description: How agents use the project's tracker (GitLab, GitHub or OpenProject) through `forge tracker` - read a ticket, list a board or a status, raise [Backend request] / [Story conflict] Tasks with a relation and a board column, move a status by name, comment, look up the exact status names. The adapter loads its own credentials by variable name and never prints them; TRACKER_DRY_RUN=1 shows a write without making it.
argument-hint: "<forge tracker command>"
---

# Tracker (`forge tracker`)

`forge tracker` runs the adapter for the project's tracker: `project.tracker` is `github`, `gitlab` or `openproject`, and `FORGE_TRACKER` overrides it. Agents do not read `.env.local` and never echo a token; the adapter finds what it needs by **variable name**.

| Tracker | Sign-in and settings | Statuses and types | Board columns |
|---|---|---|---|
| GitHub | `GH_TOKEN` or `gh auth login`; `GH_REPO`, `GH_PROJECT_OWNER`, `GH_PROJECT_NUMBER` (`GH_PROJECT_ISSUES_NUMBER`, `GH_PROJECT_FRONTEND_NUMBER` per board) | labels `status:<Name>`, `type:<Name>` | the Status field of a Projects (v2) board |
| GitLab | `GITLAB_TOKEN` or `glab auth login`; `GITLAB_HOST` for a self-managed server, `GITLAB_REPO` | labels `status::<Name>`, `type::<Name>` | label lists: the card gets the list's label |
| OpenProject | `project.openproject` in project.json (`url`, `project`, `boards`, `defaultBoard`, `readyStatus`; forge passes them as `OPENPROJECT_*`, a variable already set wins); the API key from `OPENPROJECT_API_KEY`, the macOS Keychain, the Linux keyring or a private key file (GUIDE.md, G), never in project.json | OpenProject's own statuses and work package types; no labels: `--source`/`--area`/`--repo` become a `Labels:` line in the description, and `ready` is a status (`readyStatus`, default Todo) | the configured basic boards (`list board [<name\|id\|all>]`): `status` moves the card on every board it sits on, to the column named like the status when there is one, else by the default mapping (In Development and Code review → In Process; In Testing, Ready for QA, In QA → In Testing; Ready for Release → To Be Deployed; Done, Closed, Resolved → Complete; Rejected → Canceled; On hold, Blocked, Pending → Pending; Todo and Ready for Development stay). No boards: status mode, `list board` groups by status and no card moves |

On GitLab a related ticket becomes an issue link, on OpenProject a relates relation; on GitHub a "Relates to #<id>" line. `forge tracker help` prints every command:

```bash
forge tracker get <id> [--json]                    # title, status, assignee, description
forge tracker list board                           # each status with its open tickets
forge tracker list status "In Progress"            # also: list open, list ready, list json
forge tracker statuses                             # how the tracker spells its statuses and types
forge tracker create --subject "[Backend request] …" --source ai --description-file body.md \
  --type Task --status Todo --relates <ticket> --board issues --column Pending [--assignee "<name>"]
forge tracker assign <id> "<name>"                 # OpenProject: the user's name; GitLab/GitHub: the username
forge tracker status <id> "In Testing" --comment "<branch, SHA, what to test, known gaps>"
forge tracker comment <id> "<text>"                # a longer one: --file <file>
```

## Rules
- What agents raise is titled `[Backend request] …` or `[Story conflict] …`, carries `--source ai` (decision 46), is a Task in status **Todo** with nobody assigned, relates to the feature ticket (`--relates`), and goes to the **Pending** column of the Issues board.
- Tickets stay unassigned unless the owner names an assignee: only then pass `--assignee "<name>"` on create (or set `TRACKER_ASSIGNEE`), or run `assign`. An unknown name fails with its reason; report it, never guess another user.
- Statuses such as **In Testing** change on the lead's word that review and QA are through, never earlier, and each change carries a comment naming the branch, the SHA, what to test and the known gaps.
- Unsure what a create would send: run it once with `TRACKER_DRY_RUN=1` first.
- When the command fails, report its stderr line word for word. Never fall back to your own `curl`, `gh` or `glab` call with a token.
- The `tracker-clerk` agent does single operations on haiku; when it has to write Task bodies from an alignment report, spawn it with `model=sonnet`.
- A new tracker is a new `core/tracker/adapters/<name>.sh` beside `gitlab.sh`: it defines the eight `tr_*` functions (`get`, `list`, `create`, `status`, `comment`, `statuses`, `ready`, `assign`) and honours `tk_assignee` on create, may use the helpers in `core/tracker/lib.sh`, keeps credentials out of arguments and output, and lists the variable names it reads at the top.

## Done when
- the tracker command succeeded (or its stderr line is reported verbatim);
- created items have the right prefix, type, status, relation and column; status moves carry a comment.
