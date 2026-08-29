// UI server — localhost visualizer with horizontal hierarchical layout.
// Pure canvas, no CDN dependencies, guaranteed to work.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { GraphStore } from '../core/store.js';
import { computeImpact } from '../core/impact.js';
import { healthCheck } from '../core/health.js';
import { envelope } from '../core/types.js';
import { projectView } from '../core/views.js';
import { computeInsights } from '../core/insights.js';
import { explainImpact } from '../core/explain.js';
import type { ViewMode } from '../core/types.js';

const DEFAULT_PORT = 3743;

function getGitDiff(): string[] {
  try {
    const out = execSync('git diff --name-only HEAD~1 2>/dev/null || git diff --name-only 2>/dev/null || git ls-files --others --exclude-standard 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return out.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function getHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Archmap — Architecture Visualizer</title>
<style>
  :root {
    --bg: #0a0b10;
    --bg-panel: #0f1018;
    --bg-card: #161825;
    --border: #1e2035;
    --border-active: #3b82f6;
    --text: #e8eaf0;
    --text-dim: #6b7194;
    --accent: #3b82f6;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Inter', -apple-system, system-ui, sans-serif; background: var(--bg); color: var(--text); overflow: hidden; height: 100vh; }
  
  #app { display: flex; height: 100vh; }
  
  /* ── Left Sidebar ── */
  #sidebar {
    width: 320px; min-width: 320px; background: var(--bg-panel);
    border-right: 1px solid var(--border); display: flex; flex-direction: column;
    z-index: 10; padding: 0;
  }
  .sidebar-header { padding: 20px 20px 12px; border-bottom: 1px solid var(--border); }
  .brand { font-size: 16px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
  .brand span { background: linear-gradient(135deg, #60a5fa, #a78bfa); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
  .tagline { font-size: 11px; color: var(--text-dim); margin-top: 4px; }
  
  .stats-row { display: flex; gap: 8px; padding: 12px 20px; border-bottom: 1px solid var(--border); }
  .stat-box { flex: 1; background: var(--bg-card); border-radius: 6px; padding: 10px 12px; text-align: center; }
  .stat-num { font-size: 20px; font-weight: 800; }
  .stat-lbl { font-size: 10px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; }
  
  .search-wrap { padding: 12px 20px; border-bottom: 1px solid var(--border); }
  .search-input {
    width: 100%; padding: 10px 14px; background: var(--bg-card); border: 1px solid var(--border);
    border-radius: 6px; color: #fff; font-size: 13px; outline: none; transition: border-color 0.2s;
  }
  .search-input:focus { border-color: var(--accent); }
  .search-input::placeholder { color: var(--text-dim); }
  
  .filter-bar { display: flex; flex-wrap: wrap; gap: 4px; padding: 8px 20px; border-bottom: 1px solid var(--border); }
  .filter-btn {
    padding: 5px 10px; border-radius: 4px; font-size: 10px; font-weight: 600;
    background: transparent; border: 1px solid transparent; color: var(--text-dim);
    cursor: pointer; text-transform: uppercase; transition: all 0.15s;
  }
  .filter-btn:hover { color: #fff; border-color: var(--border); }
  .filter-btn.active { background: var(--bg-card); color: #fff; border-color: var(--accent); }
  
  .node-list-wrap { flex: 1; overflow-y: auto; padding: 8px 12px; }
  .node-list { list-style: none; display: flex; flex-direction: column; gap: 4px; }
  .node-item {
    padding: 10px 12px; border-radius: 6px; background: transparent; cursor: pointer;
    border: 1px solid transparent; transition: all 0.15s; display: flex; align-items: center; gap: 10px;
  }
  .node-item:hover { background: var(--bg-card); border-color: var(--border); transform: translateX(3px); }
  .node-item.selected { background: rgba(59, 130, 246, 0.1); border-color: var(--accent); }
  .node-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .node-text { flex: 1; min-width: 0; }
  .node-nm { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .node-pth { font-size: 10px; color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
  .node-badge {
    font-size: 9px; font-weight: 700; padding: 2px 5px; border-radius: 3px;
    text-transform: uppercase; letter-spacing: 0.3px; flex-shrink: 0;
  }
  
  /* ── Diff Panel ── */
  .diff-section { border-bottom: 1px solid var(--border); padding: 12px 20px; }
  .diff-title { font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--text-dim); margin-bottom: 8px; display: flex; align-items: center; gap: 6px; }
  .diff-title .dot { width: 6px; height: 6px; border-radius: 50%; background: #f59e0b; }
  .diff-file {
    padding: 6px 10px; margin-bottom: 3px; border-radius: 4px; font-size: 12px;
    background: rgba(245, 158, 11, 0.05); border: 1px solid rgba(245, 158, 11, 0.1);
    cursor: pointer; transition: all 0.15s; font-family: 'SF Mono', monospace;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .diff-file:hover { background: rgba(245, 158, 11, 0.12); border-color: rgba(245, 158, 11, 0.3); }
  .diff-count { font-size: 11px; color: var(--text-dim); margin-top: 4px; }
  
  /* ── Canvas ── */
  #canvas-wrap { flex: 1; position: relative; overflow: hidden; background: var(--bg); }
  canvas#graph { display: block; width: 100%; height: 100%; }
  
  .zoom-badge {
    position: absolute; bottom: 12px; right: 12px; background: var(--bg-panel);
    border: 1px solid var(--border); border-radius: 4px; padding: 4px 10px;
    font-size: 11px; color: var(--text-dim); pointer-events: none;
  }
  
  /* ── Detail Panel (right slide) ── */
  #detail {
    position: absolute; right: 0; top: 0; bottom: 0; width: 420px;
    background: rgba(15, 16, 24, 0.97); backdrop-filter: blur(16px);
    border-left: 1px solid var(--border); padding: 24px; overflow-y: auto;
    transform: translateX(100%); transition: transform 0.3s ease; z-index: 20;
  }
  #detail.open { transform: translateX(0); }
  .detail-close {
    position: absolute; top: 16px; right: 16px; background: none; border: none;
    color: var(--text-dim); font-size: 18px; cursor: pointer;
  }
  .detail-close:hover { color: #fff; }
  .detail-title { font-size: 18px; font-weight: 800; margin-bottom: 4px; word-break: break-all; }
  .detail-sub { font-size: 11px; color: var(--text-dim); font-family: monospace; word-break: break-all; margin-bottom: 12px; }
  .detail-badge { display: inline-block; font-size: 10px; font-weight: 700; padding: 3px 8px; border-radius: 3px; text-transform: uppercase; margin-bottom: 10px; }
  .detail-section { margin-top: 16px; }
  .detail-section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--text-dim); border-bottom: 1px solid var(--border); padding-bottom: 6px; margin-bottom: 8px; }
  .detail-path { font-size: 12px; padding: 8px; background: var(--bg-card); border-radius: 4px; font-family: monospace; margin-bottom: 12px; }
  .detail-sig { font-size: 12px; padding: 10px; background: rgba(0,0,0,0.4); border: 1px solid var(--border); border-radius: 4px; font-family: 'SF Mono', monospace; white-space: pre-wrap; word-break: break-all; margin-bottom: 12px; }
  
  .risk-tag {
    display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px;
    border-radius: 4px; font-size: 11px; font-weight: 600; margin: 3px 3px 3px 0;
  }
  .risk-downstream { background: rgba(59, 130, 246, 0.1); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.2); }
  .risk-db_write { background: rgba(251, 191, 36, 0.1); color: #fbbf24; border: 1px solid rgba(251, 191, 36, 0.2); }
  .risk-external { background: rgba(167, 139, 250, 0.1); color: #a78bfa; border: 1px solid rgba(167, 139, 250, 0.2); }
  .risk-untested { background: rgba(248, 113, 113, 0.1); color: #f87171; border: 1px solid rgba(248, 113, 113, 0.2); }
  .risk-critical { background: rgba(248, 113, 113, 0.15); color: #f87171; border: 1px solid rgba(248, 113, 113, 0.3); }
  
  .path-flow { background: var(--bg-card); border: 1px solid var(--border); border-radius: 6px; padding: 10px; margin-bottom: 8px; }
  .path-step { font-size: 12px; display: flex; align-items: center; gap: 6px; padding: 2px 0; }
  .path-arrow { color: var(--accent); font-weight: bold; }
  
  .conn-item {
    display: flex; align-items: center; justify-content: space-between; padding: 8px 10px;
    border-radius: 4px; background: var(--bg-card); border: 1px solid var(--border);
    margin-bottom: 4px; cursor: pointer; transition: all 0.15s; font-size: 12px;
  }
  .conn-item:hover { border-color: var(--accent); transform: translateX(3px); }
  
  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 10px; }
</style>
</head>
<body>
<div id="app">
  <!-- Left Sidebar -->
  <div id="sidebar">
    <div class="sidebar-header">
      <div class="brand">⬡ <span>Archmap</span></div>
      <div class="tagline">If you change this, what breaks? And why?</div>
    </div>
    
    <div class="stats-row">
      <div class="stat-box"><div class="stat-num" id="s-nodes">0</div><div class="stat-lbl">Nodes</div></div>
      <div class="stat-box"><div class="stat-num" id="s-edges">0</div><div class="stat-lbl">Edges</div></div>
    </div>
    
    <div class="search-wrap">
      <input class="search-input" id="search" placeholder="Search symbols..." />
    </div>
    
    <div class="filter-bar" id="filters"></div>
    
    <div class="diff-section" id="diff-section" style="display:none">
      <div class="diff-title"><span class="dot"></span>Changed Files</div>
      <div id="diff-list"></div>
      <div class="diff-count" id="diff-count"></div>
    </div>
    
    <div class="node-list-wrap">
      <ul class="node-list" id="nodelist"></ul>
    </div>
  </div>
  
  <!-- Canvas -->
  <div id="canvas-wrap">
    <canvas id="graph"></canvas>
    <div class="zoom-badge" id="zoom-badge">100%</div>
    
    <!-- Detail panel -->
    <div id="detail">
      <button class="detail-close" id="detail-close">✕</button>
      <div id="detail-content"></div>
    </div>
  </div>
</div>

<script>
// ── Color palette ──
const KIND_COLORS = {
  Function: '#60a5fa', Method: '#3b82f6', Class: '#c084fc', Interface: '#a78bfa',
  Table: '#fbbf24', API: '#34d399', Route: '#10b981', File: '#64748b',
  External: '#f87171', Test: '#38bdf8', Module: '#818cf8', Package: '#fb923c',
  Service: '#f472b6', Repo: '#e2e8f0', Event: '#f59e0b', Job: '#ef4444',
  Doc: '#94a3b8', Contract: '#2dd4bf', Infra: '#a855f7', Column: '#facc15',
  ConfigKey: '#84cc16'
};
const EDGE_COLORS = {
  CONTAINS: 'rgba(100,116,139,0.15)', CALLS: 'rgba(96,165,250,0.35)',
  IMPORTS: 'rgba(167,139,250,0.3)', IMPLEMENTS: 'rgba(167,139,250,0.3)',
  EXPOSES: 'rgba(52,211,153,0.4)', CONSUMES: 'rgba(244,114,182,0.35)',
  READS: 'rgba(251,191,36,0.3)', WRITES: 'rgba(248,113,113,0.35)',
  PUBLISHES: 'rgba(245,158,11,0.3)', SUBSCRIBES: 'rgba(245,158,11,0.25)',
  TESTS: 'rgba(56,189,248,0.25)', DEPENDS_ON: 'rgba(148,163,184,0.25)',
  DOCUMENTS: 'rgba(148,163,184,0.15)', CONSTRAINED_BY: 'rgba(148,163,184,0.15)',
  CO_CHANGED: 'rgba(248,113,113,0.2)', BROKE_BEFORE: 'rgba(248,113,113,0.15)',
  USES_CONFIG: 'rgba(132,204,22,0.2)'
};
const EDGE_HIGHLIGHT = {
  CONTAINS: '#475569', CALLS: '#60a5fa', IMPORTS: '#c084fc', IMPLEMENTS: '#c084fc',
  EXPOSES: '#34d399', CONSUMES: '#f472b6', READS: '#fbbf24', WRITES: '#f87171',
  PUBLISHES: '#f59e0b', SUBSCRIBES: '#f59e0b', TESTS: '#38bdf8',
  DEPENDS_ON: '#94a3b8', DOCUMENTS: '#94a3b8', CONSTRAINED_BY: '#94a3b8',
  CO_CHANGED: '#f87171', BROKE_BEFORE: '#f87171', USES_CONFIG: '#84cc16'
};

let allNodes = [], allEdges = [], validEdges = [];
let nodeMap = new Map();
let selected = null, hovered = null;
let activeFilter = 'all';
let diffFiles = [];

// Layout data: { x, y, width, height } per node
let layout = new Map();

// Canvas state
const canvas = document.getElementById('graph');
const ctx = canvas.getContext('2d');
let camX = 0, camY = 0, camZoom = 1;
let dragging = false, dragStartX = 0, dragStartY = 0, camStartX = 0, camStartY = 0;
let animFrame = null;

// ── Canvas setup ──
function resizeCanvas() {
  const wrap = document.getElementById('canvas-wrap');
  canvas.width = wrap.clientWidth * devicePixelRatio;
  canvas.height = wrap.clientHeight * devicePixelRatio;
  canvas.style.width = wrap.clientWidth + 'px';
  canvas.style.height = wrap.clientHeight + 'px';
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
}
window.addEventListener('resize', () => { resizeCanvas(); render(); });
resizeCanvas();

// ── Layered Layout (horizontal tree) ──
function computeLayout(nodes, edges) {
  const map = new Map(nodes.map(n => [n.id, n]));
  const inDeg = new Map();
  const adj = new Map();
  
  for (const n of nodes) { inDeg.set(n.id, 0); adj.set(n.id, []); }
  for (const e of edges) {
    if (!map.has(e.from) || !map.has(e.to)) continue;
    if (e.from === e.to) continue;
    inDeg.set(e.to, (inDeg.get(e.to) || 0) + 1);
    adj.get(e.from).push(e.to);
  }
  
  // Assign layers via BFS from roots
  const layers = new Map();
  const queue = [];
  for (const n of nodes) {
    if ((inDeg.get(n.id) || 0) === 0) { layers.set(n.id, 0); queue.push(n.id); }
  }
  // If no roots (cycle), pick node with lowest in-degree
  if (queue.length === 0) {
    const sorted = [...inDeg.entries()].sort((a, b) => a[1] - b[1]);
    if (sorted.length > 0) { layers.set(sorted[0][0], 0); queue.push(sorted[0][0]); }
  }
  
  let maxLayer = 0;
  const visited = new Set(queue);
  while (queue.length > 0) {
    const id = queue.shift();
    const L = layers.get(id);
    for (const child of (adj.get(id) || [])) {
      if (visited.has(child)) {
        // Already assigned; check if we can push it further
        const cur = layers.get(child) || 0;
        if (cur <= L) { layers.set(child, L + 1); }
        continue;
      }
      visited.add(child);
      layers.set(child, L + 1);
      maxLayer = Math.max(maxLayer, L + 1);
      queue.push(child);
    }
  }
  
  // Assign remaining unvisited nodes
  for (const n of nodes) {
    if (!layers.has(n.id)) {
      layers.set(n.id, maxLayer + 1);
      maxLayer++;
    }
  }
  
  // Group by layer
  const byLayer = new Map();
  for (const n of nodes) {
    const L = layers.get(n.id) || 0;
    if (!byLayer.has(L)) byLayer.set(L, []);
    byLayer.get(L).push(n);
  }
  
  // Position: horizontal spacing = 280px per layer, vertical spacing = 60px per node
  const H_GAP = 280;
  const V_GAP = 60;
  const NODE_W = 140;
  const NODE_H = 32;
  
  const result = new Map();
  for (const [L, layerNodes] of byLayer) {
    const totalH = layerNodes.length * V_GAP;
    layerNodes.forEach((n, i) => {
      result.set(n.id, {
        x: L * H_GAP,
        y: i * V_GAP - totalH / 2,
        w: NODE_W,
        h: NODE_H,
        layer: L,
        name: n.name,
        kind: n.kind
      });
    });
  }
  
  return result;
}

// ── Render ──
function render() {
  const W = canvas.width / devicePixelRatio;
  const H = canvas.height / devicePixelRatio;
  
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  ctx.translate(W / 2 + camX, H / 2 + camY);
  ctx.scale(camZoom, camZoom);
  
  // Draw edges
  for (const e of validEdges) {
    const from = layout.get(e.from);
    const to = layout.get(e.to);
    if (!from || !to) continue;
    
    const isHighlighted = selected && (e.from === selected.id || e.to === selected.id);
    const isFaded = selected && !isHighlighted;
    
    if (isFaded) { ctx.globalAlpha = 0.06; }
    else if (isHighlighted) { ctx.globalAlpha = 1; }
    else { ctx.globalAlpha = 1; }
    
    const x1 = from.x + from.w;
    const y1 = from.y + from.h / 2;
    const x2 = to.x;
    const y2 = to.y + to.h / 2;
    
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    // Bezier curve
    const cx1 = x1 + (x2 - x1) * 0.5;
    const cx2 = x2 - (x2 - x1) * 0.5;
    ctx.bezierCurveTo(cx1, y1, cx2, y2, x2, y2);
    
    if (isHighlighted) {
      ctx.strokeStyle = EDGE_HIGHLIGHT[e.type] || '#60a5fa';
      ctx.lineWidth = 2.5;
    } else {
      ctx.strokeStyle = EDGE_COLORS[e.type] || 'rgba(148,163,184,0.15)';
      ctx.lineWidth = 1.2;
    }
    ctx.stroke();
    
    // Arrow at end
    if (isHighlighted || !isFaded) {
      const t = 0.95;
      const ax = bezierPoint(x1, cx1, cx2, x2, t);
      const ay = bezierPoint(y1, y1, y2, y2, t);
      const bx = bezierPoint(x1, cx1, cx2, x2, t - 0.03);
      const by = bezierPoint(y1, y1, y2, y2, t - 0.03);
      const angle = Math.atan2(ay - by, ax - bx);
      
      const sz = isHighlighted ? 8 : 5;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax - sz * Math.cos(angle - 0.4), ay - sz * Math.sin(angle - 0.4));
      ctx.lineTo(ax - sz * Math.cos(angle + 0.4), ay - sz * Math.sin(angle + 0.4));
      ctx.closePath();
      ctx.fillStyle = isHighlighted ? (EDGE_HIGHLIGHT[e.type] || '#60a5fa') : (EDGE_COLORS[e.type] || 'rgba(148,163,184,0.3)');
      ctx.fill();
    }
  }
  
  ctx.globalAlpha = 1;
  
  // Draw nodes
  for (const n of allNodes) {
    const pos = layout.get(n.id);
    if (!pos) continue;
    
    const isVisible = activeFilter === 'all' || n.kind === activeFilter;
    const isHovered = hovered && hovered.id === n.id;
    const isSelected = selected && selected.id === n.id;
    const isConnected = selected && isNodeConnected(n.id);
    const isFaded = selected && !isSelected && !isConnected;
    
    if (isFaded) { ctx.globalAlpha = 0.1; }
    else if (!isVisible) { ctx.globalAlpha = 0.08; }
    else { ctx.globalAlpha = 1; }
    
    const color = KIND_COLORS[n.kind] || '#64748b';
    const r = 6; // border radius
    
    // Node rectangle
    ctx.beginPath();
    roundRect(ctx, pos.x, pos.y, pos.w, pos.h, r);
    
    if (isHovered || isSelected) {
      ctx.fillStyle = color + '30';
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.shadowColor = color;
      ctx.shadowBlur = 12;
    } else {
      ctx.fillStyle = color + '18';
      ctx.strokeStyle = color + '50';
      ctx.lineWidth = 1;
      ctx.shadowBlur = 0;
    }
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;
    
    // Kind indicator bar on left
    ctx.beginPath();
    roundRectLeft(ctx, pos.x, pos.y, 4, pos.h, r);
    ctx.fillStyle = color;
    ctx.fill();
    
    // Node name
    const maxTextW = pos.w - 16;
    ctx.font = '600 11px Inter, system-ui, sans-serif';
    ctx.fillStyle = isFaded ? '#475569' : (isSelected || isHovered ? '#ffffff' : color);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    let label = pos.name;
    if (ctx.measureText(label).width > maxTextW) {
      while (ctx.measureText(label + '…').width > maxTextW && label.length > 3) label = label.slice(0, -1);
      label += '…';
    }
    ctx.fillText(label, pos.x + 12, pos.y + pos.h / 2);
    
    // Kind badge on right
    ctx.font = '700 8px Inter, system-ui, sans-serif';
    const kindLabel = n.kind.slice(0, 4).toUpperCase();
    const kindW = ctx.measureText(kindLabel).width + 8;
    ctx.fillStyle = color + '25';
    ctx.beginPath();
    roundRect(ctx, pos.x + pos.w - kindW - 6, pos.y + pos.h / 2 - 7, kindW, 14, 3);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.fillText(kindLabel, pos.x + pos.w - kindW / 2 - 6, pos.y + pos.h / 2 + 1);
  }
  
  ctx.globalAlpha = 1;
  ctx.restore();
}

// ── Bezier helper ──
function bezierPoint(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return u*u*u*p0 + 3*u*u*t*p1 + 3*u*t*t*p2 + t*t*t*p3;
}

// ── Rounded rect helpers ──
function roundRect(ctx, x, y, w, h, r) {
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function roundRectLeft(ctx, x, y, w, h, r) {
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

// ── Connectivity check ──
function isNodeConnected(id) {
  if (!selected) return false;
  for (const e of validEdges) {
    if ((e.from === selected.id && e.to === id) || (e.to === selected.id && e.from === id)) return true;
  }
  return false;
}

// ── Hit test: find node under mouse ──
function hitTest(mx, my) {
  const W = canvas.width / devicePixelRatio;
  const H = canvas.height / devicePixelRatio;
  const worldX = (mx - W / 2 - camX) / camZoom;
  const worldY = (my - H / 2 - camY) / camZoom;
  
  for (let i = allNodes.length - 1; i >= 0; i--) {
    const n = allNodes[i];
    const pos = layout.get(n.id);
    if (!pos) continue;
    if (worldX >= pos.x && worldX <= pos.x + pos.w && worldY >= pos.y && worldY <= pos.y + pos.h) {
      return n;
    }
  }
  return null;
}

// ── Mouse events ──
canvas.addEventListener('mousedown', e => {
  const node = hitTest(e.offsetX, e.offsetY);
  if (node) {
    selectNode(node.id);
    return;
  }
  dragging = true;
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  camStartX = camX;
  camStartY = camY;
  canvas.style.cursor = 'grabbing';
});

canvas.addEventListener('mousemove', e => {
  if (dragging) {
    camX = camStartX + (e.clientX - dragStartX);
    camY = camStartY + (e.clientY - dragStartY);
    render();
    return;
  }
  const node = hitTest(e.offsetX, e.offsetY);
  if (node !== hovered) {
    hovered = node;
    canvas.style.cursor = node ? 'pointer' : 'grab';
    render();
  }
});

canvas.addEventListener('mouseup', () => {
  dragging = false;
  canvas.style.cursor = hovered ? 'pointer' : 'grab';
});

canvas.addEventListener('mouseleave', () => {
  hovered = null;
  render();
});

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const factor = e.deltaY > 0 ? 0.9 : 1.1;
  camZoom = Math.max(0.05, Math.min(5, camZoom * factor));
  document.getElementById('zoom-badge').textContent = Math.round(camZoom * 100) + '%';
  render();
}, { passive: false });

// ── Sidebar list ──
function renderList(query = '') {
  const list = document.getElementById('nodelist');
  const filtered = allNodes.filter(n => {
    const matchKind = activeFilter === 'all' || n.kind === activeFilter;
    const matchQ = !query || n.name.toLowerCase().includes(query.toLowerCase()) || (n.path || '').toLowerCase().includes(query.toLowerCase());
    return matchKind && matchQ;
  });
  
  list.innerHTML = filtered.slice(0, 200).map(n => {
    const c = KIND_COLORS[n.kind] || '#64748b';
    return '<li class="node-item' + (selected && selected.id === n.id ? ' selected' : '') + '" data-id="' + n.id + '">'
      + '<span class="node-dot" style="background:' + c + '"></span>'
      + '<div class="node-text"><div class="node-nm" style="color:' + c + '">' + esc(n.name) + '</div>'
      + '<div class="node-pth">' + esc(n.path || n.id) + '</div></div>'
      + '<span class="node-badge" style="background:' + c + '20;color:' + c + ';border:1px solid ' + c + '40">' + n.kind.slice(0, 4) + '</span>'
      + '</li>';
  }).join('');
  
  // Click handlers
  list.querySelectorAll('.node-item').forEach(el => {
    el.addEventListener('click', () => selectNode(el.dataset.id));
  });
}

// ── Select node ──
function selectNode(id) {
  selected = allNodes.find(n => n.id === id) || null;
  renderList(document.getElementById('search').value);
  render();
  if (selected) showDetail(selected);
  else document.getElementById('detail').classList.remove('open');
}

// ── Detail panel ──
async function showDetail(node) {
  const panel = document.getElementById('detail');
  const content = document.getElementById('detail-content');
  panel.classList.add('open');
  content.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-dim);">Analyzing...</div>';
  
  try {
    const [neighborsData, impactData] = await Promise.all([
      fetch('/api/neighbors/' + encodeURIComponent(node.id)).then(r => r.json()),
      fetch('/api/impact/' + encodeURIComponent(node.id)).then(r => r.json())
    ]);
    
    const neighbors = neighborsData.edges || [];
    const neighborNodes = neighborsData.nodes || [];
    const impact = (impactData.data || impactData);
    const counts = impact.counts || {};
    const totalImpact = Object.values(counts).reduce((a, b) => a + b, 0);
    
    const c = KIND_COLORS[node.kind] || '#64748b';
    let h = '';
    
    h += '<span class="detail-badge" style="background:' + c + '20;color:' + c + ';border:1px solid ' + c + '40">' + node.kind + '</span>';
    h += '<div class="detail-title" style="color:' + c + '">' + esc(node.name) + '</div>';
    h += '<div class="detail-sub">' + esc(node.id) + '</div>';
    
    if (node.path) h += '<div class="detail-path">📄 ' + esc(node.path) + (node.startLine ? ':' + node.startLine : '') + '</div>';
    if (node.signature) h += '<div class="detail-section"><div class="detail-section-title">Signature</div><div class="detail-sig">' + esc(node.signature) + '</div></div>';
    
    // Impact
    h += '<div class="detail-section"><div class="detail-section-title">Impact (' + totalImpact + ' affected)</div>';
    if (impact.riskChips && impact.riskChips.length > 0) {
      impact.riskChips.forEach(r => { h += '<span class="risk-tag risk-' + r.kind + '">⬡ ' + esc(r.message) + '</span>'; });
    } else {
      h += '<div style="font-size:12px;color:var(--text-dim)">No critical risks</div>';
    }
    h += '</div>';
    
    // Why paths
    if (impact.paths && impact.paths.length > 0) {
      h += '<div class="detail-section"><div class="detail-section-title">Dependency Flows</div>';
      impact.paths.slice(0, 4).forEach(p => {
        h += '<div class="path-flow">';
        p.steps.forEach(s => {
          const fc = KIND_COLORS[s.fromType] || '#fff';
          const tc = KIND_COLORS[s.toType] || '#fff';
          h += '<div class="path-step"><span style="color:' + fc + ';font-weight:600">' + esc(s.from.split(':').pop()) + '</span>'
            + '<span class="path-arrow">→</span>'
            + '<span style="color:' + tc + '">' + esc(s.to.split(':').pop()) + '</span>'
            + '<span style="color:var(--text-dim);font-size:10px">[' + s.edgeType + ']</span></div>';
        });
        h += '</div>';
      });
      h += '</div>';
    }
    
    // Connections
    h += '<div class="detail-section"><div class="detail-section-title">Connections (' + neighbors.length + ')</div>';
    neighbors.forEach((e, i) => {
      const sn = neighborNodes[i] || { name: e.to, kind: 'Unknown' };
      const isOut = e.from === node.id;
      const nc = KIND_COLORS[sn.kind] || '#94a3b8';
      const ec = EDGE_HIGHLIGHT[e.type] || '#64748b';
      h += '<div class="conn-item" data-goto="' + esc(sn.id) + '">'
        + '<span style="color:' + nc + ';font-weight:600">' + esc(sn.name) + ' <span style="color:var(--text-dim);font-size:10px">' + sn.kind + '</span></span>'
        + '<span style="color:' + ec + ';font-size:11px;font-weight:700">' + (isOut ? '→' : '←') + ' ' + e.type + '</span></div>';
    });
    if (neighbors.length === 0) h += '<div style="font-size:12px;color:var(--text-dim)">Isolated</div>';
    h += '</div>';
    
    content.innerHTML = h;
    
    // Click connections to navigate
    content.querySelectorAll('.conn-item[data-goto]').forEach(el => {
      el.addEventListener('click', () => selectNode(el.dataset.goto));
    });
  } catch (err) {
    content.innerHTML = '<div style="color:#f87171;text-align:center;padding:40px">Failed to load details</div>';
  }
}

// ── Zoom to fit ──
function fitGraph() {
  if (layout.size === 0) return;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [id, pos] of layout) {
    minX = Math.min(minX, pos.x);
    maxX = Math.max(maxX, pos.x + pos.w);
    minY = Math.min(minY, pos.y);
    maxY = Math.max(maxY, pos.y + pos.h);
  }
  const W = canvas.width / devicePixelRatio;
  const H = canvas.height / devicePixelRatio;
  const gw = maxX - minX + 100;
  const gh = maxY - minY + 100;
  camZoom = Math.min(W / gw, H / gh) * 0.85;
  camZoom = Math.max(0.05, Math.min(2, camZoom));
  camX = -(minX + maxX) / 2 * camZoom;
  camY = -(minY + maxY) / 2 * camZoom;
  document.getElementById('zoom-badge').textContent = Math.round(camZoom * 100) + '%';
}

// ── Init ──
async function init() {
  try {
    const data = await fetch('/api/graph').then(r => r.json());
    allNodes = data.nodes || [];
    allEdges = data.edges || [];
    nodeMap = new Map(allNodes.map(n => [n.id, n]));
    
    // Filter valid edges
    const ids = new Set(allNodes.map(n => n.id));
    validEdges = allEdges.filter(e => {
      const f = typeof e.from === 'object' ? e.from.id : e.from;
      const t = typeof e.to === 'object' ? e.to.id : e.to;
      return ids.has(f) && ids.has(t) && f !== t;
    });
    
    // Stats
    document.getElementById('s-nodes').textContent = allNodes.length;
    document.getElementById('s-edges').textContent = validEdges.length;
    
    // Layout
    layout = computeLayout(allNodes, validEdges);
    fitGraph();
    
    // Filters
    buildFilters();
    renderList();
    render();
    
    // Diff files
    loadDiff();
  } catch (err) {
    console.error('Init failed:', err);
  }
}

function buildFilters() {
  const kinds = {};
  allNodes.forEach(n => { kinds[n.kind] = (kinds[n.kind] || 0) + 1; });
  const ordered = ['Function', 'Method', 'Class', 'Interface', 'Table', 'API', 'Route', 'External', 'Test', 'Module', 'Package', 'File', 'Service'];
  let h = '<button class="filter-btn active" data-f="all">All</button>';
  ordered.forEach(k => {
    if (kinds[k]) h += '<button class="filter-btn" data-f="' + k + '">' + k + (kinds[k] > 1 ? ' (' + kinds[k] + ')' : '') + '</button>';
  });
  document.getElementById('filters').innerHTML = h;
  document.getElementById('filters').addEventListener('click', e => {
    const btn = e.target.closest('.filter-btn');
    if (!btn) return;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeFilter = btn.dataset.f;
    renderList(document.getElementById('search').value);
    render();
  });
}

async function loadDiff() {
  try {
    const data = await fetch('/api/diff').then(r => r.json());
    const files = data.files || [];
    if (files.length === 0) return;
    diffFiles = files;
    
    const section = document.getElementById('diff-section');
    const list = document.getElementById('diff-list');
    section.style.display = 'block';
    list.innerHTML = files.slice(0, 15).map(f =>
      '<div class="diff-file" data-file="' + esc(f) + '">' + esc(f) + '</div>'
    ).join('');
    document.getElementById('diff-count').textContent = files.length + ' changed file' + (files.length !== 1 ? 's' : '');
    
    list.querySelectorAll('.diff-file').forEach(el => {
      el.addEventListener('click', async () => {
        const fname = el.dataset.file;
        const res = await fetch('/api/diff-impact?file=' + encodeURIComponent(fname)).then(r => r.json());
        if (res.nodes) {
          // Highlight impacted nodes
          const impactedIds = new Set(res.nodes.map(n => n.id));
          selected = null;
          render();
        }
      });
    });
  } catch {}
}

// ── Search ──
document.getElementById('search').addEventListener('input', e => renderList(e.target.value));

// ── Close detail ──
document.getElementById('detail-close').addEventListener('click', () => {
  selected = null;
  document.getElementById('detail').classList.remove('open');
  renderList(document.getElementById('search').value);
  render();
});

// ── Keyboard ──
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    selected = null;
    document.getElementById('detail').classList.remove('open');
    renderList(document.getElementById('search').value);
    render();
  }
});

// Start
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

    if (url === '/api/graph' && req.method === 'GET') {
      const view = projectView(store, 'height');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ nodes: view.nodes, edges: view.edges }));
      return;
    }

    if (url.startsWith('/api/view') && req.method === 'GET') {
      const q = new URL(url, 'http://127.0.0.1').searchParams;
      const mode = (q.get('mode') || 'height') as ViewMode;
      const focus = q.get('focus') || undefined;
      const view = projectView(store, mode, focus || undefined);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(view));
      return;
    }

    if (url === '/api/diff' && req.method === 'GET') {
      const files = getGitDiff();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ files }));
      return;
    }

    if (url.startsWith('/api/diff-impact') && req.method === 'GET') {
      const q = new URL(url, 'http://127.0.0.1').searchParams;
      const fname = q.get('file') || '';
      // Find nodes in that file
      const nodes = store.listNodesByKinds(['Function', 'Method', 'Class', 'Interface', 'API', 'Table', 'Test', 'Module', 'Route', 'External', 'Package'], 500)
        .filter(n => n.path === fname || (n.path || '').startsWith(fname.replace(/\.[^.]+$/, '')));
      const ids = new Set(nodes.map(n => n.id));
      // Impact each
      const allImpactNodes: any[] = [];
      for (const n of nodes.slice(0, 5)) {
        const impact = computeImpact(store, [n.id], { direction: 'downstream' });
        allImpactNodes.push(...impact.nodes);
      }
      const uniqueNodes = [...new Map(allImpactNodes.map(n => [n.id, n])).values()];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ nodes: uniqueNodes }));
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

    if (url.startsWith('/api/explain/') && req.method === 'GET') {
      const nodeId = decodeURIComponent(url.slice('/api/explain/'.length));
      const node = store.resolveNode(nodeId);
      if (!node) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, data: { error: 'not found' } }));
        return;
      }
      const impact = computeImpact(store, [node.id], { direction: 'downstream' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(envelope(explainImpact(store, impact))));
      return;
    }

    if (url === '/api/insights' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(envelope(computeInsights(store))));
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
    console.log(`archmap visualizer at http://127.0.0.1:${port}`);
  });

  process.on('SIGINT', () => {
    store.close();
    server.close();
    process.exit(0);
  });
}
