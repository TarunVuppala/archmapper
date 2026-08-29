// Load .archmap/seed.yaml into the ONE graph. Pins are evidence, not a second store.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import type { EdgeKind, Evidence } from './types.js';
import type { GraphStore } from './store.js';
import { serviceId, externalId } from './ids.js';

export interface SeedFile {
  project?: { name?: string };
  services?: Array<{
    id: string;
    paths?: string[];
    owns_tables?: string[];
    owns_routes?: string[];
  }>;
  externals?: Array<{ id: string; consumes?: string[] }>;
  pins?: Array<{ type: EdgeKind; from: string; to: string; evidence?: string }>;
  ignore_paths?: string[];
  critical?: string[];
  ask_me_when?: string;
}

export function loadSeed(store: GraphStore, repoPath: string): { applied: number } {
  const seedPath = join(repoPath, '.archmap', 'seed.yaml');
  if (!existsSync(seedPath)) return { applied: 0 };
  let raw: SeedFile;
  try {
    raw = (yaml.load(readFileSync(seedPath, 'utf-8')) as SeedFile) ?? {};
  } catch {
    return { applied: 0 };
  }
  return applySeed(store, raw);
}

export function applySeed(store: GraphStore, seed: SeedFile): { applied: number } {
  const now = new Date().toISOString();
  let applied = 0;
  const pinEvidence = (snippet: string): Evidence[] => [
    { file: '.archmap/seed.yaml', line: 1, snippet },
  ];

  for (const svc of seed.services ?? []) {
    const id = svc.id.startsWith('svc:') ? svc.id : serviceId(svc.id);
    store.upsertNode({
      id,
      kind: 'Service',
      name: svc.id.replace(/^svc:/, ''),
      path: svc.paths?.[0],
      updated_at: now,
      metadata: { paths: svc.paths, owns_tables: svc.owns_tables, owns_routes: svc.owns_routes },
      tags: ['seed'],
    });
    applied++;
  }

  for (const ext of seed.externals ?? []) {
    const id = ext.id.startsWith('ext:') ? ext.id : externalId(ext.id);
    store.upsertNode({
      id,
      kind: 'External',
      name: ext.id.replace(/^ext:/, ''),
      updated_at: now,
      tags: ['seed'],
    });
    for (const route of ext.consumes ?? []) {
      const normalized = normalizeRoute(route);
      store.upsertEdgeByEndpoints(
        'CONSUMES',
        id,
        normalized,
        pinEvidence(`${ext.id} consumes ${route}`),
        ['user']
      );
    }
    applied++;
  }

  for (const pin of seed.pins ?? []) {
    if (!pin.type || !pin.from || !pin.to) continue;
    store.upsertEdgeByEndpoints(
      pin.type,
      pin.from,
      pin.to,
      pinEvidence(pin.evidence ?? 'seed pin'),
      ['user']
    );
    applied++;
  }

  for (const id of seed.critical ?? []) {
    const node = store.resolveNode(id);
    if (!node) continue;
    const tags = new Set(node.tags ?? []);
    tags.add('critical');
    store.upsertNode({ ...node, tags: [...tags], updated_at: now });
    applied++;
  }

  return { applied };
}

function normalizeRoute(route: string): string {
  if (route.startsWith('api:')) return route;
  const m = route.match(/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+(\/\S+)/i);
  if (m) return `api:${m[1].toUpperCase()}:${m[2]}`;
  return route;
}
