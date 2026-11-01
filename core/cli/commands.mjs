// The commands forge ui offers (decision 153), one entry per thing a person does, in the groups of its Commands menu.
// forge's help (the comment at the top of forge.mjs) stays the one description of every command: each entry names the
// help line it comes from (from: the line's start, or all of it), and a test fails when a command in the help has no
// entry here. spec is the entry's own usage, flat, and the form's fields come from it: <x> a value it needs, [<x>] one
// it may take, <x...> several, [--flag], [--opt <x>], [--opt a|b] a choice, --opt <x> a value it needs; other words
// are typed as they are. confirm: 'yes' asks y/N before it runs; 'name' asks for the project's name (forge delete).
import fs from 'node:fs';

export const GROUPS = [['look', 'Look'], ['you', 'Your decisions'], ['setup', 'Setup'], ['lead', 'The lead\'s tools']];

export const COMMANDS = [
  { group: 'look', spec: 'forge dashboard --text', from: 'forge dashboard' },
  { group: 'look', spec: 'forge dashboard [--days <n>] [--ticket <list>] [--offline] [--no-open]', from: 'forge dashboard' },
  { group: 'look', spec: 'forge dashboard --watch [--every <30s|2m>] [--no-open]', from: 'forge dashboard' },
  { group: 'look', spec: 'forge limits', from: 'forge limits' },
  { group: 'look', spec: 'forge worktrees', from: 'forge worktrees' },
  { group: 'look', spec: 'forge timeline [<ticket>] [--days <n>]', from: 'forge timeline [' },
  { group: 'look', spec: 'forge metrics <ticket> [--branch <b>]', from: 'forge metrics' },
  { group: 'look', spec: 'forge gates', from: 'forge gates' },
  { group: 'look', spec: 'forge doctor', from: 'forge doctor' },
  { group: 'look', spec: 'forge pacing', from: 'forge pacing' },
  { group: 'look', spec: 'forge app', from: 'forge app' },
  { group: 'look', spec: 'forge shot', from: 'forge shot' },
  { group: 'look', spec: 'forge llm', from: 'forge llm' },
  { group: 'look', spec: 'forge system check [<system.json>]', from: 'forge system check' },
  { group: 'look', spec: 'forge version', from: 'forge version' },
  { group: 'you', spec: 'forge approve <ticket> [--package <names>]', from: 'forge approve', confirm: 'yes' },
  { group: 'you', spec: 'forge limits lift <ticket>', from: 'forge limits', confirm: 'yes' },
  { group: 'you', spec: 'forge save [-m <message>]', from: 'forge save', confirm: 'yes' },
  { group: 'you', spec: 'forge app up [--fresh] [--no-open]', from: 'forge app' },
  { group: 'you', spec: 'forge app down', from: 'forge app', confirm: 'yes' },
  { group: 'you', spec: 'forge worktrees --clean', from: 'forge worktrees', confirm: 'yes' },
  { group: 'you', spec: 'forge llm use <name>', from: 'forge llm', confirm: 'yes' },
  { group: 'you', spec: 'forge export --check', from: 'forge export' },
  { group: 'you', spec: 'forge export [--out <file>] [--force]', from: 'forge export', confirm: 'yes' },
  { group: 'you', spec: 'forge import <file> [--force]', from: 'forge import', confirm: 'yes' },
  { group: 'you', spec: 'forge delete <slug> [--force]', from: 'forge delete', confirm: 'name' },
  { group: 'setup', spec: 'forge setup --team-repo <path> [--kit-repo <url>] [--pacing on|off]', from: 'forge setup', confirm: 'yes' },
  { group: 'setup', spec: 'forge init --project <slug> [--new] [--client <name>] [--host gitlab|github] [--tracker gitlab|github|openproject] [--force]', from: 'forge init', confirm: 'yes' },
  { group: 'setup', spec: 'forge new [--backend <b>] [--db <d>] [--frontend react] [--mobile flutter] [--app-id <id>] [--title <t>] [--host gitlab|github]', from: 'forge new', confirm: 'yes' },
  { group: 'setup', spec: 'forge sync [--force]', from: 'forge sync', confirm: 'yes' },
  { group: 'setup', spec: 'forge upgrade --to <version>', from: 'forge upgrade', confirm: 'yes' },
  { group: 'setup', spec: 'forge llm add <name> --url <address> --model <model> [--key-file <file>]', from: 'forge llm', confirm: 'yes' },
  { group: 'setup', spec: 'forge llm remove <name>', from: 'forge llm', confirm: 'yes' },
  { group: 'setup', spec: 'forge system init --system <slug> [--from <system.json>] [--workspace <dir>]', from: 'forge system init', confirm: 'yes' },
  { group: 'setup', spec: 'forge timeline import', from: 'forge timeline import', confirm: 'yes' },
  { group: 'setup', spec: 'forge config check <file>', from: 'forge config check' },
  { group: 'lead', spec: 'forge merge <ticket> [--branch <b>]', from: 'forge merge <ticket>', confirm: 'yes' },
  { group: 'lead', spec: 'forge merge <branch>', from: 'forge merge <setup branch>', confirm: 'yes' },
  { group: 'lead', spec: 'forge handover <name> [--from-tree] [<worktree>]', from: 'forge handover', confirm: 'yes' },
  { group: 'lead', spec: 'forge wait-owner <ticket>', from: 'forge wait-owner', confirm: 'yes' },
  { group: 'lead', spec: 'forge tracker <command> [<args...>]', from: 'forge tracker', confirm: 'yes' },
  { group: 'lead', spec: 'forge api check', from: 'forge api' },
  { group: 'lead', spec: 'forge api fetch', from: 'forge api' },
  { group: 'lead', spec: 'forge api generate', from: 'forge api', confirm: 'yes' },
  { group: 'lead', spec: 'forge api apply <draft> [--ticket <n>]', from: 'forge api', confirm: 'yes' },
  { group: 'lead', spec: 'forge docs check <paths...>', from: 'forge docs check' },
  { group: 'lead', spec: 'forge design sample <image> [--top <n>]', from: 'forge design sample' },
  { group: 'lead', spec: 'forge shot <image> <what> [--ticket <n>]', from: 'forge shot <image>', confirm: 'yes' },
  { group: 'lead', spec: 'forge shot --playwright <report.json> [--ticket <n>]', from: 'forge shot --playwright', confirm: 'yes' },
  { group: 'lead', spec: 'forge shot --dir <folder> [--ticket <n>]', from: 'forge shot --dir', confirm: 'yes' },
  { group: 'lead', spec: 'forge lane open <ticket> [--name <n>] [--review]', from: 'forge lane', confirm: 'yes' },
  { group: 'lead', spec: 'forge lane close <path>', from: 'forge lane', confirm: 'yes' },
];

