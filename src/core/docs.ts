// In-repo documentation resolver. Never invents external API parameters.

import type { GraphNode } from './types.js';
import type { GraphStore } from './store.js';

export interface DocsResult {
  target?: GraphNode;
  docs: GraphNode[];
  excerpts: Array<{ id: string; path?: string; name: string }>;
}

export function resolveDocs(store: GraphStore, idOrName: string): DocsResult {
  const target = store.resolveNode(idOrName) ?? store.getNode(`ext:${idOrName}`);
  const allDocs = store.listNodes('Doc', 500);
  const needle = (idOrName + ' ' + (target?.name ?? '') + ' ' + (target?.path ?? '')).toLowerCase();

  const scored = allDocs
    .map(d => {
      const hay = `${d.name} ${d.path ?? ''} ${d.id}`.toLowerCase();
      let score = 0;
      for (const part of needle.split(/[^a-z0-9]+/).filter(p => p.length > 2)) {
        if (hay.includes(part)) score += 1;
      }
      if (target?.path && d.path && dirname(d.path) === dirname(target.path)) score += 2;
      if ((d.path ?? '').toLowerCase().includes('readme')) score += 1;
      if ((d.path ?? '').toLowerCase().includes('adr')) score += 1;
      return { d, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map(x => x.d);

  const docs = scored.length > 0 ? scored : allDocs.filter(d =>
    (d.path ?? '').toLowerCase().includes('readme') ||
    (d.path ?? '').toLowerCase().includes('llms.txt')
  ).slice(0, 8);

  if (target) {
    const documented = store.getOutEdges(target.id).filter(e => e.type === 'DOCUMENTS')
      .map(e => store.getNode(e.to))
      .filter((n): n is GraphNode => Boolean(n));
    for (const d of documented) {
      if (!docs.some(x => x.id === d.id)) docs.unshift(d);
    }
  }

  return {
    target,
    docs,
    excerpts: docs.map(d => ({ id: d.id, path: d.path, name: d.name })),
  };
}

function dirname(p: string): string {
  const i = p.replace(/\\/g, '/').lastIndexOf('/');
  return i <= 0 ? '' : p.slice(0, i);
}
