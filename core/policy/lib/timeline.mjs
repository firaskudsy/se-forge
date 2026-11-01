// The timeline (decision 96): one JSON line per event in <main>/.forge/state/timeline-<YYYY-MM>.jsonl, so a
// person can see later where a ticket's time went (`forge timeline`). The hooks and the forge command write it,
// never an agent (.forge/state is closed to agents), and nothing of it reaches an agent's context.
// - who: lead, the agent's role, human or kit; agent: the lane's id; ticket: from the spawn's description
//   ("#12 …"), else from the branch (feat/12-…).
// - A tool call is tool.start (tool.ask or tool.refused, with the kit's rule and reason) before it runs and
//   tool.done or tool.fail after, with ms = the tool's own run time. Claude Code starts that clock after the
//   permission decision, so the gap between tool.start and (end − ms) is a person answering a prompt.
// - Tokens (decision 97): a model reply's model and tokens (input, 5-minute and 1-hour cache writes, cache
//   read, output), from Claude Code's session log. Claude Code writes a reply as it streams, one line per
//   block; the input and cache counts are on every line, the final output count only on the line with the
//   stop reason. So a reply's tokens are claimed once it is complete, by the first line that finds it so (a
//   call's start or end, turn.end, agent.stop); other lines name it (`reply`) without them. At the end of a
//   turn or an agent, any finished reply of the last day not yet claimed gets a `reply` line of its own.
// - No prompts, file contents or command output: a command or path is kept to 120 characters and an error to
//   300, with secrets masked.
// - It goes into the session's project (CLAUDE_PROJECT_DIR), not the folder the shell is in: a lead that cds
//   into the team repo still writes its own project's timeline.
// Writing it never fails a hook.
import fs from 'node:fs';
import path from 'node:path';
import { readState, writeState, mainRootOf } from './context.mjs';
import { PATTERNS } from './scan.mjs';
import { isSecretVarName } from './rules/secrets.mjs';
import { laneTranscript } from './lanes.mjs';

const WHAT = 120;
const WHY = 300;
const AGENT_TOOLS = new Set(['Agent', 'Task']);

