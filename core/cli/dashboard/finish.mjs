// The finish card (decision 145): when the app could be done, every step up to the release, from the work left and
// the project's own pace. The work left:
// - the bootstrap's steps still to do, at the bootstrap's pace so far (its working time over the steps behind it);
// - the build's tickets not merged: with 3 merged, chart 2's forecast (each ticket at its area's quartiles of the merged
//   ones' time, one after the other); before, the drafts' estimates (a planned ticket's own), less the work the open
//   ones have had, corrected by the merged ones' working time over their estimates when one or two have merged. A
//   draft is matched to its issue by tickets-created.md; a merge it cannot match takes the first unmatched draft,
//   since the build goes foundations first;
// - the release, as one more ticket.
// Hours of work become days at the pace of the last 14 days: the AI's working time a calendar day, which holds the
// nights, the weekends and the waits for you as they have been.
import { day } from './format.mjs';

const H = 3600000;
const DAY = 24 * H;
const WINDOW = 14;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return !n ? 0 : n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};
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
  // Each part as { what, lo, hi } in hours of AI work (work: true) or in calendar time.
  const parts = [];
  if (buildAt > 0 && at < buildAt && at > 0 && timeline?.working) {
    const per = timeline.working / at;
    parts.push({ what: plural(buildAt - at, 'bootstrap step'), lo: per * (buildAt - at), hi: per * (buildAt - at), work: true });
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
    parts.push({ what: `${plural(forecast.remaining, 'ticket')} at the pace of the ${forecast.basis} merged`, lo: forecast.lo, mid: forecast.mid, hi: forecast.hi });
    ticket = { lo: forecast.mid / forecast.remaining, hi: forecast.mid / forecast.remaining };
  } else if (at <= buildAt && left.length) {
    const known = left.map((c) => c.estimate).filter(Boolean);
    if (!known.length) return { reason: 'the tickets have no estimates, and fewer than 3 are merged' };
    const fill = { low: median(known.map((e) => e.low)), high: median(known.map((e) => e.high)) };
    const checked = merged.filter((t) => t.estimate && working(t) > 0);
    const ratio = checked.length ? checked.reduce((s, t) => s + working(t), 0) / checked.reduce((s, t) => s + ((t.estimate.low + t.estimate.high) / 2) * H, 0) : 1;
    // The work the open tickets have had comes off the total.
    const used = all.filter((t) => t.from !== null && !over(t)).reduce((s, t) => s + working(t), 0);
    const sum = (k) => left.reduce((s, c) => s + (c.estimate ?? fill)[k] * H * ratio, 0);
    const how = checked.length ? `, ×${ratio.toFixed(2)} as the ${checked.length} merged took` : ', none merged yet to check them';
    parts.push({ what: `${plural(left.length, 'ticket')} from their estimates${how}`, lo: Math.max(0, sum('low') - used), hi: Math.max(0, sum('high') - used), work: true });
    ticket = { lo: fill.low * H * ratio, hi: fill.high * H * ratio, work: true };
  }
  if (releaseAt >= 0 && at <= releaseAt) {
    // The release is one more ticket's work; with no ticket to take it from, the median estimate's.
    const one = ticket ?? (merged.length ? { lo: median(merged.map(working)), hi: median(merged.map(working)), work: true } : null);
    if (one) parts.push({ what: 'the release', ...one });
  }
  const cal = (p, k) => (p.work ? (p[k] / pace) * DAY : p[k]);
  const lo = parts.reduce((s, p) => s + cal(p, 'lo'), 0);
  const hi = parts.reduce((s, p) => s + cal(p, 'hi'), 0);
  const mid = parts.reduce((s, p) => s + (p.mid !== undefined ? p.mid : (cal(p, 'lo') + cal(p, 'hi')) / 2), 0);
  const work = parts.filter((p) => p.work);
  return {
    at: now + mid, lo: now + lo, hi: now + hi, pace, window: Math.round(days),
    work: work.length ? { lo: work.reduce((s, p) => s + p.lo, 0), hi: work.reduce((s, p) => s + p.hi, 0) } : null,
    parts: parts.map((p) => p.what),
  };
}

// "14 Feb", with the year when it is not this year's.
export function finishDay(t, now = Date.now()) {
  const y = new Date(t).getFullYear();
  return y === new Date(now).getFullYear() ? day(t) : `${day(t)} ${y}`;
}

const hours = (ms) => `${Math.round(ms / H)} h`;
// The card's value, its small line and its hint; forge dashboard --text prints the same words.
export function finishText(f, now = Date.now()) {
  if (!f) return null;
  if (f.done) return { value: 'done', more: 'every step, the release too', line: 'every step is done, the release too' };
  if (f.reason) return { value: 'not yet', more: f.reason, line: `not yet: ${f.reason}` };
  const range = `${finishDay(f.lo, now)} – ${finishDay(f.hi, now)}`;
  // The calendar days left: the middle of the estimate, and its low and high.
  const [mid, lo, hi] = [f.at, f.lo, f.hi].map((t) => Math.round((t - now) / DAY));
  const left = mid < 1 ? 'less than a day left' : `about ${plural(mid, 'day')} left${hi > lo ? ` (${lo}–${hi})` : ''}`;
  const work = f.work ? `${f.work.lo === f.work.hi ? hours(f.work.lo) : `${hours(f.work.lo)}–${hours(f.work.hi)}`} of AI work, ` : '';
  const pace = `${(f.pace / H).toFixed(1)} h of AI work a day over the last ${plural(f.window, 'day')}`;
  return {
    value: finishDay(f.at, now),
    more: `${left} · at ${(f.pace / H).toFixed(1)} h a day`,
    line: `around ${finishDay(f.at, now)} (${range}), ${left}: ${work}${f.parts.join(', ')}; at ${pace}`,
  };
}
