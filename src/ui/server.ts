// UI server — localhost visualizer over the ONE graph.
// Serves an interactive architecture visualizer.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { GraphStore } from '../core/store.js';
import { computeImpact } from '../core/impact.js';
import { healthCheck } from '../core/health.js';
import { envelope } from '../core/types.js';

const DEFAULT_PORT = 3743;

function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function getHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Architecture Mapper</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', system-ui, sans-serif; background: #0a0a1a; color: #e0e0e0; overflow: hidden; }
    #app { display: flex; height: 100vh; }
    #sidebar { width: 320px; background: #12122a; border-right: 1px solid #2a2a4a; padding: 16px; overflow-y: auto; }
    #graph { flex: 1; position: relative; }
    #graph canvas { width: 100%; height: 100%; }
    h1 { font-size: 18px; margin-bottom: 12px; color: #7c8aff; }
    h2 { font-size: 14px; margin: 12px 0 8px; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.5px; }
    .search { width: 100%; padding: 8px 12px; background: #1a1a3a; border: 1px solid #3a3a5a; border-radius: 6px; color: #e0e0e0; font-size: 14px; margin-bottom: 12px; }
    .search:focus { outline: none; border-color: #7c8aff; }
    .node-list { list-style: none; }
    .node-item { padding: 8px 12px; border-radius: 6px; cursor: pointer; margin-bottom: 4px; display: flex; align-items: center; gap: 8px; }
    .node-item:hover { background: #1a1a3a; }
    .node-item.selected { background: #2a2a5a; border-left: 3px solid #7c8aff; }
    .node-kind { font-size: 10px; padding: 2px 6px; border-radius: 3px; text-transform: uppercase; font-weight: 600; }
    .kind-Function { background: #1e3a5f; color: #5ca0ff; }
    .kind-Class { background: #3a1e5f; color: #a05cff; }
    .kind-Interface { background: #5f1e3a; color: #ff5ca0; }
    .kind-Table { background: #1e5f3a; color: #5cffa0; }
    .kind-API { background: #5f5f1e; color: #ffff5c; }
    .kind-File { background: #2a2a2a; color: #888; }
    .kind-External { background: #5f3a1e; color: #ffaa5c; }
    .kind-Test { background: #1e5f5f; color: #5cffff; }
    .node-name { font-size: 13px; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .node-path { font-size: 11px; color: #666; }
    #detail-panel { position: absolute; right: 0; top: 0; bottom: 0; width: 360px; background: #12122a; border-left: 1px solid #2a2a4a; padding: 16px; overflow-y: auto; transform: translateX(100%); transition: transform 0.2s; }
    #detail-panel.open { transform: translateX(0); }
    .close-btn { position: absolute; top: 12px; right: 12px; background: none; border: none; color: #666; cursor: pointer; font-size: 18px; }
    .edge-list { list-style: none; }
    .edge-item { padding: 6px 0; border-bottom: 1px solid #1a1a3a; font-size: 12px; }
    .edge-type { color: #7c8aff; font-weight: 600; }
    .edge-target { color: #aaa; }
    .risk-chip { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; margin: 2px; }
    .risk-critical { background: #5f1e1e; color: #ff5c5c; }
    .risk-untested { background: #5f3a1e; color: #ffaa5c; }
    .risk-db_write { background: #1e5f3a; color: #5cffa0; }
    .risk-external { background: #3a1e5f; color: #a05cff; }
    .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 16px; }
    .stat { background: #1a1a3a; padding: 8px 12px; border-radius: 6px; }
    .stat-value { font-size: 20px; font-weight: 700; color: #7c8aff; }
    .stat-label { font-size: 11px; color: #666; }
    #cy { width: 100%; height: 100%; background: #0a0a1a; }
    .tab-bar { display: flex; gap: 4px; margin-bottom: 12px; }
    .tab { padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; background: #1a1a3a; border: none; color: #888; }
    .tab.active { background: #2a2a5a; color: #7c8aff; }
    .impact-results { margin-top: 8px; }
    .why-path { margin: 8px 0; padding: 8px; background: #1a1a3a; border-radius: 6px; }
    .why-step { font-size: 12px; padding: 2px 0; }
    .arrow { color: #7c8aff; margin: 0 4px; }
    canvas#graphCanvas { display: block; }
  </style>
</head>
<body>
  <div id="app">
    <div id="sidebar">
      <h1>⬡ Architecture Mapper</h1>
      <div class="stats" id="stats"></div>
      <input class="search" id="search" placeholder="Search nodes..." />
      <div class="tab-bar">
        <button class="tab active" data-view="all">All</button>
        <button class="tab" data-view="Function">Functions</button>
        <button class="tab" data-view="Class">Classes</button>
        <button class="tab" data-view="Table">Tables</button>
      </div>
      <ul class="node-list" id="nodeList"></ul>
    </div>
    <div id="graph">
      <canvas id="graphCanvas"></canvas>
    </div>
    <div id="detail-panel">
      <button class="close-btn" id="closeDetail">✕</button>
      <div id="detailContent"></div>
    </div>
  </div>
  <script>
    const API = '';
    let allNodes = [];
    let allEdges = [];
    let selectedNode = null;
    let currentView = 'all';
    let canvas, ctx;
    let nodePositions = {};
    let hoveredNode = null;
    let dragNode = null;
    let offsetX = 0, offsetY = 0;

    async function init() {
      canvas = document.getElementById('graphCanvas');
      ctx = canvas.getContext('2d');
      resize();
      window.addEventListener('resize', resize);

      // Load data
      const data = await fetch(API + '/api/graph').then(r => r.json());
      allNodes = data.nodes;
      allEdges = data.edges;

      // Stats
      const stats = document.getElementById('stats');
      const kinds = {};
      allNodes.forEach(n => { kinds[n.kind] = (kinds[n.kind] || 0) + 1; });
      stats.innerHTML =
        '<div class="stat"><div class="stat-value">' + allNodes.length + '</div><div class="stat-label">Nodes</div></div>' +
        '<div class="stat"><div class="stat-value">' + allEdges.length + '</div><div class="stat-label">Edges</div></div>' +
        '<div class="stat"><div class="stat-value">' + (kinds.Function || 0) + '</div><div class="stat-label">Functions</div></div>' +
        '<div class="stat"><div class="stat-value">' + (kinds.Class || 0) + '</div><div class="stat-label">Classes</div></div>';

      renderNodeList();
      layoutGraph();
      renderGraph();

      // Canvas events
      canvas.addEventListener('click', onCanvasClick);
      canvas.addEventListener('mousemove', onCanvasMouseMove);
      canvas.addEventListener('mousedown', onCanvasMouseDown);
      canvas.addEventListener('mouseup', onCanvasMouseUp);

      // Search
      document.getElementById('search').addEventListener('input', (e) => {
        renderNodeList(e.target.value);
      });

      // Tabs
      document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
          document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
          tab.classList.add('active');
          currentView = tab.dataset.view;
          renderNodeList();
        });
      });

      // Close detail
      document.getElementById('closeDetail').addEventListener('click', () => {
        document.getElementById('detail-panel').classList.remove('open');
        selectedNode = null;
        renderNodeList();
        renderGraph();
      });
    }

    function resize() {
      const container = document.getElementById('graph');
      canvas.width = container.clientWidth;
      canvas.height = container.clientHeight;
      renderGraph();
    }

    function layoutGraph() {
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      const filtered = getFilteredNodes();
      const angleStep = (2 * Math.PI) / Math.max(filtered.length, 1);
      const radius = Math.min(cx, cy) * 0.7;

      filtered.forEach((node, i) => {
        if (!nodePositions[node.id]) {
          nodePositions[node.id] = {
            x: cx + radius * Math.cos(i * angleStep - Math.PI / 2),
            y: cy + radius * Math.sin(i * angleStep - Math.PI / 2),
          };
        }
      });
    }

    function getFilteredNodes() {
      if (currentView === 'all') return allNodes;
      return allNodes.filter(n => n.kind === currentView);
    }

    function renderNodeList(query = '') {
      const list = document.getElementById('nodeList');
      const filtered = getFilteredNodes().filter(n =>
        !query || n.name.toLowerCase().includes(query.toLowerCase()) || n.id.toLowerCase().includes(query.toLowerCase())
      );

      list.innerHTML = filtered.slice(0, 100).map(n =>
        '<li class="node-item' + (selectedNode?.id === n.id ? ' selected' : '') + '" data-id="' + n.id + '">' +
        '<span class="node-kind kind-' + n.kind + '">' + n.kind.slice(0, 4) + '</span>' +
        '<div><div class="node-name">' + n.name + '</div>' +
        '<div class="node-path">' + (n.path || n.id) + '</div></div></li>'
      ).join('');

      list.querySelectorAll('.node-item').forEach(item => {
        item.addEventListener('click', () => selectNode(item.dataset.id));
      });
    }

    async function selectNode(id) {
      selectedNode = allNodes.find(n => n.id === id) || null;
      renderNodeList(document.getElementById('search').value);
      renderGraph();
      if (selectedNode) showDetail(selectedNode);
    }

    async function showDetail(node) {
      const panel = document.getElementById('detail-panel');
      const content = document.getElementById('detailContent');
      panel.classList.add('open');

      // Get neighbors
      const neighborsData = await fetch(API + '/api/neighbors/' + encodeURIComponent(node.id)).then(r => r.json());
      const neighbors = neighborsData.edges || [];
      const neighborNodes = neighborsData.nodes || [];

      // Get impact
      const impactData = await fetch(API + '/api/impact/' + encodeURIComponent(node.id)).then(r => r.json());
      const impact = impactData.data || {};

      content.innerHTML =
        '<h2>' + node.kind + '</h2>' +
        '<h1>' + node.name + '</h1>' +
        '<p style="font-size:12px;color:#666;margin-bottom:12px;">' + node.id + '</p>' +
        (node.signature ? '<pre style="font-size:11px;color:#888;white-space:pre-wrap;word-break:break-all;margin-bottom:12px;">' + node.signature + '</pre>' : '') +
        (node.path ? '<p style="font-size:12px;color:#5ca0ff;margin-bottom:12px;">📄 ' + node.path + (node.startLine ? ':' + node.startLine : '') + '</p>' : '') +
        '<h2>Impact (' + (impact.counts ? Object.values(impact.counts).reduce((a, b) => a + b, 0) : 0) + ' nodes)</h2>' +
        '<div class="impact-results">' +
        (impact.riskChips || []).map(r =>
          '<span class="risk-chip risk-' + r.kind + '">' + r.message + '</span>'
        ).join('') +
        '</div>' +
        '<h2>Paths</h2>' +
        (impact.paths || []).map(p =>
          '<div class="why-path">' + p.steps.map(s =>
            '<div class="why-step">' + s.from.split(':').pop() + '<span class="arrow">→</span>' + s.to.split(':').pop() + ' <span style="color:#7c8aff;">' + s.edgeType + '</span></div>'
          ).join('') + '</div>'
        ).join('') +
        '<h2>Neighbors (' + neighbors.length + ')</h2>' +
        '<ul class="edge-list">' +
        neighbors.map((e, i) =>
          '<li class="edge-item"><span class="edge-type">' + e.type + '</span> <span class="edge-target">' + (neighborNodes[i]?.name || e.to) + '</span></li>'
        ).join('') +
        '</ul>';
    }

    function renderGraph() {
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const visibleNodes = new Set(getFilteredNodes().map(n => n.id));

      // Draw edges
      ctx.strokeStyle = '#2a2a5a';
      ctx.lineWidth = 1;
      allEdges.forEach(edge => {
        if (!visibleNodes.has(edge.from) || !visibleNodes.has(edge.to)) return;
        const from = nodePositions[edge.from];
        const to = nodePositions[edge.to];
        if (!from || !to) return;

        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();

        // Arrow
        const angle = Math.atan2(to.y - from.y, to.x - from.x);
        const midX = (from.x + to.x) / 2;
        const midY = (from.y + to.y) / 2;
        ctx.fillStyle = '#4a4a7a';
        ctx.beginPath();
        ctx.moveTo(midX + 5 * Math.cos(angle), midY + 5 * Math.sin(angle));
        ctx.lineTo(midX - 4 * Math.cos(angle - 0.5), midY - 4 * Math.sin(angle - 0.5));
        ctx.lineTo(midX - 4 * Math.cos(angle + 0.5), midY - 4 * Math.sin(angle + 0.5));
        ctx.fill();
      });

      // Draw nodes
      const kindColors = {
        Function: '#5ca0ff', Class: '#a05cff', Interface: '#ff5ca0',
        Table: '#5cffa0', API: '#ffff5c', File: '#666', External: '#ffaa5c',
        Test: '#5cffff', Method: '#5ca0ff', Module: '#888', Repo: '#aaa',
        Service: '#ff8844', Route: '#ffdd44', Column: '#66ddaa',
        Event: '#dd66ff', Job: '#ffaa44', Infra: '#aa88ff',
        Doc: '#88aaff', Contract: '#aaffaa', ConfigKey: '#ffaa88',
      };

      getFilteredNodes().forEach(node => {
        const pos = nodePositions[node.id];
        if (!pos) return;

        const isSelected = selectedNode?.id === node.id;
        const isHovered = hoveredNode?.id === node.id;
        const color = kindColors[node.kind] || '#888';
        const radius = isSelected ? 8 : isHovered ? 7 : 5;

        // Glow for selected
        if (isSelected) {
          ctx.shadowColor = color;
          ctx.shadowBlur = 15;
        }

        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, radius, 0, 2 * Math.PI);
        ctx.fill();

        ctx.shadowBlur = 0;

        // Label
        if (isSelected || isHovered || node.kind !== 'File') {
          ctx.fillStyle = isSelected ? '#fff' : '#aaa';
          ctx.font = isSelected ? 'bold 11px system-ui' : '10px system-ui';
          ctx.textAlign = 'center';
          ctx.fillText(node.name, pos.x, pos.y - radius - 4);
        }
      });
    }

    function onCanvasClick(e) {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const hit = findNodeAt(x, y);
      if (hit) selectNode(hit.id);
    }

    function onCanvasMouseMove(e) {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      if (dragNode) {
        nodePositions[dragNode.id] = { x: x - offsetX, y: y - offsetY };
        renderGraph();
        return;
      }

      const hit = findNodeAt(x, y);
      if (hit !== hoveredNode) {
        hoveredNode = hit;
        canvas.style.cursor = hit ? 'pointer' : 'default';
        renderGraph();
      }
    }

    function onCanvasMouseDown(e) {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const hit = findNodeAt(x, y);
      if (hit) {
        dragNode = hit;
        offsetX = x - nodePositions[hit.id].x;
        offsetY = y - nodePositions[hit.id].y;
        canvas.style.cursor = 'grabbing';
      }
    }

    function onCanvasMouseUp() {
      dragNode = null;
      canvas.style.cursor = hoveredNode ? 'pointer' : 'default';
    }

    function findNodeAt(x, y) {
      const visible = getFilteredNodes();
      for (const node of visible) {
        const pos = nodePositions[node.id];
        if (!pos) continue;
        const dx = pos.x - x;
        const dy = pos.y - y;
        if (dx * dx + dy * dy < 100) return node;
      }
      return null;
    }

    init();
  </script>
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
