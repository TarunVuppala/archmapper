// Symbol-level diff impact.
// Compares symbols between two versions and computes union impact.

import { execSync } from 'node:child_process';
import type { SymbolDiff, DiffImpactResult, ChangeKind } from './types.js';
import type { GraphStore } from './store.js';
import { computeImpact } from './impact.js';
import { parseSingleFile } from '../parse/index.js';

export interface DiffOptions {
  base?: string;
  head?: string;
}

// Read uncommitted, staged, and untracked files from git
export function getGitChangedFiles(repoPath: string = '.'): string[] {
  try {
    const files = new Set<string>();

    // 1. Unstaged modified files
    try {
      const stdout = execSync('git diff --name-only', { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
      stdout.split('\n').map(f => f.trim()).filter(Boolean).forEach(f => files.add(f));
    } catch { /* ignore git fail */ }

    // 2. Staged modified files
    try {
      const stagedStdout = execSync('git diff --cached --name-only', { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
      stagedStdout.split('\n').map(f => f.trim()).filter(Boolean).forEach(f => files.add(f));
    } catch { /* ignore git fail */ }

    // 3. Untracked workspace files
    try {
      const untrackedStdout = execSync('git ls-files --others --exclude-standard', { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
      untrackedStdout.split('\n').map(f => f.trim()).filter(Boolean).forEach(f => files.add(f));
    } catch { /* ignore git fail */ }

    return Array.from(files);
  } catch {
    return [];
  }
}

// Compare two sets of nodes to detect symbol changes
export function diffSymbols(
  store: GraphStore,
  repoPath: string = '.',
  changedPaths?: string[]
): SymbolDiff[] {
  const diffs: SymbolDiff[] = [];
  const paths = changedPaths && changedPaths.length > 0 ? changedPaths : getGitChangedFiles(repoPath);

  for (const path of paths) {
    // 1. Get the previously indexed symbols from SQLite (old version)
    const oldNodes = store.listNodes().filter(n => n.path === path && n.kind !== 'File');
    
    // 2. Parse the currently modified file on-disk (new version)
    const { nodes: newNodes } = parseSingleFile(repoPath, path);
    const freshNodes = newNodes.filter(n => n.kind !== 'File');

    // Build signature maps for comparison
    const oldSigs = new Map(oldNodes.map(n => [n.id, n.signature]));
    const newSigs = new Map(freshNodes.map(n => [n.id, n.signature]));

    // Find removed symbols
    for (const [id] of oldSigs) {
      if (!newSigs.has(id)) {
        diffs.push({ nodeId: id, change: 'removed' });
      }
    }

    // Find added symbols
    for (const [id] of newSigs) {
      if (!oldSigs.has(id)) {
        diffs.push({ nodeId: id, change: 'added' });
      }
    }

    // Find changed symbols (signature vs body modifications)
    for (const [id, newSig] of newSigs) {
      const oldSig = oldSigs.get(id);
      if (oldSig !== undefined) {
        if (oldSig !== newSig) {
          const isSignatureChange = oldSig.split('(')[0] !== (newSig ?? '').split('(')[0];
          diffs.push({
            nodeId: id,
            change: isSignatureChange ? 'signature_changed' : 'body_only',
            oldSignature: oldSig,
            newSignature: newSig ?? undefined,
          });
        }
      }
    }
  }

  return diffs;
}

// Compute impact of symbol-level diffs
export function computeDiffImpact(
  store: GraphStore,
  repoPath: string = '.',
  changedPaths?: string[]
): DiffImpactResult {
  const paths = changedPaths && changedPaths.length > 0 ? changedPaths : getGitChangedFiles(repoPath);
  const changedSymbols = diffSymbols(store, repoPath, paths);

  // Compute union impact of all changed symbols
  const startIds = changedSymbols.map(d => d.nodeId);
  const impact = computeImpact(store, startIds, {
    direction: 'downstream',
    maxDepth: 5,
    maxPaths: 7,
  });

  // Detect contract/schema deltas
  const contractDeltas: string[] = [];
  const contractNodes = store.listNodes('Contract');
  for (const cn of contractNodes) {
    if (paths?.some(p => cn.path?.includes(p))) {
      contractDeltas.push(cn.id);
    }
  }

  return {
    ok: true,
    base: 'git-diff',
    head: 'local-disk',
    changedSymbols,
    impact,
    contractDeltas,
  };
}
