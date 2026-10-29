// forge dashboard and forge timeline import (decision 98), on a small project shaped like clinic-booking:
// a bootstrap catalogue, plans, metrics.md, review rounds in the team repo's history, merges on dev.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sh } from '../policy/helpers.mjs';
import { readStories, readCatalogue, readPlans, readMetrics, reviewRounds, readMerges, readGatesFailed, hours } from '../../core/cli/dashboard/data.mjs';
import { union, subtract, length, timeSplit, rework, friction, roles, progress, projectTimeline, SILENT_MS, stageOf, composition, daily, groupBy, replies } from '../../core/cli/dashboard/measures.mjs';
import { stackedBars, columns, dayStrips, step } from '../../core/cli/dashboard/svg.mjs';
import { day, weekday, hour, clock, when } from '../../core/cli/dashboard/format.mjs';
import { kitText, totals, splitText } from '../../core/cli/dashboard/page.mjs';
import { importHistory, refusalRule } from '../../core/cli/timeline-import.mjs';
import { record } from '../../core/cli/shot.mjs';

const FORGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../core/cli/forge.mjs');
const T0 = Date.parse('2026-10-09T08:00:00Z');
const at = (min) => new Date(T0 + min * 60000).toISOString();
const M = 60000;

const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const commit = (dir, msg, date) => spawnSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-qam', msg, '--allow-empty'], { cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });

// A team repo with the project's folder, and a client checkout linked to it with two tickets merged into dev.
function world() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-dash-')));
  const team = path.join(base, 'team');
  const folder = path.join(team, 'acme');
  fs.mkdirSync(folder, { recursive: true });
  sh(team, 'git', 'init', '-q', '-b', 'main');
  write(path.join(folder, 'project.json'), JSON.stringify({ project: { name: 'acme' }, policy: { gates: { full: 'true' } } }));
  write(path.join(folder, 'bootstrap/user-stories.md'), '# User stories\n## Epics\n## E1 Foundations\n### E1-S1 Data model\n### E1-S2 Slot grid\n## E2 Booking\n### E2-S1 Doctors\n');
  write(path.join(folder, 'bootstrap/tickets.md'), '# Tickets\n### T-01 Data model\n- **Story:** E1-S1; D-002.\n- **Areas:** db\n### T-02 Slots API\n- **Story:** E1-S2, E2-S1\n- **Areas:** api\n- **Estimate:** 5-9 h. Risk: the grid.\n### T-03 Book page\n- **Story:** E2-S1\n- **Areas:** ui\n');
  write(path.join(folder, 'bootstrap/tickets-created.md'), '| Item | Title | Issue | Epic | Areas |\n|---|---|---|---|---|\n| E1 | [Epic] E1 | #1 |  |  |\n| T-01 | T-01 Data model | #10 | E1 | db |\n| T-02 | T-02 Slots API | #11 | E1 | api |\n| T-03 | T-03 Book page | #12 | E2 | ui |\n');
  write(path.join(folder, 'plans/10-data-model.md'), '# Data model (#10)\nAreas: db\nBranch: `feat/10-data-model`\nGates: security (personal data (D-1))\nSources: ticket #10; story E1-S1 (lines 1-9).\n## Estimate\n| Item | Low (h) | High (h) | Main risk |\n|---|---|---|---|\n| **Total** | 2 | 4 | |\n');
  write(path.join(folder, 'plans/11-slots.md'), '# Slots API (#11)\nAreas: api\nBranch: `feat/11-slots`\nGates: none\nSources: ticket #11; stories E1-S2, E2-S1.\n');
  write(path.join(folder, 'plans/12-book.md'), '# Book page (#12)\nAreas: ui\n## Estimate\n| Item | Low | High |\n|---|---|---|\n| **Total** | **0.75 h** | **1.5 h** |\n');
  write(path.join(folder, 'metrics.md'), '| Ticket | Estimate | Actual | Bugs after release | Rework | AI cost |\n|---|---|---|---|---|---|\n| #10 | 2-4 h | 1.5 h | 0 | 1 | |\n| #11 | | | | | |\n| #12 book-page | 0.75-1.5 h | | | | |\n');
  sh(team, 'git', 'add', '.');
  commit(team, 'plans', at(0));
  write(path.join(folder, 'reviews/10/code.md'), 'Verdict: APPROVE\nCommit: aaaaaaa\n');
  write(path.join(folder, 'reviews/10/security.md'), '**Verdict:** REQUEST CHANGES\nCommit: aaaaaaa\n');
  sh(team, 'git', 'add', '.');
  commit(team, 'round 1', at(20));
  write(path.join(folder, 'reviews/10/security-r2.md'), 'Verdict: PASS\nCommit: bbbbbbb\n');
  sh(team, 'git', 'add', '.');
  commit(team, 'round 2', at(40));

  const client = path.join(base, 'client');
  const remote = path.join(base, 'client.git');
  sh(base, 'git', 'init', '-q', '--bare', remote);
  fs.mkdirSync(client);
  sh(client, 'git', 'init', '-q', '-b', 'main');
  write(path.join(client, 'a.txt'), 'a\n');
  sh(client, 'git', 'add', '.');
  commit(client, 'init', at(0));
  sh(client, 'git', 'checkout', '-q', '-b', 'dev');
  for (const [b, min] of [['feat/10-data-model', 50], ['feat/11-slots', 130]]) {
    sh(client, 'git', 'checkout', '-q', '-b', b, 'dev');
    write(path.join(client, `${b.replace('/', '-')}.txt`), 'x\n');
    sh(client, 'git', 'add', '.');
    commit(client, `feat: ${b}`, at(min - 5));
    sh(client, 'git', 'checkout', '-q', 'dev');
    spawnSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', 'merge', '--no-ff', '-q', '-m', `Merge branch '${b}' into 'dev'`, b], { cwd: client, env: { ...process.env, GIT_AUTHOR_DATE: at(min), GIT_COMMITTER_DATE: at(min) } });
  }
  sh(client, 'git', 'remote', 'add', 'origin', remote);
  sh(client, 'git', 'push', '-q', 'origin', 'main', 'dev');
  sh(client, 'git', 'fetch', '-q', 'origin');
  fs.mkdirSync(path.join(client, '.forge'));
  fs.symlinkSync(folder, path.join(client, '.forge/project'));
  fs.appendFileSync(path.join(client, '.git/info/exclude'), '.forge/\n');
  return { base, team, folder, client, state: path.join(client, '.forge/state') };
}

const tokens = (reply, model, n, extra = {}) => ({ model, reply, input: n, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 9 * n, output: 0, tokens: 10 * n, ...extra });
// #10: planner, an engineer, the lead waiting 10 minutes for you, a blocker round at 20m, a fix lane, merge at 50m.
const LINES = [
  { at: at(0), event: 'prompt', who: 'human' },
  { at: at(1), event: 'tool.start', who: 'lead', tool: 'Agent', id: 's1', what: 'backend-engineer: #10 lane', ticket: '#10', ...tokens('r1', 'claude-opus-5-5', 1000) },
  { at: at(1), event: 'tool.done', who: 'lead', tool: 'Agent', id: 's1', ms: 100, spawned: 'a1', ticket: '#10' },
  { at: at(2), event: 'agent.start', who: 'backend-engineer', agent: 'a1' },
  { at: at(5), event: 'tool.refused', who: 'backend-engineer', agent: 'a1', tool: 'Bash', rule: 'output:heavy', why: '[output:heavy] Heavy command without output control. Redirect.', ...tokens('r2', 'claude-sonnet-5-5', 300) },
  { at: at(8), event: 'tool.fail', who: 'backend-engineer', agent: 'a1', tool: 'Bash', what: 'npm test -- x', ms: 1000, why: 'Exit code 1' },
  { at: at(10), event: 'agent.stop', who: 'backend-engineer', agent: 'a1', ...tokens('r3', 'claude-sonnet-5-5', 200) },
  { at: at(12), event: 'gates.pass', who: 'kit', ticket: '#10', ms: 2 * M },
  { at: at(13), event: 'turn.end', who: 'lead', ticket: '#10', ...tokens('r4', 'claude-opus-5-5', 500) },
  { at: at(23), event: 'prompt', who: 'human' },
  { at: at(25), event: 'tool.start', who: 'lead', tool: 'Agent', id: 's2', what: 'backend-engineer: #10 fix', ticket: '#10', ...tokens('r5', 'claude-opus-5-5', 800) },
  { at: at(25), event: 'tool.done', who: 'lead', tool: 'Agent', id: 's2', ms: 100, spawned: 'a2', ticket: '#10' },
  { at: at(26), event: 'agent.start', who: 'backend-engineer', agent: 'a2' },
  { at: at(30), event: 'agent.stop', who: 'backend-engineer', agent: 'a2', ...tokens('r6', 'claude-sonnet-5-5', 400) },
  { at: at(31), event: 'turn.end', who: 'lead', ticket: '#10' },
  { at: at(49), event: 'prompt', who: 'human' },
  { at: at(50), event: 'tool.start', who: 'lead', tool: 'Bash', id: 'm1', what: 'forge merge 10', ticket: '#10' },
  { at: at(90), event: 'tool.start', who: 'lead', tool: 'Bash', id: 'b1', what: 'git status', ticket: '#11' },
  { at: at(91), event: 'agent.start', who: 'project-manager', agent: 'pm', what: 'PM digest after #11' },
  { at: at(92), event: 'agent.stop', who: 'project-manager', agent: 'pm', ticket: '#11', ...tokens('r7', 'claude-haiku-5-5', 50) },
  { at: at(129), event: 'tool.start', who: 'lead', tool: 'Bash', id: 'b2', what: 'forge merge 11', ticket: '#11' },
];

