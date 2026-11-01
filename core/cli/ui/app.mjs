// forge ui (decision 153): every forge command, the project's tickets and what its agents do now, in one terminal
// screen with two panels and the function keys, for a person in a terminal or a tmux pane (and over ssh, where the
// page needs a tunnel). It reads what forge dashboard reads, again every few seconds, and runs each command as forge
// itself in this folder, showing the command line first; it adds no rights and takes none away. Your decisions ask
// before they run, and forge delete asks for the project's name.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { decode } from './keys.mjs';
import { render, menuRows } from './view.mjs';
import { paint, textOf } from './screen.mjs';
import { COMMANDS, helpFor, helpEntries } from '../commands.mjs';
import { fieldsOf, argvOf, lineOf } from './forms.mjs';
import { itemsOf, headerOf, tail, projectLines, ticketLines, planOf } from './data.mjs';

const REFRESH = 10000;
const LIVE = 2000;
const STATUS = 'F2 or c: every command · F1 or h: help · Tab: the right panel · q quits';
const strip = (s) => s.replace(/\x1b\[[\d;?]*[A-Za-z]/g, '').replace(/\r/g, '');

// input, output: the terminal (or streams, in tests); load(): the project's data, or throws when this folder is not a
// project; forge: the path of forge.mjs; onFrame: each frame drawn, and signal, to stop it, for tests.
export function runUi({ input, output, env, cwd, forge, load, color = !env.NO_COLOR, onFrame = null, signal = null, refreshMs = REFRESH, liveMs = LIVE }) {
  const help = helpEntries();
  const entries = COMMANDS.map((c) => ({ ...c, help: helpFor(c.from, help)?.text ?? '' }));
  const st = { title: path.basename(cwd), items: [{ kind: 'project' }], sel: 0, top: 0, focus: 'left', right: { title: '', lines: [], scroll: 0 }, mode: 'details', overlay: null, status: STATUS, events: [], data: null, error: null, menuSel: 0 };
  let child = null;
  let busy = false;
  let follow = true;
  let pending = null;
  let closed = false;
  const tty = Boolean(output.isTTY && input.isTTY);
  const restore = () => { if (tty) { output.write('\x1b[?25h\x1b[?1049l'); input.setRawMode(false); } };
  const resized = () => { output.write('\x1b[2J'); soon(); };
  const size = () => ({ cols: output.columns || 100, rows: output.rows || 30 });

  const draw = () => {
    pending = null;
    if (closed) return;
    const pad = (n) => String(n).padStart(2, '0');
    const d = new Date();
    st.clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const f = render(st, size());
    output.write(`\x1b[H${paint(f, { color }).join('\r\n')}`);
    onFrame?.(textOf(f), st);
  };
  const soon = () => { pending ??= setTimeout(draw, 30); };

  const selected = () => st.items[st.sel];
  const details = () => {
    if (st.mode !== 'details' || !st.data) return;
    const it = selected();
    const { model, project, folder, stateDir } = st.data;
    st.right = { title: it?.kind === 'ticket' ? `${it.t.id}` : project, lines: it?.kind === 'ticket' ? ticketLines(model, it, { stateDir, folder, events: st.events }) : projectLines(model, project, st.events), scroll: st.right.title === (it?.kind === 'ticket' ? `${it.t.id}` : project) ? st.right.scroll : 0 };
  };

  async function refresh() {
    if (busy) return;
    busy = true;
    try {
      const keep = selected();
      const data = await load();
      st.data = data;
      st.error = null;
      st.title = headerOf(data.model, data.project);
      st.items = itemsOf(data.model);
      const again = keep?.kind === 'ticket' ? st.items.findIndex((x) => x.kind === 'ticket' && x.t.num === keep.t.num) : 0;
      st.sel = Math.max(0, again);
      st.events = tail(data.stateDir);
      details();
    } catch (e) {
      st.data = null;
      st.items = [];
      st.error = `${e.message}\n\nThe Setup commands (F2) work here: forge setup, forge init, forge import.`;
      if (st.mode === 'details') st.right = { title: '', lines: [], scroll: 0 };
    } finally { busy = false; soon(); }
  }

  function live() {
    if (!st.data || busy) return;
    st.events = tail(st.data.stateDir);
    details();
    soon();
  }

  function show(title, lines, mode = 'view') { st.mode = mode; st.right = { title, lines: lines.map((l) => [[l, '']]), scroll: 0 }; }

  function run(argv, then = null) {
    if (child) { st.status = 'A command is still running: Esc stops it.'; return; }
    st.mode = 'output';
    follow = true;
    st.right = { title: lineOf(argv), lines: [], scroll: 0 };
    st.status = `running ${lineOf(argv)} · Esc stops it`;
    let rest = '';
    const add = (chunk) => {
      const parts = strip(rest + chunk).split('\n');
      rest = parts.pop();
      st.right.lines.push(...parts.map((l) => [[l, '']]));
      if (follow) st.right.scroll = Infinity;
      soon();
    };
    child = spawn(process.execPath, [forge, ...argv], { cwd, env: { ...env, NO_COLOR: '1', FORCE_COLOR: '0', FORGE_UI: '1' } });
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    child.on('close', (code, signal) => {
      if (rest) st.right.lines.push([[rest, '']]);
      st.right.lines.push([''], [[signal ? `stopped (${signal})` : `exit ${code}`, code === 0 ? 'green' : 'red']]);
      if (follow) st.right.scroll = Infinity;
      st.status = `${lineOf(argv)}: ${signal ? 'stopped' : code === 0 ? 'done' : `exit ${code}`} · Esc: back to the ticket`;
      st.statusStyle = code === 0 ? 'green' : 'red';
      child = null;
      refresh();
      then?.(code);
    });
  }

  // A command's form, its fields filled from the selected ticket and the project where they ask for them.
  function openForm(i, from = 'menu') {
    const entry = entries[i];
    const fields = fieldsOf(entry.spec);
    const it = selected();
    const values = {};
    for (const fd of fields) {
      if (fd.key === 'ticket' && it?.kind === 'ticket') values.ticket = String(it.t.num);
      if (fd.key === 'slug' && st.data) values.slug = st.data.project;
    }
    if (!fields.length && !entry.confirm) { st.overlay = null; run(argvOf(entry.spec).argv); return; }
    st.overlay = { kind: 'form', entry, index: i, fields, values, sel: 0, from, help: entry.help };
    preview();
  }
  function preview() {
    const o = st.overlay;
    const r = argvOf(o.entry.spec, o.values);
    o.line = r.argv ? lineOf(r.argv) : '';
    return r;
  }
  function submit() {
    const o = st.overlay;
    const r = preview();
    if (r.error) { o.error = r.error; return; }
    if (o.entry.confirm === 'name') {
      const name = r.argv[1];
      st.overlay = null;
      // What would go, first; the name is asked for only when nothing stops it.
      run(r.argv, (code) => { if (code === 0) { st.overlay = { kind: 'confirm', mode: 'name', argv: r.argv, line: lineOf(r.argv), name, typed: '', back: o }; soon(); } });
      return;
    }
    if (o.entry.confirm === 'yes') { st.overlay = { kind: 'confirm', mode: 'yes', argv: r.argv, line: lineOf(r.argv), back: o }; return; }
    st.overlay = null;
    run(r.argv);
  }

  const byName = (spec) => entries.findIndex((e) => e.spec.startsWith(spec));
  function quit(resolve) {
    closed = true;
    if (child) child.kill('SIGINT');
    clearInterval(timers.refresh);
    clearInterval(timers.live);
    if (pending) clearTimeout(pending);
    input.removeListener('data', onData);
    output.removeListener?.('resize', resized);
    process.removeListener('exit', restore);
    restore();
    input.pause?.();
    resolve(0);
  }

  function key(k, resolve) {
    const o = st.overlay;
    const page = Math.max(1, size().rows - 6);
    if (o?.kind === 'help') { if (['escape', 'enter', 'q', 'f1', 'h', '?'].includes(k)) st.overlay = null; return; }
    if (o?.kind === 'menu') {
      const order = menuRows(entries).filter((r) => r.entry !== undefined).map((r) => r.entry);
      const at = order.indexOf(o.sel);
      if (k === 'escape' || k === 'f2') st.overlay = null;
      else if (k === 'up') o.sel = order[Math.max(0, at - 1)];
      else if (k === 'down') o.sel = order[Math.min(order.length - 1, at + 1)];
      else if (k === 'pageup') o.sel = order[Math.max(0, at - page)];
      else if (k === 'pagedown') o.sel = order[Math.min(order.length - 1, at + page)];
      else if (k === 'home') o.sel = order[0];
      else if (k === 'end') o.sel = order.at(-1);
      else if (k === 'enter') { st.menuSel = o.sel; openForm(o.sel); }
      return;
    }
    if (o?.kind === 'form') {
      const fd = o.fields[o.sel];
      o.error = null;
      if (k === 'escape') st.overlay = o.from === 'menu' ? { kind: 'menu', entries, sel: o.index } : null;
      else if (k === 'enter') submit();
      else if (k === 'up' || k === 'backtab') o.sel = Math.max(0, o.sel - 1);
      else if (k === 'down' || k === 'tab') o.sel = Math.min(o.fields.length - 1, o.sel + 1);
      else if (!fd) return;
      else if (fd.kind === 'flag' && (k === ' ' || k === 'left' || k === 'right')) o.values[fd.key] = o.values[fd.key] !== true;
      else if (fd.kind === 'choice' && (k === 'left' || k === 'right' || k === ' ')) {
        const all = ['', ...fd.choices];
        o.values[fd.key] = all[(all.indexOf(o.values[fd.key] ?? '') + (k === 'left' ? all.length - 1 : 1)) % all.length];
      } else if (fd.kind === 'value' && k === 'backspace') o.values[fd.key] = [...(o.values[fd.key] ?? '')].slice(0, -1).join('');
      else if (fd.kind === 'value' && k === 'ctrl-u') o.values[fd.key] = '';
      else if (fd.kind === 'value' && [...k].length === 1) o.values[fd.key] = `${o.values[fd.key] ?? ''}${k}`;
      if (st.overlay === o) preview();
      return;
    }
    if (o?.kind === 'confirm') {
      if (o.mode === 'yes') {
        if (k === 'y' || k === 'Y') { st.overlay = null; run(o.argv); } else if (['n', 'N', 'escape'].includes(k)) st.overlay = o.back;
        return;
      }
      if (k === 'escape') { st.overlay = null; st.status = 'Not deleted.'; return; }
      if (k === 'enter') {
        if (o.typed === o.name) { st.overlay = null; run([...o.argv, '--confirm', o.name]); } else st.status = `Type ${o.name} exactly to delete it.`;
        return;
      }
      if (k === 'backspace') o.typed = o.typed.slice(0, -1);
      else if ([...k].length === 1) o.typed += k;
      return;
    }

    if (k === 'q' || k === 'f10' || k === 'ctrl-c') return quit(resolve);
    if (k === 'escape') {
      if (child) { child.kill('SIGINT'); setTimeout(() => child?.kill('SIGTERM'), 2000); return; }
      st.mode = 'details';
      st.status = STATUS;
      st.statusStyle = '';
      details();
      return;
    }
    if (k === 'tab' || k === 'backtab') { st.focus = st.focus === 'left' ? 'right' : 'left'; return; }
    if (st.focus === 'right' && ['up', 'down', 'pageup', 'pagedown', 'home', 'end'].includes(k)) {
      const r = st.right;
      const step = { up: -1, down: 1, pageup: -page, pagedown: page }[k];
      r.scroll = k === 'home' ? 0 : k === 'end' ? Infinity : Math.max(0, Math.min(r.scroll + step, r.lines.length));
      follow = k === 'end';
      return;
    }
    const move = { up: -1, down: 1, pageup: -page, pagedown: page, home: -Infinity, end: Infinity }[k];
    if (move !== undefined) {
      st.sel = Math.max(0, Math.min(st.items.length - 1, st.sel + move));
      if (st.mode === 'details') details();
      return;
    }
    if (k === 'enter') { st.mode = 'details'; st.status = STATUS; st.statusStyle = ''; details(); if (size().cols < 80) st.focus = 'right'; return; }
    if (k === 'f1' || k === 'h' || k === '?') { st.overlay = { kind: 'help' }; return; }
    if (k === 'f2' || k === 'c') { st.overlay = { kind: 'menu', entries, sel: st.menuSel }; return; }
    if (k === 'f5' || k === 'r') { st.status = 'reading…'; refresh().then(() => { st.status = STATUS; soon(); }); return; }
    if (k === 'f3' || k === 'p') {
      const it = selected();
      const plan = it?.kind === 'ticket' && st.data ? planOf(st.data.folder, it.t.num) : null;
      if (plan) show(path.basename(plan), fs.readFileSync(plan, 'utf8').split('\n'));
      else st.status = it?.kind === 'ticket' ? `${it.t.id} has no plan yet.` : 'Choose a ticket first (↑↓), then F3.';
      return;
    }
    if (k === 'f4' || k === 'o') {
      const file = st.data ? path.join(st.data.main, '.forge', 'handoffs', 'lead-handover.md') : null;
      if (file && fs.existsSync(file)) show('lead-handover.md', fs.readFileSync(file, 'utf8').split('\n'));
      else st.status = 'No lead handover yet: /pause in the lead\'s session writes it.';
      return;
    }
    if (k === 'f6' || k === 'a') { openForm(byName('forge approve'), 'key'); return; }
    if (k === 'f7' || k === 'l') { openForm(byName('forge limits lift'), 'key'); return; }
    if (k === 'f8' || k === 'e') { run(['export', '--check']); return; }
    if (k === 'f9' || k === 'd') { run(env.SSH_CONNECTION || process.platform !== 'darwin' ? ['dashboard', '--no-open'] : ['dashboard']); }
  }

  let onData;
  const timers = {};
  return new Promise((resolve) => {
    onData = (chunk) => { for (const k of decode(chunk)) { key(k, resolve); if (closed) return; } soon(); };
    // The terminal comes back as it was, even when forge ui stops on an error.
    if (tty) { output.write('\x1b[?1049h\x1b[?25l\x1b[2J'); input.setRawMode(true); process.once('exit', restore); }
    input.on('data', onData);
    input.resume?.();
    output.on?.('resize', resized);
    timers.refresh = setInterval(() => { if (!st.overlay) refresh(); }, refreshMs);
    timers.live = setInterval(live, liveMs);
    signal?.addEventListener('abort', () => { if (!closed) quit(resolve); });
    draw();
    refresh();
  });
}
