// What the dashboard's charts measure (decisions 98 and 99), as pure functions of the joined data.
import { summarize, ticketLines, familyOf, costOf } from '../timeline.mjs';
import { refusalRule } from '../timeline-import.mjs';

const T = (e) => Date.parse(e.at);
const H = 3600000;
const REVIEWER = /reviewer$|^spec-checker$/;
// A stretch this long with no line at all and no tool running is nobody working (a laptop asleep, a stuck
// session), even inside an agent's or the lead's turn.
export const SILENT_MS = 15 * 60000;

// Intervals [from, to]: merged, minus another set, total length.
export function union(list) {
  const out = [];
  for (const [a, b] of list.filter(([x, y]) => y > x).sort((x, y) => x[0] - y[0])) {
    if (out.length && a <= out.at(-1)[1]) out.at(-1)[1] = Math.max(out.at(-1)[1], b);
    else out.push([a, b]);
  }
  return out;
}
export function subtract(list, cut) {
  let out = union(list);
  for (const [c, d] of union(cut)) out = out.flatMap(([a, b]) => (d <= a || c >= b ? [[a, b]] : [[a, Math.min(b, c)], [Math.max(a, d), b]].filter(([x, y]) => y > x)));
  return out;
}
export const length = (list) => union(list).reduce((s, [a, b]) => s + b - a, 0);
const within = (list, from, to) => list.map(([a, b]) => [Math.max(a, from), Math.min(b, to)]).filter(([a, b]) => b > a);

// Each agent's [start, end]: agent.start to its stop, or its first to its last line.
export function agentSpans(lines) {
  const by = new Map();
  for (const e of lines) {
    if (!e.agent) continue;
    const a = by.get(e.agent) ?? { agent: e.agent, who: e.who, first: T(e), last: T(e), start: null, stop: null };
    a.first = Math.min(a.first, T(e));
    a.last = Math.max(a.last, T(e));
    if (e.event === 'agent.start') a.start = T(e);
    if (e.event === 'agent.stop' || e.event === 'agent.gates-failed') a.stop = T(e);
    by.set(e.agent, a);
  }
  return [...by.values()].map((a) => ({ agent: a.agent, who: a.who, from: a.start ?? a.first, to: a.stop ?? a.last }));
}

// The lead's turns: from your message (or a woken agent, or a new session) to the turn's end.
function leadTurns(lines) {
  const out = [];
  let open = null;
  for (const e of lines.filter((x) => !x.agent)) {
    if (['prompt', 'agent.notify', 'session.start'].includes(e.event)) open ??= T(e);
    if (['turn.end', 'turn.fail', 'session.end'].includes(e.event) && open !== null) { out.push([open, T(e)]); open = null; }
  }
  return out;
}

// Silent stretches: gaps of SILENT_MS or more between lines, minus the time tools ran.
export function silences(lines) {
  const times = lines.map(T).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] >= SILENT_MS) gaps.push([times[i - 1], times[i]]);
  return subtract(gaps, lines.filter((e) => e.ms > 0 && /^(tool\.(done|fail)|gates\.(pass|fail))$/.test(e.event)).map((e) => [T(e) - e.ms, T(e)]));
}

// Chart 1: each moment of a ticket counted once, in this order: agents working, gates running, waiting for
// you (the lead stopped, a permission prompt, a question), the lead alone, nobody working. Silent stretches
// are taken out of the agents' and the lead's time.
export function timeSplit(lines, from, to, waits) {
  const silent = silences(lines);
  const agents = subtract(within(agentSpans(lines).map((a) => [a.from, a.to]), from, to), silent);
  const gates = within(lines.filter((e) => /^gates\.(pass|fail)$/.test(e.event) && e.ms > 0).map((e) => [T(e) - e.ms, T(e)]), from, to);
  const waiting = within(waits.map((w) => [w.at, w.at + w.ms]), from, to);
  const lead = subtract(within(leadTurns(lines), from, to), silent);
  const parts = {};
  let taken = [];
  for (const [key, list] of [['agents', agents], ['gates', gates], ['waiting', waiting], ['lead', lead]]) {
    const own = subtract(list, taken);
    parts[key] = length(own);
    taken = union([...taken, ...own]);
  }
  parts.idle = Math.max(0, to - from - length(taken));
  return { total: to - from, ...parts, waitsAll: length(waiting) };
}