test('the project\'s records: stories, the bootstrap catalogue, plans, metrics, review rounds and merges', () => {
  const w = world();
  const { epics, stories } = readStories(w.folder);
  assert.deepEqual([epics.map((e) => e.id), stories.map((s) => s.id)], [['E1', 'E2'], ['E1-S1', 'E1-S2', 'E2-S1']]);
  const cat = readCatalogue(w.folder);
  assert.equal(cat.planned, 3);
  assert.deepEqual(cat.tickets.map((t) => [t.num, t.t, t.epic, t.stories.join(','), t.areas.join(','), t.estimate]), [[10, 'T-01', 'E1', 'E1-S1', 'db', null], [11, 'T-02', 'E1', 'E1-S2,E2-S1', 'api', { low: 5, high: 9 }], [12, 'T-03', 'E2', 'E2-S1', 'ui', null]]);
  const plans = readPlans(w.folder);
  assert.deepEqual([plans.get(10).estimate, plans.get(10).gates, plans.get(10).stories, plans.get(11).stories], [{ low: 2, high: 4 }, 'security', ['E1-S1'], ['E1-S2', 'E2-S1']]);
  assert.deepEqual(readMetrics(w.folder).get(10), { estimate: { low: 2, high: 4 }, actual: 1.5, bugs: '0', rework: '1' });
  assert.deepEqual([plans.get(12).estimate, readMetrics(w.folder).get(12).estimate], [{ low: 0.75, high: 1.5 }, { low: 0.75, high: 1.5 }], 'units, bold and a slug as the models write them');
  assert.deepEqual([hours('2–4h'), hours('3 h'), hours('')], [{ low: 2, high: 4 }, { low: 3, high: 3 }, null]);
  const rounds = reviewRounds(w.team, 'acme/reviews/10');
  assert.deepEqual(rounds.map((r) => [r.at, r.blocker, r.reports]), [[T0 + 20 * M, true, { code: 'APPROVE', security: 'REQUEST CHANGES' }], [T0 + 40 * M, false, { security: 'PASS' }]]);
  assert.deepEqual([...readMerges(w.client, 'dev')], [[11, T0 + 130 * M], [10, T0 + 50 * M]]);
});

test('intervals: union, subtract, length', () => {
  assert.deepEqual(union([[5, 8], [1, 3], [2, 4]]), [[1, 4], [5, 8]]);
  assert.deepEqual(subtract([[0, 10]], [[2, 3], [5, 12]]), [[0, 2], [3, 5]]);
  assert.equal(length([[0, 10], [5, 15], [20, 21]]), 16);
});

test('chart 3: each moment once, agents before gates before your waits before the lead; silence is nobody', () => {
  const lines = [
    { at: at(0), event: 'prompt', who: 'human' },
    { at: at(1), event: 'agent.start', who: 'backend-engineer', agent: 'a' },
    { at: at(9), event: 'agent.stop', who: 'backend-engineer', agent: 'a' },
    { at: at(10), event: 'gates.pass', who: 'kit', ms: 4 * M },
    { at: at(11), event: 'turn.end', who: 'lead' },
    { at: at(31), event: 'prompt', who: 'human' },
    { at: at(33), event: 'tool.start', who: 'lead', tool: 'Bash' },
    { at: at(33 + SILENT_MS / M + 5), event: 'turn.end', who: 'lead' },
  ];
  const to = T0 + (33 + SILENT_MS / M + 5) * M;
  const s = timeSplit(lines, T0, to, [{ at: T0 + 11 * M, ms: 20 * M }]);
  assert.deepEqual([s.agents, s.gates, s.waiting, s.lead].map((v) => v / M), [8, 1, 20, 4], 'lead: 0-1, 10-11 and 31-33; gates 6-10 minus the agent until 9');
  assert.equal(s.idle / M, SILENT_MS / M + 5, 'the silent stretch inside the lead\'s turn is nobody working');
  assert.equal(s.total, to - T0);
});

test('chart 10: rework starts at the first review round with a blocker', () => {
  const lines = LINES.filter((e) => e.ticket === '#10' || e.agent === 'a1' || e.agent === 'a2' || (!e.agent && !e.ticket && Date.parse(e.at) <= T0 + 50 * M));
  const r = rework({ rounds: [{ at: T0 + 20 * M, blocker: true }, { at: T0 + 40 * M, blocker: false }] }, lines, T0, T0 + 50 * M, ['backend-engineer']);
  assert.deepEqual([r.first.tokens, r.rework.tokens, r.first.ms / M, r.rework.ms / M, r.rounds, r.blockerRounds], [20000, 12000, 20, 30, 2, 1]);
  const noHistory = rework({ rounds: [] }, [...lines, { at: at(11), event: 'agent.stop', who: 'code-reviewer', agent: 'cr' }], T0, T0 + 50 * M, ['backend-engineer']);
  assert.equal(noHistory.split, T0 + 25 * M, 'without history: the first engineer spawned after a reviewer finished');
});

const PRICES = { opus: { input: 10, cacheWrite5m: 12, cacheWrite1h: 20, cacheRead: 1, output: 50 }, sonnet: { input: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2, output: 10 } };

test('the totals split the tokens into re-read, new and output, in tokens and in dollars', () => {
  const at = '2026-10-09T08:00:00.000Z';
  const lines = [
    { at, event: 'reply', reply: 'r1', model: 'claude-opus-5-5', input: 10, cacheWrite5m: 1000, cacheWrite1h: 0, cacheRead: 90000, output: 2000, tokens: 93010 },
    { at, event: 'tool.done', reply: 'r1', model: 'claude-opus-5-5', cacheRead: 90000, tokens: 93010 },
    { at, event: 'reply', reply: 'r2', model: 'claude-opus-5-5', input: 0, cacheWrite5m: 0, cacheWrite1h: 990, cacheRead: 6000, output: 0, tokens: 6990 },
  ];
  const priced = totals({ lines, prices: PRICES, money: true });
  assert.deepEqual(Object.fromEntries(Object.entries(priced.split).map(([k, v]) => [k, v.tokens])), { reread: 96000, fresh: 2000, output: 2000 }, 'each reply once');
  assert.equal(splitText(priced), '96.0k re-read (96%) · 2.0k new · 2.0k output');
  assert.equal(splitText(priced, 'cost', ' + '), '$0.10 re-read (42%) + $0.03 new + $0.10 output', 'the cache reads are most of the tokens, not of the cost');
  const plain = totals({ lines, prices: {}, money: false });
  assert.equal(splitText(plain), '96.0k re-read (96%) · 2.0k new · 2.0k output');
  assert.equal(splitText(plain, 'cost'), '', 'no prices, no dollars');
  assert.equal(splitText(totals({ lines: [], prices: {}, money: false })), '', 'no tokens yet');
});

test('charts 7 and 11: tokens and cost by role and model, largest first; refusals and failures by role', () => {
  const r = roles(LINES);
  assert.deepEqual(r.map((x) => [x.who, x.tokens, x.spawns, x.byModel]), [['lead', 23000, 0, { opus: 23000 }], ['backend-engineer', 9000, 2, { sonnet: 9000 }], ['project-manager', 500, 1, { haiku: 500 }]]);
  assert.equal(r[0].opus, 23000);
  assert.ok(Math.abs(r[1].running - 32000 / 32500) < 1e-9);
  const priced = roles(LINES, { sonnet: PRICES.sonnet });
  assert.deepEqual(priced.map((x) => x.who), ['backend-engineer', 'lead', 'project-manager'], 'with prices: largest cost first');
  assert.ok(Math.abs(priced[0].cost - (900 * 2 + 8100 * 0.2) / 1e6) < 1e-12, 'cost at the family price');
  assert.deepEqual(Object.keys(priced[0].costByModel), ['sonnet']);
  const f = friction(LINES);
  assert.deepEqual(f.rows.map((x) => [x.row, x.total, x.cells['backend-engineer']]), [['output:heavy', 1, { n: 1, tokens: 3000 }], ['Bash npm test', 1, { n: 1, tokens: 0 }]]);
  assert.deepEqual(f.reasons, [['output:heavy: Heavy command without output control.', 1]]);
  assert.equal(refusalRule('PreToolUse:Bash hook error: [output:heavy] x'), 'output:heavy');
  assert.equal(refusalRule('<tool_use_error>This agent is isolated in the worktree /x'), 'claude:worktree');
  assert.equal(refusalRule('Exit code 1'), null);
});

test('charts 6, 8 and 9: cost by stage, by token kind and by day', () => {
  assert.deepEqual(['lead', 'planner', 'backend-engineer', 'qa-engineer', 'code-reviewer', 'spec-checker', 'project-manager'].map(stageOf), ['lead', 'plan', 'build', 'qa', 'review', 'review', 'other']);
  const stages = groupBy(replies(LINES, PRICES), (r) => stageOf(r.who));
  assert.deepEqual(Object.fromEntries(Object.entries(stages).map(([k, v]) => [k, v.tokens])), { lead: 23000, build: 9000, other: 500 });
  const c = composition(LINES, PRICES);
  assert.deepEqual(c.opus.tokens, { input: 2300, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 20700, output: 0 });
  assert.ok(Math.abs(c.opus.cost.cacheRead - 20700 / 1e6) < 1e-12);
  assert.deepEqual([c.opus.priced, c.haiku.priced], [true, false], 'a model without a price stays in tokens');
  const d = daily(LINES, PRICES);
  assert.equal(d.length, 1);
  assert.deepEqual(d[0].tokens, { opus: 23000, sonnet: 9000, haiku: 500 });
  const svg = columns({ cols: [{ label: '09 Oct', parts: { a: 3, b: 1 } }, { label: '10 Oct', parts: { a: 2 } }], keys: [{ key: 'a', label: 'A', cls: 'c-a' }, { key: 'b', label: 'B', cls: 'c-b' }], fmt: (v) => `$${v}` });
  assert.equal((svg.match(/<rect /g) || []).length, 3);
  assert.match(svg, /<title>09 Oct · B: \$1<\/title>/);
});

test('chart 2: done over time against the totals, and a forecast only from three merged tickets', () => {
  const data = { plannedTickets: 4, stories: [{ id: 'S1' }, { id: 'S2' }], catalogue: [1, 2, 3, 4].map((num) => ({ num, areas: ['api'] })) };
  const t = (num, from, merged, cost) => ({ num, areas: ['api'], stories: num <= 2 ? ['S1'] : ['S2'], from, mergedAt: merged, tokens: { total: cost * 1000, cost } });
  const two = progress(data, [t(1, 0, 10 * M, 1), t(2, 10 * M, 30 * M, 2), t(3, 30 * M, null, 0), t(4, null, null, 0)], 60 * M);
  assert.deepEqual([two.ticketsDone, two.storiesDone, two.remaining, two.forecast], [[10 * M, 30 * M], [30 * M], 2, null]);
  const three = progress(data, [t(1, 0, 10 * M, 1), t(2, 10 * M, 30 * M, 2), t(3, 30 * M, 60 * M, 3), t(4, null, null, 0)], 60 * M);
  assert.deepEqual([three.forecast.remaining, three.forecast.mid / M, three.forecast.costMid, three.forecast.doneMid], [1, 20, 2, 80 * M]);
});

