// forge delete (decision 152): a project leaves the team repo in one pushed commit, and the checkout it runs in is
// unlinked, leaving the developer's own settings and hooks as they were. Two "machines" share bare origins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sh, makeRepo, writeProjectConfig, DEFAULT_TEST_CONFIG } from '../policy/helpers.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FORGE = path.join(KIT, 'core/cli/forge.mjs');
const HOOK = path.join(KIT, 'core/policy/bin/forge-hook.mjs');
const git = (dir, ...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).stdout.trim();

function world() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-delete-')));
  const repo = (dir) => { fs.mkdirSync(dir, { recursive: true }); sh(dir, 'git', 'init', '-q', '-b', 'main'); sh(dir, 'git', 'config', 'user.email', 't@e'); sh(dir, 'git', 'config', 'user.name', 't'); };
  for (const name of ['team', 'app']) { fs.mkdirSync(path.join(base, `${name}.git`)); sh(path.join(base, `${name}.git`), 'git', 'init', '-q', '--bare', '-b', 'main'); }
  const machine = (n) => {
    const home = path.join(base, `m${n}`);
    const team = path.join(home, 'se-forge-projects');
    const app = path.join(home, 'acme');
    const env = { ...process.env, HOME: home, FORGE_USER_CONFIG: path.join(home, 'config.json'), FORGE_CACHE_DIR: path.join(home, 'cache') };
    const forge = (args, cwd = app) => { const r = spawnSync('node', [FORGE, ...args], { cwd, env, encoding: 'utf8' }); return { code: r.status, out: `${r.stdout}${r.stderr}` }; };
    return { home, team, app, env, forge };
  };
  const m1 = machine(1);
  repo(m1.team);
  fs.writeFileSync(path.join(m1.team, 'README.md'), '# team\n');
  sh(m1.team, 'git', 'add', '.'); sh(m1.team, 'git', 'commit', '-q', '-m', 'init');
  sh(m1.team, 'git', 'remote', 'add', 'origin', path.join(base, 'team.git')); sh(m1.team, 'git', 'push', '-q', '-u', 'origin', 'main');
  repo(m1.app);
  fs.writeFileSync(path.join(m1.app, 'README.md'), '# acme\n');
  sh(m1.app, 'git', 'add', '.'); sh(m1.app, 'git', 'commit', '-q', '-m', 'app');
  sh(m1.app, 'git', 'remote', 'add', 'origin', path.join(base, 'app.git')); sh(m1.app, 'git', 'push', '-q', '-u', 'origin', 'main');
  // The developer's own settings and hooks, from before the kit.
  fs.mkdirSync(path.join(m1.app, '.claude'));
  fs.writeFileSync(path.join(m1.app, '.claude/settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(make *)'] } }));
  sh(m1.app, 'git', 'config', 'core.hooksPath', '.husky');
  assert.equal(m1.forge(['setup', '--team-repo', m1.team]).code, 0);
  const init = m1.forge(['init', '--project', 'acme', '--new']);
  assert.equal(init.code, 0, init.out);
  assert.equal(m1.forge(['save', '-m', 'new project']).code, 0);
  return { base, m1, m2: machine(2) };
}