// The kinds of wait for you, as the timeline tells them apart.
export const WAIT_KINDS = [
  ['reply', 'Your reply after the lead stopped', 'replies'],
  ['question', 'A question to you', 'questions'],
  ['approval', 'A forge rule asking your approval', 'approvals'],
  ['permission', 'A Claude Code permission prompt', 'permission prompts'],
];
const nextDay = (t) => { const d = new Date(t); d.setDate(d.getDate() + 1); return d.getTime(); };
const midnight = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

// The project over time (decision 99), one row per day with a line in it, the hours of the day it worked in
// across: what the AI did (agents before gates before the lead, silent stretches taken out, and the lead's
// own waits for you) and, apart, each wait for you. They can overlap: an agent works while the lead waits for
// your answer. What is neither is nobody working. Merges are marks on their day. working: the AI's time at work over
// the whole project, each moment once, without the waits for you and the silent stretches (a laptop asleep, a
// closed session).
export function projectTimeline(lines, { merges = [], shots = [] } = {}) {
  if (!lines.length) return null;
  const times = lines.map(T);
  const from = Math.min(...times);
  const to = Math.max(...times);
  const silent = silences(lines);
  const waits = summarize(lines).waits.map((w) => ({ ...w, kind: w.kind || 'reply' })).sort((a, b) => a.at - b.at);
  const ai = [
    ['agents', subtract(agentSpans(lines).map((a) => [a.from, a.to]), silent)],
    ['gates', lines.filter((e) => /^gates\.(pass|fail)$/.test(e.event) && e.ms > 0).map((e) => [T(e) - e.ms, T(e)])],
    ['lead', subtract(leadTurns(lines), [...silent, ...waits.map((w) => [w.at, w.at + w.ms])])],
  ];
  // The hours of the day anything happened, on any day: at least two.
  const clock = times.map((t) => t - midnight(t));
  let lo = Math.floor(Math.min(...clock) / H) * H;
  let hi = Math.ceil((Math.max(...clock) + 1) / H) * H;
  if (hi - lo < 2 * H) { lo = Math.max(0, Math.min(lo, hi - 2 * H)); hi = lo + 2 * H; }
  const days = [];
  for (let d = midnight(from); d <= to; d = nextDay(d)) {
    if (!times.some((t) => t >= d && t < nextDay(d))) continue;
    const a = Math.max(d + lo, from);
    const b = Math.min(d + hi, to);
    let taken = [];
    const work = {};
    for (const [key, list] of ai) {
      work[key] = subtract(within(list, a, b), taken);
      taken = union([...taken, ...work[key]]);
    }
    const mine = waits.map((w) => ({ ...w, span: within([[w.at, w.at + w.ms]], a, b)[0] })).filter((w) => w.span);
    const yours = union(mine.map((w) => w.span));
    const shown = (m) => m.at >= d + lo && m.at <= d + hi;
    days.push({
      day: d, from: a, to: b, work, waits: mine,
      merges: merges.filter(shown), shots: shots.filter(shown),
      ai: length(taken), you: length(yours), nobody: Math.max(0, b - a - length([...taken, ...yours])),
    });
  }
  const byKind = Object.fromEntries(WAIT_KINDS.map(([k]) => {
    const own = waits.filter((w) => w.kind === k);
    return [k, { n: own.length, ms: own.reduce((s, w) => s + w.ms, 0), longest: Math.max(0, ...own.map((w) => w.ms)) }];
  }));
  return { from, to, lo, hi, days, waits, byKind, waiting: length(waits.map((w) => [w.at, w.at + w.ms])), working: length(union(ai.flatMap(([, list]) => list))) };
}