test('working time: a laptop asleep mid-agent, an agent working while you are asked, each moment once', () => {
  const lines = [
    { at: at(0), event: 'prompt', who: 'human' },
    { at: at(1), event: 'agent.start', who: 'mobile-engineer', agent: 'm' },
    { at: at(6), event: 'tool.done', who: 'mobile-engineer', agent: 'm', tool: 'Bash', id: 't1', ms: 2 * M },
    { at: at(10), event: 'tool.done', who: 'mobile-engineer', agent: 'm', tool: 'Edit', id: 't2', ms: 0 },
    // The laptop sleeps for four hours: nothing is written until 250.
    { at: at(250), event: 'tool.done', who: 'mobile-engineer', agent: 'm', tool: 'Bash', id: 't3', ms: 0 },
    { at: at(256), event: 'gates.pass', who: 'kit', ms: 4 * M },
    { at: at(258), event: 'agent.stop', who: 'mobile-engineer', agent: 'm' },
    { at: at(259), event: 'turn.end', who: 'lead' },
    // A question to you while a second agent works: its time counts, the lead's does not.
    { at: at(300), event: 'prompt', who: 'human' },
    { at: at(301), event: 'agent.start', who: 'qa-engineer', agent: 'q' },
    { at: at(302), event: 'tool.start', who: 'lead', tool: 'AskUserQuestion', id: 'q1', what: 'Ship it?' },
    { at: at(308), event: 'tool.done', who: 'qa-engineer', agent: 'q', tool: 'Bash', id: 't4', ms: 0 },
    { at: at(312), event: 'tool.done', who: 'lead', tool: 'AskUserQuestion', id: 'q1', ms: 10 * M, what: 'Ship it?' },
    { at: at(314), event: 'agent.stop', who: 'qa-engineer', agent: 'q' },
    { at: at(315), event: 'turn.end', who: 'lead' },
  ];
  const p = projectTimeline(lines);
  // 0-10 (the lead from 0, the agent from 1), 250-259 (the agent and the gate, the lead to 259), 300-315 (the lead
  // until the question at 302, the agent 301-314, the lead again 312-315): 10 + 9 + 15.
  assert.equal(p.working / M, 34, `working ${p.working / M}`);
  assert.equal(p.days.reduce((s, d) => s + d.ai, 0), p.working, 'the same as the top lane of chart 1, added up');
  assert.equal((p.to - p.from) / M, 315);
});

test('chart 1: the project over time, the AI and your waits by kind; the lead does not work while it waits for you', () => {
  const lines = [
    { at: at(0), event: 'prompt', who: 'human' },
    { at: at(1), event: 'agent.start', who: 'backend-engineer', agent: 'a' },
    { at: at(9), event: 'agent.stop', who: 'backend-engineer', agent: 'a' },
    { at: at(10), event: 'gates.pass', who: 'kit', ms: 4 * M },
    { at: at(11), event: 'turn.end', who: 'lead' },
    { at: at(31), event: 'prompt', who: 'human' },
    { at: at(33), event: 'tool.start', who: 'lead', tool: 'Bash', id: 'p1', what: 'git push' },
    { at: at(40), event: 'tool.done', who: 'lead', tool: 'Bash', id: 'p1', ms: 2 * M },
    { at: at(41), event: 'tool.start', who: 'lead', tool: 'AskUserQuestion', id: 'q1', what: 'Which stack?' },
    { at: at(50), event: 'tool.done', who: 'lead', tool: 'AskUserQuestion', id: 'q1', ms: 9 * M, what: 'Which stack?' },
    { at: at(52), event: 'turn.end', who: 'lead' },
    { at: at(80), event: 'agent.notify', who: 'lead' },
    { at: at(82), event: 'turn.end', who: 'lead' },
  ];
  const shots = [{ at: T0 + 45 * M, title: 'S1 the form', href: '#shot-1' }, { at: T0 + 12 * 60 * M, title: 'outside the hours', href: '#shot-2' }];
  const p = projectTimeline(lines, { merges: [{ at: T0 + 70 * M, title: '#10 merged' }, { at: T0 + 3 * 24 * 60 * M, title: 'another day' }], shots });
  assert.equal(p.days.length, 1);
  const d = p.days[0];
  assert.deepEqual([d.from, d.to], [T0, T0 + 82 * M]);
  assert.deepEqual(Object.fromEntries(Object.entries(d.work).map(([k, v]) => [k, length(v) / M])), { agents: 8, gates: 1, lead: 11 }, 'the lead: 0-1, 10-11, 31-33, 38-41, 50-52 and 80-82, not during the prompt or the question');
  assert.deepEqual([d.ai, d.you, d.nobody].map((v) => v / M), [20, 34, 28], 'after the turn at 52 an agent woke the lead at 80: nobody, not you');
  assert.deepEqual(d.waits.map((w) => [w.kind, w.ms / M]), [['reply', 20], ['permission', 5], ['question', 9]]);
  assert.deepEqual(Object.fromEntries(Object.entries(p.byKind).map(([k, v]) => [k, [v.n, v.ms / M]])), { reply: [1, 20], question: [1, 9], approval: [0, 0], permission: [1, 5] });
  assert.equal(p.waiting / M, 34);
  assert.equal(p.working / M, 20, 'working time: the AI lane, without your waits and the nobody-working stretch');
  assert.deepEqual(d.merges.map((m) => m.title), ['#10 merged']);
  assert.deepEqual(d.shots.map((m) => m.title), ['S1 the form'], 'a mark outside the hours drawn would fall off the row');
  assert.equal(p.hi - p.lo, 2 * 60 * M, 'the hours it worked in, at least two');
  assert.equal(projectTimeline([]), null);
});

test('dates and times: the 12-hour clock in this Mac\'s time zone', () => {
  const at = (h, m) => new Date(2026, 9, 9, h, m).getTime();
  assert.deepEqual([clock(at(14, 5)), clock(at(0, 30)), clock(at(12, 0)), clock(at(9, 7))], ['2:05 PM', '12:30 AM', '12:00 PM', '9:07 AM']);
  assert.deepEqual([0, 8, 12, 15, 24].map(hour), ['12 AM', '8 AM', '12 PM', '3 PM', '12 AM']);
  assert.deepEqual([day(at(14, 5)), weekday(at(14, 5)), when(at(23, 41))], ['09 Oct', 'Fri 09 Oct', '09 Oct, 11:41 PM']);
});