// forge's help as entries: each "forge …" line, its usage (up to a gap of three spaces) and its description (the rest,
// with the lines under it).
export function helpEntries(text = fs.readFileSync(new URL('./forge.mjs', import.meta.url), 'utf8')) {
  const lines = text.split('\n').slice(1);
  const out = [];
  for (const l of lines.slice(0, lines.findIndex((x) => !x.startsWith('//')))) {
    const body = l.replace(/^\/\/ ?/, '');
    const m = /^ {2}(forge\b.*?)(?: {3,}(.*))?$/.exec(body);
    if (m) out.push({ usage: m[1].trim(), text: (m[2] ?? '').trim() });
    else if (out.length && /^ {6,}\S/.test(body)) out.at(-1).text = `${out.at(-1).text} ${body.trim()}`.trim();
  }
  return out;
}

// The help entry an entry's from names: the line that is exactly it, else the one line that starts with it as whole
// words ("forge app" is not "forge approve").
export function helpFor(from, entries = helpEntries()) {
  const exact = entries.filter((e) => e.usage === from);
  if (exact.length) return exact[0];
  const starts = entries.filter((e) => e.usage.startsWith(from) && !/[\w-]/.test(e.usage[from.length] ?? ' '));
  return starts.length === 1 ? starts[0] : null;
}
