# VidantaMap

Walking-directions MVP for the Vidanta resort. The property is a huge complex of
boardwalks and paths that Google Maps can't route on — this app routes on the
**resort's own path network**, Google-Maps-style: pick where you are and where
you're going, get the **fastest** and **shortest** walking route with
turn-by-turn steps, distance, and estimated time.

## Quick start

```bash
npm install
npm start
```

- Guest app: **http://localhost:3000** — pick From/To, tap two places, long-press
  to drop a pin anywhere, or start from your GPS position with "⌖ Use my
  current location" (requires HTTPS or localhost, and GPS calibration in
  `data/graph.json` → `config.geo`; see SPEC.md).
- Admin editor: **http://localhost:3000/admin.html** — move locations, add/rename
  locations, add junctions, draw/delete path segments, and save. Routing uses
  the updated network immediately.

## Try it on a phone (HTTPS, GPS-capable)

`docs/index.html` is a self-contained serverless build of the guest app
(rebuild with `node scripts/build-static-demo.mjs --image public/img/resort-map-demo.jpg --out docs/index.html`).
Enable GitHub Pages (repo **Settings → Pages → Deploy from a branch**, pick this
branch and the `/docs` folder) and GitHub serves it at
`https://<user>.github.io/VidantaMap/` — a top-level HTTPS page, so the
"⌖ Use my current location" button can actually prompt for GPS on iPhone.
Note the page is public to anyone with the URL, and it's a snapshot: rebuild
and push after editing the graph. Embedded demo frames and plain-HTTP LAN
addresses block browser GPS by design; the app explains this and falls back
to press-and-hold pin placement.

## How it works

- The resort map image is the base layer; every location and path junction is a
  node with pixel coordinates on that image, and every walkable path segment is
  an edge (`data/graph.json`).
- Routing is Dijkstra over that graph. *Shortest* minimizes distance; *fastest*
  minimizes time using per-path-type walking speeds (paved > boardwalk > trail >
  stairs), so a slightly longer paved route can beat a slow garden trail.
- Distances use a `metersPerPixel` calibration in `data/graph.json` → `config`.

## Admin data notes

The seed graph was digitized from the current resort map screenshot — node
positions and names are best-effort approximations. Use the admin editor to
correct names, drag nodes onto their true positions, and refine the path
network; changes persist to `data/graph.json`.

## Tests

```bash
npm test   # routing engine + graph connectivity checks
```

See `SPEC.md` for the full data model and API contract.
