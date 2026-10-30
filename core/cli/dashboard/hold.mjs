// The On hold tab (decision 147): every ticket that waits, so the owner can answer when they have time and the lead takes
// it back up. A ticket is on hold when its plan's status says so (on hold, waiting for the owner, blocked: decisions 127,
// 139 and 147) or the board's status is On hold or Blocked, and it is neither merged nor closed. For each: what it waits
// for, its plan's open questions (section 6), the reply to paste in the lead's session, and the tickets behind it (their
// Depends on: names it).
import { esc } from './svg.mjs';
import { renderMarkdown } from './markdown.mjs';

const HELD = /\bon hold\b|\bwaiting for the owner\b|\bblocked\b|\breached its limit\b/i;
const DRAFT = /\b(?:E\d+-)?T-?\d+[a-z]?\b/;

// The questions a status names ("waiting for the owner: Q4, Q6"), each with its recommended answer when the plan marks
// one ("Default: (b)", or the option written in bold first).
function questions(t) {
  const ids = [...new Set((/waiting for the owner:?([^()]*)/i.exec(t.status || '')?.[1] ?? '').match(/\bQ\d+\b/g) ?? [])];
  const text = t.questions || '';
  const blocks = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const q = /^\s*(?:[-*]\s+)?\**\s*(Q\d+)\b[.):]?/.exec(line);
    if (q) { cur = { id: q[1], lines: [line] }; blocks.push(cur); continue; }
    if (cur && (/^\s+\S/.test(line) || /^\s*\*\*Default/i.test(line))) cur.lines.push(line);
    else if (cur && line.trim() && !/^\s/.test(line)) cur = null;
  }
  const wanted = ids.length ? blocks.filter((b) => ids.includes(b.id)) : blocks;
  return {
    ids: ids.length ? ids : wanted.map((b) => b.id),
    blocks: wanted.map((b) => {
      const body = b.lines.join('\n');
      const pick = /Default:?\**\s*\(?([A-Za-z])\)?[.):\s]/.exec(body)?.[1] ?? /^\s*(?:[-*]\s+)?\*\*\(?([A-Da-d])[.)]/m.exec(body)?.[1] ?? null;
      return { id: b.id, text: body, pick: pick?.toLowerCase() ?? null };
    }),
  };
}

// every: the dashboard's ticket list; drafts and catalogue: the bootstrap's (projectData).
export function onHold({ every = [], drafts = [], catalogue = [] }) {
  const tOf = new Map(catalogue.map((c) => [c.num, c.t]));
  const numOf = new Map(catalogue.map((c) => [c.t, c.num]));
  return every.filter((t) => !t.mergedAt && !t.board?.closed && (HELD.test(t.status || '') || /^(on hold|blocked)$/i.test(t.board?.status || ''))).map((t) => {
    // What it waits for comes from the plan's status; a ticket put on hold on the board alone says so.
    const own = t.status || '';
    const status = own || `${t.board.status} on the board`;
    const limit = /\breached its limit\b/i.test(own) || (t.limit?.over?.length ?? 0) > 0;
    const on = /\bblocked on #(\d+)/i.exec(own)?.[1];
    const q = questions(t);
    const kind = limit ? 'limit' : /\bwaiting for the owner\b|\bon hold\b/i.test(own) ? 'owner' : on ? 'ticket' : 'board';
    const draft = tOf.get(t.num) ?? (DRAFT.exec(t.title || '')?.[0] ?? null);
    const behind = [
      ...drafts.filter((d) => draft && d.deps?.includes(draft)).map((d) => (numOf.has(d.t) ? `#${numOf.get(d.t)}` : d.t)),
      ...every.filter((x) => !x.mergedAt && new RegExp(`\\bblocked on #${t.num}\\b`, 'i').test(x.status || '')).map((x) => x.id),
    ];
    const reply = kind === 'limit' ? `! forge limits lift ${t.num}`
      : kind === 'owner' ? `#${t.num} ${q.ids.length ? q.ids.map((id) => `${id} ${q.blocks.find((b) => b.id === id)?.pick ?? '?'}`).join(', ') : '<your answer>'}` : null;
    return { num: t.num, id: t.id, title: t.title, status, since: /\(asked ([^)]+)\)/i.exec(status)?.[1] ?? null, kind, on: on ? Number(on) : null, plan: t.plan ?? null, questions: q.blocks, reply, behind: [...new Set(behind)] };
  }).sort((a, b) => a.num - b.num);
}

const WHAT = { owner: 'Waits for your answer', limit: 'Parked at its limit (decision 127)', ticket: 'Waits for another ticket', board: 'On hold on the board' };
export function renderHold(list, { link = () => null, cmd }) {
  const intro = '<p class="q">Tickets that wait. Answer when you have time: copy the reply, change any answer, and paste it in the lead\'s session; the lead records it, moves the ticket back to In Progress and takes it up when a lane is free. A <b>?</b> has no recommended answer: write yours.</p>';
  if (!list.length) return `<section class="card"><h2>On hold</h2>${intro}<p class="empty">Nothing is on hold.</p></section>`;
  const one = (h) => {
    const href = link(h.num);
    const name = `${href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(h.id)}</a>` : esc(h.id)}${h.title ? ` ${esc(h.title)}` : ''}`;
    const qs = h.questions.length ? `<div class="md">${renderMarkdown(h.questions.map((b) => b.text).join('\n\n'))}</div>` : h.kind === 'owner' ? `<p class="dim">The questions are in ${esc(h.plan ? `plans/${h.plan}` : 'its plan')}, section 6.</p>` : '';
    const reply = h.reply ? `<p class="hold-r">${h.kind === 'limit' ? 'To give it one more allowance, in the lead\'s session:' : 'Your reply, to paste in the lead\'s session:'}</p>${cmd(h.reply)}` : '';
    const behind = h.behind.length ? `<p class="dim">Waiting behind it: ${esc(h.behind.join(', '))}.</p>` : '';
    return `<article class="hold" id="hold-${h.num}"><h3>${name}</h3><p class="dim">${esc(WHAT[h.kind])}${h.since ? ` · asked ${esc(h.since)}` : ''}</p><p class="hold-s">${esc(h.status)}</p>${qs}${reply}${behind}</article>`;
  };
  return `<section class="card"><h2>On hold</h2>${intro}${list.map(one).join('')}</section>`;
}

// "#12 waits for your answer (Q4, Q6, asked 30 Oct 10:12) · #15 parked at its limit": forge dashboard --text.
export function holdText(list) {
  if (!list.length) return null;
  return `On hold: ${list.map((h) => `${h.id} ${h.kind === 'owner' ? `waits for your answer${h.questions.length || h.since ? ` (${[h.questions.map((b) => b.id).join(', '), h.since ? `asked ${h.since}` : ''].filter(Boolean).join(', ')})` : ''}` : h.kind === 'limit' ? 'is parked at its limit' : h.kind === 'ticket' ? `waits for #${h.on}` : 'is on hold on the board'}${h.behind.length ? `, ${h.behind.length} behind it` : ''}`).join(' · ')}.`;
}
