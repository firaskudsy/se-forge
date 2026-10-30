// forge merge <branch> and forge api apply (decision 148): the lead merges the bootstrap's branches once the owner
// approved its review, and a ticket's contract branch once forge api check passes (a breaking change on the owner's
// decision), then tags api-v<version> itself. glab is a fake whose `mr merge` really merges into dev on the remote;
// Redocly and oasdiff are the stand-ins of tests/cli/api.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeRepo, writeProjectConfig, sh, DEFAULT_TEST_CONFIG } from '../policy/helpers.mjs';
import { merge } from '../../core/cli/merge.mjs';
import { apply, ApiError } from '../../core/cli/api.mjs';

const FAKES = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-setup-fakes-')));
fs.writeFileSync(path.join(FAKES, 'redocly.mjs'), `
import fs from 'node:fs';
const [cmd, spec, ...rest] = process.argv.slice(2);
const text = fs.readFileSync(spec, 'utf8');
if (cmd === 'lint') { if (text.includes('LINT-ERROR')) { console.log('error: LINT-ERROR found'); process.exit(1); } console.log('valid'); }
if (cmd === 'bundle') fs.writeFileSync(rest[rest.indexOf('-o') + 1], JSON.stringify(JSON.parse(text)));
`);
fs.writeFileSync(path.join(FAKES, 'oasdiff.mjs'), `
import fs from 'node:fs';
const [, base, rev] = process.argv.slice(2);
const [b, r] = [base, rev].map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
const gone = Object.keys(b.paths || {}).filter((p) => !(p in (r.paths || {})));
if (gone.length) { console.log(gone.map((p) => 'error [api-path-removed] ' + p).join('\\n')); process.exit(1); }
console.log('No breaking changes');
`);
// glab: mr list from list.json; mr merge merges $FAKE_BRANCH into dev on the remote; mr update and mr create are noted.
const GLAB = `#!/bin/sh
echo "glab $*" >> "$FAKE_DIR/calls"
case "$1 $2" in
  "mr list") cat "$FAKE_DIR/list.json" ;;
  "mr merge")
    w="$FAKE_DIR/merge-work"; rm -rf "$w"; git clone -q "$FAKE_REMOTE" "$w" && cd "$w" && git -c user.email=t@e -c user.name=t checkout -q dev \\
      && git -c user.email=t@e -c user.name=t merge -q --no-ff "origin/$FAKE_BRANCH" -m "Merge branch '$FAKE_BRANCH' into 'dev'" && git push -q origin dev && echo merged ;;
  "mr update"|"mr create") echo "https://gitlab.example.com/g/p/-/merge_requests/7" ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`;
const spec = (version, paths = ['/v1/users']) => JSON.stringify({ openapi: '3.1.0', info: { title: 'T', version }, paths: Object.fromEntries(paths.map((p) => [p, { get: { responses: { 200: { description: 'ok' } } } }])) }, null, 2);

