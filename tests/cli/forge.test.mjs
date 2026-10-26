// forge init / sync / upgrade / doctor / save / handover against throwaway repos: a client checkout,
// a team repo with a bare "origin", a kit repo with version tags, and an isolated user config and cache.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sh } from '../policy/helpers.mjs';
import { makeContext } from '../../core/policy/lib/context.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FORGE = path.join(KIT, 'core/cli/forge.mjs');
const VERSION = fs.readFileSync(path.join(KIT, 'VERSION'), 'utf8').trim();

// A kit repo with two tagged versions: the current one, and a next one whose planner differs.
function kitRepo(base) {
  const dir = path.join(base, 'kit-src');
  for (const part of ['core', 'adapters', 'VERSION', 'package.json']) fs.cpSync(path.join(KIT, part), path.join(dir, part), { recursive: true });
  sh(dir, 'git', 'init', '-q', '-b', 'main');
  sh(dir, 'git', 'config', 'user.email', 't@e'); sh(dir, 'git', 'config', 'user.name', 't');
  sh(dir, 'git', 'add', '.'); sh(dir, 'git', 'commit', '-q', '-m', `kit ${VERSION}`); sh(dir, 'git', 'tag', `v${VERSION}`);
  fs.writeFileSync(path.join(dir, 'VERSION'), '9.9.0\n');
  const planner = path.join(dir, 'core/roles/planner.md');
  // The next version drops a skill, and with it the planner's preload of it (decision 137), as a real version would.
  fs.writeFileSync(planner, fs.readFileSync(planner, 'utf8').replace('You are the **planner**', 'You are the **planner** (kit 9.9.0)').replace(/^(skills: .*?), figma-align/m, '$1'));
  fs.rmSync(path.join(dir, 'core/skills/figma-align'), { recursive: true });
  sh(dir, 'git', 'commit', '-q', '-am', 'kit 9.9.0'); sh(dir, 'git', 'tag', 'v9.9.0');
  return dir;
}

function world() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cli-')));
  const repo = (dir, bare) => {
    fs.mkdirSync(dir, { recursive: true });
    sh(dir, 'git', 'init', '-q', ...(bare ? ['--bare'] : ['-b', 'main']));
    if (!bare) { sh(dir, 'git', 'config', 'user.email', 't@e'); sh(dir, 'git', 'config', 'user.name', 't'); }
  };
  const team = path.join(base, 'se-forge-projects');
  repo(`${team}.git`, true); repo(team);
  fs.writeFileSync(path.join(team, 'README.md'), '# team\n');
  sh(team, 'git', 'add', '.'); sh(team, 'git', 'commit', '-q', '-m', 'init');
  sh(team, 'git', 'remote', 'add', 'origin', `${team}.git`); sh(team, 'git', 'push', '-q', '-u', 'origin', 'main');
  const client = path.join(base, 'client');
  repo(client);
  fs.writeFileSync(path.join(client, 'CLAUDE.md'), '# Client rules\n');
  fs.mkdirSync(path.join(client, '.claude/agents'), { recursive: true });
  fs.writeFileSync(path.join(client, '.claude/settings.json'), '{"permissions":{"allow":["Bash(make test)"]}}\n');
  fs.writeFileSync(path.join(client, '.claude/agents/client-helper.md'), '---\nname: client-helper\ndescription: theirs\n---\nx\n');
  sh(client, 'git', 'add', '.'); sh(client, 'git', 'commit', '-q', '-m', 'client');
  const env = { ...process.env, FORGE_USER_CONFIG: path.join(base, 'user', 'config.json'), FORGE_CACHE_DIR: path.join(base, 'cache') };
  const forge = (args, cwd = client) => {
    const r = spawnSync('node', [FORGE, ...args], { cwd, env, encoding: 'utf8' });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const ready = () => { forge(['setup', '--team-repo', team]); const r = forge(['init', '--project', 'acme-portal', '--new', '--client', 'Acme']); assert.equal(r.code, 0, r.out); };
  return { base, team, client, env, forge, ready };
}

const gitClean = (dir) => sh(dir, 'git', 'status', '--porcelain');

test('init refuses clearly before setup and without a project', () => {
  const w = world();
  assert.equal(w.forge(['init', '--project', 'acme-portal']).code, 2);
  w.forge(['setup', '--team-repo', w.team]);
  assert.match(w.forge(['init']).out, /needs --project/);
  assert.match(w.forge(['init', '--project', 'acme-portal']).out, /Use --new/);
});

test('init copies the kit into the checkout without leaving a trace in git', () => {
  const w = world();
  w.ready();
  assert.equal(gitClean(w.client), '', 'nothing new is visible to git');
  assert.equal(fs.readFileSync(path.join(w.client, 'CLAUDE.md'), 'utf8'), '# Client rules\n', 'client files untouched');
  assert.ok(fs.existsSync(path.join(w.client, '.claude/agents/client-helper.md')), "the client's own agent stays");
  for (const f of ['.claude/agents/planner.md', '.claude/agents/frontend-engineer.md', '.claude/skills/pipeline/SKILL.md', '.claude/commands/resume.md', '.forge/kit/core/policy/bin/forge-hook.mjs', '.forge/kit/VERSION']) {
    assert.ok(fs.existsSync(path.join(w.client, f)), f);
  }
  const settings = JSON.parse(fs.readFileSync(path.join(w.client, '.claude/settings.local.json'), 'utf8'));
  assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /\.forge\/kit\/core\/policy\/bin\/forge-hook\.mjs" pre-tool-use \|\| exit 2/);
  for (const b of ['dev', 'staging', 'main', 'master']) assert.ok(settings.permissions.deny.includes(`Bash(git push origin ${b}*)`), b);
  assert.equal(settings.disableClaudeAiConnectors, true, "the person's claude.ai connectors stay out of the project (decision 91)");
  assert.equal(settings.autoCompactWindow, 200000, 'the window sits 100k past the lead handover line (decision 93)');
  const timelineHooks = { UserPromptSubmit: 'user-prompt-submit', PostToolUseFailure: 'post-tool-use-failure', PermissionDenied: 'permission-denied', StopFailure: 'stop-failure', PreCompact: 'pre-compact', PostCompact: 'post-compact', SessionEnd: 'session-end' };
  for (const [event, name] of Object.entries(timelineHooks)) assert.match(settings.hooks[event][0].hooks[0].command, new RegExp(`forge-hook\\.mjs" ${name}$`), `${event} feeds the timeline (decision 96)`);
  const excludes = fs.readFileSync(path.join(w.client, '.git/info/exclude'), 'utf8');
  assert.match(excludes, /^\/\.claude\/agents\/planner\.md$/m, 'exact paths are excluded');
  assert.match(excludes, /^\/\.claude\/skills\/pipeline\/$/m);
  assert.doesNotMatch(excludes, /^\/\.claude\/agents\/$/m, "the client's own .claude/agents stays visible");
  const ctx = makeContext({ cwd: w.client }, { HOME: os.homedir() });
  assert.equal(ctx.project.name, 'acme-portal');
  fs.writeFileSync(path.join(w.client, '.claude/agents/new-client-agent.md'), 'x');
  assert.match(gitClean(w.client), /new-client-agent/, 'new client files in .claude/ are still visible to git');
});

