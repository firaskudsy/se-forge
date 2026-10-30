---
name: progress-report
description: The lead's progress report to the owner, from the dashboard's own numbers - what was merged since the last report, what is open and where its time went, what waits for the owner, what to look at, and the forecast; shown in the session and saved in the team repo. Use after each merge into dev (pipeline step 6) and when the owner types /progress-report. Run in the lead session only.
---

# Progress report (lead)

Decision 113. The numbers come from `forge dashboard --text`, which reads the same records as the dashboard page, so the report and the page agree. Quote its numbers; never work one out or guess it. The owner sees the charts with `forge dashboard`.

## Steps
1. **The numbers.** `forge dashboard --text` (exactly this, so no permission prompt; it writes nothing and opens nothing). With more than about 30 tickets, add `--days 7`.
2. **The last report.** The newest `.forge/project/progress/*.md`. "Merged since the last report" is every ticket in the output's Merged list with a merge time after that report's; with no report yet, every merged ticket.
3. **What waits for the owner.** The output's `Waiting for you:` line first (decision 143: settings to apply, the review to approve, a release to promote, a ticket waiting or at its limit; the setup's and the contract's merges and tags are yours, decision 148), then its `On hold:` line (decision 147: every ticket on hold, with its questions in its plan's section 6), then what you know in this session and the open tickets' status lines: a question asked and not answered (also from an earlier session: a status line `waiting for the owner: Q<n>, …`, decision 139, whose questions you ask again from the plan's section 6), an approval gate, a merge a person has to do (a contract change, `staging`, `main`), "Needs a person" in the project manager's newest digest (`.forge/project/pm/digest-*.md`). Name the ticket and since when. The open `[Follow-up]` issues go here too, in one line from the newest digest's "Follow-ups": those that join after the build by themselves (P1 and P2 inside the register, decision 119), and those that wait for the owner, with the question which of them join. Every decision is a question the owner answers here, written as a choice (skill `ask-owner`): numbered, lettered options with the recommendation first, boxes for the follow-ups. Every action only a person can take (a merge request to merge, with its address and whether it is a draft to mark ready; a tag to push; a setting to apply; `forge limits lift`) is a step of **Your turn** (decision 144), in the order they must happen, with where, the exact command and `Done when:`; never a step you could take yourself. None: write "nothing".
   **Decided for you** (decision 138): the answer log's rows (`.forge/project/owner-answers.md`) since the last report whose `By` is `assistant: precedent` or `assistant: obvious`, as boxes the owner ticks to change one; none: write "nothing". A ticked one is asked again and logged as skill `owner-answers` says.
4. **Look at.** Every line the output prints under "Look at", each with what you do about it:
   - a ticket at its limit (decision 127): it is parked; under "Needs the owner", what it reached and `forge limits lift <id>` to give it one more allowance;
   - review rounds with blockers: ask the owner, as the pipeline says after two rounds;
   - waiting for the owner: its questions go under "Needs the owner" (step 3);
   - past its estimate: the reason, from the time split (nobody working, waiting for you, or the agents);
   - GATES-FAILED: the fix lane you spawned or will spawn;
   - nothing happening: say so and continue the queue.
5. **Write** `.forge/project/progress/<YYYY-MM-DD-HHmm>.md` with the Write tool, from `template.md` in this skill's folder. Keep its headings exactly, so the next report and the retro can read it.
6. **Show the owner** a short form in the session, at most 8 lines: merged since the last report, open tickets, the forecast, and the report's path. Then the questions, as AskUserQuestion when they are in the session (skill `ask-owner`), with "Decided for you" as one pick-any question when it has rows; then, last, the Your turn block as the report has it, and end your turn there.
7. **Save.** `forge save -m "progress report"`.

## Done when
- the report is in `.forge/project/progress/`, with every section of the template, and each number in it appears in the `forge dashboard --text` output;
- every "Look at" line has what the lead does about it, and "Needs the owner" names each wait or says nothing, its actions as one Your turn block of steps in order; "Decided for you" lists the owner-assistant's precedent and obvious answers since the last report, or says nothing;
- the owner has the short form, and `forge save` ran.
