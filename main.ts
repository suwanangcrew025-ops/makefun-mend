// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON tool calls), finds the lines each edit names at the first of three
// matching tiers, and writes every change or none, as SPEC.md specifies.
// Node 22, standard library alone; run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its line break, its lines, and whether it ends with one. */
interface FileText {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** One line of an old block O or a new block N. `ctx` lines come from the file itself. */
interface BlockLine {
  text: string;
  ctx: boolean;
  oi: number;
}

/** A line the way SPEC.md section 5 reads it at a tier. */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where O occurs in the file's lines at a tier. */
function occurrences(fileLines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  const want = o.map((l) => normLine(l, tier));
  for (let i = 0; i + o.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(fileLines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with every occurrence there. */
function firstTier(fileLines: string[], o: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const pos = occurrences(fileLines, o, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** The N lines that replace O at `pos`: context lines as the file has them, the rest re-indented at tier 2. */
function buildNew(o: BlockLine[], n: BlockLine[], fileLines: string[], pos: number, tier: number): string[] {
  const out: string[] = [];
  let p = '';
  let f = '';
  if (tier === 2 && o.length > 0) {
    p = leadingWs(o[0]!.text);
    f = leadingWs(fileLines[pos]!);
  }
  for (const e of n) {
    if (e.ctx) {
      out.push(fileLines[pos + e.oi]!);
      continue;
    }
    let t = e.text;
    if (tier === 2 && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return out;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 6: unified diffs                                            */
/* ------------------------------------------------------------------ */

type BodyKind = 'ctx' | 'old' | 'new' | 'mark';
interface BodyLine {
  kind: BodyKind;
  text: string;
}

interface Hunk {
  a: number;
  o: BlockLine[];
  n: BlockLine[];
  plus: string[];
  /** a `\` line follows the hunk's last context or `+` line */
  noFinal: boolean;
  /** a `\` line follows the hunk's last `+` line */
  plusNoFinal: boolean;
}

interface UniSection {
  oldRaw: string | undefined;
  newRaw: string | undefined;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

/** The O and N lines a hunk or chunk body names, in body order. */
function entriesOf(body: BodyLine[]): { o: BlockLine[]; n: BlockLine[] } {
  const o: BlockLine[] = [];
  const n: BlockLine[] = [];
  let oi = 0;
  for (const b of body) {
    if (b.kind === 'ctx') {
      o.push({ text: b.text, ctx: true, oi });
      n.push({ text: b.text, ctx: true, oi });
      oi++;
    } else if (b.kind === 'old') {
      o.push({ text: b.text, ctx: false, oi });
      oi++;
    } else if (b.kind === 'new') {
      n.push({ text: b.text, ctx: false, oi: -1 });
    }
  }
  return { o, n };
}

/** Whether a `\` line follows the body's last line of the named kinds. */
function slashAfter(body: BodyLine[], kinds: BodyKind[]): boolean {
  for (let i = body.length - 1; i >= 0; i--) {
    if (kinds.includes(body[i]!.kind)) return body[i + 1] !== undefined && body[i + 1]!.kind === 'mark';
  }
  return false;
}

/** The path a `--- ` or `+++ ` line names: after the four characters, up to the first tab, trimmed, without a leading `a/` or `b/`. */
function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  let p = (tab >= 0 ? rest.slice(0, tab) : rest).trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let hasPair = false;
  let hasHunk = false;
  const flush = (): void => {
    if (cur) sections.push(cur);
    cur = null;
    hasPair = false;
    hasHunk = false;
  };
  const hunkRe = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  const diffRe = /^diff --git a\/(\S+) b\/(\S+)\s*$/;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = diffRe.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      flush();
      cur = { oldRaw: m[1], newRaw: m[2], newFile: false, delFile: false, hunks: [] };
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (!cur) throw new Exit2(`error: parse ${i + 1}`);
      const m = hunkRe.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const body: BodyLine[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l2 = lines[j]!;
        if (l2.startsWith('diff --git ')) break;
        if (l2.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l2 === '') body.push({ kind: 'ctx', text: '' });
        else if (l2.startsWith(' ')) body.push({ kind: 'ctx', text: l2.slice(1) });
        else if (l2.startsWith('-')) body.push({ kind: 'old', text: l2.slice(1) });
        else if (l2.startsWith('+')) body.push({ kind: 'new', text: l2.slice(1) });
        else if (l2.startsWith('\\')) body.push({ kind: 'mark', text: l2 });
        else break;
        j++;
      }
      while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.text === '') body.pop();
      const { o, n } = entriesOf(body);
      cur.hunks.push({
        a: Number(m[1]),
        o,
        n,
        plus: body.filter((b) => b.kind === 'new').map((b) => b.text),
        noFinal: slashAfter(body, ['ctx', 'new']),
        plusNoFinal: slashAfter(body, ['new']),
      });
      hasHunk = true;
      i = j;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur && !hasHunk && !hasPair) {
        cur.oldRaw = headerPath(line);
        cur.newRaw = headerPath(lines[i + 1]!);
        hasPair = true;
      } else {
        flush();
        cur = { oldRaw: headerPath(line), newRaw: headerPath(lines[i + 1]!), newFile: false, delFile: false, hunks: [] };
        hasPair = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur && !hasHunk) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (cur && !hasHunk) {
      if (line.startsWith('rename from ') && !hasPair) cur.oldRaw = line.slice(12).trim();
      else if (line.startsWith('rename to ') && !hasPair) cur.newRaw = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
    }
    i++;
  }
  flush();
  return sections;
}

/** A section's hunks applied in order to a file's text. */
function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(before);
  const lines = f.lines;
  let final = f.final;
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const atEnd = h.a + d >= lines.length;
      const idx = Math.max(0, Math.min(h.a + d, lines.length));
      lines.splice(idx, 0, ...h.n.map((e) => e.text));
      if (atEnd) final = !h.noFinal;
      d += h.n.length;
      continue;
    }
    const found = firstTier(lines, h.o.map((e) => e.text), strict);
    if (!found) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.pos[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.pos) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const atEnd = best + h.o.length === lines.length;
    const repl = buildNew(h.o, h.n, lines, best, found.tier);
    lines.splice(best, h.o.length, ...repl);
    if (atEnd) final = !h.noFinal;
    d += h.n.length - h.o.length;
  }
  return joinFile(lines, f.br, final);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => {
    const oldRaw = sec.oldRaw ?? sec.newRaw;
    const newRaw = sec.newRaw ?? sec.oldRaw;
    const oldP = oldRaw === undefined || oldRaw === '/dev/null' ? null : oldRaw;
    const newP = newRaw === undefined || newRaw === '/dev/null' ? null : newRaw;
    const isCreate = sec.newFile || oldP === null;
    const isDelete = !isCreate && (sec.delFile || newP === null);
    const isMove = !isCreate && !isDelete && oldP !== newP;
    if (isCreate) {
      return (tree: Tree) => {
        const p = newP ?? '';
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const plus: string[] = [];
        for (const h of sec.hunks) plus.push(...h.plus);
        let noFinal = false;
        for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
          if (sec.hunks[hi]!.plus.length > 0) {
            noFinal = sec.hunks[hi]!.plusNoFinal;
            break;
          }
        }
        tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noFinal ? '' : '\n'));
      };
    }
    if (isDelete) {
      return (tree: Tree) => {
        const p = oldP ?? '';
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      };
    }
    return (tree: Tree) => {
      const p = oldP ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (isMove && !safe(newP ?? '')) throw new Fail('unsafe', newP ?? '');
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      if (isMove && tree.get(newP!) !== null) throw new Fail('exists', newP!);
      const out = applyHunks(before, sec.hunks, strict, p);
      if (isMove) {
        tree.now.set(newP!, out);
        tree.now.set(p, null);
        tree.moves.push({ old: p, new: newP! });
      } else {
        tree.now.set(p, out);
      }
    };
  });
}

