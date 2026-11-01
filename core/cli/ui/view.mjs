// forge ui's screen (decision 153), drawn from its state and nothing else, so tests read it without a terminal: the
// header, the tickets on the left, the selected ticket (or a command's output, a plan, a handover) on the right, a
// status line, and the function keys; the Commands menu, a command's form and its confirmation open over them.
import { frame, put, box, fit, width } from './screen.mjs';
import { GROUPS } from '../commands.mjs';
import { titleOf } from './data.mjs';
import { needText } from '../dashboard/needs.mjs';
import { clock } from '../dashboard/format.mjs';

export const KEYS = [['1', 'Help'], ['2', 'Commands'], ['3', 'Plan'], ['4', 'Handover'], ['5', 'Refresh'], ['6', 'Approve'], ['7', 'Lift'], ['8', 'Export'], ['9', 'Dashboard'], ['10', 'Quit']];
export const NARROW = 80;

export function wrap(text, w) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && line.length + 1 + word.length > w) { out.push(line); line = ''; }
      line = line ? `${line} ${word}` : word;
    }
    out.push(line);
  }
  return out;
}

// The list's rows: the project, then each ticket with its mark, number, title and state.
function itemRow(it, w) {
  if (it.kind === 'project') return [['◆ ', 'cyan'], ['The project: steps, numbers, what to look at', 'bold']];
  const state = ` ${it.state}`;
  const name = `${it.t.id} ${titleOf(it.t)}`.trim();
  return [[`${it.mark} `, it.style], ...fit(name, Math.max(4, w - 2 - width(state))), [state, it.style]];
}

// The menu's rows: a heading per group, then its commands; entry is the index into the entries for a command's row.
export function menuRows(entries) {
  const rows = [];
  for (const [g, label] of GROUPS) {
    const mine = entries.map((e, i) => [e, i]).filter(([e]) => e.group === g);
    if (!mine.length) continue;
    rows.push({ heading: label });
    for (const [e, i] of mine) rows.push({ entry: i, text: e.spec });
  }
  return rows;
}

function keysBar(f, y, cols) {
  const slot = Math.floor(cols / KEYS.length);
  KEYS.forEach(([n, label], i) => put(f, y, i * slot, [[n, 'bold'], ...fit([[label, 'inv cyan']], slot - n.length, 'inv cyan')], i === KEYS.length - 1 ? cols - i * slot : slot));
}

function panel(f, { y, x, h, w, title, lines, from, focused }) {
  box(f, y, x, h, w, title, focused ? 'cyan' : 'grey');
  for (let i = 0; i < h - 2; i++) put(f, y + 1 + i, x + 1, lines[from + i] ?? '', w - 2);
}

function menu(f, st, cols, rows) {
  const o = st.overlay;
  const list = menuRows(o.entries);
  const w = Math.min(cols - 4, 96);
  const h = Math.min(rows - 2, list.length + 7);
  const x = Math.floor((cols - w) / 2);
  const y = Math.max(1, Math.floor((rows - h) / 2));
  box(f, y, x, h, w, 'Commands', 'yellow');
  const inner = h - 6;
  // The selected command stays in view, with its group's heading when that is just above it.
  const at = list.findIndex((r) => r.entry === o.sel);
  let top = o.top ?? 0;
  if (at <= top) top = Math.max(0, at - 1);
  if (at >= top + inner) top = at - inner + 1;
  o.top = top;
  for (let i = 0; i < inner; i++) {
    const r = list[top + i];
    if (!r) continue;
    put(f, y + 1 + i, x + 2, r.heading ? [[r.heading, 'bold yellow']] : [[`  ${r.text}`, r.entry === o.sel ? 'inv' : '']], w - 4, r.entry === o.sel ? 'inv' : '');
  }
  const help = wrap(o.entries[o.sel]?.help || '', w - 6).slice(0, 3);
  help.forEach((l, i) => put(f, y + h - 5 + i, x + 3, [[l, 'grey']], w - 6));
  put(f, y + h - 2, x + 2, [['↑↓ choose · Enter opens its form · Esc closes', 'grey']], w - 4);
}

