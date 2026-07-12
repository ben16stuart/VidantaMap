'use strict';

/**
 * lib/routing.js — pure routing logic for VidantaMap.
 *
 * Dijkstra over the undirected path graph with two weightings:
 *   - shortest: minimize distance (meters)
 *   - fastest:  minimize time (seconds), edge time = length / walkSpeed(pathType)
 *
 * No I/O here; the graph object is passed in.
 */

const DEFAULT_SPEED_KEY = 'boardwalk';
const DEFAULT_SPEED = 1.4; // m/s, last-resort fallback

/** Error with a machine-readable code: 'bad-node' | 'no-route'. */
class RoutingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RoutingError';
    this.code = code;
  }
}

/** Walking speed (m/s) for a pathType; unknown types fall back to boardwalk speed. */
function walkSpeed(config, pathType) {
  const speeds = (config && config.walkSpeeds) || {};
  const s = speeds[pathType];
  if (typeof s === 'number' && s > 0) return s;
  const fallback = speeds[DEFAULT_SPEED_KEY];
  return typeof fallback === 'number' && fallback > 0 ? fallback : DEFAULT_SPEED;
}

/* Routing weight multiplier per pathType. Paved segments are cart roads —
 * pedestrians may cross them or use short stints near buildings, but any
 * boardwalk alternative should win, so traveling along them costs ×4 by
 * default. Reported distances/times stay real; only route CHOICE is biased.
 * Override via config.routePenalties, e.g. { "paved": 4 }. */
const DEFAULT_PENALTIES = { paved: 4 };

function routePenalty(config, pathType) {
  const penalties = (config && config.routePenalties) || DEFAULT_PENALTIES;
  const p = penalties[pathType];
  return typeof p === 'number' && p > 0 ? p : 1;
}

/** Euclidean length of an edge in meters (px distance × metersPerPixel). */
function edgeLengthMeters(config, a, b) {
  const mpp =
    config && typeof config.metersPerPixel === 'number' && config.metersPerPixel > 0
      ? config.metersPerPixel
      : 1;
  return Math.hypot(b.x - a.x, b.y - a.y) * mpp;
}

/** Map of nodeId → node. */
function nodeMap(graph) {
  const m = new Map();
  for (const n of graph.nodes) m.set(n.id, n);
  return m;
}

/**
 * Adjacency list: nodeId → [{ to, lengthMeters, timeSeconds, pathType }].
 * Edges are undirected, so each edge appears in both directions.
 */
function buildAdjacency(graph) {
  const nodes = nodeMap(graph);
  const adj = new Map();
  for (const id of nodes.keys()) adj.set(id, []);
  for (const e of graph.edges) {
    const a = nodes.get(e.from);
    const b = nodes.get(e.to);
    if (!a || !b || a === b) continue; // defensive; validated at PUT time
    const lengthMeters = edgeLengthMeters(graph.config, a, b);
    const timeSeconds = lengthMeters / walkSpeed(graph.config, e.pathType);
    const penalty = routePenalty(graph.config, e.pathType);
    adj.get(e.from).push({ to: e.to, lengthMeters, timeSeconds, penalty, pathType: e.pathType });
    adj.get(e.to).push({ to: e.from, lengthMeters, timeSeconds, penalty, pathType: e.pathType });
  }
  return adj;
}

/**
 * Dijkstra shortest path by an arbitrary edge weight.
 * weightOf(edgeEntry) → non-negative number.
 * Returns array of nodeIds from fromId to toId, or null if unreachable.
 */
function dijkstra(graph, fromId, toId, weightOf, adj) {
  adj = adj || buildAdjacency(graph);
  const dist = new Map();
  const prev = new Map();
  const visited = new Set();
  dist.set(fromId, 0);

  // Graph is small (tens of nodes); a linear-scan "priority queue" is fine.
  while (true) {
    let u = null;
    let best = Infinity;
    for (const [id, d] of dist) {
      if (!visited.has(id) && d < best) {
        best = d;
        u = id;
      }
    }
    if (u === null) return null; // frontier empty, target unreachable
    if (u === toId) break;
    visited.add(u);
    for (const edge of adj.get(u) || []) {
      if (visited.has(edge.to)) continue;
      const nd = best + weightOf(edge);
      if (nd < (dist.has(edge.to) ? dist.get(edge.to) : Infinity)) {
        dist.set(edge.to, nd);
        prev.set(edge.to, u);
      }
    }
  }

  const path = [toId];
  while (path[0] !== fromId) path.unshift(prev.get(path[0]));
  return path;
}

