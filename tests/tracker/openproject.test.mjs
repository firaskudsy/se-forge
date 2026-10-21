// The OpenProject adapter against a fake curl that logs each request and answers like REST API v3.
// Runs under /bin/bash (3.2 on macOS). The fake also checks the API key never reaches curl's arguments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TRACKER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../core/tracker/tracker.sh');
const KEY = 'op-secret-key-123';

const FAKE = String.raw`#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
const at = (f) => { const k = a.indexOf(f); return k < 0 ? null : a[k + 1]; };
const method = at('-X') || 'GET';
const url = new URL(a[a.length - 1]);
const p = url.pathname.replace(/^\/api\/v3/, '');
const cfg = at('-K') ? fs.readFileSync(at('-K'), 'utf8') : '';
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ method, path: p, query: url.search, body: at('--data-binary'), argv: a.join(' '), auth: cfg.includes('apikey:' + process.env.FAKE_EXPECT_KEY) }) + '\n');
const wp = (id, status, subject) => ({ id, subject, lockVersion: 3, description: { raw: 'desc' }, createdAt: '2026-10-07T08:00:00Z', updatedAt: '2026-10-07T09:00:00Z',
  _links: { status: { title: status, href: '/api/v3/statuses/' + (status === 'Todo' ? 1 : 7) }, type: { title: 'Task' }, assignee: { title: 'Amal' }, author: { title: 'Amal' } } });
const orders = JSON.parse(process.env.FAKE_ORDERS || '{"11":{"42":0},"12":{},"21":{"42":0},"22":{}}');
const names = { 11: 'Todo', 12: 'In Process', 21: 'Backlog', 22: 'In Development' };
let r = null;
if (p === '/work_packages/42') r = wp(42, 'Todo', 'Login');
else if (p === '/statuses') r = { _embedded: { elements: [{ name: 'Todo', isClosed: false, _links: { self: { href: '/api/v3/statuses/1' } } }, { name: 'In Development', _links: { self: { href: '/api/v3/statuses/7' } } }, { name: 'Closed', isClosed: true, _links: { self: { href: '/api/v3/statuses/12' } } }] } };
else if (/\/types$/.test(p)) r = { _embedded: { elements: [{ name: 'Task', _links: { self: { href: '/api/v3/types/1' } } }, { name: 'Bug', _links: { self: { href: '/api/v3/types/7' } } }] } };
else if (/\/work_packages$/.test(p) && method === 'GET') r = { _embedded: { elements: [wp(42, 'Todo', 'Login'), wp(43, 'In Development', 'Orders')] } };
else if (p === '/grids/5') r = { widgets: [{ startColumn: 2, options: { queryId: 12 } }, { startColumn: 1, options: { queryId: 11 } }] };
else if (p === '/grids/6') r = { widgets: [{ startColumn: 1, options: { queryId: 21 } }, { startColumn: 2, options: { queryId: 22 } }] };
else if (/^\/queries\/\d+\/order$/.test(p)) r = method === 'GET' ? orders[p.split('/')[2]] : {};
else if (/^\/queries\/\d+$/.test(p)) { const q = p.split('/')[2]; r = { name: names[q], _embedded: { results: { _embedded: { elements: orders[q] && '42' in orders[q] ? [wp(42, 'Todo', 'Login')] : [] } } } }; }
else if (/\/work_packages$/.test(p) && method === 'POST') r = wp(44, 'Todo', 'x');
else if (method === 'PATCH' || method === 'POST') r = {};
process.stdout.write(JSON.stringify(r ?? { message: 'not found' }) + '\n' + (r ? 200 : 404));
`;

// The keychain tools answer only when the test gives them a key, so the real ones on this machine are never asked.
const KEYTOOL = (v) => `#!/bin/sh\n[ -n "$${v}" ] || exit 44\nprintf '%s\\n' "$${v}"\n`;

