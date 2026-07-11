/* Builds a single-file, serverless demo of the guest app: embeds the map
 * image, graph data, MapView, and the routing engine, and shims the two
 * /api/* calls so routing runs entirely client-side. Useful for sharing a
 * working demo (e.g. opening on a phone) without running the Node server.
 *
 * Usage: node scripts/build-static-demo.mjs [--image path/to/map.(png|jpg)] [--out out.html]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const args = process.argv.slice(2);
function arg(flag, dflt) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : dflt;
}
const imagePath = resolve(root, arg('--image', 'public/img/resort-map.png'));
const outPath = resolve(root, arg('--out', 'demo.html'));

const read = (p) => readFileSync(resolve(root, p), 'utf8');

const graph = JSON.parse(read('data/graph.json'));
const mime = extname(imagePath).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
graph.config.mapImage =
  `data:${mime};base64,` + readFileSync(imagePath).toString('base64');

// index.html body markup, minus its script/link tags (we inline everything)
const indexHtml = read('public/index.html');
const body = indexHtml
  .slice(indexHtml.indexOf('<body>') + 6, indexHtml.indexOf('</body>'))
  .replace(/<script[^>]*><\/script>/g, '');

const html = `<title>VidantaMap — Resort Walking Directions</title>
<script>
// iPhone/mobile: ensure a proper viewport even if the host page lacks one
if (!document.querySelector('meta[name="viewport"]')) {
  var m = document.createElement('meta');
  m.name = 'viewport';
  m.content = 'width=device-width, initial-scale=1, viewport-fit=cover';
  document.head.appendChild(m);
}
</script>
<style>
html, body { height: 100%; margin: 0; }
${read('public/css/app.css')}
</style>
${body}
<script>
${read('public/js/mapview.js')}
</script>
<script>
// Routing engine (lib/routing.js) wrapped for the browser
window.Routing = (function () {
  var module = { exports: {} };
${read('lib/routing.js')}
  return module.exports;
})();
</script>
<script>
// Serverless shim: answer /api/graph and /api/route locally
(function () {
  var GRAPH = ${JSON.stringify(graph)};
  function json(obj, status) {
    return new Response(JSON.stringify(obj), {
      status: status || 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  var realFetch = window.fetch.bind(window);
  window.fetch = function (url, opts) {
    var u = String(url);
    if (u.indexOf('/api/graph') === 0) return Promise.resolve(json(GRAPH));
    if (u.indexOf('/api/route') === 0) {
      var q = new URLSearchParams(u.split('?')[1] || '');
      try {
        return Promise.resolve(json(
          window.Routing.buildRouteResponse(GRAPH, q.get('from'), q.get('to'))));
      } catch (err) {
        if (err && err.code === 'no-route') return Promise.resolve(json({ error: 'no-route' }, 404));
        return Promise.resolve(json({ error: err && err.message || 'bad-request' }, 400));
      }
    }
    return realFetch(url, opts);
  };
})();
</script>
<script>
${read('public/js/app.js')}
</script>
`;

writeFileSync(outPath, html);
console.log('wrote', outPath, Math.round(html.length / 1024) + ' KB');
