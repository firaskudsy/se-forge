import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeRepo, ctxFor, decideBash, DEFAULT_TEST_CONFIG } from './helpers.mjs';
import { combine } from '../../core/policy/lib/decision.mjs';
import { checkFileTool } from '../../core/policy/lib/files.mjs';
import { isSecretPath } from '../../core/policy/lib/paths.mjs';
import { recordApproval } from '../../core/policy/lib/approvals.mjs';

const { dir } = makeRepo();
fs.writeFileSync(path.join(dir, 'app.csproj'), '<Project>\n  <ItemGroup>\n    <PackageReference Include="Serilog" Version="3.1.1" />\n  </ItemGroup>\n</Project>\n');
fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "x"\ndependencies = [\n  "fastapi>=0.110",\n]\n\n[tool.ruff]\nline-length = 100\n');
const p = (rel) => path.join(dir, rel);
const decide = (tool, tool_input, ctx = ctxFor(dir)) => combine(checkFileTool({ tool_name: tool, tool_input }, ctx)).decision;
const pkg = fs.readFileSync(p('package.json'), 'utf8');

const CASES = [
  ['Write', { file_path: p('.env'), content: 'X=1' }, 'deny'],
  ['Write', { file_path: p('.env.staging'), content: 'X=1' }, 'deny'],
  ['Edit', { file_path: p('.env.local'), old_string: 'a', new_string: 'b' }, 'deny'],
  ['Write', { file_path: p('.env.example'), content: 'X=' }, 'allow'],
  ['Write', { file_path: p('src/lib/api/generated/client.ts'), content: 'x' }, 'deny'],
  ['MultiEdit', { file_path: p('src/lib/api/generated/client.ts'), edits: [] }, 'deny'],
  ['Edit', { file_path: p('docs/user-stories.md'), old_string: '#', new_string: '##' }, 'deny'],
  ['NotebookEdit', { notebook_path: p('docs/user-stories.md'), new_source: 'x' }, 'deny'],
  ['Edit', { file_path: p('db/migrations/001_init.sql'), old_string: 'int', new_string: 'bigint' }, 'deny'],
  ['Write', { file_path: p('db/migrations/002_add_email.sql'), content: 'alter table t add email text;' }, 'allow'],
  ['Write', { file_path: p('infra/terraform.tfstate'), content: '{}' }, 'deny'],
  ['Edit', { file_path: p('infra/.terraform/providers/x'), old_string: 'a', new_string: 'b' }, 'deny'],
  ['Edit', { file_path: p('package-lock.json'), old_string: 'a', new_string: 'b' }, 'deny'],
  ['Edit', { file_path: p('.terraform.lock.hcl'), old_string: 'a', new_string: 'b' }, 'deny'],
  ['Write', { file_path: p('.claude/settings.local.json'), content: '{}' }, 'deny'],
  ['Edit', { file_path: p('.claude/settings.json'), old_string: 'a', new_string: 'b' }, 'deny'],
  ['Write', { file_path: p('.forge/state/approvals.json'), content: '{}' }, 'deny'],
  ['Write', { file_path: p('.git/hooks/pre-commit'), content: '' }, 'deny'],
  ['Edit', { file_path: p('.forge/project/project.json'), old_string: 'a', new_string: 'b' }, 'ask'],
  ['Write', { file_path: p('.github/workflows/ci.yml'), content: 'on: push' }, 'ask'],
  ['Write', { file_path: p('.gitlab-ci.yml'), content: 'stages: []' }, 'ask'],
  ['Write', { file_path: p('docs/adr/0002-use-postgres.md'), content: '# ADR' }, 'ask'],
  ['Write', { file_path: p('.claude/agents/new.md'), content: '---' }, 'ask'],
  ['Edit', { file_path: p('src/auth/login.ts'), old_string: 'export', new_string: 'export const x = 1\nexport' }, 'ask'],
  ['Write', { file_path: p('src/features/home/Home.tsx'), content: 'x' }, 'allow'],
  ['Edit', { file_path: p('package.json'), old_string: '"test": "vitest"', new_string: '"test": "vitest run"' }, 'allow'],
  ['Edit', { file_path: p('package.json'), old_string: '"react": "^19.0.0"', new_string: '"react": "^19.0.0",\n    "zod": "^3.23.0"' }, 'ask'],
  ['Write', { file_path: p('package.json'), content: pkg.replace('^19.0.0', '^18.0.0') }, 'ask'],
  ['Edit', { file_path: p('app.csproj'), old_string: '</ItemGroup>', new_string: '  <PackageReference Include="Dapper" Version="2.1.0" />\n  </ItemGroup>' }, 'ask'],
  ['Edit', { file_path: p('pyproject.toml'), old_string: 'line-length = 100', new_string: 'line-length = 120' }, 'allow'],
  ['Edit', { file_path: p('pyproject.toml'), old_string: '"fastapi>=0.110",', new_string: '"fastapi>=0.110",\n  "httpx",' }, 'ask'],
  ['Write', { file_path: p('requirements.txt'), content: 'requests==2.32\n' }, 'ask'],
  ['Read', { file_path: p('.env') }, 'deny'],
  ['Read', { file_path: '/Users/dev/.aws/credentials' }, 'deny'],
  ['Read', { file_path: p('.env.example') }, 'allow'],
  ['Read', { file_path: p('src/auth/login.ts') }, 'allow'],
  ['Grep', { pattern: 'TOKEN', path: p('.env') }, 'deny'],
  ['Grep', { pattern: 'TOKEN', glob: '.env*' }, 'deny'],
  ['Grep', { pattern: 'TOKEN', path: p('src') }, 'allow'],
];

