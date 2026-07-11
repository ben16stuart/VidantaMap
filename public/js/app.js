/* VidantaMap — guest UI. Builds on the shared MapView component (mapview.js).
 * Fetches /api/graph on load, /api/route?from&to on request, draws both route
 * options (fastest highlighted, shortest dashed when different) plus start/end
 * pins and destination dots, and shows turn-by-turn steps in a bottom sheet.
 */
(function () {
  'use strict';

  var TYPE_ORDER = ['hotel', 'restaurant', 'pool', 'amenity'];
  var TYPE_LABELS = {
    hotel: 'Hotels',
    restaurant: 'Restaurants',
    pool: 'Pools',
    amenity: 'Amenities'
  };
  var TYPE_COLORS = {
    hotel: '#6d5bd0',
    restaurant: '#d97706',
    pool: '#0284c7',
    amenity: '#0b8a6d'
  };
  var LABEL_MIN_SCALE = 0.42; // hide dot labels when zoomed out beyond this

  var $ = function (id) { return document.getElementById(id); };

  var els = {
    map: $('map'),
    from: $('from-select'),
    to: $('to-select'),
    swap: $('swap-btn'),
    go: $('go-btn'),
    toast: $('toast'),
    sheet: $('sheet'),
    sheetToggle: $('sheet-toggle'),
    sheetClose: $('sheet-close'),
    chips: $('chips'),
    summary: $('route-summary'),
    steps: $('steps')
  };

  var mv = null;
  var graph = null;
  var nodesById = {};
  var gRoutes, gDots, gPins;   // overlay layers (routes under dots under pins)
  var route = null;            // last /api/route response
  var selectedOpt = 'fastest';
  var toastTimer = null;

  var PIN_VALUE = '__pin';     // select value representing a dropped pin
  var pins = { from: null, to: null };  // dropped-pin map coords per side
  var suppressTap = false;     // swallow the tap that ends a long-press

  /* ---------------- helpers ---------------- */

  function typeColor(type) { return TYPE_COLORS[type] || '#64748b'; }

  function fmtTime(seconds) {
    var m = Math.max(1, Math.round(seconds / 60));
    if (m < 60) return m + ' min';
    return Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
  }

  function fmtDist(meters) {
    if (meters >= 1000) return (meters / 1000).toFixed(1) + ' km';
    return Math.round(meters) + ' m';
  }

  function showToast(msg, isError, ms) {
    els.toast.textContent = msg;
    els.toast.classList.toggle('error', !!isError);
    els.toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    if (ms !== 0) {
      toastTimer = setTimeout(function () { els.toast.hidden = true; }, ms || 3800);
    }
  }

  function hideToast() {
    if (toastTimer) clearTimeout(toastTimer);
    els.toast.hidden = true;
  }

  /* ---------------- boot ---------------- */

  function init() {
    fetch('/api/graph')
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (g) {
        graph = g;
        graph.nodes.forEach(function (n) { nodesById[n.id] = n; });
        setupMap();
        buildSelects();
        wireUi();
      })
      .catch(function () {
        showToast('Could not load the resort map. Please check the connection and refresh.', true, 0);
      });
  }

  function setupMap() {
    mv = new MapView(els.map, graph.config);
    gRoutes = MapView.el('g');
    gDots = MapView.el('g');
    gPins = MapView.el('g');
    mv.overlay.appendChild(gRoutes);
    mv.overlay.appendChild(gDots);
    mv.overlay.appendChild(gPins);

    drawDestinationDots();
    mv.onViewChanged(updateScaledMarkers);
    mv.onClick(handleMapTap);
    bindLongPress();
    updateScaledMarkers();
  }

  /* Long-press (hold ~0.5s without moving) anywhere → drop a pin there. */
  function bindLongPress() {
    var timer = null;
    var start = null;

    function cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      start = null;
    }

    mv.svg.addEventListener('pointerdown', function (e) {
      if (timer) { cancel(); return; }   // second finger → pinch, not a pin
      start = { x: e.clientX, y: e.clientY };
      timer = setTimeout(function () {
        var p = mv.screenToMap(start.x, start.y);
        timer = null;
        suppressTap = true;              // the pointerup would otherwise re-fire a tap
        dropPin(p);
      }, 550);
    });
    mv.svg.addEventListener('pointermove', function (e) {
      if (!start) return;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) cancel();
    });
    mv.svg.addEventListener('pointerup', cancel);
    mv.svg.addEventListener('pointercancel', cancel);
    mv.svg.addEventListener('wheel', cancel);
  }

  /* First pin (or a fresh start) becomes From; the second becomes To + routes. */
  function dropPin(p) {
    var point = { x: Math.round(p.x), y: Math.round(p.y) };
    if (point.x < 0 || point.y < 0 ||
        point.x > graph.config.width || point.y > graph.config.height) return;

    if (!els.from.value || (els.from.value && els.to.value)) {
      pins.from = point;
      pins.to = null;
      setPinOption(els.from);
      removePinOption(els.to);
      els.to.value = '';
      clearRoute();
      showToast('Pin dropped as your starting point. Now tap a place or hold to drop another pin.');
    } else {
      pins.to = point;
      setPinOption(els.to);
      getDirections();
    }
    updatePins();
  }

  function setPinOption(sel) {
    var opt = sel.querySelector('option[value="' + PIN_VALUE + '"]');
    if (!opt) {
      opt = document.createElement('option');
      opt.value = PIN_VALUE;
      opt.textContent = '📍 Dropped pin';
      sel.insertBefore(opt, sel.firstChild.nextSibling); // right after placeholder
    }
    sel.value = PIN_VALUE;
  }

  function removePinOption(sel) {
    var opt = sel.querySelector('option[value="' + PIN_VALUE + '"]');
    if (opt) opt.remove();
  }

  /* Endpoint helpers: a side is either a node id or a dropped pin. */
  function sideOf(sel) { return sel === els.from ? 'from' : 'to'; }

  function endpointParam(sel) {
    if (sel.value === PIN_VALUE) {
      var p = pins[sideOf(sel)];
      return p ? p.x + ',' + p.y : '';
    }
    return sel.value;
  }

  function endpointCoords(sel) {
    if (sel.value === PIN_VALUE) return pins[sideOf(sel)];
    var n = nodesById[sel.value];
    return n ? { x: n.x, y: n.y } : null;
  }

  function endpointName(param) {
    if (nodesById[param]) return nodesById[param].name;
    if (/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(param)) return 'Dropped pin';
    return param;
  }

  /* ---------------- destination dots ---------------- */

  function drawDestinationDots() {
    graph.nodes.forEach(function (n) {
      if (!n.destination) return;
      var g = MapView.el('g', { 'class': 'dot', 'data-scaled': '1' });
      g.dataset.mx = n.x;
      g.dataset.my = n.y;
      g.dataset.nodeId = n.id;

      var core = MapView.el('circle', {
        'class': 'dot-core', cx: 0, cy: 0, r: 5.5, fill: typeColor(n.type)
      });
      var label = MapView.el('text', { 'class': 'dot-label', x: 0, y: 17 });
      label.textContent = n.name;
      g.appendChild(core);
      g.appendChild(label);
      gDots.appendChild(g);
    });
  }

  /* Keep dots/pins constant size on screen: counter-scale by 1/mv.scale. */
  function updateScaledMarkers() {
    var k = 1 / mv.scale;
    var nodes = mv.overlay.querySelectorAll('[data-scaled]');
    for (var i = 0; i < nodes.length; i++) {
      var g = nodes[i];
      g.setAttribute('transform',
        'translate(' + g.dataset.mx + ',' + g.dataset.my + ') scale(' + k + ')');
    }
    gDots.classList.toggle('labels-hidden', mv.scale < LABEL_MIN_SCALE);
  }

  /* Tap a destination dot: first tap sets From, second sets To (and routes). */
  function handleMapTap(p) {
    if (suppressTap) { suppressTap = false; return; }
    var hitRadius = 16 / mv.scale; // ~16 screen px in map units
    var best = null, bestD = Infinity;
    graph.nodes.forEach(function (n) {
      if (!n.destination) return;
      var d = Math.hypot(n.x - p.x, n.y - p.y);
      if (d < hitRadius && d < bestD) { best = n; bestD = d; }
    });
    if (!best) return;

    if (!els.from.value || (els.from.value && els.to.value)) {
      // fresh selection: start over from this node
      pins.from = null;
      pins.to = null;
      removePinOption(els.from);
      removePinOption(els.to);
      els.from.value = best.id;
      els.to.value = '';
      clearRoute();
      showToast('Starting from ' + best.name + '. Now tap your destination.');
    } else if (best.id === els.from.value) {
      showToast('That is already your starting point — tap somewhere else to go.');
    } else {
      pins.to = null;
      removePinOption(els.to);
      els.to.value = best.id;
      getDirections();
    }
    updatePins();
  }

  /* ---------------- pickers ---------------- */

  function buildSelects() {
    var groups = {};
    graph.nodes.forEach(function (n) {
      if (!n.destination) return;
      var t = TYPE_LABELS[n.type] ? n.type : '_other';
      (groups[t] = groups[t] || []).push(n);
    });

    var order = TYPE_ORDER.filter(function (t) { return groups[t]; });
    if (groups._other) order.push('_other');

    [els.from, els.to].forEach(function (sel) {
      order.forEach(function (t) {
        var og = document.createElement('optgroup');
        og.label = t === '_other' ? 'More places' : TYPE_LABELS[t];
        groups[t]
          .slice()
          .sort(function (a, b) { return a.name.localeCompare(b.name); })
          .forEach(function (n) {
            var opt = document.createElement('option');
            opt.value = n.id;
            opt.textContent = n.name;
            og.appendChild(opt);
          });
        sel.appendChild(og);
      });
    });
  }

  function wireUi() {
    els.go.addEventListener('click', getDirections);

    els.swap.addEventListener('click', function () {
      var fVal = els.from.value, tVal = els.to.value;
      var tmpPin = pins.from;
      pins.from = pins.to;
      pins.to = tmpPin;
      if (tVal === PIN_VALUE) { setPinOption(els.from); }
      else { removePinOption(els.from); els.from.value = tVal; }
      if (fVal === PIN_VALUE) { setPinOption(els.to); }
      else { removePinOption(els.to); els.to.value = fVal; }
      updatePins();
      if (route && els.from.value && els.to.value) {
        getDirections();
      }
    });

    [els.from, els.to].forEach(function (sel) {
      sel.addEventListener('change', function () {
        if (sel.value !== PIN_VALUE) {
          // picking a real place discards that side's dropped pin
          pins[sideOf(sel)] = null;
          removePinOption(sel);
        }
        clearRoute(); // selection changed — old route is stale
        updatePins();
      });
    });

    els.sheetToggle.addEventListener('click', function () {
      els.sheet.classList.toggle('collapsed');
    });
    els.sheetClose.addEventListener('click', function () {
      clearRoute();
      updatePins();
    });
  }

  /* ---------------- routing ---------------- */

  function getDirections() {
    var from = endpointParam(els.from), to = endpointParam(els.to);
    if (!from || !to) {
      showToast('Choose both a starting point and a destination.');
      return;
    }
    if (from === to) {
      showToast('You are already there! Pick two different places.');
      return;
    }

    hideToast();
    els.go.disabled = true;
    els.go.textContent = 'Finding your way…';

    fetch('/api/route?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to))
      .then(function (res) {
        if (res.status === 404) {
          clearRoute();
          updatePins();
          showToast('Sorry — there is no walking path between those two places. Try a different pair.', true, 6000);
          return null;
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (!data) return;
        route = data;
        selectedOpt = 'fastest';
        renderRoutes();
        renderChips();
        renderDetails();
        updatePins();
        els.sheet.hidden = false;
        els.sheet.classList.remove('collapsed');
        fitToRoute();
      })
      .catch(function () {
        showToast('Something went wrong getting directions. Please try again.', true);
      })
      .then(function () {
        els.go.disabled = false;
        els.go.textContent = 'Get Directions';
      });
  }

  function routesDiffer() {
    return route &&
      route.routes.fastest.nodeIds.join(' ') !==
      route.routes.shortest.nodeIds.join(' ');
  }

  function clearRoute() {
    route = null;
    while (gRoutes && gRoutes.firstChild) gRoutes.removeChild(gRoutes.firstChild);
    els.sheet.hidden = true;
  }

  /* ---------------- drawing ---------------- */

  function polylinePoints(r) {
    return r.coords.map(function (c) { return c.x + ',' + c.y; }).join(' ');
  }

  function renderRoutes() {
    while (gRoutes.firstChild) gRoutes.removeChild(gRoutes.firstChild);
    if (!route) return;

    var sel = route.routes[selectedOpt];
    var altKey = selectedOpt === 'fastest' ? 'shortest' : 'fastest';

    if (routesDiffer()) {
      gRoutes.appendChild(MapView.el('polyline', {
        points: polylinePoints(route.routes[altKey]), 'class': 'route-alt'
      }));
    }
    gRoutes.appendChild(MapView.el('polyline', {
      points: polylinePoints(sel), 'class': 'route-casing'
    }));
    gRoutes.appendChild(MapView.el('polyline', {
      points: polylinePoints(sel), 'class': 'route-primary'
    }));
  }

  function makePin(color) {
    var g = MapView.el('g', { 'data-scaled': '1' });
    g.appendChild(MapView.el('ellipse', {
      'class': 'pin-shadow', cx: 0, cy: 1.5, rx: 6, ry: 2.4
    }));
    g.appendChild(MapView.el('path', {
      d: 'M0 0C-6.5 -9 -11 -12.5 -11 -19A11 11 0 1 1 11 -19C11 -12.5 6.5 -9 0 0Z',
      fill: color, stroke: '#ffffff', 'stroke-width': 2
    }));
    g.appendChild(MapView.el('circle', { cx: 0, cy: -19, r: 3.6, fill: '#ffffff' }));
    return g;
  }

  /* Green start / red end pins for the current From/To selection. */
  function updatePins() {
    while (gPins.firstChild) gPins.removeChild(gPins.firstChild);
    var from = endpointCoords(els.from);
    var to = endpointCoords(els.to);
    if (from) {
      var p1 = makePin('#16a34a');
      p1.dataset.mx = from.x; p1.dataset.my = from.y;
      gPins.appendChild(p1);
    }
    if (to) {
      var p2 = makePin('#dc2626');
      p2.dataset.mx = to.x; p2.dataset.my = to.y;
      gPins.appendChild(p2);
    }
    // mark selected dots
    var dots = gDots.querySelectorAll('.dot');
    for (var i = 0; i < dots.length; i++) {
      var id = dots[i].dataset.nodeId;
      dots[i].classList.toggle('selected',
        id === els.from.value || id === els.to.value);
    }
    updateScaledMarkers();
  }

  function fitToRoute() {
    if (!route) return;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    ['fastest', 'shortest'].forEach(function (k) {
      route.routes[k].coords.forEach(function (c) {
        if (c.x < minX) minX = c.x;
        if (c.y < minY) minY = c.y;
        if (c.x > maxX) maxX = c.x;
        if (c.y > maxY) maxY = c.y;
      });
    });
    mv.fitBounds(minX, minY, maxX, maxY, 90);
  }

  /* ---------------- bottom sheet ---------------- */

  function chipLabel(kind, r) {
    var name = kind === 'fastest' ? 'Fastest' : 'Shortest';
    if (!routesDiffer()) name = 'Fastest · Shortest';
    return '<span class="chip-kind">' + name + '</span> — ' +
      fmtTime(r.timeSeconds) + ' · ' + fmtDist(r.distanceMeters);
  }

  function renderChips() {
    els.chips.innerHTML = '';
    if (!route) return;
    var kinds = routesDiffer() ? ['fastest', 'shortest'] : ['fastest'];
    kinds.forEach(function (kind) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (kind === selectedOpt ? ' active' : '');
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', kind === selectedOpt ? 'true' : 'false');
      b.innerHTML = chipLabel(kind, route.routes[kind]);
      b.addEventListener('click', function () {
        if (selectedOpt === kind) return;
        selectedOpt = kind;
        renderRoutes();
        renderChips();
        renderDetails();
      });
      els.chips.appendChild(b);
    });
  }

  function stepGlyph(text) {
    var t = text.toLowerCase();
    if (t.indexOf('arrive') === 0) return '⚑';
    if (t.indexOf('turn left') === 0) return '↰';
    if (t.indexOf('turn right') === 0) return '↱';
    if (t.indexOf('bear left') === 0) return '↖';
    if (t.indexOf('bear right') === 0) return '↗';
    return '↑';
  }

  function renderDetails() {
    if (!route) return;
    var r = route.routes[selectedOpt];
    var fromName = endpointName(route.from);
    var toName = endpointName(route.to);

    els.summary.innerHTML = '';
    var big = document.createTextNode(fmtTime(r.timeSeconds) + ' · ' + fmtDist(r.distanceMeters));
    var small = document.createElement('small');
    small.textContent = fromName + ' → ' + toName;
    els.summary.appendChild(big);
    els.summary.appendChild(small);

    els.steps.innerHTML = '';
    (r.steps || []).forEach(function (s) {
      var li = document.createElement('li');
      var isArrive = s.text.toLowerCase().indexOf('arrive') === 0;
      if (isArrive) li.className = 'arrive';

      var icon = document.createElement('span');
      icon.className = 'step-icon';
      icon.textContent = stepGlyph(s.text);

      var txt = document.createElement('span');
      txt.className = 'step-text';
      txt.textContent = s.text;

      li.appendChild(icon);
      li.appendChild(txt);

      if (s.distanceMeters > 0) {
        var dist = document.createElement('span');
        dist.className = 'step-dist';
        dist.textContent = fmtDist(s.distanceMeters);
        li.appendChild(dist);
      }
      els.steps.appendChild(li);
    });
  }

  init();
})();
