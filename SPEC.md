# VidantaMap — Resort Path Navigation MVP

A localhost web app that gives Google-Maps-style walking directions across the
resort's own boardwalk/path network (which Google Maps cannot route on), plus an
admin editor so staff can update locations and paths when they change.

## Running

```
npm install
npm start          # → http://localhost:3000  (guest app)
                   # → http://localhost:3000/admin.html  (admin editor)
```

## Architecture

- **Server**: Node 22 + Express (`server.js`). Serves `public/` statically and a
  small JSON API. Graph data persisted to `data/graph.json` (file storage — MVP).
- **Routing**: `lib/routing.js` — Dijkstra over the path graph. Two weightings:
  - `shortest`: minimize distance (meters).
  - `fastest`: minimize time; edge time = length / walkSpeed(pathType).
- **Guest UI**: `public/index.html` + `public/js/app.js` + `public/css/app.css`.
- **Admin UI**: `public/admin.html` + `public/js/admin.js` + `public/css/admin.css`.
- **Shared map component**: `public/js/mapview.js` (pan/zoom SVG over the resort
  map image; already written — see API below).

## Data model — `data/graph.json`

```jsonc
{
  "config": {
    "mapImage": "/img/resort-map.png",
    "width": 1179,            // map image px
    "height": 1565,
    "metersPerPixel": 0.9,    // converts px distance → meters
    "walkSpeeds": {           // meters/second by pathType
      "boardwalk": 1.4,
      "paved": 1.5,
      "trail": 1.0,
      "stairs": 0.6
    }
  },
  "nodes": [
    // destination=true → selectable as origin/destination in guest UI
    { "id": "grand-bliss", "name": "The Grand Bliss", "type": "hotel",
      "x": 605, "y": 448, "destination": true },
    // junctions are path intersections, not shown as destinations
    { "id": "j06", "name": "", "type": "junction", "x": 525, "y": 610,
      "destination": false }
  ],
  "edges": [
    // undirected; length derived from node coords × metersPerPixel
    { "id": "e-j06-grand-luxxe-1", "from": "j06", "to": "grand-luxxe-1",
      "pathType": "boardwalk" }
  ]
}
```

Node `type` ∈ `hotel | restaurant | bar | pool | amenity | junction` (open set;
render unknown types like `amenity`).

`config.geo` (optional) calibrates GPS → map pixels for "use my location":
`{ "topLeft": {lat, lng}, "bottomRight": {lat, lng} }` — the lat/lng of the two
map-image corners, assuming a north-up map. Linear interpolation is accurate
enough at resort scale.

**Tap-to-calibrate (guest app):** when a GPS fix lands off the map, the app
asks the user to tap the map where they actually are; when it lands in-bounds
the user has ~15 s to tap the true spot on empty map; and **holding the ⌖
button ~0.6 s starts recalibration at any time**. One anchor point plus
`metersPerPixel` and the north-up assumption fully determine both corners.
Calibration solves a **similarity transform** (position + rotation + uniform
scale) mapping GPS→pixels, stored as `config.geo = { ref:{lat,lng}, c, d, tx,
ty }` where `pixel = [[c,-d],[d,c]]·metersFromRef + [tx,ty]`. One anchor gives
position only (nominal scale, north-up). **A second anchor far from the first
solves rotation and scale** — essential here because the resort map is drawn
at an angle, so a north-up model always drifted no matter how it was shifted.
Implausible solves (scale >3× or <1/3 of nominal) fall back to the 1-point fit
so a bad tap can't wreck the mapping; the farthest-apart pair of anchors is
kept. Legacy corner-format `geo` (`topLeft`/`bottomRight`) is still read.
Results persist to the device (`localStorage`, overriding shipped values) and
PUT back to `/api/graph` when the server is reachable. The live dot shows a
translucent GPS-accuracy circle sized in real map meters.

## API contract