/* ------------------------------------------------------------------ */
/* Section 7: SEARCH/REPLACE blocks                                    */
/* ------------------------------------------------------------------ */

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SrBlock[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    let end = -1;
    if (sep >= 0) {
      for (let j = sep + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          end = j;
          break;
        }
      }
    }
    if (sep < 0 || end < 0) throw new Exit2(`error: parse ${searchLine}`);
    blocks.push({ path, oldLines: lines.slice(i + 1, sep), newLines: lines.slice(sep + 1, end) });
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => {
    return (tree: Tree) => {
      if (!safe(b.path)) throw new Fail('unsafe', b.path);
      if (b.oldLines.length === 0) {
        if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
        tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(b.path);
      if (before === null) throw new Fail('missing', b.path);
      const f = splitFile(before);
      const found = firstTier(f.lines, b.oldLines, strict);
      if (!found) throw new Fail('no-match', b.path);
      if (found.pos.length > 1) throw new Fail('ambiguous', b.path);
      const pos = found.pos[0]!;
      const o: BlockLine[] = b.oldLines.map((text, oi) => ({ text, ctx: false, oi }));
      const n: BlockLine[] = b.newLines.map((text) => ({ text, ctx: false, oi: -1 }));
      const repl = buildNew(o, n, f.lines, pos, found.tier);
      f.lines.splice(pos, b.oldLines.length, ...repl);
      tree.now.set(b.path, joinFile(f.lines, f.br, f.final));
    };
  });
}

