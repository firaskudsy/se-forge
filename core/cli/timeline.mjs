// forge timeline [<ticket>] [--days <n>] [--json | --csv]: where the time went (decision 96), from the timeline
// the hooks write to .forge/state/timeline-<YYYY-MM>.jsonl.
// - A line belongs to its ticket; an agent's lines to the ticket its spawn named; the lead's and the person's
//   lines without a ticket to every ticket running at that moment.
// - Waiting for you: from the lead's turn ending to your next message, from a tool call to its start when a
//   permission prompt was shown (Claude Code starts a tool's clock after the permission decision), and the
//   time taken to answer an agent's question.
// - Tokens (decision 97): each model reply once, by model and by who; the costliest steps; and, with
//   project.prices, what that would cost on the API. Prices apply when the timeline is read, so they can be
//   set or changed later.
// - Without a ticket: the last 7 days (--days), all of it and then each ticket.
import fs from 'node:fs';
import path from 'node:path';
import { fmt } from './metrics.mjs';

const FILE = /^timeline-(\d{4}-\d{2}|import)\.jsonl$/;
const T = (e) => Date.parse(e.at);
const SPAWN_TOOLS = new Set(['Agent', 'Task']);
// The lead's own steps, in which a turn ending is followed by a person or by the lead working again.
const LEAD_STEPS = new Set(['prompt', 'agent.notify', 'session.start', 'tool.start', 'tool.ask', 'tool.refused', 'turn.end', 'turn.sent-back', 'turn.fail', 'compact.start']);
const PERMISSION_WAIT_MS = 5000;
const SLOW_MS = 5000;

// imported: false leaves out the history from forge timeline import.
export function readTimeline(stateDir, { imported = true } = {}) {
  const files = fs.existsSync(stateDir) ? fs.readdirSync(stateDir).filter((f) => FILE.test(f) && (imported || f !== 'timeline-import.jsonl')).sort() : [];
  const lines = [];
  for (const f of files) {
    for (const l of fs.readFileSync(path.join(stateDir, f), 'utf8').split('\n')) {
      if (!l) continue;
      try { const e = JSON.parse(l); if (Number.isFinite(T(e))) lines.push(e); } catch { /* a cut line */ }
    }
  }
  lines.sort((a, b) => T(a) - T(b));
  // Claude Code's own short helpers report a stop with no role, no start and no transcript: nobody spawned them, so
  // the agent counts leave them out (helper: true; forge timeline counts them apart).
  const started = new Set(lines.filter((e) => e.event === 'agent.start').map((e) => e.agent));
  const typed = new Set(lines.filter((e) => e.agent && e.who !== 'agent').map((e) => e.agent));
  return { files, lines: lines.map((e) => (e.agent && !started.has(e.agent) && !typed.has(e.agent) ? { ...e, helper: true } : e)) };
}

// Each agent's lines take the ticket its spawn named; the agent's own branch can still be the lead's.
export function attribute(lines) {
  const spawned = new Map();
  for (const e of lines) if (e.spawned && e.ticket) spawned.set(e.spawned, e.ticket);
  return lines.map((e) => {
    const ticket = (e.agent && spawned.get(e.agent)) || e.ticket;
    return ticket === e.ticket ? e : { ...e, ticket };
  });
}

export function ticketLines(lines, ticket) {
  const own = lines.filter((e) => e.ticket === ticket);
  if (!own.length) return [];
  const from = T(own[0]);
  const to = T(own.at(-1));
  return lines.filter((e) => e.ticket === ticket || (!e.ticket && !e.agent && T(e) >= from && T(e) <= to));
}

const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'];
export const familyOf = (model) => FAMILIES.find((f) => String(model).toLowerCase().includes(f)) ?? String(model || 'unknown');

// Dollars for one reply at the person's prices (per million tokens), by full model name or family.
export function costOf(e, prices = {}) {
  const p = prices[e.model] ?? prices[familyOf(e.model)];
  if (!p || !e.tokens) return undefined;
  return ((e.input || 0) * p.input + (e.cacheWrite5m || 0) * p.cacheWrite5m + (e.cacheWrite1h || 0) * p.cacheWrite1h + (e.cacheRead || 0) * p.cacheRead + (e.output || 0) * p.output) / 1e6;
}
const dollars = (n) => (n > 0 && n < 0.01 ? '<$0.01' : `$${n >= 100 ? n.toFixed(0) : n.toFixed(2)}`);

