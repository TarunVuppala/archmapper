// Deterministic service / package identity from the ONE graph.
// Runs after parse. Does not delete user-created service IDs.

import { basename } from 'node:path';
import type { GraphNode } from './types.js';
import type { GraphStore } from './store.js';
import { repoId, serviceId } from './ids.js';

export function identifyFromGraph(store: GraphStore, repoPath: string): {
  services: number;
  repo: string;
} {
  const now = new Date().toISOString();
  const name = basename(repoPath.replace(/\\/g, '/')) || 'workspace';
  const rId = repoId(name);

  store.upsertNode({
    id: rId,
    kind: 'Repo',
    name,
    path: '.',
    updated_at: now,
  });

  const files = store.listNodes('File', 100000);
  const buckets = new Map<string, GraphNode[]>();

  for (const file of files) {
    const p = (file.path ?? '').replace(/\\/g, '/');
    const m = p.match(/^(apps|services|packages|src)\/([^/]+)\//);
    if (m) {
      const key = `${m[1]}/${m[2]}`;
      const list = buckets.get(key) ?? [];
      list.push(file);
      buckets.set(key, list);
    }
  }

  // Flat repo: one service for the project itself.
  if (buckets.size === 0 && files.length > 0) {
    buckets.set(name, files);
  }

  let services = 0;
  for (const [key, owned] of buckets) {
    const svcName = key.includes('/') ? key.split('/')[1] : key;
    const sId = serviceId(svcName);
    const existing = store.getNode(sId);
    if (!existing) {
      store.upsertNode({
        id: sId,
        kind: 'Service',
        name: svcName,
        path: key,
        updated_at: now,
        metadata: { source: 'identify', fileCount: owned.length },
      });
    }
    store.upsertEdgeByEndpoints(
      'CONTAINS',
      rId,
      sId,
      [{ file: key, line: 1, snippet: `identified service ${svcName}` }],
      ['parser']
    );
    for (const file of owned.slice(0, 400)) {
      store.upsertEdgeByEndpoints(
        'CONTAINS',
        sId,
        file.id,
        [{ file: file.path ?? key, line: 1, snippet: file.path ?? '' }],
        ['parser'],
        0.85
      );
    }
    services++;
  }

  return { services, repo: rId };
}
