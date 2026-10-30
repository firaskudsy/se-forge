// forge dashboard --text (decision 113): the dashboard's numbers as plain text, for the lead's progress report
// (skill progress-report) and for a terminal. It reads the same model as the page, so the report and the page
// agree, and it writes no file.
import { totals, splitText, kitText, dollars, range, pct } from './page.mjs';
import { SILENT_MS, WAIT_KINDS, agentCount } from './measures.mjs';
import { day, when } from './format.mjs';
import { countsText } from './issues.mjs';
import { stepsText } from './steps.mjs';
import { finishText } from './finish.mjs';
import { holdText } from './hold.mjs';
import { duration } from '../timeline.mjs';
import { fmt } from '../metrics.mjs';

const H = 3600000;
const MERGED_SHOWN = 10;
const WAITS_SHOWN = 5;
const KIND = Object.fromEntries(WAIT_KINDS.map(([k, label]) => [k, label]));
const SPLIT = [['agents', 'agents'], ['gates', 'gates'], ['waiting', 'you'], ['lead', 'lead'], ['idle', 'nobody']];

const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : s);
// A plan's heading often ends with its own id ("… (#19)"); the line starts with it already.
const name = (t) => { const title = (t.title || '').replace(new RegExp(`\\s*\\(${t.id}\\)$`), ''); return `${t.id}${t.repo ? ` [${t.repo}]` : ''}${title ? ` ${cut(title, 80)}` : ''}`; };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const rounds = (t) => {
  const n = t.rework?.rounds ?? t.rounds.length;
  const b = t.rounds.filter((r) => r.blocker).length;
  return n ? `${plural(n, 'review round')}${b ? `, ${b} with blockers` : ''}` : '';
};
const time = (t, open) => {
  if (!t.split) return '';
  const parts = SPLIT.filter(([k]) => t.split[k] >= 60000).map(([k, l]) => `${l} ${duration(t.split[k])}`);
  return `${duration(t.split.total)}${open ? ' so far' : ''}${parts.length ? ` (${parts.join(', ')})` : ''}`;
};
const spend = (t, money) => (!t.tokens?.total ? '' : money ? dollars(t.tokens.cost || 0) : `${fmt(t.tokens.total)} tokens`);
const line = (t, money, first) => `- ${[name(t), first, t.estimate ? `est ${range(t.estimate)}` : '', time(t, !t.mergedAt), rounds(t), t.lines?.length && agentCount(t) ? plural(agentCount(t), 'agent') : '', spend(t, money)].filter(Boolean).join(' · ')}`;

// What the lead should look at now: open tickets only, from the pipeline's own rules and the records.
export function flags(m) {
  const out = [];
  const open = m.tickets.filter((t) => t.from !== null && !t.mergedAt);
  for (const t of open) {
    // At its limit (decision 127): the hook refuses its next engineer lane, and a person decides.
    if (t.limit?.over.length) out.push(`${t.id}: at its limit (${t.limit.over.join(', ')}): parked until a person lifts it with forge limits lift ${t.num}.`);
    else {
      const blockers = t.rounds.filter((r) => r.blocker).length;
      if (blockers >= 2) out.push(`${t.id}: ${blockers} review rounds with blockers; the pipeline asks the owner after two rounds.`);
    }
    if (t.estimate && t.split && t.split.total > t.estimate.high * H) out.push(`${t.id}: ${duration(t.split.total)} so far, past its estimate (${range(t.estimate)}).`);
    // A plan blocked on an issue, or with questions asked and not answered yet (decision 139): a person is needed.
    if (/\bblocked\b|\bwaiting for the owner\b|\bon hold\b/i.test(t.status || '')) out.push(`${t.id}: ${cut(t.status, 160)}`);
  }
  const merged = new Set(m.all.filter((t) => t.mergedAt).map((t) => t.num));
  for (const g of m.data.gatesFailed || []) {
    if (g.ticket !== null && merged.has(g.ticket)) continue;
    if (m.only && !m.only.includes(g.ticket)) continue;
    out.push(`${g.branch}: GATES-FAILED (${g.agent}, ${when(g.at)}): ${g.reason}`);
  }
  const last = m.lines.at(-1);
  const quiet = last ? m.now - Date.parse(last.at) : 0;
  if (open.length && quiet >= SILENT_MS) out.push(`Nothing has happened for ${duration(quiet)} while ${open.length} ticket${open.length === 1 ? ' is' : 's are'} open: nobody is working.`);
  return out;
}

