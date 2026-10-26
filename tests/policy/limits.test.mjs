// The circuit breaker (decision 127): per ticket at most 4 engineer lanes, 2 review rounds with blockers and 2 QA
// fails; past one the next engineer lane is refused until a person lifts it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo, sh, DEFAULT_TEST_CONFIG } from './helpers.mjs';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../core/policy/bin/forge-hook.mjs');
const FORGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../core/cli/forge.mjs');

// A client repo whose .forge/project links to a team repo folder with its own history.
function linked() {
  const { dir } = makeRepo(null);
  const team = `${dir}-team`;
  const folder = path.join(team, 'acme');
  fs.mkdirSync(path.join(folder, 'reviews/12'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'project.json'), JSON.stringify({ project: { name: 'acme' }, policy: DEFAULT_TEST_CONFIG }, null, 2));
  sh(team, 'git', 'init', '-q', '-b', 'main');
  sh(team, 'git', 'add', '.');
  sh(team, 'git', '-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-q', '-m', 'team');
  fs.mkdirSync(path.join(dir, '.forge'), { recursive: true });
  fs.symlinkSync(folder, path.join(dir, '.forge/project'), 'dir');
  const save = (rel, text) => { fs.writeFileSync(path.join(folder, rel), text); sh(team, 'git', 'add', '.'); sh(team, 'git', '-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-q', '-m', rel); };
  const lane = (id, type, ticket) => { fs.mkdirSync(path.join(dir, '.forge/state/spawns'), { recursive: true }); fs.writeFileSync(path.join(dir, `.forge/state/spawns/${id}.json`), JSON.stringify({ type, ticket, description: 'x', at: new Date().toISOString() })); };
  return { dir, folder, save, lane };
}

