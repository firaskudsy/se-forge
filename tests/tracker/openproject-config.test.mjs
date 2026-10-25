// project.openproject in project.json: what is accepted, what is refused, and the OPENPROJECT_* environment
// forge tracker runs the adapter with (a variable already set wins).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, openprojectEnv, trackerEnv } from '../../core/policy/lib/config.mjs';

function load(project) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-opcfg-'));
  const file = path.join(dir, 'project.json');
  fs.writeFileSync(file, JSON.stringify({ project }));
  return loadConfig(dir, { FORGE_CONFIG: file });
}

test('project.openproject: a full block is accepted, board ids kept as strings', () => {
  const { project, errors } = load({ tracker: 'openproject', openproject: {
    url: 'https://op.example.com', project: 'ird', boards: { issues: 109, frontend: '110' }, defaultBoard: 'frontend', readyStatus: 'Ready for Development',
  } });
  assert.deepEqual(errors, []);
  assert.deepEqual(project.openproject, { url: 'https://op.example.com', project: 'ird', board: '', boards: { issues: '109', frontend: '110' }, defaultBoard: 'frontend', readyStatus: 'Ready for Development' });
});

test('project.openproject: the defaults, and board as the shorthand for one board', () => {
  assert.deepEqual(load({}).project.openproject, { url: '', project: '', board: '', boards: {}, defaultBoard: '', readyStatus: '' });
  const { project, errors } = load({ tracker: 'openproject', openproject: { url: 'https://op.example.com', project: 'ird', board: 109 } });
  assert.deepEqual(errors, []);
  assert.equal(project.openproject.board, '109');
});

test('project.openproject: bad values are refused, each with its own message', () => {
  const errs = (o) => load({ tracker: 'openproject', openproject: o }).errors;
  assert.deepEqual(errs({ token: 'x' }), ['unknown key project.openproject.token']);
  assert.match(errs({ board: 'issues' })[0], /project\.openproject\.board must be a board id/);
  assert.match(errs({ board: 0 })[0], /project\.openproject\.board must be a board id/);
  assert.match(errs({ boards: { all: 1 } })[0], /project\.openproject\.boards must map a name .* not "all"/);
  assert.match(errs({ boards: { issues: 'abc' } })[0], /project\.openproject\.boards must map a name/);
  assert.match(errs({ boards: [109] })[0], /project\.openproject\.boards must map a name/);
  assert.match(errs({ boards: { '1st': 1 } })[0], /project\.openproject\.boards must map a name/);
  assert.match(errs({ boards: { issues: 109 }, defaultBoard: 'frontend' })[0], /defaultBoard "frontend" is not a name in project\.openproject\.boards/);
  assert.match(errs({ defaultBoard: true })[0], /defaultBoard must be a board name/);
  assert.match(errs({ url: 5 })[0], /project\.openproject\.url must be a string/);
  assert.deepEqual(load({ openproject: 'x' }).errors, ['project.openproject must be an object']);
  assert.deepEqual(load({ tracker: 'jira' }).errors, ['project.tracker must be gitlab, github, openproject']);
});

test('openprojectEnv: settings become OPENPROJECT_* variables; defaultBoard by name or id; env wins', () => {
  const o = { url: 'https://op.example.com', project: 'ird', board: '', boards: { issues: '109', frontend: '110' }, defaultBoard: 'frontend', readyStatus: 'Todo' };
  assert.deepEqual(openprojectEnv({ openproject: o }, {}), {
    OPENPROJECT_URL: 'https://op.example.com', OPENPROJECT_PROJECT: 'ird', OPENPROJECT_BOARDS: 'issues=109,frontend=110', OPENPROJECT_BOARD: '110', OPENPROJECT_READY_STATUS: 'Todo',
  });
  assert.equal(openprojectEnv({ openproject: { ...o, defaultBoard: '200' } }, {}).OPENPROJECT_BOARD, '200', 'an id as is');
  assert.equal(openprojectEnv({ openproject: { ...o, boards: {}, defaultBoard: '', board: '109' } }, {}).OPENPROJECT_BOARD, '109', 'the shorthand');
  assert.equal(openprojectEnv({ openproject: { ...o, defaultBoard: '' } }, {}).OPENPROJECT_BOARD, undefined, 'no default: the adapter takes the first board');
  const set = openprojectEnv({ openproject: o }, { OPENPROJECT_URL: 'https://other.example.com', OPENPROJECT_BOARD: '7' });
  assert.equal(set.OPENPROJECT_URL, undefined, 'a variable already set is left alone');
  assert.equal(set.OPENPROJECT_BOARD, undefined);
  assert.equal(set.OPENPROJECT_PROJECT, 'ird');
  assert.deepEqual(openprojectEnv({}, {}), {}, 'nothing configured, nothing set');
});

test('trackerEnv: OpenProject settings only for the openproject tracker; FORGE_TRACKER overrides', () => {
  const project = { tracker: 'openproject', board: '', openproject: { url: 'https://op.example.com', project: 'ird', board: '', boards: {}, defaultBoard: '', readyStatus: '' } };
  assert.deepEqual(trackerEnv(project, {}), { FORGE_TRACKER: 'openproject', OPENPROJECT_URL: 'https://op.example.com', OPENPROJECT_PROJECT: 'ird' });
  assert.deepEqual(trackerEnv(project, { FORGE_TRACKER: 'gitlab' }), { FORGE_TRACKER: 'gitlab' });
  assert.deepEqual(trackerEnv({ ...project, tracker: 'github', board: 'acme/board' }, {}), { FORGE_TRACKER: 'github', GH_REPO: 'acme/board' });
});
