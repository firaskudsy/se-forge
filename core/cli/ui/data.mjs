// What forge ui shows of a project (decision 153): the dashboard's model (the numbers its page and --text show), the
// lanes each ticket was given (.forge/state/spawns and lanes) and the newest lines of the timeline, read every few
// seconds, so the screen shows what the agents do now.
import fs from 'node:fs';
import path from 'node:path';
import { renderText, flags } from '../dashboard/text.mjs';
import { day } from '../dashboard/format.mjs';
import { duration } from '../timeline.mjs';
import { fmt } from '../metrics.mjs';
import { kindsText } from '../limits.mjs';

const ACTIVE = 5 * 60000;
const HOLD = /\bblocked\b|\bwaiting for the owner\b|\bon hold\b/i;
const TAIL = 256 * 1024;
const pad = (n) => String(n).padStart(2, '0');
export const hms = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };

// A ticket's place in the list: what it waits on, its mark, and its rank (what needs you first, merged last).
export function stateOf(t, now) {
  const last = t.lines?.length ? Date.parse(t.lines.at(-1).at) : 0;
  if (t.mergedAt) return { state: 'merged', mark: '✓', style: 'green', rank: 4 };
  if (t.board?.closed) return { state: 'closed', mark: '×', style: 'grey', rank: 5 };
  if (t.limit?.over?.length) return { state: 'at its limit', mark: '!', style: 'red', rank: 0 };
  if (HOLD.test(t.status || '')) return { state: 'on hold', mark: '!', style: 'yellow', rank: 0 };
  if (last && now - last < ACTIVE) return { state: 'working', mark: '▶', style: 'green', rank: 1 };
  if (t.from !== null && t.from !== undefined) return { state: 'open', mark: '○', style: 'cyan', rank: 2 };
  return { state: 'not started', mark: '·', style: 'grey', rank: 3 };
}

export function itemsOf(m) {
  const tickets = m.table.map((t) => ({ kind: 'ticket', t, ...stateOf(t, m.now) }))
    .sort((a, b) => a.rank - b.rank || (a.rank === 4 ? b.t.mergedAt - a.t.mergedAt : a.t.num - b.t.num));
  return [{ kind: 'project' }, ...tickets];
}

// The header: where the project is, how far, and on which kit and model server.
export function headerOf(m, project) {
  const s = m.steps;
  const step = !s ? '' : s.current === null ? `all ${s.steps.length} steps done` : `step ${s.current + 1} of ${s.steps.length}: ${s.steps[s.current].label}`;
  const kit = m.kit?.active ? `se-forge ${m.kit.active}${m.kit.llm ? ` on ${m.kit.llm.split(' ')[0]}` : ''}` : '';
  return [project, step, `${m.progress.ticketsDone.length} of ${m.progress.totalTickets} merged`, kit].filter(Boolean).join(' · ');
}

// The newest lines of the timeline, from the end of this month's file (and last month's, early in a month).
export function tail(stateDir) {
  let files = [];
  try { files = fs.readdirSync(stateDir).filter((f) => /^timeline-\d{4}-\d\d\.jsonl$/.test(f)).sort().slice(-2); } catch { return []; }
  const out = [];
  for (const f of files) {
    const file = path.join(stateDir, f);
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(size, TAIL));
    fs.readSync(fd, buf, 0, buf.length, size - buf.length);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    if (buf.length < size) lines.shift();
    for (const l of lines) { try { if (l) out.push(JSON.parse(l)); } catch { /* a line being written */ } }
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).slice(-500);
}

const who = (e) => String(e.who || '').replace(/-engineer$/, '');
// One line of the timeline: when, who, the tool and what it ran, or the event.
export function eventLine(e) {
  const what = String(e.what || e.why || e.trigger || '').replace(/\s+/g, ' ');
  const tool = /^tool\./.test(e.event) ? `${e.tool || ''}${e.event === 'tool.start' ? '' : ` ${e.event.slice(5)}`}` : e.event;
  const style = /fail|refused/.test(e.event) ? 'red' : e.event === 'tool.ask' ? 'yellow' : '';
  return [[`${hms(e.at)} `, 'grey'], [`${who(e).padEnd(10).slice(0, 10)} `, 'cyan'], [`${tool.padEnd(12).slice(0, 12)} `, style], [what, '']];
}
const shown = (e) => e.event !== 'tool.done';

// The lanes a ticket was given: each agent's role, its job, when it started, its calls and edits, when it last did
// something.
export function lanesOf(stateDir, num, lines = []) {
  let files = [];
  try { files = fs.readdirSync(path.join(stateDir, 'spawns')).filter((f) => f.endsWith('.json')); } catch { return []; }
  const last = new Map();
  for (const e of lines) if (e.agent) last.set(e.agent, e.at);
  return files.map((f) => ({ id: f.slice(0, -5), ...readJson(path.join(stateDir, 'spawns', f), {}) }))
    .filter((s) => String(s.ticket || '').replace('#', '') === String(num))
    .map((s) => ({ ...s, ...readJson(path.join(stateDir, 'lanes', `${s.id}.json`), {}), lastAt: last.get(s.id) ?? null }))
    .sort((a, b) => (a.at < b.at ? -1 : 1));
}

