// Core tests — conformance fixtures and unit tests.
// Tests the one graph, impact algorithm, and canonical contracts.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GraphStore } from '../src/core/store.js';
import { computeImpact } from '../src/core/impact.js';
import { computeDiffImpact, diffSymbols } from '../src/core/diff.js';
import { evaluatePolicies } from '../src/core/policy.js';
import { RAGIndex } from '../src/core/rag.js';
import { healthCheck } from '../src/core/health.js';
import { reconstructFlow } from '../src/core/flow.js';
import { Journal } from '../src/core/journal.js';
import { envelope, errorEnvelope } from '../src/core/types.js';
import { findWhyPaths } from '../src/core/why.js';
import { computeInsights } from '../src/core/insights.js';
import { projectView } from '../src/core/views.js';
import { explainImpact } from '../src/core/explain.js';
import { planChange } from '../src/core/plan.js';
import { resolveDocs } from '../src/core/docs.js';
import type { GraphNode, GraphEdge } from '../src/core/types.js';
import {
  fileId, functionId, classId, tableId, edgeId, apiId, externalId,
} from '../src/core/ids.js';

// ─── Helpers ───────────────────────────────────────────────────────────────────

let tmpDir: string;
let store: GraphStore;

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

// ─── Conformance Fixture ───────────────────────────────────────────────────────
// A fixed small graph that all deterministic tests run against.

function buildConformanceGraph(): void {
  const now = new Date().toISOString();

  // Services
  const nodes: GraphNode[] = [
    makeNode({ id: 'fn:catalog/service.ts:createItem', name: 'createItem', path: 'catalog/service.ts', kind: 'Function' }),
    makeNode({ id: 'fn:catalog/service.ts:validateItem', name: 'validateItem', path: 'catalog/service.ts', kind: 'Function' }),
    makeNode({ id: 'fn:catalog/service.ts:archiveItem', name: 'archiveItem', path: 'catalog/service.ts', kind: 'Function' }),
    makeNode({ id: 'fn:search/service.ts:indexItem', name: 'indexItem', path: 'search/service.ts', kind: 'Function' }),
    makeNode({ id: 'fn:search/service.ts:getIndexed', name: 'getIndexed', path: 'search/service.ts', kind: 'Function' }),
    makeNode({ id: 'fn:routes.ts:handleCreateItem', name: 'handleCreateItem', path: 'routes.ts', kind: 'Function' }),
    makeNode({ id: 'fn:routes.ts:handleArchive', name: 'handleArchive', path: 'routes.ts', kind: 'Function' }),
    makeNode({ id: 'api:POST:/items', name: 'POST /items', kind: 'API', path: 'api.yaml' }),
    makeNode({ id: 'api:POST:/items/:id/archive', name: 'POST /items/:id/archive', kind: 'API', path: 'api.yaml' }),
    makeNode({ id: 'table:items', name: 'items', kind: 'Table', path: 'schema.sql' }),
    makeNode({ id: 'table:orders', name: 'orders', kind: 'Table', path: 'schema.sql' }),
    makeNode({ id: 'ext:@notify/sdk', name: '@notify/sdk', kind: 'External' }),
    makeNode({ id: 'test:catalog/service.test.ts:testCreateItem', name: 'testCreateItem', path: 'catalog/service.test.ts', kind: 'Test' }),
    makeNode({ id: 'cls:catalog/service.ts:CatalogService', name: 'CatalogService', path: 'catalog/service.ts', kind: 'Class' }),
    makeNode({ id: 'file:catalog/service.ts', name: 'service.ts', path: 'catalog/service.ts', kind: 'File', lang: 'typescript' }),
  ];

  store.upsertNodes(nodes);

  const edges: GraphEdge[] = [
    // createItem calls validateItem
    makeEdge({ id: 'e_pp_vt', type: 'CALLS', from: 'fn:catalog/service.ts:createItem', to: 'fn:catalog/service.ts:validateItem',
      evidence: [{ file: 'catalog/service.ts', line: 18, snippet: 'validateItem(tx)' }] }),
    makeEdge({ id: 'e_pp_wp', type: 'WRITES', from: 'fn:catalog/service.ts:createItem', to: 'table:items',
      evidence: [{ file: 'catalog/service.ts', line: 25, snippet: 'INSERT INTO items' }] }),
    makeEdge({ id: 'e_pp_ext', type: 'CALLS', from: 'fn:catalog/service.ts:createItem', to: 'ext:@notify/sdk',
      evidence: [{ file: 'catalog/service.ts', line: 20, snippet: 'NotifySDK.send()' }] }),
    // handleCreateItem calls createItem
    makeEdge({ id: 'e_hp_pp', type: 'CALLS', from: 'fn:routes.ts:handleCreateItem', to: 'fn:catalog/service.ts:createItem',
      evidence: [{ file: 'routes.ts', line: 5, snippet: 'createItem(req.body)' }] }),
    makeEdge({ id: 'e_hp_api', type: 'EXPOSES', from: 'fn:routes.ts:handleCreateItem', to: 'api:POST:/items',
      evidence: [{ file: 'routes.ts', line: 3, snippet: "app.post('/items'" }] }),
    // indexItem calls createItem
    makeEdge({ id: 'e_co_pp', type: 'CALLS', from: 'fn:search/service.ts:indexItem', to: 'fn:catalog/service.ts:createItem',
      evidence: [{ file: 'search/service.ts', line: 10, snippet: 'createItem(order)' }] }),
    // test covers createItem
    makeEdge({ id: 'e_test_pp', type: 'TESTS', from: 'test:catalog/service.test.ts:testCreateItem', to: 'fn:catalog/service.ts:createItem',
      evidence: [{ file: 'catalog/service.test.ts', line: 5, snippet: 'it(createItem)' }] }),
    // file contains function
    makeEdge({ id: 'e_f_pp', type: 'CONTAINS', from: 'file:catalog/service.ts', to: 'fn:catalog/service.ts:createItem',
      evidence: [] }),
  ];

  store.upsertEdges(edges);
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('IDs', () => {
  it('generates stable node IDs', () => {
    expect(fileId('src/app.ts')).toBe('file:src/app.ts');
    expect(functionId('src/app.ts', 'main')).toBe('fn:src/app.ts:main');
    expect(classId('src/app.ts', 'App')).toBe('cls:src/app.ts:App');
    expect(tableId('users')).toBe('table:users');
    expect(apiId('POST', '/api/v1')).toBe('api:POST:/api/v1');
    expect(externalId('lodash')).toBe('ext:lodash');
  });

  it('generates deterministic edge IDs', () => {
    const id1 = edgeId('fn:a', 'fn:b', 'CALLS');
    const id2 = edgeId('fn:a', 'fn:b', 'CALLS');
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^e_[a-f0-9]{12}$/);
  });

  it('generates different edge IDs for different endpoints', () => {
    const id1 = edgeId('fn:a', 'fn:b', 'CALLS');
    const id2 = edgeId('fn:a', 'fn:c', 'CALLS');
    expect(id1).not.toBe(id2);
  });
});