// The token kinds of a reply, each priced differently.
export const PARTS = ['input', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output'];

// Each reply's tokens once, with its cost at the person's prices, in total and per token kind.
export function replies(lines, prices = {}) {
  const seen = new Map();
  for (const e of lines) {
    if (!e.tokens || !e.reply || seen.has(e.reply)) continue;
    const p = prices[e.model] ?? prices[familyOf(e.model)];
    seen.set(e.reply, {
      at: T(e), who: e.who, ticket: e.ticket, family: familyOf(e.model), tokens: e.tokens, cost: costOf(e, prices),
      parts: Object.fromEntries(PARTS.map((k) => [k, e[k] || 0])),
      partCost: p ? Object.fromEntries(PARTS.map((k) => [k, ((e[k] || 0) * p[k]) / 1e6])) : null,
    });
  }
  return [...seen.values()];
}

// The stage of a ticket a role works in.
export const STAGES = [['plan', 'Planning'], ['build', 'Building'], ['review', 'Reviews'], ['qa', 'QA'], ['lead', 'Lead'], ['other', 'Other']];
export function stageOf(who) {
  const w = String(who || '');
  if (w === 'lead') return 'lead';
  if (w === 'qa-engineer') return 'qa';
  if (/-engineer$/.test(w)) return 'build';
  if (/review(er)?$|^spec-checker$/.test(w)) return 'review';
  if (/^(planner|architect|designer|product-analyst|contract-analyst)$/.test(w)) return 'plan';
  return 'other';
}

const add = (o, k, v) => { o[k] = (o[k] || 0) + v; return o; };

// Tokens and cost of some replies grouped by a key: { key: { tokens, cost } }.
export function groupBy(rs, key) {
  const out = {};
  for (const r of rs) { const g = out[key(r)] ??= { tokens: 0, cost: 0 }; g.tokens += r.tokens; g.cost += r.cost || 0; }
  return out;
}

// What each model's tokens and cost are made of, by token kind.
export function composition(lines, prices = {}) {
  const out = {};
  for (const r of replies(lines, prices)) {
    const f = out[r.family] ??= { tokens: {}, cost: {}, priced: true };
    for (const k of PARTS) {
      add(f.tokens, k, r.parts[k]);
      if (r.partCost) add(f.cost, k, r.partCost[k]); else f.priced = false;
    }
  }
  return out;
}

// Spend per day (local time), by model.
export function daily(lines, prices = {}) {
  const days = new Map();
  for (const r of replies(lines, prices)) {
    const d = new Date(r.at);
    const key = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const x = days.get(key) ?? { day: key, tokens: {}, cost: {} };
    add(x.tokens, r.family, r.tokens);
    add(x.cost, r.family, r.cost || 0);
    days.set(key, x);
  }
  return [...days.values()].sort((a, b) => a.day - b.day);
}

// Chart 4: the first pass, until the first review round with a blocker, and the rework after it. Without the
// review history: from the first engineer spawned after the first reviewer finished.
export function rework(ticket, lines, from, to, engineers, prices = {}) {
  let split = ticket.rounds.find((r) => r.blocker)?.at ?? null;
  if (split === null && !ticket.rounds.length) {
    const reviewed = lines.find((e) => e.event === 'agent.stop' && REVIEWER.test(e.who || ''));
    const fix = reviewed && lines.find((e) => T(e) > T(reviewed) && e.event === 'tool.start' && e.tool === 'Agent' && engineers.some((r) => (e.what || '').startsWith(`${r}:`)));
    split = fix ? T(fix) : null;
  }
  const rs = replies(lines, prices);
  const sum = (list, k) => list.reduce((s, r) => s + (r[k] || 0), 0);
  const before = split === null ? rs : rs.filter((r) => r.at < split);
  const after = split === null ? [] : rs.filter((r) => r.at >= split);
  return {
    split,
    first: { tokens: sum(before, 'tokens'), cost: sum(before, 'cost'), ms: (split ?? to) - from },
    rework: { tokens: sum(after, 'tokens'), cost: sum(after, 'cost'), ms: split === null ? 0 : Math.max(0, to - split) },
    rounds: ticket.rounds.length || new Set(lines.filter((e) => e.event === 'agent.start' && e.who === 'code-reviewer').map((e) => e.agent)).size,
    blockerRounds: ticket.rounds.filter((r) => r.blocker).length,
    sentBack: lines.filter((e) => e.event === 'agent.sent-back').length,
  };
}

// Chart 5: refusals by rule and failures by command, per role, with the tokens of the replies that made them.
export function friction(lines) {
  const tokensOf = new Map(lines.filter((e) => e.tokens && e.reply).map((e) => [e.reply, e.tokens]));
  const cells = new Map();
  const reasons = new Map();
  for (const e of lines) {
    let row = null;
    if (e.event === 'tool.refused') row = e.rule || 'unknown';
    else if (e.event === 'tool.fail') row = refusalRule(e.why || '') ?? (e.tool === 'Bash' ? `Bash ${String(e.what || '').split(' ').slice(0, 2).join(' ')}` : e.tool);
    if (!row) continue;
    const who = e.who || 'unknown';
    const c = (cells.get(row) ?? cells.set(row, new Map()).get(row)).get(who) ?? { n: 0, replies: new Set() };
    c.n++;
    if (e.reply) c.replies.add(e.reply);
    cells.get(row).set(who, c);
    if (e.event === 'tool.refused' && e.why) {
      const text = e.why.replace(/^(PreToolUse:\w+ hook error: )?\[[\w:-]+\]\s*/, '').split(/(?<=\.)\s/)[0].slice(0, 160);
      const k = `${row}: ${text}`;
      reasons.set(k, (reasons.get(k) || 0) + 1);
    }
  }
  const total = (m) => [...m.values()].reduce((s, c) => s + c.n, 0);
  const rows = [...cells.entries()].sort((a, b) => total(b[1]) - total(a[1])).slice(0, 15);
  const cols = new Map();
  for (const [, m] of rows) for (const [who, c] of m) cols.set(who, (cols.get(who) || 0) + c.n);
  return {
    rows: rows.map(([row, m]) => ({ row, total: total(m), cells: Object.fromEntries([...m].map(([who, c]) => [who, { n: c.n, tokens: [...c.replies].reduce((s, r) => s + (tokensOf.get(r) || 0), 0) }])) })),
    cols: [...cols.entries()].sort((a, b) => b[1] - a[1]).map(([who]) => who),
    reasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
  };
}

// Chart 3: tokens and cost by who, largest first, with the running share, spawns and the Opus share.
export function roles(lines, prices = {}) {
  const by = new Map();
  for (const r of replies(lines, prices)) {
    const x = by.get(r.who) ?? { who: r.who, tokens: 0, cost: 0, opus: 0, spawns: 0, byModel: {}, costByModel: {} };
    x.tokens += r.tokens;
    x.cost += r.cost || 0;
    if (r.family === 'opus') x.opus += r.tokens;
    add(x.byModel, r.family, r.tokens);
    add(x.costByModel, r.family, r.cost || 0);
    by.set(r.who, x);
  }
  for (const e of lines) if (e.event === 'agent.start' && by.has(e.who)) by.get(e.who).spawns++;
  // Largest first: by cost when there are prices, else by tokens.
  const v = Object.keys(prices).length ? (x) => x.cost : (x) => x.tokens;
  const list = [...by.values()].sort((a, b) => v(b) - v(a));
  const all = list.reduce((s, x) => s + v(x), 0);
  let run = 0;
  return list.map((x) => { run += v(x); return { ...x, share: all ? v(x) / all : 0, running: all ? run / all : 0 }; });
}

// Decision 137: when sub-agents ran and what each had to work from. A skill is preloaded when the agent's start line
// names it (its agent file's skills: list, recorded from se-forge 0.2.33), and loaded when the agent or the lead
// opened it: a Skill call, or a read of its SKILL.md.
const SKILL_FILE = /(?:^|\/)skills\/([\w-]+)\/SKILL\.md$/;
const SPAWNS = new Set(['Agent', 'Task']);
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const inc = (map, k, n = 1) => map.set(k, (map.get(k) || 0) + n);
export function skillOf(e) {
  if (e.event !== 'tool.start') return null;
  if (e.tool === 'Skill') return e.what ? String(e.what).trim().split(/\s/)[0] : null;
  if (e.tool === 'Read') return SKILL_FILE.exec(String(e.what || ''))?.[1] ?? null;
  return null;
}
const dayOf = (t) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };

// files: what readAgentFiles found (every skill, each role's preloads and the skills its instructions name).
// otherGuides: the stack guides this project does not use, left out of "named but never used" and listed apart.
export function agentsAndSkills(lines, { skills = [], preloads = {}, named = {}, otherGuides = [] } = {}) {
  const runs = new Map();
  const lead = { calls: 0, spawns: 0, loads: 0, edits: new Map() };
  const by = new Map();
  const days = new Map();
  const day = (t) => days.get(dayOf(t)) ?? days.set(dayOf(t), { day: dayOf(t), agents: 0, withSkill: 0, preloads: 0, loads: 0 }).get(dayOf(t));
  const use = (name, e, kind) => {
    const k = by.get(name) ?? by.set(name, { name, loads: 0, preloads: 0, roles: new Set(), tickets: new Set(), last: 0 }).get(name);
    k[kind]++;
    k.roles.add(e.agent ? e.who : 'lead');
    if (e.ticket) k.tickets.add(e.ticket);
    k.last = Math.max(k.last, T(e));
    day(T(e))[kind]++;
  };
  const run = (e) => runs.get(e.agent) ?? runs.set(e.agent, { agent: e.agent, who: e.who, ticket: e.ticket ?? null, at: T(e), preloaded: [], loaded: new Map() }).get(e.agent);
  for (const e of lines) {
    const s = skillOf(e);
    if (e.agent) {
      if (e.event === 'agent.start') {
        const r = run(e);
        r.at = T(e);
        r.preloaded = Array.isArray(e.skills) ? e.skills : [];
        for (const p of r.preloaded) use(p, e, 'preloads');
      }
      if (s) { inc(run(e).loaded, s); use(s, e, 'loads'); }
    } else if (e.event === 'tool.start') {
      lead.calls++;
      if (SPAWNS.has(e.tool)) lead.spawns++;
      if (s) { lead.loads++; use(s, e, 'loads'); }
      // The lead writing the app's own files (a path inside the checkout, outside .forge/): work a lane should do.
      if (EDITS.has(e.tool) && e.what && !/^(\/|~|\.forge\/)/.test(String(e.what))) inc(lead.edits, e.what);
    }
  }
  const list = [...runs.values()].sort((a, b) => a.at - b.at);
  const had = (r) => r.preloaded.length > 0 || r.loaded.size > 0;
  for (const r of list) { const d = day(r.at); d.agents++; if (had(r)) d.withSkill++; }
  const roleMap = new Map();
  for (const r of list) {
    const x = roleMap.get(r.who) ?? roleMap.set(r.who, { who: r.who, runs: 0, withSkill: 0, preloaded: new Map(), loaded: new Map() }).get(r.who);
    x.runs++;
    if (had(r)) x.withSkill++;
    for (const p of r.preloaded) inc(x.preloaded, p);
    for (const [k, n] of r.loaded) inc(x.loaded, k, n);
  }
  const other = new Set(otherGuides);
  const roleList = [...roleMap.values()].map((x) => {
    const own = (named[x.who] ?? []).filter((k) => !other.has(k));
    return { ...x, preloads: preloads[x.who] ?? [], named: own, unused: own.filter((k) => !x.preloaded.has(k) && !x.loaded.has(k)) };
  }).sort((a, b) => b.runs - a.runs || a.who.localeCompare(b.who));
  const never = skills.filter((k) => !by.has(k));
  return {
    runs: list,
    roles: roleList,
    skills: [...by.values()].sort((a, b) => b.loads + b.preloads - (a.loads + a.preloads) || a.name.localeCompare(b.name)),
    never: never.filter((k) => !other.has(k)),
    otherStack: never.filter((k) => other.has(k)),
    days: [...days.values()].filter((d) => d.agents || d.loads || d.preloads).sort((a, b) => a.day - b.day),
    lead: { ...lead, edits: [...lead.edits].sort((a, b) => b[1] - a[1]) },
    available: skills.length,
    recorded: lines.some((e) => e.event === 'agent.start' && Array.isArray(e.skills)),
  };
}