export function renderText(m, { project }) {
  const p = m.progress;
  const sums = totals(m);
  const money = m.money;
  const fc = p.forecast;
  const out = [`${project}: progress on ${when(m.now)}${Number.isFinite(m.since) ? `, from ${when(m.since)}` : ''}${m.only ? `, tickets ${m.only.map((n) => `#${n}`).join(' ')}` : ''}`];
  if (kitText(m.kit)) out.push(`Kit: ${kitText(m.kit)}.`);
  if (m.repoLinks?.length) out.push(`Repos: ${m.repoLinks.map((l) => `${l.label} ${l.url}`).join(' · ')}`);
  // Where the project is, and what waits for you (decision 143): the stepper above the page's tabs.
  out.push(...stepsText(m.steps));
  // Every ticket that waits (decision 147): the page's On hold tab.
  if (holdText(m.hold ?? [])) out.push(holdText(m.hold));
  out.push('');

  out.push(`Tickets merged: ${p.ticketsDone.length} of ${p.totalTickets} · stories done: ${p.totalStories ? `${p.storiesDone.length} of ${p.totalStories}` : 'no story list'}`);
  out.push(`Working time: ${duration(sums.working)} · waiting for you: ${duration(sums.waiting)}`);
  const parts = (of) => (splitText(sums, of, ' + ') ? ` = ${splitText(sums, of, ' + ')}` : '');
  out.push(`Tokens: ${fmt(sums.tokens)}${parts('tokens')} · API cost: ${money ? `${dollars(sums.cost)}${parts('cost')}` : 'no prices set'} · Opus share of ${money ? 'cost' : 'tokens'}: ${pct(sums.opusShare)} · agents: ${sums.agents}`);
  // Decision 137: how many agents had a skill to work from, preloaded or opened itself.
  const sk = m.skills;
  if (sk?.runs.length) out.push(`Skills: ${sk.runs.filter((r) => r.preloaded.length || r.loaded.size).length} of ${sk.runs.length} agents had one (${sk.skills.reduce((x, k) => x + k.loads, 0)} opened, ${sk.skills.reduce((x, k) => x + k.preloads, 0)} preloaded); ${sk.skills.length}${sk.available ? ` of ${sk.available}` : ''} skills used.`);
  const timed = m.all.filter((t) => t.from !== null);
  out.push(fc
    ? `Forecast: ${fc.remaining} tickets left. At the pace of the ${fc.basis} merged so far, one after the other: done around ${day(fc.doneMid)} (from ${day(fc.doneLo)} to ${day(fc.doneHi)}), about ${fmt(fc.tokensMid)} tokens${money ? ` and ${dollars(fc.costMid)} (${dollars(fc.costLo)}–${dollars(fc.costHi)})` : ''}.`
    : `Forecast: too early, it needs at least 3 merged tickets with a timeline (${timed.filter((t) => t.mergedAt).length} so far).`);
  // When every step could be done, the release too (decision 145): the page's Finish card.
  if (finishText(m.finish, m.now)) out.push(`Finish: ${finishText(m.finish, m.now).line}.`);
  if (m.data.catalogue.length) {
    const added = m.every.filter((t) => !t.t);
    out.push(`Scope: ${m.data.catalogue.length} tickets from the bootstrap${added.length ? `; ${added.length} added since (${added.map((t) => t.id).join(' ')})` : ''}.`);
  }
  const iq = m.issues;
  if (iq) {
    const epics = iq.epics ? `; ${iq.epics === 1 ? 'the epic' : `${iq.epics} epics`} not counted` : '';
    out.push(!iq.points.length ? `Issues: no history (${iq.error ? `${iq.host} could not be read: ${iq.error}` : iq.readAt ? 'the tracker has no issues yet' : 'not read yet; run forge dashboard without --offline'}).`
      : iq.error ? `Issues: ${iq.host} could not be read now (${iq.error}); at the last read, ${when(iq.readAt)}: ${countsText(iq.now)}${epics}.`
        : `Issues: ${countsText(iq.now)} (${iq.host}, read ${when(iq.readAt)}${epics}${iq.behind ? `; ${iq.behind}` : ''}).`);
  }
  const last = m.lines.at(-1);
  if (last) out.push(`Last activity: ${when(Date.parse(last.at))} (${duration(m.now - Date.parse(last.at))} ago).`);

  const open = m.tickets.filter((t) => t.from !== null && !t.mergedAt);
  out.push('', `Open (${open.length}):`, ...(open.length ? open.map((t) => line(t, money, cut(t.status || '', 160))) : ['- none']));
  // Every ticket nobody has picked yet: the bootstrap's and the board's (decision 135).
  const waiting = m.table.filter((t) => t.from === null && !t.mergedAt && !t.board?.closed);
  if (waiting.length) out.push('', `Not started (${waiting.length}): ${waiting.map(name).join(', ')}`);
  const merged = m.tickets.filter((t) => t.mergedAt).sort((a, b) => b.mergedAt - a.mergedAt);
  out.push('', `Merged (${merged.length}), newest first:`, ...(merged.length ? merged.slice(0, MERGED_SHOWN).map((t) => line(t, money, `merged ${when(t.mergedAt)}`)) : ['- none']));
  if (merged.length > MERGED_SHOWN) out.push(`- and ${merged.length - MERGED_SHOWN} earlier: ${merged.slice(MERGED_SHOWN).map((t) => t.id).join(' ')}`);

  const look = flags(m);
  out.push('', 'Look at:', ...(look.length ? look.map((f) => `- ${f}`) : ['- nothing']));

  const waits = (m.timeline?.waits || []).slice().sort((a, b) => b.ms - a.ms);
  if (waits.length) {
    const running = (at) => timed.filter((t) => at >= t.from && at <= t.to).map((t) => t.id).join(' ') || 'no ticket';
    out.push('', `Longest waits for you (${Math.min(WAITS_SHOWN, waits.length)} of ${waits.length}):`, ...waits.slice(0, WAITS_SHOWN).map((w) => `- ${duration(w.ms)} · ${[KIND[w.kind] || w.kind, running(w.at), w.what?.toLowerCase() === (KIND[w.kind] || '').toLowerCase() ? '' : w.what, when(w.at)].filter(Boolean).join(' · ')}`));
  }
  return `${out.join('\n')}\n`;
}
