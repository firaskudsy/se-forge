// forge approve <ticket> [--package <name>[,<name>…]] (decision 149): a person's approval, so nothing in the build
// waits on a prompt. It records the approval of the ticket's plan for its branch, for each gate the plan's Gates: line
// names (security, architecture), which the hooks read before a lane is spawned or a gated file is edited; and it adds
// the packages named to policy.deps.approved, so a lane installs them without asking. forge wait-owner notices it.
// The hook refuses it from Claude: the owner types ! forge approve <ticket> in the session, or runs it in a terminal.
import fs from 'node:fs';
import path from 'node:path';
import { makeContext } from '../policy/lib/context.mjs';
import { recordApproval } from '../policy/lib/approvals.mjs';

export class ApproveError extends Error {}

const SECURITY = /security|auth|permission|payment|pii|personal/i;
const ARCHITECTURE = /architecture|stack/i;

export function approve(o, { main, env, out, now = Date.now }) {
  const num = String(o._[0] ?? '').replace(/^#/, '');
  const usage = 'forge approve <ticket> [--package <name>[,<name>…]]';
  if (!/^\d+$/.test(num)) throw new ApproveError(usage);
  const packages = String(typeof o.package === 'string' ? o.package : '').split(/[,\s]+/).filter(Boolean);
  const dir = path.join(main, '.forge', 'project', 'plans');
  const file = (fs.existsSync(dir) ? fs.readdirSync(dir) : []).find((f) => f.startsWith(`${num}-`) && f.endsWith('.md'));
  const text = file ? fs.readFileSync(path.join(dir, file), 'utf8') : '';
  const gates = (/^Gates:\s*(.+)$/mi.exec(text)?.[1] ?? 'none').replace(/[`*]/g, '').split('(')[0].trim();
  const branch = /^Branch:\s*`?([^\s`]+)`?/mi.exec(text)?.[1] ?? null;
  const which = /^none$/i.test(gates) ? [] : [...(SECURITY.test(gates) ? ['security'] : []), ...(ARCHITECTURE.test(gates) ? ['architecture'] : [])];
  if (!which.length && !packages.length) throw new ApproveError(`Nothing to approve for #${num}: ${file ? `its plan's Gates: line is "${gates}"` : 'it has no plan yet'}, and no --package was named. ${usage}`);
  if (which.length && !branch) throw new ApproveError(`#${num}'s plan (${file}) has no Branch: line, so there is no branch to approve it on.`);
  const ctx = makeContext({ cwd: main }, env);
  const at = new Date(now()).toISOString();
  for (const gate of which) recordApproval(ctx, gate, branch, { ticket: num, at, by: 'forge approve' });
  if (packages.length) {
    const cfg = path.join(main, '.forge', 'project', 'project.json');
    const data = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    data.policy ??= {};
    data.policy.deps ??= {};
    data.policy.deps.approved = [...new Set([...(data.policy.deps.approved ?? []), ...packages])];
    fs.writeFileSync(cfg, `${JSON.stringify(data, null, 2)}\n`);
  }
  // What forge wait-owner looks for: an approval of this ticket after its wait began.
  recordApproval(ctx, 'owner', branch ?? `#${num}`, { ticket: num, at, gates: which, packages });
  out(`#${num} approved${which.length ? `: ${which.join(' and ')} on ${branch}` : ''}${packages.length ? `${which.length ? '; ' : ': '}packages ${packages.join(', ')} added to policy.deps.approved` : ''}. The lead goes on with it (its forge wait-owner notices within seconds)${packages.length ? '; it saves the project file with forge save' : ''}.`);
  return 0;
}
