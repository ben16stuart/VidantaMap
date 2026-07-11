#!/usr/bin/env node
/**
 * scripts/test-routing.mjs — plain-assert tests for lib/routing.js.
 * No test framework. Exits nonzero on any failure.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const routing = require('../lib/routing.js');
const { buildRouteResponse, RoutingError } = routing;

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const graph = JSON.parse(readFileSync(path.join(root, 'data', 'graph.json'), 'utf8'));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok    ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  ${name}`);
    console.error(`      ${err.message}`);
  }
}

function assertRouteResult(r, from, to, label) {
  assert.ok(Array.isArray(r.nodeIds) && r.nodeIds.length >= 2, `${label}: nodeIds is a non-trivial array`);
  assert.equal(r.nodeIds[0], from, `${label}: path starts at "from"`);
  assert.equal(r.nodeIds[r.nodeIds.length - 1], to, `${label}: path ends at "to"`);
  assert.ok(Array.isArray(r.coords), `${label}: coords is an array`);
  assert.equal(r.coords.length, r.nodeIds.length, `${label}: coords aligned with nodeIds`);
  for (const c of r.coords) {
    assert.ok(Number.isFinite(c.x) && Number.isFinite(c.y), `${label}: coords are numeric`);
  }
  assert.ok(Number.isInteger(r.distanceMeters), `${label}: distanceMeters is a rounded integer`);
  assert.ok(Number.isInteger(r.timeSeconds), `${label}: timeSeconds is a rounded integer`);
  assert.ok(r.distanceMeters > 0, `${label}: distance is positive`);
  assert.ok(r.timeSeconds > 0, `${label}: time is positive`);
  // Plausibility: the map is 1179x1565 px at 0.9 m/px, so any single route
  // should be well under 5 km and at least a few meters.
  assert.ok(r.distanceMeters < 5000, `${label}: distance ${r.distanceMeters}m is plausible (<5km)`);
  assert.ok(r.distanceMeters >= 5, `${label}: distance ${r.distanceMeters}m is plausible (>=5m)`);

  assert.ok(Array.isArray(r.steps) && r.steps.length >= 1, `${label}: has steps`);
  assert.match(r.steps[0].text, /^Head (north|northeast|east|southeast|south|southwest|west|northwest) on /,
    `${label}: first step is a "Head <direction>" step (got "${r.steps[0].text}")`);
  const last = r.steps[r.steps.length - 1];
  assert.match(last.text, /^Arrive at /, `${label}: last step is "Arrive at ..."`);
  assert.equal(last.distanceMeters, 0, `${label}: arrive step distance is 0`);
  for (const s of r.steps) {
    assert.equal(typeof s.text, 'string', `${label}: step text is a string`);
    assert.ok(Number.isInteger(s.distanceMeters) && s.distanceMeters >= 0, `${label}: step distance is a non-negative integer`);
  }
  // Step distances should sum to ~total (each step rounded independently).
  const stepSum = r.steps.reduce((a, s) => a + s.distanceMeters, 0);
  assert.ok(Math.abs(stepSum - r.distanceMeters) <= r.steps.length,
    `${label}: step distances (${stepSum}) sum to ~distanceMeters (${r.distanceMeters})`);
}

const pairs = [
  ['sports', 'tip-pool'],
  ['mayan-palace', 'luxxe-residence'],
  ['grand-bliss', 'beach-club'],
  ['golf-club', 'lagoon-pool'],
  ['kids-pool', 'estates-2'],
];

for (const [from, to] of pairs) {
  test(`route ${from} -> ${to}`, () => {
    const resp = buildRouteResponse(graph, from, to);
    assert.equal(resp.from, from, 'response.from matches request');
    assert.equal(resp.to, to, 'response.to matches request');
    assert.ok(resp.routes && resp.routes.shortest && resp.routes.fastest, 'has routes.shortest and routes.fastest');
    assertRouteResult(resp.routes.shortest, from, to, 'shortest');
    assertRouteResult(resp.routes.fastest, from, to, 'fastest');
    assert.ok(resp.routes.fastest.timeSeconds <= resp.routes.shortest.timeSeconds,
      `fastest time (${resp.routes.fastest.timeSeconds}s) <= shortest-path time (${resp.routes.shortest.timeSeconds}s)`);
    assert.ok(resp.routes.shortest.distanceMeters <= resp.routes.fastest.distanceMeters,
      `shortest distance (${resp.routes.shortest.distanceMeters}m) <= fastest-path distance (${resp.routes.fastest.distanceMeters}m)`);
  });
}

test('routes are symmetric-ish (reverse pair also routes)', () => {
  const resp = buildRouteResponse(graph, 'tip-pool', 'sports');
  assert.equal(resp.routes.shortest.nodeIds[0], 'tip-pool');
  assert.equal(resp.routes.shortest.nodeIds.at(-1), 'sports');
});

test('unknown "from" node id throws bad-node', () => {
  assert.throws(
    () => buildRouteResponse(graph, 'nope-nope', 'tip-pool'),
    (err) => err instanceof RoutingError && err.code === 'bad-node'
  );
});

test('unknown "to" node id throws bad-node', () => {
  assert.throws(
    () => buildRouteResponse(graph, 'sports', 'definitely-missing'),
    (err) => err instanceof RoutingError && err.code === 'bad-node'
  );
});

test('disconnected node yields no-route', () => {
  const g2 = structuredClone(graph);
  g2.nodes.push({ id: 'island', name: 'Isolated Island', type: 'amenity', x: 10, y: 10, destination: true });
  assert.throws(
    () => buildRouteResponse(g2, 'island', 'sports'),
    (err) => err instanceof RoutingError && err.code === 'no-route'
  );
});

test('unknown pathType falls back to boardwalk speed', () => {
  assert.equal(
    routing.walkSpeed(graph.config, 'zipline'),
    graph.config.walkSpeeds.boardwalk
  );
  assert.equal(routing.walkSpeed(graph.config, 'paved'), graph.config.walkSpeeds.paved);
});

test('every destination can reach every other destination (connectivity)', () => {
  const destinations = graph.nodes.filter((n) => n.destination).map((n) => n.id);
  assert.ok(destinations.length >= 2, 'graph has destination nodes');
  const adj = routing.buildAdjacency(graph);
  // BFS from the first destination; all others must be reachable.
  const seen = new Set([destinations[0]]);
  const queue = [destinations[0]];
  while (queue.length) {
    const u = queue.shift();
    for (const e of adj.get(u)) {
      if (!seen.has(e.to)) {
        seen.add(e.to);
        queue.push(e.to);
      }
    }
  }
  const unreachable = destinations.filter((d) => !seen.has(d));
  assert.deepEqual(unreachable, [], `unreachable destinations: ${unreachable.join(', ')}`);
});

test('turn steps use Turn/Bear left/right vocabulary only', () => {
  for (const [from, to] of pairs) {
    const resp = buildRouteResponse(graph, from, to);
    for (const route of [resp.routes.shortest, resp.routes.fastest]) {
      for (let i = 1; i < route.steps.length - 1; i++) {
        assert.match(route.steps[i].text, /^(Turn|Bear) (left|right)$/,
          `middle step "${route.steps[i].text}" (${from}->${to})`);
      }
    }
  }
});

test('dropped pin snaps to nearest path and routes', () => {
  // a point off in the grass west of the center paths
  const resp = buildRouteResponse(graph, '350,700', 'spa');
  assert.equal(resp.from, '350,700');
  assert.deepEqual(resp.pins.from, { x: 350, y: 700 });
  for (const route of [resp.routes.shortest, resp.routes.fastest]) {
    // route starts at the raw pin point and walks a connector to the path
    assert.deepEqual(route.coords[0], { x: 350, y: 700 });
    assert.ok(route.distanceMeters > 0);
    assert.match(route.steps[0].text, /^Head \w+ on the nearest path$/);
    assert.equal(route.steps.at(-1).text, 'Arrive at Spa & Wellness Center');
  }
});

test('pin-to-pin routing works, including both pins near the same segment', () => {
  const resp = buildRouteResponse(graph, '440,630', '480,650');
  assert.ok(resp.routes.shortest.distanceMeters > 0);
  assert.ok(resp.routes.shortest.distanceMeters < 150, 'nearby pins should be a short walk');
  assert.equal(resp.routes.shortest.steps.at(-1).text, 'Arrive at Dropped pin');
});

test('pin routing leaves the stored graph unmodified', () => {
  const nodesBefore = graph.nodes.length;
  const edgesBefore = graph.edges.length;
  buildRouteResponse(graph, '350,700', '700,1200');
  assert.equal(graph.nodes.length, nodesBefore);
  assert.equal(graph.edges.length, edgesBefore);
  assert.ok(!graph.nodes.some((n) => String(n.id).startsWith('__pin')));
});

test('bearing math sanity', () => {
  // Screen coords: +x = east, +y = south (y grows downward).
  assert.equal(routing.bearing({ x: 0, y: 0 }, { x: 0, y: -10 }), 0);   // north
  assert.equal(routing.bearing({ x: 0, y: 0 }, { x: 10, y: 0 }), 90);   // east
  assert.equal(routing.bearing({ x: 0, y: 0 }, { x: 0, y: 10 }), 180);  // south
  assert.equal(routing.bearing({ x: 0, y: 0 }, { x: -10, y: 0 }), 270); // west
  assert.equal(routing.compassName(225), 'southwest');
  assert.equal(routing.bearingDelta(350, 10), 20);   // right
  assert.equal(routing.bearingDelta(10, 350), -20);  // left
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
