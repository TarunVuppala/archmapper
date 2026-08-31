
    // Complementary Base Palette for Directory-Tree Coloring (terracotta orange, deep purple, earthy beige, maroon #872341)
    const treePalette = [
      '#ca3e1c', // Burnt Terracotta Orange
      '#4a148c', // Deep Purple
      '#ebdcb9', // Earthy Beige
      '#872341', // Crimson Maroon
      '#f43f5e', // Warm Rose Red
      '#78716c', // Stone Sand Grey
      '#0284c7'  // Sky Blue
    ];

    let allNodes = [];
    let allEdges = [];
    let selectedNode = null;
    let hoveredNode = null;
    let currentView = 'overview';
    let focusDir = null; // depth: which package island is open
    let projection = { nodes: [], edges: [] };

    const OVERVIEW_KINDS = new Set([
      'Service', 'Package', 'API', 'Table', 'External', 'Class',
      'Event', 'Infra', 'Contract', 'Module', 'Interface',
    ]);

    // Map each unique subdirectory directory tree to a base color
    let directoryColorMap = {};

    // D3 Elements
    const svg = d3.select("svg#visualizer");
    const mainGroup = svg.select("g#main-group");
    const linksLayer = mainGroup.select("g#links-layer");
    const pulsesLayer = mainGroup.select("g#pulses-layer");
    const nodesLayer = mainGroup.select("g#nodes-layer");

    let simulation, zoomBehavior;
    let layoutFrozen = false;

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

        // 2. Map directories to base colors
        initDirectoryTreeColors();

        // 3. Generate categories tabs dynamically based ONLY on kinds present in the repo
        buildDynamicTabs();

        // Jitter & coordinate safety: ensure nodes have valid x and y coords initially
        allNodes.forEach((n, i) => {
          if (n.x === undefined || isNaN(n.x)) {
            const angle = i * 0.2;
            const r = 50 + i * 4;
            n.x = r * Math.cos(angle);
            n.y = r * Math.sin(angle);
          }
        });

        // Map from/to properties to source/target for D3 forceLink compliance
        allEdges.forEach(e => {
          e.source = e.from;
          e.target = e.to;
        });

        // Filter out dangling edges referencing missing node IDs to avoid D3 simulation crashes
        const nodeIds = new Set(allNodes.map(n => n.id));
        const validEdges = allEdges.filter(e => {
          const fromId = typeof e.from === 'object' ? e.from.id : e.from;
          const toId = typeof e.to === 'object' ? e.to.id : e.to;
          return nodeIds.has(fromId) && nodeIds.has(toId);
        });

        // Set up swipe panning / zooming using D3 zoom
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

        // 5. Register Event Listeners
        initEvents();

        // 6. Draw the overview (not the file hairball) and lay it out once
        renderNodeList();
        refreshGraph(true);
      } catch (err) {
        console.error("Architecture Mapper UI Initialization failed:", err);
        const list = document.getElementById('nodeList');
        if (list) {
          list.innerHTML = '<li style="padding: 12px; color: #ff5ca0; font-size:12px;">Crash: ' + err.message + '</li>';
        }
      }
    }

    function freezeLayout() {
      layoutFrozen = true;
      allNodes.forEach(n => {
        n.fx = n.x;
        n.fy = n.y;
      });
      if (simulation) simulation.stop();
    }

    function edgeEnds(e) {
      const from = typeof e.from === 'object' ? e.from.id : (typeof e.source === 'object' ? e.source.id : e.from || e.source);
      const to = typeof e.to === 'object' ? e.to.id : (typeof e.target === 'object' ? e.target.id : e.to || e.target);
      return { from, to };
    }

    function nodeDegree(id) {
      let d = 0;
      for (const e of allEdges) {
        const { from, to } = edgeEnds(e);
        if (from === id || to === id) d++;
      }
      return d;
    }

    function shortName(name) {
      if (!name) return '';
      const base = String(name).split('/').pop();
      return base.length > 22 ? base.slice(0, 20) + '…' : base;
    }

    function getDirectory(n) {
      if (!n || !n.path) return '';
      const parts = String(n.path).replace(/\\/g, '/').split('/').filter(Boolean);
      if (!parts.length) return '';
      const top = ['app', 'apps', 'src', 'packages', 'lib', 'components', 'pages', 'api'];
      if (top.includes(parts[0]) && parts[1]) return parts[0] + '/' + parts[1];
      if (parts.length === 1) return parts[0];
      return parts.slice(0, Math.min(parts.length - 1, 2)).join('/');
    }

    function clusterId(dir) { return 'cluster:' + dir; }

    function buildClusterProjection() {
      const groups = new Map();
      for (const n of allNodes) {
        if (n.kind === 'File' || n.kind === 'External') continue;
        const dir = getDirectory(n) || '(root)';
        if (!groups.has(dir)) groups.set(dir, []);
        groups.get(dir).push(n);
      }
      const clusters = [];
      for (const [dir, members] of groups) {
        clusters.push({
          id: clusterId(dir),
          kind: 'Module',
          name: dir,
          path: dir,
          memberCount: members.length,
          members,
          isCluster: true,
          updated_at: members[0]?.updated_at,
        });
      }
      const extras = allNodes.filter(n =>
        n.kind === 'External' || n.kind === 'API' || n.kind === 'Table' || n.kind === 'Service'
      );
      const nodes = [...clusters, ...extras];
      const owner = new Map();
      for (const c of clusters) for (const m of c.members) owner.set(m.id, c.id);
      for (const e of extras) owner.set(e.id, e.id);

      const agg = new Map();
      for (const e of allEdges) {
        if (e.type === 'CONTAINS') continue;
        const { from, to } = edgeEnds(e);
        const a = owner.get(from);
        const b = owner.get(to);
        if (!a || !b || a === b) continue;
        const key = a + '>' + b;
        if (!agg.has(key)) {
          agg.set(key, {
            id: 'agg:' + key, type: e.type || 'DEPENDS_ON',
            from: a, to: b, source: a, target: b, count: 0,
            evidence: e.evidence,
          });
        }
        agg.get(key).count += 1;
      }
      return { nodes, edges: [...agg.values()] };
    }

    function visibleNodes() {
      let nodes;
      if (currentView === 'overview' && !focusDir) nodes = buildClusterProjection().nodes;
      else if (focusDir) {
        nodes = allNodes.filter(n => n.kind !== 'File' && getDirectory(n) === focusDir);
      } else if (currentView === 'all') {
        nodes = allNodes.filter(n => n.kind !== 'File');
      } else {
        nodes = allNodes.filter(n => n.kind === currentView);
      }
      if (selectedNode && !selectedNode.isCluster && !nodes.some(n => n.id === selectedNode.id)) {
        if (focusDir && getDirectory(selectedNode) === focusDir) nodes = nodes.concat([selectedNode]);
        else if (currentView === selectedNode.kind || currentView === 'all') nodes = nodes.concat([selectedNode]);
      }
      return nodes;
    }

    function visibleEdges(nodes) {
      if (currentView === 'overview' && !focusDir) return buildClusterProjection().edges;
      const ids = new Set(nodes.map(n => n.id));
      return allEdges.filter(e => {
        const { from, to } = edgeEnds(e);
        if (!ids.has(from) || !ids.has(to)) return false;
        if (e.type === 'CONTAINS') return false;
        return true;
      });
    }

    function relayout(nodes, edges) {
      layoutFrozen = false;
      nodes.forEach(n => { n.fx = null; n.fy = null; });
      if (simulation) simulation.stop();
      const linkEdges = edges.map(e => ({ ...e, source: edgeEnds(e).from, target: edgeEnds(e).to }));
      const clustered = currentView === 'overview' && !focusDir;
      simulation = d3.forceSimulation(nodes)
        .velocityDecay(0.42)
        .alphaDecay(0.05)
        .alphaMin(0.001)
        .force("link", d3.forceLink(linkEdges).id(d => d.id).distance(clustered ? 180 : 110).strength(0.35))
        .force("charge", d3.forceManyBody().strength(clustered ? -420 : -140))
        .force("x", d3.forceX(0).strength(0.04))
        .force("y", d3.forceY(0).strength(0.04))
        .force("collision", d3.forceCollide().radius(d => getRadius(d) + (d.isCluster ? 28 : 16)))
        .on("tick", ticked)
        .on("end", freezeLayout);
    }

    function refreshGraph(relayoutToo) {
      const nodes = visibleNodes();
      const edges = visibleEdges(nodes);
      projection = { nodes, edges };
      updateGraphVisuals(nodes, edges);
      updateBreadcrumb();
      if (relayoutToo) relayout(nodes, edges);
    }

    function updateBreadcrumb() {
      const el = document.getElementById('breadcrumb');
      if (!el) return;
      if (focusDir) {
        el.innerHTML = '<button type="button" id="bc-home">Overview</button><span>→</span><span style="color:#fff;font-weight:600;">' + focusDir + '</span>';
        const btn = document.getElementById('bc-home');
        if (btn) btn.onclick = () => { focusDir = null; currentView = 'overview'; refreshGraph(true); renderNodeList(); };
      } else if (currentView === 'overview') {
        el.textContent = 'Overview · each island is a package/folder — double-click to open';
      } else {
        el.textContent = currentView === 'all' ? 'All symbols (files hidden)' : (currentView + ' only');
      }
    }

    function getRadius(d) {
      if (d && d.isCluster) return 20 + Math.min(18, Math.sqrt(d.memberCount || 1) * 3);
      if (d.kind === 'File') return 7;
      if (d.kind === 'API' || d.kind === 'Table' || d.kind === 'Service') return 14;
      if (d.kind === 'Class' || d.kind === 'External' || d.kind === 'Module') return 12;
      return 9;
    }

    function initDirectoryTreeColors() {
      const uniqueDirs = Array.from(new Set(allNodes.map(getDirectory).filter(Boolean)));
      uniqueDirs.sort().forEach((dir, idx) => {
        directoryColorMap[dir] = treePalette[idx % treePalette.length];
      });
    }

    // Get color dynamically: same tree gets a lighter shade, other trees get other colors
    function getNodeColor(d) {
      const dir = getDirectory(d);
      if (!dir) {
        return '#78716c'; // Stone Gray fallback
      }
      
      const baseColor = directoryColorMap[dir] || '#78716c';

      // Shaded node tree: Functions and Methods inside same directory map to a lighter shade
      if (d.kind === 'Function' || d.kind === 'Method' || d.kind === 'Interface') {
        return d3.color(baseColor).brighter(0.65).toString();
      }
      return baseColor;
    }

    // Build the filtering tabs dynamically based on present kinds
    function buildDynamicTabs() {
      const tabContainer = document.querySelector('.tab-bar');
      if (!tabContainer) return;

      const presentKinds = new Set(allNodes.map(n => n.kind));
      let html = '<button class="tab active" data-view="overview">Overview</button>';
      html += '<button class="tab" data-view="all">All</button>';
      
      const orderedKinds = ['Function', 'Method', 'Class', 'Interface', 'Table', 'API', 'File', 'External', 'Test'];
      orderedKinds.forEach(kind => {
        if (presentKinds.has(kind)) {
          const label = kind === 'Function' ? 'Functions' :
                        kind === 'Method' ? 'Methods' :
                        kind === 'Class' ? 'Classes' :
                        kind === 'Interface' ? 'Interfaces' :
                        kind === 'Table' ? 'Tables' :
                        kind === 'API' ? 'APIs' :
                        kind === 'File' ? 'Files' :
                        kind === 'External' ? 'Externals' :
                        kind === 'Test' ? 'Tests' : kind;
          html += '<button class="tab" data-view="' + kind + '">' + label + '</button>';
        }
      });
      tabContainer.innerHTML = html;
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
    function updateGraphVisuals(filterNodes, validEdges) {
      if (!filterNodes) filterNodes = visibleNodes();
      if (!validEdges) validEdges = visibleEdges(filterNodes);
      const activeIds = new Set(filterNodes.map(n => n.id));

      // Draw lines (Links)
      const linkSelection = linksLayer.selectAll("path.link")
        .data(validEdges, d => d.id);

      linkSelection.exit().remove();

      // Insert new links with semantic arrowheads
      const linkEnter = linkSelection.enter().append("path")
        .attr("class", d => "link type-" + d.type)
        .attr("id", d => d.id)
        .attr("marker-end", d => "url(#arrow-" + d.type + ")")
        .on("click", (event, d) => {
          event.stopPropagation();
          selectNode(d.source.id);
        });

      // Merge & update attributes
      const linkAll = linkEnter.merge(linkSelection)
        .attr("stroke-width", d => d.count ? Math.min(5, 1 + Math.log2(d.count + 1)) : 1.5)
        .attr("marker-end", d => {
          const isSelectedPath = selectedNode && (d.source.id === selectedNode.id || d.target.id === selectedNode.id);
          return isSelectedPath ? "url(#arrow-" + d.type + "-highlight)" : "url(#arrow-" + d.type + ")";
        });

      // Draw Nodes (Groups) — only the current projection, not the full hairball
      const nodeSelection = nodesLayer.selectAll("g.node-g")
        .data(filterNodes, d => d.id);

      nodeSelection.exit().remove();

      const nodeEnter = nodeSelection.enter().append("g")
        .attr("class", "node-g")
        .on("click", (event, d) => {
          event.stopPropagation();
          triggerPressEffect(event, d);
          selectNode(d.id);
        })
        .on("dblclick", (event, d) => {
          event.stopPropagation();
          if (d.isCluster) {
            focusDir = d.path;
            currentView = 'overview';
            selectedNode = null;
            document.getElementById('detail-panel').classList.remove('open');
            refreshGraph(true);
            renderNodeList();
          }
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

      const nodeAll = nodeEnter.merge(nodeSelection);

      nodeAll.each(function(d) {
        const el = d3.select(this);
        el.selectAll(".node-shape").remove();
        const r = getRadius(d);
        const color = getNodeColor(d);
        const kind = d.isCluster ? 'Module' : d.kind;
        let shape;
        if (kind === 'Module' || kind === 'Service' || kind === 'Package' || d.isCluster) {
          shape = el.append("rect")
            .attr("x", -r * 1.7).attr("y", -r * 0.8)
            .attr("width", r * 3.4).attr("height", r * 1.6)
            .attr("rx", 8);
        } else if (kind === 'API' || kind === 'Route') {
          shape = el.append("polygon")
            .attr("points", '0,-' + (r * 1.2) + ' ' + (r * 1.2) + ',0 0,' + (r * 1.2) + ' -' + (r * 1.2) + ',0');
        } else if (kind === 'Table') {
          const w = r * 1.15 * 0.86, h = r * 1.15 * 0.5, rH = r * 1.15;
          shape = el.append("polygon")
            .attr("points", '0,-' + rH + ' ' + w + ',-' + h + ' ' + w + ',' + h + ' 0,' + rH + ' -' + w + ',' + h + ' -' + w + ',-' + h);
        } else if (kind === 'Class' || kind === 'Interface') {
          shape = el.append("rect")
            .attr("x", -r).attr("y", -r).attr("width", r * 2).attr("height", r * 2).attr("rx", 3);
        } else if (kind === 'File') {
          shape = el.append("rect").attr("x", -6).attr("y", -10).attr("width", 12).attr("height", 20).attr("rx", 1.5);
        } else {
          shape = el.append("circle").attr("r", r);
        }
        const c = d3.color(color);
        shape.attr("class", "node-shape")
          .attr("fill", color)
          .attr("fill-opacity", d.isCluster ? 0.35 : (d.kind === 'File' ? 0.25 : 0.85))
          .attr("stroke", c ? c.brighter(0.6) : '#fff')
          .attr("stroke-width", d.isCluster ? 2 : 1.5);
      });

      // Extra Holographic Concentric visual rings for APIs & Tables in All view
      nodeAll.selectAll(".outer-ring").remove();
      nodeAll.filter(d => d.kind === 'API' || d.kind === 'Table')
        .append("circle")
        .attr("class", "outer-ring")
        .attr("r", d => getRadius(d) + 6)
        .attr("fill", "none")
        .attr("stroke", d => getNodeColor(d))
        .attr("stroke-opacity", 0.2)
        .attr("stroke-width", 1);

      // Text labels for symbols
      nodeAll.selectAll("text.node-label").remove();
      nodeAll.append("text")
        .attr("class", "node-label")
        .attr("y", d => d.isCluster ? 5 : (d.kind === 'File' ? -15 : -getRadius(d) - 6))
        .attr("text-anchor", "middle")
        .text(d => d.isCluster ? (shortName(d.name) + ' · ' + d.memberCount) : shortName(d.name))
        .style("opacity", d => d.isCluster ? 1 : 0);

      nodeAll
        .classed("fade", false)
        .classed("selected", d => selectedNode && d.id === selectedNode.id);

      // Never restart physics after the first settle — clicking a node must not move the graph.
    }

    function highlightSelection() {
      nodesLayer.selectAll("g.node-g")
        .classed("selected", d => selectedNode && d.id === selectedNode.id)
        .select("text.node-label")
        .style("opacity", d => d.isCluster || (selectedNode && d.id === selectedNode.id) ? 1 : 0)
        .classed("active", d => selectedNode && d.id === selectedNode.id);

      if (selectedNode && !selectedNode.isCluster) {
        nodesLayer.selectAll("g.node-g").each(function(d) {
          const el = d3.select(this);
          const on = d.id === selectedNode.id;
          el.select(".node-shape")
            .attr("filter", on ? "url(#glow)" : null)
            .attr("stroke-width", on ? 4 : (d.isCluster ? 2 : 1.5));
        });
      }
    }

    function nodeIsDrawn(id) {
      return (projection.nodes || []).some(n => n.id === id);
    }

    function syncTabs() {
      document.querySelectorAll('.tab').forEach(t => {
        t.classList.toggle('active', t.dataset.view === currentView);
      });
    }

    function revealOnGraph(node) {
      if (!node || node.isCluster) return false;
      if (nodeIsDrawn(node.id)) return false;
      const dir = getDirectory(node);
      if (dir) {
        focusDir = dir;
        currentView = 'overview';
        syncTabs();
        return true;
      }
      currentView = node.kind;
      focusDir = null;
      syncTabs();
      return true;
    }

    function scrollListToSelected() {
      const el = document.querySelector('#nodeList .node-item.selected');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    }

    // Hover Highlight Spotlight Spotlight with hardware-accelerated transforms
    function setNodeHover(node, isHover) {
      hoveredNode = isHover ? node : null;

      if (!isHover) {
        nodesLayer.selectAll("g.node-g").classed("fade", false);
        linksLayer.selectAll("path.link")
          .classed("highlight", false)
          .classed("fade", false)
          .attr("marker-end", d => "url(#arrow-" + d.type + ")");
        nodesLayer.selectAll("text.node-label")
          .classed("active", false)
          .style("opacity", d => d.isCluster || (selectedNode && d.id === selectedNode.id) ? 1 : 0);
        nodesLayer.selectAll(".node-shape")
          .attr("filter", null)
          .attr("transform", "scale(1)")
          .attr("stroke-width", d => d.kind === 'File' ? 2 : 1.5);
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

      // Apply transitions & glows
      nodesLayer.selectAll("g.node-g").each(function(d) {
        const matches = connectedNodeIds.has(d.id);
        const el = d3.select(this);
        el.classed("fade", !matches);
        
        const isHoverTarget = d.id === node.id;
        el.select(".node-shape")
          .attr("transform", isHoverTarget ? "scale(1.3)" : "scale(1)")
          .attr("stroke-width", isHoverTarget ? 3.5 : (d.kind === 'File' ? 2 : 1.5))
          .attr("filter", isHoverTarget ? "url(#glow)" : null);

        el.select("text.node-label")
          .classed("active", isHoverTarget)
          .style("opacity", d.isCluster || matches ? (isHoverTarget ? 1 : (d.isCluster ? 1 : 0.9)) : 0);
      });

      linksLayer.selectAll("path.link").each(function(d) {
        const matches = connectedLinkIds.has(d.id);
        d3.select(this)
          .classed("highlight", matches)
          .classed("fade", !matches)
          .attr("marker-end", d => matches ? "url(#arrow-" + d.type + "-highlight)" : "url(#arrow-" + d.type + ")");
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
        .attr("stroke", getNodeColor(d))
        .style("stroke-opacity", 1);

      ripple.transition()
        .duration(600)
        .ease(d3.easeQuadOut)
        .attr("r", 80)
        .style("stroke-opacity", 0)
        .remove();
    }

    // Drag moves only that node; the rest of the graph stays frozen.
    function dragstarted(event, d) {
      d.fx = d.x;
      d.fy = d.y;
    }

    function dragged(event, d) {
      d.fx = event.x;
      d.fy = event.y;
      d.x = event.x;
      d.y = event.y;
      ticked();
    }

    function dragended(event, d) {
      d.fx = d.x;
      d.fy = d.y;
    }

    // Select a node in place — do not pan, zoom, or restart layout.
    async function selectNode(id) {
      selectedNode = (projection.nodes || []).find(n => n.id === id)
        || allNodes.find(n => n.id === id)
        || null;

      if (!selectedNode) {
        renderNodeList(document.getElementById('search').value);
        highlightSelection();
        document.getElementById('detail-panel').classList.remove('open');
        pulsesLayer.selectAll("circle.pulse-dot").remove();
        return;
      }

      if (revealOnGraph(selectedNode)) {
        refreshGraph(true);
      }

      renderNodeList(document.getElementById('search').value);
      highlightSelection();
      scrollListToSelected();

      if (selectedNode.isCluster) {
        showClusterDetail(selectedNode);
        return;
      }
      showDetail(selectedNode);
    }

    function showClusterDetail(cluster) {
      const panel = d3.select("#detail-panel");
      const content = document.getElementById('detailContent');
      panel.classed("open", true);
      const members = (cluster.members || []).slice().sort((a, b) => (a.kind + a.name).localeCompare(b.kind + b.name));
      let html = '<span class="node-kind-badge">PACKAGE</span>';
      html += '<h1 style="font-family:Cinzel Decorative,serif;font-size:20px;margin-top:12px;color:' + getNodeColor(cluster) + ';">' + cluster.name + '</h1>';
      html += '<p style="color:var(--text-muted);font-size:12px;margin:8px 0 16px;">' + cluster.memberCount + ' symbols in this area</p>';
      html += '<button type="button" id="open-cluster" style="cursor:pointer;background:var(--primary);color:#fff;border:none;border-radius:6px;padding:8px 12px;font-weight:700;">Open this package</button>';
      html += '<div class="detail-section"><div class="section-title">Inside</div>';
      members.slice(0, 40).forEach(m => {
        html += '<div class="neighbor-item" onclick="selectNode(\'' + String(m.id).replace(/'/g, "\\'") + '\')">';
        html += '<div><span style="font-weight:600;color:' + getNodeColor(m) + ';">' + m.name + '</span>';
        html += '<div style="font-size:10px;color:var(--text-muted);">' + (m.path || m.kind) + '</div></div>';
        html += '<div style="font-size:10px;color:var(--text-muted);">' + m.kind + '</div></div>';
      });
      html += '</div>';
      content.innerHTML = html;
      const btn = document.getElementById('open-cluster');
      if (btn) btn.onclick = () => {
        focusDir = cluster.path;
        currentView = 'overview';
        refreshGraph(true);
        renderNodeList();
      };
    }

    // Fetch and show deep analysis report
    async function showDetail(node) {
      const panel = d3.select("#detail-panel");
      const content = document.getElementById('detailContent');
      panel.classed("open", true);

      content.innerHTML = `<div style="text-align: center; padding: 40px; color: var(--text-muted);">Analyzing code relationships...</div>`;

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

        let html = `
          <span class="node-kind-badge">${node.kind}</span>
          <h1 style="font-family: 'Cinzel Decorative', serif; font-size: 20px; font-weight:900; margin-top:12px; line-height:1.2; word-break:break-all; color:${getNodeColor(node)}">${node.name}</h1>
          <p style="font-family:monospace; font-size:11px; color:var(--text-muted); margin-top:4px; word-break:break-all;">${node.id}</p>
        `;

        if (node.path) {
          html += '<p style="font-size:12px; color:#ffffff; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom:12px; margin: 12px 0; font-weight:500;">📄 ' + node.path + (node.startLine ? ':' + node.startLine : '') + '</p>';
        }

        // Natural Language Impact Summary Card
        const incomingCalls = neighbors.filter(e => e.to === node.id && e.type === 'CALLS');
        const downstreamAPIs = [];
        const downstreamTables = [];
        
        if (impact.paths) {
          impact.paths.forEach(p => {
            if (p.steps) {
              p.steps.forEach(s => {
                const toId = s.to;
                const toName = toId.split(':').pop();
                if (toId.startsWith('api:') && !downstreamAPIs.includes(toName)) {
                  downstreamAPIs.push(toName);
                } else if (toId.startsWith('table:') && !downstreamTables.includes(toName)) {
                  downstreamTables.push(toName);
                }
              });
            }
          });
        }

        // Use server-computed severity and summary
        const severity = impact.severity || 'low';
        const riskRating = severity === 'critical' ? '🔴 CRITICAL RISK' : severity === 'medium' ? '🟡 MEDIUM RISK' : '🟢 LOW RISK';
        const riskColor = severity === 'critical' ? '#f87171' : severity === 'medium' ? '#fbbf24' : '#34d399';
        const dynamicSummary = impact.summary || 'No impact data available.';

        html += '<div class="impact-prediction-card">';
        html += '  <div class="prediction-title">';
        html += '    <span>⚡</span> Impact Analysis (<span style="color:' + riskColor + '">' + riskRating + '</span>)';
        html += '  </div>';
        html += '  <p class="prediction-text">' + dynamicSummary + '</p>';
        html += '</div>';

        // Grouped affected items by kind
        if (impact.affectedByKind && impact.affectedByKind.length > 0) {
          html += '<div class="detail-section">';
          html += '<div class="section-title">Affected Components</div>';
          html += '<div style="display:flex; flex-direction:column; gap:10px; margin-top:8px;">';

          for (const group of impact.affectedByKind) {
            if (group.items.length === 0) continue;
            html += '<div style="background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.05); border-radius:6px; padding:10px;">';
            html += '<div style="display:flex; align-items:center; gap:6px; margin-bottom:6px;">';
            html += '<span style="font-size:14px;">' + group.icon + '</span>';
            html += '<span style="font-family:Oswald,sans-serif; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.5px; color:var(--text-muted);">' + group.label + ' (' + group.items.length + ')</span>';
            html += '</div>';

            for (const item of group.items.slice(0, 6)) {
              const itemColor = getNodeColor({id: item.id, path: item.path, kind: group.kind});
              html += `<div class="neighbor-item" onclick="selectNode('${String(item.id).replace(/'/g, "\\'")}')">`;
              html += '<div>';
              html += '<span style="font-weight:600; color:' + itemColor + ';">' + item.name + '</span>';
              if (item.path) html += '<div style="font-size:10px; color:var(--text-muted);">' + item.path + (item.startLine ? ':' + item.startLine : '') + '</div>';
              html += '</div>';
              html += '<div style="font-size:10px; color:var(--text-muted);">' + group.kind + '</div>';
              html += '</div>';
            }
            if (group.items.length > 6) {
              html += '<div style="font-size:10px; color:var(--text-muted); padding:4px 10px;">... and ' + (group.items.length - 6) + ' more</div>';
            }
            html += '</div>';
          }
          html += '</div></div>';
        }

        if (node.signature) {
          html += `
            <div class="detail-section">
              <div class="section-title">Declaration Signature</div>
              <div class="signature-box">${escapeHTML(node.signature)}</div>
            </div>
          `;
        }

        // Risk factors
        if (impact.riskChips && impact.riskChips.length > 0) {
          html += `<div class="detail-section">`;
          html += `<div class="section-title">Risk Factors</div>`;
          html += `<div style="display:flex; flex-wrap:wrap; gap:4px; margin-top:6px;">`;
          impact.riskChips.forEach(r => {
            html += `<span class="risk-chip risk-${r.kind}">⬡ ${r.message}</span>`;
          });
          html += `</div></div>`;
        }

        // Why-paths (dependency chains with evidence)
        if (impact.paths && impact.paths.length > 0) {
          html += `<div class="detail-section">`;
          html += `<div class="section-title">Why-Paths (Dependency Chains)</div>`;
          html += `<div style="display:flex; flex-direction:column; gap:10px; margin-top:6px;">`;

          impact.paths.slice(0, 5).forEach((p, idx) => {
            html += `<div class="why-path">`;
            html += `<div style="font-size:10px; color:var(--text-muted); margin-bottom:4px;">Path ${idx + 1}</div>`;
            p.steps.forEach(s => {
              const fromName = s.from.split(':').pop() || s.from;
              const toName = s.to.split(':').pop() || s.to;
              const fromColor = getNodeColor({id: s.from, path: s.fromPath, kind: s.fromType});
              const toColor = getNodeColor({id: s.to, path: s.toPath, kind: s.toType});
              html += `<div class="why-step">`;
              html += `<span style="font-weight:600; color:${fromColor};">${fromName}</span>`;
              html += `<span class="arrow">→</span>`;
              html += `<span style="font-weight:600; color:${toColor};">${toName}</span>`;
              html += `<span style="background:rgba(255,255,255,0.06); padding:1px 5px; border-radius:3px; font-size:9px; color:var(--text-muted);">${s.edgeType}</span>`;
              html += `</div>`;
              if (s.evidence) {
                html += `<div style="font-size:10px; color:var(--text-muted); margin-left:20px; font-family:monospace;">📄 ${s.evidence.file}:${s.evidence.line}</div>`;
              }
            });
            html += `</div>`;
          });

          html += `</div></div>`;
        }

        // Tests to run
        if (impact.testsToRun && impact.testsToRun.length > 0) {
          html += `<div class="detail-section">`;
          html += `<div class="section-title">🧪 Tests to Run (${impact.testsToRun.length})</div>`;
          html += `<div style="display:flex; flex-direction:column; gap:4px; margin-top:6px;">`;
          impact.testsToRun.slice(0, 8).forEach(t => {
            const testName = t.split(':').pop() || t;
            html += `<div style="font-size:12px; padding:6px 10px; background:rgba(56,189,248,0.05); border:1px solid rgba(56,189,248,0.1); border-radius:4px; color:#38bdf8;">• ${testName}</div>`;
          });
          html += `</div></div>`;
        }

        // Neighbors List
        html += `
          <div class="detail-section">
            <div class="section-title">Direct Connections (${neighbors.length})</div>
            <div style="display:flex; flex-direction:column; gap:6px; margin-top:6px;">
        `;

        if (neighbors.length > 0) {
          neighbors.forEach((e, i) => {
            const sideNode = neighborNodes[i] || { name: e.to, id: e.to, kind: 'Unknown' };
            const isOutgoing = e.from === node.id;
            const arrowChar = isOutgoing ? '→' : '←';

            html += `
              <div class="neighbor-item" onclick="selectNode('${String(sideNode.id).replace(/'/g, "\\'")}')">
                <div>
                  <span style="font-weight:600; color:${getNodeColor(sideNode)};">${sideNode.name}</span>
                  <div style="font-size:10px; color:var(--text-muted);">${sideNode.kind}</div>
                </div>
                <div style="font-size:11px; font-weight:700; color: #ffffff;">
                  ${arrowChar} ${e.type}
                </div>
              </div>
            `;
          });
        } else {
          html += `<p style="font-size:12px; color:var(--text-muted);">This component is isolated.</p>`;
        }

        html += `</div></div>`;

        content.innerHTML = html;

      } catch (err) {
        console.error(err);
        content.innerHTML = `<div style="color:#ffffff; padding: 40px; text-align:center;">Failed to run impact query.</div>`;
      }
    }

    // Creates beautiful glowing white pulses moving along the dependency links
    function drawFlowPulses(neighborEdges) {
      pulsesLayer.selectAll("circle.pulse-dot").remove();

      neighborEdges.forEach(edge => {
        const pathEl = document.getElementById(edge.id);
        if (!pathEl) return;

        // Glowing white particle streams
        const dot = pulsesLayer.append("circle")
          .attr("class", "pulse-dot")
          .attr("r", 3.5)
          .attr("fill", "#ffffff");

        dot.append("animateMotion")
          .attr("dur", edge.type === 'EXPOSES' ? "1.2s" : "2.0s") // APIs pulse faster!
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
      
      const pool = query ? allNodes : visibleNodes();
      const filtered = pool.filter(n => {
        const matchesKind = currentView === 'overview' || currentView === 'all' || n.kind === currentView;
        const matchesSearch = !query || n.name.toLowerCase().includes(query.toLowerCase()) || n.id.toLowerCase().includes(query.toLowerCase()) || (n.path || '').toLowerCase().includes(query.toLowerCase());
        return matchesKind && matchesSearch;
      });

      list.innerHTML = filtered.slice(0, 150).map(n => `
        <li class="node-item ${selectedNode?.id === n.id ? 'selected' : ''}" data-id="${String(n.id).replace(/"/g, '&quot;')}">
          <div class="node-header-row">
            <span class="node-name" style="color: ${getNodeColor(n)}">${n.name}</span>
            <span class="node-kind-badge">${n.kind.slice(0,4)}</span>
          </div>
          <div class="node-path-row">${n.path || n.id}</div>
        </li>
      `).join('');
      scrollListToSelected();
    }

    function initEvents() {
      // Close side panel
      document.getElementById('closeDetail').addEventListener('click', () => {
        selectedNode = null;
        document.getElementById('detail-panel').classList.remove('open');
        pulsesLayer.selectAll("circle.pulse-dot").remove();
        highlightSelection();
        renderNodeList(document.getElementById('search').value);
      });

      document.getElementById('nodeList').addEventListener('click', (e) => {
        const li = e.target.closest('li.node-item');
        if (!li) return;
        const id = li.getAttribute('data-id');
        if (id) selectNode(id);
      });

      // Interactive real-time search
      document.getElementById('search').addEventListener('input', (e) => {
        renderNodeList(e.target.value);
      });

      // Filter Tabs (Delegated registry because tabs are dynamically created!)
      document.querySelector('.tab-bar').addEventListener('click', (e) => {
        const tab = e.target.closest('.tab');
        if (!tab) return;

        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentView = tab.dataset.view;
        if (currentView !== 'overview') focusDir = null;
        renderNodeList(document.getElementById('search').value);
        refreshGraph(true);
      });
    }

    // Run
    init();
  