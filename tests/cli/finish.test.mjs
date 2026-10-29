// The dashboard's finish card (decision 145): when every step could be done, the release too, from the work left and
// the project's own pace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finish, finishText, finishDay } from '../../core/cli/dashboard/finish.mjs';

const H = 3600000;
const D = 24 * H;
const NOW = Date.parse('2026-10-29T12:00:00Z');
const KEYS = ['discovery', 'stories', 'architecture', 'screens', 'contract', 'tickets', 'panel', 'review', 'setup', 'build', 'release'];
const steps = (current) => ({ steps: KEYS.map((key) => ({ key })), current });
// Four days of 5 hours of AI work each: a pace of 5 hours a day.
const timeline = (aiHours = 5, working = 20 * H) => ({ from: NOW - 4 * D, working, days: [4, 3, 2, 1].map((k) => ({ day: NOW - k * D, ai: aiHours * H })) });
const est = (low, high) => ({ low, high });
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1000, `${what}: ${a} vs ${b}`);

test('before any merge: the drafts\' estimates at what agents took in earlier projects, a missing one at their median, and the release as one more ticket, at the pace', () => {
  const f = finish({ steps: steps(9), drafts: [{ t: 'T1', estimate: est(20, 40) }, { t: 'T2', estimate: est(40, 80) }, { t: 'T3', estimate: null }], timeline: timeline(), now: NOW });
  // Tickets 20+40+30 and 40+80+60 hours, the release 30 to 60, all at 0.40.
  near(f.work.lo, 48 * H, 'low work');
  near(f.work.hi, 96 * H, 'high work');
  near(f.pace, 5 * H, 'pace');
  near(f.lo, NOW + 9.6 * D, 'low: 48 h at 5 h a day');
  near(f.hi, NOW + 19.2 * D, 'high');
  near(f.at, NOW + 14.4 * D, 'between');
  assert.deepEqual(f.parts, ['3 tickets from their estimates, ×0.40 as agents took in earlier projects', 'the release']);
  // The card leads with the agents' own time: 48 to 96 hours of work around the clock, 3 days in the middle. Then the
  // calendar, in this Mac's time zone as the page shows it: 14.4 days left, from 9.6 to 19.2.
  const [at, lo, hi] = [f.at, f.lo, f.hi].map((t) => finishDay(t, NOW));
  assert.equal(finishText(f, NOW).line, `about 3 days of AI work left, nonstop (2–4 days): 48 h–96 h of AI work, 3 tickets from their estimates, ×0.40 as agents took in earlier projects, the release; on the calendar around ${at} (${lo} – ${hi}), about 14 days left (10–19), at 5.0 h of AI work a day over the last 4 days`);
  assert.deepEqual([finishText(f, NOW).value, finishText(f, NOW).more], ['about 3 days', `2–4 days nonstop · on the calendar ${at}, at 5.0 h a day`]);
});

test('one or two merged: the rest corrected by how long they took against their estimates; an open ticket\'s work comes off', () => {
  // #10 (T1, 2-4 h) took 6 hours of work (9 h less 1 waiting for the owner and 2 of silence): twice its estimate.
  const all = [
    { num: 10, from: NOW - 3 * D, mergedAt: NOW - 2 * D, estimate: est(2, 4), split: { total: 9 * H, waiting: 1 * H, idle: 2 * H } },
    { num: 11, from: NOW - D, mergedAt: null, estimate: est(4, 8), split: { total: 2 * H, waiting: 0, idle: 0 } },
  ];
  const catalogue = [{ t: 'T1', num: 10 }, { t: 'T2', num: 11 }];
  const f = finish({ steps: steps(9), all, catalogue, drafts: [{ t: 'T1', estimate: est(2, 4) }, { t: 'T2', estimate: est(3, 5) }], timeline: timeline(), now: NOW });
  assert.equal(f.parts[0], '1 ticket from their estimates, ×2.00 as the 1 merged took');
  // T2 at its plan's 4-8 h, twice, less the 2 hours #11 has had; the release at the same 8-16 h.
  near(f.work.lo, (8 - 2 + 8) * H, 'low');
  near(f.work.hi, (16 - 2 + 16) * H, 'high');
});

