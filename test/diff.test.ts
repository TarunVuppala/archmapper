// Symbol-level git diff: range / working tree / staged.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GraphStore } from '../src/core/store.js';
import { computeDiffImpact, diffSymbols, gitChangedFiles } from '../src/core/diff.js';
import { parseFileContent } from '../src/parse/index.js';
import { functionId } from '../src/core/ids.js';
import type { GraphNode } from '../src/core/types.js';

const OLD_SRC = `export function greet(name: string) {
  return 'hi ' + name;
}

export function unused() {
  return 1;
}
`;

const BODY_ONLY = `export function greet(name: string) {
  return 'hello ' + name;
}

export function unused() {
  return 1;
}
`;

const SIG_CHANGED = `export function greet(name: string, extra: number) {
  return 'hi ' + name;
}

export function unused() {
  return 1;
}
`;

const ADDED_REMOVED = `export function greet(name: string) {
  return 'hi ' + name;
}

export function fresh() {
  return 2;
}
`;

function symbolsOf(rel: string, content: string): GraphNode[] {
  return parseFileContent(rel, content).nodes;
}

describe('diffSymbols (pure)', () => {
  const rel = 'src/greet.ts';

  it('detects body-only changes', () => {
    const diffs = diffSymbols(
      symbolsOf(rel, OLD_SRC),
      symbolsOf(rel, BODY_ONLY),
      new Map([[rel, OLD_SRC]]),
      new Map([[rel, BODY_ONLY]]),
    );
    const greet = diffs.find(d => d.nodeId === functionId(rel, 'greet'));
    expect(greet?.change).toBe('body_only');
    expect(diffs.find(d => d.nodeId === functionId(rel, 'unused'))).toBeUndefined();
  });

  it('detects signature changes', () => {
    const diffs = diffSymbols(
      symbolsOf(rel, OLD_SRC),
      symbolsOf(rel, SIG_CHANGED),
      new Map([[rel, OLD_SRC]]),
      new Map([[rel, SIG_CHANGED]]),
    );
    const greet = diffs.find(d => d.nodeId === functionId(rel, 'greet'));
    expect(greet?.change).toBe('signature_changed');
  });

  it('detects added and removed symbols', () => {
    const diffs = diffSymbols(
      symbolsOf(rel, OLD_SRC),
      symbolsOf(rel, ADDED_REMOVED),
      new Map([[rel, OLD_SRC]]),
      new Map([[rel, ADDED_REMOVED]]),
    );
    expect(diffs.find(d => d.nodeId === functionId(rel, 'unused'))?.change).toBe('removed');
    expect(diffs.find(d => d.nodeId === functionId(rel, 'fresh'))?.change).toBe('added');
    expect(diffs.find(d => d.nodeId === functionId(rel, 'greet'))).toBeUndefined();
  });
});

function git(cwd: string, args: string[]) {
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

function initRepo(dir: string) {
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@archmap.test']);
  git(dir, ['config', 'user.name', 'Archmap Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
}

describe('git working tree / staged / range', () => {
  let dir: string;
  let store: GraphStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'archmap-diff-'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'greet.ts'), OLD_SRC);
    initRepo(dir);
    git(dir, ['add', 'src/greet.ts']);
    git(dir, ['commit', '-m', 'init']);

    store = new GraphStore(join(dir, 'test.db'));
    const parsed = parseFileContent('src/greet.ts', OLD_SRC);
    for (const n of parsed.nodes) store.upsertNode(n);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('detects working-tree edits', () => {
    writeFileSync(join(dir, 'src', 'greet.ts'), BODY_ONLY);
    const files = gitChangedFiles(dir, { mode: 'working' });
    expect(files.map(f => f.path)).toContain('src/greet.ts');

    const result = computeDiffImpact(store, { mode: 'working', repoPath: dir });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('working');
    expect(result.changedPaths).toContain('src/greet.ts');
    const greet = result.changedSymbols.find(d => d.nodeId === functionId('src/greet.ts', 'greet'));
    expect(greet?.change).toBe('body_only');
    expect(result.impact.startIds).toContain(functionId('src/greet.ts', 'greet'));
  });

  it('detects staged edits and ignores unstaged-only when staged', () => {
    writeFileSync(join(dir, 'src', 'greet.ts'), SIG_CHANGED);
    git(dir, ['add', 'src/greet.ts']);

    const staged = computeDiffImpact(store, { mode: 'staged', repoPath: dir });
    expect(staged.changedSymbols.find(d => d.nodeId === functionId('src/greet.ts', 'greet'))?.change).toBe('signature_changed');

    writeFileSync(join(dir, 'src', 'greet.ts'), BODY_ONLY);
    const stillStaged = computeDiffImpact(store, { mode: 'staged', repoPath: dir });
    expect(stillStaged.changedSymbols.find(d => d.nodeId === functionId('src/greet.ts', 'greet'))?.change).toBe('signature_changed');

    const working = computeDiffImpact(store, { mode: 'working', repoPath: dir });
    expect(working.changedSymbols.find(d => d.nodeId === functionId('src/greet.ts', 'greet'))?.change).toBe('body_only');
  });

  it('detects untracked files as added in working mode', () => {
    writeFileSync(join(dir, 'src', 'new.ts'), `export function extra() { return 3; }\n`);
    const files = gitChangedFiles(dir, { mode: 'working' });
    expect(files.some(f => f.path === 'src/new.ts' && f.status === 'A')).toBe(true);

    const result = computeDiffImpact(store, { mode: 'working', repoPath: dir });
    expect(result.changedSymbols.find(d => d.nodeId === functionId('src/new.ts', 'extra'))?.change).toBe('added');
  });

  it('detects a commit range', () => {
    writeFileSync(join(dir, 'src', 'greet.ts'), ADDED_REMOVED);
    git(dir, ['add', 'src/greet.ts']);
    git(dir, ['commit', '-m', 'change']);

    const result = computeDiffImpact(store, { mode: 'range', base: 'HEAD~1', head: 'HEAD', repoPath: dir });
    expect(result.mode).toBe('range');
    expect(result.changedSymbols.find(d => d.nodeId === functionId('src/greet.ts', 'unused'))?.change).toBe('removed');
    expect(result.changedSymbols.find(d => d.nodeId === functionId('src/greet.ts', 'fresh'))?.change).toBe('added');
  });
});
