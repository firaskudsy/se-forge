// Rules injected at session and lane start, docs-only roles, and role/policy consistency.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo, ctxFor, writeProjectConfig } from './helpers.mjs';
import { sessionStart, subagentStart } from '../../core/policy/lib/handlers.mjs';
import { combine } from '../../core/policy/lib/decision.mjs';
import { roleFindings } from '../../core/policy/lib/roles.mjs';
import { DEFAULTS } from '../../core/policy/lib/config.mjs';
import { parseRole, renderClaude } from '../../adapters/claude/render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FULL_PROJECT = {
  kit: { version: fs.readFileSync(path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), 'VERSION'), 'utf8').trim() },
  project: {
    name: 'acme-portal', client: 'Acme Trading LLC', host: 'gitlab', tracker: 'gitlab', mode: 'full', coAuthor: false,
    stack: { frontend: 'React 19 + TypeScript (Vite)', backend: '.NET 8 Web API', database: 'PostgreSQL 16', cloud: 'Azure (Terraform)', other: 'Redis cache, Azure Service Bus' },
    storiesPath: 'docs/stories/release-1.pdf',
    figma: { fileKey: 'AbCdEfGh123456', rootNode: '12:345', toolPrefix: 'mcp__figma__' },
    api: { generate: 'npm run api:generate', generatedDir: 'src/lib/api/generated', specEnv: 'OPENAPI_SPEC_URL' },
  },
  policy: { gates: { full: 'npm run typecheck > /tmp/tc.log 2>&1 && npm run lint > /tmp/lint.log 2>&1 && npm test -- --reporter=dot' } },
};

