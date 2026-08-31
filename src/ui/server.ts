// UI server — localhost visualizer over the ONE graph.
// Serves an interactive architecture visualizer.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { GraphStore } from '../core/store.js';
import { computeImpact } from '../core/impact.js';
import { healthCheck } from '../core/health.js';
import { envelope } from '../core/types.js';

const DEFAULT_PORT = 3743;

function getHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Archmap — Portfolio Brutalist Suite</title>
  <!-- Google Display Fonts -->
  <link href="https://fonts.googleapis.com/css2?family=Cinzel+Decorative:wght@700;900&family=Oswald:wght@500;700&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <!-- D3 Engine -->
  <script src="/d3.min.js"></script>
  <style>
    :root {
      --bg-deep: #000000;
      --bg-panel: #060608;
      --bg-panel-hover: #111115;
      --border-glow: #1c1817;
      --border-active: #ca3e1c;
      --text-main: #fcfaf7;
      --text-muted: #8e8883;
      --primary: #ca3e1c;
      --accent-purple: #6b21a8;
      --accent-beige: #ebdcb9;
      --accent-maroon: #872341;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      background: var(--bg-deep);
      color: var(--text-main);
      overflow: hidden;
      user-select: none;
    }

    #app {
      display: flex;
      height: 100vh;
      width: 100vw;
    }

    /* Left Sidebar */
    #sidebar {
      width: 360px;
      background: var(--bg-panel);
      border-right: 1px solid var(--border-glow);
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 16px;
      z-index: 10;
      box-shadow: 10px 0 30px rgba(0,0,0,0.95);
    }

    /* Main visualizer canvas */
    #graph-container {
      flex: 1;
      position: relative;
      background: radial-gradient(circle at center, #130604 0%, #000000 100%);
    }

    svg#visualizer {
      width: 100%;
      height: 100%;
      display: block;
    }

    /* Right Detail Sidebar */
    #detail-panel {
      position: absolute;
      right: 0;
      top: 0;
      bottom: 0;
      width: 400px;
      background: rgba(6, 6, 8, 0.98);
      backdrop-filter: blur(20px);
      border-left: 1px solid var(--border-glow);
      padding: 28px;
      overflow-y: auto;
      transform: translateX(100%);
      transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1);
      z-index: 20;
      box-shadow: -10px 0 30px rgba(0,0,0,0.95);
    }
    #detail-panel.open {
      transform: translateX(0);
    }

    h1.brand {
      font-family: 'Cinzel Decorative', serif;
      font-size: 21px;
      font-weight: 900;
      letter-spacing: 0.5px;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    h1.brand span {
      background: linear-gradient(135deg, #ca3e1c, #ec6e4c);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .stats {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .stat {
      background: var(--bg-panel-hover);
      border: 1px solid rgba(202, 62, 28, 0.05);
      padding: 12px;
      border-radius: 6px;
      transition: transform 0.2s, border-color 0.2s;
    }
    .stat:hover {
      transform: translateY(-2px);
      border-color: var(--primary);
    }
    .stat-value {
      font-family: 'Oswald', sans-serif;
      font-size: 24px;
      font-weight: 700;
      color: #fff;
    }
    .stat-label {
      font-size: 11px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    /* Inputs & Search */
    .search-container {
      position: relative;
    }
    .search {
      font-family: 'Plus Jakarta Sans', sans-serif;
      width: 100%;
      padding: 12px 16px;
      background: var(--bg-panel-hover);
      border: 1px solid var(--border-glow);
      border-radius: 6px;
      color: #fff;
      font-size: 14px;
      outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    .search:focus {
      border-color: var(--primary);
      box-shadow: 0 0 12px rgba(202, 62, 28, 0.2);
    }

    /* Dynamic Tabs Bar */
    .tab-bar {
      display: flex;
      flex-wrap: wrap;
      background: rgba(255,255,255,0.01);
      padding: 4px;
      border-radius: 6px;
      border: 1px solid rgba(202,62,28,0.05);
      gap: 4px;
    }
    .tab {
      font-family: 'Oswald', sans-serif;
      flex: 1 1 auto;
      padding: 6px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      font-weight: 600;
      background: transparent;
      border: none;
      color: var(--text-muted);
      text-transform: uppercase;
      transition: all 0.2s;
      text-align: center;
      letter-spacing: 0.5px;
    }
    .tab.active {
      background: var(--bg-panel-hover);
      color: var(--primary);
      box-shadow: 0 2px 8px rgba(0,0,0,0.8);
      font-weight: 700;
    }

    /* List styling */
    .node-list-container {
      flex: 1;
      overflow-y: auto;
      margin-right: -10px;
      padding-right: 10px;
    }
    .node-list { list-style: none; display: flex; flex-direction: column; gap: 6px; }
    .node-item {
      padding: 12px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.01);
      border: 1px solid rgba(255,255,255,0.01);
      cursor: pointer;
      transition: all 0.2s;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .node-item:hover {
      background: var(--bg-panel-hover);
      border-color: #3d1c13;
      transform: translateX(4px);
    }
    .node-item.selected {
      background: rgba(202, 62, 28, 0.08);
      border-color: var(--primary);
    }

    .node-header-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .node-name {
      font-size: 13.5px;
      font-weight: 600;
      color: #fff;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .node-kind-badge {
      font-family: 'Oswald', sans-serif;
      font-size: 9px;
      font-weight: 700;
      padding: 3px 6px;
      border-radius: 3px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      background: rgba(255,255,255,0.04);
      color: #d4cfc9;
      border: 1px solid rgba(255,255,255,0.08);
    }
    .node-path-row {
      font-size: 11px;
      color: var(--text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* All links are pure white and greyish monochrome shades (enhanced visibility) */
    .link {
      stroke: rgba(255, 255, 255, 0.22);
      stroke-width: 1.5px;
      fill: none;
      transition: stroke 0.3s, stroke-width 0.3s, stroke-opacity 0.3s;
      cursor: pointer;
    }
    .link.type-CONTAINS {
      stroke: rgba(255, 255, 255, 0.08);
      stroke-width: 1px;
      stroke-dasharray: 2 2;
    }
    .link.type-CALLS {
      stroke: rgba(255, 255, 255, 0.32);
    }
    .link.type-IMPORTS {
      stroke: rgba(255, 255, 255, 0.18);
      stroke-dasharray: 3 3;
    }
    .link.type-EXPOSES {
      stroke: rgba(255, 255, 255, 0.35);
      stroke-dasharray: 4 4;
    }
    .link.type-READS, .link.type-WRITES {
      stroke: rgba(255, 255, 255, 0.26);
    }

    /* Solid bright white highlighted link */
    .link.highlight {
      stroke: #ffffff !important;
      stroke-width: 2.5px !important;
      stroke-opacity: 0.95 !important;
    }

    .link.fade {
      stroke-opacity: 0.02 !important;
    }

    /* Shapes base animations and states */
    .node-g {
      cursor: grab;
      transition: opacity 0.3s;
    }
    .node-g:active {
      cursor: grabbing;
    }
    
    .node-shape {
      stroke-width: 1.5px;
      transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275), stroke-width 0.3s, fill 0.3s, stroke 0.3s;
    }
    .node-shape.highlight {
      stroke-width: 3.5px;
    }
    .node-g.fade {
      opacity: 0.08;
    }
    .node-g.selected .node-shape {
      stroke: #ffffff;
      stroke-width: 3px;
    }
    .node-g.selected text.node-label {
      fill: #ffffff;
      opacity: 1;
    }

    .node-label {
      font-size: 10px;
      fill: var(--text-muted);
      pointer-events: none;
      font-weight: 500;
      transition: fill 0.3s, font-size 0.3s, opacity 0.3s;
    }
    .node-label.active {
      fill: #ffffff;
      font-weight: 700;
      font-size: 12px;
      opacity: 1 !important;
    }

    /* Detail layout */
    .close-detail {
      background: transparent;
      border: none;
      color: var(--text-muted);
      font-size: 20px;
      cursor: pointer;
      position: absolute;
      top: 24px;
      right: 24px;
      transition: color 0.2s;
    }
    .close-detail:hover { color: #fff; }

    .detail-section {
      margin-top: 24px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .section-title {
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      color: var(--text-muted);
      border-bottom: 1px solid rgba(255,255,255,0.05);
      padding-bottom: 6px;
    }

    .signature-box {
      background: rgba(0,0,0,0.6);
      border: 1px solid var(--border-glow);
      border-radius: 6px;
      padding: 12px;
      font-family: monospace;
      font-size: 12px;
      color: #ffffff;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }

    /* Risk tags */
    .risk-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      margin: 3px;
    }
    .risk-critical { background: rgba(248, 113, 113, 0.1); color: #f87171; border: 1px solid rgba(248, 113, 113, 0.2); }
    .risk-untested { background: rgba(202, 62, 28, 0.1); color: #ca3e1c; border: 1px solid rgba(202, 62, 28, 0.2); }
    .risk-db_write { background: rgba(235, 220, 185, 0.1); color: #ebdcb9; border: 1px solid rgba(235, 220, 185, 0.2); }
    .risk-external { background: rgba(107, 33, 168, 0.1); color: #a78bfa; border: 1px solid rgba(107, 33, 168, 0.2); }

    /* Flow step / why-path styling */
    .why-path {
      background: rgba(255,255,255,0.01);
      border: 1px solid rgba(255,255,255,0.02);
      border-radius: 6px;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .why-step {
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .arrow { color: var(--primary); font-weight: bold; }

    /* Detail simple items */
    .neighbor-item {
      padding: 8px 12px;
      background: rgba(255,255,255,0.01);
      border-radius: 4px;
      border: 1px solid rgba(255,255,255,0.01);
      font-size: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      cursor: pointer;
      transition: all 0.2s;
    }
    .neighbor-item:hover {
      background: var(--bg-panel-hover);
      border-color: #551c11;
      transform: translateX(4px);
    }

    /* Edge animated flows */
    .pulse-dot {
      fill: #ffffff;
      filter: url(#glow-pulse);
    }

    /* Canvas press interactive wave ripple */
    .press-ripple {
      fill: none;
      stroke-width: 2px;
      stroke-opacity: 1;
      pointer-events: none;
    }

    /* Natural Language Impact Summary Card Styles */
    .impact-prediction-card {
      background: rgba(202, 62, 28, 0.04);
      border: 1px solid rgba(202, 62, 28, 0.25);
      border-radius: 6px;
      padding: 16px;
      margin-top: 20px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
    }
    .prediction-title {
      font-family: 'Oswald', sans-serif;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.5px;
      color: var(--primary);
      text-transform: uppercase;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .prediction-text {
      font-size: 12.5px;
      line-height: 1.55;
      color: #eae7e2;
    }
    .prediction-item {
      display: flex;
      gap: 8px;
      font-size: 12px;
      line-height: 1.45;
      color: #d1d5db;
    }
    .prediction-bullet {
      color: var(--primary);
      font-weight: bold;
    }

    /* Scrollbar */
    ::-webkit-scrollbar {
      width: 4px;
    }
    ::-webkit-scrollbar-track {
      background: transparent;
    }
    ::-webkit-scrollbar-thumb {
      background: #3a1610;
      border-radius: 10px;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: var(--primary);
    }
  </style>
</head>
<body>
  <div id="app">
    <!-- Left Panel -->
    <div id="sidebar">
      <h1 class="brand">⬡ <span>Archmap</span></h1>
      
      <div class="stats" id="stats">
        <div class="stat">
          <div class="stat-value" id="stat-nodes">0</div>
          <div class="stat-label">Nodes</div>
        </div>
        <div class="stat">
          <div class="stat-value" id="stat-edges">0</div>
          <div class="stat-label">Edges</div>
        </div>
      </div>

      <div class="search-container">
        <input class="search" id="search" placeholder="Search codebase symbols..." />
      </div>

      <div class="tab-bar">
        <!-- Dynamically generated based on present kinds -->
      </div>

      <div class="node-list-container">
        <ul class="node-list" id="nodeList"></ul>
      </div>
    </div>

    <!-- Center Visualization Screen -->
    <div id="graph-container">
      <svg id="visualizer">
        <!-- Filters Definitions -->
        <defs>
          <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id="glow-pulse" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          
          <!-- Monochrome Directional Markers -->
          <marker id="arrow-CONTAINS" viewBox="0 0 10 10" refX="22" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="rgba(255,255,255,0.04)" />
          </marker>
          <marker id="arrow-CONTAINS-highlight" viewBox="0 0 10 10" refX="22" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#ffffff" />
          </marker>

          <marker id="arrow-CALLS" viewBox="0 0 10 10" refX="22" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="rgba(255,255,255,0.12)" />
          </marker>
          <marker id="arrow-CALLS-highlight" viewBox="0 0 10 10" refX="22" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#ffffff" />
          </marker>

          <marker id="arrow-IMPORTS" viewBox="0 0 10 10" refX="22" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="rgba(255,255,255,0.07)" />
          </marker>
          <marker id="arrow-IMPORTS-highlight" viewBox="0 0 10 10" refX="22" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#ffffff" />
          </marker>

          <marker id="arrow-EXPOSES" viewBox="0 0 10 10" refX="22" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="rgba(255,255,255,0.14)" />
          </marker>
          <marker id="arrow-EXPOSES-highlight" viewBox="0 0 10 10" refX="22" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#ffffff" />
          </marker>

          <marker id="arrow-READS" viewBox="0 0 10 10" refX="22" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="rgba(255,255,255,0.1)" />
          </marker>
          <marker id="arrow-READS-highlight" viewBox="0 0 10 10" refX="22" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#ffffff" />
          </marker>

          <marker id="arrow-WRITES" viewBox="0 0 10 10" refX="22" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="rgba(255,255,255,0.1)" />
          </marker>
          <marker id="arrow-WRITES-highlight" viewBox="0 0 10 10" refX="22" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#ffffff" />
          </marker>
        </defs>
        
        <!-- Zoom/Pan Group Container -->
        <g id="main-group">
          <g id="links-layer"></g>
          <g id="pulses-layer"></g>
          <g id="nodes-layer"></g>
        </g>
      </svg>
    </div>

    <!-- Right Slide Detail Sidebar -->
    <div id="detail-panel">
      <button class="close-detail" id="closeDetail">✕</button>
      <div id="detailContent"></div>
    </div>
  </div>

  <script src="/archmap-ui.js"></script>
</body>
</html>`;
}

export async function startUIServer(port = DEFAULT_PORT): Promise<void> {
  const cwd = process.cwd();
  const dbPath = join(cwd, '.archmap', 'index.db');

  if (!existsSync(dbPath)) {
    console.error('No .archmap/index.db found. Run "archmap init" first.');
    process.exit(1);
  }

  const store = new GraphStore(dbPath);

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';

    // API routes
    if (url === '/api/graph' && req.method === 'GET') {
      const nodes = store.listNodes(undefined, 5000);
      const edges = nodes.flatMap(n => store.getOutEdges(n.id));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ nodes, edges }));
      return;
    }

    if (url.startsWith('/api/neighbors/') && req.method === 'GET') {
      const nodeId = decodeURIComponent(url.slice('/api/neighbors/'.length));
      const edges = store.getNeighbors(nodeId);
      const nodes = edges.map(e => {
        const otherId = e.from === nodeId ? e.to : e.from;
        return store.getNode(otherId);
      }).filter(Boolean);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ edges, nodes }));
      return;
    }

    if (url.startsWith('/api/impact/') && req.method === 'GET') {
      const nodeId = decodeURIComponent(url.slice('/api/impact/'.length));
      const result = computeImpact(store, [nodeId], { direction: 'downstream' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(envelope(result)));
      return;
    }

    if (url === '/api/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(envelope(healthCheck(store))));
      return;
    }

    // Serve static JS files (D3, archmap-ui)
    if (url.startsWith('/d3.min.js') || url.startsWith('/archmap-ui.js')) {
      const fileName = url === '/d3.min.js' ? 'd3.min.js' : 'archmap-ui.js';
      const publicPath = join(process.cwd(), 'public', fileName);
      const archmapPublic = join(process.cwd(), '.archmap', 'public', fileName);
      const filePath = existsSync(publicPath) ? publicPath : existsSync(archmapPublic) ? archmapPublic : null;
      if (filePath) {
        res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'public, max-age=86400' });
        res.end(readFileSync(filePath));
        return;
      }
    }

    // Serve HTML
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(getHTML());
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`archmap ui serving at http://127.0.0.1:${port}`);
  });

  process.on('SIGINT', () => {
    store.close();
    server.close();
    process.exit(0);
  });
}