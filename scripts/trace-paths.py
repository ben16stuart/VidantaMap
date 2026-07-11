"""Trace the resort walkways from the map image into a routable graph.

Pipeline: color-mask boardwalks+roads -> close dash gaps -> drop fat blobs
(pool decks/plazas) via medial-axis width -> skeleton -> pixel graph ->
chain extraction -> RDP simplify -> prune spurs -> merge close nodes ->
bridge gaps (baked-in map pins cut the artwork) -> emit traced.json.
"""
import json
import numpy as np
from PIL import Image
from skimage.morphology import closing, disk, remove_small_objects, medial_axis

SCRATCH = '/tmp/claude-0/-home-user-VidantaMap/a5aff856-b1bf-552e-9acc-f4882bad4252/scratchpad'
img = np.array(Image.open('/home/user/VidantaMap/public/img/resort-map.png').convert('RGB')).astype(int)
H, W = img.shape[:2]
R, G, B = img[..., 0], img[..., 1], img[..., 2]

board = (np.abs(R - G) <= 18) & ((R - B) >= 26) & (R >= 135) & (R <= 218)
road = (np.abs(R - G) <= 8) & (np.abs(G - B) <= 12) & (R >= 150) & (R <= 215)
water = (G - R >= 40) & (G >= 190) & (B >= 180)

walk = closing(board | road, disk(4))
walk = remove_small_objects(walk, min_size=300)

skel, dist = medial_axis(walk, return_distance=True)
skel = skel & (dist <= 16)          # drop centerlines of fat blobs (decks/plazas)

# ---- skeleton -> pixel graph ----
ys, xs = np.nonzero(skel)
pix = set(zip(map(int, xs), map(int, ys)))
NBR = [(-1,-1),(0,-1),(1,-1),(-1,0),(1,0),(-1,1),(0,1),(1,1)]

def neighbors(p):
    return [(p[0]+dx, p[1]+dy) for dx, dy in NBR if (p[0]+dx, p[1]+dy) in pix]

deg = {p: len(neighbors(p)) for p in pix}
node_px = {p for p, d in deg.items() if d != 2}

# walk chains between node pixels
chains = []
visited_edges = set()
for start in node_px:
    for nb in neighbors(start):
        key = (start, nb)
        if key in visited_edges:
            continue
        chain = [start, nb]
        visited_edges.add(key); visited_edges.add((nb, start))
        prev, cur = start, nb
        while cur not in node_px:
            nxt = [q for q in neighbors(cur) if q != prev]
            if not nxt:
                break
            step = nxt[0]
            visited_edges.add((cur, step)); visited_edges.add((step, cur))
            chain.append(step)
            prev, cur = cur, step
        chains.append(chain)
# pure cycles with no junction pixel are rare and tiny here; skip them.

def rdp(points, eps):
    if len(points) < 3:
        return points
    a, b = np.array(points[0]), np.array(points[-1])
    ab = b - a
    lab = np.hypot(*ab) or 1e-9
    dmax, idx = -1.0, 0
    for i in range(1, len(points) - 1):
        p = np.array(points[i])
        d = abs(ab[0]*(a[1]-p[1]) - ab[1]*(a[0]-p[0])) / lab
        if d > dmax:
            dmax, idx = d, i
    if dmax > eps:
        left = rdp(points[:idx+1], eps)
        return left[:-1] + rdp(points[idx:], eps)
    return [points[0], points[-1]]

def chain_len(ch):
    return sum(np.hypot(ch[i+1][0]-ch[i][0], ch[i+1][1]-ch[i][1]) for i in range(len(ch)-1))

def chain_type(ch):
    b = sum(1 for (x, y) in ch if board[y, x])
    r = sum(1 for (x, y) in ch if road[y, x])
    return 'paved' if r > b else 'boardwalk'

# build editable graph structure: nodes dict, edge list (polyline chains kept as vertex runs)
import itertools
counter = itertools.count(1)
node_ids = {}
nodes = {}
def nid(p):
    if p not in node_ids:
        i = f'w{next(counter):04d}'
        node_ids[p] = i
        nodes[i] = p
    return node_ids[p]

edges = []   # (fromId, toId, pathType)
for ch in chains:
    if chain_len(ch) < 6 and deg.get(ch[0], 0) >= 2 and deg.get(ch[-1], 0) >= 2:
        pass  # keep tiny connectors between junctions
    simp = rdp(ch, 2.5)
    t = chain_type(ch)
    for a, b in zip(simp, simp[1:]):
        if a == b:
            continue
        edges.append((nid(a), nid(b), t))

# ---- prune short dead-end spurs (iteratively) ----
def build_adj(edges):
    adj = {}
    for a, b, t in edges:
        adj.setdefault(a, []).append((b, t))
        adj.setdefault(b, []).append((a, t))
    return adj

def euclid(i, j):
    (x1, y1), (x2, y2) = nodes[i], nodes[j]
    return np.hypot(x2-x1, y2-y1)

# ---- drop edges running through building interiors ----
# Building fill is pinkish-white; roof trim sometimes matches path colors and
# yields false "paths" through slabs (guests can't walk through buildings).
# Short skips at both ends keep doorway/breezeway connections alive; edges a
# later connectivity pass needs get re-bridged around, not through.
bld = (R >= 220) & (G >= 205) & (B >= 200) & ((R - G) >= 8)

def building_frac(i, j, skip=6):
    (x1, y1), (x2, y2) = nodes[i], nodes[j]
    L = np.hypot(x2-x1, y2-y1)
    n = max(2, int(L))
    hits = total = 0
    for k in range(n + 1):
        t = k / n
        if t * L < skip or (1 - t) * L < skip:
            continue
        x = int(round(x1 + (x2-x1)*t)); y = int(round(y1 + (y2-y1)*t))
        total += 1
        if 0 <= x < W and 0 <= y < H and bld[y, x]:
            hits += 1
    return hits / total if total else 0

edges = [e for e in edges
         if euclid(e[0], e[1]) < 10 or building_frac(e[0], e[1]) <= 0.5]

for _ in range(4):
    adj = build_adj(edges)
    drop = set()
    for i, nbrs in adj.items():
        if len(nbrs) == 1 and euclid(i, nbrs[0][0]) < 14:
            drop.add((i, nbrs[0][0]))
    if not drop:
        break
    edges = [e for e in edges if (e[0], e[1]) not in drop and (e[1], e[0]) not in drop]

# ---- merge nodes closer than 4px (grid hash) ----
parent = {}
def find(i):
    while parent.get(i, i) != i:
        parent[i] = parent.get(parent[i], parent[i])
        i = parent[i]
    return i
ids = [i for i in nodes if any(i in (a, b) for a, b, _ in edges)] and list(nodes)
grid = {}
for i, (x, y) in nodes.items():
    grid.setdefault((x//4, y//4), []).append(i)
for cell, members in grid.items():
    cx, cy = cell
    cand = []
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            cand += grid.get((cx+dx, cy+dy), [])
    for i in members:
        for j in cand:
            if i < j and euclid(i, j) < 4:
                parent[find(i)] = find(j)

def rep(i): return find(i)
edges = [(rep(a), rep(b), t) for a, b, t in edges if rep(a) != rep(b)]
edges = list({(min(a,b), max(a,b)): (a, b, t) for a, b, t in edges}.values())

# ---- connected components; bridge gaps (pin overlays cut the artwork) ----
def components(edges):
    adj = build_adj(edges)
    seen, comps = set(), []
    for s in adj:
        if s in seen:
            continue
        stack, comp = [s], set()
        while stack:
            u = stack.pop()
            if u in comp:
                continue
            comp.add(u)
            stack += [v for v, _ in adj[u]]
        seen |= comp
        comps.append(comp)
    return comps

# vegetation (grass/jungle): green-dominant pixels — bridges must not cross it
veg = ((G - R) >= 16) & ((G - B) >= 25)

def line_ok(i, j):
    """A bridge may only cross pin/building graphics or path pixels —
    never water and never the jungle/grass."""
    (x1, y1), (x2, y2) = nodes[i], nodes[j]
    n = max(2, int(np.hypot(x2-x1, y2-y1)))
    bad = 0
    for k in range(n + 1):
        x = int(round(x1 + (x2-x1)*k/n)); y = int(round(y1 + (y2-y1)*k/n))
        if 0 <= x < W and 0 <= y < H and (water[y, x] or veg[y, x]):
            bad += 1
    return bad <= n * 0.12

while True:
    comps = components(edges)
    comps.sort(key=len, reverse=True)
    if len(comps) <= 1:
        break
    main = comps[0]
    # nearest allowed pair between main and any other component
    best = None
    for comp in comps[1:]:
        for i in comp:
            for j in main:
                d = euclid(i, j)
                if d < 90 and (best is None or d < best[0]) and line_ok(i, j):
                    best = (d, i, j)
    if best is None:
        # drop remaining unreachable debris
        keep = main
        edges = [e for e in edges if e[0] in keep]
        break
    edges.append((best[1], best[2], 'boardwalk'))

# ---- heal remaining degree-1 gaps inside the main component ----
adj = build_adj(edges)
endpoints = [i for i, nbrs in adj.items() if len(nbrs) == 1]
existing = {(min(a,b), max(a,b)) for a, b, _ in edges}
for i in endpoints:
    nbr = adj[i][0][0]
    vx = nodes[i][0]-nodes[nbr][0]; vy = nodes[i][1]-nodes[nbr][1]
    best = None
    for j in adj:
        if j == i or j == nbr or (min(i,j), max(i,j)) in existing:
            continue
        d = euclid(i, j)
        if d > 45:
            continue
        wx = nodes[j][0]-nodes[i][0]; wy = nodes[j][1]-nodes[i][1]
        dot = vx*wx + vy*wy
        cos = dot / ((np.hypot(vx, vy) or 1e-9) * (np.hypot(wx, wy) or 1e-9))
        if cos > 0.2 and line_ok(i, j):  # roughly continuing forward
            if best is None or d < best[0]:
                best = (d, j)
    if best:
        edges.append((i, best[1], 'boardwalk'))
        existing.add((min(i, best[1]), max(i, best[1])))

# ---- emit ----
used = {a for a, b, _ in edges} | {b for _, b, _ in edges}
out = {
    'nodes': [{'id': i, 'x': int(nodes[i][0]), 'y': int(nodes[i][1])} for i in sorted(used)],
    'edges': [{'from': a, 'to': b, 'pathType': t} for a, b, t in edges],
}
with open(f'{SCRATCH}/traced.json', 'w') as f:
    json.dump(out, f)
comps = components(edges)
print('nodes:', len(used), 'edges:', len(edges), 'components:', len(comps),
      'largest:', max(len(c) for c in comps))

# visual check: network over dimmed map
vis = Image.fromarray((img * 0.5).astype(np.uint8))
from PIL import ImageDraw
d = ImageDraw.Draw(vis)
for a, b, t in edges:
    d.line([nodes[a], nodes[b]], fill=(80, 90, 255) if t == 'boardwalk' else (255, 140, 40), width=2)
vis.save(f'{SCRATCH}/traced-vis.png')
