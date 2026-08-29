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
    makeNode({ id: 'fn:payments/service.ts:processPayment', name: 'processPayment', path: 'payments/service.ts', kind: 'Function' }),
    makeNode({ id: 'fn:payments/service.ts:validateTransaction', name: 'validateTransaction', path: 'payments/service.ts', kind: 'Function' }),
    makeNode({ id: 'fn:payments/service.ts:refundPayment', name: 'refundPayment', path: 'payments/service.ts', kind: 'Function' }),
    makeNode({ id: 'fn:orders/service.ts:createOrder', name: 'createOrder', path: 'orders/service.ts', kind: 'Function' }),
    makeNode({ id: 'fn:orders/service.ts:getOrder', name: 'getOrder', path: 'orders/service.ts', kind: 'Function' }),
    makeNode({ id: 'fn:routes.ts:handlePayment', name: 'handlePayment', path: 'routes.ts', kind: 'Function' }),
    makeNode({ id: 'fn:routes.ts:handleRefund', name: 'handleRefund', path: 'routes.ts', kind: 'Function' }),
    makeNode({ id: 'api:POST:/payments', name: 'POST /payments', kind: 'API', path: 'api.yaml' }),
    makeNode({ id: 'api:POST:/payments/:id/refund', name: 'POST /payments/:id/refund', kind: 'API', path: 'api.yaml' }),
    makeNode({ id: 'table:payments', name: 'payments', kind: 'Table', path: 'schema.sql' }),
    makeNode({ id: 'table:orders', name: 'orders', kind: 'Table', path: 'schema.sql' }),
    makeNode({ id: 'ext:@payments/sdk', name: '@payments/sdk', kind: 'External' }),
    makeNode({ id: 'test:payments/service.test.ts:testProcessPayment', name: 'testProcessPayment', path: 'payments/service.test.ts', kind: 'Test' }),
    makeNode({ id: 'cls:payments/service.ts:PaymentService', name: 'PaymentService', path: 'payments/service.ts', kind: 'Class' }),
    makeNode({ id: 'file:payments/service.ts', name: 'service.ts', path: 'payments/service.ts', kind: 'File', lang: 'typescript' }),
  ];

  store.upsertNodes(nodes);

  const edges: GraphEdge[] = [
    // processPayment calls validateTransaction
    makeEdge({ id: 'e_pp_vt', type: 'CALLS', from: 'fn:payments/service.ts:processPayment', to: 'fn:payments/service.ts:validateTransaction',
      evidence: [{ file: 'payments/service.ts', line: 18, snippet: 'validateTransaction(tx)' }] }),
    // processPayment writes payments table
    makeEdge({ id: 'e_pp_wp', type: 'WRITES', from: 'fn:payments/service.ts:processPayment', to: 'table:payments',
      evidence: [{ file: 'payments/service.ts', line: 25, snippet: 'INSERT INTO payments' }] }),
    // processPayment calls external SDK
    makeEdge({ id: 'e_pp_ext', type: 'CALLS', from: 'fn:payments/service.ts:processPayment', to: 'ext:@payments/sdk',
      evidence: [{ file: 'payments/service.ts', line: 20, snippet: 'PaymentSDK.charge()' }] }),
    // handlePayment calls processPayment
    makeEdge({ id: 'e_hp_pp', type: 'CALLS', from: 'fn:routes.ts:handlePayment', to: 'fn:payments/service.ts:processPayment',
      evidence: [{ file: 'routes.ts', line: 5, snippet: 'processPayment(req.body)' }] }),
    // POST /payments exposed by handlePayment
    makeEdge({ id: 'e_hp_api', type: 'EXPOSES', from: 'fn:routes.ts:handlePayment', to: 'api:POST:/payments',
      evidence: [{ file: 'routes.ts', line: 3, snippet: "app.post('/payments'" }] }),
    // createOrder calls processPayment
    makeEdge({ id: 'e_co_pp', type: 'CALLS', from: 'fn:orders/service.ts:createOrder', to: 'fn:payments/service.ts:processPayment',
      evidence: [{ file: 'orders/service.ts', line: 10, snippet: 'processPayment(order)' }] }),
    // test covers processPayment
    makeEdge({ id: 'e_test_pp', type: 'TESTS', from: 'test:payments/service.test.ts:testProcessPayment', to: 'fn:payments/service.ts:processPayment',
      evidence: [{ file: 'payments/service.test.ts', line: 5, snippet: 'it(processPayment)' }] }),
    // file contains function
    makeEdge({ id: 'e_f_pp', type: 'CONTAINS', from: 'file:payments/service.ts', to: 'fn:payments/service.ts:processPayment',
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
    store.upsertNode(makeNode({ id: 'fn:a', name: 'processPayment' }));
    store.upsertNode(makeNode({ id: 'fn:b', name: 'validateTransaction' }));
    const results = store.searchNodes('process');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].name).toBe('processPayment');
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

  it('computes downstream impact from processPayment', () => {
    const result = computeImpact(store, ['fn:payments/service.ts:processPayment'], {
      direction: 'downstream',
      maxDepth: 5,
    });

    expect(result.ok).toBe(true);
    expect(result.startIds).toEqual(['fn:payments/service.ts:processPayment']);
    expect(result.direction).toBe('downstream');
    // Should find at least: processPayment, validateTransaction, external, payments table
    expect(result.nodes.length).toBeGreaterThanOrEqual(2);
    expect(result.edges.length).toBeGreaterThanOrEqual(1);
  });

  it('computes upstream impact', () => {
    const result = computeImpact(store, ['fn:payments/service.ts:processPayment'], {
      direction: 'upstream',
      maxDepth: 5,
    });

    expect(result.ok).toBe(true);
    // Upstream = what this node depends on (its callees/imports)
    const nodeIds = result.nodes.map(n => n.id);
    expect(nodeIds).toContain('fn:payments/service.ts:validateTransaction');
  });

  it('generates why-paths', () => {
    const result = computeImpact(store, ['fn:payments/service.ts:processPayment'], {
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
    const result = computeImpact(store, ['fn:payments/service.ts:processPayment'], {
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
    const result = computeImpact(store, ['fn:payments/service.ts:processPayment'], {
      direction: 'downstream',
      maxDepth: 0,
    });

    // With depth 0, should only return the start node
    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].id).toBe('fn:payments/service.ts:processPayment');
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

    const results = rag.searchWithNodes(store, 'processPayment');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('ranks exact matches higher', () => {
    const rag = new RAGIndex();
    rag.indexNodes(store);

    const results = rag.searchWithNodes(store, 'processPayment');
    const exactMatch = results.find(r => r.node.name === 'processPayment');
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

  it('reconstructs flow from handlePayment', () => {
    const result = reconstructFlow(store, 'fn:routes.ts:handlePayment');
    expect(result.ok).toBe(true);
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.steps[0].nodeId).toBe('fn:routes.ts:handlePayment');
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
