// Fast drop-in replacement for makefun-site 1.0.0.
// Written from the behaviour described in makefun-site's README and its
// reference code: same front matter, template dialect, Markdown subset,
// slug rule and build report, byte for byte -- but implemented with a
// hand-written single-pass Markdown renderer and templates compiled once
// to small functions instead of being walked as a node tree per render.
// No dependencies, no I/O, no clock, no randomness.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];
const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

const NEEDS_ESC = /[&<>"']/;

/** HTML-escape; fast path when nothing needs escaping. */
function esc(s) {
  if (!NEEDS_ESC.test(s)) return s;
  let out = '', start = 0;
  for (let i = 0; i < s.length; i++) {
    const cc = s.charCodeAt(i);
    let r;
    if (cc === 38) r = '&amp;';
    else if (cc === 60) r = '&lt;';
    else if (cc === 62) r = '&gt;';
    else if (cc === 34) r = '&quot;';
    else if (cc === 39) r = '&#39;';
    else continue;
    out += s.slice(start, i) + r;
    start = i + 1;
  }
  return out + s.slice(start);
}

/** Escape the slice s[lo..hi) of a string, without allocating the slice first. */
function escRange(s, lo, hi, out) {
  let start = lo;
  for (let i = lo; i < hi; i++) {
    const cc = s.charCodeAt(i);
    let r;
    if (cc === 38) r = '&amp;';
    else if (cc === 60) r = '&lt;';
    else if (cc === 62) r = '&gt;';
    else if (cc === 34) r = '&quot;';
    else if (cc === 39) r = '&#39;';
    else continue;
    out.push(s.slice(start, i), r);
    start = i + 1;
  }
  out.push(s.slice(start, hi));
}

const _slugCache = new Map();
function slugify(text) {
  const hit = _slugCache.get(text);
  if (hit !== undefined) return hit;
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '', gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  _slugCache.set(text, out);
  return out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = slug + '-' + n;
  taken.add(out);
  return out;
}

function longDate(date) {
  const y = date.slice(0, 4), m = Number(date.slice(5, 7)), d = Number(date.slice(8, 10));
  return d + ' ' + MONTHS[m - 1] + ' ' + y;
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

function trimLine(line) {
  let a = 0, b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return line.slice(a, b);
}

function wordsOf(text) {
  let n = 0, inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const ws = c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';
    if (ws) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function stringOf(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1)
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: 'key "' + key + '": ' + s.error } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0, mo = m ? Number(m[2]) : 0, d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo))
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t)))
        return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false }
        : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: 'unknown key "' + key + '"' };
  }
}

function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i] === '---') { close = i; break; }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlank(line) || line[0] === '#') continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: 'line ' + (i + 1) + ' is not "key: value"' };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.includes(key)) return { error: 'unknown key "' + key + '"' };
    if (Object.hasOwn(data, key)) return { error: 'key "' + key + '" is given twice' };
    if (raw === '') return { error: 'key "' + key + '" has no value' };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: lines.slice(close + 1).join('\n') };
}

// ---------------------------------------------------------------- Markdown
// Single-pass block scan over the body's lines, rendering straight into an
// output array; inline rendering works on string ranges so nested
// strong/em/link text never allocates substrings.

function isLangChar(c) {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
    c === '_' || c === '+' || c === '-';
}

function fenceLang(line) {
  // -1: not a fence open; otherwise the language ('' when none).
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return -1;
  let j = 3;
  while (j < line.length && isLangChar(line[j])) j++;
  for (let k = j; k < line.length; k++) {
    if (line[k] !== ' ' && line[k] !== '\t') return -1;
  }
  return line.slice(3, j);
}

function isFenceClose(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return false;
  for (let k = 3; k < line.length; k++) {
    if (line[k] !== ' ' && line[k] !== '\t') return false;
  }
  return true;
}

function headingOf(line) {
  // {depth, text} or null. 1-6 '#', a space/tab, non-empty text.
  let n = 0;
  while (n < line.length && line[n] === '#') n++;
  if (n === 0 || n > 6) return null;
  if (line[n] !== ' ' && line[n] !== '\t') return null;
  const text = trimLine(line.slice(n + 1));
  if (text === '') return null;
  return { depth: n, text };
}

function isHr(line) {
  const head = line.startsWith('---') ? 3 : line.startsWith('***') ? 3 : 0;
  if (!head) return false;
  for (let k = 3; k < line.length; k++) {
    if (line[k] !== ' ' && line[k] !== '\t') return false;
  }
  return true;
}

function endsParagraph(line) {
  return isBlank(line) || fenceLang(line) !== -1 ||
    (line[0] === '#' && headingOf(line) !== null) || isHr(line);
}

