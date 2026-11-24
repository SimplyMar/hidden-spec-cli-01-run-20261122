// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+|[ \t]+$/g, '');
const leadingWs = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

interface FileState {
  lines: string[];
  br: '\n' | '\r\n';
  endsWithBreak: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', endsWithBreak: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const endsWithBreak = text.endsWith(br);
  if (endsWithBreak) lines.pop();
  return { lines, br, endsWithBreak };
}

function formatFile(lines: string[], br: '\n' | '\r\n', endsWithBreak: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (endsWithBreak ? br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly movedFrom = new Map<string, string>();
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
  recordMove(oldPath: string, newPath: string): void {
    const origin = this.movedFrom.get(oldPath) ?? oldPath;
    this.movedFrom.delete(oldPath);
    this.movedFrom.set(newPath, origin);
  }
  recordDelete(path: string): void {
    this.movedFrom.delete(path);
  }
}

type Edit = (tree: Tree) => void;

type Op = { kind: 'ctx'; text: string; oIdx: number } | { kind: 'add'; text: string };

interface MatchResult {
  tier: 0 | 1 | 2;
  positions: number[];
}

function normFn(tier: 0 | 1 | 2): (s: string) => string {
  if (tier === 0) return (s) => s;
  if (tier === 1) return stripTrail;
  return stripBoth;
}

function findMatches(
  fileLines: string[],
  targetLines: string[],
  strict: boolean,
  startIdx = 0,
  maxStartIdx = fileLines.length - targetLines.length,
): MatchResult | null {
  const hi = Math.min(maxStartIdx, fileLines.length - targetLines.length);
  if (targetLines.length === 0 || startIdx > hi) return null;
  const tiers: Array<0 | 1 | 2> = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const norm = normFn(tier);
    const tNorm = targetLines.map(norm);
    const fNorm = fileLines.map(norm);
    const positions: number[] = [];
    for (let i = startIdx; i <= hi; i += 1) {
      let ok = true;
      for (let j = 0; j < tNorm.length; j += 1) {
        if (fNorm[i + j] !== tNorm[j]) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

function applyReindent(line: string, fIndent: string, pIndent: string): string {
  if (line.trim() !== '' && line.startsWith(pIndent)) {
    return fIndent + line.slice(pIndent.length);
  }
  return line;
}

function materializeOps(
  fileLines: string[],
  matchPos: number,
  oldLines: string[],
  ops: Op[],
  tier: 0 | 1 | 2,
): string[] {
  const fIndent = leadingWs(fileLines[matchPos]!);
  const pIndent = leadingWs(oldLines[0]!);
  return ops.map((op) => {
    if (op.kind === 'ctx') return fileLines[matchPos + op.oIdx]!;
    return tier === 2 ? applyReindent(op.text, fIndent, pIndent) : op.text;
  });
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

interface UnifiedHunk {
  oldStart: number;
  oldLines: string[];
  ops: Op[];
  addLines: string[];
  noNewlineAfterLastNew: boolean;
}

function parseDiffGitLine(line: string, lineNum: number): [string, string] {
  if (!line.startsWith('diff --git a/')) throw new Exit2(`error: parse ${lineNum}`);
  const rest = line.slice('diff --git '.length);
  const simple = /^a\/(\S+) b\/(\S+)$/.exec(rest);
  if (simple) return [simple[1]!, simple[2]!];
  const afterA = rest.slice(2);
  let pos = 0;
  while (true) {
    const idx = afterA.indexOf(' b/', pos);
    if (idx < 0) break;
    const x = afterA.slice(0, idx);
    const y = afterA.slice(idx + 3);
    if (x.length > 0 && x === y) return [x, y];
    pos = idx + 1;
  }
  throw new Exit2(`error: parse ${lineNum}`);
}

function parseUnifiedPath(line: string): string {
  let raw = line.slice(4);
  const tab = raw.indexOf('\t');
  if (tab >= 0) raw = raw.slice(0, tab);
  raw = raw.trim();
  if (raw === '/dev/null') return '/dev/null';
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function parseHunkBody(rawBody: string[], oldStart: number): UnifiedHunk {
  const oldLines: string[] = [];
  const ops: Op[] = [];
  const addLines: string[] = [];
  let lastKind: 'ctx' | 'del' | 'add' | null = null;
  let noNewlineAfterLastNew = false;

  for (const l of rawBody) {
    if (l === '') {
      const oIdx = oldLines.length;
      oldLines.push('');
      ops.push({ kind: 'ctx', text: '', oIdx });
      lastKind = 'ctx';
      noNewlineAfterLastNew = false;
    } else if (l[0] === ' ') {
      const t = l.slice(1);
      const oIdx = oldLines.length;
      oldLines.push(t);
      ops.push({ kind: 'ctx', text: t, oIdx });
      lastKind = 'ctx';
      noNewlineAfterLastNew = false;
    } else if (l[0] === '-') {
      oldLines.push(l.slice(1));
      lastKind = 'del';
    } else if (l[0] === '+') {
      const t = l.slice(1);
      ops.push({ kind: 'add', text: t });
      addLines.push(t);
      lastKind = 'add';
      noNewlineAfterLastNew = false;
    } else if (l[0] === '\\') {
      if (lastKind === 'ctx' || lastKind === 'add') {
        noNewlineAfterLastNew = true;
      }
    }
  }
  return { oldStart, oldLines, ops, addLines, noNewlineAfterLastNew };
}

function applyUnifiedHunks(
  path: string,
  state: FileState,
  hunks: UnifiedHunk[],
  strict: boolean,
): FileState {
  const lines = [...state.lines];
  let endsWithBreak = state.endsWithBreak;
  let delta = 0;

  for (const h of hunks) {
    if (h.oldLines.length > 0) {
      const m = findMatches(lines, h.oldLines, strict);
      if (m === null) throw new Fail('no-match', path);
      const target = h.oldStart - 1 + delta;
      let bestPos = m.positions[0]!;
      let bestDist = Math.abs(bestPos - target);
      for (let k = 1; k < m.positions.length; k += 1) {
        const pos = m.positions[k]!;
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          bestDist = dist;
          bestPos = pos;
        }
      }
      const atEnd = bestPos + h.oldLines.length === lines.length;
      const repl = materializeOps(lines, bestPos, h.oldLines, h.ops, m.tier);
      lines.splice(bestPos, h.oldLines.length, ...repl);
      delta += repl.length - h.oldLines.length;
      if (atEnd) {
        endsWithBreak = !h.noNewlineAfterLastNew;
      }
    } else {
      const insertAt = Math.max(0, Math.min(lines.length, h.oldStart + delta));
      const atEnd = insertAt === lines.length;
      const repl = h.ops.map((op) => op.text);
      lines.splice(insertAt, 0, ...repl);
      delta += repl.length;
      if (atEnd) {
        endsWithBreak = !h.noNewlineAfterLastNew;
      }
    }
  }

  return { lines, br: state.br, endsWithBreak };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  const isDiffGit = (l: string): boolean => l === 'diff --git' || l.startsWith('diff --git ');
  const isPair = (idx: number): boolean => idx + 1 < n && lines[idx]!.startsWith('--- ') && lines[idx + 1]!.startsWith('+++ ');
  const isSectionStart = (idx: number): boolean => isDiffGit(lines[idx]!) || isPair(idx);

  let i = 0;
  while (i < n) {
    if (!isSectionStart(i)) {
      if (lines[i]!.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }

    let gitOld: string | null = null;
    let gitNew: string | null = null;
    let hdrOld: string | null = null;
    let hdrNew: string | null = null;
    let renOld: string | null = null;
    let renNew: string | null = null;
    let isNewMode = false;
    let isDelMode = false;
    let hasPair = false;

    if (isDiffGit(lines[i]!)) {
      [gitOld, gitNew] = parseDiffGitLine(lines[i]!, i + 1);
      i += 1;
    } else {
      hdrOld = parseUnifiedPath(lines[i]!);
      hdrNew = parseUnifiedPath(lines[i + 1]!);
      hasPair = true;
      i += 2;
    }

    while (i < n) {
      const l = lines[i]!;
      if (l.startsWith('@@') || isDiffGit(l)) break;
      if (l.startsWith('--- ')) {
        if (isPair(i)) {
          if (hasPair) break;
          hdrOld = parseUnifiedPath(l);
          hdrNew = parseUnifiedPath(lines[i + 1]!);
          hasPair = true;
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (l.startsWith('rename from ')) renOld = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) renNew = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode ')) isNewMode = true;
      else if (l.startsWith('deleted file mode ')) isDelMode = true;
      i += 1;
    }

    const hunks: UnifiedHunk[] = [];
    while (i < n) {
      if (isSectionStart(i)) break;
      const l = lines[i]!;
      if (l.startsWith('@@')) {
        const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(l);
        if (!m) throw new Exit2(`error: parse ${i + 1}`);
        const oldStart = Number(m[1]!);
        i += 1;
        const rawBody: string[] = [];
        while (i < n) {
          const bl = lines[i]!;
          if (isDiffGit(bl) || isPair(i)) break;
          if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
            rawBody.push(bl);
            i += 1;
          } else {
            break;
          }
        }
        while (rawBody.length > 0 && rawBody[rawBody.length - 1] === '') rawBody.pop();
        hunks.push(parseHunkBody(rawBody, oldStart));
      } else {
        i += 1;
      }
    }

    const oldPath = hasPair ? hdrOld! : (renOld ?? gitOld!);
    const newPath = hasPair ? hdrNew! : (renNew ?? gitNew!);

    edits.push((tree) => {
      if (oldPath === '/dev/null' || isNewMode) {
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const createdLines: string[] = [];
        let noNewline = false;
        for (const h of hunks) {
          for (const al of h.addLines) createdLines.push(al);
        }
        if (hunks.length > 0) {
          let lastNoNl = false;
          for (let hi = hunks.length - 1; hi >= 0; hi -= 1) {
            if (hunks[hi]!.addLines.length > 0) {
              lastNoNl = hunks[hi]!.noNewlineAfterLastNew;
              break;
            }
          }
          noNewline = lastNoNl;
        }
        tree.now.set(newPath, formatFile(createdLines, '\n', !noNewline));
      } else if (newPath === '/dev/null' || isDelMode) {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        tree.now.set(oldPath, null);
        tree.recordDelete(oldPath);
      } else if (oldPath !== newPath) {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        const before = tree.get(oldPath);
        if (before === null) throw new Fail('missing', oldPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const nextState = applyUnifiedHunks(oldPath, parseFile(before), hunks, strict);
        tree.now.set(oldPath, null);
        tree.now.set(newPath, formatFile(nextState.lines, nextState.br, nextState.endsWithBreak));
        tree.recordMove(oldPath, newPath);
      } else {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        const before = tree.get(oldPath);
        if (before === null) throw new Fail('missing', oldPath);
        const nextState = applyUnifiedHunks(oldPath, parseFile(before), hunks, strict);
        tree.now.set(oldPath, formatFile(nextState.lines, nextState.br, nextState.endsWithBreak));
      }
    });
  }

  return edits;
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;

  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let foundPath: string | null = null;
    for (let k = searchIdx - 1; k >= prevEnd; k -= 1) {
      const trimmed = lines[k]!.trim();
      if (trimmed !== '' && !trimmed.startsWith('```')) {
        foundPath = trimmed;
        break;
      }
    }
    const blockPath = foundPath ?? prevPath;
    if (blockPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);

    let sepIdx = -1;
    let endIdx = -1;
    for (let k = searchIdx + 1; k < n; k += 1) {
      const te = lines[k]!.trimEnd();
      if (sepIdx < 0) {
        if (te === '=======') {
          sepIdx = k;
        } else if (te === '>>>>>>> REPLACE') {
          throw new Exit2(`error: parse ${searchIdx + 1}`);
        }
      } else if (te === '>>>>>>> REPLACE') {
        endIdx = k;
        break;
      }
    }
    if (sepIdx < 0 || endIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);

    const oldLines = lines.slice(searchIdx + 1, sepIdx);
    const newLines = lines.slice(sepIdx + 1, endIdx);
    prevPath = blockPath;
    prevEnd = endIdx + 1;
    i = endIdx + 1;

    edits.push((tree) => {
      if (!safe(blockPath)) throw new Fail('unsafe', blockPath);
      if (oldLines.length === 0) {
        if (tree.get(blockPath) !== null) throw new Fail('exists', blockPath);
        tree.now.set(blockPath, formatFile(newLines, '\n', true));
        return;
      }
      const before = tree.get(blockPath);
      if (before === null) throw new Fail('missing', blockPath);
      const state = parseFile(before);
      const m = findMatches(state.lines, oldLines, strict);
      if (m === null) throw new Fail('no-match', blockPath);
      if (m.positions.length > 1) throw new Fail('ambiguous', blockPath);
      const pos = m.positions[0]!;
      const fIndent = leadingWs(state.lines[pos]!);
      const pIndent = leadingWs(oldLines[0]!);
      const repl = m.tier === 2 ? newLines.map((l) => applyReindent(l, fIndent, pIndent)) : newLines;
      const outLines = [...state.lines];
      outLines.splice(pos, oldLines.length, ...repl);
      tree.now.set(blockPath, formatFile(outLines, state.br, state.endsWithBreak));
    });
  }

  return edits;
}

interface V4aChunk {
  anchor: string | null;
  oldLines: string[];
  ops: Op[];
  eof: boolean;
}

function parseV4aChunks(secLines: string[], startLineNum: number): V4aChunk[] {
  const chunks: V4aChunk[] = [];
  let i = 0;

  while (i < secLines.length) {
    const chunkLine = startLineNum + i;
    const l = secLines[i]!;
    let anchor: string | null = null;
    if (l.startsWith('@@')) {
      const a = l.slice(2).trim();
      anchor = a === '' ? null : a;
      i += 1;
    } else if (chunks.length > 0) {
      throw new Exit2(`error: parse ${chunkLine}`);
    }

    const oldLines: string[] = [];
    const ops: Op[] = [];
    let eof = false;
    let bodyCount = 0;

    while (i < secLines.length) {
      const bl = secLines[i]!;
      if (bl.startsWith('@@')) break;
      if (bl === '*** End of File') {
        eof = true;
        i += 1;
        break;
      }
      if (bl === '') {
        const oIdx = oldLines.length;
        oldLines.push('');
        ops.push({ kind: 'ctx', text: '', oIdx });
        bodyCount += 1;
        i += 1;
      } else if (bl[0] === ' ') {
        const t = bl.slice(1);
        const oIdx = oldLines.length;
        oldLines.push(t);
        ops.push({ kind: 'ctx', text: t, oIdx });
        bodyCount += 1;
        i += 1;
      } else if (bl[0] === '-') {
        oldLines.push(bl.slice(1));
        bodyCount += 1;
        i += 1;
      } else if (bl[0] === '+') {
        ops.push({ kind: 'add', text: bl.slice(1) });
        bodyCount += 1;
        i += 1;
      } else {
        throw new Exit2(`error: parse ${startLineNum + i}`);
      }
    }

    if (anchor === null && bodyCount === 0 && !eof) {
      throw new Exit2(`error: parse ${chunkLine}`);
    }
    chunks.push({ anchor, oldLines, ops, eof });
  }

  return chunks;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);

  let last = -1;
  for (let k = lines.length - 1; k >= first; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') {
    throw new Exit2(`error: parse ${lines.length + 1}`);
  }

  const isSecHeader = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

  const edits: Edit[] = [];
  let i = first + 1;

  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const header = lines[i]!;
    if (!isSecHeader(header)) throw new Exit2(`error: parse ${i + 1}`);

    const secStart = i;
    i += 1;
    while (i < last && !isSecHeader(lines[i]!)) i += 1;
    let secEnd = i;
    while (secEnd > secStart + 1 && blank(lines[secEnd - 1]!)) secEnd -= 1;
    const secLines = lines.slice(secStart + 1, secEnd);

    if (header.startsWith('*** Add File: ')) {
      const path = header.slice('*** Add File: '.length).trim();
      const addLines: string[] = [];
      for (let k = 0; k < secLines.length; k += 1) {
        const sl = secLines[k]!;
        if (sl.startsWith('+')) addLines.push(sl.slice(1));
        else if (sl === '') addLines.push('');
        else throw new Exit2(`error: parse ${secStart + 2 + k}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, formatFile(addLines, '\n', true));
      });
    } else if (header.startsWith('*** Delete File: ')) {
      const path = header.slice('*** Delete File: '.length).trim();
      if (secLines.length > 0) throw new Exit2(`error: parse ${secStart + 2}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
        tree.recordDelete(path);
      });
    } else {
      const path = header.slice('*** Update File: '.length).trim();
      let moveTo: string | null = null;
      let offset = 0;
      if (secLines.length > 0 && secLines[0]!.startsWith('*** Move to: ')) {
        moveTo = secLines[0]!.slice('*** Move to: '.length).trim();
        offset = 1;
      }
      const chunks = parseV4aChunks(secLines.slice(offset), secStart + 2 + offset);
      if (chunks.length === 0 && moveTo === null) {
        throw new Exit2(`error: parse ${secStart + 1}`);
      }

      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const before = tree.get(path);
        if (before === null) throw new Fail('missing', path);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);

        const state = parseFile(before);
        const fileLines = [...state.lines];
        let cursor = 0;

        for (const ch of chunks) {
          if (ch.anchor !== null) {
            const am = findMatches(fileLines, [ch.anchor], strict, cursor);
            if (am === null) throw new Fail('no-match', path);
            cursor = am.positions[0]! + 1;
          }
          if (ch.oldLines.length > 0) {
            let m: MatchResult | null;
            if (ch.eof) {
              const eofStart = fileLines.length - ch.oldLines.length;
              m = eofStart >= cursor ? findMatches(fileLines, ch.oldLines, strict, eofStart, eofStart) : null;
            } else {
              m = findMatches(fileLines, ch.oldLines, strict, cursor);
            }
            if (m === null) throw new Fail('no-match', path);
            const pos = m.positions[0]!;
            const repl = materializeOps(fileLines, pos, ch.oldLines, ch.ops, m.tier);
            fileLines.splice(pos, ch.oldLines.length, ...repl);
            cursor = pos + repl.length;
          } else {
            const pos = ch.eof ? fileLines.length : cursor;
            const repl = ch.ops.map((op) => op.text);
            fileLines.splice(pos, 0, ...repl);
            cursor = pos + repl.length;
          }
        }

        const out = formatFile(fileLines, state.br, state.endsWithBreak);
        if (moveTo !== null) {
          tree.now.set(path, null);
          tree.now.set(moveTo, out);
          tree.recordMove(path, moveTo);
        } else {
          tree.now.set(path, out);
        }
      });
    }
  }

  return edits;
}

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
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else if (kind === 'v4a') edits = v4aEdits(lines, strict);
    else edits = [];
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = new Map(tree.movedFrom);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.movedFrom.clear();
      for (const [k, v] of beforeMoves) tree.movedFrom.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };

  const added = new Set<string>();
  const deleted = new Set<string>();
  const modified = new Set<string>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was === null) added.add(p);
    else if (now === null) deleted.add(p);
    else modified.add(p);
  }

  const entries: Array<{ key: string; line: string }> = [];
  for (const p of [...added]) {
    const oldPath = tree.movedFrom.get(p);
    if (oldPath !== undefined && deleted.has(oldPath)) {
      deleted.delete(oldPath);
      added.delete(p);
      entries.push({ key: p, line: `R ${oldPath} -> ${p}` });
    }
  }
  for (const p of added) entries.push({ key: p, line: `A ${p}` });
  for (const p of deleted) entries.push({ key: p, line: `D ${p}` });
  for (const p of modified) entries.push({ key: p, line: `M ${p}` });
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));

  if (!check) {
    const sorted = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    for (const p of sorted) {
      if (tree.original(p) !== null && tree.now.get(p) === null) {
        rmSync(p, { force: true });
      }
    }
    for (const p of sorted) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now || now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }

  const rows = entries.map((e) => e.line);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