- `GET /api/graph` → the full graph JSON (as above).
- `PUT /api/graph` (body = full graph JSON) → validates & atomically replaces
  `data/graph.json`. Validation: unique non-empty node ids; every edge endpoint
  exists; no self-loop edges; numeric coords; known-or-defaulted pathType
  (unknown pathType falls back to `boardwalk` speed at routing time, do not
  reject). On success `{ ok: true }`; on failure HTTP 400 `{ error: "..." }`.
- `GET /api/route?from=<endpoint>&to=<endpoint>` → both route options. An
  endpoint is a node id **or** raw map coordinates in `x,y` form (a dropped
  pin). Coordinate endpoints are snapped to the closest point on the closest
  path segment; the walk from the pin to the path is included in the route
  (steps say "Head … on the nearest path", arrival at a pin says "Arrive at
  Dropped pin"). When any endpoint is a pin the response also carries
  `"pins": { "from"?: {x, y}, "to"?: {x, y} }` echoing the raw points. The
  stored graph is never modified by pin routing.

```jsonc
{
  "from": "grand-bliss", "to": "beach-club",
  "routes": {
    "shortest": { /* RouteResult */ },
    "fastest":  { /* RouteResult */ }   // may be identical path to shortest
  }
}
```

`RouteResult`:

```jsonc
{
  "nodeIds": ["grand-bliss", "j05", "..."],
  "coords": [{ "x": 605, "y": 448 }, ...],   // same order as nodeIds
  "distanceMeters": 412,                      // rounded
  "timeSeconds": 300,                         // rounded
  "steps": [                                  // turn-by-turn
    { "text": "Head southwest on the boardwalk", "distanceMeters": 80 },
    { "text": "Turn left", "distanceMeters": 120 },
    { "text": "Arrive at Beach Club & Ocean Pool", "distanceMeters": 0 }
  ]
}
```

Steps are generated from geometry: compass bearing of the first segment
("Head <direction>…"), then a step at each significant bearing change
(> 35° → "Turn left/right", 20–35° → "Bear left/right"), merging straight
segments and summing their distance, ending with "Arrive at <name>". Maneuvers
whose leg is shorter than 12 m are folded into the previous step so traced
path jitter doesn't produce a flood of micro-turns. Each step carries
`coordIndex` — the vertex in `coords` where its maneuver occurs — used by live
navigation to know the current step and distance to the next turn.

## Transit (gondola & shuttle)

Nodes of type `station` (destination: true) are boarding points. Edges of
pathType `gondola`/`shuttle` are ridden, not walked: only the **fastest**
weighting may use them (shortest stays a pure walking route), speeds come from
`config.walkSpeeds` (both 5 m/s ≈ average incl. stops), steps render as
"Ride the shuttle/gondola to <stop>" (consecutive transit hops merge into one
ride step, flagged `transit` in the API), and the guest UI draws ridden legs
as a dashed overlay (amber = shuttle, pink = gondola). The gondola is one
straight edge between its two stations (a cable car flies straight); shuttle
legs are chains of via-nodes traced along the road network, connected to the
walking graph only at stations so you can only board at a stop.

## Live navigation (guest UI)

Pressing **Start** on a fetched route enters turn-by-turn mode (requires GPS
follow-me). On each GPS fix the app projects the live position onto the route
polyline and: splits the line into a dimmed walked portion and a bright
remaining portion; advances the step list (completed steps greyed, current
step highlighted with live distance-to-next-turn); shows a maneuver banner
(next turn glyph + "In N m" + instruction); and updates remaining time/distance
in the sheet. Straying >25 m off the path shows an off-route banner and
auto-reroutes from the current location (throttled). Reaching the end shows an
"Arrived" banner. **Exit** returns to the static route overview.
Errors: unknown node id → 400; no path exists → 404 `{ error: "no-route" }`.

- `GET /api/health` → `{ ok: true }`.

## Shared MapView component — `public/js/mapview.js`

```js
const mv = new MapView(containerElement, config /* graph.config */);
mv.overlay          // <g> SVG group in MAP coordinates — draw routes/markers here
mv.svg              // the root <svg>
mv.scale            // current zoom scale (map px → screen px multiplier)
mv.onClick(fn)      // fn({x, y, event}) in map coords; NOT fired after a pan/drag
mv.onViewChanged(fn)// fired after pan/zoom — use to keep marker sizes constant
mv.zoomTo(x, y, targetScale?)  // animate-ish center on a map point
mv.fitAll()         // reset view to whole map
MapView.el(tag, attrs) // static helper: create namespaced SVG element
```

Pan = mouse drag / one-finger drag. Zoom = wheel / pinch. Markers you add to
`mv.overlay` are in map coordinates; divide sizes by `mv.scale` on
`onViewChanged` if you want constant on-screen size. Strokes can use
`vector-effect="non-scaling-stroke"`.

## Guest UI requirements (`index.html`)

- Full-screen map. Top card with **From** / **To** selectors (searchable
  `<select>` or filtered list of `destination:true` nodes, grouped by type),
  a swap button, and a **Directions** button. The card is minimizable: a ▴
  button collapses it to a one-line "From → To" bar (tap to re-expand), and it
  auto-collapses when a route is fetched so the map and route fill the screen;
  the bottom sheet's grabber independently collapses the step list.
- Draws both routes on the map: **fastest** highlighted (primary color),
  **shortest** as alternate (dashed/秒 secondary) when its path differs. Toggle
  between them by clicking the route summary chips.
- Bottom sheet/panel: distance, estimated walking time (e.g. "6 min · 420 m"),
  and the turn-by-turn steps list for the selected option.
- Start/end markers (green/red pin dots). Route should auto-fit in view.
- Follow-me mode (card button + floating ⌖ FAB): `watchPosition` live
  tracking (secure context required). The Google-style blue dot moves with
  every fix; the map recenters on it at most every 4 s. Panning by hand
  pauses auto-centering (tracking continues); tapping ⌖ again re-centers,
  and tapping while centered stops tracking. The first fix sets From to
  "My location" (if unset) and auto-routes when To is chosen. Out-of-bounds
  fixes trigger the tap-to-calibrate flow instead of a dot.
- Dropped pins: long-press (hold ~0.5 s) anywhere on the map to drop a pin —
  first pin (or a fresh start) becomes From, the next becomes To and routes
  immediately, mirroring the tap-a-dot flow. A dropped pin appears as a
  "📍 Dropped pin" option in the matching select; picking a real place
  discards it.
- Mobile-friendly (this replaces a phone app): touch pan/pinch works, layout
  usable at 390px wide.

## Admin UI requirements (`admin.html`)

- Loads graph, renders ALL nodes (junctions included) + edges over the map.
- Modes (toolbar): **Select/Move** (drag nodes to reposition), **Add Location**
  (click map → prompt name/type → destination node), **Add Junction** (click →
  junction node), **Draw Path** (click node A then node B → edge; choose
  pathType from a small selector), **Delete** (click node/edge to remove;
  deleting a node removes its edges).
- Side panel shows selected node's properties (id read-only, name, type,
  destination checkbox) editable.
- **Save** button → `PUT /api/graph`; show success/error. **Reload** discards
  local changes. Warn on leaving with unsaved changes.
- Edge pathType shown by stroke color + legend.

## File ownership (build phase)

- Scaffold (done): `SPEC.md`, `package.json`, `data/graph.json`,
  `public/img/resort-map.png`, `public/js/mapview.js`.
- Backend agent: `server.js`, `lib/routing.js`, `scripts/test-routing.mjs`.
- Guest UI agent: `public/index.html`, `public/js/app.js`, `public/css/app.css`.
- Admin agent: `public/admin.html`, `public/js/admin.js`, `public/css/admin.css`.
