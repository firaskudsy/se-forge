// forge export / forge import (decision 151): a project's work moves to another machine. Two "machines" here are two
// user configs and two clones of the same team repo and app, sharing their bare origins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sh, makeRepo, writeProjectConfig, DEFAULT_TEST_CONFIG } from '../policy/helpers.mjs';
import { sessionStart } from '../../core/policy/lib/handlers.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FORGE = path.join(KIT, 'core/cli/forge.mjs');
const HOOK = path.join(KIT, 'core/policy/bin/forge-hook.mjs');

function world() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-move-')));
  const repo = (dir) => { fs.mkdirSync(dir, { recursive: true }); sh(dir, 'git', 'init', '-q', '-b', 'main'); sh(dir, 'git', 'config', 'user.email', 't@e'); sh(dir, 'git', 'config', 'user.name', 't'); };
  for (const name of ['team', 'app']) {
    fs.mkdirSync(path.join(base, `${name}.git`));
    sh(path.join(base, `${name}.git`), 'git', 'init', '-q', '--bare', '-b', 'main');
  }
  const machine = (n) => {
    const home = path.join(base, `m${n}`);
    const team = path.join(home, 'se-forge-projects');
    const app = path.join(home, 'acme');
    const env = { ...process.env, HOME: home, FORGE_USER_CONFIG: path.join(home, 'config.json'), FORGE_CACHE_DIR: path.join(home, 'cache') };
    const forge = (args, cwd = app) => { const r = spawnSync('node', [FORGE, ...args], { cwd, env, encoding: 'utf8' }); return { code: r.status, out: `${r.stdout}${r.stderr}` }; };
    return { home, team, app, env, forge };
  };
  // Machine 1 starts the project and pushes both repositories.
  const m1 = machine(1);
  repo(m1.team);
  fs.writeFileSync(path.join(m1.team, 'README.md'), '# team\n');
  sh(m1.team, 'git', 'add', '.'); sh(m1.team, 'git', 'commit', '-q', '-m', 'init');
  sh(m1.team, 'git', 'remote', 'add', 'origin', path.join(base, 'team.git')); sh(m1.team, 'git', 'push', '-q', '-u', 'origin', 'main');
  repo(m1.app);
  fs.writeFileSync(path.join(m1.app, 'README.md'), '# acme\n');
  sh(m1.app, 'git', 'add', '.'); sh(m1.app, 'git', 'commit', '-q', '-m', 'app');
  sh(m1.app, 'git', 'remote', 'add', 'origin', path.join(base, 'app.git')); sh(m1.app, 'git', 'push', '-q', '-u', 'origin', 'main');
  assert.equal(m1.forge(['setup', '--team-repo', m1.team]).code, 0);
  const init = m1.forge(['init', '--project', 'acme', '--new']);
  assert.equal(init.code, 0, init.out);
  assert.equal(m1.forge(['save', '-m', 'new project']).code, 0);
  return { base, m1, m2: machine(2) };
}

const STATE = { 'timeline-2026-10.jsonl': '{"at":"2026-10-30T10:00:00.000Z","event":"tool.start","who":"lead","tool":"Bash"}\n', 'approvals.json': '{"approvals":[]}\n', 'spawns/a1.json': '{"ticket":"#15"}\n', 'dashboard.html': '<html>', 'llm.json': '{"server":"qwen"}\n' };
function work(app) {
  for (const [f, text] of Object.entries(STATE)) { fs.mkdirSync(path.dirname(path.join(app, '.forge/state', f)), { recursive: true }); fs.writeFileSync(path.join(app, '.forge/state', f), text); }
}

