// Tracker adapters against fake gh/glab commands that log every call and answer like the real CLIs.
// They run under /bin/bash, which is bash 3.2 on macOS: the shell that crashed the original adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TRACKER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../core/tracker/tracker.sh');

const FAKE = String.raw`#!/usr/bin/env node
const fs = require('fs');
const [log, tool] = [process.env.FAKE_LOG, process.env.FAKE_TOOL];
const a = process.argv.slice(2);
fs.appendFileSync(log, JSON.stringify(a) + '\n');
const has = (...w) => w.every((x) => a.includes(x));
if (process.env.FAKE_FAIL && a.join(' ').startsWith(process.env.FAKE_FAIL)) { process.stderr.write('401 Unauthorized\n'); process.exit(1); }
const out = (v) => process.stdout.write(typeof v === 'string' ? v + '\n' : JSON.stringify(v));
if (tool === 'glab') {
  if (has('issue', 'view')) out({ iid: 12, title: 'Login', state: process.env.FAKE_STATE || 'opened', labels: ['status::Todo', 'type::Task'], assignees: [], web_url: 'https://gitlab.example.com/g/p/-/issues/12', description: 'desc' });
  else if (has('label', 'list')) out([{ name: 'status::Todo' }, { name: 'status::In Testing' }, { name: 'type::Task' }]);
  else if (has('issue', 'list')) out([{ iid: 12, title: 'Login', labels: ['status::Todo'], state: 'opened', assignees: [{ username: 'amal' }], created_at: '2026-10-07T08:00:00Z', updated_at: '2026-10-07T09:00:00Z', author: { username: 'amal' }, web_url: 'https://gitlab.example.com/g/p/-/issues/12' }]);
  else if (has('issue', 'create')) out('Creating issue in g/p\nhttps://gitlab.example.com/g/p/-/issues/34');
  else if (has('api')) out([{ id: 1, name: 'Issues', lists: [{ label: { name: 'Pending' } }] }]);
} else {
  if (has('issue', 'view') && a.includes('labels,state')) out({ labels: [{ name: 'status:Todo' }], state: process.env.FAKE_STATE || 'OPEN' });
  else if (has('issue', 'view')) out({ number: 7, title: 'Login', state: 'OPEN', labels: [{ name: 'status:Todo' }], assignees: [], url: 'https://github.com/o/r/issues/7', body: 'desc' });
  else if (has('label', 'list')) out([{ name: 'status:Todo' }, { name: 'type:Task' }]);
  else if (has('issue', 'create')) out('https://github.com/o/r/issues/8');
  else if (has('issue', 'list')) out([{ number: 7, title: 'Login', labels: [{ name: 'status:Todo' }], state: 'OPEN', assignees: [], createdAt: '2026-10-07T08:00:00Z', updatedAt: '2026-10-07T09:00:00Z', author: { login: 'amal' }, url: 'https://github.com/o/r/issues/7' }]);
}
`;

function tracker(tool, args, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-tracker-'));
  fs.writeFileSync(path.join(dir, tool), FAKE, { mode: 0o755 });
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(log, '');
  const r = spawnSync('/bin/bash', [TRACKER, ...args], {
    encoding: 'utf8', cwd: dir,
    env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, FORGE_TRACKER: tool === 'glab' ? 'gitlab' : 'github', FAKE_LOG: log, FAKE_TOOL: tool, ...env },
  });
  const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).join(' '));
  return { code: r.status, out: r.stdout, err: r.stderr, calls };
}
const writes = (calls) => calls.filter((c) => !/^(issue view|issue list|label list|api )/.test(c));

