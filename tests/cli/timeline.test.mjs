// forge timeline (decision 96): where a ticket's time went, from the lines the hooks write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo } from '../policy/helpers.mjs';
import { attribute, summarize, render, ticketLines, timeline, duration, costOf } from '../../core/cli/timeline.mjs';

const FORGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../core/cli/forge.mjs');
const T0 = Date.parse('2026-10-10T09:00:00Z');
const at = (min, sec = 0) => new Date(T0 + min * 60000 + sec * 1000).toISOString();

// A ticket as the hooks record it: the lead spawns a backend engineer for #12, a permission prompt waits 4
// minutes, the gates send the engineer back once, the lead stops and you answer 20 minutes later.
const LINES = [
  { at: at(0), event: 'prompt', who: 'human', what: '/pipeline' },
  { at: at(1), event: 'tool.refused', who: 'lead', tool: 'Agent', rule: 'models:tier', ticket: '#12' },
  { at: at(2), event: 'tool.start', who: 'lead', tool: 'Agent', id: 't1', what: 'backend-engineer: #12 lane A', ticket: '#12', model: 'claude-opus-5-5', reply: 'r1', input: 10, cacheWrite5m: 0, cacheWrite1h: 1000, cacheRead: 100000, output: 500, tokens: 101510 },
  { at: at(2, 1), event: 'tool.done', who: 'lead', tool: 'Agent', id: 't1', ms: 50, spawned: 'a1', ticket: '#12' },
  { at: at(2, 2), event: 'agent.start', who: 'backend-engineer', agent: 'a1', branch: 'dev' },
  { at: at(3), event: 'tool.start', who: 'backend-engineer', agent: 'a1', tool: 'Bash', id: 't2', what: 'git push -u origin feat/12-x', model: 'claude-sonnet-5-5', reply: 'r2', input: 5, cacheWrite5m: 2000, cacheWrite1h: 0, cacheRead: 40000, output: 300, tokens: 42305 },
  { at: at(7, 2), event: 'tool.done', who: 'backend-engineer', agent: 'a1', tool: 'Bash', id: 't2', ms: 2000, what: 'git push -u origin feat/12-x' },
  { at: at(8), event: 'tool.start', who: 'backend-engineer', agent: 'a1', tool: 'Bash', id: 't3', what: 'npm test' },
  { at: at(9), event: 'tool.fail', who: 'backend-engineer', agent: 'a1', tool: 'Bash', id: 't3', ms: 60000, what: 'npm test', why: 'Exit code 1' },
  { at: at(10), event: 'gates.not-ready', who: 'kit', by: 'backend-engineer', agent: 'a1', why: 'Uncommitted changes: x' },
  { at: at(10), event: 'agent.sent-back', who: 'backend-engineer', agent: 'a1' },
  { at: at(14), event: 'gates.pass', who: 'kit', by: 'backend-engineer', agent: 'a1', ms: 30000 },
  { at: at(14), event: 'agent.stop', who: 'backend-engineer', agent: 'a1', model: 'claude-sonnet-5-5', reply: 'r3', input: 2, cacheWrite5m: 100, cacheWrite1h: 0, cacheRead: 50000, output: 200, tokens: 50302 },
  { at: at(14), event: 'agent.stop', who: 'backend-engineer', agent: 'a1', model: 'claude-sonnet-5-5', reply: 'r3', input: 2, cacheWrite5m: 100, cacheWrite1h: 0, cacheRead: 50000, output: 200, tokens: 50302 },
  { at: at(15), event: 'turn.end', who: 'lead', ticket: '#12' },
  { at: at(35), event: 'prompt', who: 'human' },
  { at: at(36), event: 'tool.start', who: 'lead', tool: 'AskUserQuestion', id: 't4', what: 'Which provider?' },
  { at: at(39), event: 'tool.done', who: 'lead', tool: 'AskUserQuestion', id: 't4', ms: 180000, what: 'Which provider?' },
  { at: at(40), event: 'turn.fail', who: 'lead', why: 'rate_limit: Too many requests', ticket: '#12' },
  { at: at(90), event: 'tool.start', who: 'lead', tool: 'Bash', id: 't9', what: 'git status', ticket: '#13' },
];

test('an agent\'s lines take the ticket its spawn named, over its branch', () => {
  const lines = attribute(LINES);
  assert.ok(lines.filter((e) => e.agent === 'a1').every((e) => e.ticket === '#12'));
  const mine = ticketLines(lines, '#12');
  assert.ok(mine.some((e) => e.event === 'prompt' && e.at === at(35)), 'your answer inside the ticket\'s time belongs to it');
  assert.ok(!mine.some((e) => e.at === at(0)), 'a message before the ticket started does not');
  assert.ok(!mine.some((e) => e.ticket === '#13'));
});

