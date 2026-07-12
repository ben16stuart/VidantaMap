/* Geometry-only refinement: bend straight graph edges back onto the walkway.
 *
 * Route lines are straight chords between graph nodes, so where the real
 * boardwalk curves, a chord can cut across grass. This pass walks each edge,
 * and wherever the midpoint of a span lies OFF the walkable mask, inserts a
 * via-node at the nearest walkable pixel — pulling the drawn line onto the
 * path. It never adds or removes connections (same nodes stay connected, same
 * route choices), so it cannot regress routing; it only refines how the line
 * is drawn. Idempotent-ish: re-running further tightens remaining chords.
 *
 * Usage: node scripts/refine-paths.mjs           (refines data/graph.json)
 *        WALKMASK=/path/to/walkmask.json node scripts/refine-paths.mjs
 * The walk mask is a flat 0/1 array (row-major, width×height) of walkable px.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const GRAPH = resolve(root, 'data/graph.json');
const MASK = process.env.WALKMASK ||
  '/tmp/claude-0/-home-user-VidantaMap/a5aff856-b1bf-552e-9acc-f4882bad4252/scratchpad/walkmask.json';

const g = JSON.parse(readFileSync(GRAPH, 'utf8'));
const mask = JSON.parse(readFileSync(MASK, 'utf8'));
const W = g.config.width, H = g.config.height;
const walk = (x, y) => { x = Math.round(x); y = Math.round(y); return x >= 0 && x < W && y >= 0 && y < H && mask[y * W + x] === 1; };

const nodes = new Map(g.nodes.map((n) => [n.id, n]));
let viaSeq = 0;
const nextVia = () => 'v' + String(++viaSeq).padStart(4, '0');

/* Nearest walkable pixel to (x,y) within radius R (spiral search). */
function nearestWalk(x, y, R) {
  x = Math.round(x); y = Math.round(y);
  if (walk(x, y)) return { x, y };
  for (let r = 1; r <= R; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (walk(x + dx, y + dy)) return { x: x + dx, y: y + dy };
      }
    }
  }
  return null;
}

/* Fraction of a segment lying off the walkway (endpoints skipped — nodes may
 * legitimately sit on decks). */
function offFrac(a, b) {
  const n = Math.max(2, Math.round(Math.hypot(b.x - a.x, b.y - a.y)));
  let off = 0, tot = 0;
  for (let k = 0; k <= n; k++) {
    const t = k / n; if (t * n < 3 || (1 - t) * n < 3) continue;
    tot++; if (!walk(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) off++;
  }
  return tot ? off / tot : 0;
}

const MIN_LEN = 14;     // don't subdivide already-short edges
const OFF_TRIGGER = 0.35; // refine a span only if this fraction is off-path
const SEARCH_R = 11;    // how far to look for the walkway (px)

/* One refinement pass: returns number of via-nodes inserted. */
function pass() {
  const newEdges = [];
  let inserted = 0;
  for (const e of g.edges) {
    const a = nodes.get(e.from), b = nodes.get(e.to);
    if (!a || !b) { newEdges.push(e); continue; }
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < MIN_LEN || offFrac(a, b) < OFF_TRIGGER) { newEdges.push(e); continue; }
    // try to bend at the midpoint toward the walkway
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const snap = nearestWalk(mid.x, mid.y, SEARCH_R);
    if (!snap || (Math.hypot(snap.x - mid.x, snap.y - mid.y) < 1.5)) { newEdges.push(e); continue; }
    // only accept if the two halves are collectively less off-path than the chord
    const before = offFrac(a, b);
    const afterA = offFrac(a, snap), afterB = offFrac(snap, b);
    if ((afterA + afterB) / 2 >= before - 0.05) { newEdges.push(e); continue; }
    const vid = nextVia();
    g.nodes.push({ id: vid, name: '', type: 'junction', x: Math.round(snap.x), y: Math.round(snap.y), destination: false });
    nodes.set(vid, { x: snap.x, y: snap.y });
    newEdges.push({ id: e.id + '_a' + vid, from: e.from, to: vid, pathType: e.pathType });
    newEdges.push({ id: e.id + '_b' + vid, from: vid, to: e.to, pathType: e.pathType });
    inserted++;
  }
  g.edges = newEdges;
  return inserted;
}

let total = 0;
for (let i = 0; i < 4; i++) { const n = pass(); total += n; if (!n) break; }
writeFileSync(GRAPH, JSON.stringify(g) + '\n');
console.log('inserted', total, 'via-nodes →', g.nodes.length, 'nodes,', g.edges.length, 'edges');