describe('GraphStore', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'archmap-test-'));
    store = new GraphStore(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('upserts and retrieves nodes', () => {
    const node = makeNode({ id: 'fn:test.ts:foo', name: 'foo' });
    store.upsertNode(node);
    const retrieved = store.getNode('fn:test.ts:foo');
    expect(retrieved).toBeDefined();
    expect(retrieved!.name).toBe('foo');
    expect(retrieved!.kind).toBe('Function');
  });

  it('upserts and retrieves edges', () => {
    store.upsertNode(makeNode({ id: 'fn:a', name: 'a' }));
    store.upsertNode(makeNode({ id: 'fn:b', name: 'b' }));
    const edge = makeEdge({ id: 'e_test', type: 'CALLS', from: 'fn:a', to: 'fn:b' });
    store.upsertEdge(edge);
    const retrieved = store.getEdge('e_test');
    expect(retrieved).toBeDefined();
    expect(retrieved!.type).toBe('CALLS');
  });

  it('lists nodes by kind', () => {
    store.upsertNode(makeNode({ id: 'fn:a', name: 'a', kind: 'Function' }));
    store.upsertNode(makeNode({ id: 'fn:b', name: 'b', kind: 'Function' }));
    store.upsertNode(makeNode({ id: 'cls:c', name: 'c', kind: 'Class' }));
    const fns = store.listNodes('Function');
    expect(fns).toHaveLength(2);
    const classes = store.listNodes('Class');
    expect(classes).toHaveLength(1);
  });

  it('searches nodes', () => {
    store.upsertNode(makeNode({ id: 'fn:a', name: 'createItem' }));
    store.upsertNode(makeNode({ id: 'fn:b', name: 'validateItem' }));
    const results = store.searchNodes('process');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].name).toBe('createItem');
  });

  it('returns neighbors', () => {
    store.upsertNode(makeNode({ id: 'fn:a', name: 'a' }));
    store.upsertNode(makeNode({ id: 'fn:b', name: 'b' }));
    store.upsertEdge(makeEdge({ id: 'e_1', type: 'CALLS', from: 'fn:a', to: 'fn:b' }));
    const outEdges = store.getOutEdges('fn:a');
    expect(outEdges).toHaveLength(1);
    const inEdges = store.getInEdges('fn:b');
    expect(inEdges).toHaveLength(1);
  });

  it('validates graph', () => {
    store.upsertNode(makeNode({ id: 'fn:a', name: 'a' }));
    const result = store.validateGraph();
    expect(result.ok).toBe(true);
  });

  it('detects dangling edges', () => {
    store.upsertNode(makeNode({ id: 'fn:a', name: 'a' }));
    store.upsertEdge(makeEdge({ id: 'e_bad', type: 'CALLS', from: 'fn:a', to: 'fn:nonexistent' }));
    const result = store.validateGraph();
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('runs transactions', () => {
    store.transaction(() => {
      store.upsertNode(makeNode({ id: 'fn:tx', name: 'tx' }));
    });
    expect(store.getNode('fn:tx')).toBeDefined();
  });
});