function form(f, st, cols, rows) {
  const o = st.overlay;
  const w = Math.min(cols - 4, 96);
  const h = Math.min(rows - 2, o.fields.length + 9 + (o.help ? 2 : 0));
  const x = Math.floor((cols - w) / 2);
  const y = Math.max(1, Math.floor((rows - h) / 2));
  box(f, y, x, h, w, o.entry.spec, 'yellow');
  let r = y + 1;
  for (const l of wrap(o.help || '', w - 6).slice(0, 2)) put(f, r++, x + 3, [[l, 'grey']], w - 6);
  if (o.help) r++;
  if (!o.fields.length) put(f, r++, x + 3, [['No options: Enter runs it.', 'grey']], w - 6);
  o.fields.forEach((fd, i) => {
    const v = o.values[fd.key];
    const shown = fd.kind === 'flag' ? (v === true ? '[x]' : '[ ]') : fd.kind === 'choice' ? `< ${v || 'none'} >` : `${v ?? ''}${i === o.sel ? '▏' : ''}`;
    const sel = i === o.sel ? 'inv' : '';
    put(f, r++, x + 3, [[`${fd.label}${fd.required ? ' *' : ''}`.padEnd(28).slice(0, 28), sel || 'bold'], [' ', sel], [shown, sel]], w - 6, sel);
  });
  r++;
  put(f, r++, x + 3, [['Runs: ', 'bold'], [o.line || '', 'green']], w - 6);
  if (o.error) put(f, r++, x + 3, [[o.error, 'red']], w - 6);
  put(f, y + h - 2, x + 2, [['Enter runs · ↑↓ field · Space on/off · ←→ choice · Esc back', 'grey']], w - 4);
}

function confirm(f, st, cols, rows) {
  const o = st.overlay;
  const w = Math.min(cols - 4, 96);
  const h = 8;
  const x = Math.floor((cols - w) / 2);
  const y = Math.max(1, Math.floor((rows - h) / 2));
  box(f, y, x, h, w, o.mode === 'name' ? 'Delete' : 'Run this?', o.mode === 'name' ? 'red' : 'yellow');
  put(f, y + 2, x + 3, [[o.line, 'bold green']], w - 6);
  if (o.mode === 'name') {
    put(f, y + 4, x + 3, [[`Type ${o.name} to delete it: `, 'bold'], [`${o.typed}▏`, '']], w - 6);
    put(f, y + h - 2, x + 2, [['Enter deletes · Esc cancels', 'grey']], w - 4);
  } else put(f, y + h - 2, x + 2, [['y runs it · n or Esc cancels', 'grey']], w - 4);
}

const HELP = [
  'Keys',
  '  ↑ ↓ PgUp PgDn    move in the list (Tab: the right panel, to scroll it)',
  '  Enter            the ticket, or the project, on the right',
  '  F2  c            every command, with a form for its options',
  '  F3  p            the selected ticket\'s plan        F4  o   the lead\'s handover',
  '  F5  r            read everything again (it also does every few seconds)',
  '  F6  a            forge approve <ticket>           F7  l   forge limits lift <ticket>',
  '  F8  e            forge export --check             F9  d   forge dashboard (the page)',
  '  Esc              stop a running command, close a dialog, back to the ticket',
  '  n                what needs you now (it pops up by itself, with the terminal\'s bell, when something new does)',
  '  F10 q            quit',
  '',
  'Each command runs as forge itself would in this folder: forge ui adds no rights and takes none away. Your decisions',
  '(approve, lift, export, delete) ask before they run. Over ssh, F9 writes the page and prints where it is.',
];

// What needs you now (decision 155), the new ones first marked.
function needsBox(f, st, cols, rows) {
  const o = st.overlay;
  const w = Math.min(cols - 4, 110);
  const lines = o.items.flatMap((n) => wrap(`${o.fresh.has(n.key) ? 'new · ' : ''}${needText(n)}${n.since ? ` · since ${clock(n.since)}` : ''}`, w - 8).map((l, i) => [[`${i ? '   ' : ' • '}${l}`, o.fresh.has(n.key) ? 'bold' : '']]));
  const h = Math.min(rows - 2, lines.length + 4);
  const x = Math.floor((cols - w) / 2);
  const y = Math.max(1, Math.floor((rows - h) / 2));
  box(f, y, x, h, w, `Needs you now (${o.items.length})`, 'red');
  lines.slice(0, h - 3).forEach((l, i) => put(f, y + 1 + i, x + 2, l, w - 4));
  put(f, y + h - 2, x + 2, [['Enter or Esc: got it · n shows this again', 'grey']], w - 4);
}

function help(f, cols, rows) {
  const w = Math.min(cols - 4, 116);
  const h = Math.min(rows - 2, HELP.length + 3);
  const x = Math.floor((cols - w) / 2);
  const y = Math.max(1, Math.floor((rows - h) / 2));
  box(f, y, x, h, w, 'Help', 'yellow');
  HELP.slice(0, h - 3).forEach((l, i) => put(f, y + 1 + i, x + 2, [[l, i === 0 ? 'bold' : '']], w - 4));
  put(f, y + h - 2, x + 2, [['Esc closes', 'grey']], w - 4);
}

export function render(st, { cols, rows }) {
  const f = frame(cols, rows);
  const badge = st.needs?.length ? [[` ! needs you (${st.needs.length}) `, 'inv red bold']] : [];
  put(f, 0, 0, [[` forge ui · ${st.title || ''} `, 'inv bold'], ...badge, [st.clock ? `  ${st.clock} ` : '', 'inv']], cols, 'inv');
  const h = rows - 3;
  const narrow = cols < NARROW;
  const lw = narrow ? cols : Math.max(30, Math.floor(cols * 0.4));
  const showLeft = !narrow || st.focus === 'left';
  const showRight = !narrow || st.focus === 'right';
  if (showLeft) {
    const inner = h - 2;
    const top = Math.min(Math.max(st.top ?? 0, st.sel - inner + 1), st.sel);
    st.top = Math.max(0, top);
    const lines = st.items.map((it, i) => {
      const row = itemRow(it, lw - 2);
      return i === st.sel ? row.map(([t, s]) => [t, st.focus === 'left' ? 'inv' : `${s} bold`.trim()]) : row;
    });
    panel(f, { y: 1, x: 0, h, w: lw, title: st.error ? 'forge ui' : `Tickets (${Math.max(0, st.items.length - 1)})`, lines: st.error ? wrap(st.error, lw - 4).map((l) => [[l, 'yellow']]) : lines, from: st.top, focused: st.focus === 'left' });
  }
  if (showRight) {
    const x = narrow ? 0 : lw;
    const w = narrow ? cols : cols - lw;
    const lines = st.right?.lines ?? [];
    const scroll = Math.max(0, Math.min(st.right?.scroll ?? 0, lines.length - (h - 2)));
    if (st.right) st.right.scroll = scroll;
    panel(f, { y: 1, x, h, w, title: st.right?.title ?? '', lines, from: scroll, focused: st.focus === 'right' });
  }
  put(f, rows - 2, 0, [[st.status || '', st.statusStyle || 'grey']], cols);
  keysBar(f, rows - 1, cols);
  if (st.overlay?.kind === 'menu') menu(f, st, cols, rows);
  if (st.overlay?.kind === 'form') form(f, st, cols, rows);
  if (st.overlay?.kind === 'confirm') confirm(f, st, cols, rows);
  if (st.overlay?.kind === 'help') help(f, cols, rows);
  if (st.overlay?.kind === 'needs') needsBox(f, st, cols, rows);
  return f;
}
