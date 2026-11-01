// What needs the owner now (decision 155): the open prompts read from the timeline, Claude Code's notifications
// recorded by the hook, the page's popup with its sound, forge dashboard --watch's desktop alert and bell (and the page
// it builds at once), and forge ui's popup with the terminal's bell.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { sh, makeRepo, writeProjectConfig, DEFAULT_TEST_CONFIG } from '../policy/helpers.mjs';
import { openPrompts, needsYou, needText } from '../../core/cli/dashboard/needs.mjs';
import { runUi } from '../../core/cli/ui/app.mjs';
import { uiData } from '../../core/cli/forge.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FORGE = path.join(KIT, 'core/cli/forge.mjs');
const HOOK = path.join(KIT, 'core/policy/bin/forge-hook.mjs');
const NOW = Date.parse('2026-11-01T12:00:00Z');
const at = (s) => new Date(NOW - s * 1000).toISOString();

test('open prompts: a forge ask, a question, a Claude Code notification, with nothing after them from whoever waits', () => {
  const ask = { at: at(600), event: 'tool.ask', who: 'frontend-engineer', agent: 'f1', session: 's1', ticket: '#15', id: 't1', tool: 'Bash', rule: 'net:outside', what: 'curl -o /tmp/a.png https://www.figma.com/x' };
  let open = openPrompts([ask], NOW);
  assert.equal(open.length, 1);
  assert.equal(needText(open[0]), 'frontend-engineer (#15): [net:outside] curl -o /tmp/a.png https://www.figma.com/x · answer its prompt in the session');
  // The lead and other agents at work in the same session do not answer it; the agent's next step does.
  const others = [{ at: at(500), event: 'tool.start', who: 'lead', session: 's1', id: 'l1', tool: 'Read' }, { at: at(400), event: 'tool.start', who: 'backend-engineer', agent: 'b1', session: 's1', id: 'b1x', tool: 'Bash' }];
  assert.equal(openPrompts([ask, ...others], NOW).length, 1);
  assert.equal(openPrompts([ask, ...others, { at: at(300), event: 'tool.done', who: 'frontend-engineer', agent: 'f1', session: 's1', id: 't1', tool: 'Bash' }], NOW).length, 0, 'answered');
  assert.equal(openPrompts([{ ...ask, at: at(3) }], NOW).length, 0, 'an ask counts after six seconds, as Claude Code\'s own notifications');
  assert.equal(openPrompts([ask, { at: at(100), event: 'session.end', who: 'lead', session: 's1' }], NOW).length, 0, 'its session ended');
  assert.equal(openPrompts([ask, { at: at(100), event: 'session.start', who: 'lead', session: 's2' }], NOW).length, 0, 'another session started');

  // The lead idle at its prompt: a reply is wanted, unless agents are still at work (they will wake it).
  const idle = { at: at(120), event: 'owner.needed', who: 'lead', session: 's3', kind: 'idle_prompt', what: 'Claude is waiting for your input' };
  open = openPrompts([idle], NOW);
  assert.deepEqual(open.map((n) => [n.kind, n.who, n.what]), [['reply', 'the lead', 'finished and waits for your reply']]);
  assert.equal(openPrompts([idle, { at: at(60), event: 'prompt', who: 'human', session: 's3' }], NOW).length, 0, 'you replied');
  assert.equal(openPrompts([{ at: at(200), event: 'tool.start', who: 'qa-engineer', agent: 'q1', session: 's3', id: 'q', tool: 'Bash' }, idle], NOW).length, 0, 'an agent is at work');

  // Claude Code's permission prompt names no agent: it is the one agent with a call open, and one wait with forge's ask.
  const call = { at: at(90), event: 'tool.start', who: 'devops-engineer', agent: 'd1', session: 's4', id: 'd', tool: 'Bash', what: 'ssh deploy@host' };
  const perm = { at: at(80), event: 'owner.needed', who: 'lead', session: 's4', kind: 'permission_prompt', what: 'Claude needs your permission to use Bash' };
  open = openPrompts([call, perm], NOW);
  assert.deepEqual(open.map((n) => [n.kind, n.who]), [['permission', 'devops-engineer']]);
  assert.equal(openPrompts([call, perm, { at: at(10), event: 'tool.done', who: 'devops-engineer', agent: 'd1', session: 's4', id: 'd', tool: 'Bash' }], NOW).length, 0);
  const lead = [{ at: at(90), event: 'tool.ask', who: 'lead', session: 's5', id: 'x', tool: 'Bash', rule: 'deps:change', what: 'npm install left-pad' }, { ...perm, session: 's5' }];
  assert.deepEqual(openPrompts(lead, NOW).map((n) => n.kind), ['approval'], 'the ask says what the prompt is');
  // A question with choices.
  open = openPrompts([{ at: at(30), event: 'tool.start', who: 'lead', session: 's6', id: 'q1', tool: 'AskUserQuestion', what: 'Which login provider?' }], NOW);
  assert.equal(needText(open[0]), 'the lead: Which login provider? · pick an answer in the session');
  // And the stepper's waits come first.
  const all = needsYou({ steps: { waiting: [{ step: 'Build', why: '#15 is at its limit (3 repeat lanes (limit 3)): forge limits lift 15' }] }, lines: [ask], now: NOW });
  assert.deepEqual(all.map((n) => n.kind), ['step', 'approval']);
  assert.equal(needText(all[0]), 'Build: #15 is at its limit (3 repeat lanes (limit 3)): forge limits lift 15');
});