test('forge export: refuses while the work is not paused, saved and pushed, naming the step for each; then one file, with no machine files, and the checkout marked as moved', () => {
  const { m1 } = world();
  work(m1.app);
  fs.writeFileSync(path.join(m1.team, 'acme', 'plans-note.md'), 'not saved\n');
  sh(m1.app, 'git', 'checkout', '-q', '-b', 'feat/15-sign-up');
  fs.writeFileSync(path.join(m1.app, 'a.txt'), 'a\n');
  sh(m1.app, 'git', 'add', 'a.txt'); sh(m1.app, 'git', 'commit', '-q', '-m', 'feat: only here');
  fs.writeFileSync(path.join(m1.app, 'b.txt'), 'not committed\n');
  let r = m1.forge(['export']);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /Not ready to move acme:/);
  assert.match(r.out, /No lead handover to continue from: \/pause in the lead's session writes \.forge\/handoffs\/lead-handover\.md/);
  assert.match(r.out, /The team repo has changes not saved: forge save \(1 file\)/);
  assert.match(r.out, /This checkout has changes not committed \(1\)/);
  assert.match(r.out, /Branch feat\/15-sign-up has 1 commit on no remote: git push -u origin feat\/15-sign-up/);
  assert.ok(!fs.readdirSync(m1.home).some((f) => f.endsWith('.tgz')), 'nothing written');
  r = m1.forge(['export', '--check']);
  assert.equal(r.code, 1);
  assert.match(r.out, /^Not ready to move acme:\n- No lead handover/);

  fs.writeFileSync(path.join(m1.app, '.forge/handoffs/lead-handover.md'), '# Lead handover\nKit: 0.2.47\n## Remaining\n- #15\n');
  assert.equal(m1.forge(['save', '-m', 'pause']).code, 0);
  fs.rmSync(path.join(m1.app, 'b.txt'));
  sh(m1.app, 'git', 'push', '-q', '-u', 'origin', 'feat/15-sign-up');
  fs.mkdirSync(path.dirname(m1.env.FORGE_USER_CONFIG), { recursive: true });
  const cfg = JSON.parse(fs.readFileSync(m1.env.FORGE_USER_CONFIG, 'utf8'));
  fs.writeFileSync(m1.env.FORGE_USER_CONFIG, JSON.stringify({ ...cfg, kitRepo: 'https://example.com/se-forge.git', llm: { qwen: { url: 'https://gpu.example.com', models: { opus: 'qwen-27b', sonnet: 'qwen-27b', haiku: 'qwen-27b' }, context: 262144 } } }));
  r = m1.forge(['export', '--check']);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out.trim(), 'Ready to move acme.\nforge export would carry 1 handover files and 3 state files, and name the model server qwen (not its key).');
  assert.ok(!fs.existsSync(path.join(m1.app, '.forge/state/exported.json')), '--check writes nothing');
  r = m1.forge(['export']);
  assert.equal(r.code, 0, r.out);
  const file = /exported acme: (\S+\.tgz)/.exec(r.out)?.[1];
  assert.ok(file && fs.existsSync(file) && path.dirname(file) === m1.home, r.out);
  assert.match(r.out, /\(\d+\.\d MB: 1 handover files, 3 state files; no key, no \.env\)/);
  assert.match(r.out, /This checkout is marked as moved: its lead starts nothing here/);
  assert.match(r.out, /3\. git clone .*app\.git ~\/code\/acme && cd ~\/code\/acme\n {2}4\. forge import ~\/acme-forge-\d{8}-\d{4}\.tgz/);
  assert.match(r.out, /forge setup --team-repo ~\/code\/se-forge-projects --kit-repo https:\/\/example\.com\/se-forge\.git/);
  const list = sh(m1.home, 'tar', '-tzf', file).split('\n').map((l) => l.replace(/\/$/, ''));
  for (const f of ['acme/forge-export.json', 'acme/handoffs/lead-handover.md', 'acme/state/timeline-2026-10.jsonl', 'acme/state/approvals.json', 'acme/state/spawns/a1.json']) assert.ok(list.includes(f), `${f} in ${list.join(', ')}`);
  for (const f of ['acme/state/dashboard.html', 'acme/state/llm.json', 'acme/state/sync-manifest.json', 'acme/state/settings-managed.json', 'acme/state/roles.json']) assert.ok(!list.includes(f), `${f} is this machine's`);
  assert.ok(fs.existsSync(path.join(m1.app, '.forge/state/exported.json')));
  const lead = sessionStart({ cwd: m1.app, source: 'startup' }, { ...m1.env }).hookSpecificOutput.additionalContext;
  assert.match(lead, /^MOVED: this project was exported on \d{4}-\d\d-\d\d \d\d:\d\d UTC \(forge export\) and runs on another machine now\. Start nothing here/);
});

