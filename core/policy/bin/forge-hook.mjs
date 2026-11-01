#!/usr/bin/env node
// Hook entry point: node forge-hook.mjs <pre-tool-use|post-tool-use|subagent-start|subagent-stop|session-start|stop>
// reads the hook input on stdin and prints the hook's JSON answer. post-tool-use-failure and the events that only
// go into the timeline (user-prompt-submit, pre-compact, post-compact, session-end, stop-failure,
// permission-denied, notification) print nothing.
// `node forge-hook.mjs gates` runs the "done" check on the current branch.
// Any failure while handling pre-tool-use blocks the call (exit 2): the guard fails closed.
import fs from 'node:fs';
import { preToolUse, postToolUse, postToolUseFailure, subagentStart, subagentStop, sessionStart, stop, note, gatesCommand } from '../lib/handlers.mjs';

const HANDLERS = {
  'pre-tool-use': preToolUse, 'post-tool-use': postToolUse, 'post-tool-use-failure': postToolUseFailure, 'subagent-start': subagentStart, 'subagent-stop': subagentStop, 'session-start': sessionStart, stop,
  'user-prompt-submit': note, 'pre-compact': note, 'post-compact': note, 'session-end': note, 'stop-failure': note, 'permission-denied': note, notification: note,
};
const event = process.argv[2];
const failClosed = event === 'pre-tool-use';

try {
  if (event === 'gates') {
    const r = gatesCommand(process.env);
    process.stdout.write(r.ok ? `gates green${r.sha ? ` on ${r.sha.slice(0, 8)}` : ''}${r.cached ? ' (recorded)' : ''}\n` : `NOT DONE: ${r.reason}\n`);
    process.exit(r.ok ? 0 : 1);
  }
  const handler = HANDLERS[event];
  if (!handler) throw new Error(`unknown event "${event}"`);
  const raw = fs.readFileSync(0, 'utf8');
  const out = handler(raw.trim() ? JSON.parse(raw) : {}, process.env);
  if (out) process.stdout.write(JSON.stringify(out));
  process.exit(0);
} catch (e) {
  process.stderr.write(`forge-hook ${event}: ${e.message}${failClosed ? ' — blocking this call to stay safe.' : ''}\n`);
  process.exit(failClosed ? 2 : 0);
}
