# Project metrics: the guide

Each project keeps `metrics.md` in its folder of the team repo (`forge init --new` creates it). One row per
ticket, filled when the ticket is closed. The retrospective after each release reads it (skill `retro`).

```
| Ticket | Estimate | Actual | Bugs after release | Rework | AI cost |
|---|---|---|---|---|---|
| #12 | 2-4 h | 1.5 h | 0 | 1 | 2.7M tokens (sonnet 2.4M, opus 359.1k) |
```

## The columns
| Column | What it is | Who fills it, when |
|---|---|---|
| **Ticket** | `#<id>` | the estimate step adds the row when the ticket is planned (`forge metrics --record` adds it if it is missing) |
| **Estimate** | the plan's total range in hours (skill `estimate`, decision 40) | the estimate step, at planning |
| **Actual** | **people's hours** on the ticket: answering questions, reviewing, merging, fixing by hand (decision 86). Not the agents' time | the person who closes the ticket |
| **Bugs after release** | `[Bug]` issues traced to this ticket after it was released | the retro, from the tracker |
| **Rework** | rounds sent back to an engineer by a review or QA blocker (0 when it passed first time) | the person closing, counted from `.forge/project/reviews/<ticket>/` |
| **AI cost** | the tokens the ticket used, by model family (decision 84) | `forge metrics <ticket> --record` |

## How AI cost is counted
`forge metrics` reads Claude Code's own session logs on the machine that ran the ticket
(`~/.claude/projects/<the checkout>/`):
- **Agents:** every agent the lead described with the ticket's number ("API lane ticket #12"), or, when the description names no ticket, every agent that worked mostly on the ticket's branch.
- **The lead:** its own replies while those agents ran.
- **Tokens:** input, cache writes, cache reads and output, each reply once. Cache reads are most of the count and cost far less than the rest; compare tickets with each other, not with a price list.

