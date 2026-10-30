// On hold (decision 147): in the build, a ticket that waits for the owner goes on hold after policy.hold.minutes
// (forge wait-owner) and the lead takes another; the dashboard's On hold tab lists every ticket that waits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { onHold, renderHold, holdText } from '../../core/cli/dashboard/hold.mjs';
import { waitOwner, WaitError } from '../../core/cli/wait.mjs';
import { makeRepo, writeProjectConfig, DEFAULT_TEST_CONFIG } from '../policy/helpers.mjs';

const QUESTIONS = [
  'Decided by the planner: the retry count: 3, as the client does.',
  '- **Q1. Where the check lives.**',
  '  - (a) In the API.',
  '  - (b) In the worker.',
  '  - **Default: (b).** It already has the queue.',
  '- **Q2. The message when it fails.**',
  '  - **A. "Try again later"** (recommended)',
  '  - B. The error code',
  '- **Q3. Answered for you.** (a) yes. Default: (a).',
].join('\n');

const every = [
  { num: 12, id: '#12', title: 'Reminders', status: 'on hold: waiting for the owner: Q1, Q2 (asked 2026-10-30 10:12)', questions: QUESTIONS, plan: '12-reminders.md' },
  { num: 13, id: '#13', title: 'Reminder list', status: 'in progress' },
  { num: 15, id: '#15', title: 'Login', status: 'Blocked: reached its limit' },
  { num: 16, id: '#16', title: 'Export', status: null, board: { status: 'On hold', closed: false } },
  { num: 17, id: '#17', title: 'Merged one', status: 'on hold: waiting for the owner: Q1', mergedAt: 1 },
  { num: 20, id: '#20', title: 'Snooze', status: 'blocked on #12 (needs its table)' },
];
const drafts = [{ t: 'T1', deps: [] }, { t: 'T2', deps: ['T1'] }, { t: 'T3', deps: ['T1'] }];
const catalogue = [{ t: 'T1', num: 12 }, { t: 'T2', num: 13 }];

test('every ticket that waits: for an answer, at its limit, for another ticket, or on hold on the board; not a merged one', () => {
  const list = onHold({ every, drafts, catalogue });
  assert.deepEqual(list.map((h) => [h.id, h.kind]), [['#12', 'owner'], ['#15', 'limit'], ['#16', 'board'], ['#20', 'ticket']]);
  const q = list[0];
  assert.equal(q.since, '2026-10-30 10:12');
  assert.deepEqual(q.questions.map((b) => [b.id, b.pick]), [['Q1', 'b'], ['Q2', 'a']], 'the questions its status names, each with the plan\'s recommended answer');
  assert.equal(q.reply, '#12 Q1 b, Q2 a');
  assert.deepEqual(q.behind, ['#13', 'T3', '#20'], 'the drafts that depend on it, and a ticket blocked on it');
  assert.equal(list[1].reply, '! forge limits lift 15');
  assert.equal(list[2].reply, null);
  assert.equal(list[3].on, 12);
  assert.equal(holdText(list), 'On hold: #12 waits for your answer (Q1, Q2, asked 2026-10-30 10:12), 3 behind it · #15 is parked at its limit · #16 is on hold on the board · #20 waits for #12.');
  assert.equal(holdText([]), null);
});

test('a status that names no questions: every question in section 6, and a ? where the plan recommends none', () => {
  const [h] = onHold({ every: [{ num: 9, id: '#9', title: 'x', status: 'waiting for the owner (asked 2026-10-30)', questions: '- **Q1. One?**\n  - (a) yes\n  - (b) no' }] });
  assert.equal(h.reply, '#9 Q1 ?');
  const [none] = onHold({ every: [{ num: 8, id: '#8', title: 'y', status: 'on hold: waiting for the owner: the CI runner', questions: '' }] });
  assert.equal(none.reply, '#8 <your answer>');
});