/* ------------------------------------------------------------------ */
/* Section 8: V4A patches                                              */
/* ------------------------------------------------------------------ */

interface Chunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
  o: BlockLine[];
  n: BlockLine[];
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lineNo: number;
  raw: { text: string; no: number }[];
}

/** The first tier with an occurrence of O at or after `from`; an end-of-file chunk takes only one ending at the last line. */
function firstTierFrom(lines: string[], o: string[], from: number, strict: boolean, eof: boolean): { tier: number; pos: number } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const occ = occurrences(lines, o, t).filter((p) => p >= from);
    const good = eof ? occ.filter((p) => p + o.length === lines.length) : occ;
    if (good.length > 0) return { tier: t, pos: good[0]! };
  }
  return null;
}

/** The first line at or after `from` equal to the anchor, at the first tier where one is. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    for (let j = from; j < lines.length; j++) {
      if (normLine(lines[j]!, t) === normLine(anchor, t)) return j;
    }
  }
  return -1;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let cur: V4aSection | null = null;
  for (let i = first + 1; i < last; i++) {
    const l = lines[i]!;
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) {
      if (cur) sections.push(cur);
      const kind = l.startsWith('*** Add') ? 'add' : l.startsWith('*** Delete') ? 'delete' : 'update';
      cur = { kind, path: l.slice(kind === 'add' ? 14 : 17).trim(), lineNo: i + 1, raw: [] };
    } else if (blank(l)) {
      if (cur) cur.raw.push({ text: l, no: i + 1 });
    } else {
      if (!cur) throw new Exit2(`error: parse ${i + 1}`);
      cur.raw.push({ text: l, no: i + 1 });
    }
  }
  if (cur) sections.push(cur);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => {
    // Blank lines at the end of a section are not part of it.
    while (sec.raw.length > 0 && blank(sec.raw[sec.raw.length - 1]!.text)) sec.raw.pop();
    if (sec.kind === 'add') {
      const content: string[] = [];
      for (const r of sec.raw) {
        if (r.text === '') content.push('');
        else if (r.text.startsWith('+')) content.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.no}`);
      }
      return (tree: Tree) => {
        if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
        if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
        tree.now.set(sec.path, content.length === 0 ? '' : content.join('\n') + '\n');
      };
    }
    if (sec.kind === 'delete') {
      for (const r of sec.raw) {
        if (!blank(r.text)) throw new Exit2(`error: parse ${r.no}`);
      }
      return (tree: Tree) => {
        if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
        if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
        tree.now.set(sec.path, null);
      };
    }
    // update: an optional `*** Move to:` first line, then chunks.
    let moveTo: string | null = null;
    let idx = 0;
    if (sec.raw[0] !== undefined && sec.raw[0]!.text.startsWith('*** Move to: ')) {
      moveTo = sec.raw[0]!.text.slice(13).trim();
      idx = 1;
    }
    const chunks: Chunk[] = [];
    let chunk: Chunk | null = null;
    let firstChunk = true;
    for (; idx < sec.raw.length; idx++) {
      const r = sec.raw[idx]!;
      const text = r.text;
      if (text.startsWith('@@')) {
        chunk = { anchor: text.slice(2).trim() === '' ? null : text.slice(2).trim(), eof: false, body: [], o: [], n: [] };
        chunks.push(chunk);
        firstChunk = false;
      } else if (text === '*** End of File') {
        if (!chunk) throw new Exit2(`error: parse ${r.no}`);
        chunk.eof = true;
        chunk = null;
        firstChunk = false;
      } else if (text.startsWith('*** Move to: ')) {
        throw new Exit2(`error: parse ${r.no}`);
      } else if (text === '' || text.startsWith(' ') || text.startsWith('-') || text.startsWith('+')) {
        if (!chunk) {
          if (!firstChunk) throw new Exit2(`error: parse ${r.no}`);
          chunk = { anchor: null, eof: false, body: [], o: [], n: [] };
          chunks.push(chunk);
          firstChunk = false;
        }
        chunk.body.push(
          text === ''
            ? { kind: 'ctx', text: '' }
            : text.startsWith(' ')
              ? { kind: 'ctx', text: text.slice(1) }
              : text.startsWith('-')
                ? { kind: 'old', text: text.slice(1) }
                : { kind: 'new', text: text.slice(1) },
        );
      } else {
        throw new Exit2(`error: parse ${r.no}`);
      }
    }
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sec.lineNo}`);
    for (const ch of chunks) {
      const { o, n } = entriesOf(ch.body);
      ch.o = o;
      ch.n = n;
    }
    return (tree: Tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
      const before = tree.get(sec.path);
      if (before === null) throw new Fail('missing', sec.path);
      if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      const f = splitFile(before);
      const lines = f.lines;
      let cursor = 0;
      for (const ch of chunks) {
        if (ch.anchor !== null) {
          const at = findAnchor(lines, ch.anchor, cursor, strict);
          if (at < 0) throw new Fail('no-match', sec.path);
          cursor = at + 1;
        }
        if (ch.o.length === 0) {
          const at = ch.eof ? lines.length : cursor;
          const ins = ch.n.map((e) => e.text);
          lines.splice(at, 0, ...ins);
          cursor = at + ins.length;
          continue;
        }
        const found = firstTierFrom(lines, ch.o.map((e) => e.text), cursor, strict, ch.eof);
        if (!found) throw new Fail('no-match', sec.path);
        const repl = buildNew(ch.o, ch.n, lines, found.pos, found.tier);
        lines.splice(found.pos, ch.o.length, ...repl);
        cursor = found.pos + repl.length;
      }
      const out = joinFile(lines, f.br, f.final);
      if (moveTo !== null) {
        tree.now.set(moveTo, out);
        tree.now.set(sec.path, null);
        tree.moves.push({ old: sec.path, new: moveTo });
      } else {
        tree.now.set(sec.path, out);
      }
    };
  });
}

/* ------------------------------------------------------------------ */
/* Section 1, 2 and 10: the command line, the output and the write     */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const m of tree.moves) {
    const oldWas = tree.original(m.old);
    const oldNow = tree.now.get(m.old);
    const newWas = tree.original(m.new);
    const newNow = tree.now.get(m.new);
    if (oldWas !== null && oldNow === null && newWas === null && newNow !== null) {
      const kept = rows.filter((r) => r.line !== `D ${m.old}` && r.line !== `A ${m.new}`);
      rows.length = 0;
      rows.push(...kept, { key: m.new, line: `R ${m.old} -> ${m.new}` });
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
