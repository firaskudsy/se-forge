// The tracker's issues over time (decision 122): each issue's band from its history, the counts over time, and
// the read that fetches only what changed, against fake glab and gh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readIssues, issueFlow, issueBands, countsText, band, issueLinks } from '../../core/cli/dashboard/issues.mjs';
import { flow } from '../../core/cli/dashboard/svg.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/issues-glab.js');
const T0 = Date.parse('2026-10-11T08:00:00Z');
const at = (min) => new Date(T0 + min * 60000).toISOString();
const add = (min, label) => ({ created_at: at(min), action: 'add', label: { name: label } });
const remove = (min, label) => ({ created_at: at(min), action: 'remove', label: { name: label } });

// #1 an epic; #2 Todo → In Progress → In Testing → Done and closed; #3 In Progress, open; #4 labelled before
// events were kept (no label events), closed and reopened.
export const GITLAB = {
  issues: [
    { iid: 1, title: '[Epic] E1 Polls', state: 'opened', labels: ['type::Epic', 'status::Todo'], created_at: at(0), updated_at: at(0) },
    { iid: 2, title: 'Poll model', state: 'closed', labels: ['status::Done', 'type::Task'], created_at: at(10), updated_at: at(301) },
    { iid: 3, title: 'Vote', state: 'opened', labels: ['status::In Progress'], created_at: at(20), updated_at: at(90) },
    { iid: 4, title: 'Old one', state: 'opened', labels: ['status::Todo'], created_at: at(30), updated_at: at(250) },
  ],
  labels: {
    1: [add(0, 'type::Epic'), add(0, 'status::Todo')],
    2: [add(10, 'status::Todo'), add(10, 'type::Task'), add(60, 'status::In Progress'), remove(60, 'status::Todo'), add(120, 'status::In Testing'), remove(120, 'status::In Progress'), add(300, 'status::Done'), remove(300, 'status::In Testing')],
    3: [add(20, 'status::Todo'), remove(90, 'status::Todo'), add(90, 'status::In Progress')],
  },
  states: { 2: [{ created_at: at(301), state: 'closed' }], 4: [{ created_at: at(200), state: 'closed' }, { created_at: at(250), state: 'reopened' }] },
};

function host(tool, data, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-issues-'));
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.copyFileSync(FAKE, path.join(dir, 'bin', tool));
  fs.chmodSync(path.join(dir, 'bin', tool), 0o755);
  fs.writeFileSync(path.join(dir, 'issues.json'), JSON.stringify(data));
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(log, '');
  return {
    dir, state: path.join(dir, 'state'),
    env: { ...process.env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, FAKE_ISSUES: path.join(dir, 'issues.json'), FAKE_LOG: log, ...env },
    calls: () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean),
    reset: () => fs.writeFileSync(log, ''),
    data: (d) => fs.writeFileSync(path.join(dir, 'issues.json'), JSON.stringify(d)),
  };
}

test('the band: a done status counts as closed; In Progress and In Testing have their own', () => {
  assert.equal(band(true, 'In Progress'), 'closed');
  assert.equal(band(false, 'Done'), 'closed');
  assert.equal(band(false, 'in testing'), 'testing');
  assert.equal(band(false, 'In Progress'), 'progress');
  for (const s of ['Todo', 'Blocked', null]) assert.equal(band(false, s), 'open');
});

test('each issue from its creation: the same moment is one change, labels before the events count from the start', async () => {
  const h = host('glab', GITLAB);
  const r = await readIssues({ main: h.dir, stateDir: h.state, tracker: 'gitlab', env: h.env });
  assert.equal(r.error, null);
  const byId = Object.fromEntries(r.issues.map((i) => [i.id, i]));
  assert.deepEqual(issueBands(byId[2]).map((b) => [b.band, (Date.parse(b.at) || b.at) - T0]), [['open', 600000], ['progress', 3600000], ['testing', 7200000], ['closed', 18000000]]);
  assert.deepEqual(issueBands(byId[4]).map((b) => b.band), ['open', 'closed', 'open'], 'closed, then reopened');
  const f = issueFlow(r.issues);
  assert.equal(f.epics, 1, 'the epic is left out');
  assert.equal(f.total, 3);
  assert.deepEqual(f.now, { closed: 1, testing: 0, progress: 1, open: 1 });
  const atMin = (min) => f.points.filter((p) => p.at <= T0 + min * 60000).at(-1).n;
  assert.deepEqual(atMin(130), { closed: 0, testing: 1, progress: 1, open: 1 });
  assert.deepEqual(atMin(210), { closed: 1, testing: 1, progress: 1, open: 0 });
  assert.equal(countsText(f.now), '1 open, 1 in progress, 0 in testing, 1 closed');
});

