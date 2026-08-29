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
  <title>Architecture Mapper — Monochrome Suite</title>
  <!-- D3 Engine -->
  <script src="https://d3js.org/d3.v7.min.js"></script>
  <style>
    :root {
      --bg-deep: #050505;
      --bg-panel: #0d0d0d;
      --bg-panel-hover: #161616;
      --border-glow: #222222;
      --border-active: #ffffff;
      --text-main: #f3f4f6;
      --text-muted: #8e9196;
      --primary: #ffffff;
      --accent: #a3a3a3;
      --accent-dark: #404040;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
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
      box-shadow: 10px 0 30px rgba(0,0,0,0.8);
    }

    /* Main visualizer canvas */
    #graph-container {
      flex: 1;
      position: relative;
      background: radial-gradient(circle at center, #111111 0%, #030303 100%);
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
      background: rgba(13, 13, 13, 0.95);
      backdrop-filter: blur(20px);
      border-left: 1px solid var(--border-glow);
      padding: 28px;
      overflow-y: auto;
      transform: translateX(100%);
      transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1);
      z-index: 20;
      box-shadow: -10px 0 30px rgba(0,0,0,0.8);
    }
    #detail-panel.open {
      transform: translateX(0);
    }

    h1.brand {
      font-size: 19px;
      font-weight: 800;
      letter-spacing: 0.5px;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    h1.brand span {
      background: linear-gradient(135deg, #ffffff, #888888);
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
      border: 1px solid rgba(255, 255, 255, 0.02);
      padding: 12px;
      border-radius: 6px;
      transition: transform 0.2s, border-color 0.2s;
    }
    .stat:hover {
      transform: translateY(-2px);
      border-color: #404040;
    }
    .stat-value {
      font-size: 22px;
      font-weight: 800;
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
      border-color: var(--border-active);
      box-shadow: 0 0 12px rgba(255, 255, 255, 0.1);
    }

    /* Tabs */
    .tab-bar {
      display: flex;
      background: rgba(255,255,255,0.01);
      padding: 4px;
      border-radius: 6px;
      border: 1px solid rgba(255,255,255,0.03);
    }
    .tab {
      flex: 1;
      padding: 8px;
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
    }
    .tab.active {
      background: var(--bg-panel-hover);
      color: #fff;
      box-shadow: 0 2px 8px rgba(0,0,0,0.5);
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
      border-color: #404040;
      transform: translateX(4px);
    }
    .node-item.selected {
      background: rgba(255, 255, 255, 0.05);
      border-color: var(--border-active);
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
      font-size: 9px;
      font-weight: 700;
      padding: 3px 6px;
      border-radius: 3px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .node-path-row {
      font-size: 11px;
      color: var(--text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* Monochrome Kinds Badges */
    .badge-Function, .badge-Method { background: #ffffff; color: #000000; }
    .badge-Class { background: #e5e5e5; color: #000000; }
    .badge-Interface { background: #a3a3a3; color: #000000; }
    .badge-Table { background: #404040; color: #ffffff; border: 1px solid #525252; }
    .badge-API { background: #ffffff; color: #000000; border: 1px solid #000000; }
    .badge-File { background: #262626; color: #a3a3a3; }
    .badge-External { background: #171717; color: #737373; border: 1px solid #262626; }
    .badge-Test { background: #d4d4d4; color: #000000; }

    /* SVG elements styles */
    .link {
      stroke: rgba(255, 255, 255, 0.06);
      stroke-width: 1.5px;
      fill: none;
      transition: stroke 0.3s, stroke-width 0.3s, stroke-opacity 0.3s;
      cursor: pointer;
    }
    .link.highlight {
      stroke: #ffffff;
      stroke-width: 2.5px;
      stroke-opacity: 0.95;
    }
    .link.fade {
      stroke-opacity: 0.02;
    }

    .node-g {
      cursor: grab;
      transition: opacity 0.3s;
    }
    .node-g:active {
      cursor: grabbing;
    }
    .node-circle {
      stroke-width: 1.5px;
      transition: r 0.3s, stroke-width 0.3s, fill 0.3s, stroke 0.3s;
    }
    .node-circle.highlight {
      stroke-width: 3.5px;
    }
    .node-g.fade {
      opacity: 0.08;
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
      background: rgba(0,0,0,0.5);
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
    .risk-critical { background: rgba(255, 255, 255, 0.08); color: #ffffff; border: 1px solid rgba(255, 255, 255, 0.15); }
    .risk-untested { background: rgba(163, 163, 163, 0.08); color: #a3a3a3; border: 1px solid rgba(163, 163, 163, 0.15); }
    .risk-db_write { background: rgba(229, 229, 229, 0.08); color: #e5e5e5; border: 1px solid rgba(229, 229, 229, 0.15); }
    .risk-external { background: rgba(64, 64, 64, 0.15); color: #d4d4d4; border: 1px solid rgba(64, 64, 64, 0.25); }

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
    .arrow { color: #ffffff; font-weight: bold; }

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
      border-color: #404040;
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

    /* Scrollbar */
    ::-webkit-scrollbar {
      width: 4px;
    }
    ::-webkit-scrollbar-track {
      background: transparent;
    }
    ::-webkit-scrollbar-thumb {
      background: var(--border-glow);
      border-radius: 10px;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: rgba(255, 255, 255, 0.08);
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
        <button class="tab active" data-view="all">All</button>
        <button class="tab" data-view="Function">Functions</button>
        <button class="tab" data-view="Class">Classes</button>
        <button class="tab" data-view="Table">Tables</button>
        <button class="tab" data-view="API">APIs</button>
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
          
          <!-- Edge Arrows Markers -->
          <marker id="arrow-standard" viewBox="0 0 10 10" refX="22" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="rgba(255,255,255,0.1)" />
          </marker>
          <marker id="arrow-highlight" viewBox="0 0 10 10" refX="22" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
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

  <script>
    // Monochrome configuration details
    const kindColors = {
      Function: '#ffffff',
      Method: '#f5f5f5',
      Class: '#e5e5e5',
      Interface: '#a3a3a3',
      Table: '#d4d4d4',
      API: '#ffffff',
      File: '#404040',
      External: '#262626',
      Test: '#737373',
      Module: '#a3a3a3',
      Repo: '#ffffff'
    };

    let allNodes = [];
    let allEdges = [];
    let selectedNode = null;
    let hoveredNode = null;
    let currentView = 'all';

    // D3 Elements
    const svg = d3.select("svg#visualizer");
    const mainGroup = svg.select("g#main-group");
    const linksLayer = mainGroup.select("g#links-layer");
    const pulsesLayer = mainGroup.select("g#pulses-layer");
    const nodesLayer = mainGroup.select("g#nodes-layer");

    let simulation, zoomBehavior;

    // Initialize application
    async function init() {
      try {
        // 1. Fetch graph data
        const data = await d3.json('/api/graph');
        allNodes = data.nodes;
        allEdges = data.edges;

        // Update counters
        document.getElementById('stat-nodes').textContent = allNodes.length;
        document.getElementById('stat-edges').textContent = allEdges.length;

        // Map from/to properties to source/target for D3 forceLink compliance
        allEdges.forEach(e => {
          e.source = e.from;
          e.target = e.to;
        });

        // Jitter & coordinate safety: ensure nodes have valid x and y coords initially
        allNodes.forEach((n, i) => {
          if (n.x === undefined || isNaN(n.x)) {
            const angle = i * 0.2;
            const r = 50 + i * 4;
            n.x = r * Math.cos(angle);
            n.y = r * Math.sin(angle);
          }
        });

        // Filter out dangling edges referencing missing node IDs to avoid D3 simulation crashes
        const nodeIds = new Set(allNodes.map(n => n.id));
        const validEdges = allEdges.filter(e => {
          const fromId = typeof e.from === 'object' ? e.from.id : e.from;
          const toId = typeof e.to === 'object' ? e.to.id : e.to;
          return nodeIds.has(fromId) && nodeIds.has(toId);
        });

        // 2. Set up swipe panning / zooming using D3 zoom
        zoomBehavior = d3.zoom()
          .scaleExtent([0.1, 8])
          .on("zoom", (event) => {
            mainGroup.attr("transform", event.transform);
          });

        svg.call(zoomBehavior);

        // Center camera baseline safely
        const svgNode = svg.node();
        const width = svgNode ? svgNode.clientWidth || svgNode.getBoundingClientRect().width : window.innerWidth - 360;
        const height = svgNode ? svgNode.clientHeight || svgNode.getBoundingClientRect().height : window.innerHeight;
        svg.call(zoomBehavior.transform, d3.zoomIdentity.translate(width / 2, height / 2).scale(0.8));

        // 3. Set up Force Physics Simulation
        simulation = d3.forceSimulation(allNodes)
          .force("link", d3.forceLink(validEdges).id(d => d.id).distance(120).strength(0.6))
          .force("charge", d3.forceManyBody().strength(-200).distanceMax(500))
          .force("center", d3.forceCenter(0, 0))
          .force("collision", d3.forceCollide().radius(d => getRadius(d) + 18))
          .on("tick", ticked);

        // 4. Register Event Listeners
        initEvents();

        // 5. Initial Render
        renderNodeList();
        updateGraphVisuals(validEdges);
      } catch (err) {
        console.error("Architecture Mapper UI Initialization failed:", err);
        const list = document.getElementById('nodeList');
        if (list) {
          list.innerHTML = '<li style="padding: 12px; color: #ff5ca0; font-size:12px;">Crash: ' + err.message + '</li>';
        }
      }
    }

    function getRadius(d) {
      if (d.kind === 'File') return 6;
      if (d.kind === 'API' || d.kind === 'Table') return 14;
      if (d.kind === 'Class') return 12;
      return 9; // functions & others
    }

    // Force Simulation update ticks
    function ticked() {
      linksLayer.selectAll("path.link")
        .attr("d", d => {
          const from = d.source;
          const to = d.target;
          return 'M' + from.x + ',' + from.y + ' L' + to.x + ',' + to.y;
        });

      nodesLayer.selectAll("g.node-g")
        .attr("transform", d => 'translate(' + d.x + ',' + d.y + ')');
    }

    // Interactive updates to SVG nodes and links
    function updateGraphVisuals(validEdges) {
      const activeKind = currentView;
      const filterNodes = activeKind === 'all' ? allNodes : allNodes.filter(n => n.kind === activeKind);
      const activeIds = new Set(filterNodes.map(n => n.id));

      // Draw lines (Links)
      const linkSelection = linksLayer.selectAll("path.link")
        .data(validEdges, d => d.id);

      // Remove unwanted links
      linkSelection.exit().remove();

      // Insert new links with arrowheads
      const linkEnter = linkSelection.enter().append("path")
        .attr("class", "link")
        .attr("id", d => d.id)
        .attr("marker-end", "url(#arrow-standard)")
        .on("click", (event, d) => {
          event.stopPropagation();
          selectNode(d.source.id);
        });

      // Merge & update attributes
      const linkAll = linkEnter.merge(linkSelection)
        .attr("stroke", d => {
          if (selectedNode && (d.source.id === selectedNode.id || d.target.id === selectedNode.id)) {
            return '#ffffff';
          }
          return 'rgba(255,255,255,0.06)';
        });

      // Draw Nodes (Groups)
      const nodeSelection = nodesLayer.selectAll("g.node-g")
        .data(allNodes, d => d.id);

      nodeSelection.exit().remove();

      const nodeEnter = nodeSelection.enter().append("g")
        .attr("class", "node-g")
        .on("click", (event, d) => {
          event.stopPropagation();
          triggerPressEffect(event, d);
          selectNode(d.id);
        })
        .on("mouseover", (event, d) => {
          setNodeHover(d, true);
        })
        .on("mouseout", (event, d) => {
          setNodeHover(d, false);
        })
        .call(d3.drag()
          .on("start", dragstarted)
          .on("drag", dragged)
          .on("end", dragended)
        );

      // Circle representing actual visual node
      nodeEnter.append("circle")
        .attr("class", "node-circle")
        .attr("r", d => getRadius(d))
        .attr("fill", d => kindColors[d.kind] || '#888')
        .attr("stroke", d => {
          if (d.kind === 'Function' || d.kind === 'API') return '#000000';
          return '#737373';
        })
        .attr("stroke-width", 1.5);

      // Concentric rings for tables and APIs
      nodeEnter.filter(d => d.kind === 'API' || d.kind === 'Table')
        .append("circle")
        .attr("class", "outer-ring")
        .attr("r", d => getRadius(d) + 4)
        .attr("fill", "none")
        .attr("stroke", "#ffffff")
        .attr("stroke-opacity", 0.2)
        .attr("stroke-width", 1);

      // Text labels for symbols
      nodeEnter.append("text")
        .attr("class", "node-label")
        .attr("y", d => -getRadius(d) - 6)
        .attr("text-anchor", "middle")
        .text(d => d.name);

      const nodeAll = nodeEnter.merge(nodeSelection);

      // Apply Filter visual fades (Highlight view)
      nodeAll.each(function(d) {
        const el = d3.select(this);
        const matchesType = activeIds.has(d.id);
        el.classed("fade", !matchesType);
        el.select("text.node-label").style("opacity", matchesType ? (d.kind === 'File' ? 0.2 : 0.8) : 0.05);
      });

      // Restart force physics
      simulation.alpha(0.3).restart();
    }

    // Hover Highlight Spotlight Spotlight
    function setNodeHover(node, isHover) {
      hoveredNode = isHover ? node : null;

      if (!isHover) {
        // Reset all faded items
        nodesLayer.selectAll("g.node-g").classed("fade", false);
        linksLayer.selectAll("path.link")
          .classed("highlight", false)
          .classed("fade", false)
          .attr("marker-end", "url(#arrow-standard)");
        nodesLayer.selectAll("text.node-label").classed("active", false);
        nodesLayer.selectAll("circle.node-circle")
          .attr("filter", null)
          .attr("r", d => getRadius(d))
          .attr("stroke-width", 1.5);
        return;
      }

      // Spotlight effect: find 1st degree connected symbols
      const connectedNodeIds = new Set([node.id]);
      const connectedLinkIds = new Set();

      allEdges.forEach(edge => {
        const srcId = typeof edge.source === 'object' ? edge.source.id : edge.source;
        const tgtId = typeof edge.target === 'object' ? edge.target.id : edge.target;
        if (srcId === node.id) {
          connectedNodeIds.add(tgtId);
          connectedLinkIds.add(edge.id);
        } else if (tgtId === node.id) {
          connectedNodeIds.add(srcId);
          connectedLinkIds.add(edge.id);
        }
      });

      // Apply transitions & filters
      nodesLayer.selectAll("g.node-g").each(function(d) {
        const matches = connectedNodeIds.has(d.id);
        const el = d3.select(this);
        el.classed("fade", !matches);
        
        const isHoverTarget = d.id === node.id;
        el.select("circle.node-circle")
          .attr("r", isHoverTarget ? getRadius(d) * 1.3 : getRadius(d))
          .attr("stroke-width", isHoverTarget ? 3.5 : 1.5)
          .attr("filter", isHoverTarget ? "url(#glow)" : null);

        el.select("text.node-label")
          .classed("active", isHoverTarget);
      });

      linksLayer.selectAll("path.link").each(function(d) {
        const matches = connectedLinkIds.has(d.id);
        d3.select(this)
          .classed("highlight", matches)
          .classed("fade", !matches)
          .attr("marker-end", matches ? "url(#arrow-highlight)" : "url(#arrow-standard)");
      });
    }

    // Trigger explosive Press Particle ripple effect on click
    function triggerPressEffect(event, d) {
      const [mx, my] = d3.pointer(event, svg.node());

      const ripple = svg.append("circle")
        .attr("class", "press-ripple")
        .attr("cx", mx)
        .attr("cy", my)
        .attr("r", 5)
        .attr("stroke", "#ffffff")
        .style("stroke-opacity", 1);

      ripple.transition()
        .duration(600)
        .ease(d3.easeQuadOut)
        .attr("r", 80)
        .style("stroke-opacity", 0)
        .remove();
    }

    // Drag gestures callbacks for force-directed layout
    function dragstarted(event, d) {
      if (!event.active) simulation.alphaTarget(0.1).restart();
      d.fx = d.x;
      d.fy = d.y;
    }

    function dragged(event, d) {
      d.fx = event.x;
      d.fy = event.y;
    }

    function dragended(event, d) {
      if (!event.active) simulation.alphaTarget(0);
      d.fx = null;
      d.fy = null;
    }

    // Select code node, zoom to it, and fetch detailed dependencies
    async function selectNode(id) {
      selectedNode = allNodes.find(n => n.id === id) || null;
      
      // Highlight row selection in left sidebar
      renderNodeList(document.getElementById('search').value);

      if (!selectedNode) {
        document.getElementById('detail-panel').classList.remove('open');
        updateGraphVisuals(allEdges);
        return;
      }

      // Smooth camera pan-and-center to targeted node
      const width = svg.node().clientWidth || window.innerWidth - 360;
      const height = svg.node().clientHeight || window.innerHeight;

      svg.transition()
        .duration(800)
        .ease(d3.easeCubicInOut)
        .call(
          zoomBehavior.transform,
          d3.zoomIdentity
            .translate(width / 2, height / 2)
            .scale(1.2)
            .translate(-selectedNode.x, -selectedNode.y)
        );

      // Re-filter and update
      const nodeIds = new Set(allNodes.map(n => n.id));
      const validEdges = allEdges.filter(e => {
        const fromId = typeof e.from === 'object' ? e.from.id : e.from;
        const toId = typeof e.to === 'object' ? e.to.id : e.to;
        return nodeIds.has(fromId) && nodeIds.has(toId);
      });

      updateGraphVisuals(validEdges);
      showDetail(selectedNode);
    }

    // Fetch and show deep analysis report
    async function showDetail(node) {
      const panel = d3.select("#detail-panel");
      const content = document.getElementById('detailContent');
      panel.classed("open", true);

      content.innerHTML = \`<div style="text-align: center; padding: 40px; color: var(--text-muted);">Analyzing code relationships...</div>\`;

      try {
        // Fetch neighbours & impact report
        const [neighborsData, impactData] = await Promise.all([
          d3.json('/api/neighbors/' + encodeURIComponent(node.id)),
          d3.json('/api/impact/' + encodeURIComponent(node.id))
        ]);

        const neighbors = neighborsData.edges || [];
        const neighborNodes = neighborsData.nodes || [];
        const impact = impactData.data || {};
        const totalImpact = impact.counts ? Object.values(impact.counts).reduce((a, b) => a + b, 0) : 0;

        // Draw animated data pulses along active impact flow lines
        drawFlowPulses(neighbors);

        let html = \`
          <span class="node-kind-badge badge-\${node.kind}">\${node.kind}</span>
          <h1 style="font-size: 20px; font-weight:800; margin-top:8px; line-height:1.2; word-break:break-all;">\${node.name}</h1>
          <p style="font-family:monospace; font-size:11px; color:var(--text-muted); margin-top:4px; word-break:break-all;">\${node.id}</p>
        \`;

        if (node.path) {
          html += \`<p style="font-size:12px; color:#ffffff; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom:12px; margin: 12px 0; font-weight:500;">📄 \${node.path}\${node.startLine ? ':' + node.startLine : ''}</p>\`;
        }

        if (node.signature) {
          html += \`
            <div class="detail-section">
              <div class="section-title">Declaration Signature</div>
              <div class="signature-box">\${escapeHTML(node.signature)}</div>
            </div>
          \`;
        }

        // Blast radius & Risk factors
        html += \`
          <div class="detail-section">
            <div class="section-title">Impact Blast Radius (\${totalImpact} Affected Modules)</div>
            <div style="margin-top: 6px;">
        \`;

        if (impact.riskChips && impact.riskChips.length > 0) {
          impact.riskChips.forEach(r => {
            html += \`<span class="risk-chip risk-\${r.kind}">⬡ \${r.message}</span>\`;
          });
        } else {
          html += \`<p style="font-size:12px; color:var(--text-muted);">No critical architectural risk factors found.</p>\`;
        }

        html += \`</div></div>\`;

        // Interactive why-paths / Dependency Flows
        if (impact.paths && impact.paths.length > 0) {
          html += \`
            <div class="detail-section">
              <div class="section-title">Evidence-Backed Dependency Flows</div>
              <div style="display:flex; flex-direction:column; gap:8px; margin-top:6px;">
          \`;

          impact.paths.slice(0, 5).forEach(p => {
            html += \`<div class="why-path">\`;
            p.steps.forEach(s => {
              html += \`
                <div class="why-step">
                  <span style="font-weight:600; color:#fff;">\${s.from.split(':').pop()}</span>
                  <span class="arrow">→</span>
                  <span style="color:#fff;">\${s.to.split(':').pop()}</span>
                  <span style="color:var(--text-muted); font-size:10px;">[\${s.edgeType}]</span>
                </div>
              \`;
            });
            html += \`</div>\`;
          });

          html += \`</div></div>\`;
        }

        // Neighbors List
        html += \`
          <div class="detail-section">
            <div class="section-title">Direct Connections (\${neighbors.length})</div>
            <div style="display:flex; flex-direction:column; gap:6px; margin-top:6px;">
        \`;

        if (neighbors.length > 0) {
          neighbors.forEach((e, i) => {
            const sideNode = neighborNodes[i] || { name: e.to, id: e.to, kind: 'Unknown' };
            const isOutgoing = e.from === node.id;
            const arrowChar = isOutgoing ? '→' : '←';

            html += \`
              <div class="neighbor-item" onclick="selectNode('\${sideNode.id}')">
                <div>
                  <span style="font-weight:600; color:#fff;">\${sideNode.name}</span>
                  <div style="font-size:10px; color:var(--text-muted);">\${sideNode.kind}</div>
                </div>
                <div style="font-size:11px; font-weight:700; color: #ffffff;">
                  \${arrowChar} \${e.type}
                </div>
              </div>
            \`;
          });
        } else {
          html += \`<p style="font-size:12px; color:var(--text-muted);">This component is isolated.</p>\`;
        }

        html += \`</div></div>\`;

        content.innerHTML = html;

      } catch (err) {
        console.error(err);
        content.innerHTML = \`<div style="color:#ffffff; padding: 40px; text-align:center;">Failed to run impact query.</div>\`;
      }
    }

    // Creates beautiful glowing pulses moving along the dependency links
    function drawFlowPulses(neighborEdges) {
      pulsesLayer.selectAll("circle.pulse-dot").remove();

      neighborEdges.forEach(edge => {
        const pathEl = document.getElementById(edge.id);
        if (!pathEl) return;

        // Add moving glowing particle
        const dot = pulsesLayer.append("circle")
          .attr("class", "pulse-dot")
          .attr("r", 3.5)
          .attr("fill", "#ffffff");

        dot.append("animateMotion")
          .attr("dur", "2.0s")
          .attr("repeatCount", "indefinite")
          .attr("path", pathEl.getAttribute("d"));
      });
    }

    function escapeHTML(str) {
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // Sync left sidebar list
    function renderNodeList(query = '') {
      const list = document.getElementById('nodeList');
      const activeKind = currentView;
      
      const filtered = allNodes.filter(n => {
        const matchesKind = activeKind === 'all' || n.kind === activeKind;
        const matchesSearch = !query || n.name.toLowerCase().includes(query.toLowerCase()) || n.id.toLowerCase().includes(query.toLowerCase());
        return matchesKind && matchesSearch;
      });

      list.innerHTML = filtered.slice(0, 150).map(n => \`
        <li class="node-item \${selectedNode?.id === n.id ? 'selected' : ''}" onclick="selectNode('\${n.id}')">
          <div class="node-header-row">
            <span class="node-name">\${n.name}</span>
            <span class="node-kind-badge badge-\${n.kind}">\${n.kind.slice(0,4)}</span>
          </div>
          <div class="node-path-row">\${n.path || n.id}</div>
        </li>
      \`).join('');
    }

    function initEvents() {
      // Close side panel
      document.getElementById('closeDetail').addEventListener('click', () => {
        selectedNode = null;
        document.getElementById('detail-panel').classList.remove('open');
        pulsesLayer.selectAll("circle.pulse-dot").remove();
        
        const nodeIds = new Set(allNodes.map(n => n.id));
        const validEdges = allEdges.filter(e => {
          const fromId = typeof e.from === 'object' ? e.from.id : e.from;
          const toId = typeof e.to === 'object' ? e.to.id : e.to;
          return nodeIds.has(fromId) && nodeIds.has(toId);
        });
        updateGraphVisuals(validEdges);
      });

      // Interactive real-time search
      document.getElementById('search').addEventListener('input', (e) => {
        renderNodeList(e.target.value);
      });

      // Filter Tabs
      document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', (e) => {
          document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
          tab.classList.add('active');
          currentView = tab.dataset.view;
          
          renderNodeList(document.getElementById('search').value);
          
          const nodeIds = new Set(allNodes.map(n => n.id));
          const validEdges = allEdges.filter(e => {
            const fromId = typeof e.from === 'object' ? e.from.id : e.from;
            const toId = typeof e.to === 'object' ? e.to.id : e.to;
            return nodeIds.has(fromId) && nodeIds.has(toId);
          });
          updateGraphVisuals(validEdges);
        });
      });
    }

    // Run
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