test('session and lane injections carry the rules and facts within the 10,000 character hook limit', () => {
  const { dir } = makeRepo(null);
  writeProjectConfig(dir, FULL_PROJECT);
  const lead = sessionStart({ cwd: dir, source: 'startup' }, { HOME: '/Users/dev' }).hookSpecificOutput.additionalContext;
  const lane = subagentStart({ cwd: dir, agent_id: 'a1', agent_type: 'frontend-engineer' }, { HOME: '/Users/dev' }).hookSpecificOutput.additionalContext;
  for (const [who, text] of [['lead', lead], ['lane', lane]]) {
    assert.ok(text.length < 9500, `${who} injection is ${text.length} characters`);
    assert.match(text, /# se-forge rules for every agent/);
    assert.match(text, /Gate command: `npm run typecheck/);
    assert.match(text, /Figma: file AbCdEfGh123456, root node 12:345; Figma tools are named mcp__figma__\*/);
    assert.match(text, /Commits do NOT carry a Co-Authored-By line/);
  }
  assert.match(lane, /# Rules for spawned agents/);
  assert.doesNotMatch(lead, /# Rules for spawned agents/);
  // Only the main session asks the owner, so only it gets the lead's rules (decision 136).
  assert.match(lead, /# Rules for the main session \(the lead\)/);
  assert.match(lead, /AskUserQuestion\. Up to 4 questions per call/);
  // What the owner has to do, as one block of steps in order (decision 144).
  assert.match(lead, /\*\*Your turn\*\* \(N steps, in this order\)/);
  assert.doesNotMatch(lane, /# Rules for the main session/);
  // Decision 138: the lead runs a plan's or an agent's questions past the owner-assistant first.
  assert.match(lead, /spawn `owner-assistant` once with all of them/);
  assert.doesNotMatch(lane, /owner-assistant/);
});

test("a Figma file without a tool prefix gets the names of Figma's Claude Code plugin", () => {
  const { dir } = makeRepo(null);
  writeProjectConfig(dir, { ...FULL_PROJECT, project: { ...FULL_PROJECT.project, figma: { fileKey: 'AbCdEfGh123456', rootNode: '12:345' } } });
  const lead = sessionStart({ cwd: dir, source: 'startup' }, { HOME: '/Users/dev' }).hookSpecificOutput.additionalContext;
  assert.match(lead, /Figma tools are named mcp__plugin_figma_figma__\*/);
});

test('an uninitialised repository gets a pointer to forge init and no lane injection', () => {
  const { dir } = makeRepo(null);
  assert.match(sessionStart({ cwd: dir }, {}).hookSpecificOutput.additionalContext, /run `forge init`/);
  assert.equal(subagentStart({ cwd: dir, agent_id: 'a1' }, {}), null);
});

test('docs-only roles write only under .forge and run only inspection and forge commands', () => {
  const { dir } = makeRepo();
  const ctx = ctxFor(dir, { agent_id: 'p1', agent_type: 'planner' });
  const d = (tool_name, tool_input) => combine(roleFindings({ tool_name, tool_input }, ctx)).decision;
  assert.equal(d('Write', { file_path: path.join(dir, '.forge/project/plans/12-login.md') }), 'allow');
  assert.equal(d('Write', { file_path: path.join(dir, 'src/auth/login.ts') }), 'deny');
  assert.equal(d('Bash', { command: 'grep -rn "Login" src | head' }), 'allow');
  assert.equal(d('Bash', { command: 'forge tracker create --subject "[Story conflict] x" --status Todo' }), 'allow');
  assert.equal(d('Bash', { command: 'mkdir -p .forge/project/bootstrap && cat > .forge/project/bootstrap/stories.md <<EOF\n# Stories\nEOF' }), 'allow');
  assert.equal(d('Bash', { command: 'echo x > src/app.ts' }), 'deny');
  assert.equal(d('Bash', { command: 'npm install zod' }), 'deny');
  const reviewer = ctxFor(dir, { agent_id: 'r1', agent_type: 'code-reviewer' });
  assert.equal(combine(roleFindings({ tool_name: 'Bash', tool_input: { command: 'forge tracker create --subject x' } }, reviewer)).decision, 'allow', 'reviewers may file issues (decision 46)');
  assert.equal(combine(roleFindings({ tool_name: 'Bash', tool_input: { command: 'forge tracker status 12 Done' } }, reviewer)).decision, 'deny', 'but not move tickets');
  assert.equal(combine(roleFindings({ tool_name: 'Bash', tool_input: { command: 'forge tracker get 12' } }, reviewer)).decision, 'allow');
  assert.equal(combine(roleFindings({ tool_name: 'Bash', tool_input: { command: 'forge design sample .forge/project/bootstrap/screens/01.png --at "5,5"' } }, reviewer)).decision, 'allow', 'sampling colours is read-only');
  assert.equal(combine(roleFindings({ tool_name: 'Bash', tool_input: { command: 'for i in 31 32; do forge tracker get $i; done' } }, reviewer)).decision, 'allow', 'a loop of inspection commands');
  assert.equal(combine(roleFindings({ tool_name: 'Bash', tool_input: { command: 'for i in 31 32; do rm -f x$i; done' } }, reviewer)).decision, 'deny', 'a loop around a write is still refused');
});

test('every role, skill and command renders; agents carry model, access and isolation', () => {
  const { files, access } = renderClaude({ kitRoot: ROOT });
  const reviewer = files.get('.claude/agents/code-reviewer.md');
  assert.match(reviewer, /model: sonnet\ndisallowedTools: Edit, NotebookEdit\nisolation: worktree\nmaxTurns: 80/);
  assert.match(reviewer, /Generated by forge sync/);
  assert.equal(access['frontend-engineer'], 'code');
  assert.ok(files.has('.claude/skills/pipeline/SKILL.md'));
  assert.ok(files.has('.claude/skills/handover/scripts/handover.sh'));
  assert.ok(files.has('.claude/commands/resume.md'));
});

// Checked with the real CLI: a skill shadows a command of the same name, and a command cannot make
// Claude run a skill that has disable-model-invocation (only a person can, by typing /<skill>).
test('every command can run: no command shadowed by a skill, none invoking a person-only skill', () => {
  const { files } = renderClaude({ kitRoot: ROOT });
  const skills = new Map([...files].filter(([f]) => /^\.claude\/skills\/[^/]+\/SKILL\.md$/.test(f)).map(([f, text]) => [f.split('/')[2], text]));
  const personOnly = [...skills].filter(([, text]) => /^disable-model-invocation: true$/m.test(text)).map(([name]) => name);
  assert.ok(personOnly.includes('ticket') && !personOnly.includes('review-pass'));
  for (const [f, text] of files) {
    if (!f.startsWith('.claude/commands/')) continue;
    const name = path.basename(f, '.md');
    assert.ok(!skills.has(name), `${f} is shadowed by the skill ${name}`);
    for (const s of personOnly) assert.doesNotMatch(text, new RegExp(`\\b${s}\\b\` skill`), `${f} invokes the person-only skill ${s}`);
  }
});