function pre(dir, tool_input, extra = {}) {
  const r = spawnSync('node', [BIN, 'pre-tool-use'], { input: JSON.stringify({ cwd: dir, permission_mode: 'default', transcript_path: '/nonexistent/s.jsonl', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input, ...extra }), encoding: 'utf8', cwd: dir, env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
  const out = r.stdout ? JSON.parse(r.stdout) : null;
  return { decision: out?.hookSpecificOutput?.permissionDecision ?? 'allow', reason: out?.hookSpecificOutput?.permissionDecisionReason ?? '' };
}
const fix = { subagent_type: 'backend-engineer', description: 'Fix lane #12', prompt: 'Fix the blockers in .forge/project/reviews/12/code.md.' };
const report = (verdict) => `# Code review (#12)\n\nVerdict: ${verdict}\nCommit: abc1234\n`;

test('the fifth engineer lane of a ticket is refused; other tickets, reviewers and QA go on', () => {
  const p = linked();
  for (const [i, type] of ['db-engineer', 'backend-engineer', 'frontend-engineer'].entries()) p.lane(`a${i}`, type, '#12');
  p.lane('q1', 'qa-engineer', '#12');
  p.lane('r1', 'code-reviewer', '#12');
  p.lane('o1', 'backend-engineer', '#13');
  assert.equal(pre(p.dir, fix).decision, 'allow', '3 lanes so far: QA and reviewers do not count');
  p.lane('a3', 'backend-engineer', '#12');
  const r = pre(p.dir, fix);
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /^\[ticket:limit\] #12 has reached its limit: 4 engineer lanes \(limit 4\)\. Park it: forge tracker status 12 Blocked --comment ".*Only a person lifts it, in a terminal: forge limits lift 12 \(decision 127\)\.$/);
  assert.equal(pre(p.dir, { ...fix, description: 'API lane #13' }).decision, 'allow', 'another ticket');
  for (const t of ['code-reviewer', 'qa-engineer', 'security-reviewer']) assert.equal(pre(p.dir, { ...fix, subagent_type: t }).decision, 'allow', t);
});

test('two review rounds with blockers stop the next fix lane, a round written but not saved included; so do two QA fails', () => {
  const p = linked();
  p.save('reviews/12/code.md', report('CHANGES REQUESTED'));
  p.save('reviews/12/security.md', report('APPROVE'));
  assert.equal(pre(p.dir, fix).decision, 'allow', 'one round with a blocker');
  fs.writeFileSync(path.join(p.folder, 'reviews/12/code.md'), report('CHANGES REQUESTED').replace('abc1234', 'def5678'));
  let r = pre(p.dir, fix);
  assert.equal(r.decision, 'deny', 'the second round is on disk, not yet saved');
  assert.match(r.reason, /2 review rounds with blockers \(limit 2\)/);
  const q = linked();
  q.save('reviews/12/qa.md', '# QA (#12)\n\nVerdict: FAIL\nCommit: abc1234\n');
  q.save('reviews/12/qa.md', '# QA (#12)\n\nVerdict: FAIL\nCommit: def5678\n');
  r = pre(q.dir, fix);
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /2 QA fails \(limit 2\)/);
  assert.doesNotMatch(r.reason, /review rounds/, 'a QA fail is not a review blocker');
});

test('a lane naming no ticket asks; the plan its prompt names counts as its ticket', () => {
  const p = linked();
  for (let i = 0; i < 4; i++) p.lane(`a${i}`, 'frontend-engineer', '#12');
  let r = pre(p.dir, { subagent_type: 'frontend-engineer', description: 'quick fix', prompt: 'Change the button colour.' });
  assert.equal(r.decision, 'ask');
  assert.match(r.reason, /\[ticket:none\] This frontend-engineer lane names no ticket/);
  assert.equal(pre(p.dir, { subagent_type: 'frontend-engineer', description: 'quick fix', prompt: 'Change it.' }, { permission_mode: 'bypassPermissions' }).decision, 'deny', 'nobody to ask in bypassPermissions mode');
  r = pre(p.dir, { subagent_type: 'frontend-engineer', description: 'UI lane', prompt: 'Implement /x/.forge/project/plans/12-book.md exactly.' });
  assert.equal(r.decision, 'deny', 'plans/12-book.md: ticket #12, at its limit');
});

test('a person lifts a ticket\'s limit with forge limits lift; Claude cannot', () => {
  const p = linked();
  for (let i = 0; i < 4; i++) p.lane(`a${i}`, 'backend-engineer', '#12');
  assert.equal(pre(p.dir, fix).decision, 'deny');
  const bash = (command, extra = {}) => { const r = spawnSync('node', [BIN, 'pre-tool-use'], { input: JSON.stringify({ cwd: p.dir, permission_mode: 'default', transcript_path: '/nonexistent/s.jsonl', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...extra }), encoding: 'utf8', cwd: p.dir, env: { ...process.env, CLAUDE_PROJECT_DIR: p.dir } }); return JSON.parse(r.stdout || '{}')?.hookSpecificOutput ?? {}; };
  let h = bash('forge limits lift 12');
  assert.equal(h.permissionDecision, 'deny', 'not the lead');
  assert.match(h.permissionDecisionReason, /\[limits:lift\] Only a person lifts/);
  assert.equal(bash('forge limits lift 12', { agent_id: 'a9', agent_type: 'backend-engineer' }).permissionDecision, 'deny', 'not an agent');
  h = bash('forge limits');
  assert.notEqual(h.permissionDecision, 'deny', 'reading them is fine');
  const env = { ...process.env, CLAUDECODE: '' };
  let r = spawnSync('node', [FORGE, 'limits'], { cwd: p.dir, encoding: 'utf8', env });
  assert.match(r.stdout, /^Limits per ticket \(policy\.limits\): 4 engineer lanes, 2 review rounds with blockers, 2 QA fails\./);
  assert.match(r.stdout, /\n#12: lanes 4 of 4 · rounds with blockers 0 of 2 · QA fails 0 of 2 · at its limit: no more engineer lanes until a person lifts it \(forge limits lift 12\)\n/);
  r = spawnSync('node', [FORGE, 'limits', 'lift', '12'], { cwd: p.dir, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /#12 has one more allowance: now 8 engineer lanes, 4 review rounds with blockers, 4 QA fails\./);
  assert.equal(pre(p.dir, fix).decision, 'allow', 'lifted');
  for (let i = 4; i < 8; i++) p.lane(`a${i}`, 'backend-engineer', '#12');
  assert.equal(pre(p.dir, fix).decision, 'deny', 'one allowance, then a known worst case again');
  r = spawnSync('node', [FORGE, 'limits'], { cwd: p.dir, encoding: 'utf8', env });
  assert.match(r.stdout, /#12: lanes 8 of 8 .* \(lifted 1×\)/);
});

test('policy.limits: the defaults, a project\'s own numbers, and what is not a limit', async () => {
  const { loadConfig } = await import('../../core/policy/lib/config.mjs');
  const { writeProjectConfig } = await import('./helpers.mjs');
  const { dir } = makeRepo();
  assert.deepEqual(loadConfig(dir, {}).config.limits, { lanes: 4, blockerRounds: 2, qaFails: 2 });
  writeProjectConfig(dir, { policy: { ...DEFAULT_TEST_CONFIG, limits: { lanes: 6 } } });
  assert.deepEqual(loadConfig(dir, {}).config.limits, { lanes: 6, blockerRounds: 2, qaFails: 2 });
  writeProjectConfig(dir, { policy: { ...DEFAULT_TEST_CONFIG, limits: { lanes: 0, qaFails: 1.5 } } });
  const { errors } = loadConfig(dir, {});
  assert.ok(errors.includes('policy.limits.lanes must be a whole number, 1 or more'), errors.join('; '));
  assert.ok(errors.includes('policy.limits.qaFails must be a whole number, 1 or more'));
});
