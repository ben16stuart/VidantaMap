/* VidantaMap Admin editor — graph editing UI on top of MapView.
 * Owns: node/edge rendering, toolbar modes, side panel, save/reload.
 */
(function () {
  'use strict';

  var el = window.MapView.el;

  /* ---------- constants ---------- */

  var PATH_COLORS = {
    boardwalk: '#c2703d',
    paved: '#5b6b7d',
    trail: '#3e8e4f',
    stairs: '#b04ac2'
  };
  var NODE_COLORS = {
    hotel: '#2563eb',
    restaurant: '#ea580c',
    bar: '#c026d3',
    pool: '#0891b2',
    amenity: '#7c3aed',
    junction: '#8a8f98'
  };
  var DEFAULT_NODE_COLOR = '#16a34a'; // unknown types
  var KNOWN_TYPES = ['hotel', 'restaurant', 'pool', 'amenity', 'junction'];

  // On-screen sizes (screen px — divided by mv.scale when applied)
  var R_DEST = 7;
  var R_JUNCTION = 4.5;
  var HIT_PAD = 5;
  var FONT_PX = 11;
  var EDGE_WIDTH = 3.5;
  var EDGE_HIT_WIDTH = 14;

  var MODE_HINTS = {
    'select': 'Select / Move: click a node or edge to edit it in this panel. Drag a node to reposition it.',
    'add-location': 'Add Location: click an empty spot on the map, then enter a name. A destination node is created there.',
    'add-junction': 'Add Junction: click the map to drop a junction (path intersection) node.',
    'draw-path': 'Draw Path: click a first node, then a second node to connect them with the selected path type. Esc or click empty map to cancel.',
    'delete': 'Delete: click a node to remove it (and all its edges), or click an edge to remove just that edge.'
  };

  /* ---------- state ---------- */

  var graph = null;
  var mv = null;
  var mode = 'select';
  var dirty = false;
  var selected = null;      // { kind: 'node'|'edge', id: string }
  var drawFromId = null;    // draw-path first endpoint

  var nodeEls = new Map();  // node id -> { g, dot, hit, label }
  var edgeEls = new Map();  // edge id -> { g, vis, hit }
  var edgesGroup, nodesGroup, ringsGroup, selRing, drawRing, previewLine;

  /* ---------- DOM refs ---------- */

  var $ = function (id) { return document.getElementById(id); };
  var mapDiv = $('map');
  var toastDiv = $('toast');
  var dirtyBadge = $('dirtyBadge');
  var modeHint = $('modeHint');
  var panelStats = $('panelStats');
  var panelEmpty = $('panelEmpty');
  var panelNode = $('panelNode');
  var panelEdge = $('panelEdge');
  var pathTypeSelect = $('pathTypeSelect');
  var pathTypeWrap = $('pathTypeWrap');

  var fId = $('fId'), fName = $('fName'), fType = $('fType'),
      fDest = $('fDest'), fX = $('fX'), fY = $('fY');

  var eId = $('eId'), eEndpoints = $('eEndpoints'),
      eLength = $('eLength'), ePathType = $('ePathType');

  /* ---------- helpers ---------- */

  function nodeById(id) {
    for (var i = 0; i < graph.nodes.length; i++) {
      if (graph.nodes[i].id === id) return graph.nodes[i];
    }
    return null;
  }

  function edgeById(id) {
    for (var i = 0; i < graph.edges.length; i++) {
      if (graph.edges[i].id === id) return graph.edges[i];
    }
    return null;
  }

  function allIds() {
    var s = new Set();
    graph.nodes.forEach(function (n) { s.add(n.id); });
    graph.edges.forEach(function (e) { s.add(e.id); });
    return s;
  }

  function slugify(name) {
    var s = String(name).toLowerCase().normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return s || 'location';
  }

  function uniqueId(base) {
    var ids = allIds();
    if (!ids.has(base)) return base;
    var i = 2;
    while (ids.has(base + '-' + i)) i++;
    return base + '-' + i;
  }

  function nextJunctionId() {
    var max = 0;
    graph.nodes.forEach(function (n) {
      var m = /^j(\d+)$/.exec(n.id);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    var ids = allIds();
    var id;
    do {
      max++;
      id = 'j' + String(max).padStart(2, '0');
    } while (ids.has(id));
    return id;
  }

  function pathColor(t) { return PATH_COLORS[t] || PATH_COLORS.boardwalk; }
  function nodeColor(n) {
    if (n.type === 'junction') return NODE_COLORS.junction;
    return NODE_COLORS[n.type] || DEFAULT_NODE_COLOR;
  }
  function nodeRadius(n) { return n.type === 'junction' ? R_JUNCTION : R_DEST; }
  function nodeLabelText(n) { return n.name || ''; }

  function edgeLengthMeters(edge) {
    var a = nodeById(edge.from), b = nodeById(edge.to);
    if (!a || !b) return 0;
    var mpp = (graph.config && graph.config.metersPerPixel) || 1;
    return Math.round(Math.hypot(a.x - b.x, a.y - b.y) * mpp);
  }

  var toastTimer = null;
  function toast(msg, kind) {
    toastDiv.textContent = msg;
    toastDiv.className = kind || '';
    toastDiv.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastDiv.hidden = true; }, 2800);
  }

  function markDirty() {
    if (!dirty) {
      dirty = true;
      dirtyBadge.hidden = false;
      document.title = '* VidantaMap Admin — Graph Editor';
    }
  }

  function clearDirty() {
    dirty = false;
    dirtyBadge.hidden = true;
    document.title = 'VidantaMap Admin — Graph Editor';
  }

  /* ---------- rendering ---------- */

  function buildOverlaySkeleton() {
    edgesGroup = el('g', { 'class': 'edges' });
    nodesGroup = el('g', { 'class': 'nodes' });
    ringsGroup = el('g', { 'class': 'rings' });

    selRing = el('circle', {
      fill: 'none', stroke: '#111827', 'stroke-width': 2,
      'vector-effect': 'non-scaling-stroke', 'pointer-events': 'none'
    });
    selRing.style.display = 'none';
    drawRing = el('circle', {
      fill: 'none', stroke: '#111827', 'stroke-width': 2,
      'stroke-dasharray': '4 3',
      'vector-effect': 'non-scaling-stroke', 'pointer-events': 'none'
    });
    drawRing.style.display = 'none';
    ringsGroup.appendChild(selRing);
    ringsGroup.appendChild(drawRing);

    previewLine = el('line', {
      stroke: '#111827', 'stroke-width': 2, 'stroke-dasharray': '6 5',
      'vector-effect': 'non-scaling-stroke', 'pointer-events': 'none'
    });
    previewLine.style.display = 'none';

    mv.overlay.appendChild(edgesGroup);
    mv.overlay.appendChild(nodesGroup);
    mv.overlay.appendChild(ringsGroup);
    mv.overlay.appendChild(previewLine);
  }

  function renderAll() {
    while (edgesGroup.firstChild) edgesGroup.removeChild(edgesGroup.firstChild);
    while (nodesGroup.firstChild) nodesGroup.removeChild(nodesGroup.firstChild);
    edgeEls.clear();
    nodeEls.clear();

    graph.edges.forEach(function (edge) { edgesGroup.appendChild(buildEdgeEl(edge)); });
    graph.nodes.forEach(function (node) { nodesGroup.appendChild(buildNodeEl(node)); });

    applySizes();
    updateSelectionVisuals();
    updateStats();
  }

  function buildEdgeEl(edge) {
    var a = nodeById(edge.from), b = nodeById(edge.to);
    var g = el('g', { 'class': 'edge' });
    g.dataset.id = edge.id;
    var coords = {
      x1: a ? a.x : 0, y1: a ? a.y : 0,
      x2: b ? b.x : 0, y2: b ? b.y : 0
    };
    var vis = el('line', {
      x1: coords.x1, y1: coords.y1, x2: coords.x2, y2: coords.y2,
      stroke: pathColor(edge.pathType),
      'stroke-width': EDGE_WIDTH,
      'vector-effect': 'non-scaling-stroke',
      'class': 'edge-vis'
    });
    var hit = el('line', {
      x1: coords.x1, y1: coords.y1, x2: coords.x2, y2: coords.y2,
      'stroke-width': EDGE_HIT_WIDTH,
      'vector-effect': 'non-scaling-stroke',
      'pointer-events': 'stroke',
      'class': 'edge-hit'
    });
    g.appendChild(vis);
    g.appendChild(hit);
    edgeEls.set(edge.id, { g: g, vis: vis, hit: hit });

    var down = null;
    g.addEventListener('pointerdown', function (e) {
      e.stopPropagation();
      down = { x: e.clientX, y: e.clientY };
    });
    g.addEventListener('pointerup', function (e) {
      if (!down) return;
      var moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5;
      down = null;
      if (!moved) handleEdgeClick(edge);
    });
    return g;
  }

  function buildNodeEl(node) {
    var g = el('g', { 'class': 'node' });
    g.dataset.id = node.id;
    var hit = el('circle', {
      cx: node.x, cy: node.y, r: 12,
      fill: 'transparent', stroke: 'none'
    });
    var dot = el('circle', {
      cx: node.x, cy: node.y, r: 7,
      fill: nodeColor(node),
      stroke: '#ffffff', 'stroke-width': 1.5,
      'vector-effect': 'non-scaling-stroke'
    });
    var title = el('title');
    title.textContent = node.id + (node.name ? ' — ' + node.name : '');
    g.appendChild(title);
    g.appendChild(hit);
    g.appendChild(dot);

    var label = null;
    if (nodeLabelText(node)) {
      label = el('text', {
        x: node.x, y: node.y,
        'text-anchor': 'middle',
        'stroke-width': 3
      });
      label.textContent = nodeLabelText(node);
      g.appendChild(label);
    }

    nodeEls.set(node.id, { g: g, dot: dot, hit: hit, label: label });
    g.addEventListener('pointerdown', function (e) { onNodePointerDown(node, g, e); });
    return g;
  }

  /** Keep dot / label / ring sizes constant on screen. */
  function applySizes() {
    var s = mv.scale || 1;
    nodeEls.forEach(function (els, id) {
      var node = nodeById(id);
      if (!node) return;
      var r = nodeRadius(node) / s;
      els.dot.setAttribute('r', r);
      els.hit.setAttribute('r', r + HIT_PAD / s);
      if (els.label) {
        els.label.setAttribute('font-size', FONT_PX / s);
        els.label.setAttribute('y', node.y + r + (FONT_PX + 2) / s);
        els.label.setAttribute('stroke-width', 3 / s);
      }
    });
    positionRing(selRing, selected && selected.kind === 'node' ? selected.id : null, s);
    positionRing(drawRing, drawFromId, s);
  }

  function positionRing(ring, nodeId, s) {
    var node = nodeId ? nodeById(nodeId) : null;
    if (!node) { ring.style.display = 'none'; return; }
    ring.setAttribute('cx', node.x);
    ring.setAttribute('cy', node.y);
    ring.setAttribute('r', nodeRadius(node) / s + 3.5 / s);
    ring.style.display = '';
  }

  function updateNodeVisual(node) {
    var els = nodeEls.get(node.id);
    if (!els) return;
    els.dot.setAttribute('cx', node.x);
    els.dot.setAttribute('cy', node.y);
    els.hit.setAttribute('cx', node.x);
    els.hit.setAttribute('cy', node.y);
    if (els.label) {
      els.label.setAttribute('x', node.x);
      var s = mv.scale || 1;
      els.label.setAttribute('y', node.y + nodeRadius(node) / s + (FONT_PX + 2) / s);
    }
    // move connected edges
    graph.edges.forEach(function (edge) {
      if (edge.from !== node.id && edge.to !== node.id) return;
      var ee = edgeEls.get(edge.id);
      if (!ee) return;
      var isFrom = edge.from === node.id;
      [ee.vis, ee.hit].forEach(function (line) {
        line.setAttribute(isFrom ? 'x1' : 'x2', node.x);
        line.setAttribute(isFrom ? 'y1' : 'y2', node.y);
      });
    });
    var s2 = mv.scale || 1;
    positionRing(selRing, selected && selected.kind === 'node' ? selected.id : null, s2);
    positionRing(drawRing, drawFromId, s2);
  }

  function updateSelectionVisuals() {
    var s = mv.scale || 1;
    positionRing(selRing, selected && selected.kind === 'node' ? selected.id : null, s);
    positionRing(drawRing, drawFromId, s);
    edgeEls.forEach(function (els, id) {
      var isSel = selected && selected.kind === 'edge' && selected.id === id;
      els.g.classList.toggle('selected', !!isSel);
    });
  }

  function updateStats() {
    var dests = graph.nodes.filter(function (n) { return n.destination; }).length;
    panelStats.textContent = graph.nodes.length + ' nodes (' + dests +
      ' destinations) · ' + graph.edges.length + ' edges';
  }

  /* ---------- selection & panel ---------- */

  function select(kind, id) {
    selected = kind ? { kind: kind, id: id } : null;
    updateSelectionVisuals();
    refreshPanel();
  }

  function refreshPanel() {
    panelEmpty.hidden = !!selected;
    panelNode.hidden = !(selected && selected.kind === 'node');
    panelEdge.hidden = !(selected && selected.kind === 'edge');

    if (selected && selected.kind === 'node') {
      var node = nodeById(selected.id);
      if (!node) { select(null); return; }
      fId.value = node.id;
      fName.value = node.name || '';
      ensureTypeOption(fType, node.type);
      fType.value = node.type;
      fDest.checked = !!node.destination;
      fX.value = node.x;
      fY.value = node.y;
    } else if (selected && selected.kind === 'edge') {
      var edge = edgeById(selected.id);
      if (!edge) { select(null); return; }
      eId.value = edge.id;
      var a = nodeById(edge.from), b = nodeById(edge.to);
      eEndpoints.innerHTML = '';
      var lbl = document.createElement('span');
      lbl.className = 'lbl';
      lbl.textContent = 'Connects: ';
      eEndpoints.appendChild(lbl);
      eEndpoints.appendChild(document.createTextNode(
        (a && a.name ? a.name : edge.from) + ' ↔ ' + (b && b.name ? b.name : edge.to)));
      var lbl2 = document.createElement('span');
      lbl2.className = 'lbl';
      lbl2.textContent = 'Length: ';
      eLength.innerHTML = '';
      eLength.appendChild(lbl2);
      eLength.appendChild(document.createTextNode('~' + edgeLengthMeters(edge) + ' m'));
      ensureTypeOption(ePathType, edge.pathType);
      ePathType.value = edge.pathType || 'boardwalk';
    }
  }

  function ensureTypeOption(selectEl, value) {
    if (!value) return;
    for (var i = 0; i < selectEl.options.length; i++) {
      if (selectEl.options[i].value === value) return;
    }
    var opt = document.createElement('option');
    opt.value = value;
    opt.textContent = value;
    selectEl.appendChild(opt);
  }

  function syncPanelCoords(node) {
    if (selected && selected.kind === 'node' && selected.id === node.id) {
      fX.value = node.x;
      fY.value = node.y;
    }
  }

  /* ---------- node interactions ---------- */

  function onNodePointerDown(node, g, e) {
    e.stopPropagation();
    if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;

    if (mode === 'select') {
      select('node', node.id);
      startDrag(node, g, e);
    } else if (mode === 'draw-path') {
      handleDrawPathClick(node);
    } else if (mode === 'delete') {
      deleteNodeWithConfirm(node);
    }
    // add-location / add-junction: clicks on existing nodes are ignored
  }

  function startDrag(node, g, e) {
    var startMap = mv.screenToMap(e.clientX, e.clientY);
    var offX = node.x - startMap.x;
    var offY = node.y - startMap.y;
    var startClient = { x: e.clientX, y: e.clientY };
    var pointerId = e.pointerId;
    var moved = false;

    try { g.setPointerCapture(pointerId); } catch (err) { /* ignore */ }

    function onMove(ev) {
      if (ev.pointerId !== pointerId) return;
      if (!moved &&
          Math.hypot(ev.clientX - startClient.x, ev.clientY - startClient.y) < 3) {
        return;
      }
      moved = true;
      var p = mv.screenToMap(ev.clientX, ev.clientY);
      node.x = Math.round(Math.min(Math.max(p.x + offX, 0), graph.config.width));
      node.y = Math.round(Math.min(Math.max(p.y + offY, 0), graph.config.height));
      updateNodeVisual(node);
      syncPanelCoords(node);
      markDirty();
    }
    function onEnd(ev) {
      if (ev.pointerId !== pointerId) return;
      g.removeEventListener('pointermove', onMove);
      g.removeEventListener('pointerup', onEnd);
      g.removeEventListener('pointercancel', onEnd);
      try { g.releasePointerCapture(pointerId); } catch (err) { /* ignore */ }
    }
    g.addEventListener('pointermove', onMove);
    g.addEventListener('pointerup', onEnd);
    g.addEventListener('pointercancel', onEnd);
  }

  /* ---------- edges ---------- */

  function handleEdgeClick(edge) {
    if (mode === 'delete') {
      removeEdge(edge.id);
      toast('Edge ' + edge.id + ' deleted');
    } else if (mode === 'select') {
      select('edge', edge.id);
    }
  }

  function handleDrawPathClick(node) {
    if (!drawFromId) {
      drawFromId = node.id;
      updateSelectionVisuals();
      return;
    }
    if (drawFromId === node.id) {
      toast('Cannot connect a node to itself', 'err');
      return;
    }
    var a = drawFromId, b = node.id;
    var exists = graph.edges.some(function (e2) {
      return (e2.from === a && e2.to === b) || (e2.from === b && e2.to === a);
    });
    if (exists) {
      toast('These nodes are already connected', 'err');
      return;
    }
    var edge = {
      id: uniqueId('e-' + a + '-' + b),
      from: a,
      to: b,
      pathType: pathTypeSelect.value
    };
    graph.edges.push(edge);
    cancelDraw();
    markDirty();
    renderAll();
    select('edge', edge.id);
    toast('Path added (' + edge.pathType + ')', 'ok');
  }

  function cancelDraw() {
    drawFromId = null;
    if (previewLine) previewLine.style.display = 'none';
    if (mv) updateSelectionVisuals();
  }

  function removeEdge(id) {
    graph.edges = graph.edges.filter(function (e2) { return e2.id !== id; });
    if (selected && selected.kind === 'edge' && selected.id === id) selected = null;
    markDirty();
    renderAll();
    refreshPanel();
  }

  function deleteNodeWithConfirm(node) {
    var edgeCount = graph.edges.filter(function (e2) {
      return e2.from === node.id || e2.to === node.id;
    }).length;
    var label = node.name ? node.name + ' (' + node.id + ')' : node.id;
    var msg = 'Delete node ' + label + '?' +
      (edgeCount ? ' This also removes ' + edgeCount + ' connected edge' +
        (edgeCount === 1 ? '' : 's') + '.' : '');
    if (!window.confirm(msg)) return;
    graph.nodes = graph.nodes.filter(function (n) { return n.id !== node.id; });
    graph.edges = graph.edges.filter(function (e2) {
      return e2.from !== node.id && e2.to !== node.id;
    });
    if (selected && selected.kind === 'node' && selected.id === node.id) selected = null;
    if (drawFromId === node.id) cancelDraw();
    markDirty();
    renderAll();
    refreshPanel();
    toast('Node ' + node.id + ' deleted');
  }

  /* ---------- map clicks (empty space) ---------- */

  function onMapClick(p) {
    if (!graph) return;
    var x = Math.round(p.x), y = Math.round(p.y);
    if (mode === 'add-location') {
      addLocation(x, y);
    } else if (mode === 'add-junction') {
      addJunction(x, y);
    } else if (mode === 'draw-path') {
      if (drawFromId) cancelDraw();
    } else if (mode === 'select') {
      select(null);
    }
  }

  function addLocation(x, y) {
    var name = window.prompt('Location name:');
    if (name === null) return;
    name = name.trim();
    if (!name) { toast('Name is required', 'err'); return; }
    var node = {
      id: uniqueId(slugify(name)),
      name: name,
      type: 'amenity',
      x: x, y: y,
      destination: true
    };
    graph.nodes.push(node);
    markDirty();
    renderAll();
    select('node', node.id);
    toast('Location "' + name + '" added — set its type in the panel', 'ok');
  }

  function addJunction(x, y) {
    var node = {
      id: nextJunctionId(),
      name: '',
      type: 'junction',
      x: x, y: y,
      destination: false
    };
    graph.nodes.push(node);
    markDirty();
    renderAll();
    select('node', node.id);
    toast('Junction ' + node.id + ' added', 'ok');
  }

  /* ---------- modes ---------- */

  function setMode(next) {
    mode = next;
    cancelDraw();
    document.querySelectorAll('.mode-btn').forEach(function (btn) {
      var active = btn.dataset.mode === mode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    mapDiv.className = 'mode-' + mode;
    pathTypeWrap.classList.toggle('enabled', mode === 'draw-path');
    modeHint.textContent = MODE_HINTS[mode] || '';
    applyCursor();
  }

  function applyCursor() {
    if (!mv) return;
    mv.svg.style.cursor = (mode === 'select') ? 'grab' : 'crosshair';
  }

  /* ---------- save / reload ---------- */

  function save() {
    fetch('/api/graph', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(graph)
    }).then(function (res) {
      if (res.ok) {
        clearDirty();
        toast('Graph saved', 'ok');
        return;
      }
      return res.json().catch(function () { return {}; }).then(function (body) {
        toast('Save failed: ' + (body.error || ('HTTP ' + res.status)), 'err');
      });
    }).catch(function (err) {
      toast('Save failed: ' + err.message, 'err');
    });
  }

  function loadGraph(isReload) {
    return fetch('/api/graph').then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      graph = data;
      selected = null;
      cancelDraw();
      if (!mv) {
        mv = new window.MapView(mapDiv, graph.config);
        buildOverlaySkeleton();
        mv.onClick(onMapClick);
        mv.onViewChanged(applySizes);
        bindMapExtras();
        applyCursor();
      }
      clearDirty();
      renderAll();
      refreshPanel();
      if (isReload) toast('Graph reloaded');
    }).catch(function (err) {
      toast('Failed to load graph: ' + err.message, 'err');
      panelStats.textContent = 'Could not load /api/graph — is the server running?';
    });
  }

  function reload() {
    if (dirty && !window.confirm('Discard unsaved changes and reload from server?')) return;
    loadGraph(true);
  }

  /* ---------- extra map listeners ---------- */

  function bindMapExtras() {
    // rubber-band preview while drawing a path
    mv.svg.addEventListener('pointermove', function (e) {
      if (mode !== 'draw-path' || !drawFromId) return;
      var from = nodeById(drawFromId);
      if (!from) return;
      var p = mv.screenToMap(e.clientX, e.clientY);
      previewLine.setAttribute('x1', from.x);
      previewLine.setAttribute('y1', from.y);
      previewLine.setAttribute('x2', p.x);
      previewLine.setAttribute('y2', p.y);
      previewLine.setAttribute('stroke', pathColor(pathTypeSelect.value));
      previewLine.style.display = '';
    });
    // MapView resets the cursor to grab/grabbing on pointer events;
    // reapply the mode cursor after it finishes.
    mv.svg.addEventListener('pointerup', applyCursor);
    mv.svg.addEventListener('pointercancel', applyCursor);
  }

  /* ---------- panel form bindings ---------- */

  function currentNode() {
    return selected && selected.kind === 'node' ? nodeById(selected.id) : null;
  }
  function currentEdge() {
    return selected && selected.kind === 'edge' ? edgeById(selected.id) : null;
  }

  fName.addEventListener('input', function () {
    var node = currentNode();
    if (!node) return;
    node.name = fName.value;
    markDirty();
    renderAll();
  });

  fType.addEventListener('change', function () {
    var node = currentNode();
    if (!node) return;
    node.type = fType.value;
    markDirty();
    renderAll();
  });

  fDest.addEventListener('change', function () {
    var node = currentNode();
    if (!node) return;
    node.destination = fDest.checked;
    markDirty();
  });

  function onCoordInput() {
    var node = currentNode();
    if (!node) return;
    var x = parseFloat(fX.value), y = parseFloat(fY.value);
    if (!isNaN(x)) node.x = x;
    if (!isNaN(y)) node.y = y;
    markDirty();
    updateNodeVisual(node);
  }
  fX.addEventListener('input', onCoordInput);
  fY.addEventListener('input', onCoordInput);

  $('fDeleteNode').addEventListener('click', function () {
    var node = currentNode();
    if (node) deleteNodeWithConfirm(node);
  });

  ePathType.addEventListener('change', function () {
    var edge = currentEdge();
    if (!edge) return;
    edge.pathType = ePathType.value;
    var els = edgeEls.get(edge.id);
    if (els) els.vis.setAttribute('stroke', pathColor(edge.pathType));
    markDirty();
  });

  $('eDeleteEdge').addEventListener('click', function () {
    var edge = currentEdge();
    if (!edge) return;
    removeEdge(edge.id);
    toast('Edge deleted');
  });

  /* ---------- toolbar / global bindings ---------- */

  document.querySelectorAll('.mode-btn').forEach(function (btn) {
    btn.addEventListener('click', function () { setMode(btn.dataset.mode); });
  });

  pathTypeSelect.addEventListener('change', function () {
    if (drawFromId) {
      previewLine.setAttribute('stroke', pathColor(pathTypeSelect.value));
    }
  });

  $('saveBtn').addEventListener('click', save);
  $('reloadBtn').addEventListener('click', reload);

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (drawFromId) { cancelDraw(); return; }
    if (selected) select(null);
  });

  window.addEventListener('beforeunload', function (e) {
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = '';
  });

  /* ---------- boot ---------- */

  setMode('select');
  loadGraph(false);
})();