/** Compass bearing of segment a→b in degrees [0, 360). North = up (−y on screen). */
function bearing(a, b) {
  const deg = (Math.atan2(b.x - a.x, -(b.y - a.y)) * 180) / Math.PI;
  return (deg + 360) % 360;
}

const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];

/** 8-point compass name for a bearing. */
function compassName(deg) {
  return COMPASS[Math.round(deg / 45) % 8];
}

/** Signed smallest angle from bearing b1 to b2, in (−180, 180]. Positive = right turn. */
function bearingDelta(b1, b2) {
  return ((b2 - b1 + 540) % 360) - 180;
}

/** Human phrase for a pathType, used in the initial "Head …" step. */
function pathPhrase(pathType) {
  switch (pathType) {
    case 'boardwalk': return 'the boardwalk';
    case 'paved': return 'the paved path';
    case 'trail': return 'the trail';
    case 'stairs': return 'the stairs';
    case 'connector': return 'the nearest path'; // dropped-pin → path link
    default: return 'the path';
  }
}

/* Transit modes: ridden, not walked. Only the fastest weighting may use them
 * (shortest = pure walking route); steps say "Ride the … to <stop>". */
const TRANSIT = { gondola: 'the gondola', shuttle: 'the shuttle' };
function isTransit(pathType) { return Object.prototype.hasOwnProperty.call(TRANSIT, pathType); }

/* ---------------- dropped-pin support ----------------
 * A route endpoint may be raw map coordinates ("x,y") instead of a node id.
 * The point is snapped to the closest position on the closest path segment;
 * that segment is split by a virtual node, and (if the pin is off the path)
 * a short "connector" edge links the pin itself to the snapped point, so the
 * walk from the pin to the path is included in distance/time/steps.
 */

/** Parse "x,y" coordinate endpoint form → {x, y}, or null if not that form. */
function parsePin(value) {
  const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(String(value).trim());
  if (!m) return null;
  return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
}

/** Closest point on segment ab to p, plus its parameter t along ab. */
function projectOnSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return { x: a.x + t * dx, y: a.y + t * dy, t };
}

/** Nearest point on any edge of the graph to p → { edge, point } or null. */
function snapToPath(graph, p) {
  const nodes = nodeMap(graph);
  let best = null;
  let bestDist = Infinity;
  for (const e of graph.edges) {
    const a = nodes.get(e.from);
    const b = nodes.get(e.to);
    if (!a || !b) continue;
    const q = projectOnSegment(p, a, b);
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < bestDist) {
      bestDist = d;
      best = { edge: e, point: { x: q.x, y: q.y } };
    }
  }
  return best;
}

/**
 * Mutates graph copy g: snaps pin point p onto the nearest path segment,
 * splits that segment with a virtual node, and (when the pin is off-path)
 * adds a pin node + connector edge. Returns the routing endpoint node id.
 * Virtual ids start with "__pin" so they can never collide with real ids
 * (admin-created ids are slugs/j-numbers).
 */
