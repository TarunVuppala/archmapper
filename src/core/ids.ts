// Stable ID generation for the Architecture Mapper graph.
// IDs are deterministic and follow the documented scheme:
//   fn:path:qualname, api:METHOD:path, table:name, etc.

import { createHash } from 'node:crypto';
import type { NodeKind } from './types.js';

// ─── Node ID builders ──────────────────────────────────────────────────────────

export function fileId(relPath: string): string {
  return `file:${posixPath(relPath)}`;
}

export function moduleId(relPath: string): string {
  return `mod:${posixPath(relPath)}`;
}

export function packageId(name: string, version?: string): string {
  return version ? `pkg:${name}@${version}` : `pkg:${name}`;
}

export function classId(relPath: string, className: string): string {
  return `cls:${posixPath(relPath)}:${className}`;
}

export function interfaceId(relPath: string, name: string): string {
  return `iface:${posixPath(relPath)}:${name}`;
}

export function functionId(relPath: string, qualName: string): string {
  return `fn:${posixPath(relPath)}:${qualName}`;
}

export function methodId(relPath: string, qualName: string): string {
  return `fn:${posixPath(relPath)}:${qualName}`;
}

export function serviceId(serviceId: string): string {
  return `svc:${serviceId}`;
}

export function apiId(method: string, path: string): string {
  return `api:${method.toUpperCase()}:${path}`;
}

export function tableId(name: string): string {
  return `table:${name}`;
}

export function columnId(table: string, name: string): string {
  return `col:${table}.${name}`;
}

export function eventId(name: string): string {
  return `event:${name}`;
}

export function jobId(relPath: string, name: string): string {
  return `job:${posixPath(relPath)}:${name}`;
}

export function testId(relPath: string, name: string): string {
  return `test:${posixPath(relPath)}:${name}`;
}

export function externalId(packageOrSystem: string): string {
  return `ext:${packageOrSystem}`;
}

export function infraId(relPath: string): string {
  return `infra:${posixPath(relPath)}`;
}

export function docId(urlOrPath: string): string {
  return `doc:${urlOrPath}`;
}

export function configKeyId(key: string): string {
  return `cfg:${key}`;
}

export function repoId(name: string): string {
  return `repo:${name}`;
}

// ─── Edge ID ───────────────────────────────────────────────────────────────────

export function edgeId(from: string, to: string, type: string): string {
  const hash = createHash('sha256')
    .update(`${from}|${to}|${type}`)
    .digest('hex')
    .slice(0, 12);
  return `e_${hash}`;
}

// ─── Utility ───────────────────────────────────────────────────────────────────

function posixPath(p: string): string {
  return p.replace(/\\/g, '/');
}

// ─── Parse ID prefix to infer kind ─────────────────────────────────────────────

export function kindFromId(id: string): NodeKind | undefined {
  const prefix = id.split(':')[0];
  const map: Record<string, NodeKind> = {
    repo: 'Repo',
    file: 'File',
    mod: 'Module',
    pkg: 'Package',
    cls: 'Class',
    iface: 'Interface',
    fn: 'Function',
    svc: 'Service',
    api: 'API',
    table: 'Table',
    col: 'Column',
    event: 'Event',
    job: 'Job',
    test: 'Test',
    ext: 'External',
    infra: 'Infra',
    doc: 'Doc',
    cfg: 'ConfigKey',
  };
  return map[prefix];
}

// ─── Normalize ─────────────────────────────────────────────────────────────────

export function normalizeId(raw: string): string {
  return raw.trim();
}
