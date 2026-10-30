// The dashboard's stepper (decision 143): where a project is, from the bootstrap's nine stages to the build and the
// release, read from the team repo's files and the client repo's git; and what waits for the owner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sh } from '../policy/helpers.mjs';
import { projectSteps, stepsText, repoFacts, stepTimes } from '../../core/cli/dashboard/steps.mjs';
import { renderSteps } from '../../core/cli/dashboard/steps-view.mjs';
import { readCatalogue, readStories } from '../../core/cli/dashboard/data.mjs';

const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const temp = (name) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), name)));
const G = ['-c', 'user.email=t@e', '-c', 'user.name=t'];

// A team repo folder with the bootstrap's files up to the panel, its applied findings half rerun.
function bootstrap() {
  const folder = temp('forge-steps-');
  const b = (f, text) => write(path.join(folder, 'bootstrap', f), text);
  write(path.join(folder, 'project.json'), JSON.stringify({ project: { name: 'acme' } }));
  b('questionnaire.md', '# Questions\n');
  b('decisions.md', '| D-001 | stack |\n| D-002 | db |\n| D-002 | again |\n');
  b('project.proposed.json', JSON.stringify({ project: { name: 'acme', stack: { backend: 'NestJS 12' } } }));
  b('user-stories.md', '## E1 Accounts\n### E1-S1 Sign up\n### E1-S2 Sign in\n## E2 Bills\n### E2-S1 Add a bill\n');
  b('authorization-matrix.md', '|role|\n');
  write(path.join(folder, 'architecture', 'nfr.md'), '# NFR\n');
  write(path.join(folder, 'architecture', 'overview.md'), '# Overview\n');
  write(path.join(folder, 'architecture', 'adr', '0001-stack.md'), '---\nstatus: proposed\n---\n');
  b('design-map.md', '# Design map\n- Design system page: `0. Design System`\n## E1\n## E2\n');
  b('contract.yaml', 'openapi: 3.1.0\ninfo:\n  title: acme\n  version: 1.0.0\npaths:\n  /a:\n    get:\n      operationId: getA\n    post:\n      operationId: postA\n');
  // Three ways the planners write a draft's heading; one draft has no estimate.
  b('tickets.md', '## E1 Accounts\n### T1 — Sign up (E1-S1)\n- **Estimate:** 3-5 h\n### E1-T2 chore(api): sign in\n- **Estimate:** 2–4 h\n### E2-T1b feat(ui): add a bill\n- **Areas:** ui\n');
  for (const seat of ['be', 'fe', 'se']) b(`panel/${seat}.md`, '# Findings\n');
  b('panel/summary.md', '# Panel summary\nSeats: BE, FE, SE\n\n## Applied\n| Id | Item | Change | Stage rerun | Done |\n|---|---|---|---|---|\n| BE1 | E1-S1 | x | stories | yes |\n| <SE1, FE2> | T1 | y | ticket drafts | — |\n\n## Rejected\n| Id | Why |\n|---|---|\n| QA3 | no |\n');
  return folder;
}
const records = (folder, more = {}) => {
  const c = readCatalogue(folder);
  return { ...readStories(folder), catalogue: c.tickets, plannedTickets: c.planned, estimatedTickets: c.estimated, tickets: [], ...more };
};
const NONE = { totalTickets: 3, ticketsDone: [] };
const states = (s) => s.steps.map((x) => `${x.label}:${x.state}`).join(' ');
const subStates = (x) => x.subs.map((y) => `${y.label}:${y.state}`).join(', ');

