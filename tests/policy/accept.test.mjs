// The lead accepts merged work on the person's word (decision 116): a done status from the base branch looks
// at the ticket's own branch, and a ticket with no branch asks the person instead of refusing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo, ctxFor, sh } from './helpers.mjs';
import { writeState, readState } from '../../core/policy/lib/context.mjs';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../core/policy/bin/forge-hook.mjs');

// project: the session's project folder (CLAUDE_PROJECT_DIR), when the call's cwd is elsewhere.
function pre(dir, command, extra = {}, project = dir) {
  const input = { cwd: dir, permission_mode: 'default', transcript_path: '/nonexistent/s.jsonl', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...extra };
  const r = spawnSync('node', [BIN, 'pre-tool-use'], { input: JSON.stringify(input), encoding: 'utf8', cwd: dir, env: { ...process.env, CLAUDE_PROJECT_DIR: project } });
  const out = r.stdout ? JSON.parse(r.stdout) : null;
  return { decision: out?.hookSpecificOutput?.permissionDecision ?? 'allow', reason: out?.hookSpecificOutput?.permissionDecisionReason ?? '' };
}

// feat/1-login with one commit whose gates passed (recorded as a lane's run records it), pushed; then back on dev.
function repoWithTicket({ ok = true } = {}) {
  const { dir } = makeRepo();
  fs.writeFileSync(path.join(dir, 'src/auth/login.ts'), 'export const login = 1\n');
  sh(dir, 'git', 'commit', '-q', '-am', 'feat(auth): login (#1)');
  sh(dir, 'git', 'push', '-q', '-u', 'origin', 'feat/1-login');
  const sha = sh(dir, 'git', 'rev-parse', 'HEAD');
  const ctx = ctxFor(dir);
  writeState(ctx, 'gates.json', { ...readState(ctx, 'gates.json', {}), [sha]: { ok, branch: 'feat/1-login', cmd: 'sh ./check.sh', at: new Date().toISOString() } });
  sh(dir, 'git', 'checkout', '-q', 'dev');
  return dir;
}
const merge = (dir) => {
  sh(dir, 'git', 'merge', '-q', '--no-ff', '-m', "Merge branch 'feat/1-login' into 'dev'", 'feat/1-login');
  sh(dir, 'git', 'push', '-q', 'origin', 'dev');
};

test('the lead on dev moves a ticket to Done once its own branch passed the gates and is merged', () => {
  const dir = repoWithTicket();
  let r = pre(dir, 'forge tracker status 1 Done --comment "Accepted by the owner"');
  assert.equal(r.decision, 'deny', 'not merged yet');
  assert.match(r.reason, /\[gates:done\].*feat\/1-login, but not on a commit merged into origin\/dev/);
  merge(dir);
  for (const c of ['forge tracker status 1 Done --comment "Accepted by the owner"', 'forge tracker status "#1" "In Testing"']) {
    r = pre(dir, c);
    assert.equal(r.decision, 'allow', `${c}: ${r.reason}`);
  }
  r = pre(dir, 'forge tracker status 1 Done && forge tracker status 2 Done');
  assert.equal(r.decision, 'ask', 'each ticket in the command is checked, not only the first');
  assert.match(r.reason, /#2 has no branch/);
  r = pre(dir, 'for i in 1; do forge tracker status $i Done; done');
  assert.equal(r.decision, 'deny', 'a loop hides the ticket');
  assert.match(r.reason, /name it by its number/);
  r = pre(dir, 'forge tracker status 1 "In Progress"');
  assert.equal(r.decision, 'allow', 'a status that is not done needs nothing');
});

test('a ticket whose branch never passed the gates stays refused, merged or not', () => {
  const dir = repoWithTicket({ ok: false });
  merge(dir);
  const r = pre(dir, 'forge tracker status 1 Done');
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /The gates have not passed on feat\/1-login/);
});

test('a ticket with no branch asks the person, in auto mode too; an agent is refused', () => {
  const dir = repoWithTicket();
  let r = pre(dir, 'forge tracker status 24 "In Testing" --comment "Team-repo work"');
  assert.equal(r.decision, 'ask', r.reason);
  assert.match(r.reason, /#24 has no branch in this repository/);
  r = pre(dir, 'forge tracker status 24 "In Testing"', { permission_mode: 'auto' });
  assert.equal(r.decision, 'ask', 'auto mode prompts for a hook\'s ask (decision 141)');
  r = pre(dir, 'forge tracker status 24 "In Testing"', { permission_mode: 'dontAsk' });
  assert.equal(r.decision, 'deny', 'nobody can approve in dontAsk mode');
  r = pre(dir, 'forge tracker status 24 Done', { agent_id: 'q1', agent_type: 'qa-engineer' });
  assert.equal(r.decision, 'deny', 'an agent never gets the question');
});

test('an agent in a detached worktree still needs its own branch, unless the ticket is merged', () => {
  const dir = repoWithTicket();
  sh(dir, 'git', 'checkout', '-q', '--detach', 'feat/1-login');
  const qa = { agent_id: 'q1', agent_type: 'qa-engineer' };
  let r = pre(dir, 'forge tracker status 1 "In Testing"', qa);
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /Detached HEAD/);
  sh(dir, 'git', 'checkout', '-q', 'dev');
  merge(dir);
  sh(dir, 'git', 'checkout', '-q', '--detach', 'origin/dev');
  r = pre(dir, 'forge tracker status 1 "In Testing"', qa);
  assert.equal(r.decision, 'allow', r.reason);
});