const quantile = (xs, q) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  return s[Math.floor(i)] + (s[Math.ceil(i)] - s[Math.floor(i)]) * (i - Math.floor(i));
};

// One summary per ticket: its span, time split, tokens, cost, rework.
export function ticketSummaries(data, { prices = {}, engineers = [], now = Date.now() } = {}) {
  return data.tickets.map((t) => {
    const own = data.lines.filter((e) => e.ticket === t.id);
    if (!own.length) return { ...t, lines: [], from: null, to: t.mergedAt, split: null, tokens: null, rework: null };
    const lines = ticketLines(data.lines, t.id);
    const from = T(own[0]);
    const to = Math.max(t.mergedAt ?? T(own.at(-1)), from);
    const s = summarize(lines, prices);
    return {
      ...t,
      lines,
      from,
      to,
      open: !t.mergedAt,
      split: timeSplit(lines, from, to, s.waits),
      waits: s.waits,
      tokens: { total: s.tokens.total, byModel: Object.fromEntries(s.tokens.byModel), cost: s.tokens.cost, unpriced: [...s.tokens.unpriced] },
      agents: agentSpans(lines).filter((a) => a.to >= from && a.from <= to),
      rework: rework(t, lines, from, to, engineers, prices),
      now,
    };
  });
}

// Chart 6: tickets and stories done over time against the totals, and a forecast from the merged tickets.
export function progress(data, summaries, now = Date.now()) {
  const merged = summaries.filter((t) => t.mergedAt).sort((a, b) => a.mergedAt - b.mergedAt);
  const totalTickets = data.plannedTickets || summaries.length;
  const storyTickets = new Map();
  for (const t of summaries) for (const s of t.stories) (storyTickets.get(s) ?? storyTickets.set(s, []).get(s)).push(t);
  const storyDone = data.stories.map((s) => {
    const ts = storyTickets.get(s.id) || [];
    return ts.length && ts.every((t) => t.mergedAt) ? Math.max(...ts.map((t) => t.mergedAt)) : null;
  }).filter(Boolean).sort((a, b) => a - b);
  const done = merged.filter((t) => t.from !== null);
  const remaining = (data.catalogue.length ? data.catalogue : summaries).filter((c) => !summaries.find((t) => t.num === c.num)?.mergedAt);
  let forecast = null;
  if (done.length >= 3) {
    const pick = (areas) => { const same = done.filter((t) => t.areas[0] && t.areas[0] === areas?.[0]); return same.length >= 2 ? same : done; };
    const sum = { lo: 0, mid: 0, hi: 0, costLo: 0, costMid: 0, costHi: 0, tokensMid: 0 };
    for (const r of remaining) {
      const like = pick(r.areas);
      const ms = like.map((t) => t.mergedAt - t.from);
      const cost = like.map((t) => t.tokens?.cost || 0);
      const tokens = like.map((t) => t.tokens?.total || 0);
      sum.lo += quantile(ms, 0.25); sum.mid += quantile(ms, 0.5); sum.hi += quantile(ms, 0.75);
      sum.costLo += quantile(cost, 0.25); sum.costMid += quantile(cost, 0.5); sum.costHi += quantile(cost, 0.75);
      sum.tokensMid += quantile(tokens, 0.5);
    }
    forecast = { remaining: remaining.length, basis: done.length, ...sum, doneLo: now + sum.lo, doneMid: now + sum.mid, doneHi: now + sum.hi };
  }
  return {
    totalTickets,
    totalStories: data.stories.length,
    ticketsDone: merged.map((t) => t.mergedAt),
    storiesDone: storyDone,
    start: Math.min(...summaries.filter((t) => t.from !== null).map((t) => t.from), merged[0]?.mergedAt ?? now),
    remaining: remaining.length,
    forecast,
  };
}

