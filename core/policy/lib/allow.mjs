// Approves, without a prompt, Bash calls made only of the project's own commands (gate
// commands, commands.allow), installs of approved packages (policy.deps.approved, decision 149), downloads of the
// project's Figma pictures (decision 149) and the plumbing around them (cd /tmp, output to /tmp, tail/grep of it). Runs only when no rule objected. Settings deny and ask rules still
// apply after an allow.
import { parseShell } from './shell.mjs';
import { approvedInstall, figmaDownload } from './rules/ops.mjs';

const PLUMBING = new Set(['tail', 'head', 'grep', 'egrep', 'rg', 'wc', 'cat', 'sort', 'uniq', 'cut', 'tr', 'echo', 'printf', 'true', 'test', '[']);
const lines = (cmd) => parseShell(cmd || '').map((c) => c.argv.join(' ')).filter(Boolean);

function projectCommands(cfg) {
  const out = [...lines(cfg.gates.full), ...cfg.commands.allow];
  if (cfg.gates.affected) out.push(...lines(cfg.gates.affected.split('{files}')[0]));
  return out.filter(Boolean);
}

export function autoAllowReason(command, ctx) {
  const known = projectCommands(ctx.config);
  const tmp = (t) => t === '/dev/null' || t.startsWith('/tmp/') || (ctx.env.TMPDIR && t.startsWith(ctx.env.TMPDIR)) || /^\d$/.test(t);
  const cmds = parseShell(command);
  if (!cmds.length) return null;
  let figma = false;
  for (const c of cmds) {
    if (c.assigns.length || c.redirects.some((r) => r.op !== '<' && !tmp(r.target))) return null;
    const line = c.argv.join(' ');
    if (known.some((k) => line === k || line.startsWith(`${k} `))) continue;
    if (approvedInstall(c.argv, ctx)) continue;
    if (figmaDownload(c.argv, ctx)) { figma = true; continue; }
    if (c.argv[0] === 'cd' && (c.argv[1] === '/tmp' || tmp(c.argv[1] || ''))) continue;
    if (c.argv[0] === 'node' && /forge-hook\.mjs$/.test(c.argv[1] || '') && c.argv[2] === 'gates') continue;
    if (PLUMBING.has(c.argv[0]) && c.argv.slice(1).filter((a) => !a.startsWith('-') && a.includes('/')).every(tmp)) continue;
    return null;
  }
  return figma ? 'a picture from the project\'s Figma file' : 'project command from the policy config';
}
