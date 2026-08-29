// SQLite graph store — the ONE graph of record.
// Uses node:sqlite (built-in since Node 22.5+).

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { GraphNode, GraphEdge, EdgeKind, NodeKind } from './types.js';
import { edgeId } from './ids.js';

export class GraphStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        path TEXT,
        lang TEXT,
        signature TEXT,
        start_line INTEGER,
        end_line INTEGER,
        metadata TEXT,
        tags TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS edges (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        "from" TEXT NOT NULL,
        "to" TEXT NOT NULL,
        evidence TEXT NOT NULL DEFAULT '[]',
        sources TEXT NOT NULL DEFAULT '[]',
        confidence REAL NOT NULL DEFAULT 1.0,
        conflict INTEGER NOT NULL DEFAULT 0,
        metadata TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_edges_from ON edges("from");
      CREATE INDEX IF NOT EXISTS idx_edges_to ON edges("to");
      CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(type);
      CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
      CREATE INDEX IF NOT EXISTS idx_nodes_path ON nodes(path);
      CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
    `);
  }

  // ─── Node Operations ───────────────────────────────────────────────────────

  upsertNode(node: GraphNode): void {
    const stmt = this.db.prepare(`
      INSERT INTO nodes (id, kind, name, path, lang, signature, start_line, end_line, metadata, tags, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind=excluded.kind,
        name=excluded.name,
        path=excluded.path,
        lang=excluded.lang,
        signature=excluded.signature,
        start_line=excluded.start_line,
        end_line=excluded.end_line,
        metadata=excluded.metadata,
        tags=excluded.tags,
        updated_at=excluded.updated_at
    `);
    stmt.run(
      node.id,
      node.kind,
      node.name,
      node.path ?? null,
      node.lang ?? null,
      node.signature ?? null,
      node.startLine ?? null,
      node.endLine ?? null,
      node.metadata ? JSON.stringify(node.metadata) : null,
      node.tags ? JSON.stringify(node.tags) : null,
      node.updated_at
    );
  }

  getNode(id: string): GraphNode | undefined {
    const stmt = this.db.prepare('SELECT * FROM nodes WHERE id = ?');
    const row = stmt.get(id) as any;
    if (!row) return undefined;
    return this.rowToNode(row);
  }

  listNodes(kind?: NodeKind, limit = 1000, offset = 0): GraphNode[] {
    let sql = 'SELECT * FROM nodes';
    const params: any[] = [];
    if (kind) {
      sql += ' WHERE kind = ?';
      params.push(kind);
    }
    sql += ' ORDER BY name LIMIT ? OFFSET ?';
    params.push(limit, offset);
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as any[];
    return rows.map(r => this.rowToNode(r));
  }

  searchNodes(query: string, limit = 50): GraphNode[] {
    const stmt = this.db.prepare(
      'SELECT * FROM nodes WHERE name LIKE ? OR path LIKE ? OR id LIKE ? ORDER BY name LIMIT ?'
    );
    const like = `%${query}%`;
    const rows = stmt.all(like, like, like, limit) as any[];
    return rows.map(r => this.rowToNode(r));
  }

  countNodes(kind?: NodeKind): number {
    if (kind) {
      const stmt = this.db.prepare('SELECT COUNT(*) as cnt FROM nodes WHERE kind = ?');
      const row = stmt.get(kind) as any;
      return row.cnt;
    }
    const stmt = this.db.prepare('SELECT COUNT(*) as cnt FROM nodes');
    const row = stmt.get() as any;
    return row.cnt;
  }

  deleteNode(id: string): void {
    this.db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
  }

  // ─── Edge Operations ───────────────────────────────────────────────────────

  upsertEdge(edge: GraphEdge): void {
    // Check for existing edge to merge evidence properly
    const existing = this.getEdge(edge.id);
    if (existing && !edge.conflict) {
      // Merge evidence arrays into one
      const mergedEvidence = [...existing.evidence, ...edge.evidence];
      // Deduplicate by file+line
      const seen = new Set<string>();
      const deduped = mergedEvidence.filter(e => {
        const key = `${e.file}:${e.line}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      edge.evidence = deduped;
      edge.sources = [...new Set([...existing.sources, ...edge.sources])];
      edge.confidence = Math.max(existing.confidence, edge.confidence);
    }

    const stmt = this.db.prepare(`
      INSERT INTO edges (id, type, "from", "to", evidence, sources, confidence, conflict, metadata, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        type=excluded.type,
        evidence=excluded.evidence,
        sources=excluded.sources,
        confidence=excluded.confidence,
        conflict=excluded.conflict | edges.conflict,
        metadata=excluded.metadata,
        updated_at=excluded.updated_at
    `);
    stmt.run(
      edge.id,
      edge.type,
      edge.from,
      edge.to,
      JSON.stringify(edge.evidence),
      JSON.stringify(edge.sources),
      edge.confidence,
      edge.conflict ? 1 : 0,
      edge.metadata ? JSON.stringify(edge.metadata) : null,
      edge.updated_at
    );
  }

  upsertEdgeByEndpoints(
    type: EdgeKind,
    from: string,
    to: string,
    evidence: import('./types.js').Evidence[],
    sources: import('./types.js').EdgeSource[],
    confidence = 1.0
  ): GraphEdge {
    const id = edgeId(from, to, type);
    const edge: GraphEdge = {
      id,
      type,
      from,
      to,
      evidence,
      sources,
      confidence,
      conflict: false,
      updated_at: new Date().toISOString(),
    };
    this.upsertEdge(edge);
    return this.getEdge(id) ?? edge;
  }

  getEdge(id: string): GraphEdge | undefined {
    const stmt = this.db.prepare('SELECT * FROM edges WHERE id = ?');
    const row = stmt.get(id) as any;
    if (!row) return undefined;
    return this.rowToEdge(row);
  }

  listEdges(type?: EdgeKind, limit = 1000, offset = 0): GraphEdge[] {
    let sql = 'SELECT * FROM edges';
    const params: any[] = [];
    if (type) {
      sql += ' WHERE type = ?';
      params.push(type);
    }
    sql += ' ORDER BY updated_at LIMIT ? OFFSET ?';
    params.push(limit, offset);
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as any[];
    return rows.map(r => this.rowToEdge(r));
  }

  countEdges(type?: EdgeKind): number {
    if (type) {
      const stmt = this.db.prepare('SELECT COUNT(*) as cnt FROM edges WHERE type = ?');
      const row = stmt.get(type) as any;
      return row.cnt;
    }
    const stmt = this.db.prepare('SELECT COUNT(*) as cnt FROM edges');
    const row = stmt.get() as any;
    return row.cnt;
  }

  deleteEdge(id: string): void {
    this.db.prepare('DELETE FROM edges WHERE id = ?').run(id);
  }

  // ─── Neighbors ─────────────────────────────────────────────────────────────

  getOutEdges(nodeId: string): GraphEdge[] {
    const stmt = this.db.prepare('SELECT * FROM edges WHERE "from" = ?');
    const rows = stmt.all(nodeId) as any[];
    return rows.map(r => this.rowToEdge(r));
  }

  getInEdges(nodeId: string): GraphEdge[] {
    const stmt = this.db.prepare('SELECT * FROM edges WHERE "to" = ?');
    const rows = stmt.all(nodeId) as any[];
    return rows.map(r => this.rowToEdge(r));
  }

  getNeighbors(nodeId: string, direction: 'out' | 'in' | 'both' = 'both'): GraphEdge[] {
    if (direction === 'out') return this.getOutEdges(nodeId);
    if (direction === 'in') return this.getInEdges(nodeId);
    return [...this.getOutEdges(nodeId), ...this.getInEdges(nodeId)];
  }

  // ─── Validation ────────────────────────────────────────────────────────────

  validateGraph(): { ok: boolean; errors: string[] } {
    const errors: string[] = [];

    // Check edges reference existing nodes
    const stmt = this.db.prepare(`
      SELECT e.id, e."from", e."to"
      FROM edges e
      LEFT JOIN nodes n1 ON e."from" = n1.id
      LEFT JOIN nodes n2 ON e."to" = n2.id
      WHERE n1.id IS NULL OR n2.id IS NULL
    `);
    const dangling = stmt.all() as any[];
    for (const row of dangling) {
      errors.push(`Edge ${row.id} references non-existent node: from=${row.from}, to=${row.to}`);
    }

    // Check for self-referencing edges
    const selfRef = this.db.prepare(
      'SELECT id FROM edges WHERE "from" = "to"'
    ).all() as any[];
    for (const row of selfRef) {
      errors.push(`Edge ${row.id} is self-referencing`);
    }

    // Check node ID format
    const badIds = this.db.prepare(
      "SELECT id FROM nodes WHERE id NOT LIKE '%:%'"
    ).all() as any[];
    for (const row of badIds) {
      errors.push(`Node ${row.id} has invalid ID format (missing colon separator)`);
    }

    return { ok: errors.length === 0, errors };
  }

  // ─── Bulk Operations ──────────────────────────────────────────────────────

  private inTransaction = false;

  transaction<T>(fn: () => T): T {
    if (this.inTransaction) {
      return fn(); // Already in a transaction, just run the function
    }
    this.inTransaction = true;
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw e;
    } finally {
      this.inTransaction = false;
    }
  }

  upsertNodes(nodes: GraphNode[]): void {
    this.transaction(() => {
      for (const node of nodes) {
        this.upsertNode(node);
      }
    });
  }

  upsertEdges(edges: GraphEdge[]): void {
    this.transaction(() => {
      for (const edge of edges) {
        this.upsertEdge(edge);
      }
    });
  }

  // ─── Row Conversion ───────────────────────────────────────────────────────

  private rowToNode(row: any): GraphNode {
    return {
      id: row.id,
      kind: row.kind as NodeKind,
      name: row.name,
      path: row.path ?? undefined,
      lang: row.lang ?? undefined,
      signature: row.signature ?? undefined,
      startLine: row.start_line ?? undefined,
      endLine: row.end_line ?? undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      tags: row.tags ? JSON.parse(row.tags) : undefined,
      updated_at: row.updated_at,
    };
  }

  private rowToEdge(row: any): GraphEdge {
    return {
      id: row.id,
      type: row.type as EdgeKind,
      from: row.from,
      to: row.to,
      evidence: JSON.parse(row.evidence || '[]'),
      sources: JSON.parse(row.sources || '[]'),
      confidence: row.confidence,
      conflict: row.conflict === 1,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      updated_at: row.updated_at,
    };
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  close(): void {
    this.db.close();
  }

  get nodeCount(): number {
    return this.countNodes();
  }

  get edgeCount(): number {
    return this.countEdges();
  }
}
