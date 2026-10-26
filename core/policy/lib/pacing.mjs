// Pacing: the Claude plan's usage windows, as the kit's status line last recorded them.
// Opt-in per developer (forge setup --pacing on, then forge sync), subscriptions only: an API key has
// no plan windows, so pacing is off whenever ANTHROPIC_API_KEY is set.
//   amber: 5-hour window >= 75 % or weekly >= 80 %   finish what runs, start nothing large
//   red:   either window >= 90 %                       start no agents, hand over, resume at the reset
// A window whose reset time has passed counts as empty, so old data never keeps work paused.
import fs from 'node:fs';
import path from 'node:path';
import { llmInUse } from './llm.mjs';

export const THRESHOLDS = { five_hour: { amber: 75, red: 90 }, seven_day: { amber: 80, red: 90 } };
const NAMES = { five_hour: '5-hour', seven_day: 'weekly' };

// resets_at arrives as epoch seconds; ISO strings and milliseconds are accepted too.
export function toEpoch(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : (/^\d+(\.\d+)?$/.test(String(v)) ? Number(v) : Date.parse(v) / 1000);
  if (!Number.isFinite(n)) return null;
  return Math.floor(n > 1e12 ? n / 1000 : n);
}

// The status line's input (rate_limits) → what usage.json keeps.
export function usageRecord(rateLimits, now = Date.now()) {
  const rec = { updated_at: Math.floor(now / 1000) };
  for (const w of Object.keys(THRESHOLDS)) {
    const r = rateLimits?.[w];
    rec[w] = r && Number.isFinite(Number(r.used_percentage)) ? { used: Math.round(Number(r.used_percentage)), resets_at: toEpoch(r.resets_at) } : null;
  }
  return rec;
}

export function levelOf(usage, now = Date.now()) {
  let level = 'green';
  const rank = { green: 0, amber: 1, red: 2 };
  let resetAt = null;
  for (const [w, t] of Object.entries(THRESHOLDS)) {
    const u = usage?.[w];
    if (!u || typeof u.used !== 'number' || (u.resets_at && u.resets_at * 1000 <= now)) continue;
    const l = u.used >= t.red ? 'red' : u.used >= t.amber ? 'amber' : 'green';
    if (l === 'red') resetAt = Math.max(resetAt ?? 0, u.resets_at ?? 0) || null;
    if (rank[l] > rank[level]) level = l;
  }
  return { level, resetAt };
}

const pad = (n) => String(n).padStart(2, '0');
export function clock(epoch, withDay = false) {
  if (!epoch) return '?';
  const d = new Date(epoch * 1000);
  return `${withDay ? `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ` : ''}${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// A one-time cron expression (local time) a few minutes after the reset, off the :00 and :30 marks.
export function resumeCron(resetAt) {
  const d = new Date((resetAt + 180) * 1000);
  if (d.getMinutes() === 0 || d.getMinutes() === 30) d.setMinutes(d.getMinutes() + 1);
  return `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`;
}

export function describe(usage, now = Date.now()) {
  const parts = Object.keys(THRESHOLDS).map((w) => {
    const u = usage?.[w];
    if (!u || (u.resets_at && u.resets_at * 1000 <= now)) return `${NAMES[w]} ?`;
    return `${NAMES[w]} ${u.used}% (resets ${clock(u.resets_at, w === 'seven_day')})`;
  });
  return parts.join(', ');
}

// { level: off | unknown | green | amber | red, resetAt, text, age } for this checkout.
export function pacingState(ctx, now = Date.now()) {
  const enabled = (() => { try { return JSON.parse(fs.readFileSync(path.join(ctx.stateDir, 'pacing.json'), 'utf8')).enabled === true; } catch { return false; } })();
  if (!enabled) return { level: 'off', why: 'not turned on (forge setup --pacing on, then forge sync)' };
  if (ctx.env.ANTHROPIC_API_KEY) return { level: 'off', why: 'ANTHROPIC_API_KEY is set: API billing has no plan windows' };
  // On a self-hosted model server (forge llm, decision 140) the Claude plan's windows say nothing; usage.json may
  // still hold numbers from before the switch.
  const server = llmInUse(ctx.stateDir);
  if (server) return { level: 'off', why: `this checkout runs on the model server ${server} (forge llm), which has no plan windows` };
  let usage;
  try { usage = JSON.parse(fs.readFileSync(path.join(ctx.stateDir, 'usage.json'), 'utf8')); } catch { return { level: 'unknown', why: 'no usage recorded yet (the status line records it after the first reply)' }; }
  const { level, resetAt } = levelOf(usage, now);
  return { level, resetAt, text: describe(usage, now), age: Math.max(0, Math.round(now / 1000 - (usage.updated_at || 0))) };
}

// The lead's pause instructions (the hook adds the [pacing:pause] tag).
export function pauseMessage(state) {
  const at = state.resetAt ? `${clock(state.resetAt, true)}` : 'the reset';
  const cron = state.resetAt ? ` Schedule the resume as one prompt, not recurring: cron "${resumeCron(state.resetAt)}", prompt "/resume .forge/handoffs/lead-handover.md".` : '';
  return `Plan usage: ${state.text}. Start no new agents. Let running lanes finish their step and hand over, write your handover with \`forge handover lead\` (it creates .forge/handoffs/lead-handover.md; skill handover), then stop until ${at} (skill pacing).${cron}`;
}

const LANE_PAUSE = (state) => `[pacing:pause] Plan usage: ${state.text}. Finish your current step only: commit with explicit paths, push, write .forge/handoffs/<your-name>-handover.md, and end with only that path. Work resumes after the reset.`;
const AMBER = (state) => `[pacing] Plan usage: ${state.text}. Finish what is running, prefer reviews and QA, start nothing large.`;

// Once per agent and level: the lead and each lane hear about amber/red one time, not on every call.
export function pacingNote(ctx, state) {
  if (state.level !== 'red' && (state.level !== 'amber' || ctx.agentId)) return null;
  const file = path.join(ctx.stateDir, 'pacing-notes.json');
  let notes = {};
  try { notes = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first note */ }
  const who = ctx.agentId || 'lead';
  const key = `${state.level}:${state.resetAt ?? ''}`;
  if (notes[who] === key) return null;
  notes[who] = key;
  fs.mkdirSync(ctx.stateDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(notes));
  if (state.level === 'amber') return AMBER(state);
  return ctx.agentId ? LANE_PAUSE(state) : `[pacing:pause] ${pauseMessage(state)}`;
}
