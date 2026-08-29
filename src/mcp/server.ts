// MCP server — stdio transport exposing Core operations as MCP tools.
// Tools == CLI JSON.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { GraphStore } from '../core/store.js';
import { computeImpact } from '../core/impact.js';
import { computeDiffImpact } from '../core/diff.js';
import { evaluatePolicies } from '../core/policy.js';
import { RAGIndex } from '../core/rag.js';
import { healthCheck } from '../core/health.js';
import { envelope, errorEnvelope } from '../core/types.js';
import { edgeId } from '../core/ids.js';

const SERVER_NAME = 'architecture-mapper';
const SERVER_VERSION = '0.1.0';

// Tool definitions matching the AGENTS.md spec
const TOOLS = [
  {
    name: 'search',
    description: 'Search for nodes in the architecture graph',
    inputSchema: {
      type: 'object' as const,
      properties: {
        q: { type: 'string', description: 'Search query' },
        kind: { type: 'string', description: 'Optional node kind filter' },
      },
      required: ['q'],
    },
  },
  {
    name: 'symbol',
    description: 'Get a node and its neighbors summary',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Node ID or name' },
      },
      required: ['id'],
    },
  },
  {
    name: 'neighbors',
    description: 'Get adjacent edges and nodes',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Node ID' },
        direction: { type: 'string', enum: ['out', 'in', 'both'], default: 'both' },
      },
      required: ['id'],
    },
  },
  {
    name: 'blast_radius',
    description: 'Compute downstream blast radius with why-paths',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Node ID to analyze' },
        direction: { type: 'string', enum: ['downstream', 'upstream'], default: 'downstream' },
        depth: { type: 'number', default: 5 },
      },
      required: ['id'],
    },
  },
  {
    name: 'diff_impact',
    description: 'Compute symbol-level diff impact between two versions',
    inputSchema: {
      type: 'object' as const,
      properties: {
        base: { type: 'string', default: 'main' },
        head: { type: 'string', default: 'HEAD' },
      },
    },
  },
  {
    name: 'why_path',
    description: 'Find evidence-backed paths between two nodes',
    inputSchema: {
      type: 'object' as const,
      properties: {
        from: { type: 'string', description: 'Source node ID' },
        to: { type: 'string', description: 'Target node ID' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'docs_for',
    description: 'Resolve documentation for a node or import',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Node ID or import name' },
      },
      required: ['id'],
    },
  },
  {
    name: 'tests_to_run',
    description: 'Get tests that should be run for a given node',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Node ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'health',
    description: 'Get graph health status',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'pin',
    description: 'Add a user-confirmed edge to the graph',
    inputSchema: {
      type: 'object' as const,
      properties: {
        from: { type: 'string' },
        to: { type: 'string' },
        type: { type: 'string', description: 'Edge type' },
      },
      required: ['from', 'to', 'type'],
    },
  },
  {
    name: 'plan_change',
    description: 'Get a bounded mutation envelope for a proposed change',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Node ID to plan changes for' },
      },
      required: ['id'],
    },
  },
];

// ─── Request Handling ─────────────────────────────────────────────────────────

interface MCPRequest {
  jsonrpc: string;
  id: number | string;
  method: string;
  params?: any;
}

interface MCPResponse {
  jsonrpc: string;
  id: number | string;
  result?: any;
  error?: { code: number; message: string };
}

function handleRequest(req: MCPRequest, store: GraphStore): MCPResponse {
  const respond = (result: any, error?: { code: number; message: string }): MCPResponse => ({
    jsonrpc: '2.0',
    id: req.id,
    result,
    error,
  });

  try {
    switch (req.method) {
      case 'initialize':
        return respond({
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });

      case 'tools/list':
        return respond({ tools: TOOLS });

      case 'tools/call': {
        const { name, arguments: args } = req.params;
        return respond(handleToolCall(name, args ?? {}, store));
      }

      default:
        return respond(null, { code: -32601, message: `Method not found: ${req.method}` });
    }
  } catch (e: any) {
    return respond(null, { code: -32000, message: e.message ?? 'Internal error' });
  }
}