test('init creates dev and staging from main, never pushes them, and doctor reports what origin lacks (decision 74)', () => {
  const w = world();
  const origin = path.join(w.base, 'client.git');
  sh(w.base, 'git', 'init', '-q', '--bare', origin);
  sh(w.client, 'git', 'remote', 'add', 'origin', origin);
  sh(w.client, 'git', 'push', '-q', '-u', 'origin', 'main');
  w.forge(['setup', '--team-repo', w.team]);
  const r = w.forge(['init', '--project', 'acme-portal', '--new']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /created branches dev \(from main\), staging \(from main\)/);
  assert.match(r.out, /git push -u origin dev staging/);
  const main = sh(w.client, 'git', 'rev-parse', 'main');
  for (const b of ['dev', 'staging']) assert.equal(sh(w.client, 'git', 'rev-parse', b), main, b);
  assert.equal(sh(origin, 'git', 'for-each-ref', '--format=%(refname:short)', 'refs/heads'), 'main', 'nothing pushed');
  assert.equal(sh(w.client, 'git', 'branch', '--show-current'), 'main', 'the checkout stays where it was');
  const doc = w.forge(['doctor']).out;
  assert.match(doc, /! branches missing on origin: dev, staging/);
  assert.match(doc, /^[✓!] Docker (Compose \S+ \(the app|with Compose v2 is not available)/m, 'doctor reports Docker Compose either way');
  sh(w.client, 'git', 'push', '-q', 'origin', 'dev', 'staging');
  sh(w.client, 'git', 'fetch', '-q', 'origin');
  assert.match(w.forge(['doctor']).out, /✓ branches dev, staging, main on origin/);
  assert.doesNotMatch(w.forge(['init', '--project', 'acme-portal']).out, /created branches/, 'a second init creates nothing');
});

test('sync is idempotent and overrides in the team repo win', () => {
  const w = world();
  w.ready();
  const kitDir = path.join(w.team, 'acme-portal/kit');
  fs.mkdirSync(path.join(kitDir, 'roles'), { recursive: true });
  fs.writeFileSync(path.join(kitDir, 'roles/planner.md'), '---\nname: planner\ndescription: Acme planner\ntier: deep\naccess: docs\n---\nYou plan for Acme.\n');
  fs.writeFileSync(path.join(kitDir, 'roles/rtl-checker.md'), '---\nname: rtl-checker\ndescription: Checks RTL\ntier: standard\naccess: read-only\n---\nCheck RTL.\n');
  fs.mkdirSync(path.join(kitDir, 'skills/acme-deploy'), { recursive: true });
  fs.writeFileSync(path.join(kitDir, 'skills/acme-deploy/SKILL.md'), '---\nname: acme-deploy\ndescription: Acme deploy notes\n---\nNotes.\n');
  fs.writeFileSync(path.join(kitDir, 'rules.md'), 'Acme forbids Friday deploys.\n');
  const r = w.forge(['sync']);
  assert.equal(r.code, 0, r.out);
  assert.match(fs.readFileSync(path.join(w.client, '.claude/agents/planner.md'), 'utf8'), /You plan for Acme\./);
  assert.match(fs.readFileSync(path.join(w.client, '.claude/agents/rtl-checker.md'), 'utf8'), /disallowedTools: Edit, NotebookEdit/);
  assert.ok(fs.existsSync(path.join(w.client, '.claude/skills/acme-deploy/SKILL.md')));
  const roles = JSON.parse(fs.readFileSync(path.join(w.client, '.forge/state/roles.json'), 'utf8'));
  assert.equal(roles['rtl-checker'], 'read-only', 'the policy learns the access of override roles');
  assert.equal(gitClean(w.client), '');
  assert.equal(w.forge(['sync']).code, 0, 'a second sync changes nothing');
});

test('sync writes each agent\'s preloaded skills, with the guides of the project\'s stack (decision 137)', () => {
  const w = world();
  w.ready();
  const pj = path.join(w.team, 'acme-portal/project.json');
  const config = JSON.parse(fs.readFileSync(pj, 'utf8'));
  config.project.stack = { ...config.project.stack, backend: 'NestJS 11', frontend: 'React 19', database: 'PostgreSQL 16' };
  fs.writeFileSync(pj, `${JSON.stringify(config, null, 2)}\n`);
  const kitDir = path.join(w.team, 'acme-portal/kit');
  fs.mkdirSync(path.join(kitDir, 'skills/acme-deploy'), { recursive: true });
  fs.writeFileSync(path.join(kitDir, 'skills/acme-deploy/SKILL.md'), '---\nname: acme-deploy\ndescription: Acme deploy notes\n---\nNotes.\n');
  fs.mkdirSync(path.join(kitDir, 'roles'), { recursive: true });
  fs.writeFileSync(path.join(kitDir, 'roles/acme-deployer.md'), '---\nname: acme-deployer\ndescription: Deploys Acme\ntier: standard\naccess: code\nskills: acme-deploy, @backend\n---\nDeploy.\n');
  const r = w.forge(['sync']);
  assert.equal(r.code, 0, r.out);
  const agent = (name) => fs.readFileSync(path.join(w.client, `.claude/agents/${name}.md`), 'utf8').split('\n---\n')[0];
  assert.match(agent('backend-engineer'), /\nskills:\n  - stack-nestjs\n  - db-postgresql\n  - new-endpoint$/);
  assert.match(agent('code-reviewer'), /\nskills:\n  - stack-nestjs\n  - stack-react\n  - db-postgresql$/);
  assert.match(agent('acme-deployer'), /\nskills:\n  - acme-deploy\n  - stack-nestjs$/, 'a project\'s own role preloads its own skill');
  // A typo in a project's role stops the sync with the reason, and leaves the agents as they were.
  fs.writeFileSync(path.join(kitDir, 'roles/acme-deployer.md'), '---\nname: acme-deployer\ndescription: Deploys Acme\ntier: standard\naccess: code\nskills: acme-deplo\n---\nDeploy.\n');
  const bad = w.forge(['sync']);
  assert.notEqual(bad.code, 0);
  assert.match(bad.out, /skills names acme-deplo, which is not a skill/);
  assert.match(agent('acme-deployer'), /  - acme-deploy\n/);
});

test('sync refuses to overwrite a generated file edited in place, and a client file with the same name', () => {
  const w = world();
  w.ready();
  fs.appendFileSync(path.join(w.client, '.claude/agents/planner.md'), '\nlocal tweak\n');
  let r = w.forge(['sync']);
  assert.equal(r.code, 2);
  assert.match(r.out, /planner\.md was edited in place; move the change to .*acme-portal\/kit/);
  assert.match(w.forge(['doctor']).out, /✗ generated files missing or edited in place: \.claude\/agents\/planner\.md/);
  assert.equal(w.forge(['sync', '--force']).code, 0);
  sh(w.client, 'git', 'rm', '-q', '--cached', '.claude/agents/client-helper.md');
  fs.writeFileSync(path.join(w.client, '.claude/agents/client-helper.md'), 'theirs, untracked');
  const kitDir = path.join(w.team, 'acme-portal/kit/roles');
  fs.mkdirSync(kitDir, { recursive: true });
  fs.writeFileSync(path.join(kitDir, 'client-helper.md'), '---\nname: client-helper\ndescription: ours\ntier: fast\naccess: read-only\n---\nx\n');
  r = w.forge(['sync']);
  assert.equal(r.code, 2);
  assert.match(r.out, /client-helper\.md exists and is not the kit's/);
  assert.equal(fs.readFileSync(path.join(w.client, '.claude/agents/client-helper.md'), 'utf8'), 'theirs, untracked');
});

test('the policy blocks agents from editing generated files', () => {
  const w = world();
  w.ready();
  const hook = spawnSync('node', [path.join(w.client, '.forge/kit/core/policy/bin/forge-hook.mjs'), 'pre-tool-use'], {
    input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: path.join(w.client, '.claude/agents/planner.md'), old_string: 'a', new_string: 'b' }, cwd: w.client }), encoding: 'utf8', env: w.env,
  });
  assert.match(hook.stdout, /\[kit:generated\]/);
});