function setup() {
  const { dir, remote } = makeRepo();
  writeProjectConfig(dir, { project: { host: 'gitlab', api: { spec: 'api/openapi.json' } }, policy: DEFAULT_TEST_CONFIG });
  sh(dir, 'git', 'checkout', '-q', 'dev');
  const bin = path.join(dir, '.forge/fake-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'glab'), GLAB);
  fs.chmodSync(path.join(bin, 'glab'), 0o755);
  const env = { HOME: '/Users/dev', PATH: `${bin}:${process.env.PATH}`, FAKE_DIR: bin, FAKE_REMOTE: remote, FORGE_REDOCLY: `node ${path.join(FAKES, 'redocly.mjs')}`, FORGE_OASDIFF: `node ${path.join(FAKES, 'oasdiff.mjs')}` };
  const w = {
    dir, env, remote,
    // A branch from dev with these files, pushed, and its open MR (a draft unless said otherwise).
    branch(name, files, { draft = true } = {}) {
      sh(dir, 'git', 'checkout', '-q', '-b', name, 'origin/dev');
      for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); sh(dir, 'git', 'add', f); }
      sh(dir, 'git', 'commit', '-q', '-m', `chore: ${name}`);
      sh(dir, 'git', 'push', '-q', '-u', 'origin', name);
      fs.writeFileSync(path.join(bin, 'list.json'), JSON.stringify([{ iid: 7, draft, sha: sh(dir, 'git', 'rev-parse', 'HEAD') }]));
      w.env.FAKE_BRANCH = name;
      sh(dir, 'git', 'checkout', '-q', 'dev');
    },
    approve() { fs.mkdirSync(path.join(dir, '.forge/project/bootstrap'), { recursive: true }); fs.writeFileSync(path.join(dir, '.forge/project/bootstrap/review.md'), 'Approved: 2026-10-30, by the owner (1A).\n\n# Review\n'); },
    run(ticket, more = {}) { const lines = []; const code = merge({ ticket, ...more }, w.env, dir, (l) => lines.push(l)); return { code, out: lines.join('\n') }; },
    calls() { try { return fs.readFileSync(path.join(bin, 'calls'), 'utf8'); } catch { return ''; } },
    remoteTags() { return sh(dir, 'git', 'ls-remote', '--tags', 'origin').split('\n').filter(Boolean).map((l) => l.split('refs/tags/')[1]); },
    // The approved contract on dev: api-v1.0.0.
    contractOnDev() {
      fs.mkdirSync(path.join(dir, 'api'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'api/openapi.json'), spec('1.0.0'));
      sh(dir, 'git', 'add', 'api'); sh(dir, 'git', 'commit', '-q', '-m', 'docs(api): contract 1.0.0'); sh(dir, 'git', 'push', '-q', 'origin', 'dev');
      sh(dir, 'git', 'tag', 'api-v1.0.0'); sh(dir, 'git', 'push', '-q', 'origin', 'api-v1.0.0');
    },
  };
  return w;
}

test('chore/architecture: merged by the lead once the owner\'s approval of the review is recorded; documents only', () => {
  const w = setup();
  w.branch('chore/architecture', { 'docs/architecture/overview.md': '# Overview\n', 'docs/adr/0001-stack.md': '# ADR\n' });
  let r = w.run('chore/architecture');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /NOT MERGED: chore\/architecture@\w{8} into dev\n- the owner's approval of the bootstrap review is not recorded: once they approved, write "Approved: <date>, by the owner" at the top of \.forge\/project\/bootstrap\/review\.md/);
  w.approve();
  r = w.run('chore/architecture');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^merged chore\/architecture@\w{8} into dev \(MR\/PR 7\)$/);
  assert.match(w.calls(), /^glab mr update 7 --ready$/m, 'a draft is marked ready first');
  assert.match(w.calls(), /^glab mr merge 7 --yes --sha [0-9a-f]{40}$/m);

  const code = setup();
  code.approve();
  code.branch('chore/architecture', { 'docs/architecture/overview.md': '# Overview\n', 'src/auth/extra.ts': 'export {}\n' });
  r = code.run('chore/architecture');
  assert.equal(r.code, 1);
  assert.match(r.out, /- chore\/architecture changes more than documents \(src\/auth\/extra\.ts\): code goes in a ticket/);
  assert.doesNotMatch(code.calls(), /mr merge/);
});

test('chore/bootstrap-contract: merged once forge api check passes, then tagged api-v1.0.0 on dev and pushed', () => {
  const w = setup();
  w.approve();
  w.branch('chore/bootstrap-contract', { 'api/openapi.json': spec('1.0.0') }, { draft: false });
  const r = w.run('chore/bootstrap-contract');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^merged chore\/bootstrap-contract@\w{8} into dev \(MR\/PR 7\)\ntagged api-v1\.0\.0 on dev@\w{8} and pushed it: API and UI work on it can start$/);
  assert.ok(w.remoteTags().includes('api-v1.0.0'), w.remoteTags().join(' '));
  assert.doesNotMatch(w.calls(), /mr update/, 'a ready MR is left as it is');
});

