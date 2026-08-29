#!/usr/bin/env node
// archmap CLI — one command, many subcommands.
// Every subcommand supports --json.

import { Command } from 'commander';
import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { parseRepository } from '../parse/index.js';
import {
  GraphStore, computeImpact, computeDiffImpact, evaluatePolicies,
  RAGIndex, Journal, healthCheck, reconstructFlow,
  envelope, errorEnvelope,
  fileId, functionId,
} from '../core/index.js';
import type { GraphNode } from '../core/types.js';

const program = new Command();

program
  .name('archmap')
  .description('Architecture Mapper — one knowledge graph for your codebase')
  .version('0.1.0');

// ─── Helpers ───────────────────────────────────────────────────────────────────

function getArchmapDir(repoPath: string): string {
  return join(repoPath, '.archmap');
}

function openStore(repoPath: string): GraphStore {
  const dbPath = join(getArchmapDir(repoPath), 'index.db');
  return new GraphStore(dbPath);
}

function output(result: unknown, json: boolean = false): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result && typeof result === 'object' && 'ok' in result) {
      const r = result as any;
      if (!r.ok) {
        console.error(`❌ Error: ${r.data?.error ?? 'Unknown error'}`);
        process.exit(1);
      }
    }
    console.log(JSON.stringify(result, null, 2));
  }
}

// ─── init ──────────────────────────────────────────────────────────────────────

