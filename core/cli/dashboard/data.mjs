// The dashboard's data (decision 98): one record per ticket, joined from what the project already keeps.
// - Team repo folder: bootstrap/user-stories.md (### E1-S1 …), bootstrap/tickets.md (### T-01 … with
//   **Story:**, **Areas:** and **Estimate:**), bootstrap/tickets-created.md (T-01 → #10), plans/<id>-*.md (Areas:, Gates:,
//   Sources:, Branch:, Status:, the Estimate total), metrics.md (estimate, people's actual hours), and the history of
//   reviews/<id>/*.md (every forge save is a commit, so each review round can be read back).
// - Client repo: merges into the base branch ("Merge branch 'feat/12-…' into 'dev'") say when a ticket was done; in a
//   system (decision 130), every member repository's merges into its own base branch, and the plan's Repo: line.
// - The timeline (decisions 96-98), with the history import; the gate results and the lanes that stopped
//   with failing gates (.forge/state/gates.json and gates-failed.json).
// - The pictures of the app in the team repo folder's shots/ (forge shot, decision 100).
// - The agents and skills forge sync rendered into the checkout's .claude/ (decision 137).
// Nothing here calls a server.
import fs from 'node:fs';
import path from 'node:path';
import { git } from '../../policy/lib/context.mjs';
import { readReport } from '../merge.mjs';
import { reviewRounds } from '../../policy/lib/reports.mjs';
import { readTimeline, attribute } from '../timeline.mjs';
import { readShots } from '../shot.mjs';

const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const T = (e) => Date.parse(e.at);
const STORY = /\bE\d+-S\d+\b/g;
const ticketOfBranch = (b) => { const m = /^[\w-]+\/(\d+)(?:-|$)/.exec(b || ''); return m ? Number(m[1]) : null; };
// The project manager triages the board for the lead: project overhead, not a ticket's work, even when its
// description names one ("PM board digest after #11 moves").
const OVERHEAD = new Set(['project-manager']);
// A role as the kit names it: agents the lead named after their ticket ("planner-12") count as their role.
const role = (who) => String(who || '').replace(/-\d+$/, '');
const AREAS = (s) => String(s || '').split(/[\s,|]+/).map((a) => a.trim().toLowerCase()).filter((a) => ['ui', 'mobile', 'api', 'db', 'infra'].includes(a));

// "2-4 h", "2–4h", "3 h" → { low, high }.
export function hours(text) {
  const m = /(\d+(?:\.\d+)?)\s*(?:[-–]\s*(\d+(?:\.\d+)?))?\s*h\b/i.exec(String(text || ''));
  return m ? { low: Number(m[1]), high: Number(m[2] ?? m[1]) } : null;
}

export function readStories(folder) {
  const text = read(path.join(folder, 'bootstrap', 'user-stories.md'));
  const epics = [];
  const stories = [];
  for (const line of text.split('\n')) {
    const e = /^##\s+(E\d+)\s+(.+)$/.exec(line);
    if (e) epics.push({ id: e[1], title: e[2].trim() });
    const s = /^###\s+(E\d+-S\d+)\s+(.+)$/.exec(line);
    if (s) stories.push({ id: s[1], epic: s[1].split('-')[0], title: s[2].trim() });
  }
  return { epics, stories };
}

// The bootstrap's tickets: T-id → stories and areas (tickets.md), and → issue number and epic (tickets-created.md).
export function readCatalogue(folder) {
  const byT = new Map();
  let current = null;
  for (const line of read(path.join(folder, 'bootstrap', 'tickets.md')).split('\n')) {
    const h = /^###\s+(T-\d+)\s+(.+)$/.exec(line);
    if (h) { current = { t: h[1], title: h[2].trim(), stories: [], areas: [], estimate: null }; byT.set(h[1], current); continue; }
    if (!current) continue;
    if (/^\s*-\s*\*\*Estimate:\*\*/.test(line)) current.estimate = hours(line);
    if (/^\s*-\s*\*\*Stor(y|ies):\*\*/.test(line)) current.stories = [...new Set(line.match(STORY) || [])];
    if (/^\s*-\s*\*\*Areas:\*\*/.test(line)) current.areas = AREAS(line.replace(/^.*\*\*Areas:\*\*/, ''));
  }
  const tickets = [];
  for (const line of read(path.join(folder, 'bootstrap', 'tickets-created.md')).split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    const t = /^T-\d+$/.test(cells[1] || '') ? cells[1] : null;
    const num = /^#(\d+)$/.exec(cells[3] || '')?.[1];
    if (!t || !num) continue;
    const c = byT.get(t) ?? { stories: [], areas: [] };
    tickets.push({ num: Number(num), t, title: (cells[2] || c.title || '').replace(/^T-\d+\s+/, ''), epic: cells[4] || null, stories: c.stories, areas: c.areas.length ? c.areas : AREAS(cells[5]), estimate: c.estimate ?? null });
  }
  return { tickets, planned: byT.size };
}

