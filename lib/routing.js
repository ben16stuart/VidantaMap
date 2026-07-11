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
    adj.get(e.from).push({ to: e.to, lengthMeters, timeSeconds, pathType: e.pathType });
    adj.get(e.to).push({ to: e.from, lengthMeters, timeSeconds, pathType: e.pathType });
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
    default: return 'the path';
  }
}

const TURN_THRESHOLD = 35; // deg: > 35 → Turn
const BEAR_THRESHOLD = 20; // deg: > 20 and ≤ 35 → Bear; ≤ 20 → straight (merge)

/**
 * Turn-by-turn steps from a node path.
 * - First step: "Head <compass direction> on <path phrase>".
 * - Bearing change > 35° → "Turn left/right"; 20–35° → "Bear left/right";
 *   ≤ 20° → merged into the current step (distances summed).
 * - Last step: "Arrive at <name>" with distanceMeters 0.
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
    let text = `Head ${compassName(bearings[0])} on ${pathPhrase(pathEdges[0].pathType)}`;
    let dist = pathEdges[0].lengthMeters;
    for (let i = 1; i < bearings.length; i++) {
      const delta = bearingDelta(bearings[i - 1], bearings[i]);
      const mag = Math.abs(delta);
      if (mag > BEAR_THRESHOLD) {
        steps.push({ text, distanceMeters: Math.round(dist) });
        const verb = mag > TURN_THRESHOLD ? 'Turn' : 'Bear';
        text = `${verb} ${delta > 0 ? 'right' : 'left'}`;
        dist = pathEdges[i].lengthMeters;
      } else {
        dist += pathEdges[i].lengthMeters;
      }
    }
    steps.push({ text, distanceMeters: Math.round(dist) });
  }

  steps.push({ text: `Arrive at ${arriveName}`, distanceMeters: 0 });
  return steps;
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
  const nodes = nodeMap(graph);
  for (const id of [fromId, toId]) {
    if (!nodes.has(id)) throw new RoutingError('bad-node', `unknown node id: ${id}`);
  }

  const adj = buildAdjacency(graph);
  const shortestPath = dijkstra(graph, fromId, toId, (e) => e.lengthMeters, adj);
  if (!shortestPath) throw new RoutingError('no-route', 'no-route');
  const fastestPath = dijkstra(graph, fromId, toId, (e) => e.timeSeconds, adj);

  return {
    from: fromId,
    to: toId,
    routes: {
      shortest: routeResult(graph, shortestPath, adj),
      fastest: routeResult(graph, fastestPath, adj),
    },
  };
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
};
