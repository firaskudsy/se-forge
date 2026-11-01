---
description: Pause the pipeline before you close the laptop or lose the internet. No new agents; running ones finish and hand over; the agents' worktrees are checked and cleaned; the lead's handover is current; everything is saved. Ends with "Safe to close" or what still blocks it.
---
Pause the pipeline now (decision 95). Start nothing new: no agent, no ticket, no merge.

1. **Scheduled prompts.** Cancel this session's scheduled prompts (`CronList`, then `CronDelete` for each), so nothing starts while the laptop is away.
2. **Running agents.** Wait for each running agent to report; never stop one mid-step. An agent told to hand over writes its handover (skill `handover`).
3. **Worktrees.** Run `forge worktrees --clean`. It removes the finished ones and lists the rest:
   - `!` running: an agent still works there. Wait for it (step 2), then run the check again.
   - `✗` unfinished: run the command it prints (`forge handover <name> --from-tree <path>`), so a fresh agent can continue from it. The worktree stays.
4. **Lead handover.** Bring `.forge/handoffs/lead-handover.md` up to date (skill `handover`, Lead section): the tickets in progress with their branch and step, each worktree kept and its handover, the queue, and the exact next command.
5. **Save.** `forge save -m "pause"`.
6. **Confirm.** Run `forge worktrees`. Exit 0 and "Safe to close" mean done. Report in at most 5 lines: "Safe to close" (or what still blocks it), what was saved, and that `/resume` in a fresh session continues from the handover. When the owner is moving the project to another machine, add that they now run `forge export` (decision 151). Then end your turn.
