// HTTP daemon — localhost HTTP server exposing Core operations.
// Port is written to .archmap/daemon.json.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GraphStore } from '../core/store.js';
import { computeImpact } from '../core/impact.js';
import { computeDiffImpact } from '../core/diff.js';
import { RAGIndex } from '../core/rag.js';
import { healthCheck } from '../core/health.js';
import { reconstructFlow } from '../core/flow.js';
import { envelope, errorEnvelope } from '../core/types.js';
import { findWhyPaths } from '../core/why.js';
import { computeInsights } from '../core/insights.js';
import { planChange } from '../core/plan.js';
import { projectView } from '../core/views.js';

const DEFAULT_PORT = 3742;

interface Route {
  method: string;
  path: string;
  handler: (body: any, store: GraphStore) => any;
}

const routes: Route[] = [
  {
    method: 'POST',
    path: '/v1/search',
    handler: (body, store) => {
      const rag = new RAGIndex();
      rag.indexNodes(store);
      return envelope(rag.searchWithNodes(store, body.q, body.limit ?? 20));
    },
  },
  {
    method: 'POST',
    path: '/v1/symbol',
    handler: (body, store) => {
      let node = store.getNode(body.id);
      if (!node) {
        const results = store.searchNodes(body.id, 1);
        if (results.length > 0) node = results[0];
      }
      if (!node) return errorEnvelope(`Node not found: ${body.id}`);
      return envelope({ node, neighbors: store.getNeighbors(node.id) });
    },
  },
  {
    method: 'POST',
    path: '/v1/neighbors',
    handler: (body, store) => {
      const edges = store.getNeighbors(body.id, body.direction ?? 'both');
      const nodes = edges.map(e => {
        const otherId = e.from === body.id ? e.to : e.from;
        return store.getNode(otherId);
      }).filter(Boolean);
      return envelope({ edges, nodes });
    },
  },
  {
    method: 'POST',
    path: '/v1/blast_radius',
    handler: (body, store) => {
      let node = store.getNode(body.id);
      if (!node) {
        const results = store.searchNodes(body.id, 1);
        if (results.length > 0) node = results[0];
      }
      if (!node) return errorEnvelope(`Node not found: ${body.id}`);
      return envelope(computeImpact(store, [node.id], {
        direction: body.direction ?? 'downstream',
        maxDepth: body.depth ?? 5,
      }));
    },
  },
  {
    method: 'POST',
    path: '/v1/diff_impact',
    handler: (body, store) => {
      const mode = body.mode ?? (body.staged ? 'staged' : body.working ? 'working' : body.base ? 'range' : 'working');
      return envelope(computeDiffImpact(store, {
        base: body.base,
        head: body.head,
        mode,
        repoPath: process.cwd(),
      }));
    },
  },
  {
    method: 'POST',
    path: '/v1/why_path',
    handler: (body, store) => {
      const a = store.resolveNode(body.from);
      const b = store.resolveNode(body.to);
      if (!a || !b) return errorEnvelope('Node not found');
      return envelope({ paths: findWhyPaths(store, a.id, b.id) });
    },
  },
  {
    method: 'POST',
    path: '/v1/health',
    handler: (_body, store) => {
      return envelope(healthCheck(store));
    },
  },
  {
    method: 'POST',
    path: '/v1/flow',
    handler: (body, store) => {
      let node = store.getNode(body.id);
      if (!node) {
        const results = store.searchNodes(body.id, 1);
        if (results.length > 0) node = results[0];
      }
      if (!node) return errorEnvelope(`Node not found: ${body.id}`);
      return envelope(reconstructFlow(store, node.id));
    },
  },
  {
    method: 'POST',
    path: '/v1/pin',
    handler: (body, store) => {
      const edge = store.upsertEdgeByEndpoints(
        body.type, body.from, body.to,
        [{ file: 'http', line: 0, snippet: 'HTTP pin' }],
        ['agent']
      );
      return envelope(edge);
    },
  },
  {
    method: 'POST',
    path: '/v1/plan_change',
    handler: (body, store) => {
      const node = store.resolveNode(body.id);
      if (!node) return errorEnvelope(`Node not found: ${body.id}`);
      return envelope(planChange(store, node));
    },
  },
  {
    method: 'POST',
    path: '/v1/insights',
    handler: (_body, store) => envelope(computeInsights(store)),
  },
  {
    method: 'POST',
    path: '/v1/view',
    handler: (body, store) => envelope(projectView(store, body.mode ?? 'height', body.focus)),
  },
];

function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export async function startDaemon(port = DEFAULT_PORT): Promise<void> {
  const cwd = process.cwd();
  const dbPath = join(cwd, '.archmap', 'index.db');
  const daemonPath = join(cwd, '.archmap', 'daemon.json');

  if (!existsSync(dbPath)) {
    console.error('No .archmap/index.db found. Run "archmap init" first.');
    process.exit(1);
  }

  const store = new GraphStore(dbPath);

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Find matching route
    const route = routes.find(r => r.method === req.method && r.path === req.url);

    if (!route) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(errorEnvelope(`Not found: ${req.method} ${req.url}`)));
      return;
    }

    try {
      const body = await parseBody(req);
      const result = route.handler(body, store);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(errorEnvelope(e.message ?? 'Internal error')));
    }
  });

  server.listen(port, '127.0.0.1', () => {
    // Write daemon.json
    writeFileSync(daemonPath, JSON.stringify({ port, pid: process.pid }, null, 2) + '\n');
    console.log(`archmap daemon listening on http://127.0.0.1:${port}`);
    console.log(`PID: ${process.pid}`);
  });

  // Cleanup on exit
  process.on('SIGINT', () => {
    store.close();
    server.close();
    process.exit(0);
  });
}
