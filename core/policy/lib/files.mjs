// File tools: Edit, Write, MultiEdit, NotebookEdit change files; Read and Grep may not open secrets.
import fs from 'node:fs';
import path from 'node:path';
import { deny, ask } from './decision.mjs';
import { resolvePath, isSecretPath, isManifest, wordNamesSecret, isOpenProjectKeyPath, isOpenProjectKeyDir } from './paths.mjs';
import { PROC_ENVIRON } from './rules/secrets.mjs';
import { writeFindings } from './rules/targets.mjs';
import { linkedPath } from './context.mjs';
import { packageName, approvedAdd } from './rules/ops.mjs';

export const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'NotebookRead']);

const applyEdit = (s, from, to, all) => (all ? s.split(from).join(to ?? '') : s.replace(from, () => to ?? ''));

function contentAfter(tool, ti, current) {
  if (tool === 'Write') return ti.content ?? '';
  if (tool === 'Edit') return applyEdit(current, ti.old_string ?? '', ti.new_string, ti.replace_all);
  if (tool === 'MultiEdit') return (ti.edits || []).reduce((s, e) => applyEdit(s, e.old_string ?? '', e.new_string, e.replace_all), current);
  return null;
}

const JSON_DEP_KEYS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'overrides', 'resolutions', 'require', 'require-dev'];
const TOML_DEP_TABLE = /dependencies|^packages$|^dev-packages$|dependency-groups/;

// The dependency declarations of a manifest as a comparable string.
function dependencyView(file, text) {
  const base = path.basename(file);
  if (base === 'package.json' || base === 'composer.json') {
    const j = JSON.parse(text);
    return JSON.stringify(JSON_DEP_KEYS.map((k) => j[k] ?? null));
  }
  if (/\.csproj$|Directory\.Packages\.props$|packages\.config$/.test(base)) {
    return (text.match(/<(PackageReference|PackageVersion|package)\b[^>]*>/gi) || []).map((l) => l.replace(/\s+/g, ' ')).sort().join('\n');
  }
  if (/^requirements.*\.txt$/.test(base)) {
    return text.split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean).sort().join('\n');
  }
  if (base === 'go.mod' || base === 'Gemfile') {
    return text.split('\n').filter((l) => /^\s*(require\b|gem\s|\S+\s+v\d)/.test(l)).map((l) => l.trim()).sort().join('\n');
  }
  // TOML (pyproject.toml, Pipfile, Cargo.toml): lines inside dependency tables and dependency arrays.
  const keep = [];
  let table = '';
  let inArray = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    const header = /^\[+([^\]]+)\]+$/.exec(line);
    if (header) { table = header[1].trim(); inArray = false; continue; }
    if (inArray) { keep.push(line); if (line.includes(']')) inArray = false; continue; }
    if (/^(dependencies|optional-dependencies|dev-dependencies)\s*=\s*\[/.test(line) && !line.includes(']')) { keep.push(line); inArray = true; continue; }
    if (TOML_DEP_TABLE.test(table.split('.').pop()) || /(^|\.)dependencies$/.test(table) || /^dependencies\s*=/.test(line)) keep.push(`${table}:${line}`);
  }
  return keep.filter((l) => !/^[^:]*:$/.test(l)).join('\n');
}

