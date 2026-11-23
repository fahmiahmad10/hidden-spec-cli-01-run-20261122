// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// Implements SPEC.md sections 1-10: the command line, output and exit codes, safe paths, format detection,
// three-tier line matching, unified diffs, SEARCH/REPLACE blocks, V4A patches, JSON edits, and the
// all-or-nothing write. In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this
// file hands over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

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

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

/** Moves recorded by successful move edits, for the `R old -> new` output lines. */
let moves: Array<{ old: string; nw: string }> = [];

/** A file's lines, its line break and whether it ends with one (SPEC.md section 3). */
class FileDoc {
  br: string = '\n';
  lines: string[] = [];
  final: boolean = false;
  static parse(text: string): FileDoc {
    const d = new FileDoc();
    if (text === '') return d;
    const nl = text.indexOf('\n');
    d.br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
    const parts = text.split(d.br);
    if (text.endsWith(d.br)) {
      parts.pop();
      d.final = true;
    }
    d.lines = parts;
    return d;
  }
  toText(): string {
    if (this.lines.length === 0) return '';
    return this.lines.join(this.br) + (this.final ? this.br : '');
  }
}

function leadingWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** A line's key at a matching tier (SPEC.md section 5). */
function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where O occurs in lines at the tier. */
function occurrences(lines: string[], O: string[], tier: number): number[] {
  const ok = O.map((l) => tierKey(l, tier));
  const out: number[] = [];
  for (let i = 0; i + O.length <= lines.length; i++) {
    let m = true;
    for (let j = 0; j < O.length; j++) {
      if (tierKey(lines[i + j]!, tier) !== ok[j]) {
        m = false;
        break;
      }
    }
    if (m) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs, with its positions. */
function findFirstTier(lines: string[], O: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, O, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

function findFirstTierFrom(lines: string[], O: string[], from: number, strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, O, t).filter((p) => p >= from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** First line at or after cursor equal to the anchor, at the first tier where one is. */
function findAnchor(lines: string[], anchor: string, cursor: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const ak = tierKey(anchor, t);
    for (let p = cursor; p < lines.length; p++) {
      if (tierKey(lines[p]!, t) === ak) return p;
    }
  }
  return -1;
}

/** One body line of a hunk or chunk: context, old, new, or a backslash line. */
type BodyItem = { kind: 'ctx' | 'del' | 'add' | 'bs'; text: string };

function bodyItem(l: string): BodyItem {
  if (l === '') return { kind: 'ctx', text: '' };
  if (l[0] === ' ') return { kind: 'ctx', text: l.slice(1) };
  if (l[0] === '-') return { kind: 'del', text: l.slice(1) };
  if (l[0] === '+') return { kind: 'add', text: l.slice(1) };
  return { kind: 'bs', text: l.slice(1) };
}

/** Split a body into its old lines O and its new lines (context items carry their O index). */
function analyzeBody(items: BodyItem[]): {
  O: string[];
  nItems: Array<{ ctx: boolean; oIndex: number; text: string }>;
  noNL: boolean;
} {
  const O: string[] = [];
  const nItems: Array<{ ctx: boolean; oIndex: number; text: string }> = [];
  let oIdx = 0;
  for (const it of items) {
    if (it.kind === 'ctx') {
      O.push(it.text);
      nItems.push({ ctx: true, oIndex: oIdx, text: '' });
      oIdx++;
    } else if (it.kind === 'del') {
      O.push(it.text);
      oIdx++;
    } else if (it.kind === 'add') {
      nItems.push({ ctx: false, oIndex: -1, text: it.text });
    }
  }
  let noNL = false;
  for (let k = items.length - 1; k >= 0; k--) {
    const it = items[k]!;
    if (it.kind === 'ctx' || it.kind === 'add') {
      noNL = items[k + 1]?.kind === 'bs';
      break;
    }
  }
  return { O, nItems, noNL };
}

/** The lines that replace a match at position i: context lines are the file's own, new lines re-indented at tier 2. */
function replacementLines(
  doc: FileDoc,
  i: number,
  O: string[],
  nItems: Array<{ ctx: boolean; oIndex: number; text: string }>,
  tier: number,
): string[] {
  const F = leadingWS(doc.lines[i] ?? '');
  const P = leadingWS(O[0] ?? '');
  const out: string[] = [];
  for (const it of nItems) {
    if (it.ctx) {
      out.push(doc.lines[i + it.oIndex]!);
      continue;
    }
    let t = it.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(P)) t = F + t.slice(P.length);
    out.push(t);
  }
  return out;
}

interface Hunk {
  a: number;
  items: BodyItem[];
  O: string[];
  nItems: Array<{ ctx: boolean; oIndex: number; text: string }>;
  noNL: boolean;
}

function makeHunk(a: number, items: BodyItem[]): Hunk {
  const { O, nItems, noNL } = analyzeBody(items);
  return { a, items, O, nItems, noNL };
}

/** Apply a section's hunks in order to a file's lines (SPEC.md section 6). */
function applyHunks(doc: FileDoc, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    if (h.O.length === 0) {
      const at = Math.min(h.a + d, doc.lines.length);
      const texts = h.nItems.map((it) => it.text);
      const atEnd = at === doc.lines.length;
      doc.lines.splice(at, 0, ...texts);
      if (atEnd) doc.final = !h.noNL;
      d += texts.length;
      continue;
    }
    const found = findFirstTier(doc.lines, h.O, strict);
    if (!found) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const i = best;
    const endsAtEnd = i + h.O.length === doc.lines.length;
    const rep = replacementLines(doc, i, h.O, h.nItems, found.tier);
    doc.lines.splice(i, h.O.length, ...rep);
    if (endsAtEnd) doc.final = !h.noNL;
    d += rep.length - h.O.length;
  }
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

/** A unified diff path: text after `--- `/`+++ `, up to the first tab, spaces removed, a/ or b/ stripped. */
function parseUnifiedPath(s: string): string | null {
  let t = s.split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/')) t = t.slice(2);
  else if (t.startsWith('b/')) t = t.slice(2);
  return t;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  hasHeaderPaths: boolean;
  diffGitOld: string | null;
  diffGitNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  isCreation: boolean;
  isDeletion: boolean;
  inHeader: boolean;
  hunks: Hunk[];
}

function newSection(): Section {
  return {
    oldPath: null,
    newPath: null,
    hasHeaderPaths: false,
    diffGitOld: null,
    diffGitNew: null,
    renameFrom: null,
    renameTo: null,
    isCreation: false,
    isDeletion: false,
    inHeader: true,
    hunks: [],
  };
}

function sectionToEdit(sec: Section, strict: boolean): Edit {
  const oldP = sec.hasHeaderPaths ? sec.oldPath : (sec.renameFrom ?? sec.diffGitOld ?? null);
  const newP = sec.hasHeaderPaths ? sec.newPath : (sec.renameTo ?? sec.diffGitNew ?? null);
  const isCreation = sec.isCreation || oldP === null;
  const isDeletion = !isCreation && (sec.isDeletion || newP === null);
  if (isCreation) {
    const np = newP as string;
    return (tree) => {
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const out: string[] = [];
      for (const h of sec.hunks) for (const it of h.items) if (it.kind === 'add') out.push(it.text);
      let noNL = false;
      outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const items = sec.hunks[hi]!.items;
        for (let k = items.length - 1; k >= 0; k--) {
          if (items[k]!.kind === 'add') {
            noNL = items[k + 1]?.kind === 'bs';
            break outer;
          }
        }
      }
      tree.now.set(np, out.length === 0 ? '' : out.join('\n') + (noNL ? '' : '\n'));
    };
  }
  if (isDeletion) {
    const op = oldP as string;
    return (tree) => {
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
    };
  }
  if (oldP !== newP) {
    const op = oldP as string;
    const np = newP as string;
    return (tree) => {
      if (!safe(op)) throw new Fail('unsafe', op);
      if (!safe(np)) throw new Fail('unsafe', np);
      const cur = tree.get(op);
      if (cur === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const doc = FileDoc.parse(cur);
      applyHunks(doc, sec.hunks, strict, op);
      tree.now.set(op, null);
      tree.now.set(np, doc.toText());
      moves.push({ old: op, nw: np });
    };
  }
  const p = oldP as string;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    const doc = FileDoc.parse(cur);
    applyHunks(doc, sec.hunks, strict, p);
    tree.now.set(p, doc.toText());
  };
}

/** Unified diffs (SPEC.md section 6). */
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let sec: Section | null = null;
  const flush = () => {
    if (sec) {
      edits.push(sectionToEdit(sec, strict));
      sec = null;
    }
  };
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    const ln = i + 1;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${ln}`);
      flush();
      sec = newSection();
      sec.diffGitOld = m[1]!;
      sec.diffGitNew = m[2]!;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (!sec) throw new Exit2(`error: parse ${ln}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) throw new Exit2(`error: parse ${ln}`);
      const a = parseInt(m[1]!, 10);
      i++;
      const items: BodyItem[] = [];
      while (i < n) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          items.push(bodyItem(bl));
          i++;
        } else break;
      }
      while (items.length > 0) {
        const last = items[items.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') items.pop();
        else break;
      }
      sec.hunks.push(makeHunk(a, items));
      sec.inHeader = false;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (sec && sec.inHeader && !sec.hasHeaderPaths) {
        sec.oldPath = parseUnifiedPath(line.slice(4));
        sec.newPath = parseUnifiedPath(lines[i + 1]!.slice(4));
        sec.hasHeaderPaths = true;
        i += 2;
        continue;
      }
      flush();
      sec = newSection();
      sec.oldPath = parseUnifiedPath(line.slice(4));
      sec.newPath = parseUnifiedPath(lines[i + 1]!.slice(4));
      sec.hasHeaderPaths = true;
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && sec && sec.inHeader) {
      throw new Exit2(`error: parse ${ln + 1}`);
    }
    if (sec && sec.inHeader) {
      if (line.startsWith('rename from ')) sec.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) sec.renameTo = line.slice('rename to '.length).trim();
      else if (line === 'new file mode' || line.startsWith('new file mode ')) sec.isCreation = true;
      else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) sec.isDeletion = true;
    }
    i++;
  }
  flush();
  return edits;
}

