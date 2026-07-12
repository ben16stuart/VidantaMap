"""Heal grass-bridge cuts in data/graph.json using the walkway skeleton.

The tracer's width filter severs the network at wide intersections
(roundabouts/plazas); those gaps were bridged straight across grass, so routes
cut corners. This pass finds every edge that crosses grass/water and, when the
full medial-axis skeleton of the walkable area connects its endpoints on-path,
replaces the grass bridge with a polyline traced along that real walkway.
Edges with no on-path alternative (true water bridges) are kept.

Idempotent-ish and safe: only edges that cross grass are touched, and each is
replaced by an on-walkway path with the same endpoints, so connectivity is
preserved and routing can only move onto real paths.
"""
import json
import heapq
import numpy as np
from PIL import Image
from skimage.morphology import closing, disk, remove_small_objects, medial_axis

ROOT = '/home/user/VidantaMap'
img = np.array(Image.open(f'{ROOT}/public/img/resort-map.png').convert('RGB')).astype(int)
H, W = img.shape[:2]
R, G, B = img[..., 0], img[..., 1], img[..., 2]
board = (np.abs(R - G) <= 18) & ((R - B) >= 26) & (R >= 135) & (R <= 218)
road = (np.abs(R - G) <= 8) & (np.abs(G - B) <= 12) & (R >= 150) & (R <= 215)
walkm = closing(board | road, disk(4))
walkm = remove_small_objects(walkm, min_size=300)
skel, _ = medial_axis(walkm, return_distance=True)

# full-skeleton pixel set + fast nearest lookup
sy, sx = np.nonzero(skel)
skpix = set(zip(map(int, sx), map(int, sy)))
NBR = [(-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1)]

def nearest_skel(x, y, R=14):
    x, y = round(x), round(y)
    best, bd = None, 1e9
    for r in range(R + 1):
        for dx in range(-r, r + 1):
            for dy in range(-r, r + 1):
                if max(abs(dx), abs(dy)) != r:
                    continue
                p = (x + dx, y + dy)
                if p in skpix:
                    d = dx * dx + dy * dy
                    if d < bd:
                        best, bd = p, d
        if best:
            return best
    return None

def skel_path(a, b):
    """Dijkstra over skeleton pixels from a to b (both skeleton pixels)."""
    if a == b:
        return [a]
    dist = {a: 0.0}
    prev = {}
    pq = [(0.0, a)]
    seen = set()
    while pq:
        d, u = heapq.heappop(pq)
        if u in seen:
            continue
        seen.add(u)
        if u == b:
            break
        for dx, dy in NBR:
            v = (u[0] + dx, u[1] + dy)
            if v not in skpix:
                continue
            nd = d + (1.414 if dx and dy else 1.0)
            if nd < dist.get(v, 1e18):
                dist[v] = nd
                prev[v] = u
                heapq.heappush(pq, (nd, v))
    if b not in prev and b != a:
        return None
    path = [b]
    while path[-1] != a:
        path.append(prev[path[-1]])
    path.reverse()
    return path

def rdp(pts, eps=2.0):
    if len(pts) < 3:
        return pts
    a, b = np.array(pts[0]), np.array(pts[-1])
    ab = b - a
    lab = np.hypot(*ab) or 1e-9
    dmax, idx = -1, 0
    for i in range(1, len(pts) - 1):
        p = np.array(pts[i])
        d = abs(ab[0] * (a[1] - p[1]) - ab[1] * (a[0] - p[0])) / lab
        if d > dmax:
            dmax, idx = d, i
    if dmax > eps:
        return rdp(pts[:idx + 1], eps)[:-1] + rdp(pts[idx:], eps)
    return [pts[0], pts[-1]]

def off_walk_frac(a, b, skip=3):
    n = max(2, int(np.hypot(b[0] - a[0], b[1] - a[1])))
    off = tot = 0
    for k in range(n + 1):
        t = k / n
        if t * n < skip or (1 - t) * n < skip:
            continue
        x = round(a[0] + (b[0] - a[0]) * t)
        y = round(a[1] + (b[1] - a[1]) * t)
        tot += 1
        if not (0 <= x < W and 0 <= y < H and walkm[y, x]):
            off += 1
    return off / tot if tot else 0

g = json.load(open(f'{ROOT}/data/graph.json'))
nid = {n['id']: n for n in g['nodes']}
vseq = [0]
def newnode(x, y):
    vseq[0] += 1
    i = 'h%04d' % vseq[0]
    n = {'id': i, 'name': '', 'type': 'junction', 'x': int(round(x)), 'y': int(round(y)), 'destination': False}
    g['nodes'].append(n)
    nid[i] = n
    return i

healed = kept = 0
new_edges = []
for e in list(g['edges']):
    if e['id'].startswith('ed-'):
        new_edges.append(e); continue
    a, b = nid[e['from']], nid[e['to']]
    L = np.hypot(a['x'] - b['x'], a['y'] - b['y'])
    if L < 16 or off_walk_frac((a['x'], a['y']), (b['x'], b['y'])) < 0.4:
        new_edges.append(e); continue
    pa, pb = nearest_skel(a['x'], a['y']), nearest_skel(b['x'], b['y'])
    path = skel_path(pa, pb) if pa and pb else None
    if not path or len(path) < 2:
        new_edges.append(e); kept += 1; continue      # true water bridge — keep
    # don't accept an absurdly long detour (skeleton wander); cap at 4x
    plen = sum(np.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]) for i in range(len(path) - 1))
    if plen > max(60, L * 4):
        new_edges.append(e); kept += 1; continue
    simp = rdp([(float(x), float(y)) for x, y in path], 2.0)
    # build a node chain: endpoints reuse a,b; interior become via nodes
    ids = [e['from']]
    for (x, y) in simp[1:-1]:
        ids.append(newnode(x, y))
    ids.append(e['to'])
    for i in range(len(ids) - 1):
        new_edges.append({'id': e['id'] + '_h%d' % i, 'from': ids[i], 'to': ids[i + 1], 'pathType': e['pathType']})
    healed += 1

g['edges'] = new_edges
json.dump(g, open(f'{ROOT}/data/graph.json', 'w'))
print(f'healed {healed} grass bridges onto the walkway, kept {kept} (no on-path route), '
      f'now {len(g["nodes"])} nodes {len(g["edges"])} edges')
