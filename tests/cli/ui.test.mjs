// forge ui (decision 153): every command of forge's help in its menu, forms that make the exact command line, the keys
// of the usual terminals, a screen drawn from its state alone, and a whole run on a project: a ticket and what its
// agents do now, a command run, a form filled from the ticket, and forge delete asking for the project's name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { sh } from '../policy/helpers.mjs';
import { COMMANDS, GROUPS, helpEntries, helpFor } from '../../core/cli/commands.mjs';
import { partsOf, fieldsOf, argvOf, lineOf } from '../../core/cli/ui/forms.mjs';
import { decode } from '../../core/cli/ui/keys.mjs';
import { render, menuRows } from '../../core/cli/ui/view.mjs';
import { textOf } from '../../core/cli/ui/screen.mjs';
import { runUi } from '../../core/cli/ui/app.mjs';
import { uiData } from '../../core/cli/forge.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FORGE = path.join(KIT, 'core/cli/forge.mjs');

test('the menu has every command of forge\'s help, each from one help line, and your decisions ask before they run', () => {
  const help = helpEntries();
  assert.ok(help.length >= 35, 'the help is read');
  for (const c of COMMANDS) {
    assert.ok(helpFor(c.from, help), `${c.spec}: no help line starts with "${c.from}"`);
    assert.ok(GROUPS.some(([g]) => g === c.group), c.spec);
    assert.doesNotThrow(() => partsOf(c.spec), c.spec);
  }
  const used = new Set(COMMANDS.map((c) => helpFor(c.from, help).usage));
  assert.deepEqual(help.filter((e) => !used.has(e.usage)).map((e) => e.usage), ['forge ui'], 'every command but forge ui itself has an entry');
  for (const spec of ['forge approve', 'forge limits lift', 'forge export [', 'forge import', 'forge save', 'forge worktrees --clean', 'forge llm use', 'forge merge <ticket>']) {
    assert.equal(COMMANDS.find((c) => c.spec.startsWith(spec)).confirm, 'yes', spec);
  }
  assert.equal(COMMANDS.find((c) => c.spec.startsWith('forge delete')).confirm, 'name');
  assert.equal(helpFor('forge app', help).usage, 'forge app [up [--fresh] [--no-open] | down]', '"forge app" is not "forge approve"');
});

test('a form\'s fields come from the spec, and its values make the exact command line', () => {
  assert.deepEqual(fieldsOf('forge limits lift <ticket>').map((f) => [f.key, f.kind, f.required]), [['ticket', 'value', true]]);
  assert.deepEqual(argvOf('forge limits lift <ticket>', { ticket: '15' }), { argv: ['limits', 'lift', '15'] });
  assert.deepEqual(argvOf('forge limits lift <ticket>', {}), { error: '<ticket> is needed' });
  const init = 'forge init --project <slug> [--new] [--host gitlab|github] [--client <name>]';
  assert.deepEqual(fieldsOf(init).map((f) => [f.key, f.kind, f.required, f.choices ?? null]), [['project', 'value', true, null], ['new', 'flag', false, null], ['host', 'choice', false, ['gitlab', 'github']], ['client', 'value', false, null]]);
  assert.deepEqual(argvOf(init, { project: 'acme', new: true, host: 'github' }).argv, ['init', '--project', 'acme', '--new', '--host', 'github']);
  assert.equal(lineOf(argvOf('forge save [-m <message>]', { m: 'new plan for #15' }).argv), 'forge save -m \'new plan for #15\'');
  assert.deepEqual(argvOf('forge docs check <paths...>', { paths: 'docs/adr  docs/architecture' }).argv, ['docs', 'check', 'docs/adr', 'docs/architecture']);
  assert.deepEqual(argvOf('forge dashboard --watch [--every <30s|2m>]', { every: '45s' }).argv, ['dashboard', '--watch', '--every', '45s']);
  assert.deepEqual(argvOf('forge shot --playwright <report.json> [--ticket <n>]', { playwright: 'r.json' }).argv, ['shot', '--playwright', 'r.json']);
  assert.deepEqual(argvOf('forge new [--frontend react]', { frontend: 'react' }).argv, ['new', '--frontend', 'react']);
});

test('keys: the function and arrow keys as Terminal, iTerm, tmux and the Linux console send them', () => {
  assert.deepEqual(decode('\x1bOP\x1b[12~\x1b[[C\x1b[15~\x1b[21~'), ['f1', 'f2', 'f3', 'f5', 'f10']);
  assert.deepEqual(decode('\x1b[A\x1bOB\x1b[5~\x1b[6~\x1b[H\x1b[4~'), ['up', 'down', 'pageup', 'pagedown', 'home', 'end']);
  assert.deepEqual(decode('q\r\t\x7f'), ['q', 'enter', 'tab', 'backspace']);
  assert.deepEqual(decode('\x1b'), ['escape']);
  assert.deepEqual(decode('\x1b[99~x'), ['x'], 'an unknown sequence is dropped, not read as letters');
  assert.deepEqual(decode('é#'), ['é', '#']);
});

