// Per-ticket limits, the circuit breaker (decisions 127 and 154): every ticket has a known worst case. The hook counts,
// for the ticket an engineer spawn names, its repeat lanes (.forge/state/spawns/: the engineer lanes after the first of
// each kind, so a ticket's planned DB, API and UI lanes are not counted, a second API lane or a fix lane is), the
// review rounds with a blocker and the QA fails (the team repo's reviews/<ticket>/, saved or not). At a limit it refuses the next engineer
// lane: the lead parks the ticket (Blocked, with the reason) and takes the next one. Only a person lifts a ticket's
// limit (forge limits lift <ticket>, in a terminal), which gives it one more allowance of each.
import fs from 'node:fs';
import path from 'node:path';
import { git } from './context.mjs';
import { ask, deny } from './decision.mjs';
import { reviewRounds, passing } from './reports.mjs';
import { spawnTicket } from './timeline.mjs';

export const LANE_TYPES = ['db-engineer', 'backend-engineer', 'frontend-engineer', 'mobile-engineer', 'devops-engineer'];
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

// The team repo's root and the project folder in it, for the review history.
export function teamPaths(folder) {
  if (!folder || !fs.existsSync(folder)) return {};
  const top = git(folder, ['rev-parse', '--show-toplevel']);
  return top.ok ? { teamRoot: top.out, rel: path.relative(top.out, fs.realpathSync(folder)) } : {};
}

// What a ticket has used: { lanes, kinds: { 'backend-engineer': 2, … }, repeats, blockerRounds, qaFails }.
export function ticketUsage({ stateDir, teamRoot, rel }, num) {
  const dir = path.join(stateDir, 'spawns');
  const kinds = {};
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith('.json')) : []) {
    const s = readJson(path.join(dir, f));
    const type = String(s?.type ?? '').replace(/^.*:/, '');
    if (s && s.ticket === `#${num}` && LANE_TYPES.includes(type)) kinds[type] = (kinds[type] ?? 0) + 1;
  }
  const counts = Object.values(kinds);
  const rounds = teamRoot ? reviewRounds(teamRoot, path.join(rel ?? '', 'reviews', String(num)), { disk: true }) : [];
  return {
    lanes: counts.reduce((a, b) => a + b, 0),
    kinds,
    repeats: counts.reduce((a, n) => a + n - 1, 0),
    blockerRounds: rounds.filter((r) => Object.entries(r.reports).some(([name, v]) => name !== 'qa' && !passing(v))).length,
    qaFails: rounds.filter((r) => r.reports.qa && !passing(r.reports.qa)).length,
  };
}

// A ticket's limits: the project's (policy.limits), times one more for each lift a person gave it.
export function ticketLimits(limits, stateDir, num) {
  const lifts = Number(readJson(path.join(stateDir, 'limits.json'))?.[String(num)]?.lifts || 0);
  return { repeats: limits.repeats * (1 + lifts), blockerRounds: limits.blockerRounds * (1 + lifts), qaFails: limits.qaFails * (1 + lifts), lifts };
}

// Which limits a ticket has reached, as words; [] when none.
export function reached(used, lim) {
  return [
    used.repeats >= lim.repeats ? `${used.repeats} repeat lanes (limit ${lim.repeats})` : null,
    used.blockerRounds >= lim.blockerRounds ? `${used.blockerRounds} review rounds with blockers (limit ${lim.blockerRounds})` : null,
    used.qaFails >= lim.qaFails ? `${used.qaFails} QA fails (limit ${lim.qaFails})` : null,
  ].filter(Boolean);
}

// PreToolUse on Agent/Task: an engineer lane for a ticket at its limit is refused; one naming no ticket asks.
export function limitFindings(input, ctx) {
  if (!['Agent', 'Task'].includes(input.tool_name)) return [];
  const type = String(input.tool_input?.subagent_type ?? '').replace(/^.*:/, '');
  if (!LANE_TYPES.includes(type)) return [];
  const ticket = spawnTicket(input.tool_input);
  if (!ticket) return [ask('ticket:none', `This ${type} lane names no ticket, so its limits cannot be counted (decision 127). Name the ticket in its description ("API lane #12"), or approve it to run outside any ticket.`)];
  const num = ticket.slice(1);
  const used = ticketUsage({ stateDir: ctx.stateDir, ...teamPaths(ctx.projectDir?.()) }, num);
  const lim = ticketLimits(ctx.config.limits, ctx.stateDir, num);
  const over = reached(used, lim);
  if (!over.length) return [];
  return [deny('ticket:limit', `${ticket} has reached its limit: ${over.join(', ')}. Park it: forge tracker status ${num} Blocked --comment "<the limit it reached, what is done, what is left>", set its plan's status line to "Blocked: reached its limit", tell the owner, and take the next ticket. Never go around it (another engineer type, a lane that names no ticket). Only a person lifts it, in a terminal: forge limits lift ${num} (decisions 127 and 154).`)];
}