test('a ticket\'s contract branch: only the contract, forge api check at its head, and a breaking change only on the owner\'s decision', () => {
  const w = setup();
  w.contractOnDev();
  w.branch('chore/5-contract', { 'api/openapi.json': spec('2.0.0', ['/v1/orders']) });
  let r = w.run('chore/5-contract');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /- the contract has breaking changes: the owner decides how consumers move \(ask them; once they agree, forge merge chore\/5-contract --breaking-approved\)/);
  r = w.run('chore/5-contract', { breakingApproved: true });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /tagged api-v2\.0\.0 on dev@\w{8} and pushed it: API and UI work on it can start \(put it on plan 5's Contract: line\)/);
  assert.ok(w.remoteTags().includes('api-v2.0.0'));

  const more = setup();
  more.contractOnDev();
  more.branch('chore/6-contract', { 'api/openapi.json': spec('1.1.0', ['/v1/users', '/v1/orders']), 'src/auth/login.ts': 'export const x = 1;\n' });
  r = more.run('chore/6-contract');
  assert.equal(r.code, 1);
  assert.match(r.out, /- chore\/6-contract changes more than the contract \(src\/auth\/login\.ts\): the rest goes in a ticket/);
  const same = setup();
  same.contractOnDev();
  same.branch('chore/7-contract', { 'api/openapi.json': spec('1.0.0', ['/v1/users', '/v1/orders']) });
  r = same.run('chore/7-contract');
  assert.equal(r.code, 1);
  assert.match(r.out, /forge api check fails at \w{8}:[\s\S]*raise info\.version above 1\.0\.0/);
});

test('forge api apply: a checked draft onto chore/<n>-contract from dev, pushed, with its merge request open; a breaking one waits for the owner', () => {
  const w = setup();
  w.contractOnDev();
  fs.mkdirSync(path.join(w.dir, '.forge/project/contracts'), { recursive: true });
  fs.writeFileSync(path.join(w.dir, '.forge/project/contracts/5-orders.json'), spec('1.1.0', ['/v1/users', '/v1/orders']));
  const lines = [];
  assert.equal(apply({ _: ['apply', '.forge/project/contracts/5-orders.json'] }, w.env, w.dir, (l) => lines.push(l)), 0, lines.join('\n'));
  assert.match(lines.join('\n'), /chore\/5-contract: contract 1\.1\.0 pushed, merge request opened[\s\S]*Next: forge merge chore\/5-contract \(it merges, then tags api-v1\.1\.0\)\.$/);
  assert.equal(sh(w.dir, 'git', 'show', 'origin/chore/5-contract:api/openapi.json'), spec('1.1.0', ['/v1/users', '/v1/orders']));
  assert.match(w.calls(), /^glab mr create --source-branch chore\/5-contract --target-branch dev --title docs\(api\): contract 1\.1\.0 for #5 --description .* --yes$/m);
  assert.equal(sh(w.dir, 'git', 'rev-parse', '--abbrev-ref', 'HEAD'), 'dev', 'the lead\'s checkout stays where it was');

  fs.writeFileSync(path.join(w.dir, '.forge/project/contracts/8-users.json'), spec('2.0.0', ['/v2/users']));
  assert.throws(() => apply({ _: ['apply', '.forge/project/contracts/8-users.json'] }, w.env, w.dir, () => {}), (e) => e instanceof ApiError && /breaking changes: the owner decides/.test(e.message));
  assert.equal(apply({ _: ['apply', '.forge/project/contracts/8-users.json'], 'breaking-approved': true }, w.env, w.dir, () => {}), 0);
  assert.throws(() => apply({ _: ['apply', '.forge/project/contracts/5-orders.json'] }, w.env, w.dir, () => {}), /chore\/5-contract is on origin already/);
});