function insertPin(g, key, p) {
  const snap = snapToPath(g, p);
  if (!snap) throw new RoutingError('no-route', 'no paths to snap to');

  const snapId = `__pin_${key}_snap`;
  g.nodes.push({ id: snapId, name: 'Dropped pin', type: 'junction', x: snap.point.x, y: snap.point.y, destination: false });

  // replace the snapped edge with its two halves
  g.edges = g.edges.filter((e) => e !== snap.edge);
  g.edges.push(
    { id: `${snap.edge.id}__${key}a`, from: snap.edge.from, to: snapId, pathType: snap.edge.pathType },
    { id: `${snap.edge.id}__${key}b`, from: snapId, to: snap.edge.to, pathType: snap.edge.pathType }
  );

  // pin more than ~2 px off the path → walk a connector from the pin itself
  if (Math.hypot(snap.point.x - p.x, snap.point.y - p.y) > 2) {
    const pinId = `__pin_${key}`;
    g.nodes.push({ id: pinId, name: 'Dropped pin', type: 'pin', x: p.x, y: p.y, destination: false });
    g.edges.push({ id: `${pinId}_link`, from: pinId, to: snapId, pathType: 'connector' });
    return pinId;
  }
  return snapId;
}

const TURN_THRESHOLD = 35; // deg: > 35 → Turn
const BEAR_THRESHOLD = 20; // deg: > 20 and ≤ 35 → Bear; ≤ 20 → straight (merge)

/**
 * Turn-by-turn steps from a node path.
 * - First step: "Head <compass direction> on <path phrase>".
 * - Bearing change > 35° → "Turn left/right"; 20–35° → "Bear left/right";
 *   ≤ 20° → merged into the current step (distances summed).
 * - Last step: "Arrive at <name>" with distanceMeters 0.
 * Each step carries `coordIndex`: the vertex in `coords` where its maneuver
 * is performed (its leg begins). Live navigation uses this to know which
 * step is current and how far to the next turn.
 */
function buildSteps(graph, pathNodes, pathEdges) {
  const destNode = pathNodes[pathNodes.length - 1];
  const arriveName = destNode.name || destNode.id;
  const steps = [];

  if (pathNodes.length >= 2) {
    const bearings = [];
    for (let i = 0; i < pathNodes.length - 1; i++) {
      bearings.push(bearing(pathNodes[i], pathNodes[i + 1]));
    }
    let text = null;
    let dist = 0;
    let startIdx = 0;
    const flush = () => {
      if (text !== null) steps.push({ text, distanceMeters: Math.round(dist), coordIndex: startIdx });
      text = null; dist = 0;
    };
    for (let i = 0; i < bearings.length; i++) {
      const type = pathEdges[i].pathType;
      if (isTransit(type)) {
        // consecutive transit hops of the same mode collapse into one ride
        flush();
        let j = i, rideDist = 0;
        while (j < bearings.length && pathEdges[j].pathType === type) {
          rideDist += pathEdges[j].lengthMeters; j++;
        }
        const stop = pathNodes[j];
        steps.push({
          text: `Ride ${TRANSIT[type]} to ${stop.name || 'the next stop'}`,
          distanceMeters: Math.round(rideDist),
          coordIndex: i,
          transit: type,
        });
        i = j - 1;
        startIdx = j;
        continue;
      }
      if (text === null) {
        text = `Head ${compassName(bearings[i])} on ${pathPhrase(type)}`;
        dist = pathEdges[i].lengthMeters;
        startIdx = i;
        continue;
      }
      const delta = bearingDelta(bearings[i - 1], bearings[i]);
      const mag = Math.abs(delta);
      if (mag > BEAR_THRESHOLD) {
        flush();
        const verb = mag > TURN_THRESHOLD ? 'Turn' : 'Bear';
        text = `${verb} ${delta > 0 ? 'right' : 'left'}`;
        dist = pathEdges[i].lengthMeters;
        startIdx = i;
      } else {
        dist += pathEdges[i].lengthMeters;
      }
    }
    flush();
  }

  steps.push({ text: `Arrive at ${arriveName}`, distanceMeters: 0, coordIndex: pathNodes.length - 1 });

  // Traced paths wiggle, producing many trivial maneuvers. Fold any turn whose
  // leg is shorter than MERGE_MIN meters into the previous step (keeping that
  // step's instruction and coordIndex, summing distance) so the guidance reads
  // like a handful of real turns rather than constant micro-adjustments.
  const MERGE_MIN = 12;
  const merged = [];
  for (const s of steps) {
    const isArrive = s.coordIndex === pathNodes.length - 1 && s.distanceMeters === 0;
    const prev = merged[merged.length - 1];
    // never merge transit steps, and never fold a walk step into a ride
    if (prev && !prev.transit && !s.transit && !isArrive && s.distanceMeters < MERGE_MIN) {
      prev.distanceMeters += s.distanceMeters;
    } else {
      merged.push(s);
    }
  }
  return merged;
}