test('the On hold tab: each ticket with what it waits for, its questions and the reply to copy; or nothing on hold', () => {
  const cmd = (c) => `<div class="cmd"><code>${c}</code></div>`;
  const html = renderHold(onHold({ every, drafts, catalogue }), { link: (n) => `https://gitlab.example.com/g/p/-/issues/${n}`, cmd });
  assert.match(html, /<article class="hold" id="hold-12"><h3><a href="https:\/\/gitlab\.example\.com\/g\/p\/-\/issues\/12" target="_blank" rel="noopener">#12<\/a> Reminders<\/h3><p class="dim">Waits for your answer · asked 2026-10-30 10:12<\/p>/);
  assert.match(html, /Where the check lives/);
  assert.doesNotMatch(html, /Answered for you|Decided by the planner/, 'only the questions its status names');
  assert.match(html, /<div class="cmd"><code>#12 Q1 b, Q2 a<\/code><\/div>/);
  assert.match(html, /<code>! forge limits lift 15<\/code>/);
  assert.match(html, /Waiting behind it: #13, T3, #20\./);
  assert.match(renderHold([], { cmd }), /<p class="empty">Nothing is on hold\.<\/p>/);
});

// A fake clock: sleep moves it on, and a prompt line can land in the timeline at a given minute.
function clock(start) {
  let t = start;
  return { now: () => t, sleep: async (ms) => { t += ms; }, at: () => t };
}
function project(minutes) {
  const { dir } = makeRepo();
  writeProjectConfig(dir, { policy: { ...DEFAULT_TEST_CONFIG, hold: { minutes } } });
  fs.mkdirSync(path.join(dir, '.forge', 'state'), { recursive: true });
  return dir;
}

test('forge wait-owner: at most 5 minutes a call, the hold after 10 in all, or the owner\'s answer as soon as it comes', async () => {
  const main = project(10);
  const config = { hold: { minutes: 10 } };
  const T0 = Date.parse('2026-10-30T10:00:00Z');
  const c = clock(T0);
  let said = [];
  const out = (s) => said.push(s);
  assert.equal(await waitOwner({ _: ['12'] }, { main, config, out, now: c.now, sleep: c.sleep }), 0);
  assert.match(said[0], /^WAITING: no answer on #12 yet \(5 of 10 minutes\)\. Run forge wait-owner 12 again\.$/);
  assert.equal(c.at() - T0, 5 * 60000, 'one call waits 5 minutes');
  said = [];
  await waitOwner({ _: ['12'] }, { main, config, out, now: c.now, sleep: c.sleep });
  assert.match(said[0], /^HOLD: no answer on #12 in 10 minutes\. Put it on hold: .*forge tracker status 12 "On hold".*does not depend on #12/);
  assert.equal(c.at() - T0, 10 * 60000, 'the second call goes on from the first');
  assert.ok(!fs.existsSync(path.join(main, '.forge', 'state', 'owner-wait.json')), 'the wait is over');

  // The owner writes 2 minutes into a new wait: the call returns then.
  const d = clock(T0 + 3600000);
  const file = path.join(main, '.forge', 'state', 'timeline-2026-10.jsonl');
  said = [];
  const sleep = async (ms) => {
    await d.sleep(ms);
    if (d.at() - (T0 + 3600000) >= 2 * 60000 && !fs.existsSync(file)) fs.writeFileSync(file, `${JSON.stringify({ at: new Date(d.at()).toISOString(), event: 'prompt', who: 'human', chars: 9 })}\n`);
  };
  await waitOwner({ _: ['#14'] }, { main, config, out, now: d.now, sleep });
  assert.match(said[0], /^ANSWERED: the owner wrote at \d\d:\d\d\. Read their message, record the answers .* carry on with it\.$/);
  assert.ok(d.at() - (T0 + 3600000) < 3 * 60000, 'within seconds of the answer');
});

test('forge wait-owner: 0 minutes holds at once; a ticket number is needed; policy.hold.minutes is checked', async () => {
  const main = project(0);
  const said = [];
  await waitOwner({ _: ['7'] }, { main, config: { hold: { minutes: 0 } }, out: (s) => said.push(s), now: () => 0, sleep: async () => { throw new Error('no wait'); } });
  assert.match(said[0], /^HOLD: no answer on #7 in 0 minutes/);
  await assert.rejects(waitOwner({ _: [] }, { main, config: { hold: { minutes: 10 } }, out: () => {} }), WaitError);
  const { loadConfig } = await import('../../core/policy/lib/config.mjs');
  assert.deepEqual(loadConfig(project(10), {}).config.hold, { minutes: 10 });
  const { dir } = makeRepo();
  writeProjectConfig(dir, { policy: { ...DEFAULT_TEST_CONFIG, hold: { minutes: -1 } } });
  assert.ok(loadConfig(dir, {}).errors.includes('policy.hold.minutes must be a whole number from 0 to 120'));
  const fresh = makeRepo().dir;
  writeProjectConfig(fresh, { policy: { ...DEFAULT_TEST_CONFIG } });
  assert.deepEqual(loadConfig(fresh, {}).config.hold, { minutes: 10 }, 'the default');
  void os;
});