test('forge import: in a clone on the other machine, it links the project, puts back the handovers and state, and lists what is the owner\'s; refusals name the fix', () => {
  const { base, m1, m2 } = world();
  work(m1.app);
  fs.writeFileSync(path.join(m1.app, '.forge/handoffs/lead-handover.md'), '# Lead handover\n');
  const cfg = JSON.parse(fs.readFileSync(m1.env.FORGE_USER_CONFIG, 'utf8'));
  fs.writeFileSync(m1.env.FORGE_USER_CONFIG, JSON.stringify({ ...cfg, llm: { qwen: { url: 'https://gpu.example.com', models: { opus: 'q-big', sonnet: 'q-big', haiku: 'q-small' }, context: 262144 } } }));
  const ex = m1.forge(['export', '--out', path.join(base, 'acme.tgz')]);
  assert.equal(ex.code, 0, ex.out);
  const file = path.join(base, 'acme.tgz');

  // The other machine: a clone of the app, no team repo yet.
  fs.mkdirSync(m2.home, { recursive: true });
  sh(m2.home, 'git', 'clone', '-q', path.join(base, 'app.git'), m2.app);
  let r = m2.forge(['import', file]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /No team repo on this machine yet\. First:\n {2}git clone .*team\.git ~\/code\/se-forge-projects\n {2}forge setup --team-repo ~\/code\/se-forge-projects/);
  sh(m2.home, 'git', 'clone', '-q', path.join(base, 'team.git'), m2.team);
  assert.equal(m2.forge(['setup', '--team-repo', m2.team]).code, 0);
  // A clone of another app is refused.
  const other = path.join(m2.home, 'other');
  fs.mkdirSync(other); sh(other, 'git', 'init', '-q', '-b', 'main'); sh(other, 'git', 'remote', 'add', 'origin', 'git@gitlab.example.com:g/other.git');
  r = m2.forge(['import', file], other);
  assert.equal(r.code, 2);
  assert.match(r.out, /This checkout's origin is git@gitlab\.example\.com:g\/other\.git, but acme was exported from a clone of .*app\.git/);

  r = m2.forge(['import', file]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /linked \.forge\/project -> .*se-forge-projects\/acme/);
  assert.match(r.out, /imported acme, exported \d{4}-\d\d-\d\d \d\d:\d\d UTC: 1 handover files and 3 state files\./);
  assert.equal(fs.realpathSync(path.join(m2.app, '.forge/project')), fs.realpathSync(path.join(m2.team, 'acme')));
  assert.equal(fs.readFileSync(path.join(m2.app, '.forge/state/timeline-2026-10.jsonl'), 'utf8'), STATE['timeline-2026-10.jsonl']);
  assert.ok(fs.existsSync(path.join(m2.app, '.forge/state/spawns/a1.json')));
  assert.ok(fs.existsSync(path.join(m2.app, '.forge/handoffs/lead-handover.md')));
  assert.ok(!fs.existsSync(path.join(m2.app, '.forge/state/exported.json')));
  assert.ok(!fs.existsSync(path.join(m2.app, '.forge/state/llm.json')), 'the model server is this machine\'s choice');
  assert.match(r.out, /Your turn, in this order:\n {2}1\. copy the key of the model server qwen from the other machine \(it is never exported\) to ~\/\.config\/se-forge\/llm-qwen-key, then chmod 600 it\n {2}2\. forge llm add qwen --url https:\/\/gpu\.example\.com --opus q-big --sonnet q-big --haiku q-small --context 262144\n {2}3\. forge llm use qwen/);
  assert.match(r.out, /\. forge doctor\n {2}\d\. tmux new -s acme, then claude, then \/resume/);
  assert.equal(sh(m2.app, 'git', 'status', '--porcelain'), '', 'nothing of the kit in the app\'s files');

  // Again over its own history: only with --force.
  r = m2.forge(['import', file]);
  assert.equal(r.code, 2);
  assert.match(r.out, /already has a history of its own .*forge import --force replaces it/);
  assert.equal(m2.forge(['import', file, '--force']).code, 0);

  // Back on the first machine, the checkout it was exported from takes it back without --force.
  r = m1.forge(['import', file]);
  assert.equal(r.code, 0, r.out);
  assert.ok(!fs.existsSync(path.join(m1.app, '.forge/state/exported.json')));
  assert.doesNotMatch(r.out, /forge llm add/, 'this machine knows the server already');
  assert.match(r.out, /1\. forge llm use qwen/);
});

test('the hook refuses forge export and forge import from Claude: moving a project is a person\'s', () => {
  const { dir } = makeRepo();
  writeProjectConfig(dir, { project: { name: 'acme' }, policy: { ...DEFAULT_TEST_CONFIG } });
  for (const command of ['forge export', 'forge import ~/acme-forge.tgz --force']) {
    const r = spawnSync('node', [HOOK, 'pre-tool-use'], { input: JSON.stringify({ cwd: dir, transcript_path: '/nonexistent/s.jsonl', permission_mode: 'auto', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }), encoding: 'utf8', cwd: dir, env: { ...process.env, HOME: '/Users/dev' } });
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, 'deny', command);
    assert.match(out.permissionDecisionReason, /\[move:person\] Only a person moves a project to another machine \(decision 151\)/);
  }
});