test('svg: round axis steps, bars with their numbers in titles', () => {
  assert.deepEqual([step(9), step(130), step(0.7)], [5, 50, 0.2]);
  const svg = stackedBars({ rows: [{ label: '#10 <x>', parts: { a: 2, b: 3 }, right: 'note' }], keys: [{ key: 'a', label: 'A', cls: 'c-a' }, { key: 'b', label: 'B', cls: 'c-b' }], fmt: (v) => `${v} h` });
  assert.match(svg, /<rect class="c-a"[^>]*><title>#10 &lt;x&gt; · A: 2 h<\/title>/);
  assert.match(svg, /<rect class="c-b"/);
  assert.match(svg, />note</);
  const day = Date.parse('2026-10-09T00:00:00');
  const strips = dayStrips({ rows: [{ label: 'Fri 09 Oct', day, from: day + 8 * 3600000, to: day + 10 * 3600000, right: 'AI 1h', lanes: [[{ from: day + 8 * 3600000, to: day + 9 * 3600000, cls: 'c-agents', title: 'Agents working' }], [{ from: day + 9 * 3600000, to: day + 9 * 3600000 + 5000, cls: 'w-permission', title: 'permission: Bash' }]], marks: [{ at: day + 9.5 * 3600000, title: '#10 merged' }] }], lo: 8 * 3600000, hi: 10 * 3600000, laneLabels: ['AI', 'You'] });
  assert.match(strips, />8 AM<\/text>.*>9 AM<\/text>.*>10 AM<\/text>/s, 'an hour apart on a short day, on the 12-hour clock');
  assert.match(strips, /<rect class="w-permission" x="[\d.]+" y="\d+" width="1\.5"[^>]*><title>permission: Bash<\/title>/, 'a five-second wait still shows');
  assert.match(strips, /<path class="mark"[^>]*><title>#10 merged<\/title>/);
  assert.match(strips, />AI<\/text>.*>You<\/text>/s);
});

function sessionLogs(projects, client) {
  const dir = path.join(projects, client.replace(/[^A-Za-z0-9]/g, '-'));
  const u = (n, h1 = 0) => ({ input_tokens: n, cache_creation_input_tokens: 2 * n, cache_creation: { ephemeral_5m_input_tokens: 2 * n - h1, ephemeral_1h_input_tokens: h1 }, cache_read_input_tokens: 10 * n, output_tokens: n });
  const a = (ts, id, content, n, stop, branch = 'dev', model = 'claude-opus-5-5') => ({ type: 'assistant', timestamp: ts, gitBranch: branch, message: { id, role: 'assistant', model, content: [content], usage: u(n, n), stop_reason: stop } });
  const res = (ts, id, text, error = false, extra = {}) => ({ type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: error }] }, toolUseResult: extra });
  const lead = [
    { type: 'user', timestamp: at(0), gitBranch: 'dev', message: { role: 'user', content: '/pipeline next 1 my private words' } },
    { type: 'user', timestamp: at(0), isMeta: true, message: { role: 'user', content: '<local-command-caveat>x' } },
    a(at(1), 'msg_1', { type: 'tool_use', id: 'tu_1', name: 'Agent', input: { subagent_type: 'backend-engineer', description: '#10 lane' } }, 10, 'tool_use'),
    res(at(1), 'tu_1', 'launched', false, { agentId: 'ag1', resolvedModel: 'claude-sonnet-5-5', status: 'async_launched' }),
    a(at(2), 'msg_2', { type: 'tool_use', id: 'tu_2', name: 'Bash', input: { command: 'GITLAB_TOKEN=glpat-abcdefghijklmnopqrstu glab mr list' } }, 20, 'tool_use'),
    res(at(3), 'tu_2', 'PreToolUse:Bash hook error: [glab:api] no', true),
    a(at(4), 'msg_3', { type: 'text', text: 'Waiting.' }, 30, 'end_turn'),
    { type: 'assistant', timestamp: at(5), isApiErrorMessage: true, message: { id: 'e1', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: Your computer went to sleep mid-response.' }] } },
    { type: 'user', timestamp: at(6), gitBranch: 'dev', message: { role: 'user', content: '<task-notification><task-id>ag1</task-id></task-notification>' } },
    a(at(100), 'msg_late', { type: 'text', text: 'Later.' }, 40, 'end_turn'),
  ];
  const lane = [
    a(at(2), 'msg_a1', { type: 'tool_use', id: 'tu_a1', name: 'Edit', input: { file_path: `${client}/.claude/worktrees/agent-ag1/backend/app.py` } }, 5, 'tool_use', 'feat/10-x', 'claude-sonnet-5-5'),
    res(at(3), 'tu_a1', 'ok'),
    a(at(4), 'msg_a2', { type: 'tool_use', id: 'tu_a2', name: 'Bash', input: { command: 'npm test' } }, 1, null, 'feat/10-x', 'claude-sonnet-5-5'),
    a(at(4), 'msg_a2', { type: 'text', text: 'and more' }, 6, 'tool_use', 'feat/10-x', 'claude-sonnet-5-5'),
    res(at(5), 'tu_a2', 'Exit code 1\nfailed', true),
    a(at(6), 'msg_a3', { type: 'text', text: 'Report.' }, 7, 'end_turn', 'feat/10-x', 'claude-sonnet-5-5'),
  ];
  write(path.join(dir, 'sess-0001.jsonl'), lead.map((e) => JSON.stringify(e)).join('\n'));
  write(path.join(dir, 'sess-0001/subagents/agent-ag1.jsonl'), lane.map((e) => JSON.stringify(e)).join('\n'));
  write(path.join(dir, 'sess-0001/subagents/agent-ag1.meta.json'), JSON.stringify({ agentType: 'backend-engineer', description: '#10 lane' }));
}

test('forge timeline import: the history from Claude Code\'s logs, before the hooks\' first line', () => {
  const w = world();
  const projects = path.join(w.base, 'projects');
  sessionLogs(projects, w.client);
  write(path.join(w.state, 'timeline-2026-10.jsonl'), `${JSON.stringify({ at: at(50), event: 'session.start', who: 'lead' })}\n`);
  write(path.join(w.state, 'gates.json'), JSON.stringify({ abc: { ok: true, branch: 'feat/10-x', cmd: 'npm test', at: at(7) }, def: { ok: false, branch: 'feat/10-x', cmd: 'npm test', at: at(60) } }));
  const r = importHistory({ main: w.client, stateDir: w.state, env: { CLAUDE_PROJECTS_DIR: projects } });
  const lines = fs.readFileSync(path.join(w.state, 'timeline-import.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const ev = (event, test = () => true) => lines.filter((e) => e.event === event && test(e));
  assert.equal(r.sessions, 1);
  assert.equal(r.agents, 1);
  assert.ok(lines.every((e) => e.source === 'import'));
  assert.deepEqual(ev('prompt').map((e) => [e.who, e.what, e.chars]), [['human', '/pipeline', 33]]);
  assert.equal(ev('agent.notify').length, 1);
  assert.deepEqual(ev('tool.refused').map((e) => [e.rule, e.tool]), [['glab:api', 'Bash']]);
  assert.doesNotMatch(JSON.stringify(lines), /glpat-abc|private words|Waiting\./, 'no secrets, prompts or replies');
  assert.deepEqual(ev('tool.done', (e) => e.tool === 'Agent').map((e) => [e.spawned, e.agentModel]), [['ag1', 'claude-sonnet-5-5']]);
  const lane = lines.filter((e) => e.agent === 'ag1');
  assert.ok(lane.every((e) => e.who === 'backend-engineer' && e.ticket === '#10'));
  assert.deepEqual(lane.map((e) => e.event), ['agent.start', 'tool.start', 'tool.done', 'tool.start', 'tool.fail', 'reply', 'agent.stop']);
  assert.equal(lane[1].what, 'backend/app.py', 'paths without the worktree folder');
  assert.deepEqual([lane[1].tokens, lane[1].cacheWrite1h, lane[1].cacheWrite5m], [70, 5, 5]);
  assert.equal(lane[3].tokens, 84, 'a streamed reply: the final line\'s numbers');
  assert.deepEqual(ev('turn.end').map((e) => [e.reply, e.tokens]), [['msg_3', 420]]);
  assert.match(ev('turn.fail')[0].why, /went to sleep/);
  assert.deepEqual(ev('gates.pass').map((e) => e.ticket), ['#10']);
  assert.equal(ev('gates.fail').length, 0, 'after the hooks\' first line: nothing but tokens');
  assert.deepEqual(ev('reply', (e) => e.reply === 'msg_late').map((e) => e.tokens), [560], 'a later reply\'s tokens the hooks did not record');
  importHistory({ main: w.client, stateDir: w.state, env: { CLAUDE_PROJECTS_DIR: projects } });
  assert.equal(fs.readFileSync(path.join(w.state, 'timeline-import.jsonl'), 'utf8').trim().split('\n').length, lines.length, 'running it again replaces, never adds');
});

test('forge dashboard: one page with fifteen charts, the architecture, the screens, the app and the table in nine tabs, a CSV next to it', () => {
  const w = world();
  write(path.join(w.state, 'timeline-2026-10.jsonl'), `${LINES.map((e) => JSON.stringify(e)).join('\n')}\n`);
  record({ buf: Buffer.from('a picture'), info: { type: 'png', width: 1280, height: 720 }, at: T0 + 30 * M, what: 'S1 the <data> model page', ticket: 10, branch: 'feat/10-data-model', commit: 'c0ffee12345678' }, w.folder);
  write(path.join(w.folder, 'shots', 'odd.json'), JSON.stringify({ at: at(31), what: 'edited by hand', file: 'odd.png', width: '1"><script>x()</script>', height: 5 }));
  write(path.join(w.folder, 'shots', 'odd.png'), 'x');
  write(path.join(w.folder, 'shots', 'away.json'), JSON.stringify({ at: at(32), what: 'outside', file: '../project.json', width: 1, height: 1 }));
  const out = path.join(w.base, 'out', 'dash.html');
  const r = spawnSync('node', [FORGE, 'dashboard', '--offline', '--no-open', '--out', out], { cwd: w.client, encoding: 'utf8', env: { ...process.env, CLAUDECODE: '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2 tickets, 2 of 3 merged/);
  const html = fs.readFileSync(out, 'utf8');
  for (const title of ['The project over time', 'Progress and forecast', 'Issues over time', 'Where each ticket\'s time goes', 'Waiting for you', 'Tokens per ticket, by model', 'Tokens per ticket, by stage', 'Who spends it, on which model', 'What the cost is made of', 'Tokens per day', 'Rework', 'Friction map', 'Tickets']) assert.ok(html.includes(esc(title)), title);
  assert.equal((html.match(/<span class="num">/g) || []).length, 15);
  assert.deepEqual([...html.matchAll(/<button type="button" role="tab" [^>]*aria-selected="(\w+)" data-tab="(\w+)">/g)].map((x) => `${x[2]}:${x[1]}`), ['overview:true', 'architecture:false', 'time:false', 'cost:false', 'quality:false', 'skills:false', 'screens:false', 'app:false', 'tickets:false']);
  assert.deepEqual([...html.matchAll(/<section class="panel" id="tab-(\w+)"/g)].map((x) => x[1]), ['overview', 'architecture', 'time', 'cost', 'quality', 'skills', 'screens', 'app', 'tickets']);
  assert.match(html, /data-tab="screens">Screens<span class="count">2<\/span>/, 'a record pointing outside shots/ is skipped');
  assert.match(html, /alt="edited by hand" width="" height="5"/, 'what a record says is never markup');
  assert.doesNotMatch(html, /<script>x\(\)/);
  assert.match(html, /<figure class="shot" id="shot-1"><a href="#shot-1" title="Show it larger"><img src="data:image\/png;base64,YSBwaWN0dXJl" alt="S1 the &lt;data&gt; model page" width="1280" height="720"><\/a><figcaption><b>\d+:30 [AP]M<\/b> · #10 Data model<br>S1 the &lt;data&gt; model page<span class="dim"> · feat\/10-data-model c0ffee12<\/span>/);
  assert.match(html, /<a href="#shot-1" class="shot-mk"><title>Screenshot \d+:30 [AP]M · #10 · S1 the &lt;data&gt; model page<\/title>/, 'a camera on chart 1 links to the picture');
  assert.match(html, /<i class="shk"><\/i>Screenshot/);
  assert.ok(html.indexOf('id="shot-1"') > html.indexOf('id="tab-screens"') && html.indexOf('id="shot-1"') < html.indexOf('id="tab-tickets"'));
  assert.ok(html.indexOf('The project over time') < html.indexOf('id="tab-time"') && html.indexOf('Friction map') > html.indexOf('id="tab-quality"'), 'each chart in its tab');
  assert.match(html, /Waiting for you<\/span><b>28m<\/b>/, 'the project\'s waits: 13-23 and 31-49');
  assert.match(html, /<span>Working time<\/span><b>\d+[hm][^<]*<\/b><\/div><div class="kpi"><span>Waiting for you<\/span>/, 'working time sits next to the waits');
  assert.match(html, /Working time: the AI at work \(agents, gates, the lead(?:'|&#39;|&#x27;)s turns\)/);
  assert.match(html, /in 2 waits \(replies 28m\)/);
  assert.match(html, /<path class="mark"[^>]*><title>#10 Data model merged/);
  assert.match(html, /Tokens shown: add prices to project\.json/);
  assert.match(html, /Opus share of tokens<\/span><b>71%<\/b>/);
  assert.match(html, /<span>Tokens<\/span><b>[\d.]+k<\/b><small>[\d.]+[kM]? re-read \(\d+%\) · [\d.]+[kM]? new · [\d.]+[kM]? output<\/small>/, 'the tokens by kind under the total');
  assert.match(html, /<span>API cost<\/span><b>no prices set<\/b><\/div>/);
  assert.match(html, /Tickets merged<\/span><b>2 of 3<\/b>/);
  assert.match(html, /Stories done<\/span><b>2 of 3<\/b>/, 'E1-S1 (#10) and E1-S2 (#11) are done; E2-S1 waits for #12');
  assert.match(html, /est 2–4 h · actual 1\.5 h · db/);
  assert.match(html, /<td data-v="5–9 h">5–9 h<\/td>/, '#11 has no plan estimate: the bootstrap draft\'s');
  assert.match(html, /2 rounds, 1 with blockers/);
  assert.match(html, /Too early for a forecast/);
  assert.doesNotMatch(html, /project-manager ×|PM digest/, 'the project manager is overhead, not a ticket\'s agent');
  assert.doesNotMatch(html, /<script[^>]+src=|https?:\/\/(?!www\.w3)/, 'no library and no network');
  assert.match(html, /This project has no Compose file yet/, 'no app here: the Run the app tab says so');
  const csv = fs.readFileSync(path.join(w.base, 'out', 'dash.csv'), 'utf8').trim().split('\n');
  assert.match(csv[0], /^ticket,title,status,stories,areas,gates,estimate,actual_h,wall_h/);
  assert.match(csv[0], /,rework_tokens,plan_tokens,build_tokens,review_tokens,qa_tokens,lead_tokens,other_tokens,merged$/);
  assert.match(csv[1], /^#10,Data model,Merged,E1-S1,db,security,2–4 h,1\.5,0\.82,0\.20,0\.47,0\.05,2,2,1,0,32000,23000,9000,,,12000,0,9000,0,0,23000,0,2026-10-09T08:50:00\.000Z$/, "49 minutes from the first spawn to the merge");
  write(path.join(w.folder, 'project.json'), JSON.stringify({ project: { name: 'acme', prices: PRICES }, policy: { gates: { full: 'true' } } }));
  spawnSync('node', [FORGE, 'dashboard', '--offline', '--no-open', '--out', out], { cwd: w.client, encoding: 'utf8' });
  const priced = fs.readFileSync(out, 'utf8');
  for (const title of ['Cost per ticket, by model', 'Cost per ticket, by stage', 'Spend per day']) assert.ok(priced.includes(title), title);
  assert.doesNotMatch(priced, /Tokens shown/);
  assert.match(priced, /Opus share of cost<\/span><b>\d+%<\/b>/);
  assert.match(priced, /<span>API cost<\/span><b>[^<]+<\/b><small>[^<]+ re-read \(\d+%\) · [^<]+ new · [^<]+ output<\/small>/, 'and the cost by kind under its total');
  const one = spawnSync('node', [FORGE, 'dashboard', '--offline', '--no-open', '--out', out, '--ticket', '11'], { cwd: w.client, encoding: 'utf8' });
  assert.match(one.stdout, /1 tickets/);
  const eleven = fs.readFileSync(out, 'utf8');
  assert.doesNotMatch(eleven, /id="shot-1"/, '#10\'s picture is not #11\'s');
  assert.match(eleven, /No screenshots yet/);
});

function esc(s) { return s.replace(/'/g, '&#39;'); }

test('the records the text form adds: a plan\'s status line, and lanes stopped with failing gates not passed since', () => {
  const w = world();
  write(path.join(w.folder, 'plans/12-book.md'), '# Book page (#12)\nWritten 2026-10-09, before any code. Status: **in review**, round 2\nAreas: ui\n');
  const plans = readPlans(w.folder);
  assert.deepEqual([plans.get(12).status, plans.get(11).status], ['in review, round 2', null], 'Status: may follow other words on its line');
  assert.deepEqual(readGatesFailed(w.state), [], 'no state yet');
  write(path.join(w.state, 'gates-failed.json'), JSON.stringify({
    'feat/12-book': { agent: 'frontend-engineer', at: at(200), reason: 'Gates failed on feat/12-book@abc12345 (exit 1): npm test' },
    'feat/13-later': { agent: 'backend-engineer', at: at(100), reason: 'Gates failed' },
    'chore/odd': { agent: 'devops-engineer', at: at(100), reason: 'Gates failed' },
  }));
  write(path.join(w.state, 'gates.json'), JSON.stringify({
    aaa: { ok: true, branch: 'feat/13-later', at: at(110) },
    bbb: { ok: true, branch: 'feat/12-book', at: at(150) },
    ccc: { ok: false, branch: 'chore/odd', at: at(120) },
  }));
  assert.deepEqual(readGatesFailed(w.state), [
    { branch: 'feat/12-book', ticket: 12, agent: 'frontend-engineer', at: T0 + 200 * M, reason: 'Gates failed on feat/12-book@abc12345 (exit 1): npm test' },
    { branch: 'chore/odd', ticket: null, agent: 'devops-engineer', at: T0 + 100 * M, reason: 'Gates failed' },
  ], 'a green run before the failure does not clear it; one after does');
});

test('forge dashboard --text: the page\'s numbers as text, what to look at, and no file written', () => {
  const w = world();
  // #12 is open: lanes from 140m to 260m (no line for 15 minutes or more counts as nobody working, as in chart 3),
  // two review rounds with blockers, a blocked plan, a lane stopped with failing gates.
  const open = [
    { at: at(140), event: 'tool.start', who: 'lead', tool: 'Agent', id: 's3', what: 'frontend-engineer: #12 lane', ticket: '#12', ...tokens('r8', 'claude-opus-5-5', 600) },
    { at: at(140), event: 'tool.done', who: 'lead', tool: 'Agent', id: 's3', ms: 100, spawned: 'a3', ticket: '#12' },
    { at: at(141), event: 'agent.start', who: 'frontend-engineer', agent: 'a3' },
    { at: at(200), event: 'agent.gates-failed', who: 'frontend-engineer', agent: 'a3', why: 'GATES-FAILED' },
    { at: at(201), event: 'tool.start', who: 'lead', tool: 'Agent', id: 's4', what: 'frontend-engineer: #12 fix', ticket: '#12' },
    { at: at(201), event: 'tool.done', who: 'lead', tool: 'Agent', id: 's4', ms: 100, spawned: 'a4', ticket: '#12' },
    { at: at(202), event: 'agent.start', who: 'frontend-engineer', agent: 'a4' },
    { at: at(260), event: 'agent.stop', who: 'frontend-engineer', agent: 'a4', ...tokens('r9', 'claude-sonnet-5-5', 700) },
  ];
  write(path.join(w.state, 'timeline-2026-10.jsonl'), `${[...LINES, ...open].map((e) => JSON.stringify(e)).join('\n')}\n`);
  write(path.join(w.folder, 'plans/12-book.md'), '# Book page (#12)\nWritten 2026-10-09. Status: blocked on #30 (the API lacks the slot\'s doctor)\nAreas: ui\n## Estimate\n| Item | Low | High |\n|---|---|---|\n| **Total** | **0.75 h** | **1.5 h** |\n');
  write(path.join(w.folder, 'reviews/12/code.md'), 'Verdict: REQUEST CHANGES\nCommit: ccccccc\n');
  sh(w.team, 'git', 'add', '.');
  commit(w.team, 'review #12', at(230));
  write(path.join(w.folder, 'reviews/12/code-r2.md'), 'Verdict: REQUEST CHANGES\nCommit: ddddddd\n');
  sh(w.team, 'git', 'add', '.');
  commit(w.team, 'review #12 again', at(250));
  write(path.join(w.state, 'gates-failed.json'), JSON.stringify({
    'feat/12-book': { agent: 'frontend-engineer', at: at(200), reason: 'Gates failed on feat/12-book@abc12345 (exit 1): npm test' },
    'feat/10-data-model': { agent: 'backend-engineer', at: at(5), reason: 'Gates failed before the merge' },
  }));
  const r = spawnSync('node', [FORGE, 'dashboard', '--offline', '--text'], { cwd: w.client, encoding: 'utf8', env: { ...process.env, CLAUDECODE: '' } });
  assert.equal(r.status, 0, r.stderr);
  const text = r.stdout;
  assert.match(text, /^acme: progress on \d\d \w{3}, \d+:\d\d [AP]M\nStep: /);
  // Where the project is (decision 143): no bootstrap stage left open, so the build; #12 waits for a person.
  assert.match(text, /\nStep: 10 of 11, Build \(2 of 3 merged, 1 in flight\); in flight: #12 Build\.\nWaiting for you: Build: #12 is at its limit \(2 review rounds with blockers \(limit 2\)\): forge limits lift 12\.\n\n/);
  assert.match(text, /\nTickets merged: 2 of 3 · stories done: 2 of 3\n/, 'the same totals as the page');
  assert.match(text, /\nWorking time: \d+[hm][^·]* · waiting for you: 28m\n/);
  assert.match(text, /\nTokens: [\d.]+k = [\d.]+[kM]? re-read \(\d+%\) \+ [\d.]+[kM]? new \+ [\d.]+[kM]? output · API cost: no prices set · Opus share of tokens: \d+% · agents: \d+\n/);
  assert.match(text, /\nForecast: too early, it needs at least 3 merged tickets with a timeline \(2 so far\)\.\n/);
  assert.match(text, /\nScope: 3 tickets from the bootstrap\.\n/, 'nothing added since');
  assert.match(text, /\nOpen \(1\):\n- #12 Book page · blocked on #30 \(the API lacks the slot's doctor\) · est 0\.75–1\.5 h · 2h 00m so far \(nobody 2h 00m\) · 2 review rounds, 2 with blockers · 2 agents · [\d.]+k tokens\n/);
  assert.doesNotMatch(text, /Not started/, 'every catalogue ticket has started');
  assert.match(text, /\nMerged \(2\), newest first:\n- #11 Slots API · merged \d\d \w{3}, \d+:\d\d [AP]M · est 5–9 h · .*\n- #10 Data model · merged .* · est 2–4 h · .* · 2 review rounds, 1 with blockers · 2 agents · .*\n/);
  const look = text.split('\nLook at:\n')[1].split('\n\n')[0].split('\n');
  assert.equal(look.length, 5, look.join('\n'));
  assert.equal(look[0], '- #12: at its limit (2 review rounds with blockers (limit 2)): parked until a person lifts it with forge limits lift 12.', 'the circuit breaker (decision 127)');
  assert.equal(look[1], '- #12: 2h 00m so far, past its estimate (0.75–1.5 h).');
  assert.equal(look[2], '- #12: blocked on #30 (the API lacks the slot\'s doctor)');
  assert.match(look[3], /^- feat\/12-book: GATES-FAILED \(frontend-engineer, \d\d \w{3}, \d+:\d\d [AP]M\): Gates failed on feat\/12-book@abc12345 \(exit 1\): npm test$/);
  assert.match(look[4], /^- Nothing has happened for \d+h \d\dm while 1 ticket is open: nobody is working\.$/, 'the last line was days ago');
  assert.doesNotMatch(text, /feat\/10-data-model/, '#10 is merged: its old failure is history');
  assert.match(text, /\nLongest waits for you \(2 of 2\):\n- 18m · Your reply after the lead stopped · #10 · \d\d \w{3}, \d+:\d\d [AP]M\n- 10m · /);
  assert.ok(!fs.existsSync(path.join(w.state, 'dashboard.html')) && !fs.existsSync(path.join(w.state, 'dashboard.csv')), 'it writes nothing');

  const one = spawnSync('node', [FORGE, 'dashboard', '--offline', '--text', '--ticket', '11'], { cwd: w.client, encoding: 'utf8', env: { ...process.env, CLAUDECODE: '' } });
  assert.equal(one.status, 0, one.stderr);
  assert.match(one.stdout, /, tickets #11\n/);
  assert.match(one.stdout, /\nOpen \(0\):\n- none\n/);
  assert.match(one.stdout, /\nMerged \(1\), newest first:\n- #11 Slots API/);
  assert.match(one.stdout, /\nLook at:\n- nothing\n/, '#12\'s failure is not #11\'s');
});


// Decision 139: questions asked and not answered outlive the session that asked them: the plan's status line says so.
test('forge dashboard --text: a plan waiting for the owner is under Look at', () => {
  const w = world();
  const open = [
    { at: at(140), event: 'tool.start', who: 'lead', tool: 'Agent', id: 's3', what: 'owner-assistant: #12 questions', ticket: '#12' },
    { at: at(140), event: 'tool.done', who: 'lead', tool: 'Agent', id: 's3', ms: 100, spawned: 'a3', ticket: '#12' },
  ];
  write(path.join(w.state, 'timeline-2026-10.jsonl'), `${[...LINES, ...open].map((e) => JSON.stringify(e)).join('\n')}\n`);
  write(path.join(w.folder, 'plans/12-book.md'), '# Book page (#12)\nStatus: waiting for the owner: Q4, Q6 (asked 2026-10-21)\nAreas: ui\n');
  const r = spawnSync('node', [FORGE, 'dashboard', '--offline', '--text'], { cwd: w.client, encoding: 'utf8', env: { ...process.env, CLAUDECODE: '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\nOpen \(1\):\n- #12 Book page · waiting for the owner: Q4, Q6 \(asked 2026-10-21\)/);
  const look = r.stdout.split('\nLook at:\n')[1].split('\n\n')[0].split('\n');
  assert.ok(look.includes('- #12: waiting for the owner: Q4, Q6 (asked 2026-10-21)'), look.join('\n'));
});

test('the kit version: what this checkout runs, with the project\'s pin and the forge command when they differ', () => {
  assert.equal(kitText({ active: '0.2.15', pinned: '0.2.15', cli: '0.2.15' }), 'se-forge 0.2.15');
  assert.equal(kitText({ active: '0.2.15', pinned: null, cli: '0.2.15' }), 'se-forge 0.2.15', 'no pin: the project follows the forge command');
  assert.equal(kitText({ active: '0.2.10', pinned: '0.2.10', cli: '0.2.15' }), 'se-forge 0.2.10 (the forge command is 0.2.15)');
  assert.equal(kitText({ active: '0.2.10', pinned: '0.2.11', cli: '0.2.15' }), 'se-forge 0.2.10, but the project pins 0.2.11: forge sync (the forge command is 0.2.15)');
  assert.equal(kitText({ active: '0.2.38', pinned: '0.2.38', cli: '0.2.38', llm: 'gpu (Qwen/Qwen3.8-27B)' }), 'se-forge 0.2.38, on the model server gpu (Qwen/Qwen3.8-27B)', 'forge llm (decision 140)');
  assert.equal(kitText({ active: null, pinned: '0.2.11', cli: '0.2.15' }), 'no kit in this checkout, the project pins se-forge 0.2.11: forge sync');
  assert.equal(kitText({ active: null, pinned: null, cli: '0.2.15' }), '');
  assert.equal(kitText(null), '');

  const w = world();
  const cli = fs.readFileSync(path.resolve(path.dirname(FORGE), '../../VERSION'), 'utf8').trim();
  write(path.join(w.client, '.forge/kit/VERSION'), '0.2.10\n');
  write(path.join(w.folder, 'project.json'), JSON.stringify({ kit: { version: '0.2.11' }, project: { name: 'acme' }, policy: { gates: { full: 'true' } } }));
  const env = { ...process.env, CLAUDECODE: '' };
  const r = spawnSync('node', [FORGE, 'dashboard', '--offline', '--text'], { cwd: w.client, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  const line = `se-forge 0.2.10, but the project pins 0.2.11: forge sync${cli === '0.2.10' ? '' : ` (the forge command is ${cli})`}`;
  assert.match(r.stdout, new RegExp(`^acme: progress on [^\\n]+\\nKit: ${line.replace(/[.()]/g, '\\$&')}\\.\\nStep: `), 'under the header');
  const page = spawnSync('node', [FORGE, 'dashboard', '--offline', '--no-open'], { cwd: w.client, encoding: 'utf8', env });
  assert.equal(page.status, 0, page.stderr);
  assert.ok(fs.readFileSync(path.join(w.state, 'dashboard.html'), 'utf8').includes(` tickets · ${line}</p>`), 'the page names it under the title');
});

test('forge dashboard: issues over time from the tracker, its line in --text, and the last read when it cannot be reached (decision 122)', () => {
  const w = world();
  const bin = path.join(w.base, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(path.join(path.dirname(FORGE), '../../tests/cli/fixtures/issues-glab.js'), path.join(bin, 'glab'));
  fs.chmodSync(path.join(bin, 'glab'), 0o755);
  const log = path.join(w.base, 'glab.log');
  write(log, '');
  write(path.join(w.base, 'issues.json'), JSON.stringify({
    issues: [
      { iid: 1, title: '[Epic] E1', state: 'opened', labels: ['type::Epic'], created_at: at(0), updated_at: at(0) },
      { iid: 10, title: 'Data model', state: 'closed', labels: ['status::Done'], created_at: at(1), updated_at: at(60), web_url: 'https://gitlab.example.com/acme/app/-/issues/10' },
      { iid: 12, title: 'Book page', state: 'opened', labels: ['status::In Progress'], created_at: at(2), updated_at: at(30) },
    ],
    labels: { 10: [{ created_at: at(59), action: 'add', label: { name: 'status::Done' } }], 12: [{ created_at: at(30), action: 'add', label: { name: 'status::In Progress' } }] },
    states: { 10: [{ created_at: at(60), state: 'closed' }] },
  }));
  const env = { ...process.env, CLAUDECODE: '', PATH: `${bin}:${process.env.PATH}`, FAKE_ISSUES: path.join(w.base, 'issues.json'), FAKE_LOG: log };
  const run = (args, extra = {}) => spawnSync('node', [FORGE, 'dashboard', ...args], { cwd: w.client, encoding: 'utf8', env: { ...env, ...extra } });
  let r = run(['--text']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\nIssues: 0 open, 1 in progress, 0 in testing, 1 closed \(GitLab, read \d\d \w{3}, \d+:\d\d [AP]M; the epic not counted\)\.\n/);
  const out = path.join(w.base, 'out', 'dash.html');
  r = run(['--no-open', '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  const html = fs.readFileSync(out, 'utf8');
  assert.match(html, /<span class="num">3<\/span>Issues over time<\/h2>/);
  assert.ok(html.indexOf('Issues over time') < html.indexOf('id="tab-time"'), 'on the Overview tab');
  assert.match(html, /<i class="i-open"><\/i>Open.*<i class="i-closed"><\/i>Closed/, 'the legend, top band first');
  assert.match(html, /<path class="band i-closed" d="M/);
  assert.match(html, /<td data-v="10"><a href="https:\/\/gitlab\.example\.com\/acme\/app\/-\/issues\/10" target="_blank" rel="noopener" title="Open #10 on the tracker">#10<\/a><\/td>/, 'the ticket opens its issue');
  assert.match(html, /<td data-v="11">#11<\/td>/, 'no address known for #11 (a local remote): plain text');
  assert.match(html, /Now: <b>0 open, 1 in progress, 0 in testing, 1 closed<\/b> \(the epic is not counted: an epic stays open while its tickets close\)\. From GitLab, read /);
  const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  r = run(['--text'], { FAKE_FAIL: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\nIssues: GitLab could not be read now \(glab api projects\/:id\/issues: 401 Unauthorized\); at the last read, .*: 0 open, 1 in progress, 0 in testing, 1 closed; the epic not counted\.\n/);
  write(log, '');
  r = run(['--offline', '--text']);
  assert.match(r.stdout, /\nIssues: 0 open, 1 in progress/);
  assert.equal(fs.readFileSync(log, 'utf8'), '', '--offline calls no tracker');
  assert.ok(calls.length >= 1);
});

test('forge dashboard: the Tickets tab lists every ticket, the ones nobody has picked yet too, with its status on the board (decision 135)', () => {
  const w = world();
  const bin = path.join(w.base, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(path.join(path.dirname(FORGE), '../../tests/cli/fixtures/issues-glab.js'), path.join(bin, 'glab'));
  fs.chmodSync(path.join(bin, 'glab'), 0o755);
  write(path.join(w.base, 'glab.log'), '');
  write(path.join(w.base, 'issues.json'), JSON.stringify({
    issues: [
      { iid: 1, title: '[Epic] E1', state: 'opened', labels: ['type::Epic', 'status::Todo'], created_at: at(0), updated_at: at(0) },
      { iid: 10, title: 'Data model', state: 'closed', labels: ['status::Done'], created_at: at(1), updated_at: at(60) },
      { iid: 12, title: 'Book page', state: 'opened', labels: ['status::In Progress'], created_at: at(2), updated_at: at(30) },
      { iid: 13, title: '[Follow-up] fix(api): refuse an empty name', state: 'opened', labels: ['status::Todo', 'area::api', 'type::Task'], created_at: at(70), updated_at: at(70), web_url: 'https://gitlab.example.com/acme/app/-/issues/13' },
      { iid: 14, title: 'Duplicate of #13', state: 'closed', labels: ['status::Todo'], created_at: at(71), updated_at: at(72) },
    ],
    labels: {}, states: {},
  }));
  const env = { ...process.env, CLAUDECODE: '', PATH: `${bin}:${process.env.PATH}`, FAKE_ISSUES: path.join(w.base, 'issues.json'), FAKE_LOG: path.join(w.base, 'glab.log') };
  const out = path.join(w.base, 'out', 'dash.html');
  const run = (args) => spawnSync('node', [FORGE, 'dashboard', '--no-open', '--out', out, ...args], { cwd: w.client, encoding: 'utf8', env });
  const table = () => {
    const html = fs.readFileSync(out, 'utf8');
    const tab = html.slice(html.indexOf('id="tab-tickets"'));
    return { html, tab, rows: [...tab.matchAll(/<tr class="t-row"><td data-v="(\d+)">.*?<\/td><td data-v="[^"]*" class="title"[^>]*>[^<]*<\/td><td data-v="([^"]*)">/g)].map((x) => `#${x[1]} ${x[2]}`) };
  };
  // Before the board is read: #12 has a plan but no work yet, and the status comes from the records.
  let r = run(['--offline']);
  assert.equal(r.status, 0, r.stderr);
  let t = table();
  assert.deepEqual(t.rows, ['#10 Merged', '#11 Merged', '#12 Not started']);
  assert.match(t.tab, /the board has not been read yet: run forge dashboard without --offline/);
  // The board read: its status for each ticket, and its issues no record names (a follow-up, a closed duplicate); no epic.
  r = run([]);
  assert.equal(r.status, 0, r.stderr);
  t = table();
  assert.deepEqual(t.rows, ['#10 Done', '#11 Merged', '#12 In Progress', '#13 Todo', '#14 Closed']);
  assert.doesNotMatch(t.tab, /the board has not been read yet/);
  assert.match(t.tab, /<td data-v="13"><a href="https:\/\/gitlab\.example\.com\/acme\/app\/-\/issues\/13" [^>]*>#13<\/a><\/td><td data-v="\[Follow-up\] fix\(api\): refuse an empty name" class="title"/, 'its number opens its issue');
  assert.match(t.html, / · 5 tickets/, 'the line under the title counts the table');
  const csv = fs.readFileSync(path.join(w.base, 'out', 'dash.csv'), 'utf8').trim().split('\n');
  assert.deepEqual(csv.slice(1).map((l) => l.split(',').slice(0, 3).join(',')), ['#10,Data model,Done', '#11,Slots API,Merged', '#12,Book page,In Progress', '#13,[Follow-up] fix(api): refuse an empty name,Todo', '#14,Duplicate of #13,Closed'], 'the same rows in the CSV');
  assert.match(csv[4], /^#13,\[Follow-up\] fix\(api\): refuse an empty name,Todo,,api,,/, 'its areas from the board');
  // A ticket begun before its plan is written: the board's title.
  write(path.join(w.state, 'timeline-2026-10.jsonl'), `${JSON.stringify({ at: at(80), event: 'tool.start', who: 'lead', tool: 'Bash', id: 'b9', what: 'forge tracker get 13', ticket: '#13' })}\n`);
  r = run(['--offline']);
  assert.match(fs.readFileSync(path.join(w.base, 'out', 'dash.csv'), 'utf8'), /\n#13,\[Follow-up\] fix\(api\): refuse an empty name,Todo,,api,/);
  fs.rmSync(path.join(w.state, 'timeline-2026-10.jsonl'));
  // --days: the tickets worked on or merged in those days, and every one still to do.
  r = run(['--offline', '--days', '1']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(table().rows, ['#12 In Progress', '#13 Todo']);
  r = run(['--offline', '--ticket', '13']);
  assert.deepEqual(table().rows, ['#13 Todo']);
  // The lead's report names the same tickets nobody has picked yet.
  r = run(['--offline', '--text']);
  assert.match(r.stdout, /\nNot started \(2\): #12 Book page, #13 \[Follow-up\] fix\(api\): refuse an empty name\n/);
  assert.match(r.stdout, /\nScope: 3 tickets from the bootstrap; 2 added since \(#13 #14\)\.\n/);
});

test('forge dashboard: the Run the app tab has the steps for this project, its addresses and a live check (decision 123)', () => {
  const w = world();
  write(path.join(w.client, 'frontend/compose.yaml'), "name: acme-app\ninclude:\n  - path: ../backend/compose.yaml\nservices:\n  web:\n    image: caddy:2-alpine\n    ports:\n      - \"127.0.0.1:${WEB_PORT:-5173}:80\"\n");
  write(path.join(w.client, 'backend/compose.yaml'), "services:\n  db:\n    image: postgres:16\n    ports:\n      - \"127.0.0.1:5432:5432\"\n  api:\n    image: alpine:3\n");
  const bin = path.join(w.base, 'bin');
  // A stand-in docker: `compose config --format json` as Docker resolves the two files above.
  write(path.join(bin, 'docker'), `#!/bin/sh\n[ "$1 $2" = "compose config" ] || exit 1\necho '${JSON.stringify({ name: 'acme-app', services: { api: {}, db: { ports: [{ target: 5432, published: '5432' }] }, web: { ports: [{ target: 80, published: '5173' }] } } })}'\n`);
  fs.chmodSync(path.join(bin, 'docker'), 0o755);
  const out = path.join(w.base, 'out', 'dash.html');
  const r = spawnSync('node', [FORGE, 'dashboard', '--offline', '--no-open', '--out', out], { cwd: w.client, encoding: 'utf8', env: { ...process.env, CLAUDECODE: '', PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(r.status, 0, r.stderr);
  const html = fs.readFileSync(out, 'utf8');
  const tab = html.slice(html.indexOf('id="tab-app"'), html.indexOf('id="tab-tickets"'));
  assert.match(tab, /<p class="status" data-probe="http:\/\/localhost:5173">/, 'the page asks the app\'s address whether it runs');
  const dir = w.client.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  assert.match(tab, new RegExp(`<code>cd &#39;${dir}&#39; &amp;&amp; forge app up</code><button type="button" class="copy" data-copy="cd &#39;${dir}&#39; &amp;&amp; forge app up">Copy</button>`), 'the folder quoted for the shell, in the page and in what Copy copies');
  assert.match(tab, /forge app down/);
  assert.match(tab, /forge app up --fresh/);
  assert.match(tab, /It builds and starts api, db, web \(frontend\/compose\.yaml\)/, 'the frontend file, which includes the backend\'s');
  assert.match(tab, /<td>web<\/td><td><a href="http:\/\/localhost:5173" target="_blank" rel="noopener">http:\/\/localhost:5173<\/a><\/td>/);
  assert.match(tab, /<td>db<\/td><td>localhost:5432<\/td>/, 'a database port is an address, not a link');
  assert.match(tab, /<td>api<\/td><td><span class="dim">inside the app only<\/span>/);
  assert.match(tab, /It runs the code checked out in [^:]+: dev at [0-9a-f]{7}\./);
  assert.match(html, /fetch\(url, \{ mode: 'no-cors'/);
});

test('forge dashboard --watch: a new page and stamp each round, the page reloads itself for a newer stamp, Ctrl+C removes the stamp (decision 126)', async () => {
  const w = world();
  const out = path.join(w.base, 'out', 'dash.html');
  const stamp = path.join(w.base, 'out', 'dash.stamp.js');
  const { spawn } = await import('node:child_process');
  const p = spawn('node', [FORGE, 'dashboard', '--watch', '--every', '1', '--offline', '--no-open', '--out', out], { cwd: w.client, env: { ...process.env, CLAUDECODE: '', FORGE_WATCH_MS: '400' } });
  let text = '';
  p.stdout.on('data', (d) => { text += d; });
  p.stderr.on('data', (d) => { text += d; });
  const stamps = new Set();
  for (let i = 0; i < 60 && stamps.size < 3; i++) {
    await new Promise((r) => setTimeout(r, 150));
    if (fs.existsSync(stamp)) stamps.add(fs.readFileSync(stamp, 'utf8'));
  }
  assert.ok(stamps.size >= 3, `three builds, three stamps: ${[...stamps].join(' | ')}\n${text}`);
  const html = fs.readFileSync(out, 'utf8');
  const built = /var W = (\{[^}]+\})/.exec(html);
  assert.ok(built, 'the page carries its own build time and the stamp\'s name');
  const W = JSON.parse(built[1]);
  assert.equal(W.file, 'dash.stamp.js');
  assert.ok([...stamps].some((s) => s.includes(JSON.stringify(W.stamp))), 'the stamp names the page\'s build');
  assert.match([...stamps][0], /^window\.forgeStamp && window\.forgeStamp\("\d{4}-\d\d-\d\dT[\d:.]+Z"\);\n$/);
  assert.match(html, /<span id="watch">watching: a new page every 1 min, and this one reloads itself<\/span>/);
  assert.match(html, /if \(!\(s > W\.stamp\)\) return;/, 'only a newer stamp reloads the page');
  p.kill('SIGINT');
  const code = await new Promise((r) => p.on('close', r));
  assert.equal(code, 0, text);
  assert.match(text, /watching: a new page every 1 minute; the open page reloads itself\. Ctrl\+C stops\./);
  assert.match(text, /\d+:\d\d [AP]M rebuilt: 2 tickets, 2 of 3 merged/);
  assert.match(text, /stopped watching; the page stays as it was last built/);
  assert.ok(!fs.existsSync(stamp), 'no stamp once stopped: the open page says it is no longer watched');
});

test('forge dashboard: no watch script without --watch; --watch with --text, or --every under a minute, is refused', () => {
  const w = world();
  const out = path.join(w.base, 'out', 'plain.html');
  const run = (...args) => spawnSync('node', [FORGE, 'dashboard', '--offline', '--no-open', ...args], { cwd: w.client, encoding: 'utf8', env: { ...process.env, CLAUDECODE: '' } });
  assert.equal(run('--out', out).status, 0);
  assert.doesNotMatch(fs.readFileSync(out, 'utf8'), /forgeStamp|id="watch"/);
  assert.ok(!fs.existsSync(path.join(w.base, 'out', 'plain.stamp.js')));
  let r = run('--watch', '--text');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--watch keeps the page current; --text prints once/);
  r = run('--watch', '--every', '0.5');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--every takes minutes, 1 or more/);
});

// Decision 137: when sub-agents ran and what each had to work from, from the timeline and the checkout's agent files.
test('the Agents & skills tab: each agent\'s skills, preloaded or opened itself, by day, by role and by skill; the lead\'s own edits', async () => {
  const w = world();
  write(path.join(w.client, '.claude/skills/stack-nestjs/SKILL.md'), '---\nname: stack-nestjs\n---\n');
  write(path.join(w.client, '.claude/skills/new-endpoint/SKILL.md'), '---\nname: new-endpoint\n---\n');
  write(path.join(w.client, '.claude/skills/plan-ticket/SKILL.md'), '---\nname: plan-ticket\n---\n');
  write(path.join(w.client, '.claude/skills/stack-fastapi/SKILL.md'), '---\nname: stack-fastapi\n---\n');
  write(path.join(w.client, '.claude/skills/retro/SKILL.md'), '---\nname: retro\n---\n');
  write(path.join(w.client, '.claude/agents/backend-engineer.md'), '---\nname: backend-engineer\nskills:\n  - stack-nestjs\n  - new-endpoint\n---\nUse `stack-nestjs`, `stack-fastapi` and `new-endpoint`.\n');
  write(path.join(w.client, '.claude/agents/planner.md'), '---\nname: planner\n---\nFollow `plan-ticket`.\n');
  const lines = [
    { at: at(1), event: 'tool.start', who: 'lead', tool: 'Agent', id: 's1', what: 'planner: Plan #10', ticket: '#10' },
    { at: at(1), event: 'tool.done', who: 'lead', tool: 'Agent', id: 's1', spawned: 'p1', ticket: '#10' },
    { at: at(2), event: 'agent.start', who: 'planner', agent: 'p1' },
    { at: at(3), event: 'tool.start', who: 'planner', agent: 'p1', tool: 'Skill', what: 'plan-ticket', id: 'k1' },
    { at: at(4), event: 'tool.start', who: 'planner', agent: 'p1', tool: 'Read', what: '.claude/skills/plan-ticket/SKILL.md', id: 'k2' },
    { at: at(5), event: 'agent.stop', who: 'planner', agent: 'p1', ...tokens('q1', 'claude-opus-5-5', 900) },
    { at: at(6), event: 'tool.start', who: 'lead', tool: 'Agent', id: 's2', what: 'backend-engineer: API lane #10', ticket: '#10' },
    { at: at(6), event: 'tool.done', who: 'lead', tool: 'Agent', id: 's2', spawned: 'e1', ticket: '#10' },
    { at: at(7), event: 'agent.start', who: 'backend-engineer', agent: 'e1', skills: ['stack-nestjs', 'new-endpoint'] },
    { at: at(9), event: 'agent.stop', who: 'backend-engineer', agent: 'e1', ...tokens('q2', 'claude-sonnet-5-5', 700) },
    { at: at(10), event: 'tool.start', who: 'lead', tool: 'Agent', id: 's3', what: 'backend-engineer: API lane #10 fix', ticket: '#10' },
    { at: at(10), event: 'tool.done', who: 'lead', tool: 'Agent', id: 's3', spawned: 'e0', ticket: '#10' },
    { at: at(11), event: 'agent.start', who: 'backend-engineer', agent: 'e0' },
    { at: at(12), event: 'agent.stop', who: 'backend-engineer', agent: 'e0', ...tokens('q3', 'claude-sonnet-5-5', 300) },
    { at: at(13), event: 'tool.start', who: 'lead', tool: 'Edit', what: 'src/app.ts', id: 'l1', ticket: '#10' },
    { at: at(14), event: 'tool.start', who: 'lead', tool: 'Edit', what: '.forge/handoffs/lead-handover.md', id: 'l2' },
    { at: at(15), event: 'tool.start', who: 'lead', tool: 'Write', what: '/tmp/notes.md', id: 'l3' },
  ];
  write(path.join(w.state, 'timeline-2026-10.jsonl'), `${lines.map((e) => JSON.stringify(e)).join('\n')}\n`);
  const { dashboardModel, renderPage } = await import('../../core/cli/dashboard/page.mjs');
  const { agentRows } = await import('../../core/cli/dashboard/measures.mjs');
  const m = dashboardModel({ main: w.client, folder: w.folder, teamRoot: w.team, base: 'dev', stateDir: w.state, stack: ['NestJS 11', 'PostgreSQL 16'] });
  const sk = m.skills;
  assert.deepEqual(sk.runs.map((r) => [r.who, r.preloaded.join(','), [...r.loaded].map(([k, n]) => `${k}×${n}`).join(',')]), [['planner', '', 'plan-ticket×2'], ['backend-engineer', 'stack-nestjs,new-endpoint', ''], ['backend-engineer', '', '']]);
  const be = sk.roles.find((x) => x.who === 'backend-engineer');
  assert.deepEqual([be.runs, be.withSkill, [...be.preloaded.keys()], be.unused], [2, 1, ['stack-nestjs', 'new-endpoint'], []], 'stack-fastapi is another stack\'s guide, not "never used"');
  assert.deepEqual(sk.skills.map((k) => [k.name, k.loads, k.preloads]), [['plan-ticket', 2, 0], ['new-endpoint', 0, 1], ['stack-nestjs', 0, 1]]);
  assert.deepEqual([sk.never, sk.otherStack], [['retro'], ['stack-fastapi']]);
  assert.deepEqual([sk.lead.spawns, sk.lead.edits], [3, [['src/app.ts', 1]]], 'only the app\'s own files count as the lead\'s edits');
  assert.equal(sk.recorded, true);
  const t = m.tickets.find((x) => x.num === 10);
  assert.deepEqual(agentRows(t).filter((r) => r.agent).map((r) => [r.who, r.skills.preloaded.join(','), r.skills.loaded.map(([k, n]) => `${k}×${n}`).join(',')]), [['planner', '', 'plan-ticket×2'], ['backend-engineer', 'stack-nestjs,new-endpoint', ''], ['backend-engineer', '', '']]);
  const html = renderPage(m, { project: 'acme' });
  const tab = html.slice(html.indexOf('id="tab-skills"'), html.indexOf('id="tab-screens"'));
  assert.match(tab, /<b>2 of 3<\/b> agents had a skill\. Skills opened 2 times and preloaded 2 times; 3 of 5 skills used\./);
  assert.match(tab, /<b>1 of the app's files edited<\/b> \(src\/app\.ts\)/);
  assert.match(tab, /<td class="nw">backend-engineer<\/td><td class="n">2<\/td><td class="n">1<\/td><td>new-endpoint, stack-nestjs<\/td>/, 'most used first, then by name');
  assert.match(tab, /<h3>Never used \(1\)<\/h3><p>retro<\/p>/);
  assert.match(tab, /Guides for other stacks, not this project's: stack-fastapi\./);
  assert.doesNotMatch(tab, /Preloads are recorded from/, 'the timeline records preloads');
  assert.match(html, /<td>stack-nestjs, new-endpoint<\/td>/, 'the Tickets tab names each agent\'s skills');
  assert.match(html, /<td>opened plan-ticket ×2<\/td>/);
  const { renderText } = await import('../../core/cli/dashboard/text.mjs');
  assert.match(renderText(m, { project: 'acme' }), /^Skills: 2 of 3 agents had one \(2 opened, 2 preloaded\); 3 of 5 skills used\.$/m);
});

test('a ticket\'s agents one by one: the job each was given, its model, tokens and time, the lead last (decision 129)', async () => {
  const { agentRows } = await import('../../core/cli/dashboard/measures.mjs');
  const w = world();
  write(path.join(w.state, 'timeline-2026-10.jsonl'), `${LINES.map((e) => JSON.stringify(e)).join('\n')}\n`);
  const out = path.join(w.base, 'out', 'dash.html');
  const r = spawnSync('node', [FORGE, 'dashboard', '--offline', '--no-open', '--out', out], { cwd: w.client, encoding: 'utf8', env: { ...process.env, CLAUDECODE: '' } });
  assert.equal(r.status, 0, r.stderr);
  const html = fs.readFileSync(out, 'utf8');
  assert.match(html, /<tr class="t-row"><td data-v="10"><button type="button" class="exp" aria-expanded="false" aria-label="Show the agents of #10"/);
  const rows = /<tr class="t-agents" hidden><td colspan="\d+"><table class="agents">([\s\S]*?)<\/table>/.exec(html.slice(html.indexOf('<td data-v="10">')))[1];
  const cells = [...rows.matchAll(/<tr><td>([^<]*)<\/td><td>([^<]*)<\/td><td>([^<]*)<\/td><td>(?:<span class="dim">)?[^<]*(?:<\/span>)?<\/td><td class="n">([^<]*)<\/td>/g)].map((x) => x.slice(1));
  assert.deepEqual(cells.slice(0, 2), [['backend-engineer', '#10 lane', 'sonnet', '5.0k'], ['backend-engineer', '#10 fix', 'sonnet', '4.0k']], 'each lane with the job its spawn named, oldest first');
  assert.deepEqual(cells.at(-1).slice(0, 2), ['lead', 'its own turns for this ticket']);
  // The rows add up to the ticket's tokens.
  const { dashboardModel } = await import('../../core/cli/dashboard/page.mjs');
  const m = dashboardModel({ main: w.client, folder: w.folder, teamRoot: w.team, base: 'dev', stateDir: w.state });
  const t = m.tickets.find((x) => x.num === 10);
  assert.equal(agentRows(t).reduce((s, x) => s + x.tokens, 0), t.tokens.total);
  assert.match(html, /:scope > tr\.t-row/, 'sorting keeps each ticket\'s agents under it');
  const heads = [...html.matchAll(/<th data-i="\d+">(\w+)<\/th>/g)].map((x) => x[1]);
  assert.deepEqual(heads.slice(0, 7), ['Ticket', 'Title', 'Status', 'Tokens', 'Cost', 'Agents', 'Rounds'], 'what people look for first, by the title');
  const row10 = html.slice(html.indexOf('<td data-v="10">'), html.indexOf('</tr>', html.indexOf('<td data-v="10">')));
  const agentsCell = [...row10.matchAll(/<td data-v="([^"]*)"/g)].map((x) => x[1])[heads.indexOf('Agents')];
  assert.equal(agentsCell, '2', 'the Agents column counts the agents ▸ lists');
  assert.match(row10, /<td data-v="Data model" class="title" title="Data model">/, 'a long title is cut, the whole of it on hover');
});
