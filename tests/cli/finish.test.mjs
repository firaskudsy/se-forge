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

test('before any merge: the drafts\' estimates, a missing one at their median, and the release as one more ticket, at the pace', () => {
  const f = finish({ steps: steps(9), drafts: [{ t: 'T1', estimate: est(2, 4) }, { t: 'T2', estimate: est(4, 8) }, { t: 'T3', estimate: null }], timeline: timeline(), now: NOW });
  assert.deepEqual(f.work, { lo: 12 * H, hi: 24 * H }, 'tickets 2+4+3 and 4+8+6 hours, the release 3 to 6');
  near(f.pace, 5 * H, 'pace');
  near(f.lo, NOW + 2.4 * D, 'low: 12 h at 5 h a day');
  near(f.hi, NOW + 4.8 * D, 'high');
  near(f.at, NOW + 3.6 * D, 'between');
  assert.deepEqual(f.parts, ['3 tickets from their estimates, none merged yet to check them', 'the release']);
  // The dates in this Mac's time zone, as the page shows them.
  const [at, lo, hi] = [f.at, f.lo, f.hi].map((t) => finishDay(t, NOW));
  // The days left on average: 3.6, from 2.4 to 4.8.
  assert.equal(finishText(f, NOW).line, `around ${at} (${lo} – ${hi}), about 4 days left (2–5): 12 h–24 h of AI work, 3 tickets from their estimates, none merged yet to check them, the release; at 5.0 h of AI work a day over the last 4 days`);
  assert.deepEqual([finishText(f, NOW).value, finishText(f, NOW).more], [at, 'about 4 days left (2–5) · at 5.0 h a day']);
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
  assert.deepEqual(f.work, { lo: (8 - 2 + 8) * H, hi: (16 - 2 + 16) * H });
});

test('a merge no list matches takes the first draft: the build goes foundations first', () => {
  const all = [{ num: 5, from: NOW - 2 * D, mergedAt: NOW - D, estimate: null, split: null }];
  const f = finish({ steps: steps(9), all, drafts: [{ t: 'T1', estimate: est(10, 10) }, { t: 'T2', estimate: est(1, 2) }, { t: 'T3', estimate: est(1, 2) }], timeline: timeline(), now: NOW });
  assert.equal(f.parts[0], '2 tickets from their estimates, none merged yet to check them');
  assert.deepEqual(f.work, { lo: (1 + 1 + 1) * H, hi: (2 + 2 + 2) * H });
});

test('three merged: chart 2\'s forecast for the build, in calendar time, and the release as one more of its tickets', () => {
  const forecast = { remaining: 4, basis: 3, lo: 4 * D, mid: 6 * D, hi: 10 * D };
  const f = finish({ steps: steps(9), forecast, drafts: [{ t: 'T1', estimate: est(1, 2) }], timeline: timeline(), now: NOW });
  assert.deepEqual(f.parts, ['4 tickets at the pace of the 3 merged', 'the release']);
  near(f.at, NOW + 6 * D + 1.5 * D, 'the build\'s middle and a quarter of it');
  near(f.lo, NOW + 5.5 * D, 'low');
  near(f.hi, NOW + 11.5 * D, 'high');
  assert.equal(f.work, null, 'no hours of work: the forecast is in calendar time');
  assert.ok(finishText(f, NOW).line.startsWith(`around ${finishDay(f.at, NOW)} (${finishDay(f.lo, NOW)} – ${finishDay(f.hi, NOW)}), about 8 days left (6–12): 4 tickets at the pace of the 3 merged, the release; at 5.0 h`), finishText(f, NOW).line);
  assert.equal(finishText({ ...f, at: NOW + 0.3 * D, lo: NOW + 0.2 * D, hi: NOW + 0.4 * D }, NOW).more, 'less than a day left · at 5.0 h a day');
});

test('in the bootstrap: the steps left at the bootstrap\'s own pace so far', () => {
  // Setup is the current step: 8 steps behind it took 16 hours of work, so 2 hours a step.
  const f = finish({ steps: steps(8), drafts: [{ t: 'T1', estimate: est(1, 3) }], timeline: timeline(5, 16 * H), now: NOW });
  assert.deepEqual(f.parts, ['1 bootstrap step', '1 ticket from their estimates, none merged yet to check them', 'the release']);
  assert.deepEqual(f.work, { lo: (2 + 1 + 1) * H, hi: (2 + 3 + 3) * H });
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