test('forge delete: says what would go until the name is typed, refuses unsaved work, then one pushed commit and the checkout as it was before forge init', () => {
  const { base, m1 } = world();
  const before = git(path.join(base, 'team.git'), 'rev-parse', 'main');
  let r = m1.forge(['delete', 'acme']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /forge delete acme would:\n {2}- remove acme\/ from the team repo .*se-forge-projects \(\d+ files in git\) in one commit, and push it/);
  assert.match(r.out, /- unlink this checkout \(.*acme\): \.forge\/ \(its handovers and its history/);
  assert.match(r.out, /It never touches the app's repository on its host or its tracker issues\./);
  assert.match(r.out, /To delete it, type its name: forge delete acme --confirm acme/);
  assert.ok(fs.existsSync(path.join(m1.team, 'acme/project.json')) && fs.existsSync(path.join(m1.app, '.forge/project')), 'nothing changed');

  fs.writeFileSync(path.join(m1.team, 'acme/note.md'), 'not saved\n');
  fs.mkdirSync(path.join(m1.app, '.claude/worktrees/agent-a1'), { recursive: true });
  r = m1.forge(['delete', 'acme', '--confirm', 'acme']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Not yet:\n {2}- 1 change in acme\/ is not saved, so git history will not have it either: forge save first, or add --force to lose it\./);
  assert.match(r.out, /- Agents' worktrees are still in \.claude\/worktrees: forge worktrees --clean removes the done ones\./);
  assert.ok(fs.existsSync(path.join(m1.team, 'acme/project.json')), 'still there');
  fs.rmSync(path.join(m1.app, '.claude/worktrees'), { recursive: true });
  assert.equal(m1.forge(['save']).code, 0);
  r = m1.forge(['delete', 'acme', '--confirm', 'acme-portal']);
  assert.equal(r.code, 2);
  assert.match(r.out, /--confirm must be the project's name: --confirm acme/);

  r = m1.forge(['delete', 'acme', '--confirm', 'acme']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /forge delete acme will:/);
  assert.match(r.out, /unlinked .*acme: removed \.forge\/ and \d+ files forge wrote\n/);
  const commit = /deleted acme from the team repo and pushed \(commit (\w+)\)/.exec(r.out)?.[1];
  assert.ok(commit, r.out);
  assert.ok(!fs.existsSync(path.join(m1.team, 'acme')));
  assert.equal(git(path.join(base, 'team.git'), 'log', '-1', '--format=%s', 'main'), 'acme: delete the project (forge delete)');
  assert.notEqual(git(path.join(base, 'team.git'), 'rev-parse', 'main'), before);
  // The checkout: no kit file left; the developer's settings and hooks path as they were.
  assert.ok(!fs.existsSync(path.join(m1.app, '.forge')));
  assert.deepEqual(fs.readdirSync(path.join(m1.app, '.claude')), ['settings.local.json']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(m1.app, '.claude/settings.local.json'), 'utf8')), { permissions: { allow: ['Bash(make *)'] } });
  assert.equal(git(m1.app, 'config', '--local', '--get', 'core.hooksPath'), '.husky');
  assert.equal(git(m1.app, 'config', '--local', '--get', 'se-forge.previousHooksPath'), '');
  assert.doesNotMatch(fs.readFileSync(path.join(m1.app, '.git/info/exclude'), 'utf8'), /se-forge/);

  // The line it prints brings the project back.
  const back = new RegExp(`To bring it back: git -C (.+) revert --no-edit ${commit} && git -C .+ push, then forge init --project acme in (.+)`).exec(r.out);
  assert.ok(back, r.out);
  sh(m1.team, 'git', 'revert', '--no-edit', commit); sh(m1.team, 'git', 'push', '-q');
  const again = m1.forge(['init', '--project', 'acme']);
  assert.equal(again.code, 0, again.out);
  assert.ok(fs.existsSync(path.join(m1.app, '.forge/project/project.json')));
});

test('forge delete on another machine: behind the remote it says to pull; after the pull it only unlinks that checkout', () => {
  const { base, m1, m2 } = world();
  fs.mkdirSync(m2.home, { recursive: true });
  sh(m2.home, 'git', 'clone', '-q', path.join(base, 'team.git'), m2.team);
  sh(m2.home, 'git', 'clone', '-q', path.join(base, 'app.git'), m2.app);
  for (const d of [m2.team, m2.app]) { sh(d, 'git', 'config', 'user.email', 't@e'); sh(d, 'git', 'config', 'user.name', 't'); }
  assert.equal(m2.forge(['setup', '--team-repo', m2.team]).code, 0);
  assert.equal(m2.forge(['init', '--project', 'acme']).code, 0);
  assert.equal(m2.forge(['delete', 'nope']).code, 2);
  // From outside any checkout: the team repo only, and a word about linked checkouts.
  let r = m1.forge(['delete', 'acme'], m1.home);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /unlink this checkout/);
  assert.match(r.out, /A checkout linked to acme keeps its link: after a pull of the team repo, run forge delete acme in it to unlink it\./);
  r = m1.forge(['delete', 'acme', '--confirm', 'acme'], m1.home);
  assert.equal(r.code, 0, r.out);
  assert.ok(fs.lstatSync(path.join(m1.app, '.forge/project'), { throwIfNoEntry: false })?.isSymbolicLink(), 'm1\'s checkout keeps its link: it ran elsewhere');

  r = m2.forge(['delete', 'acme', '--confirm', 'acme']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /The team repo is behind its remote: git -C .* pull --rebase, then run this again\./);
  sh(m2.team, 'git', 'pull', '-q');
  const head = git(m2.team, 'rev-parse', 'HEAD');
  r = m2.forge(['delete', 'acme', '--confirm', 'acme']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /\(acme\/ is already gone from the team repo/);
  assert.ok(!fs.existsSync(path.join(m2.app, '.forge')));
  assert.equal(git(m2.team, 'rev-parse', 'HEAD'), head, 'no commit');
});

test('the hook refuses forge delete from Claude: a project leaving the team repo is a person\'s call', () => {
  const { dir } = makeRepo();
  writeProjectConfig(dir, { project: { name: 'acme' }, policy: { ...DEFAULT_TEST_CONFIG } });
  for (const command of ['forge delete acme', 'forge delete acme --confirm acme --force']) {
    const r = spawnSync('node', [HOOK, 'pre-tool-use'], { input: JSON.stringify({ cwd: dir, transcript_path: '/nonexistent/s.jsonl', permission_mode: 'auto', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }), encoding: 'utf8', cwd: dir, env: { ...process.env, HOME: '/Users/dev' } });
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, 'deny', command);
    assert.match(out.permissionDecisionReason, /\[delete:person\] Only a person deletes a project \(decision 152\)/);
  }
});