test('gitlab: get prints a summary', () => {
  const r = tracker('glab', ['get', '12']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^#12 Login {2}state=opened {2}labels=status::Todo,type::Task {2}assignee=-\nurl: https:\/\/gitlab\.example\.com\/g\/p\/-\/issues\/12/);
});

test('gitlab: status replaces the status label, reopens, comments', () => {
  const r = tracker('glab', ['status', '12', 'In Testing', '--comment', 'branch feat/12, abc123']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(writes(r.calls), [
    'issue update 12 --unlabel status::Todo --label status::In Testing',
    'issue reopen 12',
    'issue note 12 --message branch feat/12, abc123',
  ]);
});

test('gitlab: a done status closes the issue and creates the missing label', () => {
  const r = tracker('glab', ['status', '12', 'Done']);
  assert.deepEqual(writes(r.calls), ['label create --name status::Done', 'issue update 12 --unlabel status::Todo --label status::Done', 'issue close 12']);
});

test('a done status on an issue that is already closed changes only the label (decision 117)', () => {
  const gl = tracker('glab', ['status', '12', 'Done', '--comment', 'Released in v1.2.0'], { FAKE_STATE: 'closed' });
  assert.equal(gl.code, 0, gl.err);
  assert.deepEqual(writes(gl.calls), ['label create --name status::Done', 'issue update 12 --unlabel status::Todo --label status::Done', 'issue note 12 --message Released in v1.2.0']);
  const gh = tracker('gh', ['status', '7', 'Done'], { FAKE_STATE: 'CLOSED' });
  assert.equal(gh.code, 0, gh.err);
  assert.ok(!writes(gh.calls).some((c) => c.startsWith('issue close')), writes(gh.calls).join('\n'));
  assert.ok(writes(tracker('gh', ['status', '7', 'Done']).calls).includes('issue close 7'), 'an open one is closed');
});

test('a status change that fails says so and exits non-zero', () => {
  for (const [tool, env] of [['glab', { FAKE_FAIL: 'issue close' }], ['glab', { FAKE_FAIL: 'issue view' }], ['gh', { FAKE_FAIL: 'issue close' }]]) {
    const r = tracker(tool, ['status', tool === 'gh' ? '7' : '12', 'Done'], env);
    assert.notEqual(r.code, 0, `${tool} ${env.FAKE_FAIL}: ${r.out}`);
    assert.match(r.err, /tracker: could not/);
    assert.doesNotMatch(r.out, /-> status Done/);
  }
});

test('gitlab: create links, labels and places the card', () => {
  const r = tracker('glab', ['create', '--subject', '[Backend request] add email', '--description', 'body', '--relates', '12', '--board', 'issues', '--column', 'Pending']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /created #34 {2}https:\/\/gitlab\.example\.com\/g\/p\/-\/issues\/34\ncard placed in 'Pending' \(label Pending\)/);
  assert.ok(writes(r.calls).includes('issue create --title [Backend request] add email --description body --label type::Task,status::Todo --linked-issues 12 --link-type relates_to --yes'));
  assert.ok(writes(r.calls).includes('issue update 34 --label Pending'));
});

test('gitlab: dry run writes nothing', () => {
  for (const args of [['status', '12', 'Done', '--comment', 'x'], ['comment', '12', 'hi'], ['create', '--subject', 'x', '--relates', '3']]) {
    const r = tracker('glab', args, { TRACKER_DRY_RUN: '1' });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(writes(r.calls), [], args.join(' '));
    assert.match(r.err, /DRY RUN: glab /);
  }
});

test('gitlab: list board groups open issues by status label', () => {
  const r = tracker('glab', ['list', 'board']);
  assert.match(r.out, /== Todo\n {2}#12 Login {2}amal/);
});

test('github: works on bash 3.2 without GH_REPO (the audit crash) and dry run writes nothing', () => {
  const r = tracker('gh', ['status', '7', 'In Testing'], { TRACKER_DRY_RUN: '1' });
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.err, /unbound variable/);
  assert.deepEqual(writes(r.calls), [], 'no label is created during a dry run');
  const live = tracker('gh', ['status', '7', 'In Testing']);
  assert.equal(live.code, 0, live.err);
  assert.ok(writes(live.calls).some((c) => c.startsWith('label create status:In Testing')));
  assert.ok(writes(live.calls).some((c) => c.startsWith('issue edit 7 --remove-label status:Todo --add-label status:In Testing')));
});

test('an unknown tracker fails clearly', () => {
  const r = tracker('glab', ['get', '1'], { FORGE_TRACKER: 'jira' });
  assert.equal(r.code, 2);
  assert.match(r.err, /github, gitlab or openproject/);
});

// The real glab, when installed: every subcommand and flag the adapter uses must exist.
const realGlab = spawnSync('glab', ['--version']).status === 0;
test('gitlab: the installed glab accepts every flag the adapter uses', { skip: !realGlab && 'glab not installed' }, () => {
  const uses = {
    'issue create': ['--title', '--description', '--label', '--linked-issues', '--link-type', '--yes'],
    'issue view': ['--output'], 'issue list': ['--output', '--all', '--label', '--per-page'],
    'issue update': ['--label', '--unlabel'], 'issue note': ['--message'], 'issue close': [], 'issue reopen': [],
    'label list': ['--output', '--per-page'], 'label create': ['--name'], api: [],
    'mr create': ['--draft', '--title', '--description'], 'mr update': ['--ready'], // skills ticket, commit-pr
  };
  for (const [cmd, flags] of Object.entries(uses)) {
    const help = spawnSync('glab', [...cmd.split(' '), '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0, `glab ${cmd} --help`);
    for (const f of flags) assert.match(`${help.stdout}${help.stderr}`, new RegExp(`(^|\\s)${f}(\\s|,|$)`, 'm'), `glab ${cmd} ${f}`);
  }
});

test('help needs no tracker CLI and prints only the usage', () => {
  const r = spawnSync('/bin/bash', [TRACKER, 'help'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', FORGE_TRACKER: 'gitlab' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^forge tracker: read and change tickets/);
  assert.match(r.stdout, /With TRACKER_DRY_RUN=1, a change prints the commands it would run and runs none\.\n$/);
});

// The real gh, when installed: every subcommand and flag the GitHub adapter uses must exist.
const realGh = spawnSync('gh', ['--version']).status === 0;
test('github: the installed gh accepts every flag the adapter uses', { skip: !realGh && 'gh not installed' }, () => {
  const uses = {
    'issue create': ['--title', '--body', '--label', '--repo'], 'issue view': ['--json'],
    'issue list': ['--state', '--label', '--limit', '--json'], 'issue edit': ['--add-label', '--remove-label'],
    'issue comment': ['--body', '--body-file'], 'issue close': [], 'issue reopen': [],
    'label list': ['--limit', '--json'], 'label create': ['--force'],
    'project view': ['--owner', '--format'], 'project field-list': ['--owner', '--format'],
    'project item-add': ['--owner', '--url', '--format'], 'project item-edit': ['--project-id', '--id', '--field-id', '--single-select-option-id'],
    'pr create': ['--draft', '--title', '--body-file'], 'pr ready': [], // skills ticket, commit-pr
  };
  for (const [cmd, flags] of Object.entries(uses)) {
    const help = spawnSync('gh', [...cmd.split(' '), '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0, `gh ${cmd} --help`);
    for (const f of flags) assert.match(`${help.stdout}${help.stderr}`, new RegExp(`(^|\\s)${f}(\\s|,|=|$)`, 'm'), `gh ${cmd} ${f}`);
  }
});

test('gitlab: agents file issues with source and area labels; the ready label and list for the leader', () => {
  let r = tracker('glab', ['create', '--subject', '[Bug] cursor skips rows', '--type', 'Bug', '--source', 'ai', '--area', 'api', '--status', 'In Progress']);
  assert.equal(r.code, 0, r.err);
  assert.ok(writes(r.calls).includes('issue create --title [Bug] cursor skips rows --description  --label type::Bug,status::In Progress,source::ai,area::api --yes'), writes(r.calls).join('\n'));
  assert.ok(writes(r.calls).includes('label create --name status::In Progress'), 'labels with spaces are created whole');
  r = tracker('glab', ['create', '--subject', 'Orders list', '--area', 'api', '--repo', 'orders-api']);
  assert.ok(writes(r.calls).some((c) => c.includes('--label type::Task,status::Todo,area::api,repo::orders-api')), 'a system\'s ticket names its repository (decision 131)');
  r = tracker('glab', ['ready', '12', '--comment', 'breaks AC2 of #9']);
  assert.deepEqual(writes(r.calls), ['label create --name ai::ready', 'issue update 12 --label ai::ready', 'issue note 12 --message breaks AC2 of #9']);
  r = tracker('glab', ['list', 'ready']);
  assert.ok(r.calls.some((c) => c.startsWith('issue list --label ai::ready')), r.calls.join('\n'));
  r = tracker('glab', ['list', 'json']);
  assert.deepEqual(JSON.parse(r.out), [{ id: 12, title: 'Login', labels: ['status::Todo'], state: 'opened', createdAt: '2026-10-07T08:00:00Z', updatedAt: '2026-10-07T09:00:00Z', author: 'amal', url: 'https://gitlab.example.com/g/p/-/issues/12' }]);
});

test('github: the same, with plain labels', () => {
  let r = tracker('gh', ['create', '--subject', '[Follow-up] add index', '--source', 'ai', '--ready']);
  assert.equal(r.code, 0, r.err);
  assert.ok(writes(r.calls).some((c) => c.startsWith('issue create') && c.includes('--label type:Task --label status:Todo --label source:ai --label ai:ready')), writes(r.calls).join('\n'));
  r = tracker('gh', ['ready', '7']);
  assert.ok(writes(r.calls).includes('issue edit 7 --add-label ai:ready'), writes(r.calls).join('\n'));
  r = tracker('gh', ['list', 'json']);
  assert.deepEqual(JSON.parse(r.out)[0], { id: 7, title: 'Login', labels: ['status:Todo'], state: 'OPEN', createdAt: '2026-10-07T08:00:00Z', updatedAt: '2026-10-07T09:00:00Z', author: 'amal', url: 'https://github.com/o/r/issues/7' });
});
