// Symbol-level diff impact.
// Compares symbols between two versions and computes union impact.

import type { SymbolDiff, DiffImpactResult, ChangeKind } from './types.js';
import type { GraphStore } from './store.js';
import { computeImpact } from './impact.js';
import { parseSingleFile } from '../parse/index.js';

export interface DiffOptions {
  base?: string;
  head?: string;
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
  base: string,
  head: string,
  changedPaths?: string[]
): DiffImpactResult {
  const changedSymbols = diffSymbols(store, base, head, changedPaths);

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
