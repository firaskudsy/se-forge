// The keys a terminal sends (decision 153), by name: xterm's, the VT220's and the Linux console's spellings of the
// function and arrow keys, so forge ui reads the same keys in Terminal, iTerm, tmux, over ssh and on a Linux console.
const SEQ = {
  '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left', '\x1bOA': 'up', '\x1bOB': 'down', '\x1bOC': 'right', '\x1bOD': 'left',
  '\x1b[5~': 'pageup', '\x1b[6~': 'pagedown', '\x1b[H': 'home', '\x1b[F': 'end', '\x1bOH': 'home', '\x1bOF': 'end', '\x1b[1~': 'home', '\x1b[4~': 'end', '\x1b[7~': 'home', '\x1b[8~': 'end',
  '\x1b[3~': 'delete', '\x1b[Z': 'backtab',
  '\x1bOP': 'f1', '\x1bOQ': 'f2', '\x1bOR': 'f3', '\x1bOS': 'f4', '\x1b[11~': 'f1', '\x1b[12~': 'f2', '\x1b[13~': 'f3', '\x1b[14~': 'f4',
  '\x1b[[A': 'f1', '\x1b[[B': 'f2', '\x1b[[C': 'f3', '\x1b[[D': 'f4', '\x1b[[E': 'f5',
  '\x1b[15~': 'f5', '\x1b[17~': 'f6', '\x1b[18~': 'f7', '\x1b[19~': 'f8', '\x1b[20~': 'f9', '\x1b[21~': 'f10',
  '\r': 'enter', '\n': 'enter', '\t': 'tab', '\x7f': 'backspace', '\b': 'backspace', '\x03': 'ctrl-c', '\x15': 'ctrl-u',
};
const LONGEST = Math.max(...Object.keys(SEQ).map((k) => k.length));

// One chunk of input as keys: names for the special ones, the character itself for the rest. A lone ESC is 'escape';
// an escape sequence this does not know is dropped rather than read as letters.
export function decode(chunk) {
  const s = String(chunk);
  const out = [];
  for (let i = 0; i < s.length;) {
    let hit = null;
    for (let n = Math.min(LONGEST, s.length - i); n > 0 && !hit; n--) if (SEQ[s.slice(i, i + n)]) hit = s.slice(i, i + n);
    if (hit) { out.push(SEQ[hit]); i += hit.length; continue; }
    if (s[i] === '\x1b') {
      const m = /^\x1b(\[[\d;]*[~A-Za-z]|O[A-Za-z]|\[\[[A-E])/.exec(s.slice(i));
      if (m) { i += m[0].length; continue; }
      out.push('escape');
      i++;
      continue;
    }
    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    if (cp >= 32) out.push(ch);
    i += ch.length;
  }
  return out;
}
