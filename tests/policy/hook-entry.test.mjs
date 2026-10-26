// End to end through the hook entry point, with the payload shapes Claude Code sends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo, sh } from './helpers.mjs';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../core/policy/bin/forge-hook.mjs');

function hook(event, payload, cwd) {
  const r = spawnSync('node', [BIN, event], { input: typeof payload === 'string' ? payload : JSON.stringify(payload), encoding: 'utf8', cwd, env: { ...process.env, CLAUDE_PROJECT_DIR: cwd } });
  return { code: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr };
}
const pre = (dir, tool_name, tool_input, extra = {}) => hook('pre-tool-use', { hook_event_name: 'PreToolUse', cwd: dir, permission_mode: 'default', session_id: 's', transcript_path: '/nonexistent/s.jsonl', tool_name, tool_input, ...extra }, dir);
const decision = (r) => r.out?.hookSpecificOutput?.permissionDecision ?? 'allow';

test('denies with a reason the agent can act on', () => {
  const { dir } = makeRepo();
  const r = pre(dir, 'Bash', { command: 'git push origin x:main' });
  assert.equal(decision(r), 'deny');
  assert.match(r.out.hookSpecificOutput.permissionDecisionReason, /\[git:push-protected\] Never push to main/);
});

test('allows ordinary work without printing anything', () => {
  const { dir } = makeRepo();
  const r = pre(dir, 'Bash', { command: 'git status --short' });
  assert.equal(r.code, 0);
  assert.equal(r.out, null);
});

test('fails closed on unreadable input', () => {
  const { dir } = makeRepo();
  const r = hook('pre-tool-use', '{not json', dir);
  assert.equal(r.code, 2);
  assert.match(r.err, /blocking this call/);
});

test('asks become denials when no human can be asked; auto mode still asks (decision 141)', () => {
  const { dir } = makeRepo();
  assert.equal(decision(pre(dir, 'Bash', { command: 'npm i zod' })), 'ask');
  assert.equal(decision(pre(dir, 'Bash', { command: 'npm i zod' }, { permission_mode: 'auto' })), 'ask', 'a hook\'s ask prompts in auto mode too');
  for (const mode of ['bypassPermissions', 'dontAsk']) {
    const r = pre(dir, 'Bash', { command: 'npm i zod' }, { permission_mode: mode });
    assert.equal(decision(r), 'deny', mode);
    assert.match(r.out.hookSpecificOutput.permissionDecisionReason, new RegExp(`cannot be given in ${mode} mode`));
  }
});

test('an invalid policy config allows reading only', () => {
  const { dir } = makeRepo({ budget: { warn: 'lots' }, oops: true });
  assert.equal(decision(pre(dir, 'Write', { file_path: path.join(dir, 'a.ts'), content: 'x' })), 'deny');
  assert.equal(decision(pre(dir, 'Bash', { command: 'npm run build > /tmp/b.log' })), 'deny');
  assert.equal(decision(pre(dir, 'Read', { file_path: path.join(dir, 'package.json') })), 'allow');
  assert.equal(decision(pre(dir, 'Bash', { command: 'git status' })), 'allow');
});

test('a human approval of a gated edit is recorded, in human modes only', () => {
  const { dir } = makeRepo();
  const edit = { file_path: path.join(dir, 'src/auth/login.ts'), old_string: 'export', new_string: 'export ' };
  assert.equal(decision(pre(dir, 'Edit', edit)), 'ask');
  hook('post-tool-use', { hook_event_name: 'PostToolUse', cwd: dir, permission_mode: 'bypassPermissions', tool_name: 'Edit', tool_input: edit }, dir);
  assert.equal(decision(pre(dir, 'Edit', edit)), 'ask', 'bypass mode must not record approvals');
  hook('post-tool-use', { hook_event_name: 'PostToolUse', cwd: dir, permission_mode: 'default', tool_name: 'Edit', tool_input: edit }, dir);
  assert.equal(decision(pre(dir, 'Edit', edit)), 'allow');
  const approvals = JSON.parse(fs.readFileSync(path.join(dir, '.forge/state/approvals.json'), 'utf8'));
  assert.deepEqual(approvals['feat/1-login'].gates, ['security']);
});

test('in auto mode the person approves a gated edit, and it is recorded (decision 141)', () => {
  const { dir } = makeRepo();
  const edit = { file_path: path.join(dir, 'src/auth/login.ts'), old_string: 'export', new_string: 'export ' };
  assert.equal(decision(pre(dir, 'Edit', edit, { permission_mode: 'auto' })), 'ask');
  hook('post-tool-use', { hook_event_name: 'PostToolUse', cwd: dir, permission_mode: 'auto', tool_name: 'Edit', tool_input: edit }, dir);
  assert.equal(decision(pre(dir, 'Edit', edit, { permission_mode: 'auto' })), 'allow');
});