function listMatch(line, ordered) {
  if (!ordered) {
    if ((line[0] === '-' || line[0] === '*') && line[1] === ' ') return { start: 1, text: line.slice(2) };
    return null;
  }
  let n = 0;
  while (n < line.length && line[n] >= '0' && line[n] <= '9') n++;
  if (n === 0 || n > 9) return null;
  if (line[n] !== '.' || line[n + 1] !== ' ') return null;
  return { start: Number(line.slice(0, n)), text: line.slice(n + 2) };
}

function isContinued(line) {
  let sp = 0;
  while (sp < line.length && line[sp] === ' ') sp++;
  if (sp < 2 || sp >= line.length) return false;
  const c = line[sp];
  return c !== ' ' && c !== '\t';
}

function findUnescaped(s, what, from, hi) {
  const wlen = what.length;
  for (let j = from; j + wlen <= hi; j++) {
    if (s[j] === '\\' && j + 1 < hi && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from, hi) {
  for (let j = from; j < hi; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < hi && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

function hasWhitespace(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') return true;
  }
  return false;
}

/** Render s[lo..hi) inline into out; link(target) resolves a link href.
 *  Plain runs are flushed in one piece (escaped on the way out), so the
 *  common case -- a long stretch of ordinary text -- costs one push. */
function inlineRange(s, lo, hi, out, link) {
  let i = lo, run = lo;
  const flush = (to) => { if (run < to) escRange(s, run, to, out); };
  while (i < hi) {
    const cc = s.charCodeAt(i);
    if (cc === 92 && i + 1 < hi && ESCAPABLE.has(s[i + 1])) {
      flush(i); out.push(s[i + 1]); i += 2; run = i; continue;
    }
    if (cc === 96) {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < hi && j > i + 1) {
        flush(i);
        out.push('<code>');
        escRange(s, i + 1, j, out);
        out.push('</code>');
        i = j + 1; run = i;
      } else i++;
      continue;
    }
    if (cc === 42) {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2, hi);
        if (j > i + 2) {
          flush(i);
          out.push('<strong>');
          inlineRange(s, i + 2, j, out, link);
          out.push('</strong>');
          i = j + 2; run = i;
        } else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1, hi);
      if (j > i + 1) {
        flush(i);
        out.push('<em>');
        inlineRange(s, i + 1, j, out, link);
        out.push('</em>');
        i = j + 1; run = i;
      } else i++;
      continue;
    }
    if (cc === 91) {
      const k = findUnescaped(s, ']', i + 1, hi);
      let ok = false, m = -1, target = '';
      if (k !== -1 && k + 1 < hi && s[k + 1] === '(') {
        m = s.indexOf(')', k + 2);
        if (m !== -1 && m < hi) {
          target = s.slice(k + 2, m);
          ok = target !== '' && !hasWhitespace(target);
        }
      }
      if (ok) {
        flush(i);
        out.push('<a href="', esc(link(target)), '">');
        inlineRange(s, i + 1, k, out, link);
        out.push('</a>');
        i = m + 1; run = i;
      } else i++;
      continue;
    }
    i++;
  }
  flush(hi);
}

function inlineStr(s, link) {
  const out = [];
  inlineRange(s, 0, s.length, out, link);
  return out.join('');
}

