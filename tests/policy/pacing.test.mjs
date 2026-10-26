// Pacing: usage levels, the pause on new agents, one note per agent, the status line, and forge's opt-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo, sh } from './helpers.mjs';
import { levelOf, toEpoch, resumeCron, usageRecord } from '../../core/policy/lib/pacing.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = path.join(ROOT, 'core/policy/bin/forge-hook.mjs');
const FORGE = path.join(ROOT, 'core/cli/forge.mjs');
const { ANTHROPIC_API_KEY: _drop, ...BASE_ENV } = process.env;
const now = () => Math.floor(Date.now() / 1000);

function hook(event, payload, dir, env = {}) {
  const r = spawnSync('node', [BIN, event], { input: JSON.stringify({ cwd: dir, permission_mode: 'default', transcript_path: '/nonexistent/s.jsonl', ...payload }), encoding: 'utf8', cwd: dir, env: { ...BASE_ENV, CLAUDE_PROJECT_DIR: dir, ...env } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
}
const pre = (dir, tool_name, tool_input, extra = {}, env) => hook('pre-tool-use', { hook_event_name: 'PreToolUse', tool_name, tool_input, ...extra }, dir, env);
const post = (dir, tool_name, extra = {}) => hook('post-tool-use', { hook_event_name: 'PostToolUse', tool_name, tool_input: {}, tool_response: {}, ...extra }, dir);
const decision = (out) => out?.hookSpecificOutput?.permissionDecision ?? 'allow';
const note = (out) => out?.hookSpecificOutput?.additionalContext ?? '';

function paced(five, week = 10, { enabled = true, reset = now() + 3600 } = {}) {
  const { dir } = makeRepo();
  fs.mkdirSync(path.join(dir, '.forge/state'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.forge/state/pacing.json'), JSON.stringify({ enabled }));
  fs.writeFileSync(path.join(dir, '.forge/state/usage.json'), JSON.stringify({ five_hour: { used: five, resets_at: reset }, seven_day: { used: week, resets_at: now() + 5 * 86400 }, updated_at: now() }));
  return dir;
}

test('levels: amber at 75 % (5-hour) or 80 % (weekly), red at 90 %; a window past its reset counts as empty', () => {
  const t = Date.now();
  const u = (five, week, reset = now() + 600) => ({ five_hour: { used: five, resets_at: reset }, seven_day: { used: week, resets_at: now() + 86400 } });
  assert.equal(levelOf(u(74, 79), t).level, 'green');
  assert.equal(levelOf(u(75, 0), t).level, 'amber');
  assert.equal(levelOf(u(0, 80), t).level, 'amber');
  assert.equal(levelOf(u(90, 0), t).level, 'red');
  assert.equal(levelOf(u(10, 95), t).level, 'red');
  assert.equal(levelOf(u(99, 0, now() - 60), t).level, 'green', 'the 5-hour window has reset');
  assert.equal(levelOf(null, t).level, 'green');
});

test('reset times: epoch seconds, milliseconds, ISO strings; the resume avoids :00 and :30', () => {
  assert.equal(toEpoch(1760000000), 1760000000);
  assert.equal(toEpoch(1760000000000), 1760000000);
  assert.equal(toEpoch('1760000000'), 1760000000);
  assert.equal(toEpoch('2026-10-07T12:00:00Z'), Date.parse('2026-10-07T12:00:00Z') / 1000);
  assert.equal(toEpoch(null), null);
  const at = (h, m) => Math.floor(new Date(2026, 9, 7, h, m, 0).getTime() / 1000);
  assert.equal(resumeCron(at(13, 57)), '1 14 7 10 *', '14:00 moves to 14:01');
  assert.equal(resumeCron(at(9, 10)), '13 9 7 10 *');
  assert.deepEqual(usageRecord({ five_hour: { used_percentage: 41.6, resets_at: 1760000000 } }, 1759990000000), { updated_at: 1759990000, five_hour: { used: 42, resets_at: 1760000000 }, seven_day: null });
});

test('red: the lead may not spawn agents; the reason carries the one-time resume schedule', () => {
  const dir = paced(93);
  const out = pre(dir, 'Agent', { subagent_type: 'code-reviewer', prompt: 'review' });
  assert.equal(decision(out), 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /^\[pacing:pause\] Plan usage: 5-hour 93% .*Start no new agents\..*cron "\d+ \d+ \d+ \d+ \*", prompt "\/resume \.forge\/handoffs\/lead-handover\.md"/);
  assert.equal(decision(pre(dir, 'Bash', { command: 'git status' })), 'allow', 'other work is not blocked');
});

test('amber, off, or an API key: spawning is not paused', () => {
  assert.equal(decision(pre(paced(80), 'Agent', { subagent_type: 'scout', prompt: 'x' })), 'allow');
  assert.equal(decision(pre(paced(95, 10, { enabled: false }), 'Agent', { subagent_type: 'scout', prompt: 'x' })), 'allow');
  assert.equal(decision(pre(paced(95), 'Agent', { subagent_type: 'scout', prompt: 'x' }, {}, { ANTHROPIC_API_KEY: 'sk-test' })), 'allow');
  assert.equal(decision(pre(paced(95, 10, { reset: now() - 5 }), 'Agent', { subagent_type: 'scout', prompt: 'x' })), 'allow', 'the window has reset');
});

test('on a self-hosted model server pacing is off: the Claude plan\'s numbers from before the switch pause nothing (decision 140)', () => {
  const dir = paced(95);
  fs.writeFileSync(path.join(dir, '.forge/state/llm.json'), JSON.stringify({ server: 'gpu' }));
  assert.equal(decision(pre(dir, 'Agent', { subagent_type: 'scout', prompt: 'x' })), 'allow');
  assert.equal(note(post(dir, 'Read')), '', 'and the lead hears nothing of it');
});

test('notes: the lead hears amber once; each lane hears red once', () => {
  const amber = paced(80);
  assert.match(note(post(amber, 'Read')), /^\[pacing\] Plan usage: 5-hour 80%.*start nothing large/);
  assert.equal(note(post(amber, 'Read')), '', 'only once');
  assert.equal(note(post(amber, 'Read', { agent_id: 'a1', agent_type: 'frontend-engineer' })), '', 'lanes are not told about amber');

  const red = paced(91);
  const lane = { agent_id: 'a1', agent_type: 'frontend-engineer' };
  assert.match(note(post(red, 'Edit', lane)), /^\[pacing:pause\] .*commit with explicit paths, push, write \.forge\/handoffs\/<your-name>-handover\.md/);
  assert.equal(note(post(red, 'Edit', lane)), '');
  assert.match(note(post(red, 'Edit', { agent_id: 'b2', agent_type: 'qa-engineer' })), /\[pacing:pause\]/, 'another lane hears it too');
  assert.match(note(post(red, 'Read')), /^\[pacing:pause\] .*Start no new agents/);
});

test('session start reports the pause to the lead', () => {
  const out = hook('session-start', { hook_event_name: 'SessionStart', source: 'startup' }, paced(92));
  assert.match(out.hookSpecificOutput.additionalContext, /WARNING \[pacing:pause\]: Plan usage: 5-hour 92%/);
});

// forge setup/sync/doctor/pacing in a client checkout, as a developer would run them.
function client() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-pacing-')));
  const team = path.join(base, 'team');
  const dir = path.join(base, 'client');
  for (const d of [team, dir]) { fs.mkdirSync(d); sh(d, 'git', 'init', '-q', '-b', 'main'); }
  sh(team, 'git', '-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const env = { ...BASE_ENV, FORGE_USER_CONFIG: path.join(base, 'cfg.json') };
  const forge = (...a) => spawnSync('node', [FORGE, ...a], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(forge('setup', '--team-repo', team).status, 0);
  assert.equal(forge('init', '--project', 'demo', '--new').status, 0);
  const settings = () => JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.local.json'), 'utf8'));
  return { dir, forge, settings };
}

test('forge: pacing is opt-in; sync adds and removes the status line; doctor and forge pacing report it', () => {
  const c = client();
  assert.equal(c.settings().statusLine, undefined, 'off by default');
  assert.match(c.forge('doctor').stdout, /· pacing off: not turned on/);
  assert.equal(c.forge('pacing').status, 3);

  assert.match(c.forge('setup', '--pacing', 'on').stdout, /pacing: on\nrun forge sync in each checkout to add the pacing status line/);
  assert.match(c.forge('doctor').stdout, /! pacing is on for you but not in this checkout: forge sync/);
  assert.equal(c.forge('sync').status, 0);
  const script = path.join(c.dir, '.forge/kit/extras/pacing/statusline.mjs');
  assert.deepEqual(c.settings().statusLine, { type: 'command', command: `node "${script}"` });
  assert.match(c.forge('doctor').stdout, /· pacing on: no usage recorded yet/);

  // The status line, fed what Claude Code sends it, records the usage where the hooks read it.
  const reset = now() + 7200;
  const r = spawnSync('node', [script], { input: JSON.stringify({ workspace: { project_dir: c.dir }, model: { display_name: 'Opus' }, context_window: { used_percentage: 12.4 }, rate_limits: { five_hour: { used_percentage: 91.2, resets_at: reset }, seven_day: { used_percentage: 40, resets_at: reset + 86400 } } }), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^client · Opus · ctx 12% · \x1b\[31m5h 91%\x1b\[0m \(resets \d\d:\d\d\) · \x1b\[32mweek 40%\x1b\[0m \(resets \w+ \d\d:\d\d\)\n$/);
  const p = c.forge('pacing');
  assert.equal(p.status, 2);
  assert.match(p.stdout, /^RED: 5-hour 91% .*pause: hand over and resume at the reset/);

  assert.equal(c.forge('setup', '--pacing', 'off').status, 0);
  assert.equal(c.forge('sync').status, 0);
  assert.equal(c.settings().statusLine, undefined, 'removed again');
  assert.equal(c.forge('pacing').status, 3);
});

test('forge: a status line of the developer\'s own is kept, and pacing says why it has no data', () => {
  const c = client();
  const s = c.settings();
  s.statusLine = { type: 'command', command: 'echo mine' };
  fs.writeFileSync(path.join(c.dir, '.claude/settings.local.json'), JSON.stringify(s));
  c.forge('setup', '--pacing', 'on');
  const r = c.forge('sync');
  assert.match(r.stdout, /pacing: \.claude\/settings\.local\.json has a status line of your own/);
  assert.deepEqual(c.settings().statusLine, { type: 'command', command: 'echo mine' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(c.dir, '.forge/state/pacing.json'), 'utf8')).enabled, false);
});

test('the status line run from a kit source tree writes nothing', () => {
  const r = spawnSync('node', [path.join(ROOT, 'extras/pacing/statusline.mjs')], { input: JSON.stringify({ rate_limits: { five_hour: { used_percentage: 5, resets_at: now() + 60 } } }), encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.ok(!fs.existsSync(path.resolve(ROOT, '..', 'state', 'usage.json')));
});