const count = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);
const words = (s, n) => String(s || '').split(' ').slice(0, n).join(' ');
// A reason's first sentence without its particulars, so the same reason counts once: "feat/12-x has no
// upstream. Push it…" → "… has no upstream".
const reasonKey = (why) => String(why || 'unknown').replace(/\([^)]*\)/g, '').split(/[:.](?:\s|$)/)[0]
  .replace(/\S*[/@]\S*/g, '…').replace(/\b\d+\b/g, 'N').replace(/\s+/g, ' ').trim();

export function summarize(lines, prices = {}) {
  const s = {
    from: lines.length ? T(lines[0]) : 0, to: lines.length ? T(lines.at(-1)) : 0,
    waits: [], agents: new Map(), helpers: new Set(), spawns: 0, refused: new Map(), asks: 0,
    gates: { pass: 0, fail: 0, ms: 0, notReady: new Map() }, failed: new Map(), interrupted: 0,
    apiErrors: new Map(), compactions: { lead: 0, agents: 0 }, slowest: [],
    tokens: { total: 0, byModel: new Map(), byWho: new Map(), cost: 0, unpriced: new Set(), steps: [] },
  };
  // Each model reply once: its tokens sit on one line, which names the reply.
  const replies = new Set();
  for (const e of lines) {
    if (!e.tokens || !e.reply || replies.has(e.reply)) continue;
    replies.add(e.reply);
    const cost = costOf(e, prices);
    s.tokens.total += e.tokens;
    count(s.tokens.byModel, familyOf(e.model), e.tokens);
    count(s.tokens.byWho, e.who || 'unknown', e.tokens);
    if (cost === undefined) s.tokens.unpriced.add(familyOf(e.model)); else s.tokens.cost += cost;
    s.tokens.steps.push({ ...e, cost });
  }
  const priced = Object.keys(prices).length > 0;
  s.tokens.steps = s.tokens.steps.sort((a, b) => (priced ? (b.cost ?? 0) - (a.cost ?? 0) : 0) || b.tokens - a.tokens).slice(0, 5);
  // Waits after the lead's turn ended.
  const steps = lines.filter((e) => !e.agent && LEAD_STEPS.has(e.event));
  steps.forEach((e, i) => {
    if (e.event !== 'turn.end') return;
    const next = steps[i + 1];
    if (next && (next.event === 'prompt' || (next.event === 'session.start' && next.source !== 'compact'))) {
      s.waits.push({ ms: T(next) - T(e), at: T(e), kind: 'reply', what: 'your reply after the lead stopped' });
    }
  });
  const starts = new Map();
  const agents = new Map();
  for (const e of lines) {
    if (e.helper) { s.helpers.add(e.agent); continue; }
    switch (e.event) {
      case 'tool.start':
      case 'tool.ask':
        if (e.id) starts.set(e.id, e);
        if (e.event === 'tool.ask') s.asks++;
        if (SPAWN_TOOLS.has(e.tool) && !e.agent) s.spawns++;
        break;
      case 'tool.done':
      case 'tool.fail': {
        const start = e.id && starts.get(e.id);
        if (e.tool === 'AskUserQuestion' && Number.isFinite(e.ms)) s.waits.push({ ms: e.ms, at: T(e) - e.ms, kind: 'question', what: `question: ${e.what || ''}` });
        else if (start && Number.isFinite(e.ms)) {
          const gap = T(e) - e.ms - T(start);
          if (gap >= PERMISSION_WAIT_MS) s.waits.push({ ms: gap, at: T(start), kind: start.event === 'tool.ask' ? 'approval' : 'permission', what: start.event === 'tool.ask' ? `${start.rule || 'approval'}: ${start.what || start.tool}` : `permission: ${start.tool} ${start.what || ''}`.trim() });
        }
        if (e.event === 'tool.fail') {
          count(s.failed, e.tool === 'Bash' ? `Bash ${words(e.what, 2)}` : e.tool);
          if (e.interrupted) s.interrupted++;
        }
        if (e.ms >= SLOW_MS && !SPAWN_TOOLS.has(e.tool) && e.tool !== 'AskUserQuestion') s.slowest.push(e);
        break;
      }
      case 'tool.refused': count(s.refused, e.rule || 'unknown'); break;
      case 'agent.start': agents.set(e.agent, { type: e.who, start: T(e), end: null, sentBack: 0 }); break;
      case 'agent.sent-back': if (agents.has(e.agent)) agents.get(e.agent).sentBack++; break;
      case 'agent.stop':
      case 'agent.gates-failed': {
        const a = agents.get(e.agent) ?? { type: e.who, start: null, sentBack: 0 };
        a.end = T(e);
        a.gatesFailed = e.event === 'agent.gates-failed';
        agents.set(e.agent, a);
        break;
      }
      case 'gates.pass': s.gates.pass++; s.gates.ms += e.ms || 0; break;
      case 'gates.fail': s.gates.fail++; s.gates.ms += e.ms || 0; break;
      case 'gates.not-ready': count(s.gates.notReady, reasonKey(e.why)); break;
      case 'turn.fail': count(s.apiErrors, words(e.why, 1).replace(/[:.]$/, '') || 'unknown'); break;
      case 'compact.start': if (e.agent) s.compactions.agents++; else s.compactions.lead++; break;
      default: break;
    }
  }
  for (const a of agents.values()) {
    const t = s.agents.get(a.type) ?? { n: 0, ms: 0, open: 0, sentBack: 0, gatesFailed: 0 };
    t.n++;
    if (a.start !== null && a.end !== null) t.ms += a.end - a.start; else t.open++;
    t.sentBack += a.sentBack;
    if (a.gatesFailed) t.gatesFailed++;
    s.agents.set(a.type, t);
  }
  s.waits.sort((a, b) => b.ms - a.ms);
  s.slowest = s.slowest.sort((a, b) => b.ms - a.ms).slice(0, 5);
  return s;
}