function op(args, env = {}, setup = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-op-'));
  fs.writeFileSync(path.join(dir, 'curl'), FAKE, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'security'), KEYTOOL('FAKE_SECURITY_KEY'), { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'secret-tool'), KEYTOOL('FAKE_SECRET_KEY'), { mode: 0o755 });
  setup(dir);
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(log, '');
  const r = spawnSync('/bin/bash', [TRACKER, ...args], {
    encoding: 'utf8', cwd: dir,
    env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, USER: 'amal', FORGE_TRACKER: 'openproject', FAKE_LOG: log, FAKE_EXPECT_KEY: KEY, OPENPROJECT_URL: 'https://op.example.com/', OPENPROJECT_API_KEY: KEY, OPENPROJECT_PROJECT: 'https://op.example.com/projects/ird/work_packages', ...env },
  });
  const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  for (const c of calls) { assert.ok(c.auth, 'the key is sent'); assert.ok(!c.argv.includes(KEY), 'the key is never an argument'); }
  assert.ok(!`${r.stdout}${r.stderr}`.includes(KEY), 'the key is never printed');
  return { code: r.status, out: r.stdout, err: r.stderr, calls, writes: calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path} ${c.body ?? ''}`.trim()) };
}

// A key file in the temp HOME, with the given mode.
const keyFile = (mode, key = KEY) => (dir) => {
  const f = path.join(dir, '.config/se-forge/openproject-key');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `${key}\n`);
  fs.chmodSync(f, mode);
};
const TWO = { OPENPROJECT_BOARDS: 'issues=5,frontend=6' };

test('openproject: a missing setting is named, never its value', () => {
  const r = op(['get', '42'], { OPENPROJECT_PROJECT: '' });
  assert.equal(r.code, 2);
  assert.match(r.err, /OPENPROJECT_PROJECT is not set/);
  assert.deepEqual(r.calls, []);
});

test('openproject: no API key anywhere names all four places', () => {
  const r = op(['get', '42'], { OPENPROJECT_API_KEY: '' });
  assert.equal(r.code, 2);
  assert.match(r.err, /no API key found\. Looked in: the OPENPROJECT_API_KEY environment variable; the macOS Keychain \(service se-forge-openproject\); the Linux keyring \(secret-tool, service se-forge-openproject\); the file .*\/\.config\/se-forge\/openproject-key/);
  assert.deepEqual(r.calls, []);
});

test('openproject: the key comes from the environment, then the Keychain, then secret-tool, then the private file', () => {
  const OTHER = 'not-this-one';
  // The environment wins over everything.
  let r = op(['get', '42'], { FAKE_SECURITY_KEY: OTHER, FAKE_SECRET_KEY: OTHER }, keyFile(0o600, OTHER));
  assert.equal(r.code, 0, r.err);
  // The Keychain (looked up for $USER) wins over secret-tool and the file.
  r = op(['get', '42'], { OPENPROJECT_API_KEY: '', FAKE_SECURITY_KEY: KEY, FAKE_SECRET_KEY: OTHER }, keyFile(0o600, OTHER));
  assert.equal(r.code, 0, r.err);
  r = op(['get', '42'], { OPENPROJECT_API_KEY: '', FAKE_SECRET_KEY: KEY }, keyFile(0o600, OTHER));
  assert.equal(r.code, 0, r.err);
  r = op(['get', '42'], { OPENPROJECT_API_KEY: '' }, keyFile(0o600));
  assert.equal(r.code, 0, r.err);
  r = op(['get', '42'], { OPENPROJECT_API_KEY: '', XDG_CONFIG_HOME: '/nowhere' }, keyFile(0o600));
  assert.equal(r.code, 2, 'XDG_CONFIG_HOME moves the file');
});

test('openproject: a key file others can read is refused, except on Git Bash', () => {
  const r = op(['get', '42'], { OPENPROJECT_API_KEY: '' }, keyFile(0o644));
  assert.equal(r.code, 2);
  assert.match(r.err, /openproject-key is readable by others; refusing it\. Run: chmod 600/);
  assert.deepEqual(r.calls, []);
  const msys = op(['get', '42'], { OPENPROJECT_API_KEY: '' }, (dir) => {
    keyFile(0o644)(dir);
    fs.writeFileSync(path.join(dir, 'uname'), '#!/bin/sh\necho MINGW64_NT-10.0\n', { mode: 0o755 });
  });
  assert.equal(msys.code, 0, msys.err);
});

test('openproject: get prints a summary, from a project given as a pasted URL', () => {
  const r = op(['get', '42']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^#42 Login {2}status=Todo {2}type=Task {2}assignee=Amal\nurl: https:\/\/op\.example\.com\/work_packages\/42\n--- description\ndesc/);
  const list = op(['list', 'open']);
  assert.ok(list.calls.some((c) => c.path === '/projects/ird/work_packages'), list.calls.map((c) => c.path).join('\n'));
});

test('openproject: list board groups by status without a board', () => {
  const r = op(['list', 'board']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /== In Development\n {2}#43 Orders {2}Amal\n== Todo\n {2}#42 Login {2}Amal/);
});

test('openproject: list board shows a basic board\'s columns left to right', () => {
  const r = op(['list', 'board'], { OPENPROJECT_BOARD: '5' });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^== Todo\n {2}#42 Login {2}\[Todo\] {2}Amal\n== In Process\n$/);
});

test('openproject: list board takes a board by name or id, the default board without one, and all of them', () => {
  const byName = op(['list', 'board', 'frontend'], TWO);
  assert.equal(byName.code, 0, byName.err);
  assert.match(byName.out, /^== Backlog\n {2}#42 Login {2}\[Todo\] {2}Amal\n== In Development\n$/);
  assert.equal(op(['list', 'board', '6'], TWO).out, byName.out, 'an id as is');
  assert.match(op(['list', 'board'], TWO).out, /^== Todo\n/, 'without a default board, the first one');
  assert.match(op(['list', 'board'], { ...TWO, OPENPROJECT_BOARD: '6' }).out, /^== Backlog\n/, 'the default board');
  const unknown = op(['list', 'board', 'mobile'], TWO);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /no board named 'mobile' in project\.openproject\.boards \(configured: issues,frontend\)/);
  const all = op(['list', 'board', 'all'], TWO);
  assert.equal(all.code, 0, all.err);
  assert.match(all.out, /^### issues \(5\)\n== Todo\n {2}#42 Login.*\n== In Process\n### frontend \(6\)\n== Backlog\n {2}#42 Login.*\n== In Development\n$/);
});

test('openproject: with no boards, list board all says so and groups by status', () => {
  const r = op(['list', 'board', 'all']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^no boards configured \(project\.openproject\.boards\): open work packages by status\n== In Development\n {2}#43 Orders/);
  assert.ok(!r.calls.some((c) => c.path.startsWith('/grids')));
});

test('openproject: a board OpenProject does not have is named in one line, and the rest goes on', () => {
  const all = op(['list', 'board', 'all'], { OPENPROJECT_BOARDS: 'gone=9,issues=5' });
  assert.equal(all.code, 0, all.err);
  assert.equal(all.err, 'board gone (9): not found on OpenProject (or this API key cannot see it); skipped\n');
  assert.match(all.out, /### gone \(9\)\n### issues \(5\)\n== Todo/);
  const st = op(['status', '42', 'In Development'], { OPENPROJECT_BOARDS: 'gone=9,issues=5' });
  assert.equal(st.code, 0, st.err);
  assert.match(st.err, /^board gone \(9\): not found on OpenProject/);
  assert.match(st.out, /card moved to 'In Process' on board issues \(5\)/);
  const cr = op(['create', '--subject', 'x', '--board', 'gone', '--column', 'Todo'], { OPENPROJECT_BOARDS: 'gone=9' });
  assert.equal(cr.code, 0, cr.err);
  assert.match(cr.out, /^created #/);
});

test('openproject: status sets the status, comments, and moves the card to the matching column', () => {
  const r = op(['status', '42', 'In Development', '--comment', 'branch feat/42'], { OPENPROJECT_BOARD: '5' });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.writes, [
    'PATCH /work_packages/42 {"lockVersion":3,"_links":{"status":{"href":"/api/v3/statuses/7"}}}',
    'POST /work_packages/42/activities {"comment":{"raw":"branch feat/42"}}',
    'PATCH /queries/11/order {"delta":{"42":-1}}',
    'PATCH /queries/12/order {"delta":{"42":0}}',
  ]);
  assert.match(r.out, /#42 -> status In Development\ncard moved to 'In Process' on board default \(5\)/);
  const none = op(['status', '42', 'Nope']);
  assert.notEqual(none.code, 0);
  assert.match(none.err, /no status named 'Nope'/);
});

test('openproject: status moves the card on every board it sits on; a column named like the status wins', () => {
  const r = op(['status', '42', 'In Development'], TWO);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.writes, [
    'PATCH /work_packages/42 {"lockVersion":3,"_links":{"status":{"href":"/api/v3/statuses/7"}}}',
    'PATCH /queries/11/order {"delta":{"42":-1}}',
    'PATCH /queries/12/order {"delta":{"42":0}}',
    'PATCH /queries/21/order {"delta":{"42":-1}}',
    'PATCH /queries/22/order {"delta":{"42":0}}',
  ]);
  assert.match(r.out, /card moved to 'In Process' on board issues \(5\)\ncard moved to 'In Development' on board frontend \(6\)/);
  const one = op(['status', '42', 'In Development'], { ...TWO, FAKE_ORDERS: '{"11":{},"12":{},"21":{"42":3},"22":{"7":4}}' });
  assert.deepEqual(one.writes.slice(1), ['PATCH /queries/21/order {"delta":{"42":-1}}', 'PATCH /queries/22/order {"delta":{"42":5}}'], 'only where it sits, at the end of the column');
  const todo = op(['status', '42', 'Todo'], TWO);
  assert.equal(todo.writes.length, 1, 'Todo: the Todo column wins on board 5, where the card already is; board 6 has none, and Todo maps to no column');
  assert.match(todo.out, /card already in 'Todo' on board issues \(5\)\ncard left where it is on board frontend \(6\)/);
});

test('openproject: a card on no board is left alone and said so; with no boards, status says nothing of cards', () => {
  const r = op(['status', '42', 'Closed'], { ...TWO, FAKE_ORDERS: '{"11":{},"12":{},"21":{},"22":{}}' });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.writes, ['PATCH /work_packages/42 {"lockVersion":3,"_links":{"status":{"href":"/api/v3/statuses/12"}}}']);
  assert.match(r.out, /card #42 is on none of the boards \(issues \(5\), frontend \(6\)\): not moved/);
  const none = op(['status', '42', 'Closed']);
  assert.equal(none.code, 0, none.err);
  assert.equal(none.out, '#42 -> status Closed\n');
  assert.equal(none.err, '');
  assert.ok(!none.calls.some((c) => c.path.startsWith('/grids') || c.path.startsWith('/queries')));
});

test('openproject: create --board X --column Y places the card on X only', () => {
  const r = op(['create', '--subject', 'x', '--board', 'frontend', '--column', 'In Development'], { ...TWO, FAKE_ORDERS: '{"11":{},"12":{},"21":{},"22":{"7":2}}' });
  assert.equal(r.code, 0, r.err);
  assert.ok(r.writes.slice(1).every((w) => w.startsWith('PATCH /queries/22/')), r.writes.join('\n'));
  assert.match(r.out, /card moved to 'In Development' on board frontend \(6\)/);
});

test('openproject: create --board without boards creates the work package and says the card was not placed', () => {
  for (const env of [{}, TWO]) {
    const r = op(['create', '--subject', 'x', '--board', 'mobile', '--column', 'Pending'], env);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^created #/);
    assert.equal(r.err, env.OPENPROJECT_BOARDS ? "card not placed: no board named 'mobile' in project.openproject.boards\n" : 'card not placed: no OpenProject board configured (project.openproject.boards)\n');
    assert.ok(!r.calls.some((c) => c.path.startsWith('/grids')));
  }
});

test('openproject: create in a dry run writes nothing and keeps labels in the description', () => {
  const r = op(['create', '--subject', '[Bug] x', '--type', 'Bug', '--source', 'ai', '--area', 'ui', '--board', '5', '--column', 'Todo'], { TRACKER_DRY_RUN: '1', OPENPROJECT_BOARDS: 'issues=5' });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.writes, []);
  assert.match(r.err, /DRY RUN: POST \/projects\/ird\/work_packages subject='\[Bug\] x' type=Bug status=Todo/);
  assert.match(r.err, /DRY RUN: place the card in 'Todo' on board issues \(5\)/);
  const live = op(['create', '--subject', 'y', '--source', 'ai']);
  assert.ok(live.writes[0].startsWith('POST /projects/ird/work_packages') && live.writes[0].includes('Labels: source::ai'), live.writes.join('\n'));
});

test('openproject: list json has the shape every adapter prints', () => {
  const r = op(['list', 'json']);
  assert.deepEqual(JSON.parse(r.out)[0], { id: 42, title: 'Login', labels: ['type::Task', 'status::Todo'], state: 'opened', createdAt: '2026-10-07T08:00:00Z', updatedAt: '2026-10-07T09:00:00Z', author: 'Amal', url: 'https://op.example.com/work_packages/42' });
});
