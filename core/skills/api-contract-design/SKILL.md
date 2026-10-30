---
name: api-contract-design
description: Design or change an API contract (OpenAPI 3.1) in the team API style, as a draft the lead merges and tags once forge api check passes (a breaking change on the owner's decision) - resources, operations, schemas, errors, pagination, security, version bump - and check it with forge api check. Used by the contract-analyst, and by the lead in light mode when a ticket needs an API change.
---

# Design a contract change

The contract is the source of truth for every API. It changes only through a draft that passes `forge api check`, its own merge request and an `api-v<semver>` tag, which the lead's `forge merge` sets (decision 148); a breaking change also needs the owner's decision.

## Procedure
1. Start from the latest approved version: `git fetch --tags`, then `git show <newest api-v tag>:<spec path>` (project facts). In a repo that consumes the contract, `forge api fetch` prints the pinned spec's path.
2. Write the **whole changed spec** to `.forge/project/contracts/<ticket>-<slug>.yaml`. Change only what the ticket needs. Follow `style.md` in this skill's folder, unless the project's rules say otherwise.
3. Version (`info.version`, semver):
   - additive change (new operation, new optional field or parameter): minor;
   - documentation only: patch;
   - anything breaking (removed or renamed operation or field, new required input, narrowed type, changed status code or auth): **major**. Prefer an additive design. A breaking change needs the owner's decision on how consumers move: a new URL major served next to the old one, or a coordinated release.
4. Check it: `forge api check --spec .forge/project/contracts/<ticket>-<slug>.yaml > /tmp/api-check.log 2>&1; tail -30 /tmp/api-check.log`. Fix lint errors. Copy the list of breaking changes into the plan.
5. In the plan: `Contract: pending (.forge/project/contracts/<ticket>-<slug>.yaml, version <x.y.z>)`, plus a short change summary (operations added or changed, breaking or not, consumers affected).
6. Hand over to the lead. It runs `forge api apply <draft>`, which puts the draft on `chore/<ticket>-contract` and opens its merge request, then `forge merge chore/<ticket>-contract`, which merges it and tags `api-v<version>` (decision 148); a breaking change waits for the owner's decision first. In consumer repos, `project.api.pin` then moves to the tag. The plan's `Contract:` line names the tag, and API and UI work can start.

Never edit the repo's spec yourself, to make an implementation pass or otherwise, and never tag.

## Done when
- the draft is in `.forge/project/contracts/` with a raised `info.version`;
- `forge api check --spec <draft>` passes, or its only finding is an expected breaking change with a new major version;
- the plan's `Contract:` line is `pending (<draft>, version <x.y.z>)` and holds the change summary and consumer migration;
- a breaking change is in the plan for the owner's decision, as a choice (skill `ask-owner`); nothing was edited in the repo's spec and nothing was tagged.