test('a merge no list matches takes the first draft: the build goes foundations first', () => {
  const all = [{ num: 5, from: NOW - 2 * D, mergedAt: NOW - D, estimate: null, split: null }];
  const f = finish({ steps: steps(9), all, drafts: [{ t: 'T1', estimate: est(10, 10) }, { t: 'T2', estimate: est(1, 2) }, { t: 'T3', estimate: est(1, 2) }], timeline: timeline(), now: NOW });
  assert.equal(f.parts[0], '2 tickets from their estimates, ×0.40 as agents took in earlier projects');
  near(f.work.lo, (1 + 1 + 1) * 0.4 * H, 'low');
  near(f.work.hi, (2 + 2 + 2) * 0.4 * H, 'high');
});

test('three merged: the work at their working time per ticket, the calendar at chart 2\'s forecast, the release as one more ticket', () => {
  const forecast = { remaining: 4, basis: 3, lo: 4 * D, mid: 6 * D, hi: 10 * D };
  const all = [1, 2, 3].map((h, k) => ({ num: k + 1, from: NOW - 3 * D, mergedAt: NOW - D, estimate: null, split: { total: h * H, waiting: 0, idle: 0 } }));
  const f = finish({ steps: steps(9), all, forecast, drafts: [{ t: 'T1', estimate: est(1, 2) }], timeline: timeline(), now: NOW });
  assert.deepEqual(f.parts, ['4 tickets at the pace of the 3 merged', 'the release']);
  near(f.at, NOW + 6 * D + 1.5 * D, 'the build\'s middle and a quarter of it');
  near(f.lo, NOW + 5.5 * D, 'low');
  near(f.hi, NOW + 11.5 * D, 'high');
  // Their working times 1, 2 and 3 hours: 4 tickets at 1.5 to 2.5 each, and the release at 2.
  near(f.work.lo, 8 * H, 'low work');
  near(f.work.hi, 12 * H, 'high work');
  assert.equal(finishText(f, NOW).line, `under a day of AI work left, nonstop (1 day): 8 h–12 h of AI work, 4 tickets at the pace of the 3 merged, the release; on the calendar around ${finishDay(f.at, NOW)} (${finishDay(f.lo, NOW)} – ${finishDay(f.hi, NOW)}), about 8 days left (6–12), at 5.0 h of AI work a day over the last 4 days`);
});

test('in the bootstrap: the steps left at the bootstrap\'s own pace so far', () => {
  // Setup is the current step: 8 steps behind it took 16 hours of work, so 2 hours a step.
  const f = finish({ steps: steps(8), drafts: [{ t: 'T1', estimate: est(1, 3) }], timeline: timeline(5, 16 * H), now: NOW });
  assert.deepEqual(f.parts, ['1 bootstrap step', '1 ticket from their estimates, ×0.40 as agents took in earlier projects', 'the release']);
  near(f.work.lo, (2 + 0.4 + 0.4) * H, 'low');
  near(f.work.hi, (2 + 1.2 + 1.2) * H, 'high');
});

test('every step done; or no pace, or nothing to estimate from: it says why', () => {
  assert.deepEqual(finish({ steps: steps(null), now: NOW }), { done: true });
  assert.deepEqual(finishText({ done: true }), { value: 'done', more: 'every step, the release too', line: 'every step is done, the release too' });
  const idle = finish({ steps: steps(9), drafts: [{ t: 'T1', estimate: est(1, 2) }], timeline: timeline(0), now: NOW });
  assert.deepEqual(idle, { reason: 'no AI work in the last 14 days to take the pace from' });
  assert.equal(finishText(idle).line, 'not yet: no AI work in the last 14 days to take the pace from');
  assert.deepEqual(finish({ steps: steps(9), drafts: [{ t: 'T1', estimate: null }], timeline: timeline(), now: NOW }), { reason: 'the tickets have no estimates, and fewer than 3 are merged' });
  assert.equal(finish({ steps: { steps: [], current: 0 }, now: NOW }), null);
});

test('the date names its year when it is not this one', () => {
  assert.equal(finishDay(Date.parse('2026-11-14T12:00:00Z'), NOW), '14 Nov');
  assert.equal(finishDay(Date.parse('2027-02-03T12:00:00Z'), NOW), '03 Feb 2027');
});