/** SEARCH/REPLACE blocks (SPEC.md section 7). */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eqIdx = -1;
    for (let j = searchIdx + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eqIdx = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eqIdx === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let repIdx = -1;
    for (let j = eqIdx + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        repIdx = j;
        break;
      }
    }
    if (repIdx === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eqIdx);
    const newLines = lines.slice(eqIdx + 1, repIdx);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      const doc = FileDoc.parse(cur);
      const found = findFirstTier(doc.lines, oldLines, strict);
      if (!found) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const at = found.occ[0]!;
      const nItems = newLines.map((t) => ({ ctx: false, oIndex: -1, text: t }));
      const rep = replacementLines(doc, at, oldLines, nItems, found.tier);
      doc.lines.splice(at, oldLines.length, ...rep);
      tree.now.set(p, doc.toText());
    });
    prevPath = path;
    prevEnd = repIdx + 1;
    i = repIdx + 1;
  }
  return edits;
}

interface V4AChunk {
  anchor: string | null;
  items: BodyItem[];
  eof: boolean;
}

function parseV4AChunks(raw: Array<{ t: string; ln: number }>): V4AChunk[] {
  const chunks: V4AChunk[] = [];
  let cur: V4AChunk | null = null;
  const flush = () => {
    if (cur) {
      chunks.push(cur);
      cur = null;
    }
  };
  for (const { t, ln } of raw) {
    if (t.startsWith('@@')) {
      flush();
      const anchorText = t.slice(2).trim();
      cur = { anchor: anchorText === '' ? null : anchorText, items: [], eof: false };
      continue;
    }
    if (t.trimEnd() === '*** End of File') {
      if (!cur) cur = { anchor: null, items: [], eof: false };
      cur.eof = true;
      flush();
      continue;
    }
    if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
      if (!cur) cur = { anchor: null, items: [], eof: false };
      cur.items.push(bodyItem(t));
      continue;
    }
    throw new Exit2(`error: parse ${ln}`);
  }
  flush();
  return chunks;
}

