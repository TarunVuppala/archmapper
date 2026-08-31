// Symbol-level diff impact.
// Compares parsed symbols between two git versions (range / working tree / staged)
// and computes the union downstream impact.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DiffImpactResult, DiffMode, GraphNode, NodeKind, SymbolDiff } from './types.js';
import type { GraphStore } from './store.js';
import { computeImpact } from './impact.js';
import { parseFileContent } from '../parse/index.js';

export interface DiffOptions {
  base?: string;
  head?: string;
  repoPath?: string;
  /** range = base...head; working = HEAD vs working tree; staged = HEAD vs index. */
  mode?: DiffMode;
  changedPaths?: string[];
}

const SYMBOL_KINDS = new Set<NodeKind>([
  'Function', 'Method', 'Class', 'Interface', 'API', 'Route',
  'Table', 'Test', 'Event', 'Job',
]);

const SKIP_PATH = /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|Gemfile\.lock)$|\.(?:map|min\.js)$/i;

const CONTRACT_PATH = /(?:openapi|swagger|asyncapi|\.proto$|\.prisma$|\.sql$|\/migrations\/)/i;

export interface ChangedFile {
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | '?';
  path: string;
  oldPath?: string;
}

function git(repoPath: string, args: string[], allowFail = false): string {
  try {
    return execFileSync('git', args, {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (e: any) {
    if (allowFail) return '';
    throw e;
  }
}

function gitOk(repoPath: string, args: string[]): boolean {
  try {
    execFileSync('git', args, {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function isGitRepo(repoPath: string): boolean {
  return gitOk(repoPath, ['rev-parse', '--is-inside-work-tree']);
}

function resolveRef(repoPath: string, ref: string): string | null {
  if (gitOk(repoPath, ['rev-parse', '--verify', ref])) return ref;
  if (gitOk(repoPath, ['rev-parse', '--verify', `${ref}^{commit}`])) return ref;
  return null;
}

function defaultBaseRef(repoPath: string): string {
  for (const cand of ['main', 'master', 'origin/main', 'HEAD']) {
    if (resolveRef(repoPath, cand)) return cand;
  }
  return 'HEAD';
}

function parseNameStatus(out: string): ChangedFile[] {
  const rows: ChangedFile[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const code = (parts[0] || '?')[0] as ChangedFile['status'];
    if (code === 'R' || code === 'C') {
      rows.push({ status: code, oldPath: parts[1]?.replace(/\\/g, '/'), path: (parts[2] || parts[1] || '').replace(/\\/g, '/') });
    } else {
      rows.push({ status: code, path: (parts[1] || '').replace(/\\/g, '/') });
    }
  }
  return rows.filter(r => r.path && !SKIP_PATH.test(r.path));
}

export function gitChangedFiles(repoPath: string, options: DiffOptions = {}): ChangedFile[] {
  if (!isGitRepo(repoPath)) return [];
  const mode: DiffMode = options.mode ?? (options.base ? 'range' : 'working');

  let out = '';
  if (mode === 'staged') {
    out = git(repoPath, ['-c', 'core.quotepath=false', 'diff', '--name-status', '--cached', 'HEAD'], true);
  } else if (mode === 'working') {
    out = git(repoPath, ['-c', 'core.quotepath=false', 'diff', '--name-status', 'HEAD'], true);
  } else {
    const base = resolveRef(repoPath, options.base ?? defaultBaseRef(repoPath)) ?? defaultBaseRef(repoPath);
    const head = resolveRef(repoPath, options.head ?? 'HEAD') ?? 'HEAD';
    out = git(repoPath, ['-c', 'core.quotepath=false', 'diff', '--name-status', `${base}...${head}`], true);
    if (!out) {
      out = git(repoPath, ['-c', 'core.quotepath=false', 'diff', '--name-status', base, head], true);
    }
  }

  const files = parseNameStatus(out);

  if (mode === 'working') {
    const untracked = git(repoPath, ['-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard'], true);
    for (const p of untracked.split(/\r?\n/).map(s => s.trim().replace(/\\/g, '/')).filter(Boolean)) {
      if (SKIP_PATH.test(p)) continue;
      if (!files.some(f => f.path === p)) files.push({ status: 'A', path: p });
    }
  }

  if (options.changedPaths?.length) {
    const allow = new Set(options.changedPaths.map(p => p.replace(/\\/g, '/')));
    return files.filter(f => allow.has(f.path) || (f.oldPath && allow.has(f.oldPath)));
  }
  return files;
}

export function gitChangedPaths(repoPath: string, base: string, head: string): string[] {
  return gitChangedFiles(repoPath, { mode: 'range', base, head }).map(f => f.path);
}

function gitShow(repoPath: string, spec: string): string | null {
  try {
    return execFileSync('git', ['show', spec], {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
  } catch {
    return null;
  }
}

function readWorkingFile(repoPath: string, relPath: string): string | null {
  const abs = join(repoPath, relPath);
  if (!existsSync(abs)) return null;
  try {
    return readFileSync(abs, 'utf-8');
  } catch {
    return null;
  }
}

function loadOldContent(repoPath: string, file: ChangedFile, baseRef: string): string | null {
  if (file.status === 'A') return null;
  const path = file.oldPath ?? file.path;
  return gitShow(repoPath, `${baseRef}:${path}`);
}

function loadNewContent(
  repoPath: string,
  file: ChangedFile,
  mode: DiffMode,
  headRef: string,
): string | null {
  if (file.status === 'D') return null;
  if (mode === 'working') return readWorkingFile(repoPath, file.path);
  if (mode === 'staged') return gitShow(repoPath, `:${file.path}`);
  return gitShow(repoPath, `${headRef}:${file.path}`);
}

function linesOf(content: string): string[] {
  return content.split(/\r?\n/);
}

function declarationLine(node: GraphNode, content: string | null): string {
  if (content && node.startLine) {
    return (linesOf(content)[node.startLine - 1] ?? '').trim();
  }
  return (node.signature ?? '').trim();
}

function bodyRest(node: GraphNode, content: string | null): string {
  if (!content) return '';
  const lines = linesOf(content);
  const start = Math.max(0, (node.startLine ?? 1) - 1);
  const end = node.endLine != null ? node.endLine : start + 1;
  return lines.slice(start + 1, Math.max(end, start + 1)).join('\n');
}

function isSymbol(n: GraphNode): boolean {
  return SYMBOL_KINDS.has(n.kind);
}

/** Compare two parsed symbol sets for one file (or many). */
export function diffSymbols(
  oldNodes: GraphNode[],
  newNodes: GraphNode[],
  oldContentByPath?: Map<string, string | null>,
  newContentByPath?: Map<string, string | null>,
): SymbolDiff[] {
  const olds = oldNodes.filter(isSymbol);
  const news = newNodes.filter(isSymbol);
  const oldMap = new Map(olds.map(n => [n.id, n]));
  const newMap = new Map(news.map(n => [n.id, n]));
  const diffs: SymbolDiff[] = [];

  for (const [id, node] of oldMap) {
    if (!newMap.has(id)) diffs.push({ nodeId: id, change: 'removed', oldSignature: node.signature });
  }

  for (const [id, node] of newMap) {
    const prev = oldMap.get(id);
    if (!prev) {
      diffs.push({ nodeId: id, change: 'added', newSignature: node.signature });
      continue;
    }
    const path = node.path ?? prev.path ?? '';
    const oldContent = oldContentByPath?.get(path) ?? oldContentByPath?.get(prev.path ?? '') ?? null;
    const newContent = newContentByPath?.get(path) ?? newContentByPath?.get(node.path ?? '') ?? null;
    const oldDecl = declarationLine(prev, oldContent);
    const newDecl = declarationLine(node, newContent);
    const oldSig = oldDecl || prev.signature || '';
    const newSig = newDecl || node.signature || '';

    if (oldSig !== newSig) {
      diffs.push({ nodeId: id, change: 'signature_changed', oldSignature: oldSig, newSignature: newSig });
    } else if (bodyRest(prev, oldContent) !== bodyRest(node, newContent)) {
      diffs.push({
        nodeId: id,
        change: 'body_only',
        oldSignature: oldSig || undefined,
        newSignature: newSig || undefined,
      });
    }
  }

  return diffs;
}

function emptyImpact(): DiffImpactResult['impact'] {
  return {
    ok: true,
    startIds: [],
    direction: 'downstream',
    counts: {} as any,
    nodes: [],
    edges: [],
    paths: [],
    testsToRun: [],
    riskChips: [],
    docsForExternals: [],
    suggestedReviewers: [],
  };
}

export function computeDiffImpact(
  store: GraphStore,
  options: DiffOptions = {},
): DiffImpactResult {
  const repoPath = options.repoPath ?? '.';
  const mode: DiffMode = options.mode ?? (options.base ? 'range' : 'working');
  const head = options.head ?? 'HEAD';
  const base = options.base ?? (mode === 'range' ? defaultBaseRef(repoPath) : 'HEAD');

  const resultBase: DiffImpactResult = {
    ok: true,
    base,
    head: mode === 'working' ? 'WORKING' : mode === 'staged' ? 'STAGED' : head,
    mode,
    changedSymbols: [],
    impact: emptyImpact(),
    contractDeltas: [],
    changedPaths: [],
  };

  if (!isGitRepo(repoPath)) {
    resultBase.gitError = 'Not a git repository';
    return resultBase;
  }

  const files = gitChangedFiles(repoPath, { ...options, mode, base, head, repoPath });
  resultBase.changedPaths = files.map(f => f.path);

  const oldContentByPath = new Map<string, string | null>();
  const newContentByPath = new Map<string, string | null>();
  const oldNodes: GraphNode[] = [];
  const newNodes: GraphNode[] = [];

  const baseRef = resolveRef(repoPath, base) ?? base;
  const headRef = resolveRef(repoPath, head) ?? head;

  for (const file of files) {
    const oldContent = loadOldContent(repoPath, file, baseRef);
    const newContent = loadNewContent(repoPath, file, mode, headRef);
    oldContentByPath.set(file.path, oldContent);
    newContentByPath.set(file.path, newContent);
    if (file.oldPath && oldContent != null) oldContentByPath.set(file.oldPath, oldContent);

    if (oldContent != null) oldNodes.push(...parseFileContent(file.oldPath ?? file.path, oldContent).nodes);
    if (newContent != null) newNodes.push(...parseFileContent(file.path, newContent).nodes);
  }

  let changedSymbols = diffSymbols(oldNodes, newNodes, oldContentByPath, newContentByPath);

  // If a modified file produced no symbol diffs, fall back to graph nodes on that path
  // (parser missed the language, or only comments/whitespace changed near symbols).
  if (changedSymbols.length === 0 && files.length > 0) {
    const pathSet = new Set(files.map(f => f.path));
    for (const n of store.listAllNodes()) {
      if (n.path && pathSet.has(n.path) && isSymbol(n)) {
        changedSymbols.push({ nodeId: n.id, change: 'body_only', oldSignature: n.signature, newSignature: n.signature });
      }
    }
  }

  const contractDeltas: string[] = [];
  for (const cn of store.listNodes('Contract')) {
    if (cn.path && files.some(f => f.path === cn.path || f.path.includes(cn.path!) || cn.path!.includes(f.path))) {
      contractDeltas.push(cn.id);
    }
  }
  for (const f of files) {
    if (CONTRACT_PATH.test(f.path) && !contractDeltas.includes(`contract:${f.path}`)) {
      contractDeltas.push(`contract:${f.path}`);
    }
  }

  const startIds = changedSymbols
    .map(d => d.nodeId)
    .filter((id): id is string => Boolean(id) && Boolean(store.getNode(id)));

  const impact = startIds.length === 0
    ? emptyImpact()
    : computeImpact(store, startIds, { direction: 'downstream', maxDepth: 5, maxPaths: 7 });

  return {
    ...resultBase,
    changedSymbols,
    impact,
    contractDeltas,
  };
}