test('the screen is drawn from the state alone: header, tickets, the right panel, the keys; narrow shows one panel', () => {
  const t = { id: '#15', num: 15, title: 'Sign up' };
  const st = { title: 'acme · step 10 of 11: Build', items: [{ kind: 'project' }, { kind: 'ticket', t, mark: '!', state: 'at its limit', style: 'red' }], sel: 1, top: 0, focus: 'left', right: { title: '#15', lines: [[['Waiting for you: lift it', 'yellow']]], scroll: 0 }, status: 'F2 or c: every command' };
  let screen = textOf(render(st, { cols: 120, rows: 20 }));
  assert.match(screen[0], /^ forge ui · acme · step 10 of 11: Build/);
  assert.match(screen[1], /┌─ Tickets \(1\) ─+┐┌─ #15 ─+┐/);
  assert.match(screen[2], /││Waiting for you: lift it +│$/);
  assert.match(screen[3], /^│! #15 Sign up +at its limit││/);
  assert.match(screen.at(-1), /^1Help +2Commands +3Plan +4Handover +5Refresh +6Approve +7Lift +8Export +9Dashboard +10Quit/);
  screen = textOf(render(st, { cols: 60, rows: 20 }));
  assert.ok(!screen.some((l) => l.includes('Waiting for you')), 'narrow: only the list');
  st.focus = 'right';
  assert.ok(textOf(render(st, { cols: 60, rows: 20 })).some((l) => l.includes('Waiting for you')), 'narrow: only the right panel');
  const entries = COMMANDS.map((c) => ({ ...c, help: 'what it does' }));
  st.overlay = { kind: 'menu', entries, sel: menuRows(entries).find((r) => r.text === 'forge limits lift <ticket>').entry };
  screen = textOf(render(st, { cols: 120, rows: 40 }));
  assert.ok(screen.some((l) => /│ Your decisions/.test(l)), 'group headings');
  assert.ok(screen.some((l) => /│ {3}forge limits lift <ticket>/.test(l)), 'the selected command is in view');
});

// A project like a real one: a team repo and an app on bare origins, forge init, a plan for #11 and an agent at work.
function project() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ui-')));
  const repo = (dir) => { fs.mkdirSync(dir, { recursive: true }); sh(dir, 'git', 'init', '-q', '-b', 'main'); sh(dir, 'git', 'config', 'user.email', 't@e'); sh(dir, 'git', 'config', 'user.name', 't'); };
  const team = path.join(base, 'se-forge-projects');
  const app = path.join(base, 'acme');
  const env = { ...process.env, HOME: base, FORGE_USER_CONFIG: path.join(base, 'config.json'), FORGE_CACHE_DIR: path.join(base, 'cache'), CLAUDECODE: '' };
  for (const [dir, file] of [[team, 'README.md'], [app, 'README.md']]) {
    fs.mkdirSync(`${dir}.git`); sh(`${dir}.git`, 'git', 'init', '-q', '--bare', '-b', 'main');
    repo(dir); fs.writeFileSync(path.join(dir, file), '# x\n');
    sh(dir, 'git', 'add', '.'); sh(dir, 'git', 'commit', '-q', '-m', 'init');
    sh(dir, 'git', 'remote', 'add', 'origin', `${dir}.git`); sh(dir, 'git', 'push', '-q', '-u', 'origin', 'main');
  }
  const forge = (...args) => spawnSync('node', [FORGE, ...args], { cwd: app, env, encoding: 'utf8' });
  assert.equal(forge('setup', '--team-repo', team).status, 0);
  assert.equal(forge('init', '--project', 'acme', '--new').status, 0);
  fs.writeFileSync(path.join(team, 'acme/plans/11-users.md'), '# Users (#11)\nBranch: `feat/11-users`\nStatus: in progress\nAreas: api\n');
  assert.equal(forge('save', '-m', 'plan 11').status, 0);
  const state = path.join(app, '.forge/state');
  fs.mkdirSync(path.join(state, 'spawns'), { recursive: true });
  fs.writeFileSync(path.join(state, 'spawns/b1.json'), JSON.stringify({ type: 'backend-engineer', ticket: '#11', description: 'API lane #11', at: new Date(Date.now() - 60000).toISOString() }));
  const at = (s) => new Date(Date.now() - s * 1000).toISOString();
  const month = new Date().toISOString().slice(0, 7);
  fs.writeFileSync(path.join(state, `timeline-${month}.jsonl`), [
    { at: at(50), event: 'agent.start', who: 'backend-engineer', agent: 'b1', ticket: '#11' },
    { at: at(40), event: 'tool.start', who: 'backend-engineer', agent: 'b1', ticket: '#11', tool: 'Bash', what: 'npm test -- users' },
    { at: at(30), event: 'tool.start', who: 'backend-engineer', agent: 'b1', ticket: '#11', tool: 'Edit', what: 'src/users/users.service.ts' },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { base, team, app, env };
}

test('forge ui on a project: #11 and its agent at work, a command run, a form filled from the ticket, and forge delete asking for the name', async (t) => {
  const p = project();
  const input = new PassThrough();
  const output = new Writable({ write(c, e, cb) { cb(); } });
  Object.assign(output, { columns: 140, rows: 36 });
  let screen = [];
  const stop = new AbortController();
  const done = runUi({ input, output, env: p.env, cwd: p.app, forge: FORGE, load: () => uiData(p.app, p.env), onFrame: (f) => { screen = f; }, signal: stop.signal, refreshMs: 60000, liveMs: 60000 });
  t.after(() => stop.abort());
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (re, what) => { for (let i = 0; i < 100 && !screen.some((l) => re.test(l)); i++) await pause(100); assert.ok(screen.some((l) => re.test(l)), `${what}\n${screen.join('\n')}`); };
  const press = async (...keys) => { for (const k of keys) { input.write(k); await pause(60); } };

  await until(/Tickets \(1\)/, 'the list');
  assert.match(screen[0], /forge ui · acme · .*0 of 1 merged/);
  await until(/▶ #11 Users +working/, '#11 is being worked on');
  await press('\x1b[B');
  await until(/^│.*││#11 Users/, '#11 on the right');
  await until(/▶ backend-engineer .*API lane #11/, 'its agent');
  await until(/backend +Edit +src\/users\/users\.service\.ts/, 'what its agent does now');
  await until(/Plan: 11-users\.md/, 'its plan');
  await press('p');
  await until(/┌─ 11-users\.md/, 'F3 shows the plan');
  await press('\x1b');

  // From the menu: forge limits runs at once (no options) and its output comes on the right.
  await press('c');
  await until(/┌─ Commands/, 'the menu');
  for (let i = 0; i < 3; i++) await press('\x1b[B');
  await until(/│ {3}forge limits +│/, 'forge limits selected');
  await press('\r');
  await until(/┌─ forge limits ─/, 'its output');
  await until(/exit 0/, 'it ran');
  await press('\x1b');

  // F7: the lift form, filled from the selected ticket, shows the command; Esc closes it without running it.
  await press('\x1b[18~');
  await until(/Runs: forge limits lift 11/, 'the form');
  await press('\x1b');
  await until(/F2 or c: every command/, 'closed');

  // forge delete: the form takes the project's name, what would go is shown, then the name is asked for.
  await press('c');
  const entries = COMMANDS.map((c) => ({ ...c }));
  const order = menuRows(entries).filter((r) => r.entry !== undefined).map((r) => r.entry);
  const target = order.indexOf(entries.findIndex((e) => e.spec.startsWith('forge delete')));
  await press('\x1b[H');
  for (let i = 0; i < target; i++) await press('\x1b[B');
  await until(/│ {3}forge delete <slug>/, 'forge delete in view');
  assert.ok(screen.some((l) => /│ {3}forge delete <slug> \[--force\]/.test(l)));
  await until(/│ {3}forge delete <slug>/, 'forge delete selected');
  await press('\r');
  await until(/Runs: forge delete acme/, 'the form, with the project\'s name');
  await press('\r');
  await until(/forge delete acme would:/, 'what would go');
  await until(/Type acme to delete it:/, 'the name asked for');
  await press('a', 'c', '\r');
  await until(/Type acme exactly to delete it\./, 'a wrong name deletes nothing');
  assert.ok(fs.existsSync(path.join(p.team, 'acme')));
  await press('m', 'e', '\r');
  await until(/deleted acme from the team repo and pushed/, 'deleted');
  assert.ok(!fs.existsSync(path.join(p.team, 'acme')));
  assert.ok(!fs.existsSync(path.join(p.app, '.forge')));
  await until(/The Setup commands \(F2\) work here/, 'the folder is no project any more');
  input.write('q');
  assert.equal(await done, 0);
});

test('forge ui needs a terminal: without one it says where to run it', () => {
  const r = spawnSync('node', [FORGE, 'ui'], { input: '', encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /forge ui needs a terminal: run it in a terminal or a tmux pane \(Claude Code's ! cannot run it\)\./);
});
