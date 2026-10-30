// forge api: the project's API contract (OpenAPI 3.1).
//   forge api check [--spec <file>] [--base <tag>]   lint, breaking changes against the last api-v tag, version rule
//   forge api fetch                                   the spec at the pinned version (project.api.pin), bundled to JSON
//   forge api generate                                fetch, then the project's generate command with {spec}
// Tools, pinned: Redocly CLI through npx, and oasdiff (installed, or its Docker image).
// FORGE_REDOCLY / FORGE_OASDIFF replace the tool commands (tests, or a locally installed copy).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../policy/lib/config.mjs';
import { git, mainRootOf } from '../policy/lib/context.mjs';

export const REDOCLY = '@redocly/cli@2.59.0';
export const OASDIFF_IMAGE = 'tufin/oasdiff:v1.33.0';
const TAG = /^api-v(\d+)\.(\d+)\.(\d+)$/;

export class ApiError extends Error {}

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
const output = (r) => `${r.stdout || ''}${r.stderr || ''}`.trim();
const tail = (text, n = 25) => text.split('\n').slice(-n).join('\n');

function semver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ''));
  return m ? m.slice(1, 4).map(Number) : null;
}
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

function redocly(env) {
  return env.FORGE_REDOCLY ? env.FORGE_REDOCLY.split(' ') : ['npx', '--yes', REDOCLY];
}

// oasdiff installed, else its Docker image with the work folder mounted at the same path.
function oasdiff(env, dir) {
  if (env.FORGE_OASDIFF) return env.FORGE_OASDIFF.split(' ');
  if (run('oasdiff', ['--version']).status === 0) return ['oasdiff'];
  if (run('docker', ['version', '--format', '{{.Server.Version}}']).status === 0) return ['docker', 'run', '--rm', '-v', `${dir}:${dir}:ro`, OASDIFF_IMAGE];
  throw new ApiError('oasdiff is needed for the breaking-change check: brew install oasdiff (or start Docker).');
}

// The spec bundled into one JSON file (resolves $refs across files), and its parsed content.
function bundle(env, spec, out) {
  const [cmd, ...pre] = redocly(env);
  const r = run(cmd, [...pre, 'bundle', spec, '--ext', 'json', '-o', out]);
  if (r.status !== 0 || !fs.existsSync(out)) throw new ApiError(`cannot bundle ${spec}:\n${tail(output(r))}`);
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

function apiTags(root) {
  return git(root, ['tag', '-l', 'api-v*']).out.split('\n').filter((t) => TAG.test(t))
    .sort((a, b) => cmp(semver(b.slice(5)), semver(a.slice(5))));
}

// The files of <dir> at <ref> of <repo>, written under <into>.
function extract(repo, ref, rel, into) {
  const dir = path.posix.dirname(rel);
  const archive = run('git', ['archive', '--format=tar', ref, '--', dir === '.' ? rel : dir], { cwd: repo, encoding: 'buffer' });
  if (archive.status !== 0) throw new ApiError(`${rel} not found at ${ref}: ${String(archive.stderr).trim()}`);
  fs.mkdirSync(into, { recursive: true });
  const untar = run('tar', ['-x', '-C', into], { input: archive.stdout });
  if (untar.status !== 0) throw new ApiError(`cannot unpack ${rel} at ${ref}`);
  return path.join(into, rel);
}

function context(cwd, env) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!top.ok) throw new ApiError('Run forge api inside the project\'s git repository.');
  const main = mainRootOf(cwd, env);
  const { project, config } = loadConfig(main, env);
  return { root: top.out, main, api: project.api, project, config };
}

