// The finish card (decision 145): how much AI work is left until every step is done, the release too, and when that
// lands on the calendar at the project's own pace. The work left:
// - the bootstrap's steps still to do, at the bootstrap's pace so far (its working time over the steps behind it);
// - the build's tickets not merged: with 3 merged, at the merged ones' working time per ticket (quartiles), and on the
//   calendar chart 2's forecast (each ticket at its area's quartiles of the merged ones' time, one after the other);
//   before, the drafts' estimates (a planned ticket's own), less the work the open ones have had, corrected by the
//   merged ones' working time over their estimates when one or two have merged, and until then by what the agents
//   took in earlier projects (PRIOR). A draft is matched to its issue by tickets-created.md; a merge it cannot match
//   takes the first unmatched draft, since the build goes foundations first;
// - the release, as one more ticket.
// The card leads with that work as days around the clock: what the agents themselves need. Hours of work become
// calendar days at the pace of the last 14 days, the AI's working time a calendar day, which holds the nights, the
// weekends and the waits for you as they have been.
import { day } from './format.mjs';

const H = 3600000;
const DAY = 24 * H;
const WINDOW = 14;
// What agents take against the planners' estimates before a project has merged its own: lunch-pool's 23 merged
// tickets took 0.40 of their estimates' middle in working time (median 0.37, from 0.20 to 1.30).
const PRIOR = 0.4;
const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return 0;
  const i = (s.length - 1) * q;
  return s[Math.floor(i)] + (s[Math.ceil(i)] - s[Math.floor(i)]) * (i - Math.floor(i));
};
const median = (xs) => quantile(xs, 0.5);
// A ticket's working time: its time without the waits for you and the silences.
const working = (t) => (t?.split ? Math.max(0, t.split.total - t.split.waiting - t.split.idle) : 0);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// steps: projectSteps; all: ticketSummaries; drafts and catalogue: the bootstrap's (projectData); forecast: progress's,
// or null; timeline: projectTimeline over the whole project. { done } when every step is done; { reason } when it
// cannot tell.
export function finish({ steps, all = [], drafts = [], catalogue = [], forecast = null, timeline = null, now = Date.now() }) {
  if (!steps?.steps.length) return null;
  if (steps.current === null) return { done: true };
  const since = Math.max(now - WINDOW * DAY, timeline?.from ?? now);
  const days = Math.max(1, (now - since) / DAY);
  const pace = (timeline?.days ?? []).filter((d) => d.day + DAY > since).reduce((s, d) => s + d.ai, 0) / days;
  if (!(pace > 0)) return { reason: `no AI work in the last ${WINDOW} days to take the pace from` };
  const at = steps.current;
  const buildAt = steps.steps.findIndex((s) => s.key === 'build');
  const releaseAt = steps.steps.findIndex((s) => s.key === 'release');
  // Each part: { what, work: { lo, hi } in hours of AI work, cal: { lo, mid, hi } in calendar time when it has its own }.
  const parts = [];
  if (buildAt > 0 && at < buildAt && at > 0 && timeline?.working) {
    const per = (timeline.working / at) * (buildAt - at);
    parts.push({ what: plural(buildAt - at, 'bootstrap step'), work: { lo: per, hi: per } });
  }
  const merged = all.filter((t) => t.mergedAt);
  const over = (t) => Boolean(t?.mergedAt || t?.board?.closed);
  const byNum = new Map(all.map((t) => [t.num, t]));
  const numOf = new Map(catalogue.map((c) => [c.t, c.num]));
  let left;
  if (drafts.length) {
    let unmatched = all.filter((t) => over(t) && !catalogue.some((c) => c.num === t.num)).length;
    left = drafts.filter((d) => (numOf.has(d.t) ? !over(byNum.get(numOf.get(d.t))) : unmatched-- <= 0))
      .map((d) => ({ estimate: byNum.get(numOf.get(d.t))?.estimate ?? d.estimate }));
  } else {
    left = (catalogue.length ? catalogue : all).filter((c) => !over(byNum.get(c.num))).map((c) => ({ estimate: byNum.get(c.num)?.estimate ?? c.estimate ?? null }));
  }
  let ticket = null;
  if (at <= buildAt && forecast?.remaining) {
    const took = merged.map(working).filter((w) => w > 0);
    const n = forecast.remaining;
    parts.push({ what: `${plural(n, 'ticket')} at the pace of the ${forecast.basis} merged`, work: { lo: quantile(took, 0.25) * n, hi: quantile(took, 0.75) * n }, cal: { lo: forecast.lo, mid: forecast.mid, hi: forecast.hi } });
    ticket = { work: { lo: median(took), hi: median(took) }, cal: { lo: forecast.mid / n, mid: forecast.mid / n, hi: forecast.mid / n } };
  } else if (at <= buildAt && left.length) {
    const known = left.map((c) => c.estimate).filter(Boolean);
    if (!known.length) return { reason: 'the tickets have no estimates, and fewer than 3 are merged' };
    const fill = { low: median(known.map((e) => e.low)), high: median(known.map((e) => e.high)) };
    const checked = merged.filter((t) => t.estimate && working(t) > 0);
    const ratio = checked.length ? checked.reduce((s, t) => s + working(t), 0) / checked.reduce((s, t) => s + ((t.estimate.low + t.estimate.high) / 2) * H, 0) : PRIOR;
    // The work the open tickets have had comes off the total.
    const used = all.filter((t) => t.from !== null && !over(t)).reduce((s, t) => s + working(t), 0);
    const sum = (k) => left.reduce((s, c) => s + (c.estimate ?? fill)[k] * H * ratio, 0);
    const how = checked.length ? `, ×${ratio.toFixed(2)} as the ${checked.length} merged took` : `, ×${PRIOR.toFixed(2)} as agents took in earlier projects`;
    parts.push({ what: `${plural(left.length, 'ticket')} from their estimates${how}`, work: { lo: Math.max(0, sum('low') - used), hi: Math.max(0, sum('high') - used) } });
    ticket = { work: { lo: fill.low * H * ratio, hi: fill.high * H * ratio } };
  }
  if (releaseAt >= 0 && at <= releaseAt) {
    // The release is one more ticket's work; with no ticket to take it from, the merged ones' median.
    const one = ticket ?? (merged.length ? { work: { lo: median(merged.map(working)), hi: median(merged.map(working)) } } : null);
    if (one) parts.push({ what: 'the release', ...one });
  }
  const cal = (p) => p.cal ?? { lo: (p.work.lo / pace) * DAY, hi: (p.work.hi / pace) * DAY, mid: ((p.work.lo + p.work.hi) / 2 / pace) * DAY };
  const sum = (k) => parts.reduce((s, p) => s + cal(p)[k], 0);
  return {
    work: { lo: parts.reduce((s, p) => s + p.work.lo, 0), hi: parts.reduce((s, p) => s + p.work.hi, 0) },
    at: now + sum('mid'), lo: now + sum('lo'), hi: now + sum('hi'), pace, window: Math.round(days),
    parts: parts.map((p) => p.what),
  };
}