export function readPlans(folder) {
  const dir = path.join(folder, 'plans');
  const out = new Map();
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /^\d+-.*\.md$/.test(n)) : []) {
    const text = read(path.join(dir, f));
    const field = (name) => new RegExp(`^${name}:\\s*(.+)$`, 'mi').exec(text)?.[1]?.replace(/[`*]/g, '').trim() ?? '';
    // "| Total | 0.75 h | 1.75 h |", with or without bold and units, as the models write it.
    const total = /^\|\s*\**Total\**\s*\|\s*\**(\d+(?:\.\d+)?)\s*h?\**\s*\|\s*\**(\d+(?:\.\d+)?)\s*h?\**\s*\|/mi.exec(text);
    out.set(Number(f.split('-')[0]), {
      file: f,
      title: /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? f,
      areas: AREAS(field('Areas')),
      gates: field('Gates').split('(')[0].trim() || 'none',
      branch: field('Branch') || null,
      repo: field('Repo') || null,
      // "Status: …" may follow other words on its line ("Written 2026-10-11. Status: Merged into dev …").
      status: /\bStatus:\s*(.+)$/mi.exec(text)?.[1]?.replace(/[`*]/g, '').trim() ?? null,
      stories: [...new Set(field('Sources').match(STORY) || [])],
      estimate: total ? { low: Number(total[1]), high: Number(total[2]) } : null,
    });
  }
  return out;
}

export function readMetrics(folder) {
  const out = new Map();
  for (const line of read(path.join(folder, 'metrics.md')).split('\n')) {
    const c = line.split('|').map((x) => x.trim());
    const num = /^#(\d+)\b/.exec(c[1] || '')?.[1]; // "#7" or "#7 status-check"
    if (num) out.set(Number(num), { estimate: hours(c[2]), actual: hours(c[3])?.low ?? null, bugs: c[4] || '', rework: c[5] || '' });
  }
  return out;
}

// Review rounds: core/policy/lib/reports.mjs, which the per-ticket limits count too (decision 127).
export { reviewRounds };

// When each ticket was merged into the base branch, from the merge commits.
export function readMerges(client, base) {
  const ref = git(client, ['rev-parse', '--verify', '-q', `origin/${base}`]).ok ? `origin/${base}` : base;
  const log = git(client, ['log', ref, '--merges', '--format=%cI%x09%s']);
  const out = new Map();
  for (const row of log.ok ? log.out.split('\n') : []) {
    const [at, subject] = row.split('\t');
    const num = ticketOfBranch(/^Merge branch '([^']+)'/.exec(subject || '')?.[1]);
    if (num !== null && !out.has(num)) out.set(num, Date.parse(at));
  }
  return out;
}

// Branches whose lane stopped with failing gates (design decision D7) and that no green gate run has passed since.
export function readGatesFailed(stateDir) {
  const json = (name) => { try { return JSON.parse(read(path.join(stateDir, name))) || {}; } catch { return {}; } };
  const results = Object.values(json('gates.json'));
  return Object.entries(json('gates-failed.json'))
    .filter(([branch, f]) => !results.some((r) => r?.ok && r.branch === branch && Date.parse(r.at) > Date.parse(f.at)))
    .map(([branch, f]) => ({ branch, ticket: ticketOfBranch(branch), agent: f.agent || '', at: Date.parse(f.at), reason: f.reason || '' }));
}

