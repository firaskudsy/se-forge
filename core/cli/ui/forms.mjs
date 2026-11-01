// A command's form in forge ui (decision 153): its fields come from the entry's spec (commands.mjs), and the values
// typed make the command line it runs, shown before it runs.
const TOKEN = /\[[^\]]*\]|<[^>]*>|\S+/g;

const nameOf = (s) => s.replace(/[<>[\].]/g, '').replace(/^-+/, '').trim();

// The spec as a list of parts: { word } typed as it is, or a field { key, label, option, kind, required, multi,
// choices }. kind: 'value' (text), 'flag' (on or off) or 'choice' (one of choices, or none).
export function partsOf(spec) {
  const tokens = spec.replace(/^forge\s+/, '').match(TOKEN) ?? [];
  const parts = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('[')) {
      const inner = t.slice(1, -1).trim();
      const [opt, arg] = inner.split(/\s+/, 2);
      if (!opt.startsWith('-')) parts.push({ key: nameOf(opt), label: opt, option: null, kind: 'value', required: false, multi: opt.endsWith('...>') });
      else if (!arg) parts.push({ key: nameOf(opt), label: opt, option: opt, kind: 'flag', required: false });
      else if (!arg.startsWith('<') && arg.includes('|')) parts.push({ key: nameOf(opt), label: opt, option: opt, kind: 'choice', required: false, choices: arg.split('|') });
      else if (!arg.startsWith('<')) parts.push({ key: nameOf(opt), label: `${opt} ${arg}`, option: opt, kind: 'choice', required: false, choices: [arg] });
      else parts.push({ key: nameOf(opt), label: `${opt} ${arg}`, option: opt, kind: 'value', required: false, hint: arg });
    } else if (t.startsWith('<')) {
      parts.push({ key: nameOf(t), label: t, option: null, kind: 'value', required: true, multi: t.endsWith('...>') });
    } else if (t.startsWith('-') && tokens[i + 1]?.startsWith('<')) {
      parts.push({ key: nameOf(t), label: `${t} ${tokens[i + 1]}`, option: t, kind: 'value', required: true, hint: tokens[i + 1] });
      i++;
    } else parts.push({ word: t });
  }
  return parts;
}

export const fieldsOf = (spec) => partsOf(spec).filter((p) => !p.word);

// The arguments for the values given ({ key: text | true | choice }), or { error } naming a value it needs.
export function argvOf(spec, values = {}) {
  const argv = [];
  for (const p of partsOf(spec)) {
    if (p.word) { argv.push(p.word); continue; }
    const v = values[p.key];
    const text = typeof v === 'string' ? v.trim() : '';
    if (p.kind === 'flag') { if (v === true) argv.push(p.option); continue; }
    if (p.kind === 'choice') { if (text) argv.push(p.option, text); continue; }
    if (!text) { if (p.required) return { error: `${p.label} is needed` }; continue; }
    const words = p.multi ? text.split(/\s+/) : [text];
    argv.push(...(p.option ? [p.option, ...words] : words));
  }
  return { argv };
}

// A command line as a person would type it in a shell.
export const quote = (a) => (/^[\w@%+=:,./#-]+$/.test(a) ? a : `'${String(a).replace(/'/g, '\'\\\'\'')}'`);
export const lineOf = (argv) => ['forge', ...argv].map(quote).join(' ');