// The plan's file for a ticket: plans/<num>-*.md in the project's folder.
export function planOf(folder, num) {
  try { const f = fs.readdirSync(path.join(folder, 'plans')).find((x) => x.startsWith(`${num}-`) && x.endsWith('.md')); return f ? path.join(folder, 'plans', f) : null; } catch { return null; }
}

const heading = (t) => [[t, 'bold cyan']];
// A plan's heading often ends with its own id ("Users (#11)"); the line starts with it already.
export const titleOf = (t) => (t.title || '').replace(new RegExp(`\\s*\\(${t.id}\\)$`), '');

// The right panel for the project: what the agents do now, then the dashboard's text.
export function projectLines(m, project, events) {
  const live = events.filter(shown).slice(-10);
  return [
    heading(project),
    [['Live', 'bold']],
    ...(live.length ? live.map(eventLine) : [[['  nothing yet', 'grey']]]),
    [''],
    ...renderText(m, { project }).trimEnd().split('\n').map((l) => [[l, /^(Waiting for you|Look at|- .*limit)/.test(l) ? 'yellow' : '']]),
  ];
}

// The right panel for a ticket: where it is, what waits for you and why, its lanes, its time and tokens, and what its
// agents do now.
export function ticketLines(m, item, { stateDir, folder, events }) {
  const t = item.t;
  const out = [heading(`${t.id} ${titleOf(t)}`.trim())];
  const row = m.steps?.current !== null && m.steps?.current !== undefined ? (m.steps.steps[m.steps.current].rows ?? []).find((r) => r.num === t.num) : null;
  const MARK = { done: ['✓', 'green'], now: ['▶', 'green'], wait: ['!', 'yellow'], todo: ['○', 'grey'], skip: ['–', 'grey'] };
  out.push([[`${item.mark} ${item.state}`, item.style], ...(t.board?.status ? [[` · on the board: ${t.board.status}`, 'grey']] : []), ...(row ? [['   ', ''], ...row.subs.flatMap((x, i) => [[`${i ? ' ─ ' : ''}${MARK[x.state]?.[0] ?? '○'} `, MARK[x.state]?.[1] ?? ''], [x.label, x.state === 'wait' ? 'yellow' : '']])] : [])]);
  if (t.status) out.push([['Status: ', 'bold'], [t.status, '']]);
  // What waits for you, as the stepper says it; then what the dashboard says to look at, less what that already said.
  const why = [...new Set((row?.subs ?? []).filter((x) => x.why).map((x) => x.why))];
  const look = flags(m).filter((f) => f.startsWith(`${t.id}:`)).map((f) => f.slice(t.id.length + 1).trim())
    .filter((f) => !(/limit/.test(f) && why.some((w) => /limit/.test(w))));
  for (const w of why) out.push([['Waiting for you: ', 'bold yellow'], [w, 'yellow']]);
  for (const f of look) out.push([['Look at: ', 'bold'], [f, '']]);
  if (item.state === 'at its limit') out.push([['  F7 lifts it: ', 'grey'], [`forge limits lift ${t.num}`, 'bold']]);
  if (item.state === 'on hold') out.push([['  F6 approves its plan or a package: ', 'grey'], [`forge approve ${t.num}`, 'bold']]);
  const lanes = lanesOf(stateDir, t.num, t.lines ?? []);
  const u = t.limit?.used;
  const l = t.limit?.lim ?? {};
  if (u) out.push([['Limits: ', 'bold'], [`repeat lanes ${u.repeats} of ${l.repeats} (${u.lanes} lanes${u.lanes ? `: ${kindsText(u.kinds)}` : ''}) · rounds with blockers ${u.blockerRounds} of ${l.blockerRounds} · QA fails ${u.qaFails} of ${l.qaFails}`, '']]);
  if (lanes.length) {
    out.push([[`Agents (${lanes.length})`, 'bold']]);
    for (const l of lanes) {
      const busy = l.lastAt && m.now - Date.parse(l.lastAt) < ACTIVE;
      out.push([[`  ${busy ? '▶' : ' '} `, 'green'], [`${String(l.type || '').padEnd(18)} `, 'cyan'], [`${day(l.at)} ${hms(l.at).slice(0, 5)}  `, 'grey'], [`${l.calls ?? 0} calls · ${l.edits ?? 0} edits  `, ''], [l.description || '', 'grey']]);
    }
  }
  if (t.split) out.push([['Time: ', 'bold'], [`${duration(t.split.total)}${t.mergedAt ? '' : ' so far'} (agents ${duration(t.split.agents || 0)}, waiting for you ${duration(t.split.waiting || 0)})`, '']]);
  if (t.tokens?.total) out.push([['Tokens: ', 'bold'], [fmt(t.tokens.total), '']]);
  const plan = planOf(folder, t.num);
  if (plan) out.push([['Plan: ', 'bold'], [path.basename(plan), ''], ['  (F3 shows it)', 'grey']]);
  const live = events.filter((e) => e.ticket === t.id && shown(e)).slice(-12);
  const past = live.length ? live : (t.lines ?? []).filter(shown).slice(-12);
  out.push([''], [[live.length ? 'Live' : 'Last steps', 'bold']], ...(past.length ? past.map(eventLine) : [[['  nothing yet', 'grey']]]));
  return out;
}