test('tickets-created.md: each row\'s cells by what they hold, an empty first column too; the epics\' issue numbers apart', () => {
  const folder = temp('forge-steps-created-');
  write(path.join(folder, 'bootstrap', 'tickets.md'), '### T1 — Sign up (E1-S1)\n- **Areas:** db, api\n- **Estimate:** 3-5 h\n');
  write(path.join(folder, 'bootstrap', 'tickets-created.md'), '|  | Ticket | Title | Issue | Epic | Areas |\n| --- | --- | --- | --- | --- | --- |\n|  | E1 | Sign-up | #1 | — | — |\n|  | E2 | Bills | #4 | — | — |\n|  | T1 | Sign up with email (E1-S1) | #15 | E1 | db, api, ui |\n|  | T2 | Add a bill (E2-S1) | #16 | E2 | ui |\n');
  const c = readCatalogue(folder);
  assert.deepEqual(c.epics, [1, 4]);
  assert.deepEqual(c.tickets.map((t) => [t.num, t.t, t.title, t.epic, t.areas.join(','), t.estimate?.low ?? null]), [[15, 'T1', 'Sign up with email (E1-S1)', 'E1', 'db,api', 3], [16, 'T2', 'Add a bill (E2-S1)', 'E2', 'ui', null]]);
});

test('the drafts are read whatever their heading: T-01, T1 —, E1-T1 and a split-off E2-T1b, with their estimates', () => {
  const folder = bootstrap();
  const c = readCatalogue(folder);
  assert.equal(c.planned, 3);
  assert.equal(c.estimated, 2);
  write(path.join(folder, 'bootstrap', 'tickets-created.md'), '| Item | Title | Issue | Epic | Areas |\n|---|---|---|---|---|\n| E1-T2 | E1-T2 chore(api): sign in | #11 | E1 | api |\n');
  assert.deepEqual(readCatalogue(folder).tickets.map((t) => [t.t, t.num, t.title]), [['E1-T2', 11, 'chore(api): sign in']]);
});

test('during the bootstrap: the furthest step begun is the current one, the steps before it done, the owner\'s settings waiting', () => {
  const folder = bootstrap();
  const s = projectSteps({ folder, main: null, data: records(folder), progress: NONE });
  assert.equal(states(s), 'Discovery:wait Stories:done Architecture:done Screens:done Contract:done Tickets:done Panel:now Your review:todo Setup:todo Build:todo Release:todo');
  // The README is not read: nothing in it moves the stepper.
  assert.equal(subStates(s.steps[0]), 'Questions:done, Register:done, Your settings:wait');
  assert.equal(s.steps[0].summary, '2 decisions');
  assert.equal(s.steps[1].summary, '3 stories in 2 epics');
  assert.equal(s.steps[4].summary, '2 operations, version 1.0.0');
  // The contract's check leaves no record: it counts as done once the next step began.
  assert.equal(subStates(s.steps[4]), 'Draft:done, API check:done');
  assert.equal(subStates(s.steps[5]), 'Drafts 3:done, Estimates 2 of 3:done');
  assert.equal(subStates(s.steps[6]), 'Seats 3:done, Summary:done, Reruns 1 of 2:now');
  assert.deepEqual(s.waiting, [{ step: 'Discovery', why: 'apply bootstrap/project.proposed.json: project.json has no stack yet (skill discovery, step 6)' }]);
  assert.deepEqual(stepsText(s), [
    'Step: 7 of 11, Panel (3 seats, 1 of 2 applied): Seats 3 done, Summary done, Reruns 1 of 2 now.',
    'Waiting for you: Discovery: apply bootstrap/project.proposed.json: project.json has no stack yet (skill discovery, step 6).',
  ]);

  // Settings applied (project.json names a stack), every finding rerun: the review is next, and it waits for you once
  // the lead wrote it.
  write(path.join(folder, 'project.json'), JSON.stringify({ project: { name: 'acme', stack: { backend: 'NestJS 12' } } }));
  write(path.join(folder, 'bootstrap', 'panel', 'summary.md'), '## Applied\n| Id | Item | Change | Stage rerun | Done |\n|---|---|---|---|---|\n| BE1 | x | y | z | yes |\n');
  let t = projectSteps({ folder, main: null, data: records(folder), progress: NONE });
  assert.equal(states(t), 'Discovery:done Stories:done Architecture:done Screens:done Contract:done Tickets:done Panel:done Your review:now Setup:todo Build:todo Release:todo');
  assert.deepEqual(t.waiting, []);
  write(path.join(folder, 'bootstrap', 'review.md'), '# Review\n');
  t = projectSteps({ folder, main: null, data: records(folder), progress: NONE });
  assert.equal(subStates(t.steps[7]), 'Written:done, Your approval:wait');
  assert.equal(t.steps[7].state, 'wait');
});