export function duration(ms) {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;
}
const when = (t) => new Date(t).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const clock = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const list = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(', ');
const total = (map) => [...map.values()].reduce((a, b) => a + b, 0);

export function render(title, s) {
  const out = [`${title} · ${when(s.from)} → ${when(s.to)} · ${duration(s.to - s.from)}`];
  const row = (label, text) => out.push(`  ${label.padEnd(16)}  ${text}`);
  const more = (text) => out.push(`  ${''.padEnd(16)}  ${text}`);
  if (s.waits.length) {
    row('waiting for you', `${duration(s.waits.reduce((a, w) => a + w.ms, 0))} in ${s.waits.length} wait${s.waits.length > 1 ? 's' : ''}`);
    for (const w of s.waits.slice(0, 5)) more(`${duration(w.ms).padStart(7)}  ${w.what} (${clock(w.at)})`);
  }
  if (s.agents.size || s.helpers.size) {
    const ms = [...s.agents.values()].reduce((a, t) => a + t.ms, 0);
    row('agents', `${s.spawns} spawned · ${duration(ms)} of agent time`);
    for (const [type, t] of [...s.agents.entries()].sort((a, b) => b[1].ms - a[1].ms)) {
      const notes = [t.sentBack && `sent back ${t.sentBack}× by the gates`, t.gatesFailed && `${t.gatesFailed} stopped with failing gates`, t.open && `${t.open} running or cut off`].filter(Boolean);
      more(`${`${type} ×${t.n}`.padEnd(26)} ${duration(t.ms).padStart(7)}${notes.length ? `  ${notes.join(', ')}` : ''}`);
    }
    if (s.helpers.size) more(`and ${s.helpers.size} of Claude Code's own helpers, which nobody spawned (no role, no transcript)`);
  }
  const runs = s.gates.pass + s.gates.fail;
  if (runs || s.gates.notReady.size) {
    row('gates', [runs && `${runs} run${runs > 1 ? 's' : ''} in ${duration(s.gates.ms)}: ${s.gates.pass} passed, ${s.gates.fail} failed`, s.gates.notReady.size && `${total(s.gates.notReady)} not ready: ${list(s.gates.notReady)}`].filter(Boolean).join(' · '));
  }
  if (s.refused.size) row('refused', `${total(s.refused)}: ${list(s.refused)}`);
  if (s.asks) row('asked you', String(s.asks));
  if (s.failed.size) row('failed calls', `${total(s.failed)}: ${list(s.failed)}${s.interrupted ? ` · ${s.interrupted} interrupted` : ''}`);
  if (s.apiErrors.size) row('API errors', `${total(s.apiErrors)}: ${list(s.apiErrors)}`);
  if (s.compactions.lead || s.compactions.agents) row('compactions', `lead ${s.compactions.lead} · agents ${s.compactions.agents}`);
  s.slowest.forEach((e, i) => (i ? more : (t) => row('slowest calls', t))(`${duration(e.ms).padStart(7)}  ${e.who}  ${e.tool}${e.what ? ` ${e.what}` : ''}`));
  const t = s.tokens;
  if (t.total) {
    const byTotal = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${fmt(n)}`).join(', ');
    row('tokens', `${fmt(t.total)}: ${byTotal(t.byModel)}`);
    more(`by who: ${byTotal(t.byWho)}`);
    if (t.cost || t.unpriced.size < t.byModel.size) row('cost', `${dollars(t.cost)} at the API prices in project.prices${t.unpriced.size ? ` (no price for ${[...t.unpriced].join(', ')})` : ''}`);
    t.steps.forEach((e, i) => (i ? more : (x) => row('costliest steps', x))(`${fmt(e.tokens).padStart(7)}${e.cost !== undefined ? `  ${dollars(e.cost).padStart(7)}` : ''}  ${e.who}  ${step(e)}`));
  }
  return out.join('\n');
}

// What a reply did: the call it made, or the answer or report that ended its turn.
function step(e) {
  if (e.tool) return `${e.tool}${e.what ? ` ${e.what}` : ''}`;
  if (e.event.startsWith('turn.')) return 'answer at the end of a turn';
  if (e.event === 'reply') return 'a reply without a tool call';
  return 'report at the end of its work';
}

const COLUMNS = ['at', 'event', 'who', 'agent', 'ticket', 'branch', 'tool', 'what', 'ms', 'rule', 'why', 'model', 'input', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output', 'tokens', 'cost'];
const csvCell = (v) => (v === undefined || v === null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

export function timeline({ ticket, days, json, csv }, { stateDir, out, now = Date.now(), prices = {} }) {
  const { files, lines: raw } = readTimeline(stateDir);
  if (!files.length) {
    out('No timeline yet. From se-forge 0.2.6 the hooks write one line per agent action to .forge/state/timeline-<month>.jsonl.');
    return 0;
  }
  // Each reply's tokens on one line only, and its cost at today's prices (never stored: prices can be set or
  // changed later).
  const seen = new Set();
  const all = attribute(raw).map((e) => {
    if (!e.tokens || !e.reply) return e;
    if (seen.has(e.reply)) { const { input, cacheWrite5m, cacheWrite1h, cacheRead, output, tokens, ...rest } = e; return rest; }
    seen.add(e.reply);
    const cost = costOf(e, prices);
    return cost === undefined ? e : { ...e, cost: Number(cost.toFixed(6)) };
  });
  const want = ticket ? `#${String(ticket).replace(/^#/, '')}` : null;
  const since = want && !days ? -Infinity : now - (Number(days) || 7) * 86400000;
  const recent = all.filter((e) => T(e) >= since);
  const selected = want ? ticketLines(recent, want) : recent;
  if (json) { for (const e of selected) out(JSON.stringify(e)); return 0; }
  if (csv) {
    out(COLUMNS.join(','));
    for (const e of selected) out(COLUMNS.map((c) => csvCell(e[c])).join(','));
    return 0;
  }
  if (!selected.length) {
    out(want ? `No timeline lines for ${want}${days ? ` in the last ${days} days` : ''}.` : `No timeline lines in the last ${Number(days) || 7} days.`);
    return 0;
  }
  const blocks = want ? [render(want, summarize(selected, prices))] : [render(`Last ${Number(days) || 7} days`, summarize(selected, prices))];
  if (!want) for (const t of new Set(selected.map((e) => e.ticket).filter(Boolean))) blocks.push(render(t, summarize(ticketLines(selected, t), prices)));
  if (!Object.keys(prices).length && selected.some((e) => e.tokens)) blocks.push('No prices set: add project.prices to project.json for a cost estimate (docs/metrics.md).');
  out(blocks.join('\n\n'));
  return 0;
}