test('a second read fetches only the issues that changed; a failed read keeps the last one', async () => {
  const h = host('glab', GITLAB);
  await readIssues({ main: h.dir, stateDir: h.state, tracker: 'gitlab', env: h.env });
  assert.equal(h.calls().length, 1 + 4 * 2, 'the list, then label and state events per issue');
  h.reset();
  await readIssues({ main: h.dir, stateDir: h.state, tracker: 'gitlab', env: h.env });
  assert.deepEqual(h.calls().map((c) => c.split('?')[0]), ['api projects/:id/issues'], 'nothing changed: only the list');
  h.reset();
  const moved = structuredClone(GITLAB);
  moved.issues[2] = { ...moved.issues[2], state: 'closed', labels: ['status::Done'], updated_at: at(400) };
  moved.labels[3].push(add(399, 'status::Done'), remove(399, 'status::In Progress'));
  moved.states[3] = [{ created_at: at(400), state: 'closed' }];
  h.data(moved);
  let r = await readIssues({ main: h.dir, stateDir: h.state, tracker: 'gitlab', env: h.env });
  assert.deepEqual(h.calls().map((c) => c.split('?')[0]), ['api projects/:id/issues', 'api projects/:id/issues/3/resource_label_events', 'api projects/:id/issues/3/resource_state_events']);
  assert.deepEqual(issueFlow(r.issues).now, { closed: 2, testing: 0, progress: 0, open: 1 });
  r = await readIssues({ main: h.dir, stateDir: h.state, tracker: 'gitlab', env: { ...h.env, FAKE_FAIL: '1' } });
  assert.match(r.error, /401 Unauthorized/);
  assert.equal(r.issues.length, 4, 'the last read stands');
  h.reset();
  r = await readIssues({ main: h.dir, stateDir: h.state, tracker: 'gitlab', env: h.env, offline: true });
  assert.equal(h.calls().length, 0, 'offline reads nothing');
  assert.equal(r.issues.length, 4);
  assert.match((await readIssues({ main: h.dir, stateDir: h.state, tracker: 'jira', env: h.env })).error, /no issue history/);
});

test('GitHub: issue events, pull requests left out', async () => {
  const h = host('gh', {
    issues: [
      { number: 7, title: 'Login', state: 'closed', labels: [{ name: 'status:Done' }], created_at: at(0), updated_at: at(90) },
      { number: 8, title: 'A pull request', state: 'open', labels: [], created_at: at(5), updated_at: at(5), pull_request: {} },
    ],
    events: { 7: [{ event: 'labeled', label: { name: 'status:In Progress' }, created_at: at(30) }, { event: 'unlabeled', label: { name: 'status:In Progress' }, created_at: at(80) }, { event: 'labeled', label: { name: 'status:Done' }, created_at: at(80) }, { event: 'closed', created_at: at(90) }, { event: 'assigned', created_at: at(31) }] },
  });
  const r = await readIssues({ main: h.dir, stateDir: h.state, tracker: 'github', env: h.env });
  assert.equal(r.error, null);
  assert.equal(r.host, 'GitHub');
  assert.deepEqual(r.issues.map((i) => i.id), [7]);
  assert.deepEqual(issueBands(r.issues[0]).map((b) => b.band), ['open', 'progress', 'closed']);
  assert.ok(h.calls().every((c) => c.startsWith('api repos/{owner}/{repo}/')), h.calls().join('\n'));
});

