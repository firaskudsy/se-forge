// The stepper between the totals and the tabs (decision 143): every step in a row, and under it the current step's
// sub-steps, or in the build one row per ticket in flight; then what waits for you. The model is steps.mjs's.
import { esc } from './svg.mjs';

const MARK = { done: '✓', wait: '!', skip: '–' };
const STATE = { done: 'done', now: 'now', wait: 'waiting for you', todo: 'to do', skip: 'skipped' };
const subs = (list) => `<ol class="ss">${list.map((x) => `<li class="st-${x.state}" title="${esc(STATE[x.state])}"><i>${MARK[x.state] ?? ''}</i>${esc(x.label)}</li>`).join('')}</ol>`;

export function renderSteps(s) {
  if (!s?.steps.length) return '';
  const row = s.steps.map((x, i) => {
    const title = `${i + 1}. ${x.label}: ${STATE[x.state]}${x.summary ? ` · ${x.summary}` : ''}`;
    return `<li class="st-${x.state}"${i === s.current ? ' aria-current="step"' : ''} title="${esc(title)}"><i>${MARK[x.state] ?? i + 1}</i><span>${esc(x.label)}</span></li>`;
  }).join('');
  const c = s.current === null ? null : s.steps[s.current];
  const head = c ? `<p class="ss-h"><b>Step ${s.current + 1} of ${s.steps.length}: ${esc(c.label)}</b>${c.summary ? ` · ${esc(c.summary)}` : ''}</p>`
    : `<p class="ss-h"><b>All ${s.steps.length} steps done</b>${s.steps.at(-1).summary ? ` · ${esc(s.steps.at(-1).summary)}` : ''}</p>`;
  const shown = 4;
  const rows = c?.rows ? (c.rows.length ? c.rows.slice(0, shown).map((r) => `<div class="ss-row"><span class="ss-t" title="${esc(`#${r.num} ${r.title}`)}">#${r.num}${r.title ? ` ${esc(r.title)}` : ''}</span>${subs(r.subs)}</div>`).join('')
    + (c.rows.length > shown ? `<p class="dim">and ${c.rows.length - shown} more in flight: the Tickets tab has them all.</p>` : '') : '<p class="dim">No ticket in flight.</p>') : '';
  const body = c ? (c.subs.length ? subs(c.subs) : '') + rows : '';
  const wait = s.waiting.length ? `<p class="st-why"><b>Waiting for you:</b> ${s.waiting.map((w) => `${esc(w.step)}: ${esc(w.why)}`).join(' · ')}</p>` : '';
  return `<section class="stepper" aria-label="Where the project is"><ol class="stp">${row}</ol><div class="ss-box">${head}${body}</div>${wait}</section>`;
}
