---
name: architecture-design
description: Designing a project's architecture from the decision register and the stories - the overview (system context, containers, main flows, cross-cutting concerns), the decision records, the non-functional checklist - as drafts for one review by the owner, then into the client repository's docs/. Use in the bootstrap's architecture stage and when a plan with `Gates: architecture` changes the structure.
---

# Architecture design

The architect's main skill (decisions 66, 76). It composes `c4-diagrams`, `adr-writer`, `nfr-checklist`
and `tech-evaluation`. Everything is drafted in `.forge/project/architecture/`; the owner decides.

## Inputs
The register (`.forge/project/bootstrap/decisions.md`), the stories and the authorization matrix, the
contract when it exists, the team decisions the register points to (stack guides; local containers and
branches: 70-75), and the existing `docs/adr/` and `docs/architecture/`.

## Outputs (`.forge/project/architecture/`)
- `overview.md`:
  1. **Purpose and scope**: the system in three sentences, what is out of scope (D-ids);
  2. **Context** and **Containers**: the C4 diagrams (skill `c4-diagrams`) with the container table;
  3. **Main flows**: for the two to five flows the stories depend on most (sign-in, the core transaction, a report), the path through the containers, step by step, with what is synchronous;
  4. **Cross-cutting**: authentication and authorization (the matrix's model and where it is enforced), validation and errors (RFC 9457, decision 33), configuration (skill `env-config`), logging, languages and RTL, time zones;
  5. **Data**: the main entities and their owner container (details in the data model, skill `data-model-design`);
  6. **Environments**: local containers now (decision 70); what staging will add;
  7. **Risks and open questions**: each with an owner.
- `adr/NNNN-<title>.md`: one record per significant decision, including those the register already took (stack, database, design source), so the reasons stay with the code (skill `adr-writer`). Status `proposed`; accepted in the review.
- `nfr.md`: targets and capacity math (skill `nfr-checklist`).
- `evaluations/<topic>.md` for any technology the team does not already run (skill `tech-evaluation`).

## Steps
1. Read the inputs; list the decisions the architecture needs and check which the register answers.
2. Draft the NFR checklist first: its numbers decide how much architecture is needed.
3. Draft the overview and the diagrams; keep the containers to what the requirements and the numbers need.
4. One ADR per decision; one evaluation per new technology.
5. `forge docs check .forge/project/architecture` until it passes.
6. Questions the register does not answer, and every `Gates: architecture` choice, go to the owner as lettered options with the recommendation first (skill `ask-owner`), never as defaults.
7. After the owner's approval (the bootstrap's single review, or the gate): the lead copies `overview.md` and the diagrams to `docs/architecture/` and the accepted ADRs to `docs/adr/` on a `chore/architecture` branch, with its merge request, which it merges itself with `forge merge chore/architecture` (decision 148).

## Done when
- the overview, the diagrams, the ADRs and the NFR checklist exist, cite the register, and pass `forge docs check`;
- every open decision went to the owner with options and a recommendation, and none was answered by a default;
- after approval, the documents are in the client repository's `docs/` through a merged merge request.
