---
name: ask-owner
description: How every question, approval or action for the owner is written - short choices the owner answers in a few keystrokes (decision 136: pick one, pick any, yes/no, or a free-text line when nothing fits), in the session with AskUserQuestion and in writing as numbered questions with lettered options; and what the owner has to do as one "Your turn" block of numbered steps in order, each with where, the exact command and how they know it worked (decision 144). Use whenever the owner has to decide, approve, answer or act, and when an agent writes a question that the lead will pass on.
---

# Asking the owner

The owner should never have to read a long message to find out what you need. Every question is a choice: they answer in a few keystrokes, or write their own words when no option fits. Everything they have to do is one "Your turn" block: steps in order, each one they can follow without thinking.

## The shapes
| The owner must… | Shape | In writing |
|---|---|---|
| pick one of a few ways | options, recommended first | `A. … (recommended)` `B. …` `C. …` |
| pick any number from a list | boxes | `[ ] #31 …` `[ ] #33 …` |
| say yes or no | two options that say what happens | `A. Yes: … · B. No: …` |
| take an action only a person can | a step of **Your turn** (below) | `1. **Merge #6** · here: …` |
| give a name, a value, a date | a free-text line | `Write it: …` |

Free text alone is the last shape, not the first: when a list of likely answers exists, offer it, and the owner can still write their own.

## In the session: AskUserQuestion
- Up to 4 questions per call; more questions go in the next call, most important first.
- 2 to 4 options per question, each a label of a few words and a description of one line: what happens if chosen.
- The recommended option first, its label ending in "(Recommended)".
- `multiSelect: true` when several may apply (which follow-ups join, which findings to apply).
- A short `header` per question (at most 12 characters): `Login`, `Follow-ups`, `Limit #12`.
- "Other" is added for free text; never add an option called Other yourself.

## In writing
For a report, a digest, a plan's questions, the owner's list at the end of a session, or anything the owner reads later:

```
Needs you (3):
1. Login for the booking page? (Gates: security, plan 12 §6)
   A. Keycloak, as D-004 says (recommended)
   B. Email and password
2. Which follow-ups join the build?
   [ ] #31 Rate limit on bookings (P2)
   [ ] #33 Export to CSV (P3, new scope)
3. #12 reached its limit (4 engineer lanes). Give it one more?
   A. Yes: run `! forge limits lift 12` · B. No: it stays parked
Reply like 1A 2[31] 3B, or in your own words.
```

- Number the questions and letter the options; the reply then reads `1A 2B`.
- One line of context per question, with the path or ticket where the details are. Never hide a question inside a paragraph.
- All open questions in one message, not one at a time.

## Your turn: what the owner has to do (decision 144)
Everything only a person can do (run a command, merge, tag, set up a machine, change a setting) goes in one block, the last thing in your message, the same every time. The owner reads it as a checklist: do step 1, then step 2, then reply.

````
**Your turn** (3 steps, in this order)

1. **Let the runner start containers** · on the runner machine, in a terminal:
   ```
   sudo usermod -aG docker gitlab-runner && sudo gitlab-runner restart
   ```
   Done when: `sudo -u gitlab-runner docker ps` prints a table, not "permission denied".
2. **Run the failed pipeline again** · here, in this session:
   ```
   ! glab ci retry 4092
   ```
   Done when: https://gitlab.example.com/acme/app/-/pipelines/4092 shows passed (about 6 minutes).
3. **Merge #6** · here, in this session:
   ```
   ! forge merge 6
   ```
   Done when: it prints `merged feat/6-… into dev`.

Reply **done**, or the step that failed and what it printed. Meanwhile I wait: #7 starts from #6's merge.
````

- **One action per step, in order.** A step that needs another comes after it; two commands that always go together may share a block, two actions never share a step.
- **Where, every time.** `here, in this session` (a command starts with `!`, so it runs in the session and you see what it printed); `in a terminal, in <folder>` (the full path) when it must run outside Claude Code (`forge upgrade`, `claude`); `in the browser: <URL>` with the buttons in order (`Mark as ready`, then `Merge`); `on <machine>` for another computer.
- **The exact command,** in its own code block, as it is typed: real ticket numbers, branch names, commit messages and addresses, never `<placeholders>` and never "your usual command". The owner copies it; nothing to work out.
- **Done when:** what the owner sees when it worked (a line it prints, a page that shows passed, a green check), so they know to go on.
- **Never a step without the how.** "Make the runner Docker-capable", "push from your session" or "fix the pipeline" are not steps. Write the commands; when you are not sure of them, say what you know, give the guide's or the tool's page, and ask what they want as a choice.
- **Never a step you could take yourself.** A `forge save`, a tracker call, a spawn, a file you may write: do it. Only what the hooks or the owner's orders keep from you goes to the owner, and the step says why in a few words when it is not obvious (`the hooks keep merges for the lead and people`).
- **No internal steps.** What you will record, stamp or spawn afterwards is yours: at most one line after the block, `Meanwhile I …` or `Then I …`.
- **Short around it.** At most 3 lines before the block: what happened and why it waits. The details go by path.
- **Every time it is still waiting:** the whole block again, the done steps marked ✓ (`1. ✓ **Let the runner start containers**`), so the owner never scrolls back to find it.
- **Nothing for the owner:** one line instead of the block, `Nothing needs you: I'm on #7's database lane.`
- **With questions too:** the questions first (as choices), then Your turn. In the session, end your turn after the block, without AskUserQuestion: the owner needs the prompt free to type the `!` commands.

Not like this (the owner cannot act on it):

> So the lead side is genuinely done; the queue is parked on your three commands: 1. Runner fix → #6 merge: make the runner Docker-capable, then retry the pipeline, and once green merge 6. 2. Team repo: save, then push from your session. 3. Tell me when #6 is merged; I record the metrics, stamp the SHA into plan 6, cut the branch for #7 and start the db lane.

The same as Your turn is the block above: each step says where, what to type and when it worked, and the lead's own work (the metrics, the plan, the branch) is left out of the list.

## Rules
1. **Ask only what is open.** An answer the decision register or the plan already holds is never asked again; cite its D-id instead. During the build, a plan's or an agent's questions go through `owner-assistant` first, and only what it returns as `owner` is asked (decision 138, skill `owner-answers`).
2. **Gates wait.** A question on a gate (security, architecture) may carry a recommendation, but nothing goes ahead on it until the owner answers. Say so in its line.
3. **Every option is real.** Each one is something you will do as written; no option that is only there to fill the list.
4. **Agents that cannot ask** (lanes, reviewers, the planner, the project manager) write their questions in the written shape in their plan, report or digest; the lead asks them.
5. **Record and confirm.** Put each answer where it belongs (the register with a new D-id when it binds later tickets, the plan, a ticket comment), during the build also a row in the answer log (skill `owner-answers`), and confirm in one line: `1A: Keycloak, recorded as D-031.`
6. **Short around the choices.** What happened, in at most 3 lines, then the choices. The rest goes in the file the report points to.

## Done when
- every question to the owner is a numbered question with options, a box list, a yes/no or a one-line free-text prompt;
- everything the owner has to do is in one Your turn block, last in the message: numbered steps in order, each with where, the exact command and `Done when:`, ending with what to reply;
- the recommended option comes first and is marked, and gate questions say they wait;
- each answer is recorded where it belongs and confirmed in one line.