test('the flow chart: a band per status, a gap between them, a hover title per stretch, counts at the right', async () => {
  const f = issueFlow((await readIssues({ main: '.', stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'forge-issues-')), tracker: 'gitlab', env: host('glab', GITLAB).env })).issues);
  const keys = [['closed', 'Closed'], ['testing', 'In Testing'], ['progress', 'In progress'], ['open', 'Open']].map(([key, label]) => ({ key, label, cls: `i-${key}` }));
  const svg = flow({ points: f.points, keys, from: T0, to: T0 + 600 * 60000 });
  assert.equal((svg.match(/<path class="band /g) || []).length, 4);
  assert.match(svg, /<text class="label"[^>]*>Open 1<\/text>/);
  assert.match(svg, /<text class="label"[^>]*>Closed 1<\/text>/);
  assert.doesNotMatch(svg, />In Testing 0</, 'an empty band gets no label');
  assert.match(svg, /<rect class="hit"[^>]*><title>From [^:]+:\d\d [AP]M: Open: 1 · In progress: 1 · In Testing: 1 · Closed: 0<\/title>/);
  assert.match(svg, />now<\/text>/);
  assert.doesNotMatch(svg, /NaN|undefined/);
});

test('a ticket\'s link: the address the tracker gave, else one made from the remote', () => {
  const gl = issueLinks({ remote: 'git@gitlab.example.com:ai/lunch-pool.git' });
  assert.equal(gl(12), 'https://gitlab.example.com/ai/lunch-pool/-/issues/12');
  assert.equal(issueLinks({ remote: 'ssh://git@git.example.com:2222/g/sub/app.git' })(3), 'https://git.example.com/g/sub/app/-/issues/3');
  assert.equal(issueLinks({ remote: 'https://github.com/o/r.git', tracker: 'github' })(7), 'https://github.com/o/r/issues/7');
  assert.equal(issueLinks({ issues: [{ id: 12, url: 'https://gitlab.example.com/ai/lunch-pool/-/issues/12#moved' }], remote: 'git@h:g/a.git' })(12), 'https://gitlab.example.com/ai/lunch-pool/-/issues/12#moved');
  assert.equal(issueLinks({ remote: '/tmp/client.git' })(1), null, 'a local remote: no link');
  assert.equal(issueLinks({})(1), null);
});

// A fake OpenProject: statuses, one board whose column query holds #10 and #11, their activities; the key checked.
function openproject() {
  const wp = (id, subject, status, raw = '') => ({ id, subject, createdAt: at(0), updatedAt: at(200), description: { raw }, _links: { status: { title: status }, type: { title: 'Task' } } });
  const routes = {
    '/api/v3/statuses': { _embedded: { elements: [{ name: 'Todo', isClosed: false }, { name: 'In Development', isClosed: false }, { name: 'Ready for QA', isClosed: false }, { name: 'Done', isClosed: true }] } },
    '/api/v3/grids/81': { widgets: [{ options: { queryId: 5 } }, { options: {} }] },
    '/api/v3/queries/5': { _embedded: { results: { _embedded: { elements: [wp(10, 'Drop tracks', 'Done', 'Some text\n\nLabels: source::ai area::ui'), wp(11, 'Filters', 'In Development')] } } } },
    '/api/v3/work_packages/10/activities': { _embedded: { elements: [
      { createdAt: at(0), details: [{ raw: 'Status set to Todo' }] },
      { createdAt: at(60), details: [{ raw: 'Status changed from **Todo** to **In Development**' }, { raw: 'Assignee set to X' }] },
      { createdAt: at(120), details: [{ raw: 'Status changed from In Development to Ready for QA' }] },
      { createdAt: at(200), details: [{ raw: 'Status changed from Ready for QA to Done' }] },
    ] } },
    '/api/v3/work_packages/11/activities': { _embedded: { elements: [{ createdAt: at(0), details: [{ raw: 'Status set to Todo' }] }, { createdAt: at(30), details: [{ raw: 'Status changed from Todo to In Development' }] }] } },
  };
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url.split('?')[0]);
    const body = routes[req.url.split('?')[0]];
    const ok = req.headers.authorization === `Basic ${Buffer.from('apikey:k1').toString('base64')}`;
    res.writeHead(!ok ? 401 : body ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok && body ? body : {}));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` })));
}

test('OpenProject: the board\'s work packages, their status changes as events, the key only in the header', async () => {
  const op = await openproject();
  try {
    const env = { OPENPROJECT_URL: op.url, OPENPROJECT_API_KEY: 'k1', OPENPROJECT_DASHBOARD_BOARDS: '81' };
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-issues-'));
    const r = await readIssues({ main: '.', stateDir, tracker: 'openproject', env });
    assert.equal(r.error, null);
    assert.equal(r.host, 'OpenProject');
    const byId = Object.fromEntries(r.issues.map((i) => [i.id, i]));
    assert.deepEqual(byId[10].labels, ['status::Done', 'type::Task', 'source::ai', 'area::ui']);
    assert.equal(byId[10].url, `${op.url}/work_packages/10`);
    assert.deepEqual(issueBands(byId[10]).map((b) => b.band), ['open', 'progress', 'testing', 'closed']);
    assert.deepEqual(issueBands(byId[11]).map((b) => b.band), ['open', 'progress']);
    assert.deepEqual(issueFlow(r.issues).now, { closed: 1, testing: 0, progress: 1, open: 0 });
    assert.doesNotMatch(fs.readFileSync(path.join(stateDir, 'issues.json'), 'utf8'), /k1/);
    op.calls.length = 0;
    await readIssues({ main: '.', stateDir, tracker: 'openproject', env });
    assert.deepEqual(op.calls, ['/api/v3/grids/81', '/api/v3/queries/5'], 'nothing changed: only the board');
    const bad = await readIssues({ main: '.', stateDir, tracker: 'openproject', env: { ...env, OPENPROJECT_API_KEY: 'wrong' } });
    assert.match(bad.error, /HTTP 401/);
    assert.doesNotMatch(bad.error, /wrong/);
    assert.equal(bad.issues.length, 2, 'the last read stands');
  } finally {
    op.server.close();
  }
});

test('the band: OpenProject\'s development and QA statuses', () => {
  for (const s of ['In Development', 'Code review']) assert.equal(band(false, s), 'progress');
  for (const s of ['Ready for QA', 'In QA', 'Ready for Release']) assert.equal(band(false, s), 'testing');
});
