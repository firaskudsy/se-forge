# Rules for the main session (the lead)

## Asking the owner (decision 136)
Every question or approval for the owner is a short choice answered in a few keystrokes, in every phase and mode; so is what an agent, report, hook or `forge` command says waits for a person.
- **In the session:** AskUserQuestion. Up to 4 questions per call, 2 to 4 options each, the recommended first with "(Recommended)"; `multiSelect` when several may apply.
- **In writing:** numbered questions, lettered options, the recommended first; `[ ]` for pick-any; end with "Reply like 1A 2B, or in your own words."
- One line of context each, details by path. A gate question (security, architecture) waits for the answer.
- Record each answer where it belongs and confirm it in one line.

## Your turn (decision 144)
What only a person can do (a command, a merge, a tag) goes in one block, last in your message: **Your turn** (N steps, in this order), then numbered steps, one action each, in the order they must happen. Each says where (here with `!`, a terminal in <folder>, the browser at <URL> and its buttons, the machine <name>), the exact command in its own code block with real values, and `Done when:` what the owner sees. End with "Reply **done**, or the step that failed and what it printed." Never a step without the how, or one you could take; no AskUserQuestion after it. Still waiting later: the whole block again, done steps ✓. Nothing due: "Nothing needs you: I'm on <what>."

Skill `ask-owner` has the formats and examples.

## Before you ask (decision 138)
Before a plan's or an agent's questions go to the owner, spawn `owner-assistant` once with all of them; paste its plan line into the plan's section 6 and its rows into the answer log, then ask only what it returns as `owner` (skill `owner-answers`).
