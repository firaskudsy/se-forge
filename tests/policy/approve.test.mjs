// Nothing in the build waits on a prompt (decision 149): approved packages install without one (the kit's settings no
// longer ask for every install), a lane refused an unapproved package reports it instead of prompting, and the owner
// approves a gated plan or a package with forge approve, which the hooks and forge wait-owner read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo, writeProjectConfig, DEFAULT_TEST_CONFIG } from './helpers.mjs';
import { approve, ApproveError } from '../../core/cli/approve.mjs';
import { waitOwner } from '../../core/cli/wait.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = path.join(ROOT, 'core/policy/bin/forge-hook.mjs');

function repo(deps = ['better-auth', 'pg-boss']) {
  const { dir } = makeRepo();
  writeProjectConfig(dir, { project: { name: 'acme' }, policy: { ...DEFAULT_TEST_CONFIG, deps: { approved: deps } } });
  return dir;
}
function pre(dir, tool_name, tool_input, extra = {}) {
  const r = spawnSync('node', [BIN, 'pre-tool-use'], { input: JSON.stringify({ cwd: dir, transcript_path: '/nonexistent/s.jsonl', permission_mode: 'auto', hook_event_name: 'PreToolUse', tool_name, tool_input, ...extra }), encoding: 'utf8', cwd: dir, env: { ...process.env, HOME: '/Users/dev' } });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout ? JSON.parse(r.stdout) : null;
  return { decision: out?.hookSpecificOutput?.permissionDecision ?? 'none', reason: out?.hookSpecificOutput?.permissionDecisionReason ?? '' };
}
function plan(dir, gates) {
  const file = path.join(dir, '.forge/project/plans/12-users.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `# Users (#12)\nBranch: \`feat/12-users\`\nGates: ${gates}\nAreas: db\nContract: none\n`);
  return file;
}

test('the kit\'s settings no longer ask for every package install: the policy hook decides', () => {
  const tpl = JSON.parse(fs.readFileSync(path.join(ROOT, 'adapters/claude/settings.local.template.json'), 'utf8'));
  for (const rule of tpl.permissions.ask) assert.doesNotMatch(rule, /^Bash\((npm (install|i)|pnpm add|yarn add|pip install|uv add|dotnet add) /, rule);
  assert.ok(tpl.permissions.ask.includes('Bash(docker push *)'), 'the other asks stay');
});

test('approved packages install without a prompt; an unapproved one is a report from a lane, a prompt only for the lead', () => {
  const dir = repo();
  let r = pre(dir, 'Bash', { command: 'npm install better-auth@^1.7.14 pg-boss --no-fund' }, { agent_id: 'api-15' });
  assert.equal(r.decision, 'allow', r.reason);
  assert.match(r.reason, /\[allow:project\]/);
  r = pre(dir, 'Bash', { command: 'npm install left-pad' }, { agent_id: 'api-15' });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /\[deps:change\] .*A lane does not wait for the owner \(decision 149\): use only approved packages \(policy\.deps\.approved\), or stop here and put it in your report as a question for the owner/);
  assert.equal(pre(dir, 'Bash', { command: 'npm install left-pad' }).decision, 'ask', 'the lead, with the owner there, is still asked');
});

test('forge approve: a person approves a gated plan for its branch, and packages; the hook refuses it from Claude', () => {
  const dir = repo();
  const file = plan(dir, 'security, architecture (auth library)');
  const spawn = () => pre(dir, 'Agent', { subagent_type: 'db-engineer', description: 'DB lane #12', prompt: `Implement ${file}.` });
  let r = spawn();
  assert.equal(r.decision, 'ask');
  assert.match(r.reason, /\[gate:security\][\s\S]*\[gate:architecture\][\s\S]*! forge approve <ticket> \(decision 149\)/);
  const said = [];
  assert.equal(approve({ _: ['12'], package: 'nodemailer,sharp' }, { main: dir, env: { HOME: '/Users/dev' }, out: (s) => said.push(s) }), 0);
  assert.match(said[0], /^#12 approved: security and architecture on feat\/12-users; packages nodemailer, sharp added to policy\.deps\.approved\./);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.forge/project/project.json'), 'utf8')).policy.deps.approved, ['better-auth', 'pg-boss', 'nodemailer', 'sharp']);
  r = spawn();
  assert.notEqual(r.decision, 'ask', `approved for feat/12-users: ${r.reason}`);
  assert.equal(pre(dir, 'Bash', { command: 'npm install sharp' }, { agent_id: 'api-12' }).decision, 'allow');

  r = pre(dir, 'Bash', { command: 'forge approve 12' });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /\[approve:person\] Only a person approves a gated plan or a package \(decision 149\)/);
  plan(dir, 'none');
  assert.throws(() => approve({ _: ['12'] }, { main: dir, env: {}, out: () => {} }), (e) => e instanceof ApproveError && /Nothing to approve for #12: its plan's Gates: line is "none"/.test(e.message));
  assert.throws(() => approve({ _: [] }, { main: dir, env: {}, out: () => {} }), ApproveError);
});

test('forge wait-owner returns as soon as the owner approves the ticket with forge approve', async () => {
  const dir = repo();
  plan(dir, 'security (sign-in)');
  fs.mkdirSync(path.join(dir, '.forge/state'), { recursive: true });
  let t = Date.parse('2026-10-30T10:00:00Z');
  const said = [];
  const sleep = async (ms) => {
    t += ms;
    if (t - Date.parse('2026-10-30T10:00:00Z') >= 60000 && !said.length) approve({ _: ['12'] }, { main: dir, env: { HOME: '/Users/dev' }, out: () => {}, now: () => t });
  };
  await waitOwner({ _: ['12'] }, { main: dir, config: { hold: { minutes: 10 } }, out: (s) => said.push(s), now: () => t, sleep });
  assert.match(said[0], /^ANSWERED: the owner approved #12 at \d\d:\d\d \(forge approve\)\./);
  assert.ok(t - Date.parse('2026-10-30T10:00:00Z') < 2 * 60000);
});

test('a Figma picture downloads without a prompt when the project names a Figma file; a lane reports any other outside address', () => {
  const asset = 'https://www.figma.com/api/mcp/asset/d3dc507a-6660-4987-ad1d-ef75936cbcd9.png';
  const get = `cd /tmp && curl -f -L -o figma-38-3.png "${asset}"`;
  const { dir } = makeRepo();
  writeProjectConfig(dir, { project: { name: 'acme', figma: { fileKey: 'abc123' } }, policy: { ...DEFAULT_TEST_CONFIG } });
  for (const extra of [{ agent_id: 'ui-15' }, {}]) {
    const r = pre(dir, 'Bash', { command: get }, extra);
    assert.equal(r.decision, 'allow', r.reason);
    assert.match(r.reason, /\[allow:project\] a picture from the project's Figma file/);
  }
  assert.equal(pre(dir, 'Bash', { command: `wget -q -O /tmp/a.png ${asset}` }).decision, 'allow');
  assert.equal(pre(dir, 'Bash', { command: `cd src && curl -o a.png ${asset}` }).decision, 'none', 'cd elsewhere is left to the settings');
  assert.equal(pre(dir, 'Bash', { command: `curl -sd @notes.json "${asset}"` }).decision, 'ask', 'sending data there still asks');
  assert.equal(pre(dir, 'Bash', { command: 'curl -L -o /tmp/a.png https://www.figma.com/file/abc123' }).decision, 'ask', 'only the plugin\'s picture links');
  // No Figma file: the lead is asked, a lane is refused with what to do instead of waiting.
  const bare = repo();
  assert.equal(pre(bare, 'Bash', { command: get }).decision, 'ask');
  const r = pre(bare, 'Bash', { command: 'curl -s https://api.example.com/v1/rates' }, { agent_id: 'api-15' });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /\[net:outside\] .*A lane does not wait for the owner \(decision 149\): work without it, or stop here and put it in your report as a question for the owner \(the address and why; they can add the host to policy\.network\.allowHosts\); the lead asks them/);
});