test('the hook records Claude Code\'s notifications in the timeline, and forge sync registers it', () => {
  const tpl = JSON.parse(fs.readFileSync(path.join(KIT, 'adapters/claude/settings.local.template.json'), 'utf8'));
  assert.match(tpl.hooks.Notification[0].hooks[0].command, /forge-hook\.mjs" notification$/);
  const { dir } = makeRepo();
  writeProjectConfig(dir, { project: { name: 'acme' }, policy: { ...DEFAULT_TEST_CONFIG } });
  const r = spawnSync('node', [HOOK, 'notification'], { input: JSON.stringify({ session_id: 'abcdef123', transcript_path: '/nonexistent/s.jsonl', cwd: dir, hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash', title: 'Permission needed', notification_type: 'permission_prompt' }), encoding: 'utf8', cwd: dir, env: { ...process.env, HOME: '/Users/dev', CLAUDE_PROJECT_DIR: dir } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', 'it answers nothing: a notification cannot be blocked');
  const state = path.join(dir, '.forge/state');
  const line = fs.readdirSync(state).filter((f) => f.startsWith('timeline-')).flatMap((f) => fs.readFileSync(path.join(state, f), 'utf8').trim().split('\n')).map((l) => JSON.parse(l)).find((e) => e.event === 'owner.needed');
  assert.ok(line, 'recorded');
  assert.equal(line.kind, 'permission_prompt');
  assert.equal(line.what, 'Claude needs your permission to use Bash');
  assert.equal(line.session, 'abcdef12');
});

// A set-up project on bare origins, as forge init leaves it.
function project() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-needs-')));
  const team = path.join(base, 'se-forge-projects');
  const app = path.join(base, 'acme');
  const env = { ...process.env, HOME: base, FORGE_USER_CONFIG: path.join(base, 'config.json'), FORGE_CACHE_DIR: path.join(base, 'cache'), CLAUDECODE: '' };
  for (const dir of [team, app]) {
    fs.mkdirSync(`${dir}.git`); sh(`${dir}.git`, 'git', 'init', '-q', '--bare', '-b', 'main');
    fs.mkdirSync(dir); sh(dir, 'git', 'init', '-q', '-b', 'main'); sh(dir, 'git', 'config', 'user.email', 't@e'); sh(dir, 'git', 'config', 'user.name', 't');
    fs.writeFileSync(path.join(dir, 'README.md'), '# x\n'); sh(dir, 'git', 'add', '.'); sh(dir, 'git', 'commit', '-q', '-m', 'init');
    sh(dir, 'git', 'remote', 'add', 'origin', `${dir}.git`); sh(dir, 'git', 'push', '-q', '-u', 'origin', 'main');
  }
  const forge = (...args) => spawnSync('node', [FORGE, ...args], { cwd: app, env, encoding: 'utf8' });
  assert.equal(forge('setup', '--team-repo', team).status, 0);
  assert.equal(forge('init', '--project', 'acme', '--new').status, 0);
  const state = path.join(app, '.forge/state');
  const timeline = path.join(state, `timeline-${new Date().toISOString().slice(0, 7)}.jsonl`);
  const add = (e) => fs.appendFileSync(timeline, `${JSON.stringify({ at: new Date(Date.now() - (e.ago ?? 0) * 1000).toISOString(), ...e, ago: undefined })}\n`);
  add({ event: 'session.start', who: 'lead', session: 's1' });
  return { base, app, env, add };
}
const ASK = { ago: 10, event: 'tool.ask', who: 'frontend-engineer', agent: 'f1', session: 's1', ticket: '#15', id: 't1', tool: 'Bash', rule: 'net:outside', what: 'curl -o /tmp/a.png https://www.figma.com/api/mcp/asset/x.png' };

test('the page pops up what needs you, with a sound, and counts it in the tab\'s title; nothing waits, no popup', () => {
  const p = project();
  const page = path.join(p.base, 'out', 'dash.html');
  let r = spawnSync('node', [FORGE, 'dashboard', '--offline', '--no-open', '--out', page], { cwd: p.app, env: p.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(fs.readFileSync(page, 'utf8'), /<dialog id="needs"/);
  p.add(ASK);
  r = spawnSync('node', [FORGE, 'dashboard', '--offline', '--no-open', '--out', page], { cwd: p.app, env: p.env, encoding: 'utf8' });
  const html = fs.readFileSync(page, 'utf8');
  assert.match(html, /<dialog id="needs" class="needs" aria-labelledby="needs-title"><h2 id="needs-title">Needs you now \(1\)<\/h2><ul><li data-key="approval:s1:[^"]+">frontend-engineer \(#15\): \[net:outside\] curl -o \/tmp\/a\.png https:\/\/www\.figma\.com\/api\/mcp\/asset\/x\.png · answer its prompt in the session <span class="dim">· since /);
  assert.match(html, /document\.title = '\(' \+ KEYS\.length \+ '\) needs you · ' \+ document\.title;/);
  assert.match(html, /d\.showModal\(\)/);
  assert.match(html, /tone\(880, 0\); tone\(1320, 0\.28\);/, 'two tones');
  assert.match(html, /click anywhere to hear it/, 'a browser that holds the sound until a click');
  assert.match(html, /localStorage\.setItem\(k, v\); \} catch \(e\)/, 'storage may be refused');
  r = spawnSync('node', [FORGE, 'dashboard', '--text', '--offline'], { cwd: p.app, env: p.env, encoding: 'utf8' });
  assert.match(r.stdout, /\nOpen in a session now: frontend-engineer \(#15\): \[net:outside\] curl/);
});

test('forge dashboard --watch: a new need rings here, alerts the desktop and builds the page at once; answered, the page drops it', async (t) => {
  const p = project();
  const page = path.join(p.base, 'out', 'dash.html');
  const alerts = path.join(p.base, 'alerts.jsonl');
  const w = spawn('node', [FORGE, 'dashboard', '--watch', '--offline', '--no-open', '--out', page], { cwd: p.app, env: { ...p.env, FORGE_WATCH_MS: '60000', FORGE_ALERT_MS: '200', FORGE_ALERT_FILE: alerts } });
  let text = '';
  w.stdout.on('data', (d) => { text += d; });
  w.stderr.on('data', (d) => { text += d; });
  t.after(() => w.kill('SIGKILL'));
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (ok, what, tries = 100) => { for (let i = 0; i < tries && !ok(); i++) await pause(100); assert.ok(ok(), `${what}\n${text}`); };
  await until(() => /alerts: what needs you is looked at every 5 seconds; something new pops up on the page, with a desktop notification and a sound \(--no-alert: none\)\./.test(text), 'started');
  assert.ok(!fs.existsSync(alerts), 'nothing needs you yet');
  p.add(ASK);
  await until(() => fs.existsSync(alerts), 'the desktop alert');
  const alert = JSON.parse(fs.readFileSync(alerts, 'utf8').trim().split('\n')[0]);
  assert.equal(alert.title, 'acme needs you');
  assert.match(alert.body, /^frontend-engineer \(#15\): \[net:outside\] curl -o \/tmp\/a\.png/);
  assert.match(text, /\x07\d+:\d\d [AP]M needs you: frontend-engineer \(#15\): \[net:outside\]/, 'the bell, in the terminal it runs in (over ssh too)');
  await until(() => /Needs you now \(1\)/.test(fs.readFileSync(page, 'utf8')), 'the page, built at once (the look is a minute away here)', 300);
  p.add({ event: 'tool.done', who: 'frontend-engineer', agent: 'f1', session: 's1', id: 't1', tool: 'Bash' });
  await until(() => !/<dialog id="needs"/.test(fs.readFileSync(page, 'utf8')), 'answered: the page drops it', 300);
  await pause(600);
  assert.equal(fs.readFileSync(alerts, 'utf8').trim().split('\n').length, 1, 'one alert for one need');
  w.kill('SIGINT');
  assert.equal(await new Promise((r) => w.on('close', r)), 0);
});

test('forge dashboard --watch --no-alert: the popup on the page only, no bell, no desktop alert', async (t) => {
  const p = project();
  const alerts = path.join(p.base, 'alerts.jsonl');
  p.add(ASK);
  const w = spawn('node', [FORGE, 'dashboard', '--watch', '--no-alert', '--offline', '--no-open', '--out', path.join(p.base, 'out', 'dash.html')], { cwd: p.app, env: { ...p.env, FORGE_WATCH_MS: '60000', FORGE_ALERT_MS: '200', FORGE_ALERT_FILE: alerts } });
  let text = '';
  w.stdout.on('data', (d) => { text += d; });
  t.after(() => w.kill('SIGKILL'));
  for (let i = 0; i < 60 && !/needs you:/.test(text); i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(text, /\n\d+:\d\d [AP]M needs you: frontend-engineer/);
  assert.doesNotMatch(text, /\x07/);
  assert.ok(!fs.existsSync(alerts));
  assert.match(text, /something new pops up on the page\.\n/);
});

test('forge ui: a new need pops up with the terminal\'s bell, and the header counts it', async (t) => {
  const p = project();
  const input = new PassThrough();
  let written = '';
  const output = new Writable({ write(c, e, cb) { written += c; cb(); } });
  Object.assign(output, { columns: 140, rows: 36 });
  let screen = [];
  const stop = new AbortController();
  const done = runUi({ input, output, env: p.env, cwd: p.app, forge: FORGE, load: () => uiData(p.app, p.env), onFrame: (f) => { screen = f; }, signal: stop.signal, refreshMs: 60000, liveMs: 200 });
  t.after(() => stop.abort());
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (re, what) => { for (let i = 0; i < 100 && !screen.some((l) => re.test(l)); i++) await pause(100); assert.ok(screen.some((l) => re.test(l)), `${what}\n${screen.join('\n')}`); };
  await until(/Tickets \(/, 'started');
  assert.doesNotMatch(written, /\x07/);
  p.add(ASK);
  await until(/┌─ Needs you now \(1\)/, 'the popup');
  await until(/new · frontend-engineer \(#15\): \[net:outside\] curl/, 'what it is');
  assert.match(written, /\x07/, 'the bell');
  assert.match(screen[0], /! needs you \(1\)/);
  input.write('\r');
  for (let i = 0; i < 50 && screen.some((l) => /┌─ Needs you now/.test(l)); i++) await pause(100);
  assert.ok(!screen.some((l) => /┌─ Needs you now/.test(l)), 'got it');
  await pause(500);
  assert.ok(!screen.some((l) => /┌─ Needs you now/.test(l)), 'it does not come back for the same need');
  assert.match(screen[0], /! needs you \(1\)/, 'still counted while it waits');
  input.write('n');
  await until(/┌─ Needs you now \(1\)/, 'n shows it again');
  input.write('\x1b');
  p.add({ event: 'tool.done', who: 'frontend-engineer', agent: 'f1', session: 's1', id: 't1', tool: 'Bash' });
  for (let i = 0; i < 50 && /needs you/.test(screen[0]); i++) await pause(100);
  assert.doesNotMatch(screen[0], /needs you/, 'answered');
  stop.abort();
  assert.equal(await done, 0);
});
