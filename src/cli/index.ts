#!/usr/bin/env node
import { Command } from 'commander';
import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { parseRepository } from '../parse/index.js';
import {
  GraphStore, computeImpact, computeDiffImpact,
  RAGIndex, Journal, healthCheck, reconstructFlow,
  envelope,
  identifyFromGraph, loadSeed, explainImpact,
  whyPathOp, insightsOp, viewOp, planChangeOp, mermaidFromView, docsOp,
} from '../core/index.js';
import type { GraphNode, NodeKind } from '../core/types.js';
import { quickPick } from './picker.js';

const program = new Command();
program.name('archmap').description(
  '🏗️  Architecture Mapper — find out what happens if you change your code.\n\n' +
  'Quick start:\n' +
  '  archmap init              Index your codebase\n' +
  '  archmap summary           See what\'s in your code\n' +
  '  archmap explain <thing>   What does this do?\n' +
  '  archmap impact <thing>    What breaks if I change this?\n' +
  '  archmap ui                Open the visualizer'
).version('0.1.0');

// ─── Helpers ───────────────────────────────────────────────────────
const KIND_ICON: Record<string, string> = {
  Function: '⚡', Method: '⚡', Class: '📦', Interface: '🔌',
  Table: '🗄️', API: '🌐', File: '📄', External: '🔗', Test: '🧪',
  Service: '🏛️', Package: '📦', Event: '📣', Module: '📁',
};
function getArchmapDir(p: string) { return join(p, '.archmap'); }
function openStore(p: string) {
  const db = join(getArchmapDir(p), 'index.db');
  if (!existsSync(db)) { console.error('❌ No indexed data. Run: archmap init'); process.exit(1); }
  return new GraphStore(db);
}
function findNode(store: GraphStore, q: string): GraphNode | null {
  let n = store.getNode(q); if (n) return n;
  const r = store.searchNodes(q, 5); return r.length ? r[0] : null;
}
function prettyNode(n: GraphNode) {
  const icon = KIND_ICON[n.kind] || '•';
  const loc = n.path ? `${n.path}${n.startLine ? ':' + n.startLine : ''}` : '';
  return `  ${icon} ${n.name}  ${n.kind}  ${loc}`;
}
function prettyImpact(result: any) {
  const lines: string[] = [];
  const counts = result.counts || {};
  const total = Object.values(counts).reduce((a: number, b: any) => a + (b as number), 0);

  // Severity banner
  const severity = result.severity || 'low';
  const severityBanner: Record<string, string> = {
    low: '🟢 LOW RISK',
    medium: '🟡 MEDIUM RISK',
    critical: '🔴 CRITICAL RISK',
  };
  lines.push(`\n${severityBanner[severity] || '🟢 LOW RISK'}`);
  lines.push(`\n🎯 Impact: ${result.summary || `${total} things affected`}\n`);

  // Grouped affected items by kind
  if (result.affectedByKind?.length) {
    for (const group of result.affectedByKind) {
      if (group.items.length === 0) continue;
      lines.push(`   ${group.icon} ${group.label} (${group.items.length}):`);
      for (const item of group.items.slice(0, 8)) {
        const loc = item.path ? `  ${item.path}${item.startLine ? ':' + item.startLine : ''}` : '';
        lines.push(`      • ${item.name}${loc}`);
      }
      if (group.items.length > 8) lines.push(`      ... and ${group.items.length - 8} more`);
      lines.push('');
    }
  } else {
    // Fallback to counts
    const order: NodeKind[] = ['Function', 'Method', 'Class', 'Interface', 'Table', 'API', 'External', 'Test'];
    for (const k of order) if (counts[k]) lines.push(`   ${counts[k]}× ${k}`);
    lines.push('');
  }

  // Why-paths (dependency chains)
  if (result.paths?.length) {
    lines.push('🔗 Why-paths (dependency chains):\n');
    for (const p of result.paths.slice(0, 5)) {
      const steps = p.steps.map((s: any) => {
        const from = s.from.split(':').pop() || s.from;
        const to = s.to.split(':').pop() || s.to;
        const edge = s.edgeType;
        return `${from} ──${edge}──▸ ${to}`;
      });
      lines.push(`   ${steps.join('\n      ')}`);
      // Show evidence for first step
      if (p.steps[0]?.evidence) {
        lines.push(`      📄 ${p.steps[0].evidence.file}:${p.steps[0].evidence.line}`);
      }
      lines.push('');
    }
  }

  // Risk chips
  if (result.riskChips?.length) {
    lines.push('⚠️  Risk factors:\n');
    const icons: Record<string, string> = { critical: '🔴', db_write: '💾', external: '🔗', untested: '🧪', conflict: '⚡', churn: '📈' };
    for (const r of result.riskChips) lines.push(`   ${icons[r.kind] || '⚠️'} ${r.message}`);
    lines.push('');
  }

  // Tests to run
  if (result.testsToRun?.length) {
    lines.push(`🧪 Tests to run (${result.testsToRun.length}):\n`);
    for (const t of result.testsToRun.slice(0, 10)) {
      const name = t.split(':').pop() || t;
      lines.push(`   • ${name}`);
    }
    lines.push('   → Run: npm test\n');
  }

  // Docs for externals
  if (result.docsForExternals?.length) {
    lines.push(`📚 External docs available:\n`);
    for (const d of result.docsForExternals.slice(0, 5)) {
      lines.push(`   • ${d.replace('ext:', '')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
function output(result: unknown) { console.log(JSON.stringify(result, null, 2)); }

// ─── init ──────────────────────────────────────────────────────────
program.command('init [path]').description('Set up archmap for this project (run once)')
  .option('--json', 'Output as JSON')
  .action(async (repoPath: string = '.', opts: any) => {
    const abs = resolve(repoPath); const dir = getArchmapDir(abs); const t0 = Date.now();
    mkdirSync(dir, { recursive: true }); mkdirSync(join(dir, 'cache', 'docs'), { recursive: true }); mkdirSync(join(dir, 'public'), { recursive: true });
    console.log(`\n🏗️  Setting up archmap for: ${basename(abs)}\n`);
    const store = new GraphStore(join(dir, 'index.db'));
    const { nodes, edges } = parseRepository(abs);
    store.replaceGraph(nodes, edges);
    identifyFromGraph(store, abs);
    loadSeed(store, abs);
    const gitignorePath = join(abs, '.gitignore');
    const entries = ['.archmap/index.db', '.archmap/vectors/', '.archmap/cache/', '.archmap/daemon.json', '.archmap/agent-runs/'];
    let gi = ''; if (existsSync(gitignorePath)) gi = readFileSync(gitignorePath, 'utf-8');
    const newE = entries.filter(e => !gi.includes(e));
    if (newE.length) writeFileSync(gitignorePath, gi + (gi.endsWith('\n') ? '' : '\n') + newE.join('\n') + '\n');
    const mcpPath = join(abs, '.mcp.json');
    if (!existsSync(mcpPath)) writeFileSync(mcpPath, JSON.stringify({ mcpServers: { 'architecture-mapper': { command: 'npx', args: ['-y', 'archmap', 'mcp'], cwd: '${workspaceFolder}' } } }, null, 2) + '\n');
    const seedPath = join(dir, 'seed.yaml');
    if (!existsSync(seedPath)) writeFileSync(seedPath, `# archmap seed file\nproject:\n  name: ${basename(abs)}\nservices: []\nexternals: []\npins: []\nignore_paths: [node_modules/, dist/, build/, .git/]\ncritical: []\n`);
    // Copy D3.js for local UI serving
    const d3Dest = join(dir, 'public', 'd3.min.js');
    if (!existsSync(d3Dest)) {
      try {
        const d3Source = join(new URL('../../', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'), 'node_modules', 'd3', 'dist', 'd3.min.js');
        if (existsSync(d3Source)) writeFileSync(d3Dest, readFileSync(d3Source));
      } catch { /* D3 not found in package — UI will use CDN fallback */ }
    }
    // Copy archmap-ui.js for local UI serving
    const uiJsDest = join(dir, 'public', 'archmap-ui.js');
    if (!existsSync(uiJsDest)) {
      try {
        const uiJsSource = join(new URL('../../', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'), 'public', 'archmap-ui.js');
        if (existsSync(uiJsSource)) writeFileSync(uiJsDest, readFileSync(uiJsSource));
      } catch { /* archmap-ui.js not found */ }
    }
    const nc = store.nodeCount, ec = store.edgeCount; store.close();
    const j = new Journal(dir); j.append('init', { path: abs, nodeCount: nc, edgeCount: ec });
    const s = ((Date.now() - t0) / 1000).toFixed(1);
    if (opts.json) output(envelope({ nodeCount: nc, edgeCount: ec }));
    else {
      console.log(`✅ Done in ${s}s — ${nc} code pieces, ${ec} connections\n`);
      console.log(`   Open the visualizer:  archmap ui`);
      console.log(`   Or explore:  archmap summary | explain | impact | map\n`);
    }
  });

// ─── summary ───────────────────────────────────────────────────────
program.command('summary').description('See what\'s in your code').option('--json')
  .action((opts: any) => {
    const store = openStore('.'); const nodes = store.listNodes(undefined, 10000);
    if (opts.json) { const c: Record<string, number> = {}; nodes.forEach(n => c[n.kind] = (c[n.kind] || 0) + 1); output(envelope({ nodeCount: nodes.length, edgeCount: store.countEdges(), counts: c })); store.close(); return; }
    const c: Record<string, number> = {}; nodes.forEach(n => c[n.kind] = (c[n.kind] || 0) + 1);
    console.log(`\n📊 Your codebase: ${nodes.length} pieces, ${store.countEdges()} connections\n`);
    for (const [k, v] of Object.entries(c).sort((a, b) => b[1] - a[1])) if (k !== 'File') console.log(`   ${String(v).padStart(3)}  ${KIND_ICON[k] || '•'} ${k}`);
    const top = nodes.filter(n => ['Function', 'Method', 'Class'].includes(n.kind)).map(n => ({ n, c: store.getNeighbors(n.id).length })).sort((a, b) => b.c - a.c).slice(0, 5);
    if (top.length) { console.log('\n🔥 Most connected:\n'); for (const { n, c } of top) console.log(`   ${String(c).padStart(3)} links  ${n.name}  (${n.path || n.id})`); }
    console.log(''); store.close();
  });

// ─── explain ───────────────────────────────────────────────────────
program.command('explain [thing]').alias('symbol').description('What does this code do? Who uses it?')
  .option('--json').action(async (thing?: string, opts: any = {}) => {
    const store = openStore('.');
    if (!thing) { const p = await quickPick(store, 'What do you want to understand?'); if (!p) { store.close(); return; } thing = p.id; }
    const node = findNode(store, thing!);
    if (!node) { console.log(`\n❌ Couldn't find "${thing}"\n`); store.close(); return; }
    if (opts.json) { const callers = store.getInEdges(node.id).filter(e => e.type === 'CALLS'); const callees = store.getOutEdges(node.id).filter(e => e.type === 'CALLS'); output(envelope({ node, who_calls_it: callers.map(e => ({ id: e.from, evidence: e.evidence[0] })), what_it_calls: callees.map(e => ({ id: e.to, evidence: e.evidence[0] })) })); store.close(); return; }
    console.log(`\n${prettyNode(node)}\n`);
    const callers = store.getInEdges(node.id).filter(e => e.type === 'CALLS');
    const callees = store.getOutEdges(node.id).filter(e => e.type === 'CALLS');
    if (callers.length) { console.log('   📥 Who calls this:'); for (const e of callers) { const c = store.getNode(e.from); console.log(`      ← ${c?.name || e.from}  (${e.evidence[0]?.file}:${e.evidence[0]?.line})`); } console.log(''); }
    if (callees.length) { console.log('   📤 What it calls:'); for (const e of callees) { const c = store.getNode(e.to); console.log(`      → ${c?.name || e.to}  (${e.evidence[0]?.file}:${e.evidence[0]?.line})`); } console.log(''); }
    if (!callers.length && !callees.length) console.log('   No connections found.\n');
    store.close();
  });

// ─── impact ────────────────────────────────────────────────────────
program.command('impact [thing]').alias('what-happens').description('What breaks if I change this?')
  .option('--upstream').option('--depth <n>', '5').option('--json')
  .action(async (thing?: string, opts: any = {}) => {
    const store = openStore('.');
    if (!thing) { const p = await quickPick(store, 'Impact of what?'); if (!p) { store.close(); return; } thing = p.id; }
    const node = findNode(store, thing!);
    if (!node) { console.log(`\n❌ Couldn't find "${thing}"\n`); store.close(); return; }
    const result = computeImpact(store, [node.id], { direction: opts.upstream ? 'upstream' : 'downstream', maxDepth: parseInt(opts.depth || '5', 10) });
    if (opts.json) output(envelope(result));
    else {
      const explanation = explainImpact(store, result);
      console.log(`\n🎯 ${explanation.title}\n`);
      console.log(`   ${explanation.summary}\n`);
      console.log(prettyImpact(result));
      if (explanation.nextSteps.length) {
        console.log('\n👉 Next:\n');
        for (const s of explanation.nextSteps) console.log(`   • ${s}`);
        console.log('');
      }
    }
    store.close();
  });

// ─── where-used ────────────────────────────────────────────────────
program.command('where-used [thing]').alias('who-uses').alias('neighbors').description('Who calls/uses this code?')
  .option('--json').action(async (thing?: string, opts: any = {}) => {
    const store = openStore('.');
    if (!thing) { const p = await quickPick(store, 'Who uses what?'); if (!p) { store.close(); return; } thing = p.id; }
    const node = findNode(store, thing!);
    if (!node) { console.log(`\n❌ Couldn't find "${thing}"\n`); store.close(); return; }
    const callers = store.getInEdges(node.id);
    if (opts.json) output(envelope({ node, used_by: callers.map(e => ({ id: e.from, type: e.type, evidence: e.evidence[0] })) }));
    else {
      console.log(`\n📥 Who uses ${node.name}:\n`);
      if (!callers.length) console.log('   Nobody — entry point or unused.\n');
      else { for (const e of callers) { const c = store.getNode(e.from); console.log(`   ← ${c?.name || e.from}  (${e.type})`); } console.log(''); }
    }
    store.close();
  });

// ─── depends-on ────────────────────────────────────────────────────
program.command('depends-on [thing]').alias('dependencies').description('What does this code depend on?')
  .option('--json').action(async (thing?: string, opts: any = {}) => {
    const store = openStore('.');
    if (!thing) { const p = await quickPick(store, 'Dependencies of what?'); if (!p) { store.close(); return; } thing = p.id; }
    const node = findNode(store, thing!);
    if (!node) { console.log(`\n❌ Couldn't find "${thing}"\n`); store.close(); return; }
    const deps = store.getOutEdges(node.id);
    if (opts.json) output(envelope({ node, depends_on: deps.map(e => ({ id: e.to, type: e.type, evidence: e.evidence[0] })) }));
    else {
      console.log(`\n📤 What ${node.name} depends on:\n`);
      if (!deps.length) console.log('   Nothing — leaf node.\n');
      else { for (const e of deps) { const t = store.getNode(e.to); console.log(`   → ${t?.name || e.to}  (${e.type})`); } console.log(''); }
    }
    store.close();
  });

// ─── trace ─────────────────────────────────────────────────────────
program.command('trace [from] [to]').alias('why').alias('why_path').description('Show the path from A to B')
  .option('--json').action(async (from?: string, to?: string, opts: any = {}) => {
    const store = openStore('.');
    if (!from) { const p = await quickPick(store, 'Trace FROM what?'); if (!p) { store.close(); return; } from = p.id; }
    if (!to) { const p = await quickPick(store, 'Trace TO what?'); if (!p) { store.close(); return; } to = p.id; }
    const fromN = findNode(store, from!); const toN = findNode(store, to!);
    if (!fromN || !toN) { console.log(`\n❌ Couldn't find "${!fromN ? from : to}"\n`); store.close(); return; }
    const env = whyPathOp(store, fromN.id, toN.id);
    const paths = env.ok && 'paths' in env.data ? env.data.paths : [];
    if (opts.json) output(envelope({ paths }));
    else {
      if (!paths.length) console.log(`\n🔍 No evidence-backed path found between ${fromN.name} and ${toN.name}\n`);
      else { console.log(`\n🔗 ${fromN.name} → ${toN.name}:\n`); for (const p of paths) { for (const s of p.steps) console.log(`   ${(s.from.split(':').pop() || s.from)} ──${s.edgeType}──▸ ${(s.to.split(':').pop() || s.to)}`); console.log(''); } }
    }
    store.close();
  });

// ─── tests ─────────────────────────────────────────────────────────
program.command('tests [thing]').alias('tests_to_run').description('Which tests should I run?')
  .option('--json').action(async (thing?: string, opts: any = {}) => {
    const store = openStore('.');
    if (!thing) { const p = await quickPick(store, 'Tests for what?'); if (!p) { store.close(); return; } thing = p.id; }
    const node = findNode(store, thing!);
    if (!node) { console.log(`\n❌ Couldn't find "${thing}"\n`); store.close(); return; }
    const result = computeImpact(store, [node.id], { direction: 'downstream', maxDepth: 3 });
    const tests = result.nodes.filter((n: any) => n.kind === 'Test');
    if (opts.json) output(envelope({ tests: tests.map((t: any) => ({ id: t.id, name: t.name, path: t.path })), command: tests.length ? 'npm test' : null }));
    else {
      console.log(`\n🧪 Tests for ${node.name}:\n`);
      if (!tests.length) console.log('   No tests found on impact path.\n');
      else { for (const t of tests) console.log(`   • ${t.name}  (${t.path})`); console.log(''); }
    }
    store.close();
  });

// ─── flow ──────────────────────────────────────────────────────────
program.command('flow [thing]').description('Trace execution flow from this point')
  .option('--json').action(async (thing?: string, opts: any = {}) => {
    const store = openStore('.');
    if (!thing) { const p = await quickPick(store, 'Flow from where?'); if (!p) { store.close(); return; } thing = p.id; }
    const node = findNode(store, thing!);
    if (!node) { console.log(`\n❌ Couldn't find "${thing}"\n`); store.close(); return; }
    const result = reconstructFlow(store, node.id);
    if (opts.json) output(envelope(result));
    else {
      console.log(`\n🌊 Flow from ${node.name}:\n`);
      for (let i = 0; i < result.steps.length; i++) { const s = result.steps[i]; console.log(`   ${i === 0 ? '▶' : '↓'} ${s.label}`); if (s.evidence) console.log(`     📄 ${s.evidence.file}:${s.evidence.line}`); }
      console.log('');
    }
    store.close();
  });

// ─── search ────────────────────────────────────────────────────────
program.command('search [query]').description('Find anything in the code')
  .option('--limit <n>', '10').option('--json').action(async (query?: string, opts: any = {}) => {
    const store = openStore('.');
    if (!query) { const p = await quickPick(store, 'What are you looking for?'); if (!p) { store.close(); return; } if (opts.json) output(envelope(p)); else console.log(`\n  Found: ${prettyNode(p)}\n`); store.close(); return; }
    const rag = new RAGIndex(); rag.indexNodes(store);
    const results = rag.searchWithNodes(store, query, parseInt(opts.limit || '10'));
    if (opts.json) output(envelope(results));
    else { if (!results.length) console.log(`\n🔍 No results for "${query}"\n`); else { console.log(`\n🔍 ${results.length} results for "${query}":\n`); for (const r of results) console.log(prettyNode(r.node)); console.log(''); } }
    store.close();
  });

// ─── map ───────────────────────────────────────────────────────────
program.command('map').alias('graph').description('See the architecture')
  .option('--format <f>', 'mermaid').option('--max-nodes <n>', '50').option('--json')
  .action((opts: any) => {
    const store = openStore('.');
    const view = viewOp(store, 'height').data;
    if (opts.format === 'json' || opts.json) { output(envelope(view)); store.close(); return; }
    console.log('\n🗺️  Architecture map (overview — services, APIs, data, packages)\n');
    console.log('```mermaid');
    console.log(mermaidFromView(view));
    console.log('```\n');
    store.close();
  });

// ─── health ────────────────────────────────────────────────────────
program.command('health').description('Graph health check').option('--json')
  .action((opts: any) => {
    const store = openStore('.'); const rows = healthCheck(store);
    if (opts.json) output(envelope(rows));
    else { console.log('\n🏥 Health:\n'); for (const r of rows) console.log(`   ${r.status === 'ok' ? '✅' : r.status === 'warn' ? '⚠️' : '❌'} ${r.message}`); console.log(''); }
    store.close();
  });

// ─── pin ───────────────────────────────────────────────────────────
program.command('pin').description('Connect two pieces of code')
  .requiredOption('--from <id>').requiredOption('--to <id>').requiredOption('--type <edge>')
  .option('--json').action((opts: any) => {
    const store = openStore('.');
    const edge = store.upsertEdgeByEndpoints(opts.type, opts.from, opts.to, [{ file: 'user', line: 0, snippet: 'user pin' }], ['user']);
    new Journal(getArchmapDir('.')).append('pin', { from: opts.from, to: opts.to, type: opts.type });
    if (opts.json) output(envelope(edge)); else console.log(`\n✅ Connected ${opts.from} → ${opts.to} (${opts.type})\n`);
    store.close();
  });

// ─── sync ──────────────────────────────────────────────────────────
program.command('analyze [path]').alias('sync').description('Analyze / re-scan a repository into the graph').option('--json')
  .action((repoPath: string = '.', opts: any) => {
    const abs = resolve(repoPath); const store = openStore(abs);
    const { nodes, edges } = parseRepository(abs);
    store.replaceGraph(nodes, edges);
    identifyFromGraph(store, abs);
    loadSeed(store, abs);
    if (opts.json) output(envelope({ nodeCount: store.nodeCount, edgeCount: store.edgeCount }));
    else console.log(`\n✅ Re-scanned: ${store.nodeCount} pieces, ${store.edgeCount} connections\n`);
    store.close();
  });

// ─── mcp ───────────────────────────────────────────────────────────
program.command('mcp').description('Start MCP server for AI tools').action(async () => {
  const { startMCPServer } = await import('../mcp/server.js'); startMCPServer();
});

// ─── ui ────────────────────────────────────────────────────────────
program.command('ui').description('Open the visualizer in your browser')
  .option('--port <n>', '3743').option('--no-open')
  .action(async (opts: any) => {
    const port = parseInt(opts.port || '3743', 10);
    if (opts.open !== false) setTimeout(() => {
      const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      import('node:child_process').then(cp => cp.exec(`${cmd} http://localhost:${port}`));
    }, 600);
    const { startUIServer } = await import('../ui/server.js'); await startUIServer(port);
  });

// ─── serve ─────────────────────────────────────────────────────────
program.command('serve').description('Start HTTP API server')
  .option('--port <n>', '3742').action(async (opts: any) => {
    const { startDaemon } = await import('../daemon/server.js'); await startDaemon(parseInt(opts.port || '3742', 10));
  });

// ─── guide ─────────────────────────────────────────────────────────
program.command('guide').description('Interactive walkthrough for first-timers').action(() => {
  console.log(`
🏗️  Welcome to Architecture Mapper!

This tool helps you understand your codebase.
You don't need to know how to code to use it.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STEP 1: Set up
   archmap init              Index your codebase

STEP 2: Open visualizer
   archmap ui                See everything in browser

STEP 3: Explore (no args = interactive picker!)
   archmap summary           See what's in your code
   archmap explain           What does this do?
   archmap where-used        Who uses this code?
   archmap depends-on        What does it need?

STEP 4: Understand risk
   archmap insights          Cycles, coupling, hotspots
   archmap impact            What breaks if I change this?
   archmap tests             Which tests to run?
   archmap trace A B         Why are these connected?

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

💡 Every command works without arguments —
   it shows a numbered list to pick from!

   Every command has --json for machine output.
`);
});

// ─── insights ──────────────────────────────────────────────────────
program.command('insights').description('Cycles, coupling, bottlenecks, hotspots')
  .option('--json').action((opts: any) => {
    const store = openStore('.');
    const env = insightsOp(store);
    if (opts.json) { output(env); store.close(); return; }
    const d = env.data;
    console.log('\n🔎 Architecture insights\n');
    const block = (title: string, lines: string[]) => {
      console.log(`   ${title}`);
      if (!lines.length) console.log('      none found');
      else for (const l of lines.slice(0, 8)) console.log(`      • ${l}`);
      console.log('');
    };
    block('Circular dependencies', d.cycles.map(c => c.nodes.map(id => id.split(':').pop()).join(' → ')));
    block('Highly coupled', d.highlyCoupled.map(i => `${i.name} — ${i.reason}`));
    block('Bottlenecks', d.bottlenecks.map(i => `${i.name} — ${i.reason}`));
    block('Hubs', d.hubs.map(i => `${i.name} — ${i.reason}`));
    block('Isolated', d.isolated.map(i => `${i.name}`));
    block('Hotspots', d.hotspots.map(i => `${i.name} — ${i.reason}`));
    block('Large downstream impact', d.largeDownstream.map(i => `${i.name} — ${i.reason}`));
    store.close();
  });

program.command('plan_change [thing]').description('Bounded files you are allowed to change')
  .option('--json').action(async (thing?: string, opts: any = {}) => {
    const store = openStore('.');
    if (!thing) { const p = await quickPick(store, 'Plan a change to what?'); if (!p) { store.close(); return; } thing = p.id; }
    const env = planChangeOp(store, thing!);
    if (!env.ok || !('target' in env.data)) { console.log(`\n❌ Couldn't find "${thing}"\n`); store.close(); return; }
    if (opts.json) output(env);
    else {
      const plan = env.data;
      console.log(`\n📋 Change plan for ${plan.target.name}\n`);
      console.log('   Allowed files:');
      for (const f of plan.allowedFiles) console.log(`      • ${f}`);
      console.log(`\n   Impacted: ${plan.impacted.length} nodes`);
      if (plan.testsToRun.length) {
        console.log('   Tests:');
        for (const t of plan.testsToRun) console.log(`      • ${t.split(':').pop()}`);
      }
      console.log('');
    }
    store.close();
  });

program.command('diff [base] [head]').description('Impact of a git diff (working tree if no refs given)')
  .option('--json')
  .option('--staged', 'Compare staged (index) changes to HEAD')
  .option('--working', 'Compare the working tree (unstaged + untracked) to HEAD')
  .action((base?: string, head?: string, opts: any = {}) => {
    const store = openStore('.');
    const mode = opts.staged ? 'staged' : (opts.working || !base) ? 'working' : 'range';
    const result = computeDiffImpact(store, { base, head, mode, repoPath: resolve('.') });
    if (opts.json) output(envelope(result));
    else {
      const label = mode === 'working' ? 'working tree vs HEAD' : mode === 'staged' ? 'staged vs HEAD' : `${result.base}...${result.head}`;
      console.log(`\n📑 Diff impact (${label})`);
      if (result.gitError) console.log(`   ⚠️  ${result.gitError}`);
      if (result.changedPaths.length) console.log(`   ${result.changedPaths.length} changed file(s)`);
      if (result.changedSymbols.length) {
        console.log(`   ${result.changedSymbols.length} changed symbols`);
        for (const s of result.changedSymbols.slice(0, 12)) {
          console.log(`      • ${s.change}  ${s.nodeId}`);
        }
      } else {
        console.log('   No changed symbols resolved from git diff.');
      }
      console.log(prettyImpact(result.impact));
    }
    store.close();
  });

program.command('docs [name]').description('In-repo docs for a component or package')
  .option('--json').action(async (name?: string, opts: any = {}) => {
    const store = openStore('.');
    if (!name) { const p = await quickPick(store, 'Docs for what?'); if (!p) { store.close(); return; } name = p.name; }
    const env = docsOp(store, name!);
    if (opts.json) output(env);
    else {
      const d = env.data;
      console.log(`\n📚 Docs related to ${name}\n`);
      if (!d.docs.length) console.log('   No in-repo README/ADR/docs indexed. Add markdown and re-sync.\n');
      else for (const doc of d.docs) console.log(`   • ${doc.name}  (${doc.path || doc.id})`);
      console.log('');
    }
    store.close();
  });

program.command('status [path]').description('Project/analysis status').option('--json')
  .action((repoPath: string = '.', opts: any = {}) => {
    const abs = resolve(repoPath);
    const dir = getArchmapDir(abs);
    const db = join(dir, 'index.db');
    if (!existsSync(db)) {
      if (opts.json) output(envelope({ initialized: false }));
      else console.log('\n❌ Not initialized. Run: archmap init\n');
      return;
    }
    const store = new GraphStore(db);
    const rows = healthCheck(store);
    const j = new Journal(dir).recent(5);
    const payload = {
      initialized: true,
      path: abs,
      nodes: store.nodeCount,
      edges: store.edgeCount,
      functions: store.countNodes('Function'),
      apis: store.countNodes('API'),
      tables: store.countNodes('Table'),
      services: store.countNodes('Service'),
      lastEvents: j.map(e => ({ event: e.event, at: e.timestamp })),
    };
    if (opts.json) output(envelope(payload));
    else {
      console.log(`\n📍 ${basename(abs)}`);
      console.log(`   ${payload.nodes} components, ${payload.edges} relationships`);
      console.log(`   ${payload.functions} functions · ${payload.apis} APIs · ${payload.tables} tables · ${payload.services} services`);
      if (j.length) console.log(`   last: ${j[j.length - 1].event} @ ${j[j.length - 1].timestamp}`);
      console.log('');
    }
    store.close();
  });

program.command('add [path]').description('Import another repository into the current graph (does not wipe)')
  .option('--json').action((repoPath: string = '.', opts: any = {}) => {
    const extra = resolve(repoPath);
    if (!existsSync(extra)) { console.error('Path not found:', extra); process.exit(1); }
    const store = openStore('.');
    const { nodes, edges } = parseRepository(extra);
    store.transaction(() => { store.upsertNodes(nodes); store.upsertEdges(edges); });
    identifyFromGraph(store, extra);
    const payload = { added: extra, nodes: store.nodeCount, edges: store.edgeCount };
    new Journal(getArchmapDir('.')).append('add', payload);
    if (opts.json) output(envelope(payload));
    else console.log(`\n✅ Imported ${extra}\n   graph now: ${payload.nodes} nodes, ${payload.edges} edges\n`);
    store.close();
  });

program.parse();
