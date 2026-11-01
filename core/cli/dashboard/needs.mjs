// What needs the owner now (decision 155), for the dashboard's popup, forge dashboard --watch's desktop alert and
// forge ui: the stepper's "Waiting for you" (a ticket at its limit or on hold, a review, a merge to do), and every
// prompt open in a session: a Claude Code notification (a permission prompt, the lead idle at its prompt for a minute,
// a form), a forge rule's ask, a question with choices, with nothing after it from whoever waits on it.
import fs from 'node:fs';
import path from 'node:path';

const T = (e) => Date.parse(e.at);
const TAIL = 256 * 1024;

// The newest lines of the timeline, from the end of this month's file (and last month's, early in a month): the last
// max of the last bytes of each.
export function tail(stateDir, { bytes = TAIL, max = 500 } = {}) {
  let files = [];
  try { files = fs.readdirSync(stateDir).filter((f) => /^timeline-\d{4}-\d\d\.jsonl$/.test(f)).sort().slice(-2); } catch { return []; }
  const out = [];
  for (const f of files) {
    const file = path.join(stateDir, f);
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(size, bytes));
    fs.readSync(fd, buf, 0, buf.length, size - buf.length);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    if (buf.length < size) lines.shift();
    for (const l of lines) { try { if (l) out.push(JSON.parse(l)); } catch { /* a line being written */ } }
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).slice(-max);
}
// Claude Code's own notifications wait about six seconds; a forge ask or a question waits as long before it counts.
export const ASK_AFTER = 6000;
// Agents at work this recently: the lead idle at its prompt is waiting for them, not for you.
const BUSY = 5 * 60000;
const PROMPTS = { permission_prompt: 'permission', idle_prompt: 'reply', elicitation_dialog: 'input', elicitation_url_dialog: 'input', agent_needs_input: 'input' };

// Whose wait a notification is (it names no agent): the one agent with a call still open in its session, else the lead.
function ownerAt(lines, i, session) {
  const open = new Map();
  for (let j = 0; j < i; j++) {
    const e = lines[j];
    if (e.session !== session || !e.id) continue;
    if (e.event === 'tool.start' || e.event === 'tool.ask') open.set(e.id, e.agent ?? null);
    else if (e.event === 'tool.done' || e.event === 'tool.fail' || e.event === 'tool.refused') open.delete(e.id);
  }
  const who = new Set(open.values());
  return who.size === 1 && !who.has(null) ? [...who][0] : null;
}

const whoOf = (e, owner, lines) => (owner === null ? 'the lead' : lines.find((x) => x.agent === owner && x.who)?.who ?? 'an agent');

// The prompts open now, oldest first: { key, kind, who, what, since, ticket }.
export function openPrompts(lines, now = Date.now()) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const e = lines[i];
    const ask = e.event === 'tool.ask';
    const question = e.event === 'tool.start' && e.tool === 'AskUserQuestion';
    const note = e.event === 'owner.needed' && PROMPTS[e.kind];
    if (!ask && !question && !note) continue;
    const owner = note ? (e.kind === 'idle_prompt' ? null : ownerAt(lines, i, e.session)) : (e.agent ?? null);
    // Answered: whoever waited did something since; or gone: its session ended, or another one started.
    const later = lines.slice(i + 1);
    if (later.some((n) => n.session === e.session && (((n.agent ?? null) === owner && n.event !== 'owner.needed') || n.event === 'session.end'))) continue;
    if (later.some((n) => n.event === 'session.start' && n.session !== e.session)) continue;
    if (!note && now - T(e) < ASK_AFTER) continue;
    if (note && e.kind === 'idle_prompt' && lines.some((n) => n.agent && n.session === e.session && T(n) > T(e) - BUSY)) continue;
    const kind = ask ? 'approval' : question ? 'question' : PROMPTS[e.kind];
    const what = ask ? `${e.rule ? `[${e.rule}] ` : ''}${e.what || e.tool || ''}`.trim()
      : question ? (e.what || 'a question with choices')
        : kind === 'reply' ? 'finished and waits for your reply' : (e.what || e.title || 'needs you');
    out.push({ key: `${kind}:${e.session ?? ''}:${e.at}`, kind, who: whoOf(e, owner, lines), what, since: T(e), ticket: e.ticket ?? null, owner, session: e.session });
  }
  // A forge ask and Claude Code's notification about the same prompt are one wait: the ask says what it is.
  return out.filter((p) => !(p.kind === 'permission' && out.some((q) => q !== p && ['approval', 'question'].includes(q.kind) && q.owner === p.owner && q.session === p.session)))
    .map(({ owner, session, ...p }) => p);
}

// Everything that needs the owner now: the stepper's waits, then the open prompts.
export function needsYou({ steps = null, lines = [], now = Date.now() } = {}) {
  const waits = (steps?.waiting ?? []).map((w) => ({ key: `step:${w.step}:${w.why}`, kind: 'step', who: w.step, what: w.why, since: null, ticket: null }));
  return [...waits, ...openPrompts(lines, now)];
}

const WHERE = { approval: 'answer its prompt in the session', permission: 'answer its prompt in the session', question: 'pick an answer in the session', input: 'answer it in the session', reply: 'read its last message (Your turn) in the session' };
// One line for a need: who, what, and where you act on it.
export const needText = (n) => (n.kind === 'step' ? `${n.who}: ${n.what}` : `${n.who}${n.ticket ? ` (${n.ticket})` : ''}: ${n.what} · ${WHERE[n.kind] ?? 'in the session'}`);
