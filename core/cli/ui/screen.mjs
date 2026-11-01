// forge ui's drawing (decision 153): a frame of cells, each a character and a style, so boxes and dialogs can be drawn
// over one another; plain ANSI codes, no library. A piece of text is a list of [text, style] segments; a style is
// words from SGR (several with spaces). NO_COLOR keeps only bold and reverse.
const SGR = { bold: '1', dim: '2', inv: '7', red: '31', green: '32', yellow: '33', blue: '34', magenta: '35', cyan: '36', grey: '90' };

export const segs = (x) => (Array.isArray(x) ? x.map((e) => (Array.isArray(e) ? [String(e[0] ?? ''), e[1] || ''] : [String(e ?? ''), ''])) : [[String(x ?? ''), '']]);

// Segments cut (with …) or padded with spaces to exactly w characters.
export function fit(x, w, fill = '') {
  const out = [];
  let left = Math.max(0, w);
  for (const [t, s] of segs(x)) {
    if (left <= 0) break;
    const cps = [...String(t).replace(/[\x00-\x1f\x7f]/g, ' ')];
    if (cps.length > left) { out.push([`${cps.slice(0, left - 1).join('')}…`, s]); left = 0; } else { out.push([cps.join(''), s]); left -= cps.length; }
  }
  if (left > 0) out.push([' '.repeat(left), fill]);
  return out;
}
export const width = (x) => segs(x).reduce((n, [t]) => n + [...String(t)].length, 0);

export const frame = (cols, rows) => Array.from({ length: rows }, () => Array.from({ length: cols }, () => [' ', '']));

// Writes text at row y, column x, cut or padded to w.
export function put(f, y, x, text, w, fill = '') {
  if (y < 0 || y >= f.length) return;
  let cx = x;
  for (const [t, s] of fit(text, w, fill)) for (const ch of t) { if (cx >= 0 && cx < f[y].length) f[y][cx] = [ch, s]; cx++; }
}

// A box with its title on the top line; the inside is cleared.
export function box(f, y, x, h, w, title = '', style = '') {
  if (h < 2 || w < 2) return;
  const t = title ? fit([[` ${title} `, `${style} bold`.trim()]], Math.min(width(` ${title} `), w - 4)) : [];
  put(f, y, x, [['┌─', style], ...t, ['─'.repeat(Math.max(0, w - 3 - width(t))), style], ['┐', style]], w);
  for (let i = 1; i < h - 1; i++) { put(f, y + i, x, [['│', style]], 1); put(f, y + i, x + 1, '', w - 2); put(f, y + i, x + w - 1, [['│', style]], 1); }
  put(f, y + h - 1, x, [['└', style], ['─'.repeat(w - 2), style], ['┘', style]], w);
}

const codes = (s, color) => s.split(' ').filter((x) => x && (color || x === 'inv' || x === 'bold')).map((x) => SGR[x]).filter(Boolean);

// The frame as terminal lines: runs of one style each, every line full width so it overwrites the last frame.
export function paint(f, { color = true } = {}) {
  return f.map((row) => {
    let out = '';
    let run = '';
    let style = null;
    const flush = () => { if (!run) return; const c = codes(style, color); out += c.length ? `\x1b[${c.join(';')}m${run}\x1b[0m` : run; run = ''; };
    for (const [ch, s] of row) { if (s !== style) { flush(); style = s; } run += ch; }
    flush();
    return out;
  });
}
export const textOf = (f) => f.map((row) => row.map(([ch]) => ch).join('').trimEnd());
