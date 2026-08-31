
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
    let currentView = 'all';

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

        // Force layout once, then freeze so clicks / the detail panel never scatter nodes.
        simulation = d3.forceSimulation(allNodes)
          .velocityDecay(0.45)
          .alphaDecay(0.06)
          .alphaMin(0.001)
          .force("link", d3.forceLink(validEdges).id(d => d.id).distance(d => d.type === 'CONTAINS' ? 70 : 140).strength(0.5))
          .force("charge", d3.forceManyBody().strength(-160))
          .force("x", d3.forceX(0).strength(0.06))
          .force("y", d3.forceY(0).strength(0.06))
          .force("collision", d3.forceCollide().radius(d => getRadius(d) + 14))
          .on("tick", ticked)
          .on("end", freezeLayout);

        // 5. Register Event Listeners
        initEvents();

        // 6. Initial Render
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

    function freezeLayout() {
      layoutFrozen = true;
      allNodes.forEach(n => {
        n.fx = n.x;
        n.fy = n.y;
      });
      if (simulation) simulation.stop();
    }

    function getRadius(d) {
      if (d.kind === 'File') return 8;
      if (d.kind === 'API' || d.kind === 'Table') return 15;
      if (d.kind === 'Class') return 13;
      return 10; // functions & others
    }

    // Classify nodes into directory trees and build directory color index
    function getDirectory(n) {
      if (!n.path) return '';
      const parts = n.path.split('/');
      if (parts.length <= 1) return '';
      return parts.slice(0, Math.min(parts.length - 1, 2)).join('/');
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
      let html = '<button class="tab active" data-view="all">All</button>';
      
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
    function updateGraphVisuals(validEdges) {
      const activeKind = currentView;
      const filterNodes = activeKind === 'all' ? allNodes : allNodes.filter(n => n.kind === activeKind);
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
        .attr("marker-end", d => {
          const isSelectedPath = selectedNode && (d.source.id === selectedNode.id || d.target.id === selectedNode.id);
          return isSelectedPath ? "url(#arrow-" + d.type + "-highlight)" : "url(#arrow-" + d.type + ")";
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

      const nodeAll = nodeEnter.merge(nodeSelection);

      // --- Morphing Geometric Shapes view ---
      nodeAll.each(function(d) {
        const el = d3.select(this);
        el.selectAll(".node-shape").remove(); // clear previous shape to morph

        const r = getRadius(d);
        const color = getNodeColor(d);

        let shape;

        // MORPH shapes based on active tab view
        if (currentView === 'all') {
          // All View -> Standard elegant Circle
          shape = el.append("circle")
            .attr("r", r);
        } else if (currentView === 'Function') {
          // Functions Mode -> Render glowing Diamonds
          shape = el.append("polygon")
            .attr("points", '0,-' + (r * 1.25) + ' ' + (r * 1.25) + ',0 0,' + (r * 1.25) + ' -' + (r * 1.25) + ',0');
        } else if (currentView === 'Method') {
          // Methods Mode -> Render upward Triangles
          shape = el.append("polygon")
            .attr("points", '0,-' + (r * 1.3) + ' ' + (r * 1.2) + ',' + (r * 0.9) + ' -' + (r * 1.2) + ',' + (r * 0.9));
        } else if (currentView === 'Class' || currentView === 'Interface') {
          // Class Mode -> Render robust Squares
          shape = el.append("rect")
            .attr("x", -r)
            .attr("y", -r)
            .attr("width", r * 2)
            .attr("height", r * 2)
            .attr("rx", 3);
        } else if (currentView === 'Table') {
          // Table Mode -> Render Hexagons
          const w = r * 1.15 * 0.86;
          const h = r * 1.15 * 0.5;
          const rH = r * 1.15;
          shape = el.append("polygon")
            .attr("points", '0,-' + rH + ' ' + w + ',-' + h + ' ' + w + ',' + h + ' 0,' + rH + ' -' + w + ',' + h + ' -' + w + ',-' + h);
        } else if (currentView === 'API') {
          // API Mode -> Render Horizontal Diamonds
          shape = el.append("polygon")
            .attr("points", '0,-' + (r * 1.2) + ' ' + (r * 1.2) + ',0 0,' + (r * 1.2) + ' -' + (r * 1.2) + ',0');
        } else if (currentView === 'File') {
          // File Mode -> Render Vertical Cards
          shape = el.append("rect")
            .attr("x", -6)
            .attr("y", -10)
            .attr("width", 12)
            .attr("height", 20)
            .attr("rx", 1.5);
        } else {
          // Fallback Circle
          shape = el.append("circle")
            .attr("r", r);
        }

        shape.attr("class", "node-shape")
          .attr("fill", color)
          .attr("fill-opacity", d.kind === 'File' ? 0.25 : 0.8)
          .attr("stroke", d3.color(color).darker(0.35))
          .attr("stroke-width", d.kind === 'File' ? 2 : 1.5);
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
        .attr("y", d => d.kind === 'File' ? -15 : -getRadius(d) - 6)
        .attr("text-anchor", "middle")
        .text(d => d.name);

      // Apply Filter visual fades (Highlight view)
      nodeAll.each(function(d) {
        const el = d3.select(this);
        const matchesType = activeIds.has(d.id);
        el.classed("fade", !matchesType);
        el.classed("selected", selectedNode && d.id === selectedNode.id);
        el.select("text.node-label").style("opacity", matchesType ? (d.kind === 'File' ? 0.4 : 0.8) : 0.05);
      });

      // Never restart physics after the first settle — clicking a node must not move the graph.
    }

    function highlightSelection() {
      nodesLayer.selectAll("g.node-g")
        .classed("selected", d => selectedNode && d.id === selectedNode.id);
    }

    // Hover Highlight Spotlight Spotlight with hardware-accelerated transforms
    function setNodeHover(node, isHover) {
      hoveredNode = isHover ? node : null;

      if (!isHover) {
        // Reset all faded items
        nodesLayer.selectAll("g.node-g").classed("fade", false);
        linksLayer.selectAll("path.link")
          .classed("highlight", false)
          .classed("fade", false)
          .attr("marker-end", d => "url(#arrow-" + d.type + ")");
        nodesLayer.selectAll("text.node-label").classed("active", false);
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
          .classed("active", isHoverTarget);
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
      selectedNode = allNodes.find(n => n.id === id) || null;

      renderNodeList(document.getElementById('search').value);
      highlightSelection();

      if (!selectedNode) {
        document.getElementById('detail-panel').classList.remove('open');
        pulsesLayer.selectAll("circle.pulse-dot").remove();
        return;
      }

      showDetail(selectedNode);
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
      
      const filtered = allNodes.filter(n => {
        const matchesKind = activeKind === 'all' || n.kind === activeKind;
        const matchesSearch = !query || n.name.toLowerCase().includes(query.toLowerCase()) || n.id.toLowerCase().includes(query.toLowerCase());
        return matchesKind && matchesSearch;
      });

      list.innerHTML = filtered.slice(0, 150).map(n => `
        <li class="node-item ${selectedNode?.id === n.id ? 'selected' : ''}" onclick="selectNode('${n.id}')">
          <div class="node-header-row">
            <span class="node-name" style="color: ${getNodeColor(n)}">${n.name}</span>
            <span class="node-kind-badge">${n.kind.slice(0,4)}</span>
          </div>
          <div class="node-path-row">${n.path || n.id}</div>
        </li>
      `).join('');
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
        
        renderNodeList(document.getElementById('search').value);
        
        const nodeIds = new Set(allNodes.map(n => n.id));
        const validEdges = allEdges.filter(e => {
          const fromId = typeof e.from === 'object' ? e.from.id : e.from;
          const toId = typeof e.to === 'object' ? e.to.id : e.to;
          return nodeIds.has(fromId) && nodeIds.has(toId);
        });
        updateGraphVisuals(validEdges);
      });
    }

    // Run
    init();
  