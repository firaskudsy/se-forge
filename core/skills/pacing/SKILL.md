---
name: pacing
description: Pause safely when the Claude plan's usage window is nearly used up, and resume at the reset. Only where the developer turned pacing on (forge setup --pacing on) and only on a Claude subscription, never with an API key or on a self-hosted model server (forge llm). Use when a hook reports [pacing:pause] or [pacing].
---

# Pause and resume at the usage reset (lead)

The kit's status line records the plan's usage, and the hooks read it:
- **amber** (5-hour window at 75 %, or weekly at 80 %): `[pacing]` note. Finish what is running, prefer reviews and QA, start nothing large.
- **red** (either window at 90 %): `[pacing:pause]`. New agents are refused, and each running lane is told to commit, push and hand over.

## When the hook pauses you (`[pacing:pause]`)
1. Start no new work. Wait for running lanes to report or hand over. In light mode, finish your current step, commit and push.
2. Write your handover: `forge handover lead` creates `.forge/handoffs/lead-handover.md` (skill `handover`); fill in the running lanes and their branches, the queue, and decisions since the last handover.
3. Schedule the resume with the cron scheduling tool (`CronCreate` in Claude Code): one prompt, `recurring: false`, with the cron expression and prompt given in the pause message (a few minutes after the reset, local time). Not a wake-up timer: the reset can be hours away.
4. Tell the user in one line: paused until <time>. It resumes by itself only while this Claude session stays open and idle; otherwise they run `/resume .forge/handoffs/lead-handover.md` after the reset.
5. Stop.

## Check by hand
`forge pacing` prints the last recorded usage and the level (exit 0 green, 1 amber, 2 red, 3 off or unknown).

## Done when
- no agent was started after the pause;
- `.forge/handoffs/lead-handover.md` lists the running lanes, the queue and the decisions;
- one non-recurring resume is scheduled with the time from the pause message, and the user was told when it resumes.
