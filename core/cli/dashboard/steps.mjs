// The stepper above the tabs (decision 143): where the project is, from the bootstrap's nine stages (skill bootstrap)
// to the build and the release, each with two to four sub-steps; the page shows the current step's. Read from the team
// repo's files and the client repo's git, not from the bootstrap's README, which the lead may not have brought up to
// date. The furthest step that has begun is where the project is: before it, a sub-step with nothing to show counts
// as done (the work moved on), except the owner's own, which keep their step waiting for you while there is something
// to act on (a proposal to apply, a branch to merge, a tag to push).
import fs from 'node:fs';
import path from 'node:path';
import { git } from '../../policy/lib/context.mjs';
import { stageOf, spawnTypes, timeSplit } from './measures.mjs';
import { summarize } from '../timeline.mjs';

const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const has = (file) => fs.existsSync(file);
const json = (file) => { try { return JSON.parse(read(file)); } catch { return null; } };
const list = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : s);
const semver = (v) => v.split('.').map(Number);
const newer = (a, b) => { const x = semver(a); const y = semver(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };

// What the client repo's git says: branch names (local and origin's, and origin's apart), tags, and merge commits by the branch merged
// (GitLab's "Merge branch 'x' into 'dev'", git's own "Merge branch 'x' into dev", GitHub's "Merge pull request #3 from
// owner/x"). A squash merge leaves no merge commit, so it is not seen.
export function repoFacts(dir) {
  if (!dir) return { refs: new Set(), pushed: null, tags: [], merges: [], contains: () => false };
  const names = (git(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes/origin']).out || '').split('\n').filter(Boolean);
  const refs = new Set(names.map((r) => r.replace(/^origin\//, '')));
  // What origin has: null for a repository without one.
  const pushed = git(dir, ['remote', 'get-url', 'origin']).ok ? new Set(names.filter((r) => r.startsWith('origin/')).map((r) => r.slice(7))) : null;
  const tags = (git(dir, ['tag', '-l']).out || '').split('\n').filter(Boolean);
  const merges = [];
  for (const row of (git(dir, ['log', '--all', '--merges', '--format=%H%x09%s']).out || '').split('\n')) {
    const [hash, subject = ''] = row.split('\t');
    const m = /^Merge branch '([^']+)'(?: into '?([^'\s]+)'?)?/.exec(subject) ?? /^Merge pull request #\d+ from [^/\s]+\/(\S+)/.exec(subject);
    if (m) merges.push({ hash, from: m[1], into: m[2] ?? null });
  }
  // Whether a commit is on a branch, origin's copy first.
  const contains = (hash, branch) => {
    const ref = git(dir, ['rev-parse', '--verify', '-q', `origin/${branch}`]).ok ? `origin/${branch}` : branch;
    return git(dir, ['merge-base', '--is-ancestor', hash, ref]).ok;
  };
  return { refs, pushed, tags, merges, contains };
}

// A sub-step: done, or open; the owner's (mine) are waiting for you while due (there is something to act on).
// skip: not part of this project (no contract, so no contract tag).
const sub = (label, done, more = {}) => ({ label, done: Boolean(done), mine: false, due: false, skip: false, why: '', ...more });

// The tickets in flight: a ticket on the board (or, with no board, in the records) that a planner, an engineer, a
// reviewer or QA worked on, not merged and not closed, the latest first; each with where it is: the last such agent's
// stage (a review that sent it back makes it Build again), and why it waits for you. The bootstrap's agents are no
// ticket's work, even when the timeline guessed a ticket from their spawn's words ("E5 ops 1-11" is not #1), and nor
// is a project manager's triage spawned under an epic.
const PIPE = ['Plan', 'Build', 'Review', 'Merge'];
const AT = { build: 1, review: 2, qa: 2 };
function inFlight({ lines, data, board, all }) {
  const roleOf = spawnTypes(lines);
  const known = board ? new Set(board.map((b) => b.num)) : new Set(data.tickets.filter((t) => t.planned || t.t).map((t) => t.num));
  const last = new Map();
  for (const e of lines) {
    const num = Number(String(e.ticket || '').slice(1));
    if (!(num > 0) || !e.agent || !known.has(num)) continue;
    const role = roleOf(e);
    const stage = role === 'planner' ? 0 : AT[stageOf(role)];
    if (stage === undefined) continue;
    last.set(num, { num, at: Date.parse(e.at), stage });
  }
  const closed = new Set((board ?? []).filter((b) => b.closed).map((b) => b.num));
  return [...last.values()].filter((t) => !data.tickets.find((x) => x.num === t.num)?.mergedAt && !closed.has(t.num)).sort((a, b) => b.at - a.at).map((t) => {
    const rec = data.tickets.find((x) => x.num === t.num);
    // A written plan is a planned ticket, even before its first engineer starts.
    const at = t.stage === 0 && rec?.planned ? 1 : t.stage;
    const over = all.find((x) => x.num === t.num)?.limit?.over ?? [];
    const why = over.length ? `#${t.num} is at its limit (${over.join(', ')}): forge limits lift ${t.num}`
      : /\bblocked\b|\bwaiting for the owner\b/i.test(rec?.status || '') ? `#${t.num}: ${cut(rec.status, 140)}` : '';
    return {
      num: t.num, title: rec?.title || '',
      subs: PIPE.map((label, i) => sub(label, i < at, i === at && why ? { mine: true, due: true, why } : {})),
    };
  });
}

// Everything the stepper shows. data: projectData's records, lines: the whole timeline (not only --days), board: the
// tracker's tickets ({ num, closed }) or null, all: ticketSummaries (their limits), progress: the merged count.
export function projectSteps({ folder, main, base = 'dev', promote = ['staging', 'main'], data, lines = [], board = null, all = [], progress }) {
  const boot = path.join(folder, 'bootstrap');
  const arch = path.join(folder, 'architecture');
  const repo = repoFacts(main);
  const seen = (b) => repo.refs.has(b) || repo.merges.some((m) => m.from === b);
  const merged = (b) => repo.merges.some((m) => m.from === b);
  const steps = [];
  const step = (key, label, summary, subs) => steps.push({ key, label, summary, subs });
  const flight = inFlight({ lines, data, board, all });

  if (has(boot)) {
    // 1. Discovery: the questionnaire, the register, and the settings it proposes, which the owner applies (skill
    // discovery, step 6). Applied once project.json names a stack.
    const decisions = new Set(read(path.join(boot, 'decisions.md')).match(/\bD-\d{3,}\b/g) || []).size;
    const stack = json(path.join(folder, 'project.json'))?.project?.stack;
    const stackSet = typeof stack === 'string' ? stack.trim() !== '' : Object.values(stack ?? {}).some((v) => typeof v === 'string' && v.trim());
    step('discovery', 'Discovery', decisions ? `${decisions} decisions` : '', [
      sub('Questions', has(path.join(boot, 'questionnaire.md'))),
      sub('Register', has(path.join(boot, 'decisions.md'))),
      sub('Your settings', stackSet, { mine: true, due: has(path.join(boot, 'project.proposed.json')), why: 'apply bootstrap/project.proposed.json: project.json has no stack yet (skill discovery, step 6)' }),
    ]);
    // 2. Stories.
    step('stories', 'Stories', data.stories.length ? `${data.stories.length} stories in ${data.epics.length} epics` : '', [
      sub('Stories', data.stories.length > 0),
      sub('Authorization matrix', has(path.join(boot, 'authorization-matrix.md'))),
    ]);
    // 3. Architecture, in the skill's order: the numbers first, then the overview, then a record per decision.
    const adrs = list(path.join(arch, 'adr')).filter((f) => f.endsWith('.md')).length;
    step('architecture', 'Architecture', adrs ? `${adrs} ADRs` : '', [
      sub('NFR', has(path.join(arch, 'nfr.md'))),
      sub('Overview', has(path.join(arch, 'overview.md'))),
      sub(adrs ? `ADRs ${adrs}` : 'ADRs', adrs > 0),
    ]);
    // 4. Screens: the design system, then the epics the design map covers.
    const map = read(path.join(boot, 'design-map.md'));
    const covered = data.epics.filter((e) => new RegExp(`\\b${e.id}\\b`).test(map)).length;
    step('screens', 'Screens', data.epics.length && map ? `${covered} of ${data.epics.length} epics` : '', [
      sub('Design system', has(path.join(boot, 'design-system.md')) || /design system/i.test(map)),
      sub(data.epics.length ? `Epics ${covered} of ${data.epics.length}` : 'Epics', data.epics.length > 0 && covered >= data.epics.length),
    ]);
    // 5. Contract: the draft, then forge api check, which leaves no record: done once the next step begins.
    const spec = read(path.join(boot, 'contract.yaml'));
    const ops = (spec.match(/^\s+operationId:/gm) || []).length;
    const version = /^info:[ \t]*\n(?:[ \t]+.*\n)*?[ \t]+version:[ \t]*['"]?([^'"\s]+)/m.exec(spec)?.[1] ?? '';
    step('contract', 'Contract', spec ? `${ops} operations${version ? `, version ${version}` : ''}` : '', [
      sub('Draft', spec !== ''),
      sub('API check', false),
    ]);
    // 6. Ticket drafts, each with its estimate.
    const n = data.plannedTickets;
    step('tickets', 'Tickets', n ? `${n} drafts` : '', [
      sub(n ? `Drafts ${n}` : 'Drafts', n > 0),
      sub(n ? `Estimates ${data.estimatedTickets} of ${n}` : 'Estimates', n > 0 && data.estimatedTickets >= n),
    ]);
    // 7. The panel: a report per seat, the summary, and the applied findings marked done against the reruns.
    const panel = path.join(boot, 'panel');
    const seats = list(panel).filter((f) => f.endsWith('.md') && f !== 'summary.md').length;
    const summary = read(path.join(panel, 'summary.md'));
    const applied = (/^## Applied[ \t]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(summary)?.[1] ?? '').split('\n')
      .filter((l) => /^\|/.test(l) && !/^\|[\s|:-]+\|?\s*$/.test(l) && !/^\|\s*Id\s*\|/i.test(l))
      .map((l) => l.replace(/^\||\|\s*$/g, '').split('|').at(-1).trim());
    const rerun = applied.filter((c) => c && !/^(—|-|–|no\b|pending|todo|tbd)/i.test(c)).length;
    step('panel', 'Panel', seats ? `${seats} seats${applied.length ? `, ${rerun} of ${applied.length} applied` : ''}` : '', [
      sub(seats ? `Seats ${seats}` : 'Seats', seats > 0),
      sub('Summary', summary !== ''),
      sub(applied.length ? `Reruns ${rerun} of ${applied.length}` : 'Reruns', summary !== '' && rerun >= applied.length),
    ]);
    // 8. The owner's one review; approved once the work after it begins.
    const after = ['chore/architecture', 'chore/bootstrap-contract', 'chore/starter'].some(seen) || repo.tags.some((t) => t.startsWith('api-v')) || data.catalogue.length > 0 || (board ?? []).length > 0 || flight.length > 0;
    step('review', 'Your review', after ? 'approved' : '', [
      sub('Written', has(path.join(boot, 'review.md'))),
      sub('Your approval', after, { mine: true, due: has(path.join(boot, 'review.md')), why: 'approve bootstrap/review.md when the lead asks' }),
    ]);
    // 9. After approval: the owner merges the architecture, contract and starter merge requests and tags the contract,
    // and the lead creates the tickets (on the board, or listed in tickets-created.md).
    const contract = spec !== '' || seen('chore/bootstrap-contract');
    const wanted = ['chore/architecture', ...(contract ? ['chore/bootstrap-contract'] : []), ...(has(path.join(boot, 'project.starter.json')) || seen('chore/starter') ? ['chore/starter'] : [])];
    // A merge request is the owner's once its branch is on origin; before, the lead is still on it.
    const open = wanted.filter((b) => (repo.pushed ? repo.pushed.has(b) : seen(b)) && !merged(b));
    const building = wanted.filter((b) => repo.pushed && !repo.pushed.has(b) && repo.refs.has(b) && !merged(b));
    const tag = repo.tags.find((t) => t.startsWith('api-v'));
    const created = data.catalogue.length || (board ?? []).length;
    step('setup', 'Setup', [wanted.length ? `${wanted.filter(merged).length} of ${wanted.length} merged` : '', tag ?? '', created ? `${created} tickets` : ''].filter(Boolean).join(', '), [
      sub(`Your merges ${wanted.filter(merged).length} of ${wanted.length}`, wanted.every(merged), { mine: true, due: open.length > 0, why: `merge ${open.join(', ')} into ${base} (a draft: mark it ready first)${building.length ? `; ${building.join(', ')} is not pushed yet: the lead is still on it` : ''}` }),
      sub(tag ? `Contract tag ${tag}` : 'Contract tag', Boolean(tag), { mine: true, skip: !contract, due: merged('chore/bootstrap-contract'), why: `tag api-v${version || '1.0.0'} on ${base} and push it` }),
      sub(created ? `Tickets created ${created}` : 'Tickets created', created > 0),
    ]);
  }

  // 10. The build: done when every ticket on the board is closed (or, with no board, every draft merged).
  const total = progress.totalTickets;
  const done = progress.ticketsDone.length;
  const buildDone = board?.length ? board.every((b) => b.closed) && done > 0 : total > 0 && done >= total;
  steps.push({ key: 'build', label: 'Build', summary: `${total || done ? `${done} of ${Math.max(total, done)} merged` : 'no tickets yet'}${flight.length ? `, ${flight.length} in flight` : ''}`, rows: flight, subs: [], started: done > 0 || flight.length > 0, complete: buildDone });

  // 11. The release (skill release): the latest release branch merged into the base branch by a person, promoted to
  // each promote branch in turn, and tagged on the last.
  const versions = [...new Set([...repo.refs, ...repo.merges.map((m) => m.from)].map((b) => /^chore\/release-v(\d+\.\d+\.\d+)$/.exec(b)?.[1]).filter(Boolean))];
  const ver = versions.reduce((a, b) => (!a || newer(b, a) ? b : a), null);
  const branch = ver ? `chore/release-v${ver}` : '';
  const mr = ver ? repo.merges.find((m) => m.from === branch && (m.into === null || m.into === base)) : null;
  const promoted = mr ? promote.filter((b) => repo.contains(mr.hash, b)) : [];
  const next = promote.find((b) => !promoted.includes(b));
  const prev = next ? [base, ...promote][promote.indexOf(next)] : '';
  const tagged = ver ? repo.tags.includes(`v${ver}`) : false;
  steps.push({ key: 'release', label: 'Release', summary: ver ? `v${ver}${tagged ? '' : ' in progress'}` : '', subs: [
    sub('Release MR', Boolean(mr), { mine: true, due: ver !== null && seen(branch), why: `merge ${branch} into ${base}` }),
    sub(`Promotions ${promoted.length} of ${promote.length}`, Boolean(mr) && !next, { mine: true, due: Boolean(mr) && Boolean(next), why: `merge ${prev} into ${next}` }),
    sub(ver ? `Tag v${ver}` : 'Tag', tagged, { mine: true, due: Boolean(mr) && !next, why: `tag v${ver} on ${promote.at(-1)} and push it` }),
  ], complete: tagged && buildDone });

  return place(steps);
}

// Where the project is: the furthest step begun (the release counts once the build is done), or the one after it
// when that one is complete. The states: done, now, wait (yours to act on), todo, skip.
function place(steps) {
  const begun = (s) => s.started ?? s.subs.some((x) => x.done);
  const complete = (s) => s.complete ?? s.subs.every((x) => x.done || x.skip);
  const buildAt = steps.findIndex((s) => s.key === 'build');
  let far = -1;
  steps.forEach((s, i) => { if (begun(s) && (s.key !== 'release' || complete(steps[buildAt]))) far = i; });
  const at = far < 0 ? 0 : complete(steps[far]) ? far + 1 : far;
  const current = at < steps.length ? at : null;
  const waiting = [];
  steps.forEach((s, i) => {
    const before = current === null || i < current;
    const open = s.subs.filter((x) => !x.done && !x.skip);
    if (before) {
      for (const x of open) x.state = x.mine && x.due ? 'wait' : x.mine ? 'skip' : 'done';
      for (const x of s.subs.filter((y) => y.done)) x.state = 'done';
      for (const x of s.subs.filter((y) => y.skip && !y.done)) x.state = 'skip';
      s.state = s.subs.some((x) => x.state === 'wait') ? 'wait' : s.key !== 'build' && s.key !== 'release' && !s.subs.some((x) => x.done) ? 'skip' : 'done';
    } else if (i === current) {
      let first = true;
      for (const x of s.subs) {
        if (x.done) x.state = 'done';
        else if (x.skip) x.state = 'skip';
        else if (x.mine && x.due) { x.state = 'wait'; first = false; } else { x.state = first ? 'now' : 'todo'; first = false; }
      }
      for (const r of s.rows ?? []) {
        for (const x of r.subs) x.state = x.done ? 'done' : x.why ? 'wait' : 'todo';
        const here = r.subs.find((x) => x.state === 'todo');
        if (here && !r.subs.some((x) => x.state === 'wait')) here.state = 'now';
      }
      s.state = s.subs.some((x) => x.state === 'wait') || (s.rows ?? []).some((r) => r.subs.some((x) => x.state === 'wait')) ? 'wait' : 'now';
    } else {
      for (const x of s.subs) x.state = 'todo';
      s.state = 'todo';
    }
    for (const x of [...s.subs, ...(s.rows ?? []).flatMap((r) => r.subs)]) if (x.state === 'wait') waiting.push({ step: s.label, why: x.why });
  });
  return { steps, current, waiting };
}

// The same in words, for forge dashboard --text and the lead's progress report.
const WORD = { done: 'done', now: 'now', wait: 'waits for you', todo: 'next', skip: 'skipped' };
const subsText = (subs) => subs.filter((x) => x.state !== 'todo' || x === subs.find((y) => y.state === 'todo')).map((x) => `${x.label} ${WORD[x.state]}`).join(', ');
export function stepsText(s) {
  if (!s) return [];
  const out = [];
  if (s.current === null) out.push(`Step: all ${s.steps.length} done${s.steps.at(-1).summary ? ` (${s.steps.at(-1).summary})` : ''}.`);
  else {
    const c = s.steps[s.current];
    const rows = (c.rows ?? []).map((r) => `#${r.num} ${r.subs.find((x) => x.state === 'now' || x.state === 'wait')?.label ?? 'Merge'}`);
    out.push(`Step: ${s.current + 1} of ${s.steps.length}, ${c.label}${c.summary ? ` (${c.summary})` : ''}${c.subs.length ? `: ${subsText(c.subs)}` : ''}${rows.length ? `; in flight: ${rows.join(', ')}` : ''}.`);
  }
  if (s.waiting.length) out.push(`Waiting for you: ${s.waiting.map((w) => `${w.step}: ${w.why}`).join('; ')}.`);
  return out;
}

// Each step's time (decision 146), for the Time tab: from the step's first file to the start of the step that came next
// in time (a lead may draw the screens after the contract), split as a ticket's time is: the AI working (agents, gates,
// the lead's turns), waiting for you, and nobody working. A step's first file is its first write in the timeline, else
// its first commit in the team repo (forge init's .gitkeep files are no step's); the setup and the release also start
// at their first commit in the client repo, the setup at the contract tag too. The first step begun also holds what
// came before its first file (the discovery interview). Only the steps begun: the ones done and the current one, so far.
const EVIDENCE = {
  discovery: /(^|\/)bootstrap\/(questionnaire|decisions)\.md$/,
  stories: /(^|\/)bootstrap\/user-stories\.md$/,
  architecture: /(^|\/)architecture\/.+\.md$/,
  screens: /(^|\/)bootstrap\/design-map\.md$/,
  contract: /(^|\/)bootstrap\/contract\.yaml$/,
  tickets: /(^|\/)bootstrap\/tickets(-(?!created)[\w-]+)?\.md$/,
  panel: /(^|\/)bootstrap\/panel\/[^/]+$/,
  review: /(^|\/)bootstrap\/review\.md$/,
  setup: /(^|\/)bootstrap\/tickets-created\.md$/,
  build: /(^|\/)plans\/\d+-[^/]*\.md$/,
};
const WRITES = /^(Write|Edit|MultiEdit|NotebookEdit)$/;
export function stepTimes({ steps, folder, main, base = 'dev', lines = [], now = Date.now() }) {
  if (!steps?.steps.length || !lines.length) return [];
  const first = new Map();
  const seen = (key, t) => { if (Number.isFinite(t) && t > 0 && !(first.get(key) <= t)) first.set(key, t); };
  const match = (file, t) => { for (const [key, re] of Object.entries(EVIDENCE)) if (re.test(file)) seen(key, t); };
  for (const e of lines) if (e.event === 'tool.start' && WRITES.test(e.tool || '')) match(String(e.what || ''), Date.parse(e.at));
  let at = null;
  for (const row of (folder ? git(folder, ['log', '--diff-filter=A', '--format=@%ct', '--name-only', '--', '.']).out || '' : '').split('\n')) {
    if (row.startsWith('@')) at = Number(row.slice(1)) * 1000;
    else if (row) match(row, at);
  }
  // The client repo: a branch's first commit, merged or not.
  const repo = main ? repoFacts(main) : repoFacts(null);
  const ref = (b) => [b, `origin/${b}`].find((r) => git(main, ['rev-parse', '--verify', '-q', r]).ok);
  const from = ref(base);
  const firstCommit = (branch) => {
    const m = repo.merges.find((x) => x.from === branch);
    const range = m ? `${m.hash}^1..${m.hash}^2` : ref(branch) && from ? `${from}..${ref(branch)}` : null;
    const out = range ? git(main, ['log', '--format=%ct', '--reverse', range]).out.split('\n')[0] : '';
    return out ? Number(out) * 1000 : null;
  };
  for (const b of main ? ['chore/architecture', 'chore/bootstrap-contract', 'chore/starter'] : []) seen('setup', firstCommit(b));
  const tag = repo.tags.find((t) => t.startsWith('api-v'));
  if (tag && main) seen('setup', Number(git(main, ['log', '-1', '--format=%ct', tag]).out) * 1000);
  const release = [...repo.refs].filter((r) => /^chore\/release-v\d+\.\d+\.\d+$/.test(r)).sort().at(-1);
  if (release) seen('release', firstCommit(release));

  const begun = steps.steps.map((s, i) => ({ s, i, from: first.get(s.key) }))
    .filter((x) => x.from !== undefined && x.s.state !== 'skip' && (steps.current === null || x.i <= steps.current));
  if (!begun.length) return [];
  const T = (e) => Date.parse(e.at);
  const start = Math.min(...lines.map(T));
  const last = Math.max(...lines.map(T));
  const order = [...begun].sort((a, b) => a.from - b.from);
  const waits = summarize(lines).waits;
  return begun.map((x) => {
    const k = order.indexOf(x);
    const a = k === 0 ? Math.min(x.from, start) : x.from;
    const b = k + 1 < order.length ? order[k + 1].from : steps.current === null ? last : Math.max(now, last);
    const t = timeSplit(lines, a, Math.max(a, b), waits);
    return { key: x.s.key, label: x.s.label, from: a, to: Math.max(a, b), open: x.i === steps.current, ai: t.agents + t.gates + t.lead, owner: t.waiting, idle: t.idle, total: t.total };
  });
}