function renderMarkdown(src, link) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const lang = fenceLang(line);
    if (lang !== -1) {
      const body = [];
      i++;
      while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ' class="language-' + esc(lang) + '"';
      const parts = ['<pre><code' + cls + '>'];
      for (const l of body) { parts.push(esc(l), '\n'); }
      parts.push('</code></pre>');
      blocks.push(parts.join(''));
      continue;
    }
    const hd = line[0] === '#' ? headingOf(line) : null;
    if (hd !== null) {
      const id = uniqueSlug(slugify(hd.text), ids);
      const html = inlineStr(hd.text, link);
      blocks.push('<h' + hd.depth + ' id="' + id + '">' + html + '</h' + hd.depth + '>');
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) { blocks.push('<hr>'); i++; continue; }
    if (line[0] === '>') {
      const body = [];
      while (i < n && lines[i][0] === '>') {
        let l = lines[i++];
        l = l.startsWith('> ') ? l.slice(2) : l.slice(1);
        body.push(trimLine(l));
      }
      const kept = body.filter((l) => l !== '');
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>'
        : '<blockquote>\n<p>' + inlineStr(kept.join('\n'), link) + '</p>\n</blockquote>');
      continue;
    }
    const bullet = listMatch(line, false);
    const ordered = bullet === null ? listMatch(line, true) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const first = isOrdered ? ordered : bullet;
      const items = [];
      while (i < n) {
        const m = listMatch(lines[i], isOrdered);
        if (m !== null) { items.push([trimLine(m.text)]); i++; }
        else if (isContinued(lines[i])) { items[items.length - 1].push(trimLine(lines[i])); i++; }
        else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && first.start !== 1 ? '<ol start="' + first.start + '">' : '<' + tag + '>';
      const parts = [open, '\n'];
      for (const parts0 of items) {
        parts.push('<li>', inlineStr(parts0.join('\n'), link), '</li>\n');
      }
      parts.push('</' + tag + '>');
      blocks.push(parts.join(''));
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    const html = inlineStr(text, link);
    if (excerpt === null) excerpt = html;
    blocks.push('<p>' + html + '</p>');
  }
  return { html: blocks.length === 0 ? '' : blocks.join('\n') + '\n', toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- Templates
// Parsed once into a small node tree (same grammar and error strings as
// makefun-site), then compiled once per template into a function that
// renders straight into a shared output array. Scopes are a stack of
// plain frames; the first name of a path is read from the nearest frame
// holding it, later names from own properties.

class TemplateError extends Error {}

const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError('template "' + name + '": a ' + (raw ? '{{{' : '{{') + ' is not closed');
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError('template "' + name + '": a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = T_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = T_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError('template "' + name + '": an else outside an if');
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if'))
          throw new TemplateError('template "' + name + '": an ' + tag + ' with no open ' + tag.slice(3));
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = T_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError('template "' + name + '": {% ' + tag + ' %} is not a tag');
    }
  }
  if (stack.length > 1) throw new TemplateError('template "' + name + '": a ' + stack[stack.length - 1].kind + ' is not closed');
  return root.body;
}

// --- template runtime helpers (shared by every compiled template) ---

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

const H = {
  esc,
  txt: textOf,
  tru: truthy,
  has: (v, k) => Object.hasOwn(v, k),
  get(sc, first) {
    for (let k = sc.length - 1; k >= 0; k--) {
      if (Object.hasOwn(sc[k], first)) return sc[k][first];
    }
    return undefined;
  },
};

/** Compile a parsed template body into (sc, d, out) => void. T is the map of compiled templates, for includes. */
function compileTemplate(nodes) {
  let code = '';
  let tmp = 0;
  const lookupCode = (path) => {
    const v = '_v' + (tmp++);
    let s = 'let ' + v + '=H.get(sc,' + JSON.stringify(path[0]) + ');';
    for (let k = 1; k < path.length; k++) {
      s += 'if(' + v + '!==null&&typeof ' + v + '==="object"&&H.has(' + v + ',' + JSON.stringify(path[k]) + '))' +
        v + '=' + v + '[' + JSON.stringify(path[k]) + '];else ' + v + '=undefined;';
    }
    return { code: s, v };
  };
  const gen = (list) => {
    for (const n of list) {
      if (n.kind === 'text') { code += 'out.push(' + JSON.stringify(n.text) + ');'; continue; }
      if (n.kind === 'var' || n.kind === 'raw') {
        const l = lookupCode(n.path);
        code += l.code;
        code += n.kind === 'var' ? 'out.push(H.esc(H.txt(' + l.v + ')));' : 'out.push(H.txt(' + l.v + '));';
        continue;
      }
      if (n.kind === 'if') {
        const l = lookupCode(n.path);
        code += l.code + 'if(' + (n.not ? '!' : '') + 'H.tru(' + l.v + ')){';
        gen(n.then);
        code += '}';
        if (n.else !== null) { code += 'else{'; gen(n.else); code += '}'; }
        continue;
      }
      if (n.kind === 'for') {
        const l = lookupCode(n.path);
        const x = '_x' + (tmp++), k = '_k' + (tmp++), f = '_f' + (tmp++);
        code += l.code + 'if(Array.isArray(' + l.v + ')){let ' + x + '=' + l.v + ';' +
          'for(let ' + k + '=0;' + k + '<' + x + '.length;' + k + '++){' +
          'let ' + f + '={};' + f + '[' + JSON.stringify(n.name) + ']=' + x + '[' + k + '];' +
          f + '.loop={index:' + k + '+1,first:' + k + '===0,last:' + k + '===' + x + '.length-1,length:' + x + '.length};' +
          'sc.push(' + f + ');';
        gen(n.body);
        code += 'sc.pop();}}';
        continue;
      }
      if (n.kind === 'include') {
        const t = '_t' + (tmp++);
        code += 'if(d<8){let ' + t + '=T[' + JSON.stringify(n.name) + '];if(' + t + ')' + t + '(sc,d+1,out);}';
        continue;
      }
    }
  };
  gen(nodes);
  return new Function('H', 'T', 'return function(sc,d,out){' + code + '}')(H, compiledTemplates);
}

