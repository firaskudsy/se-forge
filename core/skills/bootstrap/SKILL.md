---
name: bootstrap
description: Start a brand-new project discovery first - the full interview and decision register, then stories, the architecture, screens (designed in Figma or taken in from the client's Figma, PDF or images), API contract and ticket drafts one after the other, a panel of agents that reviews the drafts, one review of everything by the owner, then the contract tagged, the tickets created ready, and the build running ticket after ticket with the project manager. Run in the lead session only.
disable-model-invocation: true
argument-hint: "<requirements files> [--answers <filled questionnaire>] [--skip-contract]"
---

# Starting a new project (lead)

Requirements and options: **$ARGUMENTS**

You are the leader (decisions 42-49). You run the stages in order and never write stories, designs or contracts yourself: you spawn the agents, check each result against the decision register, and keep `.forge/project/bootstrap/README.md` current (stage, date, artefact paths). The stages run one after the other: spawn each stage's agent in the foreground and wait for its result before the next stage (only reviewers run in the background). After discovery nothing stops for the owner until the single review in stage 8. A gap the register does not answer is the one exception: one question round with the owner, recorded in the register. Every question to the owner is a choice (skill `ask-owner`).

## 1. Discovery (skill `discovery`)
The interview and `.forge/project/bootstrap/decisions.md`. The project settings it writes (stack, database, design source, approved libraries) ask the owner once.

## 2. Stories (agent `product-analyst`)
From the requirements and the register: `user-stories.md` and `authorization-matrix.md` in `.forge/project/bootstrap/`. Check every story's roles and rules against the register.

## 3. Architecture (agent `architect`, skill `architecture-design`)
`.forge/project/architecture/`: `overview.md` with the C4 context and container diagrams, the non-functional checklist with its capacity math (`nfr.md`), an ADR per significant decision, including those the register took (status `proposed`), and an evaluation for any technology the team does not run yet. `forge docs check .forge/project/architecture` passes.

## 4. Screens (by the register's design source)
- **The kit designs** (`project.design.source: kit`): `designer` in Figma, one spawn per epic, writing `design-map.md`.
- **Provided screens** (`figma`, `pdf`, `images`): spawn `designer` with skill `design-intake`, writing `design-system.md` and `design-map.md`, with the "Not in the screens" list.

## 5. Contract (agent `contract-analyst`, skill `api-contract-design`, bootstrap mode)
`.forge/project/bootstrap/contract.yaml`, version 1.0.0, in the team style; `forge api check --spec` passes. Skip it with `--skip-contract` when the backend already exists.

## 6. Ticket drafts (agent `planner`, not created yet)
`.forge/project/bootstrap/tickets.md`: one ticket per story slice. Each draft has its title, acceptance criteria, areas, screen references, contract operations, dependencies, its gates (`performance` for flows with a target in `nfr.md`) and its estimate (skill `estimate`). The order: database before API before UI, foundations first.

## 7. The panel (skill `requirements-panel`, decision 114)
Before the owner sees anything, the drafts of stages 2-6 are read by a panel, each seat through its own discipline: backend, frontend, mobile, database, security, QA, architecture and tickets, plus devops or performance when they apply. Spawn every seat at once and wait for all. Apply what fits the register by rerunning only the stages it touches, each once; what needs the owner goes into the review. One round, and no new scope.

## 8. One review (decision 44)
Write `.forge/project/bootstrap/review.md`:
- the panel first (`panel/summary.md`): what it changed, the decisions it leaves to the owner with the options and your recommendation, and what it rejected and why;
- the epics and stories;
- the architecture: the diagrams, the decisions with their options, the targets and the assumptions to confirm;
- the screens and the "Not in the screens" list, plus the measured tokens when the screens came as a PDF or images;
- the contract's operations;
- the tickets in order, with estimates and the total;
- every contradiction between these artefacts and the register.

Ask the owner once, with AskUserQuestion (skill `ask-owner`): the panel's open decisions as questions with their options, your recommendation first, then `A. Approve everything · B. Change something (say what)`. A change reruns only the affected stage, then this review again. On A, write `Approved: <date>, by the owner` as the first line of `review.md`: `forge merge` reads it before merging the setup's branches (decision 148).

## 9. After approval
1. **Architecture.** On branch `chore/architecture`, copy the overview and diagrams to `docs/architecture/` and the accepted ADRs (status `accepted`, today's date) to `docs/adr/`; the first ADR asks the owner once for the branch. Commit, push, open its merge request, and merge it yourself: `forge merge chore/architecture` (decision 148; it takes documents only).
2. **Contract.** `forge api apply .forge/project/bootstrap/contract.yaml` puts it on `chore/bootstrap-contract` at the repo's spec path (`project.api.spec`) and opens its merge request; `forge merge chore/bootstrap-contract` merges it and tags `api-v1.0.0` on `dev` (decision 148).
3. **Starter** (a repository without code yet; decisions 78-81). On branch `chore/starter`, `forge new` with the approved stack (`--backend … --db …`, `--frontend react`, `--mobile flutter --app-id <the store id the register records>`, as the register says; it asks the owner). Check `docker compose up -d --build --wait` and the gate (`forge gates`), commit, push, open its merge request, and merge it yourself: `forge merge chore/starter` (decision 148). Merge `.forge/project/bootstrap/project.starter.json` into `project.json` after `forge config check` (asks the owner). An existing repository is onboarded instead (skill `onboard-repo`).
4. **Tickets.** Create them yourself from `tickets.md`, in order: `forge tracker create … --ready --source ai --area <area> --relates <epic>`. The review approved them, so they are ready. Agents other than you and the project manager cannot set that label.
5. `forge save`.
6. **Build:** `/pipeline next 1`, one ticket after the other, with the project manager.

## Rules
- Every artefact cites the register's D-ids it relies on. An artefact that needs a decision the register lacks waits for that one question to the owner; nothing is invented.
- A bootstrap agent is a lane like any other, with the same budget: large requirements are split by epic over several fresh agents.
- Credentials (Figma, tracker, spec URLs) are referred to by env variable name only, never written into artefacts.

## Done when
- the register, stories, architecture, screens, contract and ticket drafts exist, the panel reviewed them (`panel/summary.md`), and the owner approved them in one review;
- the architecture records, the contract and the starter are merged, the contract tagged `api-v1.0.0`, the tickets exist with `ai::ready`, and `forge save` ran;
- the pipeline is running the first ticket.