for (const [tool, input, want] of CASES) {
  test(`${want.padEnd(5)} ${tool} ${path.relative(dir, input.file_path ?? input.notebook_path ?? input.path ?? input.glob ?? '')}`, () => {
    assert.equal(decide(tool, input), want);
  });
}

test('a recorded human approval lets security-sensitive edits through on that branch only', () => {
  const ctx = ctxFor(dir);
  recordApproval(ctx, 'security', 'feat/1-login', { by: 'test' });
  assert.equal(decide('Edit', { file_path: p('src/auth/login.ts'), old_string: 'export', new_string: 'export ' }), 'allow');
  fs.rmSync(path.join(dir, '.forge'), { recursive: true, force: true });
  assert.equal(decide('Edit', { file_path: p('src/auth/login.ts'), old_string: 'export', new_string: 'export ' }), 'ask');
});

test('register-approved libraries: adding them asks no one; anything else still asks', () => {
  const { dir } = makeRepo({ ...DEFAULT_TEST_CONFIG, deps: { approved: ['httpx', 'lodash', '@tanstack/react-query', 'Serilog'] } });
  const ctx = ctxFor(dir);
  const bash = (c) => decideBash(c, ctx).decision;
  for (const c of ['uv add httpx', 'npm install lodash@4', 'npm install @tanstack/react-query@5', 'pnpm add lodash', 'pip install "httpx[http2]>=0.28"', 'dotnet add src/Api package Serilog --version 4.0.0']) assert.equal(bash(c), 'allow', c);
  for (const c of ['uv add httpx requests', 'npm install -g lodash', 'dotnet add src/Api package Newtonsoft.Json', 'npm uninstall lodash', 'uv remove httpx', 'npm update lodash']) assert.equal(bash(c), 'ask', c);

  const pkg = path.join(dir, 'package.json');
  const base = JSON.parse(fs.readFileSync(pkg, 'utf8'));
  const write = (deps) => combine(checkFileTool({ tool_name: 'Write', tool_input: { file_path: pkg, content: JSON.stringify({ ...base, dependencies: deps }, null, 2) } }, ctx)).decision;
  assert.equal(write({ ...base.dependencies, lodash: '^4.17.0' }), 'allow', 'adds an approved package');
  assert.equal(write({ ...base.dependencies, leftpad: '^1.0.0' }), 'ask', 'adds another package');
  assert.equal(write({}), 'ask', 'removes a package');
  const py = path.join(dir, 'pyproject.toml');
  fs.writeFileSync(py, '[project]\nname = "x"\ndependencies = [\n  "fastapi>=0.142",\n]\n');
  const pyWrite = (deps) => combine(checkFileTool({ tool_name: 'Write', tool_input: { file_path: py, content: `[project]\nname = "x"\ndependencies = [\n${deps.map((d) => `  "${d}",`).join('\n')}\n]\n` } }, ctx)).decision;
  assert.equal(pyWrite(['fastapi>=0.142', 'httpx>=0.28']), 'allow');
  assert.equal(pyWrite(['fastapi>=0.142', 'requests>=2']), 'ask');
});