Limits: only the machine that ran the ticket has its logs, so run it there; work outside an agent's
time window (a lead's planning chat before the first agent) is not counted; tickets run at the same time
share the lead's window.

## Reading it
- **Estimate accuracy:** the share of tickets whose actual hours fall in the range. Consistently above it: the plans miss work (look at the reviews' blockers); below: ranges are padded.
- **Rework and bugs after release** together show where quality is lost: blockers caught in review are cheap, bugs after release are not.
- **AI cost** by ticket size: a ticket far above others of its estimate usually means a lane restarted, a context handover, or a plan that was too broad. Its handover files and the lead's notes say which.

## Where the time went: `forge timeline`
The hooks log every step of every session to `.forge/state/timeline-<YYYY-MM>.jsonl` in the checkout, one
JSON line per event (decision 96). The hooks write it, not the agents, so nothing is skipped; it costs
no tokens.

```
forge timeline 12            one ticket
forge timeline               the last 7 days (--days 30), then each ticket
forge timeline 12 --csv      every line, for a spreadsheet (--json: one JSON object per line)
```

```
#12 · 10 Oct, 09:02 → 10 Oct, 13:12 · 4h 10m
  waiting for you   1h 32m in 5 waits
                        41m  your reply after the lead stopped (10:15)
                        23m  permission: Bash git push -u origin feat/12-auth (11:02)
  agents            9 spawned · 2h 05m of agent time
                    backend-engineer ×4              1h 10m  sent back 2× by the gates
                    and 12 of Claude Code's own helpers, which nobody spawned (no role, no transcript)
  gates             5 runs in 6m: 3 passed, 2 failed · 4 not ready: Uncommitted changes ×3, … has no upstream
  refused           9: models:tier ×3, gate:security ×2, output:heavy ×2, …
  failed calls      14: Bash npm run ×5, Bash git push ×2, Edit ×2 · 1 interrupted
  API errors        1: rate_limit
  compactions       lead 2 · agents 1
  slowest calls         16m  backend-engineer  Bash git fetch origin
  tokens            41.2M: opus 22.3M, sonnet 18.9M
                    by who: lead 15.1M, code-reviewer 9.8M, backend-engineer 9.1M, security-reviewer 7.2M
  cost              $38.40 at the API prices in project.prices
  costliest steps     402k    $1.10  security-reviewer  Read src/auth/session.ts
```

### What a line holds
`at`, `event`, `who` (`lead`, the agent's role, `human` or `kit`), `agent` (the lane's id), `ticket`,
`branch`, and per event:

| Event | When | Also |
|---|---|---|
| `tool.start`, `tool.done`, `tool.fail` | an agent's tool call starts, ends, fails | `tool`, `what` (the command, the file, the agent spawned), `ms` (the tool's own run time), `why` (the error), `interrupted`; on a spawn `askedModel` (a `model=` given) and, when it returns, `spawned` (the agent's id) and `agentModel` |
| `tool.refused`, `tool.ask` | the kit refuses a call or asks you; Claude Code itself refuses one (`rule: permission`) | `rule`, `why` |
| `agent.start`, `agent.stop`, `agent.sent-back`, `agent.gates-failed` | a lane starts, finishes, is sent back by the gates, gives up on them. A stop with no role, no start and no transcript is one of Claude Code's own helpers: no agent count includes it, and `forge timeline` names how many | `context` (its context size at the end) |
| `gates.pass`, `gates.fail`, `gates.not-ready` | the gate command ran, or the check stopped before it (uncommitted changes, nothing pushed, no tests) | `by`, `ms`, `why` |
| `prompt`, `agent.notify` | you send a message (only its length and a slash command's name); a background agent wakes the lead | `chars` |
| `turn.end`, `turn.sent-back`, `turn.fail` | the lead stops and waits for you; the save reminder sends it back; an API error (rate limit, overload) | `why` |
| `session.start`, `session.end`, `compact.start`, `compact.end` | sessions and compaction | `source`, `trigger` |
| `forge.done`, `forge.fail` | a `forge` command you ran in a terminal (an agent's are its tool calls) | `code` |

Never logged: your messages, file contents, command output. Commands and paths are cut to 120
characters and errors to 300, with tokens, passwords and keys masked.

### Tokens and cost
Each model reply, the lead's and every agent's, is counted once with its model (decision 97):
- **Where:** on the first line that finds the reply complete in Claude Code's session log: a tool call's start or end, or, for a reply that makes no call, `turn.end`, `turn.sent-back` (the lead's answer), `agent.stop`, `agent.sent-back` or `agent.gates-failed` (a lane's report). Other lines name the reply without its numbers. At the end of each turn and each agent, a finished reply that no line counted yet gets a `reply` line of its own.
- **Why "complete":** Claude Code writes a reply while it streams, one line per block. Every line has the input and cache counts, but only the last one, with the stop reason, has the final output count. A reply's first call can even start before the reply is in the log.
- **Fields:** `model`, `reply` (the reply's id), `input`, `cacheWrite5m` and `cacheWrite1h` (prompt-cache writes that last 5 minutes or 1 hour), `cacheRead`, `output`, and `tokens` (their sum). They match Claude Code's own session log exactly. In clinic-booking the lead's session wrote the 1-hour cache and the agents the 5-minute one.
- **Report:** tokens by model and by who, and the five costliest steps. The CSV adds the columns `model`, `input`, `cacheWrite5m`, `cacheWrite1h`, `cacheRead`, `output`, `tokens` and `cost`.

**Cost.** You're on a subscription, so this is what the same work would cost on the API, not what you
pay. To see it, add the prices once to the project's `project.json`, in US dollars per million tokens, by
model family (`opus`, `sonnet`, `haiku`, `fable`) or by full model name, copied from Anthropic's pricing page:

```json
"project": {
  "prices": {
    "opus":   { "input": …, "cacheWrite5m": …, "cacheWrite1h": …, "cacheRead": …, "output": … },
    "sonnet": { "input": …, "cacheWrite5m": …, "cacheWrite1h": …, "cacheRead": …, "output": … }
  }
}
```

The prices are applied when you read the timeline, never stored in it, so you can add or change them
later and see older work at the new prices. The price list has two cache-write prices, for the 5-minute and
the 1-hour cache: copy both. A model without a price shows "no price for …". `forge config check` checks the
shape.

A checkout on a self-hosted model server (`forge llm`, GUIDE.md H) records the server's model under its own name,
for example `Qwen/Qwen3.8-27B`: give it a price under that name, at zero or what the server costs you, to see it in
dollars. Such a server may not report cache reads; its tokens then all count as new.

### How "waiting for you" is measured
- **After the lead stopped:** from its turn ending to your next message.
- **Permission prompts:** Claude Code starts a tool's clock after you answer, so the gap between a call's start and the start of its run is your answer time (counted from 5 seconds).
- **Questions:** the time an agent's question (AskUserQuestion) stayed open.
- **Approvals:** the time a forge rule's request for your approval stayed open.

Each wait keeps its kind (`reply`, `question`, `approval`, `permission`); the dashboard's first chart and its
"Waiting for you" card group them by it.

### Reading it
- **Long waits** are the first thing to cut: a project command you approve every ticket can go into `policy.commands.allow`, a decision you are asked for every time into the plan or the project rules, and repeated questions into the requirements.
- **Refusals** by rule show where agents keep trying something the kit forbids: the role or the skill should say it up front.
- **Gates not ready** and **sent back** show lanes finishing too early, often uncommitted work or missing tests.
- **Slowest calls** find hangs: a `git fetch` of 16 minutes is a network or credential problem, not slow work.
- **Costliest steps** and **by who** show where tokens go: a reviewer reading whole files, a lead that never compacts, a lane rerun after a blocker. Cache reads are most of the count and the cheapest part; compare the cost, not only the tokens.

Limits: the file stays on the machine that ran the ticket and is not committed. A lane spawned in the
foreground gets its ticket in its own lines only when the spawn returns; `forge timeline` (and `--csv`,
`--json`) fill it in from the spawn. The lead's lines on `dev` count for every ticket running at that
moment. Logging starts with se-forge 0.2.6, tokens and models with 0.2.7 (exact for every reply from 0.2.8);
`forge timeline import` fills in what came before.

## The history: `forge timeline import`
Run it once in a checkout that worked before 0.2.6. It reads Claude Code's own session logs for the checkout
(`~/.claude/projects/<checkout>/`, each agent's log and description included) and the recorded gate results,
and writes `.forge/state/timeline-import.jsonl`:
- everything before the hooks' first line: sessions, your messages (length only), tool calls with their errors and refusals (the kit's `[rule]`, Claude Code's worktree isolation and auto mode), agents with their role and ticket, API errors, and every reply's model and tokens;
- after the hooks' first line, only the tokens of replies no hook line counted.

Running it again replaces the file. Limits: a call's time runs from the call to its result, so it includes any
permission prompt; gate runs have no duration; Claude Code removes its logs after 30 days by default
(`cleanupPeriodDays`).

## The dashboard: `forge dashboard`
```
forge dashboard                 the whole project, opened in the browser
forge dashboard --days 14       the last 14 days
forge dashboard --ticket 11,12  some tickets
forge dashboard --out ~/Desktop/acme.html --no-open
forge dashboard --text          the same numbers as text, nothing written (the lead's progress report)
forge dashboard --watch         a new page every 5 minutes (--every <minutes>) until Ctrl+C; the open page reloads itself
```
One page on this Mac (`.forge/state/dashboard.html`, never committed), with `dashboard.csv` next to it. It
joins the timeline with the bootstrap's stories and tickets, the plans, `metrics.md`, the review rounds in the
team repo's history and the merges into `dev`; the one server it calls is the tracker's, for the issues chart
(`--offline` skips it and draws from the last read). The cost charts show dollars once
`project.prices` is set, tokens until then. The KPIs stay on top; the charts, the app's screenshots and the table
are in nine tabs, and the page remembers the open tab in its address (`dashboard.html#cost`).

The page is a snapshot of the moment it was built (the line under the title says when). With `--watch` (decision
126) forge makes a new one every few minutes and writes a small stamp next to it (`dashboard.stamp.js`, the build's
time); the open page loads the stamp every 10 seconds and reloads itself when it is newer, keeping its tab, its open
sections and where it was scrolled to. Ctrl+C removes the stamp, and the open page says it is no longer watched.

**Working time**, a KPI next to "Waiting for you", is the AI at work over the whole project: agents, gates and the
lead's turns, each moment once (chart 1's top lane, added up). It leaves out the waits for you and every stretch of
15 minutes with nothing happening, such as a laptop asleep or a closed session. On clinic-booking: 9 h 18 min of
work in 38.6 hours from the first line to the last, beside 13 h 07 min waiting for you.

**Finish (AI time)** (decision 145), the KPI after the tickets and stories, is how much AI work is left until every
step is done, the release too, and when that lands on the calendar:
- **The work left,** in hours of AI working time:
  - the bootstrap's steps still to do, at the bootstrap's pace so far (its working time over the steps behind it);
  - the build's tickets not merged. From three merged tickets on, at their working time per ticket. Before, the
    drafts' estimates (`tickets.md`; a planned ticket's own plan), a missing one at the others' median, less the work
    the open tickets have had, multiplied by what agents take against such estimates: 0.40 before the project's own
    merges (lunch-pool's 23 merged tickets took 0.40 of their estimates' middle in working time, median 0.37), then
    by how long its first one or two merged tickets took against theirs (`×0.55 as the 2 merged took`). A draft is
    matched to its issue by `tickets-created.md`; a merge it cannot match takes the first unmatched draft, since the
    build goes foundations first;
  - the release, as one more ticket.
- **The card's number** is that work around the clock, in days: what the agents themselves need (`about 27 days`,
  `21–33 days nonstop`).
- **On the calendar,** the second line: the work at the project's pace, the AI's working time a calendar day over the
  last 14 days (or since the first line), with the nights, the weekends and the waits for you in it as they have been.
  From three merged tickets on, the build's part is chart 2's forecast, so the card and the chart agree. The gap
  between the two lines is the hours the AI is not running, not its speed.

Hover for the hours of work, what they were made of, the calendar range and the days left. With no AI work in the
last 14 days, or no estimates and fewer than three merged tickets, it says why it cannot tell. It reads the whole
project, whatever `--days` or `--ticket` say. Before a ticket merges it is only as good as the estimates; each merge
corrects it.

**Where the project is** (decision 143), between the KPIs and the tabs: eleven steps, the bootstrap's nine stages and
then the build and the release, each with two to four sub-steps, read from the records, never from the bootstrap's
README (which the lead may not have brought up to date):

| Step | Sub-steps, and where each is read |
|---|---|
| Discovery | Questions (`bootstrap/questionnaire.md`) · Register (`decisions.md`, its D-ids counted) · **Your settings**: done once `project.json` names a stack; yours once `project.proposed.json` exists |
| Stories | Stories (`user-stories.md`) · Authorization matrix |
| Architecture | NFR · Overview · ADRs (`architecture/nfr.md`, `overview.md`, `adr/*.md`) |
| Screens | Design system (`design-system.md`, or the design map naming it) · Epics *n* of *m* (the epics of the stories that `design-map.md` names) |
| Contract | Draft (`contract.yaml`: its operations and version) · API check |
| Tickets | Drafts (`tickets.md`: `### T-01`, `### T1 —`, `### E1-T1` and `### E2-T3b` headings) · Estimates *n* of *m* |
| Panel | Seats (`panel/<seat>.md`) · Summary · Reruns *n* of *m* (the Applied table's rows with a Done cell) |
| Your review | Written (`review.md`) · **Your approval**: done once the work after it began |
| Setup | **Your merges** (`chore/architecture`, `chore/bootstrap-contract`, `chore/starter` merged; one waits for you once its branch is on origin, before that the lead is still on it) · **Contract tag** (`api-v*`) · Tickets created (`tickets-created.md`, else the board) |
| Build | one row per ticket in flight: Plan · Build · Review · Merge, by the role of the last agent on it |
| Release | **Release MR** (the newest `chore/release-vX.Y.Z` merged into `dev`) · **Promotions** (that merge on each `branches.promote` branch) · **Tag** (`vX.Y.Z`) |

A merge is a merge commit as GitLab, GitHub or git word it ("Merge branch 'chore/starter' into 'main'", "Merge pull
request #3 from acme/chore/starter"); a squash merge leaves none, so it is not seen. The project is at the furthest step
that has begun, or the next one when that one is complete; the release counts once the build is (every ticket on the
board closed, or with no board every draft merged). Before the current step, a sub-step with nothing to show counts as
done, since the work moved on (the contract's API check leaves no record, for one); a step with nothing to show at all
was skipped. The owner's sub-steps (in bold) are the exception: while there is something to act on (a proposal, a
branch, a merged contract) and it is not done, the step waits for you, amber. A ticket is in flight when a planner, an
engineer, a reviewer or QA worked on it (by the role its spawn named, as `db-reviewer: DB review #6`, since a lead may
name its agents freely), it is on the board, and it is neither merged nor closed; the bootstrap's own agents count for
no ticket, even when the timeline guessed one from their spawn's words. It waits for you when its plan says `waiting
for the owner` or `blocked`, or it is at its limit (decision 127). `forge dashboard --text` prints the same as its
`Step:` and `Waiting for you:` lines. On a page narrower than 720 px only the current step keeps its name. The current
step's dot pulses, and the line into it fades from green to its colour; with the system set to reduce motion it does
not pulse.


**Overview**
1. **The project over time:** one row per day, the hours it worked in across, from the bootstrap on. The top lane is the AI at work (agents, gates, the lead alone); the bottom lane is each wait for you, coloured by kind: your reply after the lead stopped, a question, a forge rule's approval, a permission prompt. Both can show at once (an agent works while the lead waits for your answer); blank in both is nobody working; a triangle is a merge, a camera under the lanes a screenshot (`forge shot`; click it to open the picture in the Screens tab). Hover a segment for what and how long.
2. **Progress and forecast:** tickets and stories done over time against the totals, the tickets as bars with their agents, and the finish date and cost at the pace of the merged tickets (from three merged tickets on).
3. **Issues over time** (decision 122): every issue in the tracker by its status from its creation to now, stacked: open, in progress, In Testing, closed (a Done status counts as closed). It comes from each issue's label and state history (GitLab's resource events, GitHub's issue events), kept in `.forge/state/issues.json`, so a later build fetches only the issues that changed. A build reads at most 40 issues' histories (two calls each: gitlab.com's free plan allows 100 calls a minute) and leaves the rest, or those a rate limit stopped, to the next build, and says how many are still to read; when the tracker cannot be reached, the chart is the last read and says so. Epics are left out: they stay open while their tickets close. Hover for the counts at any moment. `forge dashboard --text` prints the counts now as its `Issues:` line.

**Time**
4. **Where each ticket's time goes:** agents working, gates running, waiting for you, the lead alone, nobody working, each moment counted once in that order; a wait counts when nothing else runs.
5. **Waiting for you:** the waits by kind (how many, how long, the longest), and the eight longest with the tickets running then.

**Cost**
6. **Cost per ticket, by model,** with the estimate (the plan's, else `metrics.md`'s, else the bootstrap draft's), your hours and the areas.
7. **Cost per ticket, by stage:** planning (planner, analysts, architect, designer), building (the engineers), reviews (the reviewers and the spec checker), QA, the lead, other.
8. **Who spends it, on which model:** each role split by model, largest first, with the running share and the cost of one spawn.
9. **What the cost is made of:** each model by token kind (new: input, 5-minute and 1-hour cache writes; re-read: cache reads; output), with the share of cache reads and output.
10. **Spend per day,** by model.

**Quality**
11. **Rework:** the first pass against everything after the first review round with a blocker; review rounds and gate send-backs.
12. **Friction map:** refusals by rule and failed commands, by role; the colour is the tokens of the replies that made them. Below: the most frequent refusal reasons, word for word.

**Agents & skills** (decision 137): when sub-agents ran, and the skills each had to work from. A skill is **preloaded**
when the agent's start line names it (its agent file's `skills:` list, which Claude Code loads before the agent's first
turn; recorded from 0.2.33) and **opened** when an agent or the lead loaded it itself (a Skill call, or a read of its
`SKILL.md`).
13. **Sub-agents and skills, day by day:** each day's agents, with a skill or with none, and the skills opened and
    preloaded. Below: how many agents had a skill, and what the lead did itself: its calls, the sub-agents it started,
    the skills it opened, and the app's own files it edited (a path in the checkout outside `.forge/`), which is work a
    lane should do.
14. **Roles and their skills:** per role, its agents, how many had a skill, the skills preloaded and opened, and the
    skills its instructions name that no agent of it used (another stack's guides left out).
15. **Skills:** each skill used, how often opened and preloaded, by which roles, on which tickets and when last; then
    the skills never used, and apart the guides for stacks this project does not use (from `project.stack`).

**Screens:** the pictures kept with `forge shot`, by day, oldest first, each with its time, ticket, what it shows,
branch and commit; click one to see it larger. They are inside the page, so it stays one file that opens anywhere.
`--days` and `--ticket` choose them like the rest.

**Architecture** (decision 124): how the app is built and what it must do, in sections that open and close, each
document readable in the page with where it comes from and a download of its Markdown:
- **Components:** the architecture overview's C4 diagrams (as designed), and the Compose file's services with what
  each needs and where the browser opens it (as it runs); a component in one and not the other is worth a look;
- **Requirements:** the client's requirements (`bootstrap/inputs/`; a PDF or a picture opens from the team repo),
  the authorization matrix and the user stories, and **Download the SRS**: every part in one document, in the
  usual order (the client's requirements, users and roles, functional requirements, interfaces, non-functional
  requirements, constraints), each naming its source;
- **the architecture overview, the decision records** (a table, each record below it), **the non-functional
  requirements** and **the evaluations**, from `docs/architecture/` and `docs/adr/` on the base branch, the
  approved copies; a team-repo draft changed after its approval says so, and a record never approved shows as a draft;
- **API endpoints:** each operation of the contract at its pinned tag (method, path, operation, what it does, the
  answers), and the contract's download;
- **Standards:** the stack with the kit guide for each, the API rules, the security level (the register's when it
  sets one, such as ASVS Level 1, otherwise the kit's Level 2), the paths that need a person's approval, the gate
  command and the tests rule, the branches and the approved dependencies, and the project's own `kit/rules.md`.
The diagrams are drawn with mermaid-cli in Docker when the page is built, all new ones in one run, and kept in
`.forge/state/diagrams/`; without Docker they show as their text.

**Run the app** (decision 123): how to see the app as it is now. The page checks the app's address every 5 seconds
and says whether it answers. The steps are this project's: `forge app up` in its folder (with a Copy button), which
builds and starts the services of the app's Compose file (the one no other includes, such as `frontend/compose.yaml`
with the backend's), waits until they are healthy and opens the app; `forge app down` stops it and keeps the data;
`forge app up --fresh` after a dependency change. Below: each service with its address on this Mac (a database port
is an address, not a link) and the code the app is built from, with how far the checkout is behind its upstream.

**Tickets:** a sortable table, one row per ticket, every ticket (decision 135): the ones worked on, and the ones
nobody has picked yet, from the bootstrap and from the board (issues filed since, such as follow-ups; epics left out).
Its Status is the board's (`Todo`, `In Progress`, `Done`; `Closed` for a closed issue whose label says otherwise), or,
before the board is read, the records' (Merged, Started, Not started). With `--days`, the tickets worked on or merged
in those days and every one still to do. A ticket's number opens its issue on GitLab or GitHub (the
address the tracker gave for it, else one made from the repository's `origin`), and ▸ opens its agents one by one
(decision 129): each spawned agent with the job its spawn named, its main model, its skills (preloaded, then opened), its tokens, cost and time, oldest
first, and the lead's own turns for the ticket last. The rows add up to the ticket's tokens. `dashboard.csv` has the same rows
with the status, and the tokens per model and per stage.

The KPIs include the Opus share of the cost (or of the tokens) and the time the project waited for you, each
wait counted once. Under **Tokens** (and **API cost**, with prices) the total is split three ways: **re-read**, the
conversation so far that every reply sends again and the cache serves cheaply (cache reads, usually over 90% of the
tokens but a small part of the cost); **new**, what was added to it (input and cache writes); and **output**, what
the model wrote, its thinking included. `forge dashboard --text` prints the same split. How the numbers are made:
- **A ticket** runs from its first line to its merge on `dev`; the lead's lines without a ticket count for every ticket running at that moment; the project manager is overhead, not a ticket's work.
- **Nobody working:** a stretch of 15 minutes with no line and no tool running (a laptop asleep), also inside an agent's or the lead's turn. In chart 1 the lead also does not work while it waits for you.
- **The hours across chart 1** are the hours of the day anything happened on any day, at least two; a day with no line has no row.
- **Review rounds** come from `reviews/<ticket>/` in the team repo's history: a report saved again, or a round file (`code-r2.md`), starts a new round; a verdict other than APPROVE or PASS is a blocker.
- **The forecast** assumes one ticket after another, at the median time and cost of merged tickets of the same area.

### The text form and the lead's progress report
`forge dashboard --text` prints the dashboard's numbers instead of drawing the page, and writes no file
(decision 113). `--days` and `--ticket` work as for the page. In order:
- **Kit:** the se-forge version this checkout runs (`.forge/kit`, what its hooks, agents and skills use), with the project's pin when it differs (`forge sync` moves the checkout to it) and the `forge` command's own version when it differs; the page shows the same words under its title;
- **Repos:** the project's repository and its folder in the team repo on their host, from their `origin` remotes (a system's member repositories too; none for a remote on this machine); the page links them beside its title;
- the KPIs, the forecast, **Finish:** the finish card's AI work left (days nonstop, hours) and when it lands on the calendar at the pace, the scope (the bootstrap's tickets and the ones added since, when the bootstrap has a ticket list) and the time of the last line in the timeline;
- **Issues:** the tracker's issues now by status (open, in progress, In Testing, closed; epics not counted), with when they were read, or the last read and why the tracker could not be read now (chart 3);
- **Open:** each ticket started and not merged, with its plan's `Status:` line, estimate, time so far split as in chart 4, review rounds, agents and cost;
- **Not started**, then **Merged**, newest first (the ten newest in full);
- **Look at:** for open tickets only, two or more review rounds with a blocker (the pipeline asks the owner after two), time past the estimate's high end, a plan whose status says blocked or waiting for the owner (decision 139); a branch whose lane stopped with GATES-FAILED and that no green gate run has passed since; and 15 minutes with nothing happening while tickets are open;
- **Longest waits for you:** the five longest, with the tickets running then.

The lead runs it after each merge into dev, and when the owner types `/progress-report` (skill
`progress-report`): it writes `.forge/project/progress/<YYYY-MM-DD-HHmm>.md` (merged since the last report, in
progress, what needs the owner (the open follow-ups among it, in one line: decision 115), what to look at and what the lead does about it, the forecast, the numbers),
shows the owner a short form and runs `forge save`. The settings allow `forge dashboard --text` without a prompt.

## Screenshots: `forge shot`
```
forge shot <image> "<what it shows>" [--ticket <n>]       one picture, PNG or JPEG
forge shot --playwright <report.json> [--ticket <n>]      the last screen of each passed test in a Playwright JSON report
forge shot                                                the project's pictures, oldest first
```
Decision 100. When a ticket whose plan's `Areas:` include `ui` passes QA, the QA engineer runs that ticket's
end-to-end specs once more in Chromium with `FORGE_SHOTS=1` (the starter's `playwright.config.ts` then sets
`screenshot: 'on'`) and the JSON reporter, and records them with `--playwright`: one picture per test, the last
screen, named after the test (its `describe` titles and its title), at the moment the test ended. Paths written
inside a container (`/app/test-results/…`) are found again from the report's folder. Anyone can add a picture
with the first form; its time is the file's.

Each picture is kept in the project's folder in the team repo, `shots/<time>Z-<ticket>-<words>.png` (or `.jpg`),
next to a JSON record of the same name:

| Field | |
|---|---|
| `at` | when it was taken (UTC) |
| `what` | what it shows: the test's name, or the words given |
| `ticket` | `--ticket`, else the number in the branch (`feat/12-…`), else null |
| `branch`, `commit` | where `forge shot` ran |
| `test` | the spec file and line (`--playwright` only) |
| `file`, `width`, `height`, `sha` | the picture; the same picture for the same ticket is kept once |

A picture wider than 1280 px or over 300 KB becomes a JPEG at most 1280 px wide (macOS's `sips`; transparency
becomes white); one still over 1 MB is refused. Playwright's pictures of a page are 1280×720 and usually
10–50 KB. `forge save` shares them; the dashboard reads `shots/` when it is built.