export function check(o, env, cwd, out) {
  const { root, api } = context(cwd, env);
  if (!o.spec && api.contractRepo) throw new ApiError(`This repo consumes the contract from ${api.contractRepo}: check it there, or pass --spec <file>.`);
  const specArg = typeof o.spec === 'string' ? o.spec : api.spec;
  if (!specArg) throw new ApiError('No spec: set project.api.spec, or pass --spec <file>.');
  const spec = path.resolve(typeof o.spec === 'string' ? cwd : root, specArg);
  if (!fs.existsSync(spec)) throw new ApiError(`${spec} does not exist.`);
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-api-')));
  const problems = [];

  const [cmd, ...pre] = redocly(env);
  const lint = run(cmd, [...pre, 'lint', spec]);
  out(`lint: ${lint.status === 0 ? 'ok' : 'FAILED'}`);
  if (lint.status !== 0) { out(tail(output(lint))); problems.push('the spec has lint errors'); }

  const rev = bundle(env, spec, path.join(tmp, 'rev.json'));
  const revV = semver(rev.info?.version);
  if (!revV) problems.push(`info.version "${rev.info?.version}" is not semver`);

  const base = typeof o.base === 'string' ? o.base : apiTags(root)[0];
  if (!base) {
    out('breaking changes: no approved version yet (no api-v tag): this is the first');
  } else if (!api.spec && typeof o.base !== 'string') {
    out('breaking changes: skipped (set project.api.spec to compare with the approved version)');
  } else {
    const baseSpec = bundle(env, extract(root, base, api.spec || path.relative(root, spec), path.join(tmp, 'base')), path.join(tmp, 'base.json'));
    const baseV = semver(baseSpec.info?.version) || semver(base.slice(5));
    const [dcmd, ...dpre] = oasdiff(env, tmp);
    const diff = run(dcmd, [...dpre, 'breaking', path.join(tmp, 'base.json'), path.join(tmp, 'rev.json'), '--fail-on', 'ERR']);
    if (diff.status !== 0 && diff.status !== 1) throw new ApiError(`oasdiff failed:\n${tail(output(diff))}`);
    const breaking = diff.status === 1;
    const same = JSON.stringify({ ...baseSpec, info: { ...baseSpec.info, version: null } }) === JSON.stringify({ ...rev, info: { ...rev.info, version: null } });
    out(`breaking changes against ${base} (${baseV?.join('.')}): ${breaking ? 'YES' : 'none'}`);
    if (breaking) out(tail(output(diff), 40));
    if (revV && baseV && !same) {
      if (breaking && revV[0] <= baseV[0]) problems.push(`a breaking change needs a new major version: ${baseV[0] + 1}.0.0 (info.version is ${revV.join('.')})`);
      else if (cmp(revV, baseV) <= 0) problems.push(`the spec changed: raise info.version above ${baseV.join('.')}`);
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (problems.length) { out(`NOT OK: ${problems.join('; ')}`); return 1; }
  out(`ok: ${path.relative(cwd, spec) || spec} version ${revV?.join('.')}`);
  return 0;
}

// The spec as a ref has it (origin/<branch>), checked as forge api check checks it, for forge merge (decision 148):
// { ok, breaking, version, text }.
export function checkAt(env, cwd, ref) {
  const { root, api } = context(cwd, env);
  if (!api.spec) throw new ApiError('No spec: set project.api.spec.');
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-api-at-')));
  try {
    const lines = [];
    const code = check({ spec: extract(root, ref, api.spec, tmp) }, env, cwd, (l) => lines.push(l));
    const text = lines.join('\n');
    return { ok: code === 0, breaking: /^breaking changes against .*: YES$/m.test(text), version: /^ok: .* version (\d+\.\d+\.\d+)$/m.exec(text)?.[1] ?? null, text };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// forge api apply <draft> [--ticket <n>] [--breaking-approved] (decision 148): the lead puts a contract draft on its own
// branch from the base branch and opens its merge request, ready: chore/<n>-contract from
// .forge/project/contracts/<n>-<slug>.yaml, or chore/bootstrap-contract from .forge/project/bootstrap/contract.yaml.
// The draft is checked first as forge api check checks it; a breaking change needs the owner's decision
// (--breaking-approved, once they gave it). forge merge <branch> then merges it and tags api-v<version>.
export function apply(o, env, cwd, out) {
  const { root, api, project, config } = context(cwd, env);
  const usage = 'forge api apply <draft> [--ticket <n>] [--breaking-approved]';
  if (typeof o._[1] !== 'string') throw new ApiError(usage);
  if (!api.spec || api.contractRepo) throw new ApiError('This repo has no spec of its own (project.api.spec): apply the draft in the contract\'s repository.');
  const draft = path.resolve(cwd, o._[1]);
  if (!fs.existsSync(draft)) throw new ApiError(`${draft} does not exist.`);
  const bootstrap = /(^|\/)bootstrap\/contract\.(ya?ml|json)$/.test(draft);
  const ticket = typeof o.ticket === 'string' ? o.ticket.replace(/^#/, '') : /(^|\/)(\d+)-[^/]*\.(ya?ml|json)$/.exec(draft)?.[2];
  if (!bootstrap && !/^\d+$/.test(ticket ?? '')) throw new ApiError(`${usage}: a draft named <ticket>-<slug>.yaml, or --ticket <n>`);
  const branch = bootstrap ? 'chore/bootstrap-contract' : `chore/${ticket}-contract`;
  const lines = [];
  const code = check({ spec: draft }, env, cwd, (l) => lines.push(l));
  out(lines.join('\n'));
  if (code !== 0) throw new ApiError('the draft does not pass forge api check: the contract-analyst fixes it first.');
  if (/^breaking changes against .*: YES$/m.test(lines.join('\n')) && o['breaking-approved'] !== true) throw new ApiError(`the draft has breaking changes: the owner decides how consumers move (ask them; once they agree, ${usage.replace(' [--ticket <n>]', '')} with --breaking-approved).`);
  const version = /^ok: .* version (\d+\.\d+\.\d+)$/m.exec(lines.join('\n'))?.[1];
  const base = config.branches.base;
  if (!git(root, ['fetch', '-q', 'origin', base], 60000).ok) throw new ApiError(`git fetch origin ${base} failed.`);
  if (git(root, ['ls-remote', '--exit-code', '--heads', 'origin', branch]).ok) throw new ApiError(`${branch} is on origin already: merge it with forge merge ${branch}, or remove it first.`);
  const wt = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-api-apply-')));
  fs.rmSync(wt, { recursive: true, force: true });
  const step = (args, what) => { const r = git(wt, args, 120000); if (!r.ok) throw new ApiError(`${what} failed: ${r.err || r.out}`); return r; };
  const added = git(root, ['worktree', 'add', '-q', '-b', branch, wt, `origin/${base}`]);
  if (!added.ok) throw new ApiError(`cannot open ${branch}: ${added.err}`);
  try {
    fs.mkdirSync(path.dirname(path.join(wt, api.spec)), { recursive: true });
    fs.copyFileSync(draft, path.join(wt, api.spec));
    step(['add', api.spec], 'git add');
    const title = `docs(api): contract ${version}${ticket ? ` for #${ticket}` : ''}`;
    step(['commit', '-q', '-m', title], 'git commit');
    step(['push', '-q', '-u', 'origin', branch], 'git push');
    const body = `The API contract at version ${version}, from ${path.relative(root, draft)}${bootstrap ? ' (the bootstrap\'s, approved in the owner\'s review)' : ` (ticket #${ticket})`}. forge api check passed${o['breaking-approved'] === true ? '; its breaking changes were approved by the owner' : ''}. forge merge ${branch} merges it and tags api-v${version}.`;
    const r = project.host === 'github'
      ? run('gh', ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body], { cwd: wt, env })
      : run('glab', ['mr', 'create', '--source-branch', branch, '--target-branch', base, '--title', title, '--description', body, '--yes'], { cwd: wt, env });
    if (r.status !== 0) throw new ApiError(`the merge request was not opened: ${output(r)}`);
    out(`${branch}: contract ${version} pushed, merge request opened${output(r) ? `\n${tail(output(r), 3)}` : ''}\nNext: forge merge ${branch} (it merges, then tags api-v${version}).`);
    return 0;
  } finally {
    git(root, ['worktree', 'remove', '--force', wt]);
  }
}

// The approved spec at project.api.pin, bundled to JSON in .forge/state/api/, from this repo or the contract repo.
export function fetchSpec(env, cwd) {
  const { root, main, api } = context(cwd, env);
  if (!api.pin) throw new ApiError('No pinned contract version: a person sets project.api.pin (e.g. api-v1.2.0) after the contract is approved.');
  if (!api.spec) throw new ApiError('Set project.api.spec: the spec\'s path in the repo that owns the contract.');
  const file = path.join(main, '.forge', 'state', 'api', `${api.pin}.json`);
  if (fs.existsSync(file)) return file;
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-api-')));
  try {
    let repo = root;
    if (api.contractRepo) {
      repo = path.join(tmp, 'contract');
      run('git', ['init', '-q', repo]);
      const f = run('git', ['fetch', '-q', '--depth', '1', api.contractRepo, `refs/tags/${api.pin}:refs/tags/${api.pin}`], { cwd: repo });
      if (f.status !== 0) throw new ApiError(`cannot fetch ${api.pin} from ${api.contractRepo}: ${tail(output(f), 3)}`);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    bundle(env, extract(repo, api.pin, api.spec, path.join(tmp, 'spec')), file);
    return file;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function generate(env, cwd, out) {
  const { root, api } = context(cwd, env);
  if (!api.generate) throw new ApiError('No generate command: set project.api.generate (use {spec} for the spec file).');
  const spec = fetchSpec(env, cwd);
  const quoted = `'${spec.replace(/'/g, "'\\''")}'`;
  const r = run('sh', ['-c', api.generate.replaceAll('{spec}', quoted)], { cwd: root, env: { ...env, [api.specEnv]: spec } });
  out(tail(output(r), 10));
  out(r.status === 0 ? `generated from ${api.pin}` : `generate failed (exit ${r.status})`);
  return r.status === 0 ? 0 : 1;
}