describe('Impact Algorithm', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'archmap-test-'));
    store = new GraphStore(join(tmpDir, 'test.db'));
    buildConformanceGraph();
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('computes downstream impact from createItem', () => {
    const result = computeImpact(store, ['fn:catalog/service.ts:createItem'], {
      direction: 'downstream',
      maxDepth: 5,
    });

    expect(result.ok).toBe(true);
    expect(result.startIds).toEqual(['fn:catalog/service.ts:createItem']);
    expect(result.direction).toBe('downstream');
    const ids = result.nodes.map(n => n.id);
    // Callers, writers, tests, APIs — not callees (those are upstream).
    expect(ids).toContain('fn:catalog/service.ts:createItem');
    expect(ids).toContain('table:items');
    expect(ids).toContain('fn:routes.ts:handleCreateItem');
    expect(ids).toContain('fn:search/service.ts:indexItem');
    expect(ids).not.toContain('fn:catalog/service.ts:validateItem');
    expect(result.edges.length).toBeGreaterThanOrEqual(1);
  });

  it('computes upstream impact', () => {
    const result = computeImpact(store, ['fn:catalog/service.ts:createItem'], {
      direction: 'upstream',
      maxDepth: 5,
    });

    expect(result.ok).toBe(true);
    // Upstream = what this node depends on (its callees/imports)
    const nodeIds = result.nodes.map(n => n.id);
    expect(nodeIds).toContain('fn:catalog/service.ts:validateItem');
  });

  it('generates why-paths', () => {
    const result = computeImpact(store, ['fn:catalog/service.ts:createItem'], {
      direction: 'downstream',
      maxPaths: 7,
    });

    expect(result.paths.length).toBeGreaterThan(0);
    for (const path of result.paths) {
      expect(path.steps.length).toBeGreaterThan(0);
      expect(path.steps[0].edgeType).toBeDefined();
    }
  });

  it('identifies risk chips', () => {
    const result = computeImpact(store, ['fn:catalog/service.ts:createItem'], {
      direction: 'downstream',
    });

    // Should detect DB write risk
    const dbWriteRisk = result.riskChips.find(r => r.kind === 'db_write');
    expect(dbWriteRisk).toBeDefined();

    // Should detect external dependency
    const extRisk = result.riskChips.find(r => r.kind === 'external');
    expect(extRisk).toBeDefined();
  });

  it('respects maxDepth', () => {
    const result = computeImpact(store, ['fn:catalog/service.ts:createItem'], {
      direction: 'downstream',
      maxDepth: 0,
    });

    // With depth 0, should only return the start node
    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].id).toBe('fn:catalog/service.ts:createItem');
  });

  it('returns empty for non-existent node', () => {
    const result = computeImpact(store, ['fn:nonexistent'], {
      direction: 'downstream',
    });
    expect(result.nodes).toHaveLength(0);
  });
});

describe('Diff Impact', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'archmap-test-'));
    store = new GraphStore(join(tmpDir, 'test.db'));
    buildConformanceGraph();
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('computes diff impact', () => {
    const result = computeDiffImpact(store, 'main', 'HEAD');
    expect(result.ok).toBe(true);
    expect(result.base).toBe('main');
    expect(result.head).toBe('HEAD');
  });
});

describe('Policy Evaluation', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'archmap-test-'));
    store = new GraphStore(join(tmpDir, 'test.db'));
    buildConformanceGraph();
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('evaluates built-in policies', () => {
    const result = evaluatePolicies(store);
    expect(result.ok).toBeDefined();
    expect(Array.isArray(result.violations)).toBe(true);
  });

  it('warns on critical nodes without tests', () => {
    // Add a critical node with no tests
    store.upsertNode(makeNode({
      id: 'fn:critical.ts:doStuff',
      name: 'doStuff',
      path: 'critical.ts',
      tags: ['critical'],
    }));
    const result = evaluatePolicies(store);
    const testViolation = result.violations.find(v => v.policyId === 'critical-must-have-tests');
    expect(testViolation).toBeDefined();
    expect(testViolation!.severity).toBe('warning');
  });
});