// The dependencies an edit adds or re-versions, or null when it removes one or the format is not
// understood (then a person is asked as before).
function changedDependencyNames(file, before, after) {
  const base = path.basename(file);
  try {
    if (base === 'package.json') {
      const [b, a] = [JSON.parse(before || '{}'), JSON.parse(after)];
      const out = [];
      for (const k of JSON_DEP_KEYS) {
        const [bo, ao] = [b[k] || {}, a[k] || {}];
        if (typeof bo !== 'object' || typeof ao !== 'object') return null;
        if (Object.keys(bo).some((n) => !(n in ao))) return null;
        for (const [n, v] of Object.entries(ao)) if (JSON.stringify(bo[n]) !== JSON.stringify(v)) out.push(n);
      }
      return out;
    }
    if (/\.csproj$|Directory\.Packages\.props$/.test(base)) {
      const refs = (t) => new Map((t.match(/<Package(Reference|Version)\b[^>]*>/gi) || []).map((l) => [(/Include="([^"]+)"/i.exec(l)?.[1] || '').toLowerCase(), l.replace(/\s+/g, ' ')]));
      const [b, a] = [refs(before || ''), refs(after)];
      if ([...b.keys()].some((n) => !a.has(n))) return null;
      return [...a].filter(([n, l]) => b.get(n) !== l).map(([n]) => n);
    }
    if (/^requirements.*\.txt$/.test(base) || base === 'pyproject.toml') {
      const view = (t) => new Set(dependencyView(file, t).split('\n').filter(Boolean));
      const [b, a] = [view(before || ''), view(after)];
      const nameOf = (l) => packageName(l.replace(/^[^:"']*:/, '').replace(/^["'\s]+/, '').replace(/^([\w.-]+)\s*=.*/, '$1'));
      const added = [...a].filter((l) => !b.has(l));
      const addedNames = new Set(added.map(nameOf));
      if ([...b].filter((l) => !a.has(l)).some((l) => !addedNames.has(nameOf(l)))) return null;
      return [...addedNames];
    }
  } catch {
    return null;
  }
  return null;
}

function dependenciesChanged(file, before, after) {
  if (after === null) return false;
  try {
    return dependencyView(file, before ?? '') !== dependencyView(file, after);
  } catch {
    return true; // unparsable manifest: let a human look
  }
}

// Container images a Dockerfile builds from (FROM, minus references to its own stages) or a compose file
// runs (image:). Changing them is a dependency change (decision 6): a new base, a new tag, a new service.
const IMAGE_FILES = /(^|\/)(Dockerfile(\.[\w.-]+)?|[\w.-]+\.Dockerfile|(docker-)?compose(\.[\w.-]+)?\.ya?ml)$/i;
export function imageRefs(file, text) {
  if (!text) return [];
  if (/compose/i.test(path.basename(file))) return [...text.matchAll(/^\s*image:\s*["']?([^\s"'#]+)/gm)].map((m) => m[1]).sort();
  const stages = new Set();
  const out = [];
  for (const m of text.matchAll(/^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/gim)) {
    if (!stages.has(m[1].toLowerCase())) out.push(m[1]);
    if (m[2]) stages.add(m[2].toLowerCase());
  }
  return out.sort();
}

const READ_MSG = 'Secret files are never opened by agents. Use .env.example for variable names; scripts load credentials by variable name.';
const KEY_MSG = 'The OpenProject API key file is never opened or written by an agent. Use `forge tracker`; it loads the key itself.';
const ENV_MSG = 'A process environment file can print secrets. Ask for one variable by name instead.';

// The OpenProject key file or its folder, a glob into that folder, or a process environment file.
function keyFindings(paths, ctx) {
  const abs = paths.map((p) => resolvePath(p, ctx.cwd, ctx.home));
  if (abs.some((p) => isOpenProjectKeyPath(p) || isOpenProjectKeyDir(p))
    || paths.some((p) => /(^|[/\\])openproject-key$/.test(p))) return [deny('openproject:key', KEY_MSG)];
  if (paths.some((p) => PROC_ENVIRON.test(p))) return [deny('secrets:env-dump', ENV_MSG)];
  return [];
}

export function checkFileTool(input, ctx) {
  const tool = input.tool_name;
  const ti = input.tool_input || {};
  if (READ_TOOLS.has(tool)) {
    const p = ti.file_path ?? ti.notebook_path;
    const keys = p ? keyFindings([p], ctx) : [];
    if (keys.length) return keys;
    return p && isSecretPath(resolvePath(p, ctx.cwd, ctx.home), ctx.config, ctx.home) ? [deny('secrets:read', READ_MSG)] : [];
  }
  if (tool === 'Grep') {
    const keys = keyFindings([ti.path, ti.glob].filter(Boolean), ctx);
    if (keys.length) return keys;
    const hits = [ti.path, ti.glob].filter(Boolean).some((p) => wordNamesSecret(p, ctx));
    return hits ? [deny('secrets:read', READ_MSG)] : [];
  }
  if (!WRITE_TOOLS.has(tool)) return [];
  const p = ti.file_path ?? ti.notebook_path;
  if (!p) return [];
  const keys = keyFindings([p], ctx);
  if (keys.length) return keys;
  const abs = linkedPath(resolvePath(p, ctx.cwd, ctx.home), ctx);
  const exists = fs.existsSync(abs);
  const out = writeFindings(abs, ctx, exists ? 'Editing' : 'Creating');
  if (isManifest(abs) && !out.some((f) => f.decision === 'deny')) {
    const before = exists ? fs.readFileSync(abs, 'utf8') : null;
    const after = contentAfter(tool, ti, before ?? '');
    if (dependenciesChanged(abs, before, after)) {
      const names = changedDependencyNames(abs, before, after);
      if (names === null || !names.length || !approvedAdd(names, ctx)) {
        out.push(ask('deps:change', `This edit changes the dependencies declared in ${path.basename(abs)} (a stack decision).`));
      }
    }
  }
  if (IMAGE_FILES.test(abs.split(path.sep).join('/')) && !out.some((f) => f.decision === 'deny')) {
    const before = exists ? fs.readFileSync(abs, 'utf8') : null;
    const [b, a] = [imageRefs(abs, before), imageRefs(abs, contentAfter(tool, ti, before ?? ''))];
    if (b.join('\n') !== a.join('\n')) {
      const added = a.filter((x) => !b.includes(x));
      out.push(ask('deps:image', `This edit changes the container images in ${path.basename(abs)}${added.length ? ` (${added.join(', ')})` : ''}: base images and service images are dependencies.`));
    }
  }
  return out;
}