test('container images in Dockerfiles and compose files are dependencies: changing them asks', () => {
  const { dir } = makeRepo();
  const f = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); return path.join(dir, rel); };
  const docker = f('api/Dockerfile', 'FROM node:24-bookworm AS dev\nRUN npm ci\n\nFROM node:24-bookworm-slim AS build\nRUN npm run build\n\nFROM node:24-bookworm-slim\nCOPY --from=build /app/dist ./dist\n');
  const compose = f('compose.yaml', 'services:\n  db:\n    image: postgres:17-alpine\n  api:\n    build: .\n');
  const run = (tool, input) => combine(checkFileTool({ tool_name: tool, tool_input: input }, ctxFor(dir)));
  const cases = [
    ['a new base tag', 'Edit', { file_path: docker, old_string: 'FROM node:24-bookworm AS dev', new_string: 'FROM node:26-bookworm AS dev' }, 'ask'],
    ['a platform flag and a new image', 'Edit', { file_path: docker, old_string: 'FROM node:24-bookworm-slim\n', new_string: 'FROM --platform=linux/amd64 gcr.io/distroless/nodejs24\n' }, 'ask'],
    ['a stage reference', 'Edit', { file_path: docker, old_string: 'FROM node:24-bookworm-slim\nCOPY', new_string: 'FROM node:24-bookworm-slim AS final\nCOPY' }, 'allow'],
    ['a RUN line', 'Edit', { file_path: docker, old_string: 'RUN npm ci', new_string: 'RUN npm ci --no-audit' }, 'allow'],
    ['a new Dockerfile', 'Write', { file_path: path.join(dir, 'web/Dockerfile'), content: 'FROM caddy:2-alpine\n' }, 'ask'],
    ['a compose image', 'Edit', { file_path: compose, old_string: 'postgres:17-alpine', new_string: 'postgres:18-alpine' }, 'ask'],
    ['a new compose service image', 'Edit', { file_path: compose, old_string: '  api:\n', new_string: '  mail:\n    image: axllent/mailpit:v1.27\n  api:\n' }, 'ask'],
    ['compose settings', 'Edit', { file_path: compose, old_string: 'build: .', new_string: 'build: { context: ., target: dev }' }, 'allow'],
  ];
  for (const [name, tool, input, want] of cases) {
    const r = run(tool, input);
    assert.equal(r.decision, want, name);
    if (want === 'ask') assert.ok(r.findings.some((x) => x.rule === 'deps:image'), name);
  }
});

test('a path through a symlink to the repository meets the same rules (git names the repo by its real path)', () => {
  const { dir } = makeRepo();
  const link = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-link-'))), 'repo');
  fs.symlinkSync(dir, link, 'dir');
  const via = (rel) => path.join(link, rel);
  for (const cwd of [dir, link]) {
    const ctx = ctxFor(cwd);
    const cases = [
      ['Write', { file_path: via('docs/user-stories.md'), content: 'x' }, 'deny'],
      ['Edit', { file_path: via('db/migrations/001_init.sql'), old_string: 'int', new_string: 'bigint' }, 'deny'],
      ['Write', { file_path: via('src/lib/api/generated/client.ts'), content: 'x' }, 'deny'],
      ['Write', { file_path: via('src/feature.ts'), content: 'x' }, 'allow'],
    ];
    for (const [tool, input, want] of cases) assert.equal(decide(tool, input, ctx), want, `${input.file_path} (cwd ${cwd === dir ? 'real' : 'link'})`);
    for (const [cmd, want] of [[`echo x > ${via('docs/user-stories.md')}`, 'deny'], [`rm ${via('db/migrations/001_init.sql')}`, 'deny'], [`rm -rf ${via('src')}`, 'ask']]) {
      assert.equal(decideBash(cmd, ctx).decision, want, `${cmd} (cwd ${cwd === dir ? 'real' : 'link'})`);
    }
  }
});

test('the OpenProject key file and process environments are closed to the file tools (openproject:key, secrets:env-dump)', () => {
  const key = '/Users/dev/.config/se-forge/openproject-key';
  const run = (tool, input) => combine(checkFileTool({ tool_name: tool, tool_input: input }, ctxFor(dir)));
  for (const [tool, input, rule] of [
    ['Read', { file_path: key }, 'openproject:key'],
    ['Read', { file_path: '~/.config/se-forge/openproject-key' }, 'openproject:key'],
    ['Grep', { pattern: '.', path: key }, 'openproject:key'],
    ['Grep', { pattern: '.', path: '/Users/dev/.config/se-forge' }, 'openproject:key'],
    ['Grep', { pattern: '.', path: '/Users/dev', glob: '**/openproject-key' }, 'openproject:key'],
    ['Edit', { file_path: key, old_string: 'a', new_string: 'b' }, 'openproject:key'],
    ['Write', { file_path: key, content: 'fake-key-123' }, 'openproject:key'],
    ['Read', { file_path: '/proc/self/environ' }, 'secrets:env-dump'],
  ]) {
    const r = run(tool, input);
    assert.equal(r.decision, 'deny', `${tool} ${JSON.stringify(input)}`);
    assert.deepEqual(r.findings.map((f) => f.rule), [rule], `${tool} ${JSON.stringify(input)}`);
  }
  assert.equal(run('Read', { file_path: p('core/tracker/openproject-key.sh') }).decision, 'allow', 'the script that finds the key is code, not the key');
  assert.equal(isSecretPath(key, ctxFor(dir).config, '/Users/dev'), true, 'git add and writes treat the key file as a secret');
});