describe('RAG Search', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'archmap-test-'));
    store = new GraphStore(join(tmpDir, 'test.db'));
    buildConformanceGraph();
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('indexes and searches nodes', () => {
    const rag = new RAGIndex();
    rag.indexNodes(store);
    expect(rag.chunkCount).toBeGreaterThan(0);

    const results = rag.searchWithNodes(store, 'createItem');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('ranks exact matches higher', () => {
    const rag = new RAGIndex();
    rag.indexNodes(store);

    const results = rag.searchWithNodes(store, 'createItem');
    const exactMatch = results.find(r => r.node.name === 'createItem');
    expect(exactMatch).toBeDefined();
    expect(exactMatch!.score).toBeGreaterThanOrEqual(0.5);
  });
});

describe('Health Check', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'archmap-test-'));
    store = new GraphStore(join(tmpDir, 'test.db'));
    buildConformanceGraph();
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns health rows', () => {
    const rows = healthCheck(store);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some(r => r.category === 'graph')).toBe(true);
  });
});

describe('Flow Reconstruction', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'archmap-test-'));
    store = new GraphStore(join(tmpDir, 'test.db'));
    buildConformanceGraph();
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reconstructs flow from handleCreateItem', () => {
    const result = reconstructFlow(store, 'fn:routes.ts:handleCreateItem');
    expect(result.ok).toBe(true);
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.steps[0].nodeId).toBe('fn:routes.ts:handleCreateItem');
  });
});

describe('Journal', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'archmap-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appends and reads entries', () => {
    const journal = new Journal(tmpDir);
    journal.append('test_event', { key: 'value' });
    const entries = journal.recent();
    expect(entries.length).toBe(1);
    expect(entries[0].event).toBe('test_event');
    expect(entries[0].details.key).toBe('value');
  });
});

describe('Canonical Envelope', () => {
  it('wraps data in envelope', () => {
    const result = envelope({ foo: 'bar' });
    expect(result.ok).toBe(true);
    expect(result.version).toBe('0.1.0');
    expect(result.data).toEqual({ foo: 'bar' });
    expect(result.timestamp).toBeDefined();
  });

  it('wraps errors', () => {
    const result = errorEnvelope('something broke');
    expect(result.ok).toBe(false);
    expect(result.data.error).toBe('something broke');
  });
});

describe('Why paths', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'archmap-test-'));
    store = new GraphStore(join(tmpDir, 'test.db'));
    buildConformanceGraph();
  });
  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds an evidence-backed path from function to table', () => {
    const paths = findWhyPaths(store, 'fn:catalog/service.ts:createItem', 'table:items');
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0].steps.some(s => s.edgeType === 'WRITES')).toBe(true);
    expect(paths[0].evidence.length).toBeGreaterThan(0);
  });
});

describe('Insights', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'archmap-test-'));
    store = new GraphStore(join(tmpDir, 'test.db'));
    buildConformanceGraph();
  });
  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports hubs and downstream impact', () => {
    const result = computeInsights(store);
    expect(result.ok).toBe(true);
    expect(result.hubs.length).toBeGreaterThan(0);
    expect(result.largeDownstream.length).toBeGreaterThan(0);
  });
});

describe('Views', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'archmap-test-'));
    store = new GraphStore(join(tmpDir, 'test.db'));
    buildConformanceGraph();
  });
  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('height view prefers architecture nodes over files', () => {
    const view = projectView(store, 'height');
    expect(view.mode).toBe('height');
    expect(view.nodes.some(n => n.kind === 'API' || n.kind === 'Table' || n.kind === 'External')).toBe(true);
  });
});

describe('Explain and plan', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'archmap-test-'));
    store = new GraphStore(join(tmpDir, 'test.db'));
    buildConformanceGraph();
  });
  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('explains impact in plain language', () => {
    const impact = computeImpact(store, ['fn:catalog/service.ts:createItem']);
    const text = explainImpact(store, impact);
    expect(text.summary.length).toBeGreaterThan(10);
    expect(text.title).toContain('createItem');
  });

  it('builds a change envelope', () => {
    const node = store.getNode('fn:catalog/service.ts:createItem')!;
    const plan = planChange(store, node);
    expect(plan.allowedFiles).toContain('catalog/service.ts');
    expect(plan.impacted.length).toBeGreaterThan(0);
  });

  it('resolves in-repo docs without inventing APIs', () => {
    store.upsertNode(makeNode({
      id: 'doc:README.md',
      name: 'Payments platform',
      kind: 'Doc',
      path: 'README.md',
    }));
    const docs = resolveDocs(store, 'payments');
    expect(docs.docs.some(d => d.id === 'doc:README.md')).toBe(true);
  });
});