test('spawning an engineer on a security-gated plan asks once per branch', () => {
  const { dir } = makeRepo();
  fs.mkdirSync(path.join(dir, '.forge/project/plans'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.forge/project/plans/12-login.md'), '# Login (#12)\nBranch: `feat/12-login`\nGates: security (auth)\n');
  const spawn = { subagent_type: 'frontend-engineer', description: 'login', prompt: 'Implement .forge/project/plans/12-login.md exactly.' };
  assert.equal(decision(pre(dir, 'Agent', spawn)), 'ask');
  assert.equal(decision(pre(dir, 'Agent', { ...spawn, subagent_type: 'code-reviewer' })), 'allow');
  hook('post-tool-use', { hook_event_name: 'PostToolUse', cwd: dir, permission_mode: 'default', tool_name: 'Agent', tool_input: spawn }, dir);
  assert.equal(decision(pre(dir, 'Agent', spawn)), 'allow');
  const approvals = JSON.parse(fs.readFileSync(path.join(dir, '.forge/state/approvals.json'), 'utf8'));
  assert.ok(approvals['feat/12-login'].gates.includes('security'));
});

test("the gates are the names on a plan's Gates: line, not the words in its notes", () => {
  const { dir } = makeRepo();
  fs.mkdirSync(path.join(dir, '.forge/project/plans'), { recursive: true });
  const asks = (gates) => {
    fs.writeFileSync(path.join(dir, '.forge/project/plans/30-x.md'), `# X (#30)\nBranch: \`feat/30-x\`\n${gates}\n`);
    const r = pre(dir, 'Agent', { subagent_type: 'backend-engineer', description: 'x', prompt: 'Implement .forge/project/plans/30-x.md exactly.' });
    return (r.out?.hookSpecificOutput?.permissionDecisionReason ?? '').match(/gate:(security|architecture)/g) ?? [];
  };
  // clinic-booking #15 and #12, as the planner wrote them.
  assert.deepEqual(asks('Gates: performance (free slots p95 < 300 ms, error rate < 1 %: `docs/architecture/nfr.md` §3 line 60, assumption A9, D-037, D-069)'), []);
  assert.deepEqual(asks('Gates: security (rate limits on the public entry points, the trusted-proxy client IP, a pseudonymised IP stored (D-034, D-035, ADR 0012))'), ['gate:security']);
  assert.deepEqual(asks('Gates: performance (caches the auth token, see the stack notes)'), []);
  assert.deepEqual(asks('Gates: architecture (a job queue)'), ['gate:architecture']);
  assert.deepEqual(asks('Gates: performance, stack (Redis)'), ['gate:architecture']);
  assert.deepEqual(asks('Gates: security, architecture (new identity provider)').sort(), ['gate:architecture', 'gate:security']);
  assert.deepEqual(asks('Gates: none'), []);
});

test('opening a ready PR needs green gates on the branch', () => {
  const { dir } = makeRepo();
  sh(dir, 'git', 'push', '-q', '-u', 'origin', 'feat/1-login');
  fs.writeFileSync(path.join(dir, 'status.txt'), 'broken\n');
  sh(dir, 'git', 'commit', '-q', '-am', 'wip');
  sh(dir, 'git', 'push', '-q');
  const r = pre(dir, 'Bash', { command: 'gh pr create --title x --body y' });
  assert.equal(decision(r), 'deny');
  assert.match(r.out.hookSpecificOutput.permissionDecisionReason, /Gates failed/);
  assert.equal(decision(pre(dir, 'Bash', { command: 'gh pr create --draft --title x --body y' })), 'allow');
  fs.writeFileSync(path.join(dir, 'status.txt'), 'ok\n');
  sh(dir, 'git', 'commit', '-q', '-am', 'fix');
  sh(dir, 'git', 'push', '-q');
  assert.equal(decision(pre(dir, 'Bash', { command: 'gh pr create --title x --body y' })), 'allow');
});

test('the gates command reports done or not done', () => {
  const { dir } = makeRepo();
  sh(dir, 'git', 'push', '-q', '-u', 'origin', 'feat/1-login');
  const r = spawnSync('node', [BIN, 'gates'], { cwd: dir, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /gates green/);
});

test('session start reports thresholds from config and pending handovers', () => {
  const { dir } = makeRepo({ budget: { warn: 90000, block: 110000 }, gates: { full: 'true' } });
  fs.mkdirSync(path.join(dir, '.forge/handoffs'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.forge/handoffs/fe-12-handover.md'), '# x');
  const r = hook('session-start', { hook_event_name: 'SessionStart', source: 'compact', cwd: dir }, dir);
  const text = r.out.hookSpecificOutput.additionalContext;
  assert.match(text, /^RESUME \(compact\)/);
  assert.match(text, /Lanes hand over at 90k context and stop at 110k/);
  assert.match(text, /\.forge\/handoffs\/fe-12-handover\.md/);
});