test('waits for you: after the lead stopped, at a permission prompt, answering a question', () => {
  const s = summarize(ticketLines(attribute(LINES), '#12'));
  assert.deepEqual(s.waits.map((w) => [w.what, w.ms / 60000]), [
    ['your reply after the lead stopped', 20],
    ['permission: Bash git push -u origin feat/12-x', 4],
    ['question: Which provider?', 3],
  ]);
  const agent = s.agents.get('backend-engineer');
  assert.deepEqual([agent.n, agent.ms / 1000, agent.sentBack, s.spawns], [1, 11 * 60 + 58, 1, 1]);
  assert.deepEqual([...s.refused], [['models:tier', 1]]);
  assert.deepEqual([s.gates.pass, s.gates.fail, [...s.gates.notReady]], [1, 0, [['Uncommitted changes', 1]]]);
  assert.deepEqual([...s.failed], [['Bash npm test', 1]]);
  assert.deepEqual([...s.apiErrors], [['rate_limit', 1]]);
  assert.equal(s.slowest[0].what, 'npm test');
});

test('the report reads as one block per ticket', () => {
  const text = render('#12', summarize(ticketLines(attribute(LINES), '#12')));
  for (const want of [/^#12 · .* · 39m$/m, /waiting for you\s+27m in 3 waits/, /20m {2}your reply after the lead stopped/, /1 spawned · 12m of agent time/,
    /backend-engineer ×1\s+12m {2}sent back 1× by the gates/, /gates\s+1 run in 30s: 1 passed, 0 failed · 1 not ready: Uncommitted changes/,
    /refused\s+1: models:tier/, /failed calls\s+1: Bash npm test/, /API errors\s+1: rate_limit/, /slowest calls\s+1m {2}backend-engineer {2}Bash npm test/]) {
    assert.match(text, want);
  }
  assert.equal(duration(45 * 1000), '45s');
  assert.equal(duration(92 * 60000), '1h 32m');
});