test('closing through glab or gh is the same claim, checked the same way', () => {
  const dir = repoWithTicket();
  for (const c of ['glab issue close 1', 'gh issue close 1', 'glab issue update 1 --unlabel "status::In Testing" --label status::Done', 'gh issue edit 1 --add-label "status:In Testing"']) {
    assert.equal(pre(dir, c).decision, 'deny', `${c}: not merged yet`);
  }
  merge(dir);
  assert.equal(pre(dir, 'glab issue close 1').decision, 'allow');
  assert.equal(pre(dir, 'glab issue close 24').decision, 'ask', 'no branch: the person is asked');
  assert.equal(pre(dir, 'glab issue update 24 --label status::Done', { agent_id: 'r1', agent_type: 'backend-engineer' }).decision, 'deny');
  assert.equal(pre(dir, 'glab issue update 1 --label "status::In Progress"').decision, 'allow', 'a status that is not done needs nothing');
  assert.equal(pre(dir, 'glab issue view 24').decision, 'allow');
});

test('from the team repo, and after a cd, the claim is checked in the project (the live run that closed #12)', () => {
  const dir = repoWithTicket();
  merge(dir);
  // #2: its branch passed the gates but is not merged.
  sh(dir, 'git', 'checkout', '-q', '-b', 'feat/2-paging', 'dev');
  fs.writeFileSync(path.join(dir, 'src/a.ts'), 'export const a = 2\n');
  sh(dir, 'git', 'add', 'src/a.ts');
  sh(dir, 'git', 'commit', '-q', '-m', 'feat: paging (#2)');
  const sha = sh(dir, 'git', 'rev-parse', 'HEAD');
  const ctx = ctxFor(dir);
  writeState(ctx, 'gates.json', { ...readState(ctx, 'gates.json', {}), [sha]: { ok: true, branch: 'feat/2-paging' } });
  sh(dir, 'git', 'checkout', '-q', 'dev');
  const team = fs.mkdtempSync(path.join(path.dirname(dir), 'team-'));
  sh(team, 'git', 'init', '-q', '-b', 'main');
  sh(team, 'git', 'commit', '-q', '--allow-empty', '-m', 'team repo');
  let r = pre(team, `cd ${dir} && forge tracker status 1 Done && forge tracker status 2 Done && forge tracker status 24 "In Testing"`, {}, dir);
  assert.equal(r.decision, 'deny', 'one question for #24 must not carry #2 through');
  assert.match(r.reason, /feat\/2-paging, but not on a commit merged/);
  r = pre(team, 'forge tracker status 2 Done', {}, dir);
  assert.equal(r.decision, 'deny', 'the team repo is not taken for the project');
  r = pre(team, 'forge tracker status 1 Done', {}, dir);
  assert.equal(r.decision, 'allow', r.reason);
  r = pre(dir, 'cd "$APP" && forge tracker status 1 Done');
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /folder the hook cannot read/);
});

test('work with no branch closes on its approving reviews (decision 120)', () => {
  const dir = repoWithTicket();
  const review = (name, verdict) => {
    fs.mkdirSync(path.join(dir, '.forge/project/reviews/24'), { recursive: true });
    fs.writeFileSync(path.join(dir, `.forge/project/reviews/24/${name}.md`), `# ${name} review (#24)\n\nVerdict: **${verdict}**\n`);
  };
  review('security', 'APPROVE');
  for (const who of [{}, { agent_id: 'q1', agent_type: 'qa-engineer' }]) {
    const r = pre(dir, 'forge tracker status 24 Done --comment "Team-repo work, reviewed"', who);
    assert.equal(r.decision, 'allow', r.reason);
  }
  review('code', 'CHANGES REQUESTED');
  let r = pre(dir, 'forge tracker status 24 Done');
  assert.equal(r.decision, 'ask', 'one review that does not approve: the person is asked');
  assert.match(r.reason, /its reviews do not all approve \(code: CHANGES REQUESTED\)/);
  r = pre(dir, 'forge tracker status 24 Done', { agent_id: 'q1', agent_type: 'qa-engineer' });
  assert.equal(r.decision, 'deny');
});
