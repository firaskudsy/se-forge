// forge wait-owner <ticket> (decision 147): in the build, the lead's wait for the owner's answer on a ticket. The whole
// wait lasts policy.hold.minutes (10) from its first call for that ticket; one call waits at most 5 minutes, so it fits
// a shell command's time, and returns as soon as the owner writes in the session (a prompt line in the timeline after
// the wait began). It prints one word first, then what to do:
//   ANSWERED  the owner wrote: read their message and carry on with the ticket;
//   WAITING   no answer yet: run it again;
//   HOLD      no answer in time: put the ticket on hold and take the next one that does not depend on it.
import fs from 'node:fs';
import path from 'node:path';

export class WaitError extends Error {}

const STEP = 5 * 60000;
const POLL = 5000;
const FILE = /^timeline-\d{4}-\d{2}\.jsonl$/;
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const clock = (t) => new Date(t).toTimeString().slice(0, 5);

// A prompt from the owner after since, in the timeline's newest file (the hooks write every prompt there).
function answeredAt(stateDir, since) {
  const files = fs.existsSync(stateDir) ? fs.readdirSync(stateDir).filter((f) => FILE.test(f)).sort() : [];
  const newest = files.at(-1);
  if (!newest) return null;
  for (const l of fs.readFileSync(path.join(stateDir, newest), 'utf8').split('\n').reverse()) {
    if (!l) continue;
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    const t = Date.parse(e.at);
    if (!(t > since)) return null;
    if (e.event === 'prompt' && e.who === 'human') return t;
  }
  return null;
}

export async function waitOwner(o, { main, config, out, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const num = String(o._[0] ?? '').replace(/^#/, '');
  if (!/^\d+$/.test(num)) throw new WaitError('forge wait-owner <ticket>');
  const stateDir = path.join(main, '.forge', 'state');
  const file = path.join(stateDir, 'owner-wait.json');
  const minutes = config.hold?.minutes ?? 10;
  const total = minutes * 60000;
  // The wait goes on from the first call for this ticket, unless that one is long over.
  const was = readJson(file);
  const since = was?.ticket === num && now() - Date.parse(was.since) < total + STEP ? Date.parse(was.since) : now();
  const done = () => { try { fs.rmSync(file); } catch { /* none */ } };
  const hold = () => {
    done();
    out(`HOLD: no answer on #${num} in ${minutes} minute${minutes === 1 ? '' : 's'}. Put it on hold: its plan's status line "on hold: waiting for the owner: <the questions or the action> (asked <date and time>)", forge tracker status ${num} "On hold" --comment "<what it waits for>", then take the next ready ticket that does not depend on #${num} (its Depends on: names neither #${num} nor another ticket not merged yet). The owner answers when they can, in the session or from the dashboard's On hold tab.`);
    return 0;
  };
  if (total === 0) return hold();
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ ticket: num, since: new Date(since).toISOString() })}\n`);
  const until = Math.min(since + total, now() + STEP);
  for (;;) {
    const at = answeredAt(stateDir, since);
    if (at) {
      done();
      out(`ANSWERED: the owner wrote at ${clock(at)}. Read their message, record the answers (the plan's section 6, the answer log), set the plan's status line back to where #${num} is, and carry on with it.`);
      return 0;
    }
    if (now() >= since + total) return hold();
    if (now() >= until) {
      out(`WAITING: no answer on #${num} yet (${Math.floor((now() - since) / 60000)} of ${minutes} minutes). Run forge wait-owner ${num} again.`);
      return 0;
    }
    await sleep(Math.min(POLL, until - now()));
  }
}