// Decision 138: the owner-assistant reads and answers, never edits, and starts with its rules loaded.
test('the owner-assistant is read-only, on the standard tier, and preloads skill owner-answers', () => {
  const { files, preloads } = renderClaude({ kitRoot: ROOT });
  const agent = files.get('.claude/agents/owner-assistant.md');
  assert.match(agent, /^model: sonnet$/m);
  assert.match(agent, /^disallowedTools: Edit, NotebookEdit$/m);
  assert.deepEqual(preloads['owner-assistant'], ['owner-answers']);
  assert.ok(DEFAULTS.roles.readOnly.includes('owner-assistant'), 'the policy keeps it to inspection and reports');
  const skill = fs.readFileSync(path.join(ROOT, 'core/skills/owner-answers/SKILL.md'), 'utf8');
  for (const v of ['recorded', 'precedent', 'obvious', 'owner']) assert.match(skill, new RegExp(`^\\| \`${v}\` \\|`, 'm'), `verdict ${v}`);
  assert.match(skill, /## Never answered for the owner\n- A gate question/);
});

// Decision 137: agents preload the playbooks their role names, and the project's stack picks the guides.
test('agents preload their skills: the stack picks the guides, and every preloaded skill is one Claude may start', () => {
  const { files, preloads } = renderClaude({ kitRoot: ROOT, stack: ['NestJS 11', 'React 19 + TypeScript (Vite)', 'MongoDB 7'] });
  assert.match(files.get('.claude/agents/backend-engineer.md'), /maxTurns: 200\nskills:\n  - stack-nestjs\n  - db-mongodb\n  - new-endpoint\n---\n/);
  assert.deepEqual(preloads['code-reviewer'], ['stack-nestjs', 'stack-react', 'db-mongodb']);
  assert.deepEqual(preloads['frontend-engineer'].slice(0, 2), ['stack-react', 'api-sync']);
  assert.ok(!preloads['mobile-engineer'].includes('stack-flutter'), 'no Flutter in this stack');
  for (const r of ['backend-engineer', 'frontend-engineer', 'devops-engineer', 'code-reviewer', 'security-reviewer', 'spec-checker', 'qa-engineer']) assert.ok(preloads[r].length, `${r} preloads its skills`);
  // Without a stack the guides drop out and the rest stays; a role with nothing left gets no skills: line.
  const bare = renderClaude({ kitRoot: ROOT });
  assert.deepEqual(bare.preloads['backend-engineer'], ['new-endpoint']);
  assert.doesNotMatch(bare.files.get('.claude/agents/code-reviewer.md').split('\n---\n')[0], /skills:/);
  // A system's repositories add their stacks: both backends' guides.
  assert.deepEqual(renderClaude({ kitRoot: ROOT, stack: ['NestJS 11, PostgreSQL 16', 'FastAPI 0.115 with MinIO'] }).preloads['backend-engineer'], ['stack-nestjs', 'stack-fastapi', 'db-postgresql', 'new-endpoint']);
});

test('a role that preloads a missing skill, a person-only skill or an unknown placeholder stops forge sync', () => {
  const kit = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-'));
  const role = (skills) => `---\nname: x-engineer\ndescription: An engineer for the test.\ntier: standard\naccess: code\nskills: ${skills}\n---\nBody.\n`;
  const skill = (name, extra = '') => { fs.mkdirSync(path.join(kit, 'core/skills', name), { recursive: true }); fs.writeFileSync(path.join(kit, 'core/skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n${extra}---\n`); };
  fs.mkdirSync(path.join(kit, 'core/roles'), { recursive: true });
  skill('good');
  skill('person-only', 'disable-model-invocation: true\n');
  const render = (skills) => { fs.writeFileSync(path.join(kit, 'core/roles/x-engineer.md'), role(skills)); return renderClaude({ kitRoot: kit }); };
  assert.deepEqual(render('good').preloads['x-engineer'], ['good']);
  assert.throws(() => render('good, missing'), /skills names missing, which is not a skill/);
  assert.throws(() => render('person-only'), /only a person starts/);
  assert.throws(() => render('@backnd'), /@backnd is not one of @backend, @frontend, @mobile, @database/);
});

test('the policy\'s role lists match the access level declared in every role file', () => {
  for (const f of fs.readdirSync(path.join(ROOT, 'core/roles')).filter((x) => x.endsWith('.md'))) {
    const { fields } = parseRole(fs.readFileSync(path.join(ROOT, 'core/roles', f), 'utf8'), f);
    const policy = DEFAULTS.roles.readOnly.includes(fields.name) ? 'read-only' : DEFAULTS.roles.docsOnly.includes(fields.name) ? 'docs' : 'code';
    assert.equal(policy, fields.access, `${fields.name}: role says ${fields.access}, policy treats it as ${policy}`);
  }
});

test('a project with a mobile app: project.stack.mobile is a known key and shows in the facts (decision 101)', () => {
  const { dir } = makeRepo(null);
  writeProjectConfig(dir, { ...FULL_PROJECT, project: { ...FULL_PROJECT.project, stack: { backend: 'FastAPI (Python 3.13)', database: 'PostgreSQL 17', mobile: 'Flutter (Dart)' } } });
  const lane = subagentStart({ cwd: dir, agent_id: 'a1', agent_type: 'mobile-engineer' }, { HOME: '/Users/dev' }).hookSpecificOutput.additionalContext;
  assert.match(lane, /mobile Flutter \(Dart\), backend FastAPI \(Python 3\.13\), database PostgreSQL 17/);
  assert.doesNotMatch(lane, /invalid|unknown key/);
});

test("the lead's handover from another kit version gets the kit-change note (decision 121)", () => {
  const { dir } = makeRepo(null);
  writeProjectConfig(dir, FULL_PROJECT);
  const version = FULL_PROJECT.kit.version;
  const handover = path.join(dir, '.forge/handoffs/lead-handover.md');
  fs.mkdirSync(path.dirname(handover), { recursive: true });
  const start = (source = 'resume') => sessionStart({ cwd: dir, source }, { HOME: '/Users/dev' }).hookSpecificOutput.additionalContext;
  assert.doesNotMatch(start(), /KIT CHANGED/, 'no handover, no note');
  fs.writeFileSync(handover, 'Updated 2026-10-14. OWNER ITEMS: accept #2-#22 (In Testing; never move or close them).\n');
  let text = start();
  assert.match(text, /^KIT CHANGED: .*written for se-forge an older version \(no Kit: line\)/);
  assert.match(text, new RegExp(`${version.replace(/\./g, '\\.')} is active now.*\\.forge/kit/CHANGELOG\\.md.*pipeline/SKILL\\.md.*follow the skill.*"Kit: ${version.replace(/\./g, '\\.')}"`));
  fs.writeFileSync(handover, 'Kit: 0.2.17\nUpdated 2026-10-14.\n');
  assert.match(start('startup'), /written for se-forge 0\.2\.17;/);
  fs.writeFileSync(handover, `Kit: ${version}\nUpdated 2026-10-14.\n`);
  assert.doesNotMatch(start(), /KIT CHANGED/, 'stamped with the active kit: no note');
  fs.writeFileSync(handover, `**Kit:** se-forge ${version}\n`);
  assert.doesNotMatch(start(), /KIT CHANGED/, 'emphasis and the product name are fine');
});
