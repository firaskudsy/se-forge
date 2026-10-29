// forge dashboard (decisions 98 to 100, 122, 137, 143): one local HTML page with where the project is (steps.mjs), and
// fifteen charts, the app's screenshots and a ticket table in nine tabs, from the project's own records (data.mjs) and
// the measures (measures.mjs). No library, no network: the pictures are inside the page. Written next to a CSV.
import fs from 'node:fs';
import path from 'node:path';
import { projectData, readAgentFiles } from './data.mjs';
import { ticketSummaries, progress, roles, friction, replies, composition, daily, groupBy, stageOf, projectTimeline, agentRows, agentCount, agentsAndSkills, STAGES, PARTS, WAIT_KINDS } from './measures.mjs';
import { stackGuides, ALL_GUIDES } from '../../policy/lib/stack.mjs';
import { stackedBars, columns, gantt, burnup, dayStrips, flow, esc } from './svg.mjs';
import { BANDS, issueFlow, countsText, issueLinks, isEpic, fromBoard, issueTicket, webUrl, treeUrl } from './issues.mjs';
import { git } from '../../policy/lib/context.mjs';
import { renderArchitecture } from './architecture-view.mjs';
import { projectSteps } from './steps.mjs';
import { renderSteps } from './steps-view.mjs';
import { ticketUsage, ticketLimits, reached, teamPaths } from '../../policy/lib/limits.mjs';
import { day, weekday, clock, when } from './format.mjs';
import { duration } from '../timeline.mjs';
import { fmt } from '../metrics.mjs';

const T = (e) => Date.parse(e.at);
const H = 3600000;
const FAMILIES = [['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku'], ['fable', 'Fable'], ['other', 'Other']];
export const dollars = (v) => (v > 0 && v < 0.01 ? '<$0.01' : `$${v >= 100 ? v.toFixed(0) : v.toFixed(2)}`);
const hrs = (v) => `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} h`;
export const range = (e) => (e ? (e.low === e.high ? `${e.low} h` : `${e.low}–${e.high} h`) : '');
export const pct = (v) => `${Math.round(v * 100)}%`;

function byFamily(lines, prices, money) {
  const out = {};
  for (const r of replies(lines, prices)) {
    const k = FAMILIES.some(([f]) => f === r.family) ? r.family : 'other';
    out[k] = (out[k] || 0) + (money ? r.cost || 0 : r.tokens);
  }
  return out;
}