// Compiled templates, keyed by their source: the same partial text recurs
// across a set's cases, and compiling it once serves them all. The compiled
// functions read their includes through `compiledTemplates` at render time,
// so a cached function stays valid in every case.
const tplCache = new Map();

// Filled as templates compile; includes resolve through it at render time.
const compiledTemplates = {};

// ---------------------------------------------------------------- the build

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function run(input) {
  const base = input.site.base_url.replace(/\/+$/, '');
  const report = [];
  // Templates, parsed and compiled once, in code-unit order of name.
  for (const k of Object.keys(compiledTemplates)) delete compiledTemplates[k];
  for (const name of Object.keys(input.templates).sort()) {
    const src = input.templates[name];
    let fn = tplCache.get(src);
    if (fn === undefined) {
      try {
        fn = compileTemplate(parseTemplate(name, src));
      } catch (err) {
        if (!(err instanceof TemplateError)) throw err;
        report.push(err.message);
        continue;
      }
      tplCache.set(src, fn);
    }
    compiledTemplates[name] = fn;
  }

  // Sources in code-unit order of path; .md is a source, the rest static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const c = f.content;
      sources.push({ path: f.path, text: c.indexOf('\r') < 0 ? c : c.replace(/\r\n?/g, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // Front matter and the drop checks, in order, first failure reported.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push('refused ' + s.path + ': ' + fm.error); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(d + '/')) { own = d; break; }
    }
    if (own !== undefined) { report.push('refused ' + s.path + ': ' + own + '/ is the generator\'s own'); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push('refused ' + s.path + ': a post needs a date'); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (compiledTemplates[layout] === undefined) {
      report.push('refused ' + s.path + ': layout "' + layout + '" is no template that parses');
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) { report.push('draft ' + s.path); continue; }
    kept.push(s);
  }

  // Permalinks: slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.outDir = dir === '' ? s.slug : dir + '/' + s.slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  // Markdown, with links resolved to pages and static files. Link
  // resolutions repeat a lot across sources, so they are cached per run
  // by (source directory, target); a cached miss still reports the
  // broken link for the source that uses it.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const linkCache = new Map();
  const hasScheme = (t) => {
    const c0 = t.charCodeAt(0);
    if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
    for (let k = 1; k < t.length; k++) {
      const cc = t.charCodeAt(k);
      if (cc === 58) return true;
      if (!((cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) ||
            cc === 43 || cc === 45 || cc === 46)) return false;
    }
    return false;
  };
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (hasScheme(target) || target[0] === '/' || target[0] === '#') return target;
      const key = dir + ' ' + target;
      const hit = linkCache.get(key);
      if (hit !== undefined) {
        if (hit === false) broken.add('broken-link ' + s.path + ' -> ' + target);
        return hit === false ? target : hit;
      }
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      let href = false;
      if (path !== null && bySource.has(path)) href = bySource.get(path).url + frag;
      else if (path !== null && staticPaths.has(path)) href = base + '/' + path + frag;
      linkCache.set(key, href);
      if (href === false) broken.add('broken-link ' + s.path + ' -> ' + target);
      return href === false ? target : href;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = wordsOf(s.body);
  }

  // Collections: posts newest first, equal dates by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by slug, first spelling kept, ordered by count then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const sl = slugify(name);
      if (!seen.has(sl)) { seen.add(sl); out.push(name); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards and pages as templates read them.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const linkOf = (s) => s === null ? null : {
    title: s.data.title, url: s.url, date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  };
  const pageOf = (s) => {
    const c = cardOf(s);
    c.slug = s.slug;
    c.content = s.html;
    c.toc = s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html }));
    c.newer = linkOf(s.newer ?? null);
    c.older = linkOf(s.older ?? null);
    c.is_post = s.post;
    return c;
  };

  // Layouts.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const fn = compiledTemplates[name];
    if (fn === undefined) return null;
    const sc = [{ site, tags: allTags, recent, ...vars }];
    const out = [];
    fn(sc, 0, out);
    return out.join('');
  };
  for (const s of kept) output[s.outDir + '/index.html'] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: {
        number: k, total: pages, url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push('shadowed ' + f.path + ': a built page has its path');
    else output[f.path] = f.content;
  }

  // The report.
  const lines = [...report, ...broken].sort();
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push('built ' + pageCount + ' pages, ' + posts.length + ' posts, ' + tags.length +
    ' tags and ' + statics.length + ' static files');
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}
