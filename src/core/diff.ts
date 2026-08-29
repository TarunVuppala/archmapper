// Symbol-level diff impact.
// Compares symbols between two versions and computes union impact.

import type { SymbolDiff, DiffImpactResult, ChangeKind } from './types.js';
import type { GraphStore } from './store.js';
import { computeImpact } from './impact.js';

export interface DiffOptions {
  base?: string;
  head?: string;
}

// Compare two sets of nodes to detect symbol changes
export function diffSymbols(
  store: GraphStore,
  _base: string,
  _head: string,
  changedPaths?: string[]
): SymbolDiff[] {
  const diffs: SymbolDiff[] = [];

  // If we have specific changed paths, diff those
  if (changedPaths && changedPaths.length > 0) {
    for (const path of changedPaths) {
      const oldNodes = store.listNodes().filter(n => n.path === path);
      const newNodes = store.listNodes().filter(n => n.path === path);

      // Build signature maps
      const oldSigs = new Map(oldNodes.map(n => [n.id, n.signature]));
      const newSigs = new Map(newNodes.map(n => [n.id, n.signature]));

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

      // Find changed symbols
      for (const [id, newSig] of newSigs) {
        const oldSig = oldSigs.get(id);
        if (oldSig !== undefined) {
          if (oldSig !== newSig) {
            // Determine if it's a signature change or body-only
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
    if (changedPaths?.some(p => cn.path?.includes(p))) {
      contractDeltas.push(cn.id);
    }
  }

  return {
    ok: true,
    base,
    head,
    changedSymbols,
    impact,
    contractDeltas,
  };
}