export function mask(text) {
  let s = String(text);
  for (const [, rx] of PATTERNS) s = s.replace(new RegExp(rx.source, 'g'), '***');
  return s
    .replace(/(:\/\/)[^\s/@]+@/g, '$1***@')
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g, (m, name) => (isSecretVarName(name) ? `${name}=***` : m))
    .replace(/\b(authorization|private-token|x-api-key|api-key)(\s*[:=]\s*)((?:bearer|basic|token)\s+)?[^\s'"]+/gi, '$1$2$3***')
    .replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 ***');
}

// One line of text, secrets masked, at most n characters.
export function clip(text, n = WHY) {
  if (text === undefined || text === null) return undefined;
  const s = mask(typeof text === 'string' ? text : JSON.stringify(text)).replace(/\s+/g, ' ').trim();
  if (!s) return undefined;
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export const ticketIn = (text) => {
  const m = /(?:#|\bticket\s+#?)(\d+)\b/i.exec(String(text ?? ''));
  return m ? `#${m[1]}` : undefined;
};
// The ticket a spawn works for: in its description ("API lane #12"), else the plan its prompt names
// (plans/12-login.md), else a #12 in the prompt. The per-ticket limits count lanes by it (decision 127).
export const spawnTicket = (toolInput = {}) => {
  const prompt = String(toolInput.prompt ?? '');
  const plan = /plans\/(\d+)-[^\s/]*\.md/.exec(prompt)?.[1];
  return ticketIn(toolInput.description) ?? (plan ? `#${plan}` : ticketIn(prompt));
};
const ticketOfBranch = (branch) => {
  const m = /^[\w-]+\/(\d+)(?:-|$)/.exec(branch || '');
  return m ? `#${m[1]}` : undefined;
};

// Who acts: the lane's role, the lead, or a person running forge in a terminal.
export function actor(ctx) {
  if (ctx.agentId) return ctx.agentType || 'agent';
  if (ctx.input?.hook_event_name) return 'lead';
  if (ctx.env?.CLAUDECODE === '1') return /\/\.claude\/worktrees\//.test(ctx.cwd || '') ? 'lane' : 'lead';
  return 'human';
}

// Where the timeline goes: { stateDir } of the session's project, or null when that project is not linked.
const homes = new WeakMap();
function home(ctx) {
  if (homes.has(ctx)) return homes.get(ctx);
  const project = ctx.env?.CLAUDE_PROJECT_DIR;
  let dir = ctx.configSource ? ctx.stateDir : null;
  if (project && ![ctx.root, ctx.mainRoot].includes(path.resolve(project)) && fs.existsSync(project)) {
    const root = mainRootOf(project, ctx.env);
    dir = fs.existsSync(path.join(root, '.forge', 'project')) ? path.join(root, '.forge', 'state') : null;
  }
  const out = dir ? { stateDir: dir } : null;
  homes.set(ctx, out);
  return out;
}

const spawnFile = (id) => (/^[\w-]+$/.test(String(id)) ? `spawns/${id}.json` : null);
const laneTicket = (ctx, where) => {
  const file = ctx.agentId && spawnFile(ctx.agentId);
  return file ? readState(where, file, null)?.ticket : undefined;
};

export function record(ctx, event, fields = {}) {
  try {
    const where = home(ctx);
    if (!where) return;
    const at = new Date().toISOString();
    let branch;
    try { branch = ctx.branch?.() || undefined; } catch { /* no branch */ }
    const line = {
      at,
      event,
      who: actor(ctx),
      agent: ctx.agentId || undefined,
      session: ctx.input?.session_id ? String(ctx.input.session_id).slice(0, 8) : undefined,
      ticket: laneTicket(ctx, where) ?? ticketOfBranch(branch),
      branch,
    };
    for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && v !== '') line[k] = v;
    fs.mkdirSync(where.stateDir, { recursive: true });
    fs.appendFileSync(path.join(where.stateDir, `timeline-${at.slice(0, 7)}.jsonl`), `${JSON.stringify(line)}\n`);
  } catch { /* the timeline never blocks work */ }
}

function relPath(p, ctx) {
  if (!p) return undefined;
  for (const base of [ctx.root, ctx.mainRoot].filter(Boolean)) {
    const r = path.relative(base, p);
    if (r && !r.startsWith('..') && !path.isAbsolute(r)) return r;
  }
  return ctx.home && p.startsWith(ctx.home) ? `~${p.slice(ctx.home.length)}` : p;
}

// The session log of whoever acts: the lead's session, or the lane's own log next to it.
const transcriptOf = (ctx) => (ctx.agentId ? laneTranscript(ctx.input) : ctx.input?.transcript_path);

function tailLines(file, bytes = 2 * 1024 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    if (len < size) lines.shift();
    return lines;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
const parse = (l) => { try { return JSON.parse(l); } catch { return null; } };
const toolUses = (m) => (Array.isArray(m?.content) ? m.content.filter((c) => c.type === 'tool_use').map((c) => c.id) : []);

// The lead's session writes the 1-hour cache and agents the 5-minute one (seen in clinic-booking's logs); they
// are priced differently, so both are kept. A log without the split counts every write as 5-minute.
export function usageFields(m) {
  const u = m?.usage || {};
  const write = u.cache_creation_input_tokens || 0;
  const hour = Math.min(write, u.cache_creation?.ephemeral_1h_input_tokens || 0);
  const f = { input: u.input_tokens || 0, cacheWrite5m: write - hour, cacheWrite1h: hour, cacheRead: u.cache_read_input_tokens || 0, output: u.output_tokens || 0 };
  return { ...f, tokens: f.input + write + f.cacheRead + f.output };
}

// The reply that asked for a tool call, or without one the log's last reply: { model, reply, usage,
// complete } or null. Its usage is the final one once a line of it has the stop reason.
export function findReply(file, toolUseId = null) {
  if (!file) return null;
  const lines = tailLines(file);
  for (let i = lines.length - 1; i >= 0; i--) {
    if ((toolUseId && !lines[i].includes(toolUseId)) || !lines[i].includes('"assistant"')) continue;
    const m = parse(lines[i])?.message;
    if (m?.role !== 'assistant' || !m.id || !m.usage || m.model === '<synthetic>') continue;
    if (toolUseId && !toolUses(m).includes(toolUseId)) continue;
    const parts = lines.filter((l) => l.includes(m.id)).map((l) => parse(l)?.message).filter((x) => x?.id === m.id);
    const done = parts.find((x) => x.stop_reason);
    return { model: m.model, reply: m.id, usage: (done ?? parts.at(-1) ?? m).usage, complete: Boolean(done) };
  }
  return null;
}

// The first caller for a reply wins its tokens: an exclusive marker file, safe between hooks running at once.
function claim(where, reply) {
  if (!where || !/^[\w-]+$/.test(reply)) return false;
  try {
    fs.mkdirSync(path.join(where.stateDir, 'replies'), { recursive: true });
    fs.writeFileSync(path.join(where.stateDir, 'replies', reply), '', { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

// Markers older than three days are no longer needed (a session's replies are claimed within minutes).
export function pruneClaims(ctx, now = Date.now()) {
  const where = home(ctx);
  const dir = where && path.join(where.stateDir, 'replies');
  try {
    for (const f of fs.readdirSync(dir)) if (now - fs.statSync(path.join(dir, f)).mtimeMs > 3 * 86400000) fs.rmSync(path.join(dir, f), { force: true });
  } catch { /* none yet */ }
}

const replyFields = (ctx, found) => {
  if (!found) return {};
  return { model: found.model, reply: found.reply, ...(found.complete && claim(home(ctx), found.reply) ? usageFields(found) : {}) };
};
export const lastReply = (ctx) => replyFields(ctx, findReply(transcriptOf(ctx)));

// At the end of a turn or an agent: each finished reply of the last day that no line claimed yet.
export function sweepReplies(ctx, now = Date.now()) {
  try {
    const where = home(ctx);
    if (!where) return;
    const seen = new Set();
    for (const l of tailLines(transcriptOf(ctx))) {
      if (!l.includes('"assistant"') || !l.includes('"stop_reason":"')) continue;
      const e = parse(l);
      const m = e?.message;
      if (m?.role !== 'assistant' || !m.id || !m.stop_reason || m.model === '<synthetic>' || seen.has(m.id)) continue;
      seen.add(m.id);
      if (now - Date.parse(e.timestamp) > 86400000) continue;
      if (claim(where, m.id)) record(ctx, 'reply', { at: e.timestamp, model: m.model, reply: m.id, ...usageFields(m) });
    }
  } catch { /* the timeline never blocks work */ }
}

// What a call does, in a few words: the command, the file, the agent's role and task.
export function describe(input, ctx) {
  const ti = input.tool_input || {};
  switch (input.tool_name) {
    case 'Bash': return ti.command;
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit': return relPath(ti.file_path || ti.notebook_path, ctx);
    case 'Grep': case 'Glob': return [ti.pattern, ti.path && `in ${relPath(ti.path, ctx)}`].filter(Boolean).join(' ');
    case 'Agent': case 'Task': return `${ti.subagent_type || 'general-purpose'}: ${ti.description || ''}`;
    case 'Skill': return ti.skill;
    case 'WebFetch': return ti.url;
    case 'WebSearch': return ti.query;
    case 'AskUserQuestion': return ti.questions?.[0]?.question;
    default: return undefined;
  }
}

// PreToolUse: the call and the kit's answer (`out` is what the hook prints; null means allowed).
export function noteCall(ctx, out) {
  const input = ctx.input;
  const decision = out?.hookSpecificOutput?.permissionDecision;
  const reason = out?.hookSpecificOutput?.permissionDecisionReason;
  const stopped = decision === 'deny' || decision === 'ask';
  const spawn = AGENT_TOOLS.has(input.tool_name);
  record(ctx, decision === 'deny' ? 'tool.refused' : decision === 'ask' ? 'tool.ask' : 'tool.start', {
    id: input.tool_use_id,
    tool: input.tool_name,
    what: clip(describe(input, ctx), WHAT),
    rule: stopped ? /^\[([\w:-]+)\]/.exec(reason || '')?.[1] : undefined,
    why: stopped ? clip(reason) : undefined,
    ...(spawn ? { ticket: spawnTicket(input.tool_input), askedModel: input.tool_input?.model } : {}),
    ...replyFields(ctx, findReply(transcriptOf(ctx), input.tool_use_id)),
  });
}

// PostToolUse (failed = false) and PostToolUseFailure (failed = true). A spawn's result names the new agent, so
// its ticket is kept for the agent's own lines.
export function noteResult(ctx, failed) {
  const input = ctx.input;
  const r = input.tool_response;
  const extra = {};
  if (!failed && AGENT_TOOLS.has(input.tool_name) && r && typeof r === 'object' && r.agentId) {
    const ticket = ticketIn(r.description) ?? spawnTicket(input.tool_input);
    Object.assign(extra, { spawned: r.agentId, ticket, agentModel: r.resolvedModel, status: r.status });
    const file = spawnFile(r.agentId);
    const where = home(ctx);
    try {
      if (file && where) writeState(where, file, { type: input.tool_input?.subagent_type || null, ticket: ticket ?? null, description: clip(r.description ?? input.tool_input?.description, WHAT) ?? null, at: new Date().toISOString() });
    } catch { /* the timeline never blocks work */ }
  }
  record(ctx, failed ? 'tool.fail' : 'tool.done', {
    id: input.tool_use_id,
    tool: input.tool_name,
    what: clip(describe(input, ctx), WHAT),
    ms: input.duration_ms,
    why: failed ? clip(input.error) : undefined,
    interrupted: failed && input.is_interrupt ? true : undefined,
    ...extra,
    ...replyFields(ctx, findReply(transcriptOf(ctx), input.tool_use_id)),
  });
}

// The events that only go into the timeline.
export function noteEvent(ctx) {
  const input = ctx.input;
  switch (input.hook_event_name) {
    case 'SessionStart': pruneClaims(ctx); return record(ctx, 'session.start', { source: input.source });
    case 'SessionEnd': return record(ctx, 'session.end', { why: clip(input.reason) });
    case 'UserPromptSubmit': {
      const text = String(input.prompt ?? '').trim();
      // A finished background agent wakes the lead through a notification, not a person.
      if (/^<task-notification>/.test(text)) return record(ctx, 'agent.notify', {});
      return record(ctx, 'prompt', { who: 'human', what: /^\/[\w:-]+/.exec(text)?.[0], chars: text.length });
    }
    case 'PreCompact': return record(ctx, 'compact.start', { trigger: input.trigger });
    case 'PostCompact': return record(ctx, 'compact.end', { trigger: input.trigger });
    case 'StopFailure': return record(ctx, 'turn.fail', { why: clip([input.error, input.error_details].filter(Boolean).join(': ')) });
    // Claude Code needs the person (decision 155): a permission prompt, the lead idle at its prompt, a form; the
    // dashboard, forge dashboard --watch and forge ui tell them while nothing in that session follows it.
    case 'Notification': return record(ctx, 'owner.needed', { kind: input.notification_type, what: clip(input.message, WHAT), title: clip(input.title) });
    case 'PermissionDenied': return record(ctx, 'tool.refused', { id: input.tool_use_id, tool: input.tool_name, what: clip(describe(input, ctx), WHAT), rule: 'permission', why: clip(input.reason) });
    default: return undefined;
  }
}