/** V4A patches (SPEC.md section 8). */
function parseV4A(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = n - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const p = line.slice('*** Add File: '.length).trim();
      i++;
      const secLines: string[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ') || l.trim() === '*** End Patch') break;
        if (l !== '' && !l.startsWith('+')) throw new Exit2(`error: parse ${i + 1}`);
        secLines.push(l);
        i++;
      }
      while (secLines.length > 0 && secLines[secLines.length - 1] === '') secLines.pop();
      const fileLines = secLines.map((l) => (l === '' ? '' : l.slice(1)));
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const p = line.slice('*** Delete File: '.length).trim();
      i++;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const p = line.slice('*** Update File: '.length).trim();
      const headerLine = i + 1;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const raw: Array<{ t: string; ln: number }> = [];
      while (i < last) {
        const l = lines[i]!;
        if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ') || l.trim() === '*** End Patch') break;
        raw.push({ t: l, ln: i + 1 });
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.t)) raw.pop();
      const chunks = parseV4AChunks(raw);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
      const mt = moveTo;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (mt !== null && !safe(mt)) throw new Fail('unsafe', mt);
        const cur = tree.get(p);
        if (cur === null) throw new Fail('missing', p);
        if (mt !== null && tree.get(mt) !== null) throw new Fail('exists', mt);
        const doc = FileDoc.parse(cur);
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null) {
            const pos = findAnchor(doc.lines, ch.anchor, cursor, strict);
            if (pos === -1) throw new Fail('no-match', p);
            cursor = pos + 1;
          }
          const { O, nItems } = analyzeBody(ch.items);
          if (O.length === 0) {
            const at = ch.eof ? doc.lines.length : cursor;
            const texts = nItems.map((it) => it.text);
            doc.lines.splice(at, 0, ...texts);
            cursor = at + texts.length;
          } else {
            const found = findFirstTierFrom(doc.lines, O, cursor, strict);
            if (!found) throw new Fail('no-match', p);
            let at = found.occ[0]!;
            if (ch.eof) {
              const eofOcc = found.occ.find((q) => q + O.length === doc.lines.length);
              if (eofOcc === undefined) throw new Fail('no-match', p);
              at = eofOcc;
            }
            const rep = replacementLines(doc, at, O, nItems, found.tier);
            doc.lines.splice(at, O.length, ...rep);
            cursor = at + rep.length;
          }
        }
        const text = doc.toText();
        if (mt !== null) {
          tree.now.set(p, null);
          tree.now.set(mt, text);
          moves.push({ old: p, nw: mt });
        } else {
          tree.now.set(p, text);
        }
      });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  moves = [];
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
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4A(lines, strict);
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
  const rows: Array<{ key: string; line: string }> = [];
  const rPairs: Array<{ old: string; nw: string }> = [];
  for (const m of moves) {
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.nw) === null && tree.get(m.nw) !== null) {
      rPairs.push(m);
    }
  }
  const rOlds = new Set(rPairs.map((m) => m.old));
  const rNews = new Set(rPairs.map((m) => m.nw));
  for (const p of [...tree.now.keys()]) {
    if (rOlds.has(p) || rNews.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const m of rPairs) rows.push({ key: m.nw, line: `R ${m.old} -> ${m.nw}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
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