test('upgrade fetches the pinned version by tag, regenerates, and removes what the new version dropped', () => {
  const w = world();
  w.ready();
  w.forge(['setup', '--team-repo', w.team, '--kit-repo', kitRepo(w.base)]);
  assert.ok(fs.existsSync(path.join(w.client, '.claude/skills/figma-align/SKILL.md')));
  const r = w.forge(['upgrade', '--to', '9.9.0']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /removed \d+ stale/);
  assert.equal(fs.readFileSync(path.join(w.client, '.forge/kit/VERSION'), 'utf8').trim(), '9.9.0');
  assert.match(fs.readFileSync(path.join(w.client, '.claude/agents/planner.md'), 'utf8'), /\(kit 9\.9\.0\)/);
  assert.ok(!fs.existsSync(path.join(w.client, '.claude/skills/figma-align')), 'a skill dropped by the new version is removed');
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.team, 'acme-portal/project.json'), 'utf8')).kit.version, '9.9.0');
  assert.ok(fs.existsSync(path.join(w.base, 'cache/9.9.0/VERSION')), 'the version is cached');
  assert.equal(gitClean(w.client), '');
  const back = w.forge(['upgrade', '--to', VERSION]);
  assert.equal(back.code, 0, back.out);
  assert.ok(fs.existsSync(path.join(w.client, '.claude/skills/figma-align/SKILL.md')));
});

test('a teammate\'s newer pin leaves agents read-only until forge sync', () => {
  const w = world();
  w.ready();
  w.forge(['setup', '--team-repo', w.team, '--kit-repo', kitRepo(w.base)]);
  const pj = path.join(w.team, 'acme-portal/project.json');
  const data = JSON.parse(fs.readFileSync(pj, 'utf8'));
  data.kit.version = '9.9.0';
  fs.writeFileSync(pj, JSON.stringify(data));
  const pre = () => spawnSync('node', [path.join(w.client, '.forge/kit/core/policy/bin/forge-hook.mjs'), 'pre-tool-use'], {
    input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: path.join(w.client, 'a.ts'), content: 'x' }, cwd: w.client }), encoding: 'utf8', env: w.env,
  }).stdout;
  assert.match(pre(), /\[kit:version\] This project pins se-forge 9\.9\.0/);
  assert.match(w.forge(['doctor']).out, /✗ kit .* but the project pins 9\.9\.0: forge sync/);
  assert.equal(w.forge(['sync']).code, 0);
  assert.doesNotMatch(pre(), /kit:version/);
});

test('upgrade to a version that does not exist changes nothing', () => {
  const w = world();
  w.ready();
  w.forge(['setup', '--team-repo', w.team, '--kit-repo', kitRepo(w.base)]);
  const r = w.forge(['upgrade', '--to', '7.7.7']);
  assert.equal(r.code, 2);
  assert.match(r.out, /Cannot fetch se-forge v7\.7\.7/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.team, 'acme-portal/project.json'), 'utf8')).kit.version, VERSION);
});

