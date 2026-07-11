/* MapView — shared pan/zoom SVG map component over the resort map image.
 * See SPEC.md for the public API. No dependencies.
 */
(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function el(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k]);
    return node;
  }

  class MapView {
    constructor(container, config) {
      this.container = container;
      this.config = config;
      this.mapW = config.width;
      this.mapH = config.height;

      // view state: map-coordinate rect currently shown
      this.view = { x: 0, y: 0, w: this.mapW, h: this.mapH };

      this.svg = el('svg', {
        width: '100%',
        height: '100%',
        preserveAspectRatio: 'xMidYMid meet'
      });
      this.svg.style.touchAction = 'none';
      this.svg.style.userSelect = 'none';
      this.svg.style.display = 'block';
      this.svg.style.cursor = 'grab';

      const image = el('image', {
        href: config.mapImage,
        x: 0, y: 0,
        width: this.mapW, height: this.mapH
      });
      this.svg.appendChild(image);

      this.overlay = el('g');
      this.svg.appendChild(this.overlay);

      container.appendChild(this.svg);

      this._clickHandlers = [];
      this._viewHandlers = [];
      this._pointers = new Map();
      this._dragged = false;
      this._pinchStart = null;

      this._bindEvents();
      this.fitAll();
    }

    /* ------------ public API ------------ */

    get scale() {
      const r = this.svg.getBoundingClientRect();
      // 'meet' scaling: uniform scale is min of both axes
      return Math.min(r.width / this.view.w, r.height / this.view.h);
    }

    onClick(fn) { this._clickHandlers.push(fn); }
    onViewChanged(fn) { this._viewHandlers.push(fn); }

    screenToMap(clientX, clientY) {
      const pt = this.svg.createSVGPoint();
      pt.x = clientX; pt.y = clientY;
      const ctm = this.svg.getScreenCTM();
      if (!ctm) return { x: 0, y: 0 };
      const p = pt.matrixTransform(ctm.inverse());
      return { x: p.x, y: p.y };
    }

    fitAll() {
      this._setView(0, 0, this.mapW, this.mapH);
    }

    zoomTo(x, y, targetScale) {
      const r = this.svg.getBoundingClientRect();
      const s = targetScale || Math.min(r.width / this.mapW, r.height / this.mapH) * 3;
      const w = r.width / s, h = r.height / s;
      this._setView(x - w / 2, y - h / 2, w, h);
    }

    /** Fit a bounding box (map coords) with padding (map px). */
    fitBounds(minX, minY, maxX, maxY, pad) {
      pad = pad == null ? 60 : pad;
      const r = this.svg.getBoundingClientRect();
      let w = Math.max(maxX - minX + pad * 2, 40);
      let h = Math.max(maxY - minY + pad * 2, 40);
      // match container aspect so target area is fully visible
      const aspect = r.width / r.height;
      if (w / h < aspect) w = h * aspect; else h = w / aspect;
      this._setView((minX + maxX) / 2 - w / 2, (minY + maxY) / 2 - h / 2, w, h);
    }

    /* ------------ internals ------------ */

    _setView(x, y, w, h) {
      // clamp zoom-in level and keep the map roughly in frame
      const minW = this.mapW / 12;
      if (w < minW) { const c = x + w / 2, cy = y + h / 2, ratio = minW / w; w = minW; h = h * ratio; x = c - w / 2; y = cy - h / 2; }
      const maxW = this.mapW * 2.5;
      if (w > maxW) { const c = x + w / 2, cy = y + h / 2, ratio = maxW / w; w = maxW; h = h * ratio; x = c - w / 2; y = cy - h / 2; }
      const margX = w * 0.6, margY = h * 0.6;
      x = Math.min(Math.max(x, -margX), this.mapW - w + margX);
      y = Math.min(Math.max(y, -margY), this.mapH - h + margY);
      this.view = { x, y, w, h };
      this.svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
      for (const fn of this._viewHandlers) fn();
    }

    _bindEvents() {
      const svg = this.svg;

      svg.addEventListener('pointerdown', (e) => {
        svg.setPointerCapture(e.pointerId);
        this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        this._dragged = false;
        if (this._pointers.size === 2) {
          const [a, b] = [...this._pointers.values()];
          this._pinchStart = {
            dist: Math.hypot(a.x - b.x, a.y - b.y),
            view: { ...this.view },
            center: this.screenToMap((a.x + b.x) / 2, (a.y + b.y) / 2)
          };
        }
        svg.style.cursor = 'grabbing';
      });

      svg.addEventListener('pointermove', (e) => {
        if (!this._pointers.has(e.pointerId)) return;
        const prev = this._pointers.get(e.pointerId);
        const cur = { x: e.clientX, y: e.clientY };

        if (this._pointers.size === 1) {
          const dx = cur.x - prev.x, dy = cur.y - prev.y;
          if (Math.abs(dx) + Math.abs(dy) > 0) {
            const s = this.scale;
            if (Math.abs(dx) + Math.abs(dy) > 3) this._dragged = true;
            this._setView(this.view.x - dx / s, this.view.y - dy / s, this.view.w, this.view.h);
          }
        } else if (this._pointers.size === 2 && this._pinchStart) {
          this._pointers.set(e.pointerId, cur);
          const [a, b] = [...this._pointers.values()];
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          if (dist > 0 && this._pinchStart.dist > 0) {
            this._dragged = true;
            const factor = this._pinchStart.dist / dist;
            const v0 = this._pinchStart.view;
            const c = this._pinchStart.center;
            const w = v0.w * factor, h = v0.h * factor;
            const fx = (c.x - v0.x) / v0.w, fy = (c.y - v0.y) / v0.h;
            this._setView(c.x - fx * w, c.y - fy * h, w, h);
          }
          return;
        }
        this._pointers.set(e.pointerId, cur);
      });

      const endPointer = (e) => {
        if (!this._pointers.has(e.pointerId)) return;
        this._pointers.delete(e.pointerId);
        if (this._pointers.size < 2) this._pinchStart = null;
        if (this._pointers.size === 0) {
          svg.style.cursor = 'grab';
          if (!this._dragged && e.type === 'pointerup') {
            const p = this.screenToMap(e.clientX, e.clientY);
            for (const fn of this._clickHandlers) fn({ x: p.x, y: p.y, event: e });
          }
        }
      };
      svg.addEventListener('pointerup', endPointer);
      svg.addEventListener('pointercancel', endPointer);

      svg.addEventListener('wheel', (e) => {
        e.preventDefault();
        const factor = Math.exp(e.deltaY * 0.0015);
        const c = this.screenToMap(e.clientX, e.clientY);
        const v = this.view;
        const w = v.w * factor, h = v.h * factor;
        const fx = (c.x - v.x) / v.w, fy = (c.y - v.y) / v.h;
        this._setView(c.x - fx * w, c.y - fy * h, w, h);
      }, { passive: false });

      window.addEventListener('resize', () => {
        for (const fn of this._viewHandlers) fn();
      });
    }
  }

  MapView.el = el;
  window.MapView = MapView;
})();