test('a step with nothing to show before the current one was skipped, and an owner\'s step with nothing to act on too', () => {
  const folder = bootstrap();
  fs.rmSync(path.join(folder, 'bootstrap', 'contract.yaml'));
  fs.rmSync(path.join(folder, 'bootstrap', 'project.proposed.json'));
  const s = projectSteps({ folder, main: null, data: records(folder), progress: NONE });
  assert.equal(s.steps[4].state, 'skip', 'no contract (--skip-contract)');
  assert.equal(subStates(s.steps[0]), 'Questions:done, Register:done, Your settings:skip');
  assert.deepEqual(s.waiting, []);
  // Without the bootstrap's folder (an onboarded repository) the stepper has the build and the release only.
  const bare = temp('forge-steps-bare-');
  assert.equal(states(projectSteps({ folder: bare, main: null, data: records(bare), progress: NONE })), 'Build:now Release:todo');
});

// A client repository with the after-approval branches; some merged the way GitLab and GitHub word it.
function client() {
  const dir = temp('forge-steps-repo-');
  sh(dir, 'git', 'init', '-q', '-b', 'main');
  sh(dir, 'git', ...G, 'commit', '-q', '--allow-empty', '-m', 'init');
  sh(dir, 'git', 'branch', 'dev');
  const branch = (name, into, subject) => {
    sh(dir, 'git', 'checkout', '-q', '-b', name, into);
    sh(dir, 'git', ...G, 'commit', '-q', '--allow-empty', '-m', `work on ${name}`);
    sh(dir, 'git', 'checkout', '-q', into);
    if (subject) sh(dir, 'git', ...G, 'merge', '-q', '--no-ff', '-m', subject, name);
  };
  return { dir, branch };
}

test('after approval: the lead\'s merges and the contract tag from git (decision 148), the tickets from the board', () => {
  const folder = bootstrap();
  write(path.join(folder, 'project.json'), JSON.stringify({ project: { name: 'acme', stack: { backend: 'NestJS 12' } } }));
  write(path.join(folder, 'bootstrap', 'review.md'), '# Review\n');
  write(path.join(folder, 'bootstrap', 'project.starter.json'), '{}');
  const { dir, branch } = client();
  branch('chore/architecture', 'main', "Merge branch 'chore/architecture' into 'main'");
  branch('chore/bootstrap-contract', 'main', 'Merge pull request #2 from acme/chore/bootstrap-contract');
  branch('chore/starter', 'main', null);
  const facts = repoFacts(dir);
  assert.deepEqual(facts.merges.map((m) => [m.from, m.into]).sort(), [['chore/architecture', 'main'], ['chore/bootstrap-contract', null]]);

  let s = projectSteps({ folder, main: dir, data: records(folder), progress: NONE });
  assert.equal(s.steps[7].state, 'done', 'the work after the review began: it was approved');
  assert.equal(s.steps[8].state, 'now', 'the lead merges and tags: nothing waits for the owner');
  assert.equal(subStates(s.steps[8]), 'Merges 2 of 3:now, Contract tag:todo, Tickets created:todo');
  assert.deepEqual(s.waiting, []);

  sh(dir, 'git', ...G, 'merge', '-q', '--no-ff', '-m', "Merge branch 'chore/starter' into 'main'", 'chore/starter');
  sh(dir, 'git', 'tag', 'api-v1.0.0');
  s = projectSteps({ folder, main: dir, data: records(folder), board: [{ num: 10, closed: false }, { num: 11, closed: false }], progress: NONE });
  assert.equal(subStates(s.steps[8]), 'Merges 3 of 3:done, Contract tag api-v1.0.0:done, Tickets created 2:done');
  assert.equal(s.steps[8].summary, '3 of 3 merged, api-v1.0.0, 2 tickets');
  assert.equal(s.current, 9, 'the build is next');
});