function handleToolCall(name: string, args: any, store: GraphStore): any {
  switch (name) {
    case 'search': {
      const rag = new RAGIndex();
      rag.indexNodes(store);
      const results = rag.searchWithNodes(store, args.q, args.limit ?? 20);
      return { content: [{ type: 'text', text: JSON.stringify(envelope(results)) }] };
    }

    case 'symbol': {
      let node = store.getNode(args.id);
      if (!node) {
        const results = store.searchNodes(args.id, 1);
        if (results.length > 0) node = results[0];
      }
      if (!node) return { content: [{ type: 'text', text: JSON.stringify(errorEnvelope(`Node not found: ${args.id}`)) }] };
      const neighbors = store.getNeighbors(node.id);
      return { content: [{ type: 'text', text: JSON.stringify(envelope({ node, neighbors })) }] };
    }

    case 'neighbors': {
      const edges = store.getNeighbors(args.id, args.direction ?? 'both');
      const nodes = edges.map(e => {
        const otherId = e.from === args.id ? e.to : e.from;
        return store.getNode(otherId);
      }).filter(Boolean);
      return { content: [{ type: 'text', text: JSON.stringify(envelope({ edges, nodes })) }] };
    }

    case 'blast_radius': {
      let node = store.getNode(args.id);
      if (!node) {
        const results = store.searchNodes(args.id, 1);
        if (results.length > 0) node = results[0];
      }
      if (!node) return { content: [{ type: 'text', text: JSON.stringify(errorEnvelope(`Node not found: ${args.id}`)) }] };
      const result = computeImpact(store, [node.id], {
        direction: args.direction ?? 'downstream',
        maxDepth: args.depth ?? 5,
      });
      return { content: [{ type: 'text', text: JSON.stringify(envelope(result)) }] };
    }

    case 'diff_impact': {
      const result = computeDiffImpact(store, args.base ?? 'main', args.head ?? 'HEAD');
      return { content: [{ type: 'text', text: JSON.stringify(envelope(result)) }] };
    }

    case 'why_path': {
      const result = computeImpact(store, [args.from], { direction: 'downstream', maxPaths: 7 });
      const relevant = result.paths.filter(p =>
        p.steps.some(s => s.to === args.to || s.from === args.to)
      );
      return { content: [{ type: 'text', text: JSON.stringify(envelope({ paths: relevant })) }] };
    }

    case 'docs_for': {
      const extNode = store.getNode(`ext:${args.id}`);
      const docNodes = store.listNodes('Doc').filter(d => d.path?.includes(args.id));
      return { content: [{ type: 'text', text: JSON.stringify(envelope({ external: extNode, docs: docNodes })) }] };
    }

    case 'tests_to_run': {
      const result = computeImpact(store, [args.id], { direction: 'downstream', maxDepth: 3 });
      const testNodes = result.nodes.filter(n => n.kind === 'Test');
      return { content: [{ type: 'text', text: JSON.stringify(envelope({
        tests: testNodes.map(n => ({ id: n.id, name: n.name, path: n.path })),
        inferredCommand: testNodes.length > 0 ? 'npm test' : null,
      })) }] };
    }

    case 'health': {
      const rows = healthCheck(store);
      return { content: [{ type: 'text', text: JSON.stringify(envelope(rows)) }] };
    }

    case 'pin': {
      const edge = store.upsertEdgeByEndpoints(
        args.type, args.from, args.to,
        [{ file: 'mcp', line: 0, snippet: 'MCP pin' }],
        ['agent']
      );
      return { content: [{ type: 'text', text: JSON.stringify(envelope(edge)) }] };
    }

    case 'plan_change': {
      let node = store.getNode(args.id);
      if (!node) {
        const results = store.searchNodes(args.id, 1);
        if (results.length > 0) node = results[0];
      }
      if (!node) return { content: [{ type: 'text', text: JSON.stringify(errorEnvelope(`Node not found: ${args.id}`)) }] };
      const impact = computeImpact(store, [node.id], { direction: 'downstream' });
      const policies = evaluatePolicies(store);
      return { content: [{ type: 'text', text: JSON.stringify(envelope({
        target: node,
        allowedFiles: node.path ? [node.path] : [],
        impacted: impact.nodes.map(n => n.id),
        policies,
        testsToRun: impact.testsToRun,
      })) }] };
    }

    default:
      return { content: [{ type: 'text', text: JSON.stringify(errorEnvelope(`Unknown tool: ${name}`)) }] };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export function startMCPServer(): void {
  const cwd = process.cwd();
  const dbPath = join(cwd, '.archmap', 'index.db');

  if (!existsSync(dbPath)) {
    console.error('No .archmap/index.db found. Run "archmap init" first.');
    process.exit(1);
  }

  const store = new GraphStore(dbPath);

  let buffer = '';

  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.trim() === '') continue;
      try {
        const req: MCPRequest = JSON.parse(line);
        const resp = handleRequest(req, store);
        process.stdout.write(JSON.stringify(resp) + '\n');
      } catch {
        // Ignore malformed messages
      }
    }
  });

  process.stdin.on('end', () => {
    store.close();
    process.exit(0);
  });

  process.stderr.write(`${SERVER_NAME} v${SERVER_VERSION} started\n`);
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  startMCPServer();
}
