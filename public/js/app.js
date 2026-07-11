/* VidantaMap — guest UI. Builds on the shared MapView component (mapview.js).
 * Fetches /api/graph on load, /api/route?from&to on request, draws both route
 * options (fastest highlighted, shortest dashed when different) plus start/end
 * pins and destination dots, and shows turn-by-turn steps in a bottom sheet.
 */
(function () {
  'use strict';

  var TYPE_ORDER = ['hotel', 'restaurant', 'bar', 'pool', 'amenity'];
  var TYPE_LABELS = {
    hotel: 'Hotels',
    restaurant: 'Restaurants',
    bar: 'Bars',
    pool: 'Pools',
    amenity: 'Amenities'
  };
  var TYPE_COLORS = {
    hotel: '#6d5bd0',
    restaurant: '#d97706',
    bar: '#c026d3',
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
    loc: $('loc-btn'),
    topcard: $('topcard'),
    topFull: $('topcard-full'),
    topMini: $('topcard-mini'),
    miniText: $('mini-text'),
    collapse: $('collapse-btn'),
    filters: $('filters'),
    reverse: $('reverse-btn'),
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
  var fromIsLocation = false;  // From pin came from device GPS (blue-dot marker)
  var GEO_STORE_KEY = 'vidantamap-geo-calibration';
  var typeVisible = { hotel: true, restaurant: true, bar: true, pool: true, amenity: true };
  function isTypeVisible(type) {
    return typeVisible[type] !== undefined ? typeVisible[type] : typeVisible.amenity;
  }
  // pending GPS→map calibration: { lat, lng, soft, expires }
  // soft=true: dot landed in-bounds, tap-to-correct offered briefly;
  // soft=false: GPS said out-of-bounds, next tap calibrates (sticky).
  var pendingCal = null;

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
        // a calibration done on this device beats the shipped estimate
        try {
          var savedGeo = localStorage.getItem(GEO_STORE_KEY);
          if (savedGeo) graph.config.geo = JSON.parse(savedGeo);
        } catch (e) { /* private mode etc. — ignore */ }
        setupMap();
        buildSelects();
        wireUi();
        wireFilters();
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
      fromIsLocation = false;
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

  /* ---------------- current location (GPS) ---------------- */

  /* Linear lat/lng → map px using the config.geo corner calibration. */
  function gpsToMap(lat, lng) {
    var geo = graph.config.geo;
    if (!geo || !geo.topLeft || !geo.bottomRight) return null;
    return {
      x: (lng - geo.topLeft.lng) / (geo.bottomRight.lng - geo.topLeft.lng) * graph.config.width,
      y: (lat - geo.topLeft.lat) / (geo.bottomRight.lat - geo.topLeft.lat) * graph.config.height
    };
  }

  /* One-point calibration: the user stands at map point (x, y) with GPS
   * (lat, lng). Combined with the map's meters-per-pixel scale and a
   * north-up map, that fully determines the corner coordinates. */
  function geoFromAnchor(lat, lng, x, y) {
    var mpp = graph.config.metersPerPixel || 1;
    var latSpan = graph.config.height * mpp / 110540;                       // ° per map height
    var lngSpan = graph.config.width * mpp / (111320 * Math.cos(lat * Math.PI / 180));
    var topLat = lat + (y / graph.config.height) * latSpan;
    var topLng = lng - (x / graph.config.width) * lngSpan;
    return {
      comment: 'Calibrated in-app from a GPS fix at a user-tapped map point (north-up assumed).',
      topLeft: { lat: topLat, lng: topLng },
      bottomRight: { lat: topLat - latSpan, lng: topLng + lngSpan }
    };
  }

  function calibrateAt(p) {
    var cal = pendingCal;
    pendingCal = null;
    hideToast();
    var x = Math.round(Math.min(Math.max(p.x, 0), graph.config.width));
    var y = Math.round(Math.min(Math.max(p.y, 0), graph.config.height));
    graph.config.geo = geoFromAnchor(cal.lat, cal.lng, x, y);
    try { localStorage.setItem(GEO_STORE_KEY, JSON.stringify(graph.config.geo)); } catch (e) { /* ignore */ }
    // best effort: persist for everyone when the real server is behind us
    try {
      fetch('/api/graph', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(graph)
      }).catch(function () { /* static demo / offline — device copy still saved */ });
    } catch (e) { /* ignore */ }

    pins.from = { x: x, y: y };
    fromIsLocation = true;
    setPinOption(els.from, '⌖ My location');
    clearRoute();
    updatePins();
    mv.zoomTo(x, y);
    if (els.to.value) getDirections();
    else showToast('Map calibrated to your GPS ✓ Starting from your location — now pick a destination.');
  }

  /* True when we're inside a cross-origin iframe whose permissions policy
   * blocks geolocation (e.g. an embedded demo view) — the browser then
   * auto-denies without ever prompting the user. */
  function geoBlockedByFrame() {
    try {
      if (window.self === window.top) return false;
      if (document.featurePolicy && document.featurePolicy.allowsFeature) {
        return !document.featurePolicy.allowsFeature('geolocation');
      }
    } catch (e) { /* fall through */ }
    return false;
  }

  var MANUAL_TIP = ' You can still set your start manually: press and hold the map where you are.';

  function useMyLocation() {
    if (!navigator.geolocation) {
      showToast('Location is not available in this browser.' + MANUAL_TIP, true, 8000);
      return;
    }
    if (!window.isSecureContext) {
      showToast('Location needs a secure (HTTPS) connection — this page is plain HTTP, so the phone blocks GPS.' + MANUAL_TIP, true, 8000);
      return;
    }
    if (geoBlockedByFrame()) {
      showToast('This embedded demo view blocks location access.' + MANUAL_TIP, true, 8000);
      return;
    }
    if (!graph.config.geo) {
      showToast('This map has no GPS calibration yet — ask the resort to set it up.', true);
      return;
    }
    els.loc.disabled = true;
    els.loc.textContent = 'Locating…';

    function done() {
      els.loc.disabled = false;
      els.loc.textContent = '⌖ Use my current location';
    }

    navigator.geolocation.getCurrentPosition(function (pos) {
      done();
      var lat = pos.coords.latitude, lng = pos.coords.longitude;
      var p = gpsToMap(lat, lng);
      // tolerate a little GPS drift just past the map edge, then clamp on
      var marginX = graph.config.width * 0.12, marginY = graph.config.height * 0.12;
      if (!p || p.x < -marginX || p.y < -marginY ||
          p.x > graph.config.width + marginX || p.y > graph.config.height + marginY) {
        // likely mis-calibrated GPS anchoring — let the user fix it with one tap
        pendingCal = { lat: lat, lng: lng, soft: false };
        showToast('Your GPS position lands off this map — the map’s GPS calibration is probably off. If you are at the resort, tap the map exactly where you are standing and I’ll recalibrate.', true, 0);
        return;
      }
      pins.from = {
        x: Math.round(Math.min(Math.max(p.x, 0), graph.config.width)),
        y: Math.round(Math.min(Math.max(p.y, 0), graph.config.height))
      };
      fromIsLocation = true;
      // brief window to correct a wrong-but-in-bounds dot with a tap
      pendingCal = { lat: lat, lng: lng, soft: true, expires: Date.now() + 15000 };
      setPinOption(els.from, '⌖ My location');
      clearRoute();
      updatePins();
      mv.zoomTo(pins.from.x, pins.from.y);
      if (els.to.value) getDirections();
      else showToast('Starting from your location. Blue dot in the wrong spot? Tap the map where you actually are to fix it.', false, 8000);
    }, function (err) {
      done();
      var msg;
      if (err && err.code === 1) {
        msg = geoBlockedByFrame()
          ? 'This embedded demo view blocks location access.' + MANUAL_TIP
          : 'Location permission was denied. On iPhone: Settings → Privacy & Security → Location Services → Safari Websites → While Using.' + MANUAL_TIP;
      } else {
        msg = 'Could not get your location right now.' + MANUAL_TIP;
      }
      showToast(msg, true, 9000);
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
  }

  function setPinOption(sel, label) {
    var opt = sel.querySelector('option[value="' + PIN_VALUE + '"]');
    if (!opt) {
      opt = document.createElement('option');
      opt.value = PIN_VALUE;
      sel.insertBefore(opt, sel.firstChild.nextSibling); // right after placeholder
    }
    opt.textContent = label || '📍 Dropped pin';
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

  /* Display name for a select's current choice ('' when unset). */
  function sideName(sel) {
    if (!sel.value) return '';
    if (sel.value === PIN_VALUE) {
      return sel === els.from && fromIsLocation ? 'My location' : 'Dropped pin';
    }
    return (nodesById[sel.value] || {}).name || sel.value;
  }

  /* ---------------- top card collapse ---------------- */

  function setTopCollapsed(collapsed) {
    els.topFull.hidden = collapsed;
    els.topMini.hidden = !collapsed;
    els.topcard.classList.toggle('collapsed', collapsed);
    if (collapsed) updateMiniText();
  }

  function updateMiniText() {
    var f = sideName(els.from), t = sideName(els.to);
    els.miniText.textContent =
      f && t ? f + ' → ' + t :
      f ? f + ' → where to?' :
      'Where to?';
  }

  /* ---------------- destination dots ---------------- */

  function drawDestinationDots() {
    graph.nodes.forEach(function (n) {
      if (!n.destination) return;
      var g = MapView.el('g', { 'class': 'dot', 'data-scaled': '1' });
      g.dataset.mx = n.x;
      g.dataset.my = n.y;
      g.dataset.nodeId = n.id;

      g.dataset.nodeType = TYPE_LABELS[n.type] ? n.type : 'amenity';
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

  /* ---------------- POI category filters ---------------- */

  function applyTypeFilters() {
    var dots = gDots.querySelectorAll('.dot');
    for (var i = 0; i < dots.length; i++) {
      var g = dots[i];
      var show = typeVisible[g.dataset.nodeType];
      // keep the current From/To visible even if its category is off
      var id = g.dataset.nodeId;
      if (id === els.from.value || id === els.to.value) show = true;
      g.style.display = show ? '' : 'none';
    }
  }

  function wireFilters() {
    var chips = els.filters.querySelectorAll('.filter-chip');
    chips.forEach(function (chip) {
      chip.addEventListener('click', function () {
        var t = chip.dataset.type;
        typeVisible[t] = !typeVisible[t];
        chip.classList.toggle('off', !typeVisible[t]);
        applyTypeFilters();
      });
    });
    // pin the chip row just below the (resizable) top card
    function placeFilters() {
      els.filters.style.top = (els.topcard.getBoundingClientRect().bottom + 8) + 'px';
    }
    if (window.ResizeObserver) new ResizeObserver(placeFilters).observe(els.topcard);
    window.addEventListener('resize', placeFilters);
    placeFilters();
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
      if (!isTypeVisible(TYPE_LABELS[n.type] ? n.type : 'amenity')) return; // hidden category
      var d = Math.hypot(n.x - p.x, n.y - p.y);
      if (d < hitRadius && d < bestD) { best = n; bestD = d; }
    });

    if (pendingCal) {
      if (pendingCal.expires && Date.now() > pendingCal.expires) {
        pendingCal = null;                    // correction window closed
      } else if (!pendingCal.soft) {
        calibrateAt(p);                       // out-of-bounds fix: any tap calibrates
        return;
      } else if (!best) {
        calibrateAt(p);                       // wrong-spot fix: taps on empty map calibrate
        return;
      } else {
        pendingCal = null;                    // they picked a destination instead
      }
    }

    if (!best) return;

    if (!els.from.value || (els.from.value && els.to.value)) {
      // fresh selection: start over from this node
      pins.from = null;
      pins.to = null;
      fromIsLocation = false;
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
    els.loc.addEventListener('click', useMyLocation);
    els.collapse.addEventListener('click', function () { setTopCollapsed(true); });
    els.topMini.addEventListener('click', function () { setTopCollapsed(false); });

    function swapEndpoints() {
      var fVal = els.from.value, tVal = els.to.value;
      var tmpPin = pins.from;
      pins.from = pins.to;
      pins.to = tmpPin;
      fromIsLocation = false; // a swapped location pin becomes a plain pin
      if (tVal === PIN_VALUE) { setPinOption(els.from); }
      else { removePinOption(els.from); els.from.value = tVal; }
      if (fVal === PIN_VALUE) { setPinOption(els.to); }
      else { removePinOption(els.to); els.to.value = fVal; }
      updatePins();
      if (route && els.from.value && els.to.value) {
        getDirections();
      }
    }
    els.swap.addEventListener('click', swapEndpoints);
    els.reverse.addEventListener('click', swapEndpoints);

    [els.from, els.to].forEach(function (sel) {
      sel.addEventListener('change', function () {
        if (sel.value !== PIN_VALUE) {
          // picking a real place discards that side's dropped pin
          pins[sideOf(sel)] = null;
          removePinOption(sel);
          if (sel === els.from) fromIsLocation = false;
        }
        clearRoute(); // selection changed — old route is stale
        updatePins();
      });
    });

    els.sheetToggle.addEventListener('click', function () {
      els.sheet.classList.toggle('collapsed');
    });
    // the summary line is also a toggle — a bigger target than the grabber
    els.summary.addEventListener('click', function () {
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
        setTopCollapsed(true);  // get the pickers out of the way of the route
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

  /* Google-style blue dot for "my location". */
  function makeLocationDot() {
    var g = MapView.el('g', { 'data-scaled': '1' });
    g.appendChild(MapView.el('circle', {
      cx: 0, cy: 0, r: 14, fill: '#3b82f6', 'fill-opacity': 0.25
    }));
    g.appendChild(MapView.el('circle', {
      cx: 0, cy: 0, r: 6.5, fill: '#2563eb', stroke: '#ffffff', 'stroke-width': 2.5
    }));
    return g;
  }

  /* Green start / red end pins for the current From/To selection. */
  function updatePins() {
    while (gPins.firstChild) gPins.removeChild(gPins.firstChild);
    var from = endpointCoords(els.from);
    var to = endpointCoords(els.to);
    if (from) {
      var p1 = fromIsLocation && els.from.value === PIN_VALUE
        ? makeLocationDot()
        : makePin('#16a34a');
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
    updateMiniText();
    applyTypeFilters();
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
    var fromName = fromIsLocation && els.from.value === PIN_VALUE
      ? 'My location' : endpointName(route.from);
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
