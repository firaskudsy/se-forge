// Lanes are subagents (their hook input carries agent_id). Lanes never spawn agents,
// and each lane has a context budget and a "first edit" budget enforced before every call.
import fs from 'node:fs';
import path from 'node:path';
import { deny } from './decision.mjs';
import { readState, writeState } from './context.mjs';
import { leadCompactAt } from './config.mjs';
import { parseShell } from './shell.mjs';

const SPAWN_TOOLS = new Set(['Agent', 'Task', 'Workflow']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// The lane's own transcript sits next to the session transcript the harness gives every hook:
// <session>.jsonl → <session>/subagents/agent-<agent_id>.jsonl (agent_transcript_path at SubagentStop).
export function laneTranscript(input) {
  if (input.agent_transcript_path) return input.agent_transcript_path;
  if (!input.agent_id || !input.transcript_path) return null;
  return `${input.transcript_path.replace(/\.jsonl$/, '')}/subagents/agent-${input.agent_id}.jsonl`;
}

// Context size of the latest model call: input + cache read + cache creation tokens.
// Returns null when the transcript is missing or holds no usage yet.
export function contextTokens(file) {
  if (!file) return null;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"usage"')) continue;
      try {
        const u = JSON.parse(lines[i])?.message?.usage;
        if (u) return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      } catch { /* partial first line */ }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Calls that still help a lane hand over cleanly once it is over budget.
const HANDOVER_GIT = new Set(['add', 'commit', 'push', 'status', 'diff', 'log', 'show', 'rev-parse', 'branch']);
function handoverSafe(input) {
  const ti = input.tool_input || {};
  if (input.tool_name === 'Read') return true;
  if (EDIT_TOOLS.has(input.tool_name)) return /handoffs\/[^/]*handover[^/]*\.md$/.test(ti.file_path || '');
  if (input.tool_name !== 'Bash') return false;
  return parseShell(ti.command || '').every((c) => {
    const [a0, sub] = c.argv;
    return (a0 === 'git' && HANDOVER_GIT.has(sub)) || /handover\.sh$/.test(a0 || '') || (a0 === 'bash' && /handover\.sh$/.test(sub || '')) || a0 === 'mkdir';
  });
}

const k = (n) => `${Math.round(n / 1000)}k`;
const laneFile = (id) => `lanes/${id}.json`;

export function laneFindings(input, ctx) {
  if (!ctx.agentId) return [];
  const out = [];
  if (SPAWN_TOOLS.has(input.tool_name)) {
    out.push(deny('lanes:no-subagents', 'Lanes never launch sub-agents, forks or workflows. Do the work yourself, or report to the lead.'));
  }
  const { warn, block, maxCallsWithoutEdit, engineers } = ctx.config.budget;
  const tokens = contextTokens(laneTranscript(input));
  if (tokens !== null && tokens >= block && !handoverSafe(input)) {
    out.push(deny('budget:block', `Context budget exceeded: ${k(tokens)} (hard limit ${k(block)}, warning at ${k(warn)}). Stop now: commit your work with explicit paths, push, write .forge/handoffs/<your-name>-handover.md (done / remaining / decisions / exact next step), then end your turn with only that path. The lead continues in a fresh agent.`));
  }
  const s = readState(ctx, laneFile(ctx.agentId), { calls: 0, edits: 0 });
  if (engineers.includes(ctx.agentType) && s.edits === 0 && s.calls >= maxCallsWithoutEdit && !EDIT_TOOLS.has(input.tool_name) && !handoverSafe(input)) {
    out.push(deny('budget:no-edit', `${s.calls} tool calls without a single edit. You are off track: stop exploring, commit anything useful, and end with a report of at most 6 lines saying what blocked you.`));
  }
  return out;
}

// Where Claude Code compacts the lead: the window forge sync wrote (lowered on a self-hosted model server, decision
// 142), else the budget's.
function compactAt(ctx) {
  try { return JSON.parse(fs.readFileSync(path.join(ctx.mainRoot, '.claude', 'settings.local.json'), 'utf8')).autoCompactWindow || leadCompactAt(ctx.config.budget); } catch { return leadCompactAt(ctx.config.budget); }
}

// After each call: count calls and edits, and warn once the context passes the warning line.
export function laneAfterCall(input, ctx) {
  const { warn, block, leadWarn } = ctx.config.budget;
  if (!ctx.agentId) {
    const tokens = contextTokens(input.transcript_path);
    if (tokens === null || tokens < leadWarn) return null;
    const s = readState(ctx, 'lead.json', { calls: 0, warnedAt: -100 });
    s.calls++;
    const due = s.calls - s.warnedAt >= 20;
    if (due) s.warnedAt = s.calls;
    writeState(ctx, 'lead.json', s);
    return due ? `Lead context is ${k(tokens)} (handover line ${k(leadWarn)}). Bring .forge/handoffs/lead-handover.md up to date now (handover skill), then keep working: Claude Code compacts this conversation before it reaches ${k(compactAt(ctx))}, and you carry on from the handover. Do not stop to ask for /clear.` : null;
  }
  const s = readState(ctx, laneFile(ctx.agentId), { calls: 0, edits: 0, warnedAt: -100, type: ctx.agentType, started: new Date().toISOString() });
  s.calls++;
  if (EDIT_TOOLS.has(input.tool_name)) s.edits++;
  const tokens = contextTokens(laneTranscript(input));
  let msg = null;
  if (tokens !== null && tokens >= warn && s.calls - s.warnedAt >= 10) {
    s.warnedAt = s.calls;
    msg = `Context budget warning: ${k(tokens)} used; the warning line is ${k(warn)} and the lane is stopped at ${k(block)}. Complete only the step you are on, commit and push it, write .forge/handoffs/<your-name>-handover.md, then stop, with as little tool output as possible in the meantime.`;
  }
  writeState(ctx, laneFile(ctx.agentId), s);
  return msg;
}