// "14 Feb", with the year when it is not this year's.
export function finishDay(t, now = Date.now()) {
  const y = new Date(t).getFullYear();
  return y === new Date(now).getFullYear() ? day(t) : `${day(t)} ${y}`;
}

const hours = (ms) => `${Math.round(ms / H)} h`;
const days = (ms) => Math.max(1, Math.round(ms / DAY));
// "about 27 days", "under a day": a length of time from its middle.
const about = (ms) => (ms < DAY / 2 ? 'under a day' : `about ${plural(Math.round(ms / DAY), 'day')}`);
// The card's value, its small line and its hint; forge dashboard --text prints the same words.
export function finishText(f, now = Date.now()) {
  if (!f) return null;
  if (f.done) return { value: 'done', more: 'every step, the release too', line: 'every step is done, the release too' };
  if (f.reason) return { value: 'not yet', more: f.reason, line: `not yet: ${f.reason}` };
  // The agents' own time: the hours of work around the clock.
  const span = days(f.work.hi) > days(f.work.lo) ? `${days(f.work.lo)}–${days(f.work.hi)} days` : plural(days(f.work.lo), 'day');
  const ai = about((f.work.lo + f.work.hi) / 2);
  const hoursOf = f.work.lo === f.work.hi ? hours(f.work.lo) : `${hours(f.work.lo)}–${hours(f.work.hi)}`;
  // On the calendar, at the pace: the date, its range and the days left.
  const range = `${finishDay(f.lo, now)} – ${finishDay(f.hi, now)}`;
  const [lo, hi] = [f.lo, f.hi].map((t) => Math.round((t - now) / DAY));
  const left = `${about(f.at - now)} left${hi > lo ? ` (${lo}–${hi})` : ''}`;
  const pace = (f.pace / H).toFixed(1);
  return {
    value: ai,
    more: `${span} nonstop · on the calendar ${finishDay(f.at, now)}, at ${pace} h a day`,
    line: `${ai} of AI work left, nonstop (${span}): ${hoursOf} of AI work, ${f.parts.join(', ')}; on the calendar around ${finishDay(f.at, now)} (${range}), ${left}, at ${pace} h of AI work a day over the last ${plural(f.window, 'day')}`,
  };
}
