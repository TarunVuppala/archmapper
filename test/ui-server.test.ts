// UI Server tests — verifies HTTP API endpoints and HTML serving.
// Tests that the visualizer server correctly serves the D3 UI and graph data.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GraphStore } from '../src/core/store.js';
import { fileId, functionId, edgeId, tableId, apiId } from '../src/core/ids.js';
import type { GraphNode, GraphEdge } from '../src/core/types.js';

let tmpDir: string;
let store: GraphStore;
let serverPort: number;
let serverUrl: string;

function makeNode(overrides: Partial<GraphNode> & { id: string; name: string }): GraphNode {
  return {
    kind: 'Function',
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeEdge(overrides: Partial<GraphEdge> & { id: string; from: string; to: string; type: GraphEdge['type'] }): GraphEdge {
  return {
    evidence: [],
    sources: ['parser'],
    confidence: 1.0,
    conflict: false,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

beforeAll(async () => {
  // Create temp directory with .archmap/index.db
  tmpDir = mkdtempSync(join(tmpdir(), 'archmap-ui-test-'));
  const archmapDir = join(tmpDir, '.archmap');
  mkdirSync(archmapDir, { recursive: true });

  // Initialize store with test data
  store = new GraphStore(join(archmapDir, 'index.db'));

  // Seed minimal graph: file → function → table, file → API
  const fId = fileId('src/app.ts');
  const fnId = functionId('src/app.ts', 'processOrder');
  const tblId = tableId('orders');
  const apiIdVal = apiId('POST', '/orders');

  store.upsertNode(makeNode({ id: fId, kind: 'File', name: 'app.ts', path: 'src/app.ts' }));
  store.upsertNode(makeNode({ id: fnId, kind: 'Function', name: 'processOrder', path: 'src/app.ts', signature: 'function processOrder()' }));
  store.upsertNode(makeNode({ id: tblId, kind: 'Table', name: 'orders' }));
  store.upsertNode(makeNode({ id: apiIdVal, kind: 'API', name: 'POST /orders' }));

  store.upsertEdge(makeEdge({ id: edgeId(fId, fnId, 'CONTAINS'), type: 'CONTAINS', from: fId, to: fnId }));
  store.upsertEdge(makeEdge({ id: edgeId(fnId, tblId, 'WRITES'), type: 'WRITES', from: fnId, to: tblId }));
  store.upsertEdge(makeEdge({ id: edgeId(fnId, apiIdVal, 'EXPOSES'), type: 'EXPOSES', from: fnId, to: apiIdVal }));

  store.close();

  // Start UI server on a random port
  serverPort = 19876 + Math.floor(Math.random() * 1000);
  serverUrl = `http://127.0.0.1:${serverPort}`;

  // Dynamically import and start
  const { startUIServer } = await import('../src/ui/server.js');

  // Override the working directory so the server finds our temp .archmap
  const originalCwd = process.cwd;
  process.cwd = () => tmpDir;

  // Start server in background (don't await - it listens)
  startUIServer(serverPort).catch(() => {});

  // Wait for server to be ready
  await new Promise(resolve => setTimeout(resolve, 500));

  // Restore cwd
  process.cwd = originalCwd;
});

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Windows: SQLite file lock may prevent cleanup — ignore
  }
});

describe('UI Server HTTP API', () => {
  it('GET / returns HTML with D3 visualizer', async () => {
    const res = await fetch(serverUrl);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Archmap');
    expect(html).toContain('d3.min.js');
    expect(html).toContain('svg#visualizer');
    expect(html).toContain('archmap-ui.js');
  });

  it('GET /api/graph returns nodes and edges', async () => {
    const res = await fetch(`${serverUrl}/api/graph`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.nodes).toBeDefined();
    expect(data.edges).toBeDefined();
    expect(Array.isArray(data.nodes)).toBe(true);
    expect(Array.isArray(data.edges)).toBe(true);
    expect(data.nodes.length).toBeGreaterThan(0);
    expect(data.edges.length).toBeGreaterThan(0);
  });

  it('GET /api/neighbors/:id returns edges and neighbor nodes', async () => {
    const fnId = 'fn:src/app.ts:processOrder';
    const res = await fetch(`${serverUrl}/api/neighbors/${encodeURIComponent(fnId)}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.edges).toBeDefined();
    expect(data.nodes).toBeDefined();
    expect(Array.isArray(data.edges)).toBe(true);
    expect(data.edges.length).toBeGreaterThan(0);
  });

  it('GET /api/impact/:id returns impact envelope', async () => {
    const fnId = 'fn:src/app.ts:processOrder';
    const res = await fetch(`${serverUrl}/api/impact/${encodeURIComponent(fnId)}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.data).toBeDefined();
    expect(data.data.counts).toBeDefined();
    expect(data.data.riskChips).toBeDefined();
  });

  it('GET /api/health returns health check', async () => {
    const res = await fetch(`${serverUrl}/api/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.data).toBeDefined();
  });
});