test('doctor reports a healthy checkout, and fails on a broken one', () => {
  const w = world();
  w.ready();
  let r = w.forge(['doctor']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /✓ nothing from the kit is visible to git/);
  assert.match(r.out, /✓ safety hooks wired/);
  assert.match(r.out, /! no gate command/);
  assert.match(r.out, /(✓ tracker gitlab: glab and jq installed|! tracker gitlab needs (glab|jq|glab and jq) \(brew install)/);
  assert.match(r.out, /✓ claude\.ai connectors off in this project/);
  assert.doesNotMatch(r.out, /Figma/, 'no Figma check for a project without Figma');
  const file = path.join(w.client, '.claude/settings.local.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), disableClaudeAiConnectors: false }));
  r = w.forge(['doctor']);
  assert.equal(r.code, 1);
  assert.match(r.out, /✗ claude\.ai connectors \(mail, documents, calendars\) are on in this project: forge sync/);
  w.forge(['sync']);
  assert.match(w.forge(['doctor']).out, /✓ claude\.ai connectors off/, 'sync turns them off again');
  fs.rmSync(path.join(w.client, '.forge/project'));
  r = w.forge(['doctor']);
  assert.equal(r.code, 1);
  assert.match(r.out, /✗ \.forge\/project is missing/);
});

test('sync moves the compaction point with the lead handover line, within what Claude Code accepts', () => {
  const w = world();
  w.ready();
  const pj = path.join(w.team, 'acme-portal/project.json');
  const settings = () => JSON.parse(fs.readFileSync(path.join(w.client, '.claude/settings.local.json'), 'utf8')).autoCompactWindow;
  const lead = (n) => { const d = JSON.parse(fs.readFileSync(pj, 'utf8')); fs.writeFileSync(pj, JSON.stringify({ ...d, policy: { ...d.policy, budget: { leadWarn: n } } }, null, 2)); assert.equal(w.forge(['sync']).code, 0); };
  lead(150000);
  assert.equal(settings(), 250000);
  lead(0);
  assert.equal(settings(), 100000, 'never below the 100k Claude Code accepts');
  lead(990000);
  assert.equal(settings(), 1000000, 'never above 1M');
});

test("doctor checks Figma's MCP server when the project's screens are in Figma (GUIDE.md, B8)", () => {
  const w = world();
  w.ready();
  const pj = path.join(w.team, 'acme-portal/project.json');
  const data = JSON.parse(fs.readFileSync(pj, 'utf8'));
  fs.writeFileSync(pj, JSON.stringify({ ...data, project: { ...data.project, design: { source: 'figma' } } }, null, 2));
  // A stand-in for `claude mcp list`, printing what the test puts in MCP_LIST.
  const bin = path.join(w.base, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n[ "$1 $2" = "mcp list" ] && printf "%s\\n" "$MCP_LIST"\n', { mode: 0o755 });
  w.env.PATH = `${bin}:${process.env.PATH}`;
  const doctor = (list) => { w.env.MCP_LIST = `Checking MCP server health…\n\n${list}`; return w.forge(['doctor']).out; };
  assert.match(doctor('claude.ai Notion: https://mcp.notion.com/mcp - ✔ Connected'), /! the screens are in Figma, but Figma's MCP server is not installed: claude plugin install figma \(GUIDE\.md, B8\)/);
  assert.match(doctor('plugin:figma:figma: https://mcp.figma.com/mcp (HTTP) - ! Needs authentication'), /! Figma's MCP server: Needs authentication\. Log in through \/plugin/);
  assert.match(doctor('plugin:figma:figma: https://mcp.figma.com/mcp (HTTP) - ✔ Connected'), /✓ Figma's MCP server connected/);
});

test('worktrees: running, cut off, done or unfinished; --clean removes only what is done (decision 95)', () => {
  const w = world();
  w.ready();
  const c = w.client;
  sh(w.base, 'git', 'init', '-q', '--bare', 'client.git');
  sh(c, 'git', 'remote', 'add', 'origin', path.join(w.base, 'client.git'));
  sh(c, 'git', 'push', '-q', '-u', 'origin', 'main');
  const tree = (name, ...args) => { const p = path.join(c, '.claude/worktrees', name); sh(c, 'git', 'worktree', 'add', '-q', ...args, p); return p; };
  const commit = (p, file) => { fs.writeFileSync(path.join(p, file), 'x\n'); sh(p, 'git', 'add', file); sh(p, 'git', 'commit', '-q', '-m', `chore: add ${file}`); };
  const dead = spawnSync('true').pid;
  const lock = (p, pid) => sh(c, 'git', 'worktree', 'lock', '--reason', `claude agent ${path.basename(p)} (pid ${pid} start now)`, p);
  const done = tree('agent-done', '-b', 'feat/done'); commit(done, 'done.txt'); sh(done, 'git', 'push', '-q', '-u', 'origin', 'feat/done');
  fs.writeFileSync(path.join(tree('agent-dirty', '--detach'), 'wip.txt'), 'x\n');
  commit(tree('agent-local', '-b', 'feat/local'), 'local.txt');
  lock(tree('agent-run', '--detach'), process.pid);
  lock(tree('agent-cut', '--detach'), dead);
  const cutDirty = tree('agent-cut-dirty', '--detach'); fs.writeFileSync(path.join(cutDirty, 'wip.txt'), 'x\n'); lock(cutDirty, dead);
  let r = w.forge(['worktrees']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /✓ \.claude\/worktrees\/agent-done {2}feat\/done {2}done, clean, everything pushed$/m);
  assert.match(r.out, /✗ \.claude\/worktrees\/agent-dirty {2}detached {2}unfinished, uncommitted changes: forge handover agent-dirty --from-tree \.claude\/worktrees\/agent-dirty$/m);
  assert.match(r.out, /✗ \.claude\/worktrees\/agent-local {2}feat\/local {2}unfinished, commits not pushed: forge handover feat-local --from-tree/m);
  assert.match(r.out, new RegExp(`! \\.claude/worktrees/agent-run {2}detached {2}running, an agent is working there \\(pid ${process.pid}\\)`));
  assert.match(r.out, /✓ \.claude\/worktrees\/agent-cut {2}detached {2}done, clean, everything pushed, its agent was cut off$/m);
  assert.match(r.out, /✗ \.claude\/worktrees\/agent-cut-dirty {2}detached {2}unfinished, uncommitted changes, its agent was cut off/m);
  assert.match(r.out, /^Not yet: 1 running, 3 unfinished\./m);
  r = w.forge(['worktrees', '--clean']);
  assert.match(r.out, /agent-done .*\(removed\)$/m);
  assert.match(r.out, /agent-cut {2}.*\(removed\)$/m);
  const left = sh(c, 'git', 'worktree', 'list').split('\n').length;
  assert.equal(left, 5, 'the main checkout and the four that are not done stay');
  assert.ok(fs.existsSync(path.join(c, '.claude/worktrees/agent-dirty/wip.txt')), 'unfinished work is never removed');
  // A handover written from an unfinished worktree keeps it, and it no longer blocks closing.
  assert.equal(w.forge(['handover', 'agent-dirty', '--from-tree', '.claude/worktrees/agent-dirty']).code, 0);
  assert.match(w.forge(['worktrees']).out, /· \.claude\/worktrees\/agent-dirty {2}detached {2}handed over, uncommitted changes; \.forge\/handoffs\/agent-dirty-handover\.md continues it$/m);
  for (const n of ['agent-local', 'agent-run', 'agent-cut-dirty']) sh(c, 'git', 'worktree', 'remove', '-f', '-f', path.join(c, '.claude/worktrees', n));
  r = w.forge(['worktrees']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^Safe to close: no agent is working and nothing is unfinished \(1 handed over, kept for the next agent\)\.$/m);
});

test('init refuses when kit files are tracked in the client repo', () => {
  const w = world();
  w.forge(['setup', '--team-repo', w.team]);
  fs.writeFileSync(path.join(w.client, '.claude/settings.local.json'), '{}');
  sh(w.client, 'git', 'add', '-f', '.claude/settings.local.json');
  sh(w.client, 'git', 'commit', '-q', '-m', 'oops');
  const r = w.forge(['init', '--project', 'acme-portal', '--new']);
  assert.equal(r.code, 2);
  assert.match(r.out, /Kit files are tracked/);
});

test('sync keeps the developer\'s own settings and hooks, and drops rules an older kit added', () => {
  const w = world();
  w.ready();
  const file = path.join(w.client, '.claude/settings.local.json');
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  s.permissions.allow.push('Bash(npm run storybook)', 'Bash(old-kit-rule)');
  s.hooks.Stop = [{ hooks: [{ type: 'command', command: 'say done' }] }];
  fs.writeFileSync(file, JSON.stringify(s));
  const managed = path.join(w.client, '.forge/state/settings-managed.json');
  const m = JSON.parse(fs.readFileSync(managed, 'utf8'));
  m.allow.push('Bash(old-kit-rule)');
  fs.writeFileSync(managed, JSON.stringify(m));
  assert.equal(w.forge(['sync']).code, 0);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(after.permissions.allow.includes('Bash(npm run storybook)'));
  assert.ok(!after.permissions.allow.includes('Bash(old-kit-rule)'));
  assert.equal(after.hooks.Stop[0].hooks[0].command, 'say done');
  assert.equal(after.hooks.PreToolUse.length, 1, 'the kit hook is not duplicated');
});

test('save commits and pushes only the project folder of the team repo', () => {
  const w = world();
  w.ready();
  fs.writeFileSync(path.join(w.client, '.forge/project/plans/12-login.md'), '# Login (#12)\n');
  fs.writeFileSync(path.join(w.team, 'unrelated.txt'), 'not mine');
  const r = w.forge(['save', '-m', 'plan #12']);
  assert.match(r.out, /saved and pushed: acme-portal: plan #12/);
  assert.match(sh(`${w.team}.git`, 'git', 'log', '--oneline', '-1', 'main'), /acme-portal: plan #12/);
  assert.match(sh(w.team, 'git', 'status', '--porcelain'), /unrelated\.txt/);
  assert.equal(w.forge(['save']).out.trim(), 'nothing to save');
  assert.equal(gitClean(w.client), '');
});

test('handover, tracker and version work in a set-up checkout', () => {
  const w = world();
  w.ready();
  const r = w.forge(['handover', 'fe-12']);
  assert.equal(r.code, 0, r.out);
  assert.match(fs.readFileSync(path.join(w.client, '.forge/handoffs/fe-12-handover.md'), 'utf8'), /diff --stat vs origin\/dev/);
  // A lane writes its handover into its own worktree (Claude Code refuses it the main checkout; decision 92);
  // the lead writing for a stopped lane writes the main checkout.
  const tree = path.join(w.client, '.claude/worktrees/agent-be3');
  sh(w.client, 'git', 'worktree', 'add', '-q', '--detach', tree);
  assert.equal(w.forge(['handover', 'be-3'], tree).code, 0);
  assert.ok(fs.existsSync(path.join(tree, '.forge/handoffs/be-3-handover.md')), 'in the worktree');
  assert.ok(!fs.existsSync(path.join(w.client, '.forge/handoffs/be-3-handover.md')), 'not in the main checkout');
  assert.equal(w.forge(['handover', 'be-3', '--from-tree', tree]).code, 0);
  assert.match(fs.readFileSync(path.join(w.client, '.forge/handoffs/be-3-handover.md'), 'utf8'), /Written by: lead-from-tree/);
  sh(w.client, 'git', 'worktree', 'remove', '--force', tree);
  assert.equal(w.forge(['version']).out.trim(), VERSION);
  assert.match(w.forge(['tracker', 'help']).out, /^ {2}get <id> \[--json\] /m);
  assert.equal(gitClean(w.client), '');
});

test('the project folder in the team repo is an additional working directory, kept up to date on relink', () => {
  const w = world();
  w.ready();
  const file = path.join(w.client, '.claude/settings.local.json');
  const dirs = () => JSON.parse(fs.readFileSync(file, 'utf8')).permissions.additionalDirectories;
  assert.deepEqual(dirs(), [path.join(w.team, 'acme-portal')]);
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  s.permissions.additionalDirectories.push('/opt/mine');
  fs.writeFileSync(file, JSON.stringify(s));
  assert.equal(w.forge(['init', '--project', 'other', '--new', '--force']).code, 0);
  assert.deepEqual(dirs(), ['/opt/mine', path.join(w.team, 'other')], "the developer's own entry stays; the old project folder goes");
});

test('doctor reports the API contract', () => {
  const w = world();
  w.ready();
  const pj = path.join(w.team, 'acme-portal/project.json');
  const cfg = JSON.parse(fs.readFileSync(pj, 'utf8'));
  cfg.project.api = { spec: 'api/openapi.yaml' };
  fs.writeFileSync(pj, JSON.stringify(cfg));
  assert.match(w.forge(['doctor']).out, /! API contract api\/openapi\.yaml does not exist yet/);
  fs.mkdirSync(path.join(w.client, 'api'));
  fs.writeFileSync(path.join(w.client, 'api/openapi.yaml'), 'openapi: 3.1.0\n');
  sh(w.client, 'git', 'tag', 'api-v1.2.0'); sh(w.client, 'git', 'tag', 'api-v1.10.0');
  assert.match(w.forge(['doctor']).out, /✓ API contract api\/openapi\.yaml; newest approved version api-v1\.10\.0/);
  cfg.project.api = { spec: 'api/openapi.yaml', contractRepo: 'git@example.com:acme/backend.git' };
  fs.writeFileSync(pj, JSON.stringify(cfg));
  assert.match(w.forge(['doctor']).out, /! API contract from git@example\.com:acme\/backend\.git, but no version is pinned/);
});

test('tracker openproject: project.openproject reaches the adapter, a variable already set wins, doctor names the key source', () => {
  const w = world();
  w.ready();
  for (const k of Object.keys(w.env)) if (k.startsWith('OPENPROJECT_')) delete w.env[k];
  // A fake curl that answers a one-column board and logs the address it was asked; a fake Keychain with a key.
  const bin = path.join(w.base, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'curl'), String.raw`#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('curl 8 (fake)'); process.exit(0); }
const url = new URL(a[a.length - 1]);
require('fs').appendFileSync(process.env.FAKE_LOG, url.origin + url.pathname + '\n');
const p = url.pathname.replace(/^\/api\/v3/, '');
const r = p === '/grids/109' ? { widgets: [{ startColumn: 1, options: { queryId: 11 } }] }
  : p === '/queries/11' ? { name: 'Todo', _embedded: { results: { _embedded: { elements: [{ id: 42, subject: 'Login', _links: { status: { title: 'Todo' }, assignee: { title: 'Amal' } } }] } } } }
  : null;
process.stdout.write(JSON.stringify(r ?? { message: 'not found' }) + '\n' + (r ? 200 : 404));
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'security'), '#!/bin/sh\nprintf "%s\\n" op-keychain-key\n', { mode: 0o755 });
  const log = path.join(w.base, 'curl.log');
  fs.writeFileSync(log, '');
  Object.assign(w.env, { PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log, HOME: w.base });
  const pj = path.join(w.team, 'acme-portal/project.json');
  const cfg = JSON.parse(fs.readFileSync(pj, 'utf8'));
  cfg.project.tracker = 'openproject';
  cfg.project.openproject = { url: 'https://op.example.com', project: 'ird' };
  fs.writeFileSync(pj, JSON.stringify(cfg));
  let r = w.forge(['doctor']);
  assert.match(r.out, /✓ tracker openproject: API key from macOS Keychain \(se-forge-openproject\)/);
  assert.match(r.out, /tracker openproject: no boards configured, status mode/);
  assert.ok(!r.out.includes('op-keychain-key'), 'doctor names the source, never the key');
  cfg.project.openproject.boards = { issues: 109 };
  fs.writeFileSync(pj, JSON.stringify(cfg));
  r = w.forge(['tracker', 'list', 'board', 'all']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^### issues \(109\)\n== Todo\n {2}#42 Login {2}\[Todo\] {2}Amal$/m);
  assert.ok(!r.out.includes('op-keychain-key'));
  assert.match(fs.readFileSync(log, 'utf8'), /^https:\/\/op\.example\.com\/api\/v3\/grids\/109$/m, 'the URL from project.json');
  fs.writeFileSync(log, '');
  w.env.OPENPROJECT_URL = 'https://override.example.com';
  w.env.OPENPROJECT_API_KEY = 'op-env-key';
  assert.equal(w.forge(['tracker', 'list', 'board', 'issues']).code, 0);
  const calls = fs.readFileSync(log, 'utf8');
  assert.match(calls, /^https:\/\/override\.example\.com\/api\/v3\/grids\/109$/m, 'a variable already set wins');
  assert.doesNotMatch(calls, /op\.example\.com/);
  r = w.forge(['doctor']);
  assert.match(r.out, /✓ tracker openproject: API key from env OPENPROJECT_API_KEY/);
  assert.match(r.out, /✓ tracker openproject: boards issues=109/);
  assert.ok(!r.out.includes('op-env-key'));
});

test('forge config check validates a proposal before it is applied', () => {
  const w = world();
  const good = path.join(w.base, 'good.json');
  const bad = path.join(w.base, 'bad.json');
  fs.writeFileSync(good, JSON.stringify({ project: { stack: { backend: 'FastAPI' }, design: { source: 'images' } }, policy: { deps: { approved: ['zod'] } } }));
  fs.writeFileSync(bad, JSON.stringify({ project: { stack: { repo: 'single' }, db: { engine: 'postgresql' } }, policy: { deps: { approved: { frontend: ['zod'] } } } }));
  let r = w.forge(['config', 'check', good]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^valid: /);
  r = w.forge(['config', 'check', bad]);
  assert.equal(r.code, 1);
  assert.match(r.out, /unknown key project\.stack\.repo/);
  assert.match(r.out, /unknown key project\.db\.engine/);
  assert.match(r.out, /policy\.deps\.approved must be a list of strings/);
});

test('project.models picks the model per tier for this project only', () => {
  const w = world();
  w.ready();
  const agent = (name) => fs.readFileSync(path.join(w.client, '.claude/agents', `${name}.md`), 'utf8');
  assert.match(agent('planner'), /^model: opus$/m, 'deep tier, default');
  assert.match(agent('scout'), /^model: haiku$/m, 'fast tier, default');
  const pj = path.join(w.team, 'acme-portal/project.json');
  const cfg = JSON.parse(fs.readFileSync(pj, 'utf8'));
  cfg.project.models = { deep: 'claude-opus-5-5', standard: 'sonnet' };
  fs.writeFileSync(pj, JSON.stringify(cfg));
  assert.equal(w.forge(['sync']).code, 0);
  assert.match(agent('planner'), /^model: claude-opus-5-5$/m);
  assert.match(agent('backend-engineer'), /^model: sonnet$/m);
  assert.match(agent('scout'), /^model: haiku$/m, 'tiers not named keep the default');
  cfg.project.models = { deep: 'opus 5' };
  fs.writeFileSync(pj, JSON.stringify(cfg));
  assert.match(w.forge(['config', 'check', pj]).out, /project\.models\.deep must be a model name/);
  const r = w.forge(['sync']);
  assert.equal(r.code, 2);
  assert.match(r.out, /project\.json is invalid, nothing written:\n {2}project\.models\.deep must be a model name/);
});

// forge llm (decision 140): a fake model server in its own process (forge runs with spawnSync), the key in a private
// file under XDG_CONFIG_HOME, and no Keychain or Secret Service on the PATH.
async function fakeServer(env = {}) {
  const child = spawn('node', [path.join(KIT, 'tests/cli/fixtures/fake-llm-server.mjs')], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((resolve) => child.stdout.once('data', (d) => resolve(Number(String(d).trim()))));
  return { url: `http://127.0.0.1:${port}/gpu/llm`, stop: () => child.kill() };
}
function llmWorld() {
  const w = world();
  w.ready();
  const bin = path.join(w.base, 'bin');
  fs.mkdirSync(bin);
  for (const t of ['security', 'secret-tool']) fs.writeFileSync(path.join(bin, t), '#!/bin/sh\nexit 44\n', { mode: 0o755 });
  const env = { ...w.env, PATH: `${bin}:${process.env.PATH}`, XDG_CONFIG_HOME: path.join(w.base, 'xdg') };
  const forge = (args, cwd = w.client) => {
    const r = spawnSync('node', [FORGE, ...args], { cwd, env, encoding: 'utf8' });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const keySrc = path.join(w.base, 'qwen-key');
  fs.writeFileSync(keySrc, 'fake-llm-key\n', { mode: 0o600 });
  const settings = () => JSON.parse(fs.readFileSync(path.join(w.client, '.claude/settings.local.json'), 'utf8'));
  return { ...w, env, forge, keySrc, settings, keyFile: path.join(w.base, 'xdg/se-forge/llm-gpu-key') };
}

test('forge llm: add keeps the server on this machine and the key in a private file; use points the checkout at it, claude back (decision 140)', async () => {
  const w = llmWorld();
  const s = await fakeServer();
  try {
    assert.equal(w.forge(['setup', '--team-repo', w.team, '--pacing', 'on']).code, 0);
    let r = w.forge(['llm', 'add', 'gpu', '--url', `${s.url}/v1/`, '--model', 'Qwen/Qwen3.8-27B', '--key-file', w.keySrc]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /key copied to .*\/xdg\/se-forge\/llm-gpu-key, readable by you only; you can delete .*qwen-key/);
    assert.match(r.out, /✓ model server: http:\/\/127\.0\.0\.1:\d+\/gpu\/llm serves Qwen\/Qwen3\.8-27B/);
    assert.match(r.out, /✓ model server: Qwen\/Qwen3\.8-27B takes tool calls/);
    assert.equal(fs.statSync(w.keyFile).mode & 0o777, 0o600);
    const cfg = JSON.parse(fs.readFileSync(w.env.FORGE_USER_CONFIG, 'utf8'));
    assert.deepEqual(cfg.llm.gpu, { url: s.url, models: { opus: 'Qwen/Qwen3.8-27B', sonnet: 'Qwen/Qwen3.8-27B', haiku: 'Qwen/Qwen3.8-27B' } }, 'the address without /v1');
    assert.equal(cfg.pacing, true, 'the rest of the machine settings stay');
    r = w.forge(['llm']);
    assert.match(r.out, /- gpu: http:\/\/127\.0\.0\.1:\d+\/gpu\/llm, Qwen\/Qwen3\.8-27B for opus, sonnet and haiku; key: file .*llm-gpu-key\nThis checkout runs on Claude\./);

    r = w.forge(['llm', 'use', 'gpu']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /This checkout runs on gpu \(Qwen\/Qwen3\.8-27B for opus, sonnet and haiku\) from the next Claude Code session/);
    assert.equal(w.settings().env.ANTHROPIC_BASE_URL, s.url);
    assert.equal(w.settings().env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'Qwen/Qwen3.8-27B');
    assert.equal(w.settings().env.CLAUDE_CODE_ATTRIBUTION_HEADER, '0');
    assert.match(w.settings().apiKeyHelper, /^node ".*\/\.forge\/kit\/core\/cli\/llm-key\.mjs" gpu$/);
    assert.ok(w.settings().hooks, 'the safety hooks stay');
    assert.equal(gitClean(w.client), '', 'nothing is visible to git');
    for (const out of [r.out, w.forge(['llm']).out, JSON.stringify(w.settings())]) assert.ok(!out.includes('fake-llm-key'), 'the key is never printed or written there');
    // Claude Code runs the key helper through the shell: it prints the key and nothing else.
    const helper = spawnSync('/bin/sh', ['-c', w.settings().apiKeyHelper], { cwd: w.client, env: w.env, encoding: 'utf8' });
    assert.equal(helper.stdout, 'fake-llm-key');

    assert.equal(w.forge(['sync']).code, 0);
    assert.equal(w.settings().env.ANTHROPIC_BASE_URL, s.url, 'forge sync keeps it');
    r = w.forge(['doctor']);
    assert.match(r.out, /✓ model server gpu: http:\/\/127\.0\.0\.1:\d+\/gpu\/llm, Qwen\/Qwen3\.8-27B for opus, sonnet and haiku/);
    assert.match(r.out, /✓ model server: key from file .*llm-gpu-key/);
    assert.match(r.out, /✓ model server: Qwen\/Qwen3\.8-27B takes tool calls/);
    assert.match(r.out, /· pacing off: this checkout runs on the model server gpu \(forge llm\), which has no plan windows/);
    assert.doesNotMatch(r.out, /pacing is on for you but not in this checkout/);

    // A server the machine no longer knows: sync says so and the checkout runs on Claude.
    r = w.forge(['llm', 'remove', 'gpu']);
    assert.match(r.out, /model server gpu removed\. Its key stays where you stored it: .*rm ".*llm-gpu-key"\.\n! this checkout is still set to gpu: forge llm use claude/);
    r = w.forge(['sync']);
    assert.match(r.out, /model server: this checkout is set to gpu, which this machine does not know/);
    assert.equal(w.settings().env, undefined);
    assert.match(w.forge(['doctor']).out, /✗ model server: this checkout is set to gpu/);
    r = w.forge(['llm', 'use', 'claude']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /This checkout runs on Claude again \(it was gpu\)/);
    assert.equal(w.settings().apiKeyHelper, undefined);
    assert.equal(w.forge(['llm', 'use', 'claude']).out.trim(), 'This checkout runs on Claude already.');
  } finally { s.stop(); }
});

test('forge llm: doctor says what the server lacks (tool calls, room for the lead, the key)', async () => {
  const w = llmWorld();
  const s = await fakeServer({ FAKE_LLM_TOOLS: 'off', FAKE_LLM_CONTEXT: '131072' });
  try {
    assert.equal(w.forge(['llm', 'add', 'gpu', '--url', s.url, '--model', 'Qwen/Qwen3.8-27B', '--key-file', w.keySrc]).code, 0);
    let r = w.forge(['llm', 'use', 'gpu']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /✗ model server: .*\/v1\/messages refused a tool call/, 'use says it at once');
    r = w.forge(['doctor']);
    assert.equal(r.code, 1);
    assert.match(r.out, /✗ model server: http:.*\/gpu\/llm\/v1\/messages refused a tool call \(HTTP 400: "auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set\)\. vLLM takes tool calls when started with --enable-auto-tool-choice/);
    assert.match(r.out, /! model server: Qwen\/Qwen3\.8-27B has a context of 131072 tokens and the lead compacts at 200000/);
    fs.writeFileSync(w.keyFile, 'wrong-key\n', { mode: 0o600 });
    assert.match(w.forge(['doctor']).out, /✗ model server: http:.* refused the key \(HTTP 401: invalid api key\)/);
    fs.chmodSync(w.keyFile, 0o644);
    assert.match(w.forge(['doctor']).out, /✗ model server: .*llm-gpu-key is readable by others; refusing it\. Run: chmod 600/);
  } finally { s.stop(); }
});

test('forge llm refuses what it cannot do: a bad name, address or model, no key, a key helper of your own, a kit without it', () => {
  const w = llmWorld();
  assert.match(w.forge(['llm', 'use', 'gpu']).out, /this machine knows no model server named gpu: forge llm add/);
  assert.match(w.forge(['llm', 'add', 'claude', '--url', 'http://x.example', '--model', 'm']).out, /not "claude"/);
  assert.match(w.forge(['llm', 'add', 'gpu', '--url', 'gpu.example.com', '--model', 'm']).out, /--url is the server's address/);
  assert.match(w.forge(['llm', 'add', 'gpu', '--url', 'http://127.0.0.1:9', '--opus', 'm']).out, /sonnet, haiku has none/);
  assert.match(w.forge(['llm', 'add', 'gpu', '--url', 'http://127.0.0.1:9', '--model', 'm', '--key-file', path.join(w.base, 'nothing')]).out, /--key-file .*nothing holds no key/);

  let r = w.forge(['llm', 'add', 'gpu', '--url', 'http://127.0.0.1:9', '--model', 'm']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /No key stored for gpu yet\. Store it once, in one of \(GUIDE\.md, H\):\n {2}macOS Keychain: {2}security add-generic-password -U -s se-forge-llm-gpu -a "\$USER" -T \/usr\/bin\/security -w/);
  r = w.forge(['llm', 'use', 'gpu']);
  assert.equal(r.code, 2);
  assert.match(r.out, /no key for the model server gpu\. Looked in: the macOS Keychain \(service se-forge-llm-gpu\); the Linux keyring/);
  assert.equal(fs.existsSync(path.join(w.client, '.forge/state/llm.json')), false);

  fs.mkdirSync(path.dirname(w.keyFile), { recursive: true });
  fs.writeFileSync(w.keyFile, 'k\n', { mode: 0o600 });
  const file = path.join(w.client, '.claude/settings.local.json');
  fs.writeFileSync(file, JSON.stringify({ ...w.settings(), apiKeyHelper: 'my-vault-script' }));
  r = w.forge(['llm', 'use', 'gpu']);
  assert.equal(r.code, 2);
  assert.match(r.out, /\.claude\/settings\.local\.json sets apiKeyHelper itself; remove it first/);
  assert.equal(w.settings().apiKeyHelper, 'my-vault-script', 'a person\'s own key helper is never overwritten');
  assert.equal(w.forge(['sync']).code, 0);
  assert.equal(w.settings().apiKeyHelper, 'my-vault-script', 'nor by forge sync');

  fs.writeFileSync(file, JSON.stringify({ ...w.settings(), apiKeyHelper: undefined }));
  fs.rmSync(path.join(w.client, '.forge/kit/core/cli/llm-key.mjs'));
  assert.match(w.forge(['llm', 'use', 'gpu']).out, /this checkout's kit is older than forge llm \(it came with 0\.2\.38\): forge upgrade --to 0\.2\.38/);
});