/** Build a RouteResult (spec schema) from a node-id path. */
function routeResult(graph, nodeIds, adj) {
  const nodes = nodeMap(graph);
  const pathNodes = nodeIds.map((id) => nodes.get(id));

  // Resolve the traversed edge entries (for length/time/pathType per hop).
  const pathEdges = [];
  let distanceMeters = 0;
  let timeSeconds = 0;
  for (let i = 0; i < nodeIds.length - 1; i++) {
    const entries = adj.get(nodeIds[i]) || [];
    // If multiple parallel edges exist, take the cheapest by time (matches Dijkstra's preference).
    let bestEdge = null;
    for (const e of entries) {
      if (e.to === nodeIds[i + 1] && (!bestEdge || e.timeSeconds < bestEdge.timeSeconds)) {
        bestEdge = e;
      }
    }
    pathEdges.push(bestEdge);
    distanceMeters += bestEdge.lengthMeters;
    timeSeconds += bestEdge.timeSeconds;
  }

  return {
    nodeIds: nodeIds.slice(),
    coords: pathNodes.map((n) => ({ x: n.x, y: n.y })),
    distanceMeters: Math.round(distanceMeters),
    timeSeconds: Math.round(timeSeconds),
    steps: buildSteps(graph, pathNodes, pathEdges),
  };
}

/**
 * Full /api/route response body:
 *   { from, to, routes: { shortest: RouteResult, fastest: RouteResult } }
 * Throws RoutingError('bad-node') for unknown ids,
 * RoutingError('no-route') when no path exists.
 */
function buildRouteResponse(graph, fromId, toId) {
  const fromPin = parsePin(fromId);
  const toPin = parsePin(toId);

  // Dropped-pin endpoints route over a copy of the graph augmented with
  // virtual nodes; the stored graph is never mutated.
  let g = graph;
  const pins = {};
  let from = fromId;
  let to = toId;
  if (fromPin || toPin) {
    g = { config: graph.config, nodes: graph.nodes.slice(), edges: graph.edges.slice() };
    // Insert sequentially so a second pin can snap onto a half produced by
    // splitting for the first (both pins on the same original segment).
    if (fromPin) {
      from = insertPin(g, 'from', fromPin);
      pins.from = fromPin;
    }
    if (toPin) {
      to = insertPin(g, 'to', toPin);
      pins.to = toPin;
    }
  }

  const nodes = nodeMap(g);
  for (const id of [from, to]) {
    if (!nodes.has(id)) throw new RoutingError('bad-node', `unknown node id: ${id}`);
  }
  if (from === to) throw new RoutingError('bad-node', 'from and to are the same point');

  const adj = buildAdjacency(g);
  // shortest = pure walking route: transit is effectively forbidden (only used
  // when no walking path exists at all); fastest may ride transit when quicker.
  const shortestPath = dijkstra(g, from, to,
    (e) => e.lengthMeters * e.penalty * (isTransit(e.pathType) ? 1000 : 1), adj);
  if (!shortestPath) throw new RoutingError('no-route', 'no-route');
  const fastestPath = dijkstra(g, from, to, (e) => e.timeSeconds * e.penalty, adj);

  const resp = {
    from: fromId,
    to: toId,
    routes: {
      shortest: routeResult(g, shortestPath, adj),
      fastest: routeResult(g, fastestPath, adj),
    },
  };
  if (fromPin || toPin) resp.pins = pins;
  return resp;
}

module.exports = {
  buildRouteResponse,
  RoutingError,
  // internals exported for testing/reuse
  dijkstra,
  buildAdjacency,
  walkSpeed,
  edgeLengthMeters,
  bearing,
  bearingDelta,
  compassName,
  buildSteps,
  parsePin,
  snapToPath,
  routePenalty,
  isTransit,
};