test('the build: each ticket in flight with where it is, by its agents\' roles as their spawns named them', () => {
  const folder = bootstrap();
  write(path.join(folder, 'project.json'), JSON.stringify({ project: { name: 'acme', stack: { backend: 'NestJS 12' } } }));
  const at = (min) => new Date(Date.parse('2026-10-28T10:00:00Z') + min * 60000).toISOString();
  const lines = [
    // A bootstrap agent the timeline put on #1 from its spawn's words ("ops 1-11"): no ticket's work.
    { at: at(0), event: 'agent.start', who: 'contract-analyst', agent: 'c1', ticket: '#1' },
    // #6: a lead that names its agents freely; the spawn line says the role.
    { at: at(1), event: 'tool.done', who: 'lead', tool: 'Agent', what: 'planner: Plan #6', spawned: 'p6', ticket: '#6' },
    { at: at(2), event: 'agent.start', who: 'plan-6', agent: 'p6', ticket: '#6' },
    { at: at(3), event: 'tool.done', who: 'lead', tool: 'Agent', what: 'devops-engineer: #6 lane', spawned: 'd6', ticket: '#6' },
    { at: at(4), event: 'agent.start', who: 'devops-lane', agent: 'd6', ticket: '#6' },
    { at: at(5), event: 'tool.done', who: 'lead', tool: 'Agent', what: 'db-reviewer: DB review #6', spawned: 'r6', ticket: '#6' },
    { at: at(6), event: 'agent.start', who: 'db-review-6', agent: 'r6', ticket: '#6' },
    // #7: planned, nobody building yet; it waits for the owner's answer.
    { at: at(7), event: 'agent.start', who: 'planner', agent: 'p7', ticket: '#7' },
    // #8: merged.
    { at: at(8), event: 'agent.start', who: 'backend-engineer', agent: 'b8', ticket: '#8' },
  ];
  const data = records(folder, { tickets: [
    { num: 6, t: 'E1-T2', title: 'Compose base', planned: true, status: null, mergedAt: null },
    { num: 7, t: 'T1', title: 'Sign up', planned: true, status: 'Waiting for the owner: Q1 (asked 28 Oct)', mergedAt: null },
    { num: 8, t: 'E2-T1b', title: 'Add a bill', planned: true, status: null, mergedAt: Date.parse(at(9)) },
  ] });
  const board = [{ num: 6, closed: false }, { num: 7, closed: false }, { num: 8, closed: true }];
  const s = projectSteps({ folder, main: null, data, lines, board, progress: { totalTickets: 3, ticketsDone: [Date.parse(at(9))] } });
  const build = s.steps[s.current];
  assert.equal(build.label, 'Build');
  assert.equal(build.summary, '1 of 3 merged, 2 in flight');
  assert.deepEqual(build.rows.map((r) => [r.num, subStates(r)]), [
    [7, 'Plan:done, Build:wait, Review:todo, Merge:todo'],
    [6, 'Plan:done, Build:done, Review:now, Merge:todo'],
  ]);
  assert.equal(build.state, 'wait');
  assert.deepEqual(s.waiting, [{ step: 'Build', why: '#7: Waiting for the owner: Q1 (asked 28 Oct)' }]);
  assert.equal(stepsText(s)[0], 'Step: 10 of 11, Build (1 of 3 merged, 2 in flight); in flight: #7 Build, #6 Review.');

  const html = renderSteps(s);
  assert.match(html, /<li class="st-wait" aria-current="step" title="10\. Build: waiting for you · 1 of 3 merged, 2 in flight"><i>!<\/i><span>Build<\/span><\/li>/);
  assert.match(html, /<span class="ss-t" title="#6 Compose base">#6 Compose base<\/span><ol class="ss"><li class="st-done" title="done"><i>✓<\/i>Plan<\/li>/);
  assert.match(html, /<p class="st-why"><b>Waiting for you:<\/b> Build: #7: Waiting for the owner: Q1 \(asked 28 Oct\)<\/p>/);
});

test('the release: merged into dev, promoted branch by branch, tagged; then every step is done', () => {
  const folder = temp('forge-steps-rel-');
  const { dir, branch } = client();
  sh(dir, 'git', 'checkout', '-q', 'dev');
  branch('chore/release-v1.0.0', 'dev', "Merge branch 'chore/release-v1.0.0' into 'dev'");
  branch('chore/release-v1.2.0', 'dev', "Merge branch 'chore/release-v1.2.0' into 'dev'");
  sh(dir, 'git', 'branch', 'staging', 'dev');
  const done = { totalTickets: 2, ticketsDone: [1, 2] };
  let s = projectSteps({ folder, main: dir, data: records(folder), board: [{ num: 1, closed: true }, { num: 2, closed: true }], progress: done });
  assert.equal(states(s), 'Build:done Release:wait');
  assert.equal(subStates(s.steps[1]), 'Release MR:done, Promotions 1 of 2:wait, Tag v1.2.0:todo');
  assert.deepEqual(s.waiting, [{ step: 'Release', why: 'merge staging into main' }]);

  sh(dir, 'git', 'checkout', '-q', 'main');
  sh(dir, 'git', ...G, 'merge', '-q', '--no-ff', '-m', "Merge branch 'staging' into 'main'", 'staging');
  sh(dir, 'git', 'tag', 'v1.2.0');
  s = projectSteps({ folder, main: dir, data: records(folder), board: [{ num: 1, closed: true }, { num: 2, closed: true }], progress: done });
  assert.equal(s.current, null);
  assert.equal(states(s), 'Build:done Release:done');
  assert.deepEqual(stepsText(s), ['Step: all 2 done (v1.2.0).']);
  assert.match(renderSteps(s), /<p class="ss-h"><b>All 2 steps done<\/b> · v1\.2\.0<\/p>/);
});

test('time per step: from each step\'s first file to the next step\'s start in time, split into the AI, waiting for you and nobody working', () => {
  const T0 = Date.parse('2026-10-25T20:00:00Z');
  const at = (min) => new Date(T0 + min * 60000).toISOString();
  const write = (min, file) => ({ at: at(min), event: 'tool.start', who: 'lead', tool: 'Write', what: `.forge/project/${file}` });
  const lines = [
    { at: at(0), event: 'prompt', who: 'human' },
    write(1, 'bootstrap/questionnaire.md'),
    { at: at(5), event: 'turn.end', who: 'lead' },
    { at: at(15), event: 'prompt', who: 'human' },
    write(16, 'bootstrap/user-stories.md'),
    { at: at(17), event: 'agent.start', who: 'product-analyst', agent: 'a1' },
    { at: at(27), event: 'agent.stop', who: 'product-analyst', agent: 'a1' },
    // The contract before the screens, as a lead may do it.
    write(30, 'bootstrap/contract.yaml'),
    write(40, 'bootstrap/design-map.md'),
    write(50, 'bootstrap/tickets.md'),
    { at: at(60), event: 'turn.end', who: 'lead' },
  ];
  const keys = [['discovery', 'Discovery', 'done'], ['stories', 'Stories', 'done'], ['architecture', 'Architecture', 'skip'], ['screens', 'Screens', 'done'], ['contract', 'Contract', 'done'], ['tickets', 'Tickets', 'now'], ['panel', 'Panel', 'todo']];
  const steps = { steps: keys.map(([key, label, state]) => ({ key, label, state })), current: 5 };
  const rows = stepTimes({ steps, folder: temp('forge-steps-time-'), main: null, lines, now: T0 + 70 * 60000 });
  const M = 60000;
  assert.deepEqual(rows.map((r) => [r.label, (r.from - T0) / M, (r.to - T0) / M, r.open]), [
    ['Discovery', 0, 16, false], ['Stories', 16, 30, false], ['Screens', 40, 50, false], ['Contract', 30, 40, false], ['Tickets', 50, 70, true],
  ], 'in the stepper\'s order, each from its first file to the next start in time; the first from the first line');
  assert.equal(rows[0].owner, 10 * M, 'the discovery waited 10 minutes for the owner\'s reply');
  assert.ok(rows[1].ai >= 10 * M, 'the stories\' analyst worked 10 minutes');
  for (const r of rows) assert.equal(r.ai + r.owner + r.idle, r.total, `${r.label}: each moment once`);
  assert.deepEqual(stepTimes({ steps, folder: null, main: null, lines: [], now: T0 }), [], 'no timeline, no times');
});

