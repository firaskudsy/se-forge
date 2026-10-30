// Contract first: the spec asks a person, api-v* tags are a person's, and API/UI lanes start only
// on an approved contract version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo, sh, writeProjectConfig, DEFAULT_TEST_CONFIG } from './helpers.mjs';
import { loadConfig } from '../../core/policy/lib/config.mjs';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../core/policy/bin/forge-hook.mjs');

function repo(api = { spec: 'api/openapi.yaml' }) {
  const { dir } = makeRepo();
  writeProjectConfig(dir, { project: { api }, policy: DEFAULT_TEST_CONFIG });
  fs.mkdirSync(path.join(dir, 'api'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'api/openapi.yaml'), 'openapi: 3.1.0\n');
  return dir;
}
function hook(event, dir, payload) {
  const r = spawnSync('node', [BIN, event], { input: JSON.stringify({ cwd: dir, transcript_path: '/nonexistent/s.jsonl', permission_mode: 'default', ...payload }), encoding: 'utf8', cwd: dir, env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout ? JSON.parse(r.stdout) : null;
  return { decision: out?.hookSpecificOutput?.permissionDecision ?? 'allow', reason: out?.hookSpecificOutput?.permissionDecisionReason ?? '' };
}
const pre = (dir, tool_name, tool_input, extra = {}) => hook('pre-tool-use', dir, { hook_event_name: 'PreToolUse', tool_name, tool_input, ...extra });
function plan(dir, contract) {
  const file = path.join(dir, '.forge/project/plans/12-users.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `# Users (#12)\nBranch: \`feat/12-users\`\nGates: none\nAreas: db, api, ui\nContract: ${contract}\n`);
  return file;
}
const spawn = (dir, type, file) => pre(dir, 'Agent', { subagent_type: type, prompt: `Implement ${file}.` });

test('editing the spec asks a person once per branch; unattended it is refused', () => {
  const dir = repo();
  const edit = { file_path: path.join(dir, 'api/openapi.yaml'), old_string: 'openapi', new_string: 'openapi' };
  let r = pre(dir, 'Edit', edit);
  assert.equal(r.decision, 'ask');
  assert.match(r.reason, /\[gate:contract\] api\/openapi\.yaml is the API contract.*branch feat\/1-login/);
  assert.equal(pre(dir, 'Edit', edit, { permission_mode: 'bypassPermissions' }).decision, 'deny');
  hook('post-tool-use', dir, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: edit, tool_response: {} });
  assert.equal(pre(dir, 'Edit', edit).decision, 'allow', 'approved for this branch');
  sh(dir, 'git', 'switch', '-q', '-c', 'feat/2-other');
  assert.equal(pre(dir, 'Edit', edit).decision, 'ask', 'not for another branch');
});

test('an ADR asks a person once per branch too (decision 148): the bootstrap\'s setup copies them all at once', () => {
  const dir = repo();
  const adr = (n) => ({ file_path: path.join(dir, `docs/adr/000${n}-stack.md`), content: '# ADR\n' });
  let r = pre(dir, 'Write', adr(1));
  assert.equal(r.decision, 'ask');
  assert.match(r.reason, /\[gate:architecture\] docs\/adr\/0001-stack\.md records an architecture or stack decision.*approving allows ADR edits on branch feat\/1-login/);
  hook('post-tool-use', dir, { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: adr(1), tool_response: {} });
  assert.equal(pre(dir, 'Write', adr(2)).decision, 'allow', 'the next ADR on this branch');
  sh(dir, 'git', 'switch', '-q', '-c', 'chore/architecture');
  assert.equal(pre(dir, 'Write', adr(3)).decision, 'ask', 'not on another branch');
});

test('a repo that only consumes the contract does not guard a file at that path', () => {
  const dir = repo({ spec: 'api/openapi.yaml', contractRepo: 'git@example.com:acme/backend.git', pin: 'api-v1.0.0' });
  assert.equal(pre(dir, 'Write', { file_path: path.join(dir, 'api/openapi.yaml'), content: 'x' }).decision, 'allow');
});

test('api-v* tags are a person\'s; other tags and listing are not gated', () => {
  const dir = repo();
  for (const c of ['git tag api-v1.0.0', 'git tag -a api-v1.0.0 -m "approved"', 'git tag -f api-v1.0.0 HEAD~1', 'git tag -d api-v1.0.0']) {
    const r = pre(dir, 'Bash', { command: c });
    assert.equal(r.decision, 'ask', c);
    assert.match(r.reason, /\[gate:contract\] Tag api-v1\.0\.0/, c);
  }
  for (const c of ['git tag', 'git tag -l "api-v*"', 'git tag --list', 'git tag -m "x" v2.0.0']) assert.equal(pre(dir, 'Bash', { command: c }).decision, 'allow', c);
});

test('API, UI and mobile lanes start only on an approved contract version', () => {
  const dir = repo();
  const file = plan(dir, '`api-v1.2.0`');
  for (const type of ['backend-engineer', 'frontend-engineer', 'mobile-engineer']) {
    const r = spawn(dir, type, file);
    assert.equal(r.decision, 'deny', type);
    assert.match(r.reason, /\[contract:unapproved\] Plan 12-users\.md builds against api-v1\.2\.0, which is not approved here/);
  }
  assert.equal(spawn(dir, 'db-engineer', file).decision, 'allow', 'database work does not wait for the contract');
  sh(dir, 'git', 'tag', 'api-v1.2.0');
  assert.equal(spawn(dir, 'backend-engineer', file).decision, 'allow', 'tagged in this repo');
  plan(dir, 'pending (draft in .forge/project/contracts/12-users.yaml)');
  assert.match(spawn(dir, 'frontend-engineer', file).reason, /\[contract:unapproved\] Plan 12-users\.md has Contract: pending/);
  plan(dir, 'none');
  assert.equal(spawn(dir, 'frontend-engineer', file).decision, 'allow');
});

test('a consumer repo builds against the version it pins', () => {
  const dir = repo({ spec: 'api/openapi.yaml', contractRepo: 'git@example.com:acme/backend.git', pin: 'api-v1.2.0' });
  assert.equal(spawn(dir, 'frontend-engineer', plan(dir, 'api-v1.2.0')).decision, 'allow');
  const r = spawn(dir, 'frontend-engineer', plan(dir, 'api-v1.3.0'));
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /and the project pins api-v1\.2\.0/);
});

test('reviewers may run forge api check, nothing else of forge api', () => {
  const dir = repo();
  const reviewer = { agent_id: 'r1', agent_type: 'spec-checker' };
  assert.equal(pre(dir, 'Bash', { command: 'forge api check' }, reviewer).decision, 'allow');
  assert.equal(pre(dir, 'Bash', { command: 'forge api generate' }, reviewer).decision, 'deny');
});

test('config: the pin must be an api-v<semver> tag', () => {
  const dir = repo({ pin: 'v1.2' });
  assert.match(loadConfig(dir).errors.join(), /project\.api\.pin must be a tag like api-v1\.2\.0/);
});