program
  .command('init [path]')
  .description('Create .archmap/, index repo, write .gitignore + .mcp.json + starter seed.yaml')
  .option('--daemon', 'Also start the HTTP daemon after init')
  .option('--json', 'Output as JSON')
  .action((repoPath: string = '.', opts: { daemon?: boolean; json?: boolean }) => {
    const absPath = resolve(repoPath);
    const archmapDir = getArchmapDir(absPath);
    const startTime = Date.now();

    // Create .archmap/ directory
    mkdirSync(archmapDir, { recursive: true });
    mkdirSync(join(archmapDir, 'cache', 'docs'), { recursive: true });

    console.log(`🔧 Initializing archmap in ${absPath}...`);

    // Parse and index
    const store = openStore(absPath);
    const { nodes, edges } = parseRepository(absPath);

    store.transaction(() => {
      store.upsertNodes(nodes);
      store.upsertEdges(edges);
    });

    console.log(`📊 Indexed ${store.nodeCount} nodes, ${store.edgeCount} edges`);

    // Write .gitignore entries
    const gitignorePath = join(absPath, '.gitignore');
    const gitignoreEntries = [
      '.archmap/index.db',
      '.archmap/vectors/',
      '.archmap/cache/',
      '.archmap/daemon.json',
      '.archmap/agent-runs/',
    ];

    let existingGitignore = '';
    if (existsSync(gitignorePath)) {
      existingGitignore = readFileSync(gitignorePath, 'utf-8');
    }

    const newEntries = gitignoreEntries.filter(e => !existingGitignore.includes(e));
    if (newEntries.length > 0) {
      const separator = existingGitignore.endsWith('\n') ? '' : '\n';
      writeFileSync(gitignorePath, existingGitignore + separator + newEntries.join('\n') + '\n');
      console.log(`📝 Updated .gitignore with ${newEntries.length} entries`);
    }

    // Write .mcp.json
    const mcpPath = join(absPath, '.mcp.json');
    if (!existsSync(mcpPath)) {
      const mcpConfig = {
        mcpServers: {
          'architecture-mapper': {
            command: 'npx',
            args: ['-y', 'archmap', 'mcp'],
            cwd: '${workspaceFolder}',
          },
        },
      };
      writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2) + '\n');
      console.log('📝 Created .mcp.json');
    }

    // Write starter seed.yaml
    const seedPath = join(archmapDir, 'seed.yaml');
    if (!existsSync(seedPath)) {
      const seed = `# Architecture Mapper seed file
# Use this to correct or supplement automatic inference.
# After loading, seed entries are upserted into the ONE graph.

project:
  name: ${basename(absPath)}

services: []

externals: []

pins: []

ignore_paths:
  - node_modules/
  - dist/
  - build/
  - .git/
  - vendor/
  - __pycache__/

critical: []

ask_me_when: stuck
`;
      writeFileSync(seedPath, seed);
      console.log('📝 Created .archmap/seed.yaml');
    }

    // Validate
    const validation = store.validateGraph();
    if (!validation.ok) {
      console.log(`⚠️  Graph validation warnings: ${validation.errors.length}`);
    }

    // Journal
    const journal = new Journal(archmapDir);
    journal.append('init', {
      path: absPath,
      nodeCount: store.nodeCount,
      edgeCount: store.edgeCount,
      duration_ms: Date.now() - startTime,
    });

    const finalNodeCount = store.nodeCount;
    const finalEdgeCount = store.edgeCount;
    store.close();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\n✅ archmap initialized in ${elapsed}s`);
    console.log(`   ${finalNodeCount} nodes, ${finalEdgeCount} edges`);
    console.log(`   Database: ${join(archmapDir, 'index.db')}`);

    if (opts.daemon) {
      console.log('🚀 Starting daemon...');
      // TODO: Phase 4 - start serve
    }
  });

// ─── sync ──────────────────────────────────────────────────────────────────────

program
  .command('sync [path]')
  .description('Re-index on demand (also used by git hook)')
  .option('--json', 'Output as JSON')
  .action((repoPath: string = '.', opts: { json?: boolean }) => {
    const absPath = resolve(repoPath);
    const archmapDir = getArchmapDir(absPath);

    if (!existsSync(join(archmapDir, 'index.db'))) {
      output(errorEnvelope('No .archmap/index.db found. Run "archmap init" first.'), opts.json ?? false);
      return;
    }

    console.log(`🔄 Syncing ${absPath}...`);
    const startTime = Date.now();
    const store = openStore(absPath);

    // Re-parse
    const { nodes, edges } = parseRepository(absPath);
    store.transaction(() => {
      store.upsertNodes(nodes);
      store.upsertEdges(edges);
    });

    const journal = new Journal(archmapDir);
    journal.append('sync', {
      nodeCount: store.nodeCount,
      edgeCount: store.edgeCount,
      duration_ms: Date.now() - startTime,
    });

    store.close();
    output(envelope({
      nodeCount: store.nodeCount,
      edgeCount: store.edgeCount,
      duration_ms: Date.now() - startTime,
    }), opts.json ?? false);
  });

// ─── impact ────────────────────────────────────────────────────────────────────

program
  .command('impact <id>')
  .description('Bounded blast radius + why-paths')
  .option('--downstream', 'Direction (default)', true)
  .option('--upstream', 'Direction: upstream')
  .option('--depth <n>', 'Max traversal depth', '5')
  .option('--paths <n>', 'Max why-paths', '7')
  .option('--json', 'Output as JSON')
  .action((id: string, opts: any) => {
    const repoPath = '.';
    const store = openStore(repoPath);

    let node = store.getNode(id);
    if (!node) {
      const results = store.searchNodes(id, 1);
      if (results.length > 0) {
        node = results[0];
      }
    }

    if (!node) {
      output(errorEnvelope(`Node not found: ${id}`), opts.json ?? false);
      store.close();
      return;
    }

    const direction = opts.upstream ? 'upstream' : 'downstream';
    const result = computeImpact(store, [node.id], {
      direction,
      maxDepth: parseInt(opts.depth, 10),
      maxPaths: parseInt(opts.paths, 10),
    });

    store.close();
    output(envelope(result), opts.json ?? false);
  });

// ─── diff ──────────────────────────────────────────────────────────────────────

program
  .command('diff [base] [head]')
  .description('Symbol-level diff impact')
  .option('--json', 'Output as JSON')
  .action((base: string = 'main', head: string = 'HEAD', opts: { json?: boolean }) => {
    const store = openStore('.');
    const result = computeDiffImpact(store, base, head);
    store.close();
    output(envelope(result), opts.json ?? false);
  });

// ─── flow ──────────────────────────────────────────────────────────────────────

program
  .command('flow <id>')
  .description('Reconstruct an evidence-backed flow')
  .option('--json', 'Output as JSON')
  .action((id: string, opts: { json?: boolean }) => {
    const store = openStore('.');
    let node = store.getNode(id);
    if (!node) {
      const results = store.searchNodes(id, 1);
      if (results.length > 0) node = results[0];
    }
    if (!node) {
      output(errorEnvelope(`Node not found: ${id}`), opts.json ?? false);
      store.close();
      return;
    }
    const result = reconstructFlow(store, node.id);
    store.close();
    output(envelope(result), opts.json ?? false);
  });

// ─── graph ─────────────────────────────────────────────────────────────────────

program
  .command('graph')
  .description('Export a bounded graph view (json|mermaid)')
  .option('--format <fmt>', 'Output format: json or mermaid', 'json')
  .option('--max-nodes <n>', 'Max nodes to export', '200')
  .option('--json', 'Output as JSON')
  .action((opts: any) => {
    const store = openStore('.');
    const nodes = store.listNodes(undefined, parseInt(opts.maxNodes, 10));

    if (opts.format === 'mermaid') {
      console.log('graph LR');
      for (const node of nodes) {
        const edges = store.getOutEdges(node.id);
        for (const edge of edges) {
          if (nodes.some(n => n.id === edge.to)) {
            const fromName = node.name.replace(/[^a-zA-Z0-9]/g, '_');
            const toName = (store.getNode(edge.to)?.name ?? edge.to).replace(/[^a-zA-Z0-9]/g, '_');
            console.log(`  ${fromName} -->|${edge.type}| ${toName}`);
          }
        }
      }
    } else {
      output(envelope({ nodes, edges: nodes.flatMap(n => store.getOutEdges(n.id)) }), opts.json ?? false);
    }
    store.close();
  });

// ─── search ────────────────────────────────────────────────────────────────────

program
  .command('search <query>')
  .description('RAG + graph search')
  .option('--limit <n>', 'Max results', '20')
  .option('--json', 'Output as JSON')
  .action((query: string, opts: any) => {
    const store = openStore('.');
    const rag = new RAGIndex();
    rag.indexNodes(store);
    const results = rag.searchWithNodes(store, query, parseInt(opts.limit, 10));
    store.close();
    output(envelope(results), opts.json ?? false);
  });

// ─── symbol ────────────────────────────────────────────────────────────────────

program
  .command('symbol <id>')
  .description('Node + neighbors summary')
  .option('--json', 'Output as JSON')
  .action((id: string, opts: { json?: boolean }) => {
    const store = openStore('.');
    let node = store.getNode(id);
    if (!node) {
      const results = store.searchNodes(id, 1);
      if (results.length > 0) node = results[0];
    }
    if (!node) {
      output(errorEnvelope(`Node not found: ${id}`), opts.json ?? false);
      store.close();
      return;
    }
    const neighbors = store.getNeighbors(node.id);
    output(envelope({ node, neighbors }), opts.json ?? false);
    store.close();
  });

// ─── neighbors ─────────────────────────────────────────────────────────────────

program
  .command('neighbors <id>')
  .description('Adjacent edges/nodes')
  .option('--direction <dir>', 'out, in, or both', 'both')
  .option('--json', 'Output as JSON')
  .action((id: string, opts: any) => {
    const store = openStore('.');
    const edges = store.getNeighbors(id, opts.direction);
    const nodes = edges.map(e => {
      const otherId = e.from === id ? e.to : e.from;
      return store.getNode(otherId);
    }).filter(Boolean);
    output(envelope({ edges, nodes }), opts.json ?? false);
    store.close();
  });

// ─── why_path ──────────────────────────────────────────────────────────────────

program
  .command('why_path <from> <to>')
  .description('Evidence-backed paths')
  .option('--json', 'Output as JSON')
  .action((from: string, to: string, opts: { json?: boolean }) => {
    const store = openStore('.');
    const result = computeImpact(store, [from], { direction: 'downstream', maxPaths: 7 });
    const relevant = result.paths.filter(p =>
      p.steps.some(s => s.to === to || s.from === to)
    );
    store.close();
    output(envelope({ paths: relevant }), opts.json ?? false);
  });

// ─── tests_to_run ──────────────────────────────────────────────────────────────

program
  .command('tests_to_run <id>')
  .description('Tests + inferred command')
  .option('--json', 'Output as JSON')
  .action((id: string, opts: { json?: boolean }) => {
    const store = openStore('.');
    const result = computeImpact(store, [id], { direction: 'downstream', maxDepth: 3 });
    const testNodes = result.nodes.filter(n => n.kind === 'Test');
    store.close();
    output(envelope({
      tests: testNodes.map(n => ({ id: n.id, name: n.name, path: n.path })),
      inferredCommand: testNodes.length > 0 ? 'npm test' : null,
    }), opts.json ?? false);
  });

// ─── docs ──────────────────────────────────────────────────────────────────────

program
  .command('docs <name>')
  .description('Resolve official/in-repo docs')
  .option('--json', 'Output as JSON')
  .action((name: string, opts: { json?: boolean }) => {
    const store = openStore('.');
    const extNode = store.getNode(`ext:${name}`);
    const docNodes = store.listNodes('Doc').filter(d => d.path?.includes(name));
    store.close();
    output(envelope({
      external: extNode,
      docs: docNodes,
      note: 'Use "archmap sync" to re-index after fetching docs',
    }), opts.json ?? false);
  });

// ─── pin ───────────────────────────────────────────────────────────────────────

program
  .command('pin')
  .description('Add a user-confirmed edge')
  .requiredOption('--from <id>', 'Source node ID')
  .requiredOption('--to <id>', 'Target node ID')
  .requiredOption('--type <edge>', 'Edge type')
  .option('--json', 'Output as JSON')
  .action((opts: any) => {
    const store = openStore('.');
    const edge = store.upsertEdgeByEndpoints(
      opts.type, opts.from, opts.to,
      [{ file: 'user', line: 0, snippet: 'user pin' }],
      ['user']
    );
    const journal = new Journal(getArchmapDir('.'));
    journal.append('pin', { from: opts.from, to: opts.to, type: opts.type });
    store.close();
    output(envelope(edge), opts.json ?? false);
  });

// ─── health ────────────────────────────────────────────────────────────────────

program
  .command('health')
  .description('Graph consistency + inference health')
  .option('--json', 'Output as JSON')
  .action((opts: { json?: boolean }) => {
    const store = openStore('.');
    const rows = healthCheck(store);
    store.close();
    output(envelope(rows), opts.json ?? false);
  });

// ─── plan_change ───────────────────────────────────────────────────────────────

program
  .command('plan_change <id>')
  .description('Bounded mutation envelope')
  .option('--json', 'Output as JSON')
  .action((id: string, opts: { json?: boolean }) => {
    const store = openStore('.');
    let node = store.getNode(id);
    if (!node) {
      const results = store.searchNodes(id, 1);
      if (results.length > 0) node = results[0];
    }
    if (!node) {
      output(errorEnvelope(`Node not found: ${id}`), opts.json ?? false);
      store.close();
      return;
    }

    const impact = computeImpact(store, [node.id], { direction: 'downstream' });
    const policies = evaluatePolicies(store);

    output(envelope({
      target: node,
      allowedFiles: node.path ? [node.path] : [],
      impacted: impact.nodes.map(n => n.id),
      policies,
      testsToRun: impact.testsToRun,
    }), opts.json ?? false);
    store.close();
  });

// ─── MCP ─────────────────────────────────────────────────────────────────────

program
  .command('mcp')
  .description('MCP server over stdio')
  .action(async () => {
    const { startMCPServer } = await import('../mcp/server.js');
    startMCPServer();
  });

// ─── UI ───────────────────────────────────────────────────────────────────────

program
  .command('ui')
  .description('Serve the localhost visualizer')
  .option('--port <n>', 'Port number', '3743')
  .action(async (opts: any) => {
    const { startUIServer } = await import('../ui/server.js');
    await startUIServer(parseInt(opts.port, 10));
  });

// ─── serve ────────────────────────────────────────────────────────────────────

program
  .command('serve')
  .description('Optional localhost HTTP daemon')
  .option('--port <n>', 'Port number', '3742')
  .action(async (opts: any) => {
    const { startDaemon } = await import('../daemon/server.js');
    await startDaemon(parseInt(opts.port, 10));
  });

// ─── orchestrate (stub) ────────────────────────────────────────────────────────

program
  .command('orchestrate <task>')
  .description('Bounded, verified agent workflow')
  .action((task: string) => {
    console.log(`Agent orchestration — coming in Phase 5: ${task}`);
  });

// ─── route (stub) ──────────────────────────────────────────────────────────────

program
  .command('route <task>')
  .description('Capability/cost model route')
  .action((task: string) => {
    console.log(`Cost routing — coming in Phase 5: ${task}`);
  });

// ─── Parse ─────────────────────────────────────────────────────────────────────

program.parse();
