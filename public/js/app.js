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
    fab: $('follow-fab'),
    toast: $('toast'),
    sheet: $('sheet'),
    sheetToggle: $('sheet-toggle'),
    sheetClose: $('sheet-close'),
    chips: $('chips'),
    summary: $('route-summary'),
    steps: $('steps'),
    start: $('start-btn'),
    navBanner: $('nav-banner'),
    navGlyph: $('nav-glyph'),
    navDist: $('nav-dist'),
    navInstr: $('nav-instr'),
    navExit: $('nav-exit')
  };

  var mv = null;
  var graph = null;
  var nodesById = {};
  var gRoutes, gDots, gPins;   // overlay layers (routes under dots under pins)
  var route = null;            // last /api/route response
  var selectedOpt = 'fastest';
  var toastTimer = null;

  // live navigation state
  var navMode = false;         // actively navigating a route (Start pressed)
  var navGeom = null;          // { coords, cumPx[], totalPx, steps, stepStartPx[] }
  var stepEls = [];            // <li> per step, for progress highlighting
  var navArrived = false;
  var offRouteCount = 0;
  var lastReroute = 0;

  var PIN_VALUE = '__pin';     // select value representing a dropped pin
  var pins = { from: null, to: null };  // dropped-pin map coords per side
  var suppressTap = false;     // swallow the tap that ends a long-press
  var fromIsLocation = false;  // From pin came from device GPS (blue-dot marker)
  var GEO_STORE_KEY = 'vidantamap-geo-calibration';
  var calAnchors = [];         // GPS↔map reference points ({lat,lng,x,y}, max 2)
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
          if (savedGeo) {
            var parsed = JSON.parse(savedGeo);
            if (parsed.topLeft) {            // legacy format: geo only
              graph.config.geo = parsed;
            } else if (parsed.geo) {
              graph.config.geo = parsed.geo;
              calAnchors = parsed.anchors || [];
            }
          }
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
    bindPanPausesFollow();
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

  /* GPS (lat,lng) → local planar meters around a reference point.
   * sx = east (map x grows east), sy = -north (screen y grows south). */
  function toMeters(lat, lng, ref) {
    return {
      sx: (lng - ref.lng) * 111320 * Math.cos(ref.lat * Math.PI / 180),
      sy: -(lat - ref.lat) * 110540
    };
  }

  /* lat/lng → map pixels. Supports a similarity transform (position +
   * rotation + scale, from in-app calibration) OR legacy corner geo. */
  function gpsToMap(lat, lng) {
    var geo = graph.config.geo;
    if (!geo) return null;
    if (typeof geo.c === 'number') {           // similarity transform
      var s = toMeters(lat, lng, geo.ref);
      return { x: geo.c * s.sx - geo.d * s.sy + geo.tx,
               y: geo.d * s.sx + geo.c * s.sy + geo.ty };
    }
    if (geo.topLeft && geo.bottomRight) {       // legacy north-up corners
      return {
        x: (lng - geo.topLeft.lng) / (geo.bottomRight.lng - geo.topLeft.lng) * graph.config.width,
        y: (lat - geo.topLeft.lat) / (geo.bottomRight.lat - geo.topLeft.lat) * graph.config.height
      };
    }
    return null;
  }

  /* Build a GPS→pixel similarity transform from anchor points.
   *   pixel = R·meters + t,  R = [[c,-d],[d,c]]  (scale·rotation).
   * One anchor: position only (nominal scale from metersPerPixel, north-up).
   * Two anchors: full position + rotation + scale — the right model for a
   * map drawn at an angle (which is why a north-up fit kept drifting). */
  function geoFromAnchors(anchors) {
    var mpp = graph.config.metersPerPixel || 1;
    var ref = { lat: anchors[0].lat, lng: anchors[0].lng };
    var a = anchors[0];
    var sa = toMeters(a.lat, a.lng, ref);       // ≈ (0,0)
    if (anchors.length < 2) {
      var c1 = 1 / mpp;                          // px per meter, north-up
      return { comment: 'Calibrated from 1 GPS point (position only).',
        ref: ref, c: c1, d: 0,
        tx: a.x - c1 * sa.sx, ty: a.y - c1 * sa.sy };
    }
    var b = anchors[1];
    var sb = toMeters(b.lat, b.lng, ref);
    var dsx = sb.sx - sa.sx, dsy = sb.sy - sa.sy;
    var dpx = b.x - a.x, dpy = b.y - a.y;
    var det = dsx * dsx + dsy * dsy;
    var c = (dsx * dpx + dsy * dpy) / det;
    var d = (dsx * dpy - dsy * dpx) / det;
    // sanity: solved scale within 3× of nominal, else GPS noise won → 1-point
    var scale = Math.hypot(c, d), nominal = 1 / mpp;
    if (!(scale > 0) || scale > nominal * 3 || scale < nominal / 3) {
      return geoFromAnchors([anchors[0]]);
    }
    return { comment: 'Calibrated from 2 GPS points (position, rotation, scale).',
      ref: ref, c: c, d: d,
      tx: a.x - (c * sa.sx - d * sa.sy),
      ty: a.y - (d * sa.sx + c * sa.sy) };
  }

  function calibrateAt(p) {
    var cal = pendingCal;
    pendingCal = null;
    hideToast();
    var x = Math.round(Math.min(Math.max(p.x, 0), graph.config.width));
    var y = Math.round(Math.min(Math.max(p.y, 0), graph.config.height));

    calAnchors.push({ lat: cal.lat, lng: cal.lng, x: x, y: y });
    if (calAnchors.length > 2) {
      // keep the pair that spans the most map — better scale solving
      var best = null;
      for (var i = 0; i < calAnchors.length; i++) {
        for (var j = i + 1; j < calAnchors.length; j++) {
          var d = Math.hypot(calAnchors[i].x - calAnchors[j].x, calAnchors[i].y - calAnchors[j].y);
          if (!best || d > best.d) best = { d: d, pair: [calAnchors[i], calAnchors[j]] };
        }
      }
      calAnchors = best.pair;
    }
    graph.config.geo = geoFromAnchors(calAnchors);
    var twoPoint = calAnchors.length >= 2 && typeof graph.config.geo.d === 'number' &&
      (graph.config.geo.d !== 0 || graph.config.geo.c !== 1 / (graph.config.metersPerPixel || 1));
    try {
      localStorage.setItem(GEO_STORE_KEY, JSON.stringify({ geo: graph.config.geo, anchors: calAnchors }));
    } catch (e) { /* ignore */ }
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
    if (following()) { hadFix = true; ensureLiveDot(x, y); }
    mv.zoomTo(x, y);
    var calMsg = twoPoint
      ? 'Calibrated with 2 points — position, rotation and scale locked in ✓ The dot should track you accurately now.'
      : 'Point 1 set ✓ This map is drawn at an angle, so please calibrate ONE more time from a spot far from here (your tower, the lobby, the far pool): walk there, hold ⌖, and tap where you stand.';
    if (els.to.value) { getDirections(); showToast(calMsg, false, twoPoint ? 5000 : 9000); }
    else showToast(calMsg, false, twoPoint ? 5000 : 9000);
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

  /* Live follow-me tracking: watchPosition keeps the blue dot on your real
   * position as you walk; the map recenters on you every few seconds until
   * you pan it yourself (tap ⌖ again to re-center, tap once more to stop). */
  var watchId = null;         // active geolocation watch
  var autoCenter = false;     // keep the map centered on the live dot
  var lastCenter = 0;         // last auto-recenter time (throttled)
  var liveDot = null;         // the moving blue-dot marker
  var accRing = null;         // GPS accuracy circle (true map size)
  var hadFix = false;         // got at least one usable fix this session
  var lastFix = null;         // most recent raw GPS fix {lat, lng}
  var calibrateOnFix = false; // FAB held before tracking had a fix
  var CENTER_EVERY_MS = 4000;

  function following() { return watchId !== null; }

  function ensureLiveDot(x, y, accuracyMeters) {
    if (!accRing) {
      accRing = MapView.el('circle', {
        fill: '#3b82f6', 'fill-opacity': 0.12, stroke: '#3b82f6',
        'stroke-opacity': 0.35, 'stroke-width': 1,
        'vector-effect': 'non-scaling-stroke', 'pointer-events': 'none'
      });
      mv.overlay.appendChild(accRing);
    }
    if (!liveDot) {
      liveDot = makeLocationDot();
      mv.overlay.appendChild(liveDot);
    }
    liveDot.dataset.mx = x;
    liveDot.dataset.my = y;
    accRing.setAttribute('cx', x);
    accRing.setAttribute('cy', y);
    // accuracy radius in true map pixels (shows GPS wobble honestly)
    var mpp = graph.config.metersPerPixel || 1;
    accRing.setAttribute('r', Math.min((accuracyMeters || 20) / mpp, 200));
    updateScaledMarkers();
  }

  function removeLiveDot() {
    if (liveDot && liveDot.parentNode) liveDot.parentNode.removeChild(liveDot);
    if (accRing && accRing.parentNode) accRing.parentNode.removeChild(accRing);
    liveDot = null;
    accRing = null;
  }

  function updateFollowUi() {
    var fab = els.fab;
    fab.classList.toggle('active', following() && autoCenter);
    fab.classList.toggle('paused', following() && !autoCenter);
    els.loc.textContent = !following() ? '⌖ Follow my location'
      : autoCenter ? '⌖ Following you — tap to stop'
      : '⌖ Tap to re-center on me';
    fab.title = els.loc.textContent.replace('⌖ ', '');
  }

  function stopFollowing() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    autoCenter = false;
    hadFix = false;
    removeLiveDot();
    updateFollowUi();
  }

  function onFix(pos) {
    var lat = pos.coords.latitude, lng = pos.coords.longitude;
    lastFix = { lat: lat, lng: lng, accuracy: pos.coords.accuracy };
    if (calibrateOnFix) {      // user held ⌖ before the first fix arrived
      calibrateOnFix = false;
      pendingCal = { lat: lat, lng: lng, soft: false };
      showToast('Got a GPS fix. Now tap the map exactly where you are standing.', false, 0);
      return;
    }
    var p = gpsToMap(lat, lng);
    var marginX = graph.config.width * 0.12, marginY = graph.config.height * 0.12;
    if (!p || p.x < -marginX || p.y < -marginY ||
        p.x > graph.config.width + marginX || p.y > graph.config.height + marginY) {
      // likely mis-calibrated GPS anchoring — one tap from the user fixes it
      if (!pendingCal && !hadFix) {
        pendingCal = { lat: lat, lng: lng, soft: false };
        showToast('Your GPS position lands off this map — the calibration is probably off. Tap the map exactly where you are standing and I’ll recalibrate.', true, 0);
      } else if (pendingCal && !pendingCal.soft) {
        pendingCal.lat = lat; pendingCal.lng = lng;  // keep the freshest fix
      }
      return;
    }
    var x = Math.round(Math.min(Math.max(p.x, 0), graph.config.width));
    var y = Math.round(Math.min(Math.max(p.y, 0), graph.config.height));
    var first = !hadFix;
    hadFix = true;
    ensureLiveDot(x, y, pos.coords.accuracy);

    // live navigation drives its own line/steps/banner from each fix
    if (navMode) updateNavigation(x, y);

    if (first) {
      // brief window to correct a wrong-but-in-bounds dot with a tap
      pendingCal = { lat: lat, lng: lng, soft: true, expires: Date.now() + 15000 };
      if (!els.from.value || fromIsLocation) {
        pins.from = { x: x, y: y };
        fromIsLocation = true;
        setPinOption(els.from, '⌖ My location');
        updatePins();
        if (els.to.value && !route) getDirections();
      }
      mv.zoomTo(x, y);
      lastCenter = Date.now();
      // If this device has never done a 2-point calibration, the dot on this
      // angled map will be off — teach the fix up front.
      var calibrated = calAnchors.length >= 2;
      showToast(calibrated
        ? 'Following your location — the blue dot updates as you walk.'
        : 'Following you. If the blue dot is off, HOLD the ⌖ button and tap the map where you actually are (do this twice, from two spots far apart, for accurate tracking).',
        false, calibrated ? 5000 : 10000);
      return;
    }
    if (autoCenter && Date.now() - lastCenter >= CENTER_EVERY_MS) {
      mv.centerOn(x, y);
      lastCenter = Date.now();
    }
  }

  function onFixError(err) {
    if (err && err.code === 1) {
      stopFollowing();
      var msg = geoBlockedByFrame()
        ? 'This embedded demo view blocks location access.' + MANUAL_TIP
        : 'Location permission was denied. On iPhone: Settings → Privacy & Security → Location Services → Safari Websites → While Using.' + MANUAL_TIP;
      showToast(msg, true, 9000);
    }
    // transient errors (timeout / temporarily unavailable): keep watching
  }

  function useMyLocation() {
    if (following()) {
      if (!autoCenter) {           // panned away → snap back to me
        autoCenter = true;
        if (liveDot) { mv.centerOn(+liveDot.dataset.mx, +liveDot.dataset.my); lastCenter = Date.now(); }
        updateFollowUi();
      } else {
        stopFollowing();
      }
      return;
    }
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
    autoCenter = true;
    watchId = navigator.geolocation.watchPosition(onFix, onFixError, {
      enableHighAccuracy: true,
      maximumAge: 2000,
      timeout: 15000
    });
    updateFollowUi();
  }

  /* Hold-⌖ entry point: recalibrate from the freshest GPS fix. */
  function startRecalibration() {
    if (!graph || !graph.config.geo) return;
    if (lastFix) {
      pendingCal = { lat: lastFix.lat, lng: lastFix.lng, soft: false };
      showToast('Recalibrating: tap the map exactly where you are standing.', false, 0);
      return;
    }
    // no fix yet — start tracking and calibrate on the first fix
    calibrateOnFix = true;
    if (!following()) useMyLocation();
    if (following()) showToast('Getting a GPS fix… then tap the map exactly where you are standing.', false, 0);
    else calibrateOnFix = false; // useMyLocation refused (insecure context etc.)
  }

  /* Panning by hand pauses auto-centering (tracking continues). */
  function bindPanPausesFollow() {
    function paused() {
      if (following() && autoCenter) {
        autoCenter = false;
        updateFollowUi();
      }
    }
    mv.svg.addEventListener('pointermove', function (e) {
      if (e.buttons) paused();
    });
    mv.svg.addEventListener('wheel', paused);
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
    // hold ⌖ ~0.6s → recalibrate: tap the map where you actually are
    var fabHold = null, fabHeld = false;
    els.fab.addEventListener('pointerdown', function () {
      fabHeld = false;
      fabHold = setTimeout(function () {
        fabHeld = true;
        startRecalibration();
      }, 600);
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) {
      els.fab.addEventListener(ev, function () { clearTimeout(fabHold); });
    });
    els.fab.addEventListener('click', function () {
      if (fabHeld) { fabHeld = false; return; }  // the hold consumed this press
      useMyLocation();
    });
    updateFollowUi();

    // keep the follow button floating just above the directions sheet
    function placeFab() {
      var h = els.sheet.hidden ? 0 : els.sheet.getBoundingClientRect().height;
      els.fab.style.bottom = (h + 16) + 'px';
    }
    if (window.ResizeObserver) new ResizeObserver(placeFab).observe(els.sheet);
    window.addEventListener('resize', placeFab);
    placeFab();
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

    els.start.addEventListener('click', startNavigation);
    els.navExit.addEventListener('click', function () {
      if (navArrived) { clearRoute(); updatePins(); }
      else exitNavigation();
    });

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

  function getDirections(opts) {
    var keepNav = opts && opts.keepNav;
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
        buildNavGeom();
        els.sheet.hidden = false;
        els.start.classList.toggle('hidden', navMode && keepNav);
        if (keepNav && navMode) {
          // reroute mid-navigation: resume progress on the new line
          offRouteCount = 0;
          if (liveDot) updateNavigation(+liveDot.dataset.mx, +liveDot.dataset.my);
        } else {
          els.sheet.classList.remove('collapsed');
          setTopCollapsed(true);  // get the pickers out of the way of the route
          fitToRoute();
        }
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
      route.routes.fastest.nodeIds.join(' ') !==
      route.routes.shortest.nodeIds.join(' ');
  }

  function clearRoute() {
    route = null;
    navGeom = null;
    stepEls = [];
    if (navMode || navArrived) exitNavigation();
    els.start.classList.remove('hidden');
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
        buildNavGeom();
        if (navMode && liveDot) updateNavigation(+liveDot.dataset.mx, +liveDot.dataset.my);
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
    stepEls = [];
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

      // always create the distance slot (live nav updates it in place)
      var dist = document.createElement('span');
      dist.className = 'step-dist';
      dist.textContent = s.distanceMeters > 0 ? fmtDist(s.distanceMeters) : '';
      li.appendChild(dist);

      els.steps.appendChild(li);
      stepEls.push(li);
    });
  }

  /* ---------------- live navigation ---------------- */

  function mpp() { return graph.config.metersPerPixel || 1; }

  /* Precompute cumulative geometry + per-step start distances for the
   * currently selected route. Rebuilt whenever the route/option changes. */
  function buildNavGeom() {
    if (!route) { navGeom = null; return; }
    var r = route.routes[selectedOpt];
    var c = r.coords, cum = [0];
    for (var i = 1; i < c.length; i++) {
      cum[i] = cum[i - 1] + Math.hypot(c[i].x - c[i - 1].x, c[i].y - c[i - 1].y);
    }
    var stepStartPx = r.steps.map(function (s) {
      return cum[Math.min(s.coordIndex || 0, cum.length - 1)];
    });
    navGeom = { coords: c, cumPx: cum, totalPx: cum[cum.length - 1],
                steps: r.steps, stepStartPx: stepStartPx };
  }

  /* Nearest point on the route polyline to (px,py). */
  function projectOnRoute(px, py) {
    if (!navGeom) return null;
    var c = navGeom.coords, best = null;
    for (var i = 0; i < c.length - 1; i++) {
      var ax = c[i].x, ay = c[i].y, dx = c[i + 1].x - ax, dy = c[i + 1].y - ay;
      var L2 = dx * dx + dy * dy;
      var t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
      var qx = ax + t * dx, qy = ay + t * dy, d = Math.hypot(px - qx, py - qy);
      if (!best || d < best.d) {
        best = { d: d, seg: i, x: qx, y: qy, alongPx: navGeom.cumPx[i] + t * Math.sqrt(L2) };
      }
    }
    return best;
  }

  function ptStr(c) { return c.x + ',' + c.y; }

  /* Redraw the selected route split into walked (dim) + ahead (bright). */
  function renderRouteSplit(proj) {
    while (gRoutes.firstChild) gRoutes.removeChild(gRoutes.firstChild);
    if (!route) return;
    var r = route.routes[selectedOpt];
    gRoutes.appendChild(MapView.el('polyline', { points: polylinePoints(r), 'class': 'route-casing' }));
    var head = proj.x + ',' + proj.y;
    var traveled = r.coords.slice(0, proj.seg + 1).map(ptStr).concat([head]).join(' ');
    var ahead = [head].concat(r.coords.slice(proj.seg + 1).map(ptStr)).join(' ');
    gRoutes.appendChild(MapView.el('polyline', { points: traveled, 'class': 'route-traveled' }));
    gRoutes.appendChild(MapView.el('polyline', { points: ahead, 'class': 'route-primary' }));
  }

  function startNavigation() {
    if (!route) return;
    navMode = true;
    navArrived = false;
    offRouteCount = 0;
    buildNavGeom();
    if (!following()) useMyLocation();        // begin GPS tracking
    if (!following()) {                        // GPS blocked/denied — abort nav
      navMode = false;
      return;                                  // useMyLocation already explained why
    }
    els.start.classList.add('hidden');
    els.sheet.classList.add('collapsed');      // give the map room; banner leads
    setTopCollapsed(true);
    // if we already have a fix, paint progress immediately
    if (liveDot) updateNavigation(+liveDot.dataset.mx, +liveDot.dataset.my);
    updateNavUi();
  }

  function exitNavigation() {
    navMode = false;
    navArrived = false;
    els.navBanner.hidden = true;
    els.navBanner.classList.remove('off-route', 'arrived');
    els.start.classList.remove('hidden');
    if (route) { renderRoutes(); renderDetails(); }  // back to static overview
  }

  function updateNavUi() {
    els.start.classList.toggle('hidden', navMode);
  }

  var GLYPH = { arrive: '⚑', 'turn left': '↰', 'turn right': '↱',
                'bear left': '↖', 'bear right': '↗' };
  function glyphFor(text) {
    var t = text.toLowerCase();
    for (var k in GLYPH) if (t.indexOf(k) === 0) return GLYPH[k];
    return '↑';
  }

  /* Called on each GPS fix while navigating: projects the dot, splits the
   * line, advances the step list, updates the maneuver banner, handles
   * arrival, and reroutes if the walker strays off the path. */
  function updateNavigation(px, py) {
    if (!navMode || !route) return;
    if (!navGeom) buildNavGeom();
    var proj = projectOnRoute(px, py);
    if (!proj) return;
    renderRouteSplit(proj);

    var M = mpp();
    var alongM = proj.alongPx * M;
    var totalM = navGeom.totalPx * M;
    var perpM = proj.d * M;
    var remainingM = Math.max(0, totalM - alongM);

    if (remainingM <= 8 || (proj.seg >= navGeom.coords.length - 2 && remainingM <= 15)) {
      showArrived();
      return;
    }

    // current step = last step whose maneuver point we've passed
    var cur = 0;
    for (var i = 0; i < navGeom.steps.length; i++) {
      if (navGeom.stepStartPx[i] * M <= alongM + 0.5) cur = i;
    }
    var nextIdx = Math.min(cur + 1, navGeom.steps.length - 1);
    var distNext = Math.max(0, navGeom.stepStartPx[nextIdx] * M - alongM);

    // maneuver banner shows the NEXT maneuver and the distance to it
    var nextStep = navGeom.steps[nextIdx];
    var offRoute = perpM > 25;
    els.navBanner.hidden = false;
    els.navBanner.classList.toggle('off-route', offRoute);
    els.navBanner.classList.remove('arrived');
    if (offRoute) {
      els.navGlyph.textContent = '⚠';
      els.navDist.textContent = Math.round(perpM) + ' m off route';
      els.navInstr.textContent = 'Head back to the path';
    } else {
      els.navGlyph.textContent = glyphFor(nextStep.text);
      els.navDist.textContent = 'In ' + fmtDist(distNext);
      els.navInstr.textContent = nextStep.text;
    }

    // ETA + remaining in the sheet summary
    var speed = totalM / Math.max(1, route.routes[selectedOpt].timeSeconds); // m/s
    var remainingSec = remainingM / (speed || 1.3);
    els.summary.innerHTML = '';
    els.summary.appendChild(document.createTextNode(fmtTime(remainingSec) + ' · ' + fmtDist(remainingM) + ' left'));
    var small = document.createElement('small');
    small.textContent = 'to ' + endpointName(route.to);
    els.summary.appendChild(small);

    highlightSteps(cur, distNext);

    if (offRoute) {
      offRouteCount++;
      if (offRouteCount >= 3 && Date.now() - lastReroute > 8000) reroute(px, py);
    } else {
      offRouteCount = 0;
    }
  }

  function highlightSteps(cur, distNext) {
    for (var i = 0; i < stepEls.length; i++) {
      var li = stepEls[i];
      if (!li) continue;
      li.classList.toggle('done', i < cur);
      li.classList.toggle('current', i === cur);
      var distEl = li.querySelector('.step-dist');
      if (i === cur && distEl && !li.classList.contains('arrive')) {
        distEl.textContent = fmtDist(distNext);
      } else if (distEl && navGeom.steps[i]) {
        distEl.textContent = navGeom.steps[i].distanceMeters > 0
          ? fmtDist(navGeom.steps[i].distanceMeters) : '';
      }
    }
    if (stepEls[cur] && !els.sheet.classList.contains('collapsed')) {
      stepEls[cur].scrollIntoView({ block: 'nearest' });
    }
  }

  function showArrived() {
    navArrived = true;
    els.navBanner.hidden = false;
    els.navBanner.classList.remove('off-route');
    els.navBanner.classList.add('arrived');
    els.navGlyph.textContent = '⚑';
    els.navDist.textContent = 'Arrived';
    els.navInstr.textContent = endpointName(route.to);
    // full route dim to show it's complete
    while (gRoutes.firstChild) gRoutes.removeChild(gRoutes.firstChild);
    gRoutes.appendChild(MapView.el('polyline', {
      points: polylinePoints(route.routes[selectedOpt]), 'class': 'route-traveled'
    }));
    for (var i = 0; i < stepEls.length; i++) if (stepEls[i]) {
      stepEls[i].classList.add('done');
      stepEls[i].classList.remove('current');
    }
    if (navigator.vibrate) { try { navigator.vibrate(200); } catch (e) {} }
    navMode = false; // stop advancing; banner stays until dismissed
  }

  function reroute(px, py) {
    lastReroute = Date.now();
    offRouteCount = 0;
    showToast('Off route — recalculating from your location…', false, 3000);
    pins.from = { x: Math.round(px), y: Math.round(py) };
    fromIsLocation = true;
    setPinOption(els.from, '⌖ My location');
    updatePins();
    getDirections({ keepNav: true });
  }

  init();
})();
