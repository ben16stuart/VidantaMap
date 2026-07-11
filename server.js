'use strict';

/**
 * server.js — VidantaMap Express app.
 * Serves public/ statically plus the JSON API described in SPEC.md.
 * Graph persisted in data/graph.json (file storage — MVP).
 */

const path = require('path');
const fs = require('fs');
const express = require('express');
const { buildRouteResponse, RoutingError } = require('./lib/routing');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const GRAPH_PATH = path.join(DATA_DIR, 'graph.json');

// ---------------------------------------------------------------------------
// Graph storage
// ---------------------------------------------------------------------------

let graph = loadGraphFromDisk();

function loadGraphFromDisk() {
  return JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf8'));
}

/** Atomic write: temp file in the same directory, then rename over the target. */
function saveGraphToDisk(g) {
  const tmpPath = path.join(
    DATA_DIR,
    `.graph.json.tmp-${process.pid}-${Date.now()}`
  );
  fs.writeFileSync(tmpPath, JSON.stringify(g, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, GRAPH_PATH);
}

/**
 * Validate a candidate graph per SPEC.md.
 * Returns null if valid, or an error message string.
 * Note: unknown pathType is allowed (falls back to boardwalk speed at routing time).
 */
function validateGraph(g) {
  if (!g || typeof g !== 'object' || Array.isArray(g)) return 'graph must be a JSON object';
  if (!g.config || typeof g.config !== 'object' || Array.isArray(g.config)) {
    return 'graph.config must be an object';
  }
  if (!Array.isArray(g.nodes)) return 'graph.nodes must be an array';
  if (!Array.isArray(g.edges)) return 'graph.edges must be an array';

  const ids = new Set();
  for (let i = 0; i < g.nodes.length; i++) {
    const n = g.nodes[i];
    if (!n || typeof n !== 'object') return `nodes[${i}] must be an object`;
    if (typeof n.id !== 'string' || n.id.trim() === '') {
      return `nodes[${i}] must have a non-empty string id`;
    }
    if (ids.has(n.id)) return `duplicate node id: ${n.id}`;
    ids.add(n.id);
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) {
      return `node ${n.id} must have numeric x and y coordinates`;
    }
  }

  for (let i = 0; i < g.edges.length; i++) {
    const e = g.edges[i];
    if (!e || typeof e !== 'object') return `edges[${i}] must be an object`;
    if (!ids.has(e.from)) return `edge ${e.id || i} references missing node: ${e.from}`;
    if (!ids.has(e.to)) return `edge ${e.id || i} references missing node: ${e.to}`;
    if (e.from === e.to) return `edge ${e.id || i} is a self-loop (${e.from})`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/graph', (req, res) => {
  res.json(graph);
});

app.put('/api/graph', (req, res) => {
  const candidate = req.body;
  const error = validateGraph(candidate);
  if (error) return res.status(400).json({ error });
  try {
    saveGraphToDisk(candidate);
    graph = loadGraphFromDisk(); // keep in-memory copy in sync with the file
  } catch (err) {
    return res.status(500).json({ error: `failed to persist graph: ${err.message}` });
  }
  res.json({ ok: true });
});

app.get('/api/route', (req, res) => {
  const { from, to } = req.query;
  if (typeof from !== 'string' || from === '' || typeof to !== 'string' || to === '') {
    return res.status(400).json({ error: 'query parameters "from" and "to" are required' });
  }
  try {
    res.json(buildRouteResponse(graph, from, to));
  } catch (err) {
    if (err instanceof RoutingError) {
      if (err.code === 'bad-node') return res.status(400).json({ error: err.message });
      if (err.code === 'no-route') return res.status(404).json({ error: 'no-route' });
    }
    throw err;
  }
});

// Unknown API routes → JSON 404 (static middleware handles everything else).
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'not-found' });
});

// Error handler: malformed JSON bodies → 400, everything else → 500 JSON.
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'invalid JSON body' });
  }
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

app.listen(PORT, () => {
  console.log(`VidantaMap listening on http://localhost:${PORT}`);
});