// Everything the page shows, for the selected days and tickets.
// issues: what readIssues returned (the tracker's issues with their history; every one but the epics is a row of the
// ticket table), or null. app: what appInfo found (the app's Compose file, services and code), or null.
// architecture: what architectureModel gathered, or null.
// watch: { every } (minutes) when forge dashboard --watch rebuilds the page, which then reloads itself.
// limits: the project's per-ticket limits (policy.limits, decision 127); each open ticket gets what it used of them.
// tracker: gitlab or github, for each ticket's link to its issue. repos: a system's member repositories (projectData).
// stack: the project's stack in its own words, which tells the stack guides it uses from the ones it does not (decision 137).
// promote: the branches a release goes through after base (config.branches.promote), for the stepper's last step.
export function dashboardModel({ main, folder, teamRoot, base, stateDir, prices = {}, engineers = [], days = null, only = null, kit = null, issues = null, app = null, architecture = null, watch = null, limits = null, tracker = 'gitlab', repos = null, stack = [], promote = ['staging', 'main'], now = Date.now() }) {
  const data = projectData({ main, folder, teamRoot, base, stateDir, repos });
  const since = days ? now - days * 24 * H : -Infinity;
  // The stepper shows where the project is, whatever --days says (decision 143).
  const everyLine = data.lines;
  data.lines = data.lines.filter((e) => T(e) >= since);
  const all = ticketSummaries(data, { prices, engineers, now });
  if (limits) {
    const team = teamPaths(folder);
    for (const t of all.filter((x) => x.from !== null && !x.mergedAt)) {
      const used = ticketUsage({ stateDir, ...team }, t.num);
      const lim = ticketLimits(limits, stateDir, t.num);
      t.limit = { used, lim, over: reached(used, lim) };
    }
  }
  const picked = all.filter((t) => (!only || only.includes(t.num)) && (t.from !== null || (t.mergedAt && t.mergedAt >= since)));
  // The ticket table lists every ticket (decision 135): the ones worked on, and the ones nobody has picked yet, from
  // the bootstrap and from the board (issues filed since, epics left out), each with its status on the board. With
  // --days: the tickets worked on or merged in those days, and every one still to do.
  const board = new Map((issues?.issues ?? []).filter((i) => !isEpic(i)).map((i) => [Number(i.id), i]));
  for (const t of all) {
    if (!board.has(t.num)) continue;
    const b = fromBoard(board.get(t.num));
    t.board = { status: b.status, closed: b.closed };
    // A ticket begun before its plan is written has only the board's title and areas.
    t.title ||= b.title;
    if (!t.areas.length) t.areas = b.areas;
    t.repo ??= b.repo;
  }
  const every = [...all, ...[...board.values()].filter((i) => !all.some((t) => t.num === Number(i.id))).map(issueTicket)].sort((a, b) => a.num - b.num);
  const table = every.filter((t) => (!only || only.includes(t.num)) && (!days || picked.includes(t) || !(t.mergedAt || t.board?.closed)));
  const lines = only ? data.lines.filter((e) => picked.some((t) => t.id === e.ticket) || (!e.agent && !e.ticket && picked.some((t) => t.from !== null && T(e) >= t.from && T(e) <= t.to))) : data.lines;
  const money = Object.keys(prices).length > 0;
  const merges = all.filter((t) => t.mergedAt).map((t) => ({ at: t.mergedAt, title: `${t.id}${t.title ? ` ${t.title}` : ''} merged ${when(t.mergedAt)}` }));
  const shots = data.shots.filter((s) => s.at >= since && (!only || only.includes(s.ticket))).map((s, i) => ({ ...s, n: i + 1 }));
  const marks = shots.map((s) => ({ at: s.at, href: `#shot-${s.n}`, title: `Screenshot ${clock(s.at)}${s.ticket ? ` · #${s.ticket}` : ''} · ${s.what}` }));
  const tracked = issues ? { ...issueFlow(issues.issues), host: issues.host, readAt: issues.readAt, error: issues.error, behind: issues.behind ?? null } : null;
  const origin = (dir) => (dir ? git(dir, ['remote', 'get-url', 'origin']).out : '');
  const link = issueLinks({ issues: issues?.issues ?? [], remote: origin(main), tracker });
  const mine = new Set(Object.values(stackGuides(stack)).flat());
  const skills = agentsAndSkills(lines, { ...readAgentFiles(main), otherGuides: ALL_GUIDES.filter((g) => !mine.has(g)) });
  const prog = progress(data, all, now);
  const steps = projectSteps({ folder, main, base, promote, data, lines: everyLine, board: issues?.readAt ? [...board.entries()].map(([num, i]) => ({ num, closed: fromBoard(i).closed })) : null, all, progress: prog });
  return { data, all, tickets: picked, every, table, only, kit, issues: tracked, app, architecture, watch, link, repoLinks: repoLinks({ main, folder, repos, origin }), lines, money, prices, now, since, shots, progress: prog, steps, roles: roles(lines, prices), friction: friction(lines), timeline: projectTimeline(lines, { merges, shots: marks }), skills };
}

// The project's repositories on their host, for the links beside the page's title: the client repo (a system's
// member repositories, each by its name), then the project's folder in the team repo, on the branch checked out.
// A repository whose remote is on this machine, or has none, gets no link.
export function repoLinks({ main, folder, repos = null, origin }) {
  const name = (url) => url.replace(/^\w+:\/\/[^/]+\//, '');
  const out = [];
  const add = (label, url, shown = url && name(url)) => { if (url) out.push({ label, url, name: shown }); };
  add('Project repo', webUrl(origin(main)));
  for (const r of repos ?? []) add(r.name, webUrl(origin(r.dir)));
  const team = folder ? webUrl(origin(folder)) : null;
  const dir = team ? git(folder, ['rev-parse', '--show-prefix']).out.replace(/\/$/, '') : '';
  add('Team repo', team && treeUrl(team, dir && git(folder, ['rev-parse', '--abbrev-ref', 'HEAD']).out, dir), team && `${name(team)}${dir ? ` › ${dir}` : ''}`);
  return out;
}

// A ticket's status: its board's (decision 135), else what the records tell.
export const statusText = (t) => t.board?.status ?? (t.mergedAt ? 'Merged' : t.from !== null ? 'Started' : 'Not started');

const CSV = ['ticket', 'title', 'status', 'stories', 'areas', 'gates', 'estimate', 'actual_h', 'wall_h', 'agents_h', 'waiting_h', 'idle_h', 'agents', 'review_rounds', 'blocker_rounds', 'sent_back', 'tokens', 'opus_tokens', 'sonnet_tokens', 'haiku_tokens', 'cost_usd', 'rework_tokens', ...STAGES.map(([k]) => `${k}_tokens`), 'merged'];
const cell = (v) => (v === undefined || v === null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
function rowOf(t) {
  const h1 = (ms) => (ms ? (ms / H).toFixed(2) : '');
  return {
    ticket: t.id, title: t.title, status: statusText(t), stories: t.stories.join(' '), areas: t.areas.join(' '), gates: t.gates ?? '', estimate: range(t.estimate), actual_h: t.actual ?? '',
    wall_h: h1(t.split?.total), agents_h: h1(t.split?.agents), waiting_h: h1(t.split?.waiting), idle_h: h1(t.split?.idle), agents: t.lines?.length ? agentCount(t) : '',
    review_rounds: t.rework?.rounds ?? (t.rounds.length || ''), blocker_rounds: t.rework?.blockerRounds ?? '', sent_back: t.rework?.sentBack ?? '',
    tokens: t.tokens?.total ?? '', opus_tokens: t.tokens?.byModel?.opus ?? '', sonnet_tokens: t.tokens?.byModel?.sonnet ?? '', haiku_tokens: t.tokens?.byModel?.haiku ?? '',
    cost_usd: t.tokens?.cost ? t.tokens.cost.toFixed(4) : '', rework_tokens: t.rework?.rework.tokens ?? '', merged: t.mergedAt ? new Date(t.mergedAt).toISOString() : '', repo: t.repo ?? '',
    ...Object.fromEntries(STAGES.map(([k]) => [`${k}_tokens`, t.lines?.length ? (groupBy(replies(t.lines), (r) => stageOf(r.who))[k]?.tokens ?? 0) : ''])),
  };
}
// A system's table names each ticket's repository last (decision 131).
export const csv = (m) => { const cols = m.data.repos?.length ? [...CSV, 'repo'] : CSV; return [cols.join(','), ...m.table.map((t) => { const r = rowOf(t); return cols.map((c) => cell(r[c])).join(','); })].join('\n'); };

// The links beside the title to the repositories (repoLinks), each opening in a new tab.
const repoNav = (links) => (links?.length ? `<nav class="repos" aria-label="Repositories">${links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener" title="${esc(l.url)}"><span>${esc(l.label)}</span><b>${esc(l.name)}</b><i aria-hidden="true">↗</i></a>`).join('')}</nav>` : '');

function legend(keys) {
  return `<div class="legend">${keys.map((k) => `<span><i class="${k.cls}"></i>${esc(k.label)}</span>`).join('')}</div>`;
}
const TABS = [['overview', 'Overview'], ['architecture', 'Architecture'], ['time', 'Time'], ['cost', 'Cost'], ['quality', 'Quality'], ['skills', 'Agents & skills'], ['screens', 'Screens'], ['app', 'Run the app'], ['tickets', 'Tickets']];
const panel = (id, body) => `<section class="panel" id="tab-${id}" role="tabpanel" aria-labelledby="tab-btn-${id}">${body}</section>`;
const card = (n, title, question, body) => `<section class="card"><h2><span class="num">${n}</span>${esc(title)}</h2><p class="q">${esc(question)}</p>${body}</section>`;

// The kit version this checkout runs (.forge/kit: its hooks, agents and skills), with the project's pin and
// this forge command when they differ, and the model server it runs on instead of Claude (forge llm, decision 140).
// forge dashboard --text prints the same words.
export function kitText(k) {
  if (!k?.active) return k?.pinned ? `no kit in this checkout, the project pins se-forge ${k.pinned}: forge sync` : '';
  const pin = k.pinned && k.pinned !== k.active ? `, but the project pins ${k.pinned}: forge sync` : '';
  const cli = k.cli && k.cli !== k.active ? ` (the forge command is ${k.cli})` : '';
  return `se-forge ${k.active}${pin}${cli}${k.llm ? `, on the model server ${k.llm}` : ''}`;
}

// The token kinds in three groups: what each reply re-reads from the cache (the conversation so far, sent again),
// what is new in it (input and cache writes), and what the model writes (output, its thinking included).
export const SPLIT = [['reread', 're-read', ['cacheRead']], ['fresh', 'new', ['input', 'cacheWrite5m', 'cacheWrite1h']], ['output', 'output', ['output']]];
export const SPLIT_HINT = 'Re-read: the conversation so far, which every reply sends again and the cache serves cheaply. New: what was added to it (input and cache writes). Output: what the model wrote, its thinking included.';

// The totals above the tabs; forge dashboard --text prints the same ones.
export function totals(m) {
  const rs = replies(m.lines, m.prices);
  const value = (r) => (m.money ? r.cost || 0 : r.tokens);
  const all = rs.reduce((x, r) => x + value(r), 0);
  const sum = (of, keys) => rs.reduce((s, r) => s + (r[of] ? keys.reduce((x, k) => x + r[of][k], 0) : 0), 0);
  return {
    tokens: rs.reduce((s, r) => s + r.tokens, 0),
    cost: rs.reduce((s, r) => s + (r.cost || 0), 0),
    split: Object.fromEntries(SPLIT.map(([k, , keys]) => [k, { tokens: sum('parts', keys), cost: sum('partCost', keys) }])),
    opusShare: all ? rs.filter((r) => r.family === 'opus').reduce((x, r) => x + value(r), 0) / all : 0,
    working: m.timeline?.working || 0,
    waiting: m.timeline?.waiting || 0,
    agents: m.lines.filter((e) => e.event === 'agent.start').length,
  };
}

// "95.8M re-read (93%) · 5.6M new · 2.2M output", or the same in dollars; '' before any tokens.
export function splitText(sums, of = 'tokens', sep = ' · ') {
  const total = SPLIT.reduce((x, [k]) => x + sums.split[k][of], 0);
  if (!total) return '';
  const show = of === 'cost' ? dollars : fmt;
  return SPLIT.map(([k, label], i) => `${show(sums.split[k][of])} ${label}${i === 0 ? ` (${pct(sums.split[k][of] / total)})` : ''}`).join(sep);
}

export function renderPage(m, { project }) {
  const timed = m.tickets.filter((t) => t.from !== null);
  const label = (t) => { const s = `${t.id}${t.title ? ` ${t.title}` : ''}`; return s.length > 28 ? `${s.slice(0, 27).replace(/\s+\S*$/, '')}…` : s; };
  const pt = m.timeline;
  const p = m.progress;
  const money = m.money;
  const amount = money ? dollars : fmt;
  const sums = totals(m);
  const costNote = money ? '' : '<p class="hint">Tokens shown: add prices to project.json to see dollars (the guide, part E).</p>';
  const kpis = [
    ['Tickets merged', `${p.ticketsDone.length} of ${p.totalTickets}`],
    ['Stories done', p.totalStories ? `${p.storiesDone.length} of ${p.totalStories}` : 'no story list'],
    ['Tokens', fmt(sums.tokens), splitText(sums)],
    ['API cost', money ? dollars(sums.cost) : 'no prices set', money ? splitText(sums, 'cost') : ''],
    ['Working time', duration(sums.working)],
    ['Waiting for you', duration(sums.waiting)],
    [money ? 'Opus share of cost' : 'Opus share of tokens', pct(sums.opusShare)],
    ['Agents', String(sums.agents)],
  ];

  // Chart 1: where each ticket's time goes.
  const TIME = [{ key: 'agents', label: 'Agents working', cls: 'c-agents' }, { key: 'gates', label: 'Gates running', cls: 'c-gates' }, { key: 'waiting', label: 'Waiting for you', cls: 'c-waiting' }, { key: 'lead', label: 'Lead alone', cls: 'c-lead' }, { key: 'idle', label: 'Nobody working', cls: 'c-idle' }];
  const c1 = stackedBars({ rows: timed.map((t) => ({ label: label(t), parts: Object.fromEntries(TIME.map((k) => [k.key, t.split[k.key] / H])), right: `${duration(t.split.total)}${t.open ? ' so far' : ''} · you ${duration(t.split.waiting)}` })), keys: TIME, fmt: hrs });

  // The project over time: the AI's lane and your lane, one row per day.
  const WAITS = WAIT_KINDS.map(([k, l, short]) => ({ key: k, label: l, short, cls: `w-${k}` }));
  const AI = TIME.filter((k) => ['agents', 'gates', 'lead'].includes(k.key));
  const span = (k, a, b) => `${k.label} ${clock(a)}–${clock(b)} (${duration(b - a)})`;
  const cDays = pt?.days.length ? dayStrips({
    lo: pt.lo, hi: pt.hi, laneLabels: ['AI', 'You'],
    rows: pt.days.map((d) => ({
      label: weekday(d.day), day: d.day, from: d.from, to: d.to, right: `AI ${duration(d.ai)} · you ${duration(d.you)}`,
      lanes: [
        AI.flatMap((k) => d.work[k.key].map(([a, b]) => ({ from: a, to: b, cls: k.cls, title: span(k, a, b) }))),
        d.waits.map((w) => ({ from: w.span[0], to: w.span[1], cls: `w-${w.kind}`, title: `${w.what} · ${duration(w.ms)} from ${when(w.at)}` })),
      ],
      marks: d.merges, shots: d.shots,
    })),
  }) : '<p class="empty">No timeline yet: the hooks write it from kit 0.2.6, or run forge timeline import.</p>';
  const kinds = WAITS.filter((k) => pt?.byKind[k.key].n);
  const kindsText = kinds.length ? `<p class="fc">Waiting for you: <b>${duration(pt.waiting)}</b> in ${pt.waits.length} waits (${kinds.map((k) => `${k.short} ${duration(pt.byKind[k.key].ms)}`).join(', ')}). The Time tab lists the longest.</p>` : '';
  const MARK = { label: 'Merged', cls: 'mk' };
  const SHOT = pt?.days.some((d) => d.shots.length) ? [{ label: 'Screenshot', cls: 'shk' }] : [];

  // Waiting for you: by kind, and the longest waits with the tickets running then.
  const cKinds = kinds.length ? stackedBars({ rows: kinds.map((k) => ({ label: k.label, parts: { [k.key]: pt.byKind[k.key].ms / H }, right: `${pt.byKind[k.key].n} wait${pt.byKind[k.key].n === 1 ? '' : 's'} · longest ${duration(pt.byKind[k.key].longest)}` })), keys: WAITS, fmt: hrs, labelW: 230 }) : '<p class="empty">No waits for you recorded.</p>';
  const running = (t) => timed.filter((x) => t >= x.from && t <= x.to).map((x) => x.id).join(' ') || 'no ticket';
  const longest = (pt?.waits || []).slice().sort((a, b) => b.ms - a.ms).slice(0, 8);
  const waitList = longest.length ? `<h3>Longest waits for you</h3><ol class="list">${longest.map((w) => `<li><b>${duration(w.ms)}</b> ${esc(running(w.at))} · ${esc(w.what)} <span class="dim">${esc(when(w.at))}</span></li>`).join('')}</ol>` : '';

  // The app's screens: forge shot's pictures, by day, each inside the page.
  const ticketName = (num) => { const t = m.all.find((x) => x.num === num); return `#${num}${t?.title ? ` ${t.title}` : ''}`; };
  const picture = (s) => { try { return `data:${s.file.endsWith('.png') ? 'image/png' : 'image/jpeg'};base64,${fs.readFileSync(s.path).toString('base64')}`; } catch { return null; } };
  const figure = (s) => {
    const src = picture(s);
    return `<figure class="shot" id="shot-${s.n}">${src ? `<a href="#shot-${s.n}" title="Show it larger"><img src="${src}" alt="${esc(s.what)}" width="${Number(s.width) || ''}" height="${Number(s.height) || ''}"></a>` : `<p class="empty">The picture ${esc(s.file)} is missing from shots/.</p>`}<figcaption><b>${esc(clock(s.at))}</b> · ${esc(s.ticket ? ticketName(s.ticket) : 'no ticket')}<br>${esc(s.what)}<span class="dim">${s.branch ? ` · ${esc(s.branch)}` : ''}${s.commit ? ` ${esc(s.commit.slice(0, 8))}` : ''}</span> <a class="smaller" href="#screens">Smaller</a></figcaption></figure>`;
  };
  const shotDays = [];
  for (const s of m.shots) {
    if (shotDays.at(-1)?.label !== weekday(s.at)) shotDays.push({ label: weekday(s.at), shots: [] });
    shotDays.at(-1).shots.push(s);
  }
  const cShots = shotDays.length ? shotDays.map((d) => `<h3>${esc(d.label)}</h3><div class="shots">${d.shots.map(figure).join('')}</div>`).join('') : '<p class="empty">No screenshots yet. The QA engineer records them when a UI ticket passes; to add one yourself: forge shot &lt;image&gt; "&lt;what it shows&gt;".</p>';

  // Chart 2: cost per ticket, by model.
  const MODELS = FAMILIES.map(([k, l]) => ({ key: k, label: l, cls: `m-${k}` }));
  const withTokens = timed.filter((t) => t.tokens?.total);
  const c2 = withTokens.length ? stackedBars({ rows: withTokens.map((t) => ({ label: label(t), parts: byFamily(t.lines, m.prices, money), right: [t.estimate ? `est ${range(t.estimate)}` : 'no estimate', t.actual !== null ? `actual ${t.actual} h` : null, t.areas.join(',')].filter(Boolean).join(' · ') })), keys: MODELS, fmt: amount }) : '<p class="empty">No tokens recorded yet: tokens are in the timeline from 0.2.7, or run forge timeline import.</p>';

  // Chart 4: who spends it, each role split by model.
  const top = m.roles.slice(0, 12);
  const cRoles = top.length ? stackedBars({ rows: top.map((r) => ({ label: r.who, parts: money ? r.costByModel : r.byModel, right: `${pct(r.share)} · ${pct(r.running)} so far${r.spawns ? ` · ${r.spawns} spawns, ${amount((money ? r.cost : r.tokens) / r.spawns)} each` : ''}` })), keys: MODELS, fmt: amount, rightW: 300 }) : '<p class="empty">No tokens recorded yet.</p>';
  const rolesModels = MODELS.filter((k) => top.some((r) => r.byModel[k.key]));

  // Chart 3: cost per ticket, by stage.
  const STAGE_KEYS = STAGES.map(([k, l]) => ({ key: k, label: l, cls: `s-${k}` }));
  const stageRows = withTokens.map((t) => { const g = groupBy(replies(t.lines, m.prices), (r) => stageOf(r.who)); return { label: label(t), parts: Object.fromEntries(STAGES.map(([k]) => [k, money ? g[k]?.cost || 0 : g[k]?.tokens || 0])), g }; });
  const cStages = stageRows.length ? stackedBars({ rows: stageRows.map((r) => { const total = STAGES.reduce((x, [k]) => x + r.parts[k], 0); const review = r.parts.review; return { label: r.label, parts: r.parts, right: `${amount(total)} · reviews ${pct(total ? review / total : 0)}` }; }), keys: STAGE_KEYS, fmt: amount }) : '<p class="empty">No tokens recorded yet.</p>';

  // Chart 5: what the cost is made of, each model by token kind.
  const KINDS = [{ key: 'input', label: 'New: input', cls: 'k-input' }, { key: 'cacheWrite5m', label: 'New: cache write (5 min)', cls: 'k-cw5' }, { key: 'cacheWrite1h', label: 'New: cache write (1 hour)', cls: 'k-cw1' }, { key: 'cacheRead', label: 'Re-read: cache read', cls: 'k-cr' }, { key: 'output', label: 'Output', cls: 'k-output' }];
  const comp = composition(m.lines, m.prices);
  const compRows = FAMILIES.filter(([f]) => comp[f]).map(([f, l]) => { const c = comp[f]; const shown = money && c.priced ? c.cost : c.tokens; const total = PARTS.reduce((x, k) => x + (shown[k] || 0), 0); return { label: l, parts: shown, right: `${amount(total)}${money && !c.priced ? ' (tokens: no price for it)' : ''} · cache reads ${pct(total ? (shown.cacheRead || 0) / total : 0)}, output ${pct(total ? (shown.output || 0) / total : 0)}` }; });
  const cComp = compRows.length ? stackedBars({ rows: compRows, keys: KINDS, fmt: amount, rightW: 300 }) : '<p class="empty">No tokens recorded yet.</p>';

  // Chart 6: spend per day, by model.
  const days = daily(m.lines, m.prices);
  const cDaily = days.length ? columns({ cols: days.map((d) => ({ label: day(d.day), parts: money ? d.cost : d.tokens })), keys: MODELS, fmt: amount }) : '<p class="empty">No tokens recorded yet.</p>';


  // Chart 7: rework.
  const reworked = timed.filter((t) => t.rework && (t.rework.first.tokens || t.rework.rework.tokens));
  const c4 = reworked.length ? stackedBars({ rows: reworked.map((t) => ({ label: label(t), parts: { first: money ? t.rework.first.cost : t.rework.first.tokens, rework: money ? t.rework.rework.cost : t.rework.rework.tokens }, right: `${t.rework.rounds} round${t.rework.rounds === 1 ? '' : 's'}, ${t.rework.blockerRounds} with blockers · sent back ${t.rework.sentBack}× · rework ${duration(t.rework.rework.ms)}` })), keys: [{ key: 'first', label: 'First pass', cls: 'c-first' }, { key: 'rework', label: 'After the first blocker', cls: 'c-rework' }], fmt: amount, rightW: 330 }) : '<p class="empty">No tickets with tokens yet.</p>';

  // Chart 8: friction map.
  const f = m.friction;
  const maxTokens = Math.max(1, ...f.rows.flatMap((r) => Object.values(r.cells).map((c) => c.tokens)));
  const c5 = f.rows.length ? `<div class="scroll"><table class="heat"><thead><tr><th></th>${f.cols.map((c) => `<th>${esc(c)}</th>`).join('')}<th>total</th></tr></thead><tbody>${f.rows.map((r) => `<tr><th>${esc(r.row)}</th>${f.cols.map((c) => { const x = r.cells[c]; return x ? `<td style="--a:${(0.12 + 0.88 * (x.tokens / maxTokens)).toFixed(2)}" title="${esc(`${r.row} · ${c}: ${x.n} calls, ${fmt(x.tokens)} tokens in the replies that made them`)}">${x.n}</td>` : '<td class="none"></td>'; }).join('')}<td class="total">${r.total}</td></tr>`).join('')}</tbody></table></div>`
    + (f.reasons.length ? `<h3>Most frequent refusals</h3><ol class="list">${f.reasons.map(([k, c]) => `<li><b>${c}×</b> ${esc(k)}</li>`).join('')}</ol>` : '') : '<p class="empty">No refusals or failed calls.</p>';

  // Agents and skills (decision 137): when sub-agents ran, and the playbooks each had: preloaded before its first turn,
  // or opened itself (a Skill call, or a read of its SKILL.md).
  const sk = m.skills;
  const times = (map) => [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(', ');
  const SKILL_KEYS = [{ key: 'with', label: 'Agents with a skill', cls: 'c-agents' }, { key: 'without', label: 'Agents with none', cls: 'c-idle' }];
  const withAny = sk.runs.filter((r) => r.preloaded.length || r.loaded.size).length;
  const cSkillDays = sk.days.length ? stackedBars({ rows: sk.days.map((d) => ({ label: weekday(d.day), parts: { with: d.withSkill, without: d.agents - d.withSkill }, right: `${d.agents} agent${d.agents === 1 ? '' : 's'} · ${d.loads} opened${d.preloads ? `, ${d.preloads} preloaded` : ''}` })), keys: SKILL_KEYS, fmt: (v) => String(Math.round(v)), rightW: 260 }) : '<p class="empty">No agents in the timeline yet.</p>';
  const leadText = `The lead itself: ${fmt(sk.lead.calls)} calls, ${sk.lead.spawns} sub-agents started, ${sk.lead.loads} skill${sk.lead.loads === 1 ? '' : 's'} opened, ${sk.lead.edits.length ? `<b>${sk.lead.edits.length} of the app's files edited</b> (${esc(sk.lead.edits.slice(0, 3).map(([f, n]) => `${f}${n > 1 ? ` ×${n}` : ''}`).join(', '))}${sk.lead.edits.length > 3 ? '…' : ''}): work a lane should do` : "none of the app's files edited"}.`;
  const skillsText = sk.runs.length ? `<p class="fc"><b>${withAny} of ${sk.runs.length}</b> agents had a skill. Skills opened ${sk.skills.reduce((x, k) => x + k.loads, 0)} times and preloaded ${sk.skills.reduce((x, k) => x + k.preloads, 0)} times; ${sk.skills.length} of ${sk.available || 'the'} skills used. ${leadText}</p>${sk.recorded ? '' : '<p class="hint">Preloads are recorded from se-forge 0.2.33: before it, an agent had only the skills it opened itself.</p>'}` : '';
  const roleRows = sk.roles.map((x) => `<tr><td class="nw">${esc(x.who)}</td><td class="n">${x.runs}</td><td class="n">${x.withSkill}</td><td>${esc(times(x.preloaded)) || (x.preloads.length ? `<span class="dim">from the next run: ${esc(x.preloads.join(', '))}</span>` : '')}</td><td>${esc(times(x.loaded))}</td><td>${x.unused.length ? `<span class="note">${esc(x.unused.join(', '))}</span>` : ''}</td></tr>`).join('');
  const cSkillRoles = sk.roles.length ? `<div class="scroll"><table class="wrap"><thead><tr><th>Role</th><th>Agents</th><th>With a skill</th><th>Preloaded</th><th>Opened itself</th><th>Named in its instructions, never used</th></tr></thead><tbody>${roleRows}</tbody></table></div><p class="dim">Some named skills are needed only at a step: the requirements panel in a bootstrap, a load test with Gates: performance.</p>` : '<p class="empty">No agents in the timeline yet.</p>';
  const skillRows = sk.skills.map((k) => `<tr><td class="nw">${esc(k.name)}</td><td class="n">${k.loads || ''}</td><td class="n">${k.preloads || ''}</td><td>${esc([...k.roles].join(', '))}</td><td>${esc([...k.tickets].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))).join(' '))}</td><td class="nw">${k.last ? esc(when(k.last)) : ''}</td></tr>`).join('');
  const cSkills = (sk.skills.length ? `<div class="scroll"><table class="wrap"><thead><tr><th>Skill</th><th>Opened</th><th>Preloaded</th><th>By</th><th>Tickets</th><th>Last used</th></tr></thead><tbody>${skillRows}</tbody></table></div>` : '<p class="empty">No skill used yet.</p>')
    + (sk.never.length ? `<h3>Never used (${sk.never.length})</h3><p>${esc(sk.never.join(', '))}</p>` : '')
    + (sk.otherStack.length ? `<p class="dim">Guides for other stacks, not this project's: ${esc(sk.otherStack.join(', '))}.</p>` : '');

  // Chart 9: progress and forecast.
  const from = Math.min(p.start, ...timed.map((t) => t.from));
  const fc = p.forecast;
  const c6a = burnup({
    series: [{ label: 'Tickets', cls: 'l-tickets', total: p.totalTickets, times: p.ticketsDone, forecast: true }, ...(p.totalStories ? [{ label: 'Stories', cls: 'l-stories', total: p.totalStories, times: p.storiesDone }] : [])],
    from, to: m.now, forecast: fc ? { lo: fc.doneLo, mid: fc.doneMid, hi: fc.doneHi, title: `forecast ${day(fc.doneLo)} – ${day(fc.doneHi)}` } : null,
  });
  const fcText = fc ? `<p class="fc">${fc.remaining} tickets left. At the pace of the ${fc.basis} merged so far, one after the other: done around <b>${day(fc.doneMid)}</b> (from ${day(fc.doneLo)} to ${day(fc.doneHi)}), about <b>${fmt(fc.tokensMid)} tokens</b>${money ? ` and <b>${dollars(fc.costMid)}</b> (${dollars(fc.costLo)}–${dollars(fc.costHi)})` : ''}.</p>` : `<p class="fc">Too early for a forecast: it needs at least 3 merged tickets with a timeline (${timed.filter((t) => t.mergedAt).length} so far).</p>`;
  const c6b = timed.length ? gantt({ rows: timed.map((t) => ({ label: label(t), from: t.from, to: t.to, open: t.open, title: `${t.id} ${t.title}: ${when(t.from)} → ${t.open ? 'open' : when(t.to)}`, bars: t.agents.map((a) => [Math.max(a.from, t.from), Math.min(a.to, t.to)]) })), from, to: m.now }) : '';

  // Chart 3: the tracker's issues by status over time (decision 122).
  const iq = m.issues;
  const ISSUE_KEYS = BANDS.map(([k, l]) => ({ key: k, label: l, cls: `i-${k}` }));
  const read = iq?.readAt ? `${esc(iq.host)}, read ${esc(when(iq.readAt))}` : '';
  const cIssues = !iq ? '<p class="empty">No tracker is set for this project.</p>'
    : !iq.points.length ? `<p class="empty">No issue history: ${iq.error ? `${esc(iq.host)} could not be read (${esc(iq.error)}).` : iq.readAt ? 'the tracker has no issues yet.' : 'not read yet; run forge dashboard without --offline.'}</p>`
      : legend(ISSUE_KEYS.slice().reverse()) + flow({ points: iq.points, keys: ISSUE_KEYS, from: Number.isFinite(m.since) ? Math.max(m.since, iq.points[0].at) : iq.points[0].at, to: m.now })
        + `<p class="fc">Now: <b>${esc(countsText(iq.now))}</b>${iq.epics ? ` (${iq.epics === 1 ? 'the epic is' : `${iq.epics} epics are`} not counted: an epic stays open while its tickets close)` : ''}. From ${read}${iq.error ? `; it could not be read now (${esc(iq.error)}), so this is the last read` : ''}${iq.behind ? `; ${esc(iq.behind)}` : ''}.</p>`;

  // Run the app (decision 123): the steps for this project, and whether it runs now (the page asks the address).
  const ap = m.app;
  const sq = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;
  const cmd = (c) => `<div class="cmd"><code>${esc(c)}</code><button type="button" class="copy" data-copy="${esc(c)}">Copy</button></div>`;
  const inMain = (c) => `cd ${sq(ap.main)} && ${c}`;
  const where = ap?.found ? `${ap.found.dir ? `${ap.found.dir}/` : ''}${ap.found.file}` : '';
  const sv = ap?.services;
  const url = sv?.url;
  const code = ap?.code;
  const codeText = code ? `It runs the code checked out in ${ap.main}${code.branch ? `: ${code.branch} at ${code.sha}` : code.sha ? `: ${code.sha}` : ''}${code.behind ? `, ${code.behind} commit${code.behind === 1 ? '' : 's'} behind ${code.upstream} (run git pull there first for the latest)` : ''}.` : '';
  const svcRows = sv ? sv.services.map((x) => `<tr><td>${esc(x.name)}</td><td>${x.ports.length ? x.ports.map((p) => (p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url)}</a>` : esc(p.address))).join(', ') : '<span class="dim">inside the app only</span>'}</td></tr>`).join('') : '';
  const mobileText = ap?.mobile ? '<h3>The mobile app</h3><p>With the API running, in <code>mobile/</code>: <code>flutter run --dart-define=API_URL=http://localhost:8080</code>, with Xcode\'s simulator or an Android emulator open (an Android emulator uses <code>http://10.0.2.2:8080</code>; skill <code>stack-flutter</code>).</p>' : '';
  const cApp = !ap ? '<p class="empty">Not available in this view.</p>'
    : !ap.found ? `<p class="empty">This project has no Compose file yet (at the root, or in frontend/, backend/ or mobile/): forge new adds one (skill dev-environment).</p>${mobileText}`
      : `${url ? `<p class="status" data-probe="${esc(url)}"><i></i><span>Checking ${esc(url)}…</span></p>` : ''}
<ol class="steps">
<li>Open <b>Docker Desktop</b> and wait until it says it is running.</li>
<li>In Terminal:${cmd(inMain('forge app up'))}<span class="dim">It builds and starts ${esc(sv ? sv.services.map((x) => x.name).join(', ') : 'the app')} (${esc(where)}), waits until they are healthy and opens the app. The first build takes a few minutes; later ones reuse it.</span></li>
<li>Open the app: ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>` : 'no service publishes a web port.'}</li>
</ol>
<h3>Stop it</h3>${cmd(inMain('forge app down'))}<p class="dim">The data stays (its volumes), so the next start has it.</p>
<h3>After a dependency change</h3>${cmd(inMain('forge app up --fresh'))}<p class="dim">For a new package in package.json and the like: it renews the containers' own copies of the dependencies.</p>
<h3>What runs</h3>${ap.error ? `<p class="empty">${esc(ap.error)}</p>` : `<div class="scroll"><table><thead><tr><th>Service</th><th>On this Mac</th></tr></thead><tbody>${svcRows}</tbody></table></div>`}
<p class="dim">${esc(codeText)} <code>forge app</code> shows what runs now.</p>${mobileText}`;

  // The ticket table.
  // The columns people look for first come first (status, tokens and cost by the title); the rest scroll sideways.
  // A system's tickets name their repository (decision 131), with a filter above the table.
  const system = m.data.repos?.length > 0;
  const cols = [['Ticket', (t) => t.num], ['Title', (t) => t.title], ...(system ? [['Repo', (t) => t.repo ?? '']] : []), ['Status', statusText], ['Tokens', (t) => t.tokens?.total ?? ''], ['Cost', (t) => t.tokens?.cost || ''], ['Agents', (t) => (t.lines?.length ? agentCount(t) : '')], ['Rounds', (t) => t.rework?.rounds ?? (t.rounds.length || '')], ['Wall', (t) => t.split?.total ?? ''], ['You', (t) => t.split?.waiting ?? ''], ['Estimate', (t) => range(t.estimate)], ['Actual', (t) => (t.actual ?? '')], ['Merged', (t) => t.mergedAt ?? ''], ['Opus', (t) => (t.tokens?.total ? (t.tokens.byModel.opus || 0) / t.tokens.total : '')], ['Stories', (t) => t.stories.join(' ')], ['Areas', (t) => t.areas.join(',')], ['Gates', (t) => t.gates ?? '']];
  const show = (name, v) => (v === '' ? '' : ['Wall', 'You'].includes(name) ? duration(v) : name === 'Tokens' ? fmt(v) : name === 'Opus' ? pct(v) : name === 'Cost' ? dollars(v) : name === 'Merged' ? day(v) : name === 'Ticket' ? `#${v}` : v);
  // A ticket's number opens its issue on the tracker; ▸ opens its agents one by one, under the row (decision 129).
  const cellHtml = (c, v, t) => { const url = c === 'Ticket' && m.link ? m.link(t.num) : null; return url ? `<a href="${esc(url)}" target="_blank" rel="noopener" title="Open #${esc(t.num)} on the tracker">${esc(show(c, v))}</a>` : esc(show(c, v)); };
  const agentTable = (t) => {
    const rows = agentRows(t, m.prices);
    if (!rows.length) return null;
    const head = ['Agent', 'Job', 'Model', 'Skills', 'Tokens', ...(money ? ['Cost'] : []), 'Time', 'Started'];
    // Its skills (decision 137): the preloaded ones, then the ones it opened itself.
    const skillsOf = (x) => [x.preloaded.join(', '), x.loaded.length ? `opened ${x.loaded.map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(', ')}` : ''].filter(Boolean).join(' · ');
    const body = rows.map((r) => `<tr><td>${esc(r.who)}</td><td>${esc(r.job ?? '')}</td><td>${esc(r.model ?? '')}</td><td>${skillsOf(r.skills) ? esc(skillsOf(r.skills)) : '<span class="dim">none</span>'}</td><td class="n">${esc(fmt(r.tokens))}</td>${money ? `<td class="n">${esc(dollars(r.cost))}</td>` : ''}<td class="n">${esc(r.agent ? duration(Math.max(0, r.to - r.from)) : '')}</td><td>${esc(r.agent ? when(r.from) : '')}</td></tr>`).join('');
    return `<table class="agents"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`;
  };
  const ticketRows = m.table.map((t) => {
    const agents = agentTable(t);
    const cells = cols.map(([c, get], i) => { const v = get(t); return `<td data-v="${esc(v)}"${c === 'Title' ? ` class="title" title="${esc(v)}"` : ''}>${i === 0 && agents ? `<button type="button" class="exp" aria-expanded="false" aria-label="Show the agents of #${esc(t.num)}" title="The agents of #${esc(t.num)}, one by one">▸</button>` : ''}${cellHtml(c, v, t)}</td>`; }).join('');
    return `<tr class="t-row"${system ? ` data-repo="${esc(t.repo ?? '')}"` : ''}>${cells}</tr>${agents ? `<tr class="t-agents" hidden><td colspan="${cols.length}">${agents}</td></tr>` : ''}`;
  }).join('');
  const filter = system ? `<p class="repo-filter"><label>Repository <select id="repo-filter"><option value="">all ${m.data.repos.length}</option>${m.data.repos.map((r) => `<option>${esc(r)}</option>`).join('')}</select></label></p>` : '';
  const table = `${filter}<div class="scroll"><table class="tickets"><thead><tr>${cols.map(([c], i) => `<th data-i="${i}">${c}</th>`).join('')}</tr></thead><tbody>${ticketRows}</tbody></table></div>`;

  const live = m.lines.filter((e) => e.source !== 'import').length;
  const imported = m.lines.length - live;
  const notes = [
    `Sources: ${m.data.stories.length} stories and ${m.data.plannedTickets} tickets from the bootstrap; ${m.data.tickets.filter((t) => t.planned).length} plans; ${m.data.tickets.filter((t) => t.rounds.length).length} tickets with review history; ${p.ticketsDone.length} merges on the base branch; ${m.shots.length} screenshots from shots/; ${live} timeline lines${imported ? ` and ${imported} imported from Claude Code's logs (a call's time includes any permission prompt; gate runs have no duration)` : ' (run forge timeline import for the history before 0.2.6)'}.`,
    'A ticket runs from its first line to its merge. The lead\'s lines without a ticket count for every ticket running at that moment. A stretch of 15 minutes with nothing happening counts as nobody working.',
    'Working time: the AI at work (agents, gates, the lead\'s turns), each moment once, from the first line to the last: without the waits for you, and without the stretches of 15 minutes with nothing happening (a laptop asleep, a closed session). The top lane of chart 1, added up.',
    money ? 'Cost: what the same tokens would cost on the API at the prices in project.prices, not the subscription bill.' : 'No prices: add project.prices to project.json for the API cost (docs/metrics.md).',
    m.data.tickets.some((t) => t.planned && !t.estimate) ? 'Plans without an Estimate section have no estimate in chart 6 or the table.' : '',
  ].filter(Boolean);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(project)} dashboard</title>
<style>
:root{--bg:#f7f7f5;--card:#fff;--fg:#1d1d1b;--dim:#6b6b66;--line:#e3e3df;--agents:#2f6fde;--gates:#8a5cf6;--waiting:#e8590c;--lead:#12a594;--idle:#d6d6d0;--opus:#7c3aed;--sonnet:#2f6fde;--haiku:#12a594;--fable:#d97706;--other:#9a9a94;--first:#2f6fde;--rework:#e03131;--role:#2f6fde;--tickets:#2f6fde;--stories:#12a594;--heat:224,49,49;--s-plan:#7c3aed;--s-build:#2f6fde;--s-review:#d97706;--s-qa:#12a594;--s-lead:#e8590c;--k-input:#2f6fde;--k-cw5:#d97706;--k-cw1:#e8590c;--k-cr:#9a9a94;--k-output:#7c3aed;--w-reply:#e8590c;--w-question:#f59f00;--w-approval:#c92a2a;--w-permission:#e64980;--shot:#0b7285;--i-open:#2f6fde;--i-progress:#d97706;--i-testing:#8a5cf6;--i-closed:#12a594}
@media (prefers-color-scheme: dark){:root{--bg:#141413;--card:#1e1e1c;--fg:#ececea;--dim:#9a9a94;--line:#33332f;--idle:#45453f;--shot:#3bc9db}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 48px}h1{font-size:22px;margin:0 0 2px}.sub{color:var(--dim);margin:0}
.top{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:10px 16px;margin:0 0 18px}.top>div{flex:1 1 320px;min-width:0}.repos{display:flex;flex-wrap:wrap;gap:6px;max-width:100%}.repos a{display:inline-flex;align-items:baseline;gap:6px;max-width:100%;border:1px solid var(--line);border-radius:999px;background:var(--card);color:var(--fg);padding:4px 11px;font-size:12px;text-decoration:none}.repos a:hover{border-color:var(--agents)}.repos a:focus-visible{outline:2px solid var(--agents);outline-offset:2px}.repos span{color:var(--dim);white-space:nowrap}.repos b{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.repos i{font-style:normal;color:var(--agents)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:18px}.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px}.kpi b{display:block;font-size:20px}.kpi span{color:var(--dim);font-size:12px}.kpi small{display:block;color:var(--dim);font-size:11px;margin-top:2px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:16px}h2{font-size:16px;margin:0}.num{display:inline-block;width:22px;height:22px;border-radius:11px;background:var(--fg);color:var(--card);text-align:center;font-size:12px;line-height:22px;margin-right:8px}
.q{color:var(--dim);margin:4px 0 10px}h3{font-size:13px;margin:14px 0 4px}.list{margin:0;padding-left:20px}.dim{color:var(--dim)}.empty{color:var(--dim);font-style:italic}.fc{margin:6px 0 10px}.hint{color:var(--waiting);font-size:12px;margin:0 0 6px}
.chart{width:100%;height:auto;display:block}.chart text{fill:var(--fg);font-size:11px}.chart .axis{fill:var(--dim);font-size:10px}.chart .note{fill:var(--dim)}.chart .grid{stroke:var(--line)}
.c-agents{fill:var(--agents)}.c-gates{fill:var(--gates)}.c-waiting{fill:var(--waiting)}.c-lead{fill:var(--lead)}.c-idle{fill:var(--idle)}.m-opus{fill:var(--opus)}.m-sonnet{fill:var(--sonnet)}.m-haiku{fill:var(--haiku)}.m-fable{fill:var(--fable)}.m-other{fill:var(--other)}.s-plan{fill:var(--s-plan)}.s-build{fill:var(--s-build)}.s-review{fill:var(--s-review)}.s-qa{fill:var(--s-qa)}.s-lead{fill:var(--s-lead)}.s-other{fill:var(--other)}.k-input{fill:var(--k-input)}.k-cw5{fill:var(--k-cw5)}.k-cw1{fill:var(--k-cw1)}.k-cr{fill:var(--k-cr)}.k-output{fill:var(--k-output)}.w-reply{fill:var(--w-reply)}.w-question{fill:var(--w-question)}.w-approval{fill:var(--w-approval)}.w-permission{fill:var(--w-permission)}.lane{fill:var(--line);opacity:.5}.mark{fill:var(--fg)}.shot-mk rect{fill:var(--shot)}.shot-mk .lens{fill:var(--card)}.shot-mk:hover rect{fill:var(--fg)}.c-first{fill:var(--first)}.c-rework{fill:var(--rework)}.c-role{fill:var(--role)}.i-open{fill:var(--i-open)}.i-progress{fill:var(--i-progress)}.i-testing{fill:var(--i-testing)}.i-closed{fill:var(--i-closed)}.band{stroke:var(--card);stroke-width:1.5}.hit{fill:var(--fg);opacity:0}.hit:hover{opacity:.07}
.g-ticket{fill:var(--line);stroke:var(--dim);stroke-width:.5}.g-open{fill:none;stroke:var(--waiting);stroke-dasharray:3 2}.g-agent{fill:var(--agents)}
.line{fill:none;stroke-width:2.5}.total{stroke-dasharray:5 4;stroke-width:1}.forecast{stroke-dasharray:2 3;stroke-width:2}.l-tickets{stroke:var(--tickets)}.l-stories{stroke:var(--stories)}.l-tickets-text{fill:var(--tickets)!important}.l-stories-text{fill:var(--stories)!important}.f-band{fill:var(--tickets);opacity:.08}.now{stroke:var(--dim);stroke-dasharray:2 2}
.legend{display:flex;flex-wrap:wrap;gap:14px;margin:6px 0 2px;color:var(--dim);font-size:12px}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}.legend .c-agents{background:var(--agents)}.legend .c-gates{background:var(--gates)}.legend .c-waiting{background:var(--waiting)}.legend .c-lead{background:var(--lead)}.legend .c-idle{background:var(--idle)}.legend .m-opus{background:var(--opus)}.legend .m-sonnet{background:var(--sonnet)}.legend .m-haiku{background:var(--haiku)}.legend .m-fable{background:var(--fable)}.legend .m-other{background:var(--other)}.legend .s-plan{background:var(--s-plan)}.legend .s-build{background:var(--s-build)}.legend .s-review{background:var(--s-review)}.legend .s-qa{background:var(--s-qa)}.legend .s-lead{background:var(--s-lead)}.legend .s-other{background:var(--other)}.legend .k-input{background:var(--k-input)}.legend .k-cw5{background:var(--k-cw5)}.legend .k-cw1{background:var(--k-cw1)}.legend .k-cr{background:var(--k-cr)}.legend .k-output{background:var(--k-output)}.legend .w-reply{background:var(--w-reply)}.legend .w-question{background:var(--w-question)}.legend .w-approval{background:var(--w-approval)}.legend .w-permission{background:var(--w-permission)}.legend .mk{width:0;height:0;border-radius:0;border-left:5px solid transparent;border-right:5px solid transparent;border-top:8px solid var(--fg)}.legend .shk{background:var(--shot);height:8px}.legend .i-open{background:var(--i-open)}.legend .i-progress{background:var(--i-progress)}.legend .i-testing{background:var(--i-testing)}.legend .i-closed{background:var(--i-closed)}.legend .c-first{background:var(--first)}.legend .c-rework{background:var(--rework)}
.scroll{overflow-x:auto;scrollbar-color:var(--line) transparent}table{border-collapse:collapse;font-size:12px;width:100%}th,td{padding:5px 7px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}thead th{color:var(--dim);font-weight:600}
.heat td{text-align:center;background:rgba(var(--heat),var(--a));min-width:44px}.heat td.none{background:none}.heat td.total{background:none;font-weight:600}.tickets th{cursor:pointer}.tickets td a{color:var(--agents);font-weight:600}.tickets td.title{max-width:340px;overflow:hidden;text-overflow:ellipsis}.exp{appearance:none;border:1px solid var(--line);border-radius:4px;background:var(--card);color:var(--agents);cursor:pointer;font-family:inherit;font-weight:600;font-size:13px;line-height:1;padding:2px 5px;margin-right:6px}.exp:hover{border-color:var(--agents)}.exp[aria-expanded=true]{color:var(--fg)}.exp:focus-visible{outline:2px solid var(--agents);border-radius:3px}.t-agents>td{background:var(--bg);padding:6px 10px 10px 28px}.agents{width:auto;font-size:12px}.agents th{cursor:default}.agents td,.agents th{white-space:nowrap;padding:3px 10px 3px 0;border-bottom:1px solid var(--line)}.agents td:nth-child(2){white-space:normal;min-width:220px}.agents .n{text-align:right}.agents td:nth-child(4){white-space:normal;max-width:300px}table.wrap td{white-space:normal;vertical-align:top}table.wrap td.n{text-align:right;white-space:nowrap}table.wrap td.nw{white-space:nowrap}.tickets th:hover{color:var(--fg)}
.stepper{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 12px 12px;margin-bottom:16px;overflow:hidden}.stp{display:flex;list-style:none;margin:0;padding:0}.stp li{flex:1 1 0;min-width:0;position:relative;display:flex;flex-direction:column;align-items:center;text-align:center;font-size:11px;color:var(--dim)}.stp li+li::before{content:"";position:absolute;top:11px;left:-50%;width:100%;height:2px;background:var(--line)}.stp li.st-done::before,.stp li.st-now::before,.stp li.st-wait::before{background:var(--i-closed)}.stp i,.ss i{position:relative;display:inline-flex;align-items:center;justify-content:center;border-radius:50%;border:2px solid var(--line);background:var(--card);color:var(--dim);font-style:normal;font-weight:700}.stp i{width:24px;height:24px;font-size:11px;z-index:1}.stp span{margin-top:4px;max-width:100%;padding:0 2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.st-done>i{background:var(--i-closed);border-color:var(--i-closed);color:#fff}.st-now>i{border-color:var(--agents);color:var(--agents)}.st-wait>i{background:var(--waiting);border-color:var(--waiting);color:#fff}.st-skip>i{border-style:dashed}.stp .st-now span,.stp .st-wait span{color:var(--fg);font-weight:600}
.ss-box{border-top:1px solid var(--line);margin-top:12px;padding-top:10px}.ss-h{margin:0 0 8px}.ss{display:flex;flex-wrap:wrap;align-items:center;gap:6px;list-style:none;margin:0;padding:0;font-size:12px}.ss li{display:inline-flex;align-items:center;gap:5px;color:var(--dim)}.ss li+li::before{content:"";width:16px;height:2px;background:var(--line)}.ss i{width:16px;height:16px;font-size:9px}.ss .st-now,.ss .st-wait{color:var(--fg);font-weight:600}.ss .st-wait{color:var(--waiting)}.ss .st-done{color:var(--fg)}.ss-row{display:flex;flex-wrap:wrap;align-items:center;gap:4px 14px;margin:0 0 6px}.ss-t{width:260px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:600}.st-why{margin:10px 0 0;color:var(--waiting);font-size:12px}
@media (max-width:720px){.stp li:not([aria-current]) span{display:none}.stp li[aria-current] span{overflow:visible;max-width:none}}
.stp li[aria-current]>i::after{content:"";position:absolute;inset:-2px;border-radius:50%;border:2px solid;border-color:inherit;pointer-events:none;animation:st-pulse 1.8s ease-out infinite}.stp li.st-now[aria-current]::before{background:linear-gradient(90deg,var(--i-closed),var(--agents))}.stp li.st-wait[aria-current]::before{background:linear-gradient(90deg,var(--i-closed),var(--waiting))}
@keyframes st-pulse{0%{transform:scale(1);opacity:.7}100%{transform:scale(1.8);opacity:0}}
@media (prefers-reduced-motion:reduce){.stp li[aria-current]>i::after{animation:none;display:none}}
.tabs{position:sticky;top:0;z-index:2;display:flex;gap:2px;overflow-x:auto;background:var(--bg);border-bottom:1px solid var(--line);margin:0 0 16px;padding-top:6px}.tabs button{appearance:none;border:0;border-bottom:2px solid transparent;background:none;color:var(--dim);font:inherit;font-weight:600;padding:8px 14px;cursor:pointer;white-space:nowrap}.tabs button:hover{color:var(--fg)}.tabs button[aria-selected=true]{color:var(--fg);border-bottom-color:var(--fg)}.tabs button:focus-visible{outline:2px solid var(--agents);outline-offset:-2px;border-radius:4px}
.tabs .count{color:var(--dim);font-weight:400;margin-left:5px}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px;margin-bottom:6px}.shot{margin:0;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--bg);scroll-margin-top:56px}.shot img{display:block;width:100%;height:auto;border-bottom:1px solid var(--line)}.shot figcaption{padding:6px 9px;font-size:12px}.shot .smaller{display:none;color:var(--dim)}.shot:target{grid-column:1/-1;outline:2px solid var(--shot)}.shot:target .smaller{display:inline}
@media print{.tabs{display:none}.panel[hidden]{display:block}.shot .smaller{display:none}}
footer{color:var(--dim);font-size:12px}footer p{margin:4px 0}
.steps{padding-left:20px;margin:6px 0 4px}.steps li{margin:0 0 12px}.cmd{display:flex;gap:8px;align-items:center;margin:6px 0 4px;max-width:100%}.cmd code{flex:1;min-width:0;overflow-x:auto;white-space:nowrap;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:7px 9px;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}.copy{appearance:none;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:6px;padding:6px 12px;font:inherit;font-size:12px;cursor:pointer}.copy:hover{border-color:var(--dim)}.copy:focus-visible{outline:2px solid var(--agents);outline-offset:1px}
.toc{display:flex;flex-wrap:wrap;gap:6px 14px;margin:0 0 12px;font-size:13px}.toc a,.arch a{color:var(--agents)}
.doc{border-top:1px solid var(--line);padding:10px 0;scroll-margin-top:56px}.doc>summary{cursor:pointer;display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px;list-style-position:outside}.doc>summary .t{font-weight:600;font-size:15px}.doc .doc .t{font-size:14px}.src{color:var(--dim);font-size:12px}.doc .body{padding:6px 0 4px 2px}.note{color:var(--waiting)}
.dl{display:inline-block;border:1px solid var(--line);border-radius:6px;padding:2px 9px;font-size:12px;font-weight:600;text-decoration:none;color:var(--fg)!important;background:var(--card)}.dl:hover{border-color:var(--dim)}h4 .dl{margin-left:8px;vertical-align:1px}
.md{max-width:920px}.md h3{font-size:15px;margin:16px 0 6px}.md h4,.arch h4{font-size:14px;margin:14px 0 6px}.md h5,.md h6{font-size:13px;margin:12px 0 4px}.md p,.md li{line-height:1.55}.md table{margin:6px 0 10px}.md td,.md th{white-space:normal;vertical-align:top}.md code,.arch td code{background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:0 4px;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}.md pre.src{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px 10px;overflow-x:auto}.md pre.src code{border:0;padding:0;background:none}.md blockquote{border-left:3px solid var(--line);margin:8px 0;padding:2px 12px;color:var(--dim)}.md hr{border:0;border-top:1px solid var(--line)}
.diagram{margin:8px 0 14px}.diagram{background:#fff;border:1px solid var(--line);border-radius:8px;padding:8px;overflow-x:auto}.diagram svg{display:block;margin:0 auto;height:auto}h4.part{margin-top:18px}
.comp .node rect{fill:var(--card);stroke:var(--dim);stroke-width:1.2}.comp .node.outside rect{stroke-dasharray:4 3}.comp .edge{fill:none;stroke:var(--dim);stroke-width:1.5}.comp .arrowhead{fill:var(--dim)}
.verb{display:inline-block;min-width:52px;text-align:center;border-radius:4px;padding:1px 6px;font:600 11px ui-monospace,Menlo,monospace;color:#fff;background:var(--dim)}.v-get{background:var(--i-open)}.v-post{background:var(--i-closed)}.v-put,.v-patch{background:var(--i-progress)}.v-delete{background:var(--rework)}
.status{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--line);border-radius:999px;padding:4px 12px;margin:0 0 10px;font-weight:600}.status i{width:9px;height:9px;border-radius:50%;background:var(--idle)}.status.up i{background:var(--i-closed)}.status.down i{background:var(--dim)}
</style></head><body><main>
<header class="top"><div><h1>${esc(project)}</h1><p class="sub">${m.since > 0 ? `Last ${Math.round((m.now - m.since) / (24 * H))} days` : 'Whole project'} · built ${esc(when(m.now))} · ${m.table.length} tickets${kitText(m.kit) ? ` · ${esc(kitText(m.kit))}` : ''}${m.watch ? ` · <span id="watch">watching: a new page every ${m.watch.every} min, and this one reloads itself</span>` : ''}</p></div>${repoNav(m.repoLinks)}</header>
<div class="kpis">${kpis.map(([k, v, more]) => `<div class="kpi"${more ? ` title="${esc(SPLIT_HINT)}"` : ''}><span>${esc(k)}</span><b>${esc(v)}</b>${more ? `<small>${esc(more)}</small>` : ''}</div>`).join('')}</div>
${renderSteps(m.steps)}
<nav class="tabs" role="tablist" aria-label="Dashboard sections">${TABS.map(([id, l], i) => `<button type="button" role="tab" id="tab-btn-${id}" aria-controls="tab-${id}" aria-selected="${i === 0}" data-tab="${id}">${esc(l)}${id === 'screens' && m.shots.length ? `<span class="count">${m.shots.length}</span>` : ''}</button>`).join('')}</nav>
${panel('overview', `${card(1, 'The project over time', 'Where did the work wait for you? Each day across, in the hours anything happened: the top lane is the AI at work, the bottom lane each wait for you, by kind. Blank in both is nobody working; a triangle is a merge, a camera a screenshot (click it to see it).', legend([...AI, ...kinds, MARK, ...SHOT]) + cDays + kindsText)}
${card(2, 'Progress and forecast', 'When will the project be done, and what will it cost?', c6a + fcText + c6b)}
${card(3, 'Issues over time', 'Is the board shrinking? Every issue in the tracker by its status, from its creation to now: hover for the counts at any moment.', cIssues)}`)}
${panel('architecture', `<section class="card arch"><h2>Architecture</h2><p class="q">How the app is built and what it must do: the approved documents, the standards every change follows, and the components as designed and as they run. Each document downloads as Markdown.</p>${renderArchitecture(m.architecture)}</section>`)}
${panel('time', `${card(4, 'Where each ticket\'s time goes', 'How much of the delay is people, not AI? Each moment counted once, in the legend\'s order.', legend(TIME) + c1)}
${card(5, 'Waiting for you', 'What the work waited for you on, and the longest waits: the ones to remove first.', legend(kinds) + cKinds + waitList)}`)}
${panel('cost', `${card(6, `${money ? 'Cost' : 'Tokens'} per ticket, by model`, 'Which tickets cost far more than others of their size, and is the model mix right?', costNote + legend(MODELS.filter((k) => withTokens.some((t) => byFamily(t.lines, m.prices, money)[k.key]))) + c2)}
${card(7, `${money ? 'Cost' : 'Tokens'} per ticket, by stage`, 'Where in a ticket the money goes: planning, building, reviews, QA or the lead.', costNote + legend(STAGE_KEYS.filter((k) => stageRows.some((r) => r.parts[k.key]))) + cStages)}
${card(8, 'Who spends it, on which model', 'Which agent to make cheaper first: largest first, with the running share and the cost of one spawn.', costNote + legend(rolesModels) + cRoles)}
${card(9, 'What the cost is made of', 'Each model by token kind: cache reads are most of the tokens and the cheapest; output and cache writes cost the most per token.', costNote + legend(KINDS) + cComp)}
${card(10, `${money ? 'Spend' : 'Tokens'} per day`, 'How the spend moves from day to day, by model.', costNote + legend(MODELS.filter((k) => days.some((d) => d.tokens[k.key]))) + cDaily)}`)}
${panel('quality', `${card(11, 'Rework', 'What the first blocker costs: everything after the first review round with a blocker.', legend([{ label: 'First pass', cls: 'c-first' }, { label: 'After the first blocker', cls: 'c-rework' }]) + c4)}
${card(12, 'Friction map', 'Where agents hit walls: refusals by rule and failed commands, per role. The colour is the tokens of the replies that made them.', c5)}`)}
${panel('skills', `${card(13, 'Sub-agents and skills, day by day', 'When did sub-agents run, and did they have their playbooks? Each day: the agents started, with a skill (preloaded, or opened itself) or with none.', legend(SKILL_KEYS) + cSkillDays + skillsText)}
${card(14, 'Roles and their skills', 'Which roles work from their skills, and which skip the ones their instructions name.', cSkillRoles)}
${card(15, 'Skills', 'Which skills were used, by whom and on which tickets; and the ones never used.', cSkills)}`)}
${panel('screens', `<section class="card"><h2>Screens</h2><p class="q">What the app looked like, and when: the pictures kept with forge shot, oldest first. Click one to see it larger.</p>${cShots}</section>`)}
${panel('app', `<section class="card"><h2>Run the app</h2><p class="q">See the app as it is now: build and start its containers on this Mac, then open it.</p>${cApp}</section>`)}
${panel('tickets', `<section class="card"><h2>Tickets</h2><p class="q">Every ticket, the ones nobody has picked yet too, with its status on the board${!m.issues ? ' (no tracker: the status comes from the records)' : !m.issues.readAt ? ' (the board has not been read yet: run forge dashboard without --offline; until then the status comes from the records)' : ''}. Click a column to sort, a ticket's number to open its issue, and ▸ to see its agents one by one (the job each was given, its model, its skills, tokens and time; the lead's own turns last). The same rows are in dashboard.csv next to this page.</p>${table}</section>`)}
<footer>${notes.map((x) => `<p>${esc(x)}</p>`).join('')}</footer>
</main>
<script>
(function () {
  // Tabs: the one in the address (#cost) or the first; arrow keys move between them. Without script every
  // panel shows.
  var tabs = Array.prototype.slice.call(document.querySelectorAll('[role=tab]'));
  function show(id, keep) {
    if (!tabs.some(function (t) { return t.dataset.tab === id; })) id = tabs[0].dataset.tab;
    tabs.forEach(function (t) {
      var on = t.dataset.tab === id;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
      document.getElementById('tab-' + t.dataset.tab).hidden = !on;
    });
    if (keep) try { history.replaceState(null, '', '#' + id); } catch (e) { /* a page opened from a file may refuse */ }
    tighten();
  }
  // Mermaid draws a C4 diagram with wide empty margins: once one shows, its view is cut to what it draws.
  function tighten() {
    document.querySelectorAll('.diagram svg:not([data-tight])').forEach(function (s) {
      try {
        var b = s.getBBox();
        if (!b.width || !b.height) return;
        s.setAttribute('viewBox', (b.x - 10) + ' ' + (b.y - 10) + ' ' + (b.width + 20) + ' ' + (b.height + 20));
        s.style.maxWidth = Math.round(b.width + 20) + 'px';
        s.setAttribute('data-tight', '1');
      } catch (e) { /* not drawn yet */ }
    });
  }
  document.querySelectorAll('details').forEach(function (d) { d.addEventListener('toggle', tighten); });
  tabs.forEach(function (t, i) {
    t.addEventListener('click', function () { show(t.dataset.tab, true); });
    t.addEventListener('keydown', function (e) {
      var d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      var next = tabs[(i + d + tabs.length) % tabs.length];
      next.focus();
      show(next.dataset.tab, true);
    });
  });
  // A link to something inside a tab (#shot-3, from a camera on chart 1) opens that tab and scrolls to it.
  function go() {
    var h = decodeURIComponent(location.hash.slice(1)), el = h ? document.getElementById(h) : null, p = el && el.closest('[role=tabpanel]');
    // A link to a closed section (#arch-api) opens it, and every section around it.
    for (var d = el; d; d = d.parentElement) if (d.tagName === 'DETAILS') d.open = true;
    show(p ? p.id.slice(4) : h, false);
    if (p) el.scrollIntoView({ block: 'start' });
  }
  window.addEventListener('hashchange', go);
  go();
})();
// Run the app: copy a command; ask the app's address whether it answers (an opaque reply is enough).
document.querySelectorAll('.copy').forEach(function (b) {
  b.addEventListener('click', function () {
    var text = b.dataset.copy, done = function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy'; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
    function fallback() { var t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); done(); } catch (e) { /* select it by hand */ } t.remove(); }
  });
});
document.querySelectorAll('[data-probe]').forEach(function (el) {
  var url = el.dataset.probe, label = el.querySelector('span');
  function probe() {
    var c = window.AbortController ? new AbortController() : null, t = setTimeout(function () { if (c) c.abort(); }, 2000);
    fetch(url, { mode: 'no-cors', cache: 'no-store', signal: c ? c.signal : undefined }).then(function () {
      el.className = 'status up'; label.textContent = 'Running: ' + url;
    }, function () {
      el.className = 'status down'; label.textContent = 'Not running (checked ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + ')';
    }).then(function () { clearTimeout(t); });
  }
  probe();
  setInterval(probe, 5000);
});
document.querySelectorAll('.tickets .exp').forEach(function (b) {
  b.addEventListener('click', function () {
    var open = b.getAttribute('aria-expanded') !== 'true', row = b.closest('tr').nextElementSibling;
    b.setAttribute('aria-expanded', open ? 'true' : 'false');
    b.textContent = open ? '▾' : '▸';
    if (row && row.classList.contains('t-agents')) row.hidden = !open;
  });
});
var repoFilter = document.getElementById('repo-filter');
if (repoFilter) repoFilter.addEventListener('change', function () {
  document.querySelectorAll('.tickets tr.t-row').forEach(function (r) {
    var hide = repoFilter.value !== '' && r.dataset.repo !== repoFilter.value, d = r.nextElementSibling, b = r.querySelector('.exp');
    r.hidden = hide;
    if (d && d.classList.contains('t-agents')) d.hidden = hide || !b || b.getAttribute('aria-expanded') !== 'true';
  });
});
document.querySelectorAll('.tickets > thead th').forEach(function (th) {
  th.addEventListener('click', function () {
    var i = Number(th.dataset.i), body = th.closest('table').tBodies[0], up = th.dataset.up !== '1';
    th.dataset.up = up ? '1' : '0';
    // Each ticket's row moves with its agents' row under it.
    var rows = Array.from(body.querySelectorAll(':scope > tr.t-row')).map(function (r) { var d = r.nextElementSibling; return { r: r, d: d && d.classList.contains('t-agents') ? d : null }; });
    rows.sort(function (a, b) {
      var x = a.r.cells[i].dataset.v, y = b.r.cells[i].dataset.v, nx = parseFloat(x), ny = parseFloat(y);
      var r = !isNaN(nx) && !isNaN(ny) ? nx - ny : x.localeCompare(y);
      return up ? r : -r;
    });
    rows.forEach(function (p) { body.appendChild(p.r); if (p.d) body.appendChild(p.d); });
  });
});
</script>${m.watch ? watchScript(m) : ''}</body></html>`;
}

// The stamp forge dashboard --watch writes next to the page after each build: the build's time. The page loads it
// every 10 seconds (a script tag, which a page opened from a file may load from its own folder) and reloads itself
// for a newer one, keeping its tab (the address), its open sections and where it was scrolled to. Once per stamp:
// an older copy of the page never reloads in a loop. When the watch stops, the stamp goes and the page says so.
export const stampFile = (out) => `${out.replace(/\.html?$/i, '')}.stamp.js`;
export const stampText = (now) => `window.forgeStamp && window.forgeStamp(${JSON.stringify(new Date(now).toISOString())});\n`;
function watchScript(m) {
  const w = { stamp: new Date(m.now).toISOString(), file: path.basename(stampFile(m.watch.out || 'dashboard.html')) };
  return `<script>
(function () {
  var W = ${JSON.stringify(w)}, KEY = 'forge-dashboard-' + location.pathname;
  try {
    var kept = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    if (kept && kept.stamp === W.stamp) {
      kept.open.forEach(function (id) { var d = document.getElementById(id); if (d) d.open = true; });
      window.scrollTo(0, kept.y);
    }
  } catch (e) { /* no storage: start at the top */ }
  window.forgeStamp = function (s) {
    if (!(s > W.stamp)) return;
    try {
      var kept = JSON.parse(sessionStorage.getItem(KEY) || 'null');
      if (kept && kept.stamp === s) return;
      sessionStorage.setItem(KEY, JSON.stringify({ stamp: s, y: window.scrollY, open: Array.prototype.map.call(document.querySelectorAll('details[open][id]'), function (d) { return d.id; }) }));
    } catch (e) { /* reload anyway */ }
    location.reload();
  };
  var note = document.getElementById('watch');
  var timer = setInterval(function () {
    var s = document.createElement('script');
    s.src = W.file + '?' + Date.now();
    s.onload = function () { s.remove(); };
    s.onerror = function () { s.remove(); clearInterval(timer); if (note) note.textContent = 'no longer watched: forge dashboard --watch starts it again'; };
    document.head.appendChild(s);
  }, 10000);
})();
</script>`;
}

export function writeDashboard(m, { project, out }) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (m.watch) m.watch.out = out;
  fs.writeFileSync(out, renderPage(m, { project }));
  const csvFile = out.replace(/\.html?$/i, '') + '.csv';
  fs.writeFileSync(csvFile, `${csv(m)}\n`);
  // The stamp after the page: a page that sees it can reload into this build.
  if (m.watch) fs.writeFileSync(stampFile(out), stampText(m.now));
  return { html: out, csv: csvFile, stamp: m.watch ? stampFile(out) : null };
}