function stateWith(lines) {
  const { dir } = makeRepo();
  fs.mkdirSync(path.join(dir, '.forge/state'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.forge/state/timeline-2026-10.jsonl'), `${lines.map((e) => JSON.stringify(e)).join('\n')}\n{cut`);
  return dir;
}

test('forge timeline: a ticket, the last days, --json and --csv', () => {
  const dir = stateWith(LINES);
  const out = [];
  const run = (o) => { out.length = 0; timeline(o, { stateDir: path.join(dir, '.forge/state'), out: (s) => out.push(s), now: T0 + 2 * 86400000 }); return out.join('\n'); };
  assert.match(run({ ticket: '12' }), /^#12 · /);
  const week = run({});
  assert.match(week, /^Last 7 days · /);
  assert.match(week, /\n\n#12 · [\s\S]*\n\n#13 · /);
  assert.match(run({ days: 1 }), /No timeline lines in the last 1 days/);
  const json = run({ ticket: '#12', json: true }).split('\n').map((l) => JSON.parse(l));
  assert.ok(json.every((e) => e.ticket === '#12' || !e.ticket));
  const csv = run({ ticket: '12', csv: true }).split('\n');
  assert.equal(csv[0], 'at,event,who,agent,ticket,branch,tool,what,ms,rule,why,model,input,cacheWrite5m,cacheWrite1h,cacheRead,output,tokens,cost');
  assert.match(csv.find((l) => l.includes('tool.fail')), /,npm test,60000,,Exit code 1,,,,,,,,$/);
  const empty = makeRepo().dir;
  out.length = 0;
  timeline({}, { stateDir: path.join(empty, '.forge/state'), out: (s) => out.push(s) });
  assert.match(out[0], /No timeline yet/);
});

test('Claude Code\'s own helpers (a stop with no role, no start, no transcript) are not counted as agents', () => {
  const helpers = [0, 1, 2].map((i) => ({ at: at(20 + i), event: 'agent.stop', who: 'agent', agent: `h${i}`, branch: 'dev' }));
  const dir = stateWith([...LINES, ...helpers, { at: at(30), event: 'agent.start', agent: 'u1', who: 'agent' }, { at: at(31), event: 'agent.stop', agent: 'u1', who: 'agent' }]);
  const out = [];
  timeline({}, { stateDir: path.join(dir, '.forge/state'), out: (s) => out.push(s), now: T0 + 3600000 });
  const week = out.join('\n').split('\n\n')[0];
  assert.match(week, /\n {20}backend-engineer ×1 /);
  assert.match(week, /\n {20}agent ×1 /, 'an agent with a start but no role is still an agent');
  assert.match(week, /\n {20}and 3 of Claude Code's own helpers, which nobody spawned \(no role, no transcript\)/);
  assert.doesNotMatch(week, /running or cut off/);
});

test('a forge command you run in a terminal goes into the timeline; one an agent runs is already there', () => {
  const { dir } = makeRepo();
  const env = { ...process.env, CLAUDE_PROJECT_DIR: dir };
  delete env.CLAUDECODE;
  const r = spawnSync('node', [FORGE, 'gates'], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(r.status, 1);
  const file = fs.readdirSync(path.join(dir, '.forge/state')).find((f) => f.startsWith('timeline-'));
  const lines = fs.readFileSync(path.join(dir, '.forge/state', file), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((e) => [e.event, e.who, e.by]), [['gates.not-ready', 'kit', 'human'], ['forge.fail', 'human', undefined]]);
  assert.deepEqual([lines[1].what, lines[1].code], ['forge gates', 1]);
  spawnSync('node', [FORGE, 'gates'], { cwd: dir, env: { ...env, CLAUDECODE: '1' }, encoding: 'utf8' });
  const after = fs.readFileSync(path.join(dir, '.forge/state', file), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(after.slice(2).map((e) => [e.event, e.by]), [['gates.not-ready', 'lead']]);
});

const PRICES = { opus: { input: 10, cacheWrite5m: 11, cacheWrite1h: 12, cacheRead: 1, output: 50 }, 'claude-sonnet-5-5': { input: 2, cacheWrite5m: 3, cacheWrite1h: 4, cacheRead: 0.2, output: 10 } };

test('tokens: each reply once, by model and by who; the costliest steps; dollars at the person\'s prices', () => {
  const s = summarize(ticketLines(attribute(LINES), '#12'), PRICES);
  assert.equal(s.tokens.total, 101510 + 42305 + 50302, 'the repeated reply r3 counts once');
  assert.deepEqual([...s.tokens.byModel], [['opus', 101510], ['sonnet', 92607]]);
  assert.deepEqual([...s.tokens.byWho], [['lead', 101510], ['backend-engineer', 92607]]);
  const opus = (10 * 10 + 1000 * 12 + 100000 * 1 + 500 * 50) / 1e6; // its cache write is the 1-hour one
  assert.ok(Math.abs(costOf(LINES[2], PRICES) - opus) < 1e-12, 'a family price applies to its full model name');
  assert.ok(Math.abs(s.tokens.cost - (opus + costOf(LINES[5], PRICES) + costOf(LINES[13], PRICES))) < 1e-12);
  assert.equal(s.tokens.steps[0].reply, 'r1', 'the costliest first');
  const text = render('#12', s);
  assert.match(text, /tokens\s+194\.1k: opus 101\.5k, sonnet 92\.6k\n\s+by who: lead 101\.5k, backend-engineer 92\.6k/);
  assert.match(text, /cost\s+\$0\.17 at the API prices in project\.prices/);
  assert.match(text, /costliest steps\s+101\.5k\s+\$0\.14\s+lead\s+Agent backend-engineer: #12 lane A/);
  assert.match(text, /\$0\.01\s+backend-engineer\s+report at the end of its work/);
  assert.match(render('#12', summarize(ticketLines(attribute(LINES), '#12'), { opus: PRICES.opus })), /\(no price for sonnet\)/);
  assert.doesNotMatch(render('#12', summarize(ticketLines(attribute(LINES), '#12'))), /cost /, 'no prices, no dollars');
});

test('the CSV carries model, tokens and cost; a repeated reply keeps its tokens on one line', () => {
  const dir = stateWith(LINES);
  const out = [];
  timeline({ ticket: '12', csv: true }, { stateDir: path.join(dir, '.forge/state'), out: (s) => out.push(s), prices: PRICES });
  assert.match(out[0], /,model,input,cacheWrite5m,cacheWrite1h,cacheRead,output,tokens,cost$/);
  const r3 = out.filter((l) => l.includes('agent.stop'));
  assert.equal(r3.length, 2);
  assert.match(r3[0], /,claude-sonnet-5-5,2,100,0,50000,200,50302,0\.012304$/);
  assert.match(r3[1], /,claude-sonnet-5-5,,,,,,,$/);
  out.length = 0;
  timeline({ ticket: '12' }, { stateDir: path.join(dir, '.forge/state'), out: (s) => out.push(s) });
  assert.match(out.join('\n'), /No prices set: add project\.prices/);
});