// Everything, one record per ticket number found anywhere. repos: a system's member repositories
// ([{ name, dir, base, stateDir }]), whose merges and failed lanes count too; null for one repository.
// The project's agents and skills as forge sync rendered them (decision 137): every skill in .claude/skills/, the skills
// each agent preloads (its file's skills: list), and the skills its instructions name (`stack-nestjs` and the like).
export function readAgentFiles(main) {
  const list = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };
  const skills = list(path.join(main || '', '.claude', 'skills')).filter((e) => e.isDirectory() && fs.existsSync(path.join(main, '.claude', 'skills', e.name, 'SKILL.md'))).map((e) => e.name).sort();
  const known = new Set(skills);
  const preloads = {};
  const named = {};
  for (const e of list(path.join(main || '', '.claude', 'agents')).filter((x) => x.name.endsWith('.md'))) {
    const text = read(path.join(main, '.claude', 'agents', e.name));
    const front = /^---\n([\s\S]*?)\n---\n?/.exec(text);
    const name = /^name:\s*(\S+)/m.exec(front?.[1] ?? '')?.[1] ?? e.name.replace(/\.md$/, '');
    preloads[name] = (/^skills:[ \t]*\n((?:[ \t]+-[^\n]*(?:\n|$))+)/m.exec(front?.[1] ?? '')?.[1] ?? '').split('\n').map((l) => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean);
    named[name] = [...new Set([...text.slice(front ? front[0].length : 0).matchAll(/`([a-z0-9-]+)`/g)].map((x) => x[1]).filter((x) => known.has(x)))];
  }
  return { skills, preloads, named };
}

export function projectData({ main, folder, teamRoot, base, stateDir, repos = null }) {
  const { epics, stories } = readStories(folder);
  const catalogue = readCatalogue(folder);
  const plans = readPlans(folder);
  const metrics = readMetrics(folder);
  const merges = readMerges(main, base);
  const mergedIn = new Map();
  for (const r of repos ?? []) {
    for (const [num, at] of readMerges(r.dir, r.base)) {
      if (!merges.has(num) || at < merges.get(num)) { merges.set(num, at); mergedIn.set(num, r.name); }
    }
  }
  // Claude Code's own helpers are no one's agents (forge timeline counts them apart); they leave no transcript, so no
  // reply of theirs is on a line.
  const lines = attribute(readTimeline(stateDir).lines.filter((e) => !e.helper)).map((e) => {
    if (!e.who) return e;
    const who = role(e.who);
    return OVERHEAD.has(who) ? { ...e, who, ticket: undefined } : who === e.who ? e : { ...e, who };
  });
  const rel = path.relative(teamRoot, folder);
  const nums = new Set([...catalogue.tickets.map((t) => t.num), ...plans.keys(), ...metrics.keys(), ...merges.keys(),
    ...lines.map((e) => Number(String(e.ticket || '').slice(1))).filter((n) => n > 0)]);
  const reviewsDir = path.join(folder, 'reviews');
  const tickets = [...nums].sort((a, b) => a - b).map((num) => {
    const c = catalogue.tickets.find((t) => t.num === num);
    const p = plans.get(num);
    const m = metrics.get(num);
    return {
      num,
      id: `#${num}`,
      t: c?.t ?? null,
      title: c?.title || p?.title || '',
      epic: c?.epic ?? null,
      stories: [...new Set([...(c?.stories || []), ...(p?.stories || [])])],
      areas: p?.areas?.length ? p.areas : c?.areas || [],
      gates: p?.gates ?? null,
      planned: Boolean(p),
      status: p?.status ?? null,
      // The plan's estimate, else metrics.md's, else the bootstrap draft's.
      estimate: p?.estimate ?? m?.estimate ?? c?.estimate ?? null,
      actual: m?.actual ?? null,
      mergedAt: merges.get(num) ?? null,
      repo: p?.repo ?? mergedIn.get(num) ?? null,
      rounds: fs.existsSync(path.join(reviewsDir, String(num))) ? reviewRounds(teamRoot, `${rel}/reviews/${num}`) : [],
    };
  });
  return { epics, stories, catalogue: catalogue.tickets, plannedTickets: catalogue.planned, tickets, lines: lines.sort((a, b) => T(a) - T(b)), shots: readShots(folder), gatesFailed: [stateDir, ...(repos ?? []).map((r) => r.stateDir)].flatMap(readGatesFailed), repos: (repos ?? []).map((r) => r.name) };
}