// A ticket's agents one by one (decision 129): each spawned agent with its role, the job its spawn named, its main
// model, its tokens and cost, and when it ran; the lead's own turns for the ticket as the last row. Oldest first.
export function agentRows(t, prices = {}) {
  if (!t.lines?.length) return [];
  // The job: what the spawn named ("backend-engineer: API lane #12"), on its done line or on its start line.
  const started = new Map(t.lines.filter((e) => e.event === 'tool.start' && e.id && e.what).map((e) => [e.id, e.what]));
  const jobs = new Map();
  for (const e of t.lines) {
    const what = e.spawned ? e.what ?? started.get(e.id) : null;
    if (what) jobs.set(e.spawned, { what: String(what).replace(/^[^:]+:\s*/, ''), model: e.agentModel });
  }
  const spans = new Map((t.agents ?? []).map((a) => [a.agent, a]));
  const rows = new Map();
  const seen = new Set();
  for (const e of t.lines) {
    const key = e.agent ?? ' lead';
    const r = rows.get(key) ?? { agent: e.agent ?? null, who: e.agent ? e.who : 'lead', tokens: 0, cost: 0, byModel: {}, first: T(e), last: T(e), preloaded: [], loaded: new Map() };
    r.first = Math.min(r.first, T(e));
    r.last = Math.max(r.last, T(e));
    // Its skills (decision 137): preloaded before its first turn, and the ones it opened itself.
    if (e.event === 'agent.start' && Array.isArray(e.skills)) r.preloaded = e.skills;
    const skill = skillOf(e);
    if (skill) inc(r.loaded, skill);
    if (e.tokens && e.reply && !seen.has(e.reply)) {
      seen.add(e.reply);
      r.tokens += e.tokens;
      r.cost += costOf(e, prices) || 0;
      const f = familyOf(e.model);
      r.byModel[f] = (r.byModel[f] || 0) + e.tokens;
    }
    rows.set(key, r);
  }
  const out = [...rows.values()].map((r) => {
    const span = r.agent ? spans.get(r.agent) : null;
    const job = r.agent ? jobs.get(r.agent) : null;
    const model = Object.entries(r.byModel).sort((a, b) => b[1] - a[1])[0]?.[0] ?? (job?.model ? familyOf(job.model) : null);
    return { agent: r.agent, who: r.who, job: r.agent ? job?.what ?? null : 'its own turns for this ticket', model, tokens: r.tokens, cost: r.cost, from: span?.from ?? r.first, to: span?.to ?? r.last, skills: { preloaded: r.preloaded, loaded: [...r.loaded] } };
  });
  const lead = out.filter((r) => !r.agent);
  return [...out.filter((r) => r.agent && (r.tokens || r.job)).sort((a, b) => a.from - b.from), ...lead.filter((r) => r.tokens)];
}

// How many agents worked on a ticket: the ones its agent rows list (a job from its spawn, or tokens), not every
// agent id its lines mention.
export const agentCount = (t) => agentRows(t).filter((r) => r.agent).length;
