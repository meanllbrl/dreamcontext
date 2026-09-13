/**
 * chat-html-graph.js — the kit's DIAGRAM engine, run inside the sandboxed `dream-html` frame.
 *
 * Mirrored into `chatHtmlKit.ts` as `KIT_GRAPH` by `scripts/gen-chat-html-kit-mirror.mjs`
 * (never hand-edit the TS constant; `tests/unit/chat-html.test.ts` pins them byte-identical),
 * and rides in the srcdoc HEAD beside the tab script, so an author writes DATA and gets a
 * drawing:
 *
 *   <div class="dc-graph">
 *     <div class="dc-node" id="a">Sinyal</div>
 *     <div class="dc-node dc-node--decision" id="b">Komşu var mı?</div>
 *     <div class="dc-edge" data-from="a" data-to="b" data-label="evet"></div>
 *   </div>
 *
 * WHY THIS EXISTS (owner, 2026-09-11). The kit's flow was a list wearing arrows: chips in a
 * row that wrapped, then a top-down stack with a "↓" glyph between rules. Neither is a
 * diagram. A diagram shows SHAPE — it branches here, two paths merge there, this loops back —
 * and shape only appears when a node is PLACED by its relations and the arrow is DRAWN
 * between it and the next. CSS cannot place by relation; a script can, and this frame has
 * one (`sandbox="allow-scripts"`), so the kit uses it.
 *
 * What it does, in order: read nodes + edges (no edges = a chain in written order, which is
 * how a retired `.dc-flow` renders); break cycles (DFS back edges, drawn dashed); rank by
 * longest path; route long edges through invisible waypoints so they pass BETWEEN nodes;
 * order each rank by barycenter to cut crossings; measure every node at its natural size;
 * lay ranks top-down (or a chain left-to-right when it measurably fits the pane); draw
 * every edge as one smooth SVG path with an arrowhead; then PLACE each label on clear
 * ground. It re-lays on width change, so one block is right at 380px and in the fullscreen
 * deck.
 *
 * AND IT IS A VIEW, NOT A PICTURE (owner, 2026-09-13, with a screenshot of a 10-node ladder:
 * "bu görünüm interaktif değil yaklaştırılamıyor merkezde değil … tıklanamıyor iç içe
 * yazılar var"). Four things that screenshot proves a drawing needs and a drawing alone
 * does not have:
 *
 *   · CENTRED. The laid drawing sits on a STAGE inside the block, and the stage is centred
 *     in the pane. A 270px-wide ladder in a 1050px pane used to hug the left edge with 778px
 *     of dead space beside it, which reads as a rendering accident rather than a diagram.
 *   · ZOOMABLE. Ctrl/⌘-wheel (which is also how a trackpad pinch arrives) zooms at the
 *     pointer; the corner control zooms in steps and fits back; `+` / `-` / `0` do the same
 *     from the keyboard. A PLAIN wheel is left alone on purpose — the block lives in a
 *     transcript, and a diagram that eats the page's scroll is worse than one you cannot
 *     zoom.
 *   · PANNABLE. Drag anywhere to push the drawing around, arrow keys to nudge it. The pan is
 *     clamped so the drawing can never be thrown out of its own block.
 *   · CLICKABLE. Hovering a node lights its edges; clicking one FOCUSES it — its edges and
 *     its immediate neighbours stay lit and everything else dims, so one path through a
 *     dense ladder can be read on its own. Click it again, click the background, or press
 *     Esc to clear. Every node is tabbable and answers Enter/Space, so the same trace is
 *     reachable without a pointer.
 *
 * LABELS LAND ON CLEAR GROUND. An edge label used to be pinned to the midpoint of the drawn
 * path, which put "+100k sonra" on top of two nodes in that same screenshot (the reserved
 * waypoint and the drawn midpoint disagreed on back edges with an even number of points —
 * reproduced, then fixed). Now the engine reserves the middle waypoint(s) for the label AND
 * scores real candidate boxes along the finished path — sliding along it, then stepping off
 * it — against every node box and every label already placed, taking the cleanest.
 *
 * It stays inside the block: no message out, no network, no host. Everything it
 * touches is markup the author already wrote, plus the `<svg>`, the stage, the label spans
 * and the zoom control it adds. Before it runs — or when it cannot — the nodes are plain
 * inline chips in written order: a legible degradation, never a blank.
 *
 * ES5 on purpose: it runs verbatim in the frame, with no build step between this file and
 * the reader. The unit suite forbids it any reach outside the block — no message out, no
 * network, no host — same as the tab script beside it.
 */
(function () {
  var GAP = 24;   // between nodes inside one rank (16 once the labels have been shrunk)
  var ROW = 34;   // between ranks, top-down
  var ROWL = 46;  // …when an edge label has to sit in that gap
  var COL = 44;   // between ranks, left-to-right
  var WAY = 12;   // a waypoint's own width, so a routed edge keeps clear of its neighbours
  var LAID = 'dc-graph--laid';
  var TIGHT = 'dc-graph--tight';
  var FOCUSED = 'dc-graph--focused';
  var ZOOMED = 'dc-graph--zoomed';
  var DRAGGING = 'dc-graph--drag';
  var MINZ = 0.5;   // out far enough to see a tall ladder whole
  var MAXZ = 4;     // in far enough to read a shrunk label
  var STEP = 1.3;   // one press of + / −
  var KEEP = 64;    // px of drawing that must stay inside the block, however hard you drag
  var NUDGE = 40;   // px an arrow key pans

  function isNode(el) { return el.classList.contains('dc-node') || el.classList.contains('dc-flow-node'); }
  function isEdge(el) { return el.classList.contains('dc-edge'); }
  function kids(g) { return [].slice.call(g.children); }

  function read(g) {
    var nodes = kids(g).filter(isNode);
    var byId = {};
    nodes.forEach(function (n, i) { if (n.id) byId[n.id] = i; });
    var edges = [];
    kids(g).filter(isEdge).forEach(function (e) {
      var a = byId[e.getAttribute('data-from') || ''];
      var b = byId[e.getAttribute('data-to') || ''];
      if (a === undefined || b === undefined || a === b) return;
      var cls = (e.getAttribute('class') || '').split(/\s+/).filter(function (c) {
        return c && c !== 'dc-edge';
      });
      edges.push({ from: a, to: b, label: e.getAttribute('data-label') || '', cls: cls });
    });
    // No usable edges: a chain in written order (also how a retired .dc-flow reads).
    if (!edges.length) for (var i = 1; i < nodes.length; i++) edges.push({ from: i - 1, to: i, label: '', cls: [] });
    return { nodes: nodes, edges: edges };
  }

  /** Longest-path ranks over the DAG left after DFS marks the back edges. */
  function rank(n, edges) {
    var out = [];
    for (var i = 0; i < n; i++) out.push([]);
    edges.forEach(function (e) { out[e.from].push(e); });
    var state = [], order = [];
    function visit(v) {
      state[v] = 1;
      out[v].forEach(function (e) {
        if (state[e.to] === 1) { e.back = true; return; }
        if (!state[e.to]) visit(e.to);
      });
      state[v] = 2;
      order.push(v);
    }
    for (var v = 0; v < n; v++) if (!state[v]) visit(v);
    order.reverse();
    var r = [];
    for (i = 0; i < n; i++) r[i] = 0;
    order.forEach(function (u) {
      out[u].forEach(function (e) { if (!e.back && r[e.to] < r[u] + 1) r[e.to] = r[u] + 1; });
    });
    return r;
  }

  /** Rank lists of items — real nodes plus zero-size waypoints for edges spanning ranks. */
  function build(nodes, edges, r, sizes) {
    var maxR = 0;
    r.forEach(function (x) { if (x > maxR) maxR = x; });
    var ranks = [];
    for (var i = 0; i <= maxR; i++) ranks.push([]);
    var items = nodes.map(function (n, k) {
      var it = { node: k, w: sizes[k].w, h: sizes[k].h, up: [], down: [] };
      ranks[r[k]].push(it);
      return it;
    });
    edges.forEach(function (e) {
      // A back edge points UP the ranking; it is routed as its reverse and drawn reversed.
      var a = e.back ? e.to : e.from, b = e.back ? e.from : e.to;
      var path = [items[a]];
      for (var k = r[a] + 1; k < r[b]; k++) {
        var d = { node: null, w: WAY, h: 0, up: [], down: [] };
        ranks[k].push(d);
        path.push(d);
      }
      path.push(items[b]);
      // The label of a routed edge sits near the MIDDLE of the finished path, so the middle
      // waypoint is made as wide as the label and the rank opens a gap for it instead of the
      // label landing on a node. Both middles when the path has an even number of points:
      // the geometric middle then falls between two waypoints, and reserving only the one
      // the old code picked is exactly how a back edge's label ended up on two nodes.
      if (e.labelW && path.length > 2) {
        var m = Math.floor(path.length / 2);
        [m, path.length % 2 ? -1 : m - 1].forEach(function (k2) {
          var way = k2 > 0 ? path[k2] : null;
          if (way && way.node === null) way.w = Math.max(way.w, e.labelW + 8);
        });
      }
      for (var j = 1; j < path.length; j++) {
        path[j - 1].down.push(path[j]);
        path[j].up.push(path[j - 1]);
      }
      e.path = path;
    });
    return ranks;
  }

  /** Barycenter sweeps: each item moves toward the mean position of its neighbours. */
  function order(ranks) {
    ranks.forEach(function (rk) { rk.forEach(function (it, i) { it.pos = i; }); });
    function sweep(dir) {
      var k = dir > 0 ? 1 : ranks.length - 2;
      for (; k >= 0 && k < ranks.length; k += dir) {
        var rk = ranks[k];
        rk.forEach(function (it) {
          var nb = dir > 0 ? it.up : it.down;
          if (!nb.length) { it.bc = it.pos; return; }
          var s = 0;
          nb.forEach(function (o) { s += o.pos; });
          it.bc = s / nb.length;
        });
        rk.sort(function (a, b) { return (a.bc - b.bc) || (a.pos - b.pos); });
        rk.forEach(function (it, i) { it.pos = i; });
      }
    }
    sweep(1); sweep(-1); sweep(1); sweep(-1);
  }

  /**
   * Coordinates. `along` is the axis ranks advance on (y top-down, x left-to-right); `cross`
   * runs through a rank. A rank wider than the pane splits into lines rather than overflowing.
   */
  function place(ranks, horizontal, limit, labelled, split, gap) {
    var lines = [];
    var crossMax = 0;
    var overflow = false;
    ranks.forEach(function (rk) {
      var cur = [], span = 0, rankLines = [];
      rk.forEach(function (it) {
        var c = horizontal ? it.h : it.w;
        var next = span + (cur.length ? gap : 0) + c;
        if (cur.length && next > limit) {
          if (!split) { overflow = true; }
          rankLines.push(cur); cur = []; span = c;
        } else span = next;
        cur.push(it);
      });
      if (cur.length) rankLines.push(cur);
      rankLines.forEach(function (ln) {
        var s = -gap, t = 0;
        ln.forEach(function (it) { s += gap + (horizontal ? it.h : it.w); var a = horizontal ? it.w : it.h; if (a > t) t = a; });
        ln.span = s; ln.thick = t;
        if (s > crossMax) crossMax = s;
      });
      lines.push(rankLines);
    });
    if (overflow) return null;
    var along = 0;
    var gapAlong = horizontal ? COL : (labelled ? ROWL : ROW);
    lines.forEach(function (rankLines, k) {
      if (k) along += gapAlong;
      rankLines.forEach(function (ln, li) {
        if (li) along += gap;
        // One line sits centred. A rank that had to split STAGGERS its lines — first left,
        // second right — so an edge coming down to the lower line passes beside the upper
        // node instead of through it.
        var cross = rankLines.length === 1 ? (crossMax - ln.span) / 2 : (li % 2 ? crossMax - ln.span : 0);
        ln.forEach(function (it) {
          var c = horizontal ? it.h : it.w, a = horizontal ? it.w : it.h;
          var alongPos = along + (ln.thick - a) / 2;
          if (horizontal) { it.x = alongPos; it.y = cross; } else { it.x = cross; it.y = alongPos; }
          cross += c + gap;
        });
        along += ln.thick;
      });
    });
    return { w: horizontal ? along : crossMax, h: horizontal ? crossMax : along };
  }

  function seg(p, q, horizontal) {
    if (horizontal) {
      var dx = (q.x - p.x) / 2;
      return ' C ' + (p.x + dx) + ' ' + p.y + ', ' + (q.x - dx) + ' ' + q.y + ', ' + q.x + ' ' + q.y;
    }
    var dy = (q.y - p.y) / 2;
    return ' C ' + p.x + ' ' + (p.y + dy) + ', ' + q.x + ' ' + (q.y - dy) + ', ' + q.x + ' ' + q.y;
  }

  function draw(stage, edges, horizontal, size, gid) {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'dc-graph-svg');
    svg.setAttribute('width', size.w);
    svg.setAttribute('height', size.h);
    svg.setAttribute('aria-hidden', 'true');
    var defs = document.createElementNS(NS, 'defs');
    var tones = ['', 'accent', 'good', 'bad', 'warn'];
    tones.forEach(function (t) {
      var m = document.createElementNS(NS, 'marker');
      m.setAttribute('id', gid + '-arrow' + (t ? '-' + t : ''));
      m.setAttribute('class', 'dc-arrow' + (t ? ' dc-arrow--' + t : ''));
      m.setAttribute('viewBox', '0 0 10 10');
      m.setAttribute('refX', '9'); m.setAttribute('refY', '5');
      m.setAttribute('markerWidth', '7'); m.setAttribute('markerHeight', '7');
      m.setAttribute('orient', 'auto');
      var tip = document.createElementNS(NS, 'path');
      tip.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
      m.appendChild(tip);
      defs.appendChild(m);
    });
    svg.appendChild(defs);
    edges.forEach(function (e) {
      var pts = e.path.map(function (it, i) {
        // Real endpoints leave from an edge of the box; waypoints are their own centre. A back
        // edge leaves and enters a third of the way across so it never sits on the forward one.
        var first = i === 0;
        var shift = e.back ? 0.3 : 0;
        if (horizontal) {
          return { x: first ? it.x + it.w : it.x, y: it.y + it.h * (0.5 + shift) };
        }
        return { x: it.x + it.w * (0.5 + shift), y: first ? it.y + it.h : it.y };
      });
      if (e.back) pts.reverse();
      var d = 'M ' + pts[0].x + ' ' + pts[0].y;
      for (var i = 1; i < pts.length; i++) d += seg(pts[i - 1], pts[i], horizontal);
      var tone = '';
      e.cls.forEach(function (c) { var m = /^dc-edge--(accent|good|bad|warn)$/.exec(c); if (m) tone = m[1]; });
      var p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      p.setAttribute('class', ['dc-edge-path'].concat(e.cls, e.back ? ['dc-edge--back'] : []).join(' '));
      p.setAttribute('marker-end', 'url(#' + gid + '-arrow' + (tone ? '-' + tone : '') + ')');
      svg.appendChild(p);
      e.el = p;
      // Where the label goes when the path cannot be measured (no geometry API, no length):
      // the old behaviour, kept as the floor under the placement pass below.
      e.mid = pts.length === 2
        ? { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }
        : pts[Math.floor(pts.length / 2)];
    });
    stage.insertBefore(svg, stage.firstChild);
  }

  function grow(a, by) { return { x: a.x - by, y: a.y - by, w: a.w + by * 2, h: a.h + by * 2 }; }

  function overlap(a, b) {
    var x = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    var y = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return x > 0 && y > 0 ? x * y : 0;
  }

  /** A point at `t` along the DRAWN path — the curve, not the polyline it was built from. */
  function at(e, total, t) {
    if (!total || !e.el || !e.el.getPointAtLength) return e.mid;
    try {
      var p = e.el.getPointAtLength(total * t);
      return { x: p.x, y: p.y };
    } catch (err) { return e.mid; }
  }

  /**
   * Labels, placed rather than pinned.
   *
   * Every label gets candidate boxes: seven points sliding along its own path from the middle
   * outward, each tried ON the line and stepped off it to either side (across the line, so it
   * still reads as that edge's). Each candidate is scored by how much it covers — a node
   * counts triple, a label already placed double — with a small preference for the middle and
   * for sitting on the line, and the cheapest wins. Returns the boxes so the caller can size
   * the stage around them.
   */
  function labels(stage, edges, boxes) {
    var placed = [];
    var TS = [0.5, 0.44, 0.56, 0.38, 0.62, 0.3, 0.7];
    edges.forEach(function (e) {
      if (!e.label) return;
      var span = document.createElement('span');
      span.className = 'dc-edge-label';
      span.textContent = e.label;
      span.style.visibility = 'hidden';
      stage.appendChild(span);
      var r = span.getBoundingClientRect();
      var w = Math.ceil(r.width), h = Math.ceil(r.height);
      var total = 0;
      try { total = e.el && e.el.getTotalLength ? e.el.getTotalLength() : 0; } catch (err) { total = 0; }
      var best = null, bestScore = Infinity;
      TS.forEach(function (t, ti) {
        var p = at(e, total, t);
        if (!p) return;
        var ahead = at(e, total, Math.min(0.97, t + 0.04)) || p;
        var steep = Math.abs(ahead.y - p.y) >= Math.abs(ahead.x - p.x);
        var tries = [{ dx: 0, dy: 0 }];
        if (steep) { tries.push({ dx: w / 2 + 9, dy: 0 }); tries.push({ dx: -(w / 2 + 9), dy: 0 }); }
        else { tries.push({ dx: 0, dy: h / 2 + 7 }); tries.push({ dx: 0, dy: -(h / 2 + 7) }); }
        tries.forEach(function (off, oi) {
          var box = { x: p.x + off.dx - w / 2, y: p.y + off.dy - h / 2, w: w, h: h };
          var hits = 0;
          boxes.forEach(function (b) { if (b) hits += overlap(box, grow(b, 3)); });
          placed.forEach(function (b) { hits += overlap(box, b) * 0.7; });
          var score = hits * 1000 + ti * 12 + (oi ? 30 : 0);
          if (score < bestScore) { bestScore = score; best = box; }
        });
      });
      if (!best) best = { x: (e.mid ? e.mid.x : 0) - w / 2, y: (e.mid ? e.mid.y : 0) - h / 2, w: w, h: h };
      span.style.left = (best.x + w / 2) + 'px';
      span.style.top = (best.y + h / 2) + 'px';
      span.style.visibility = '';
      placed.push(best);
      e.labelEl = span;
    });
    return placed;
  }

  // ── the view: centred, zoomable, pannable ────────────────────────────────────────────

  function view(g) {
    if (!g.dcView) g.dcView = { s: 1, tx: 0, ty: 0 };
    return g.dcView;
  }

  function apply(g) {
    var v = view(g);
    if (!g.dcStage) return;
    g.dcStage.style.transform = 'translate(' + v.tx + 'px, ' + v.ty + 'px) scale(' + v.s + ')';
    if (Math.abs(v.s - 1) > 0.001) g.classList.add(ZOOMED); else g.classList.remove(ZOOMED);
  }

  /** However hard it is dragged, KEEP px of the drawing stay inside the block. */
  function clamp(g) {
    var v = view(g), b = g.dcBox;
    if (!b) return;
    var W = g.clientWidth, H = g.clientHeight;
    var left = v.tx + b.x * v.s, top = v.ty + b.y * v.s;
    var right = left + b.w * v.s, bottom = top + b.h * v.s;
    var keepX = Math.min(KEEP, b.w * v.s), keepY = Math.min(KEEP, b.h * v.s);
    if (right < keepX) v.tx += keepX - right;
    if (left > W - keepX) v.tx -= left - (W - keepX);
    if (bottom < keepY) v.ty += keepY - bottom;
    if (top > H - keepY) v.ty -= top - (H - keepY);
  }

  /** Home: unzoomed, and CENTRED in the pane — the state every layout and every reset lands in. */
  function fit(g) {
    var v = view(g), b = g.dcBox;
    if (!b) return;
    v.s = 1;
    v.tx = Math.round((g.clientWidth - b.w) / 2 - b.x);
    v.ty = -b.y;
    apply(g);
  }

  function zoom(g, factor, cx, cy) {
    var v = view(g);
    var s = Math.max(MINZ, Math.min(MAXZ, v.s * factor));
    if (s === v.s) return;
    var k = s / v.s;
    v.tx = cx - (cx - v.tx) * k;
    v.ty = cy - (cy - v.ty) * k;
    v.s = s;
    clamp(g);
    apply(g);
  }

  // ── the trace: hover lights a node's edges, a click holds them ───────────────────────

  function mark(g, idx) {
    var m = g.dcMap;
    if (!m) return;
    m.nodes.forEach(function (n) { n.classList.remove('dc-node--on'); n.classList.remove('dc-node--near'); });
    m.edges.forEach(function (e) {
      if (e.el) e.el.classList.remove('dc-edge--on');
      if (e.labelEl) e.labelEl.classList.remove('dc-edge-label--on');
    });
    if (idx === null || idx === undefined || !m.nodes[idx]) return;
    m.nodes[idx].classList.add('dc-node--on');
    m.edges.forEach(function (e) {
      if (e.from !== idx && e.to !== idx) return;
      if (e.el) e.el.classList.add('dc-edge--on');
      if (e.labelEl) e.labelEl.classList.add('dc-edge-label--on');
      var other = m.nodes[e.from === idx ? e.to : e.from];
      if (other) other.classList.add('dc-node--near');
    });
  }

  /** A held trace: the marks stay AND everything outside them dims. */
  function focus(g, idx) {
    g.dcFocus = (idx === null || idx === undefined) ? null : idx;
    mark(g, g.dcFocus);
    if (g.dcFocus === null) g.classList.remove(FOCUSED); else g.classList.add(FOCUSED);
  }

  /** A passing trace: the same marks, nothing dimmed, and never over a held one. */
  function hover(g, idx) {
    if (g.dcFocus !== null && g.dcFocus !== undefined) return;
    mark(g, idx);
  }

  function nodeAt(g, target) {
    if (!target || !target.closest) return null;
    var n = target.closest('.dc-node, .dc-flow-node');
    return n && n.dcIdx !== undefined && g.contains(n) ? n : null;
  }

  function chrome(g) {
    var box = document.createElement('div');
    box.className = 'dc-graph-zoom';
    [['out', '−', 'Zoom out'], ['fit', '⤢', 'Fit'], ['in', '+', 'Zoom in']].forEach(function (spec) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'dc-graph-zoom-btn';
      b.setAttribute('data-act', spec[0]);
      b.setAttribute('aria-label', spec[2]);
      b.setAttribute('title', spec[2]);
      b.textContent = spec[1];
      box.appendChild(b);
    });
    box.addEventListener('click', function (ev) {
      var b = ev.target.closest ? ev.target.closest('[data-act]') : null;
      if (!b) return;
      var act = b.getAttribute('data-act');
      if (act === 'fit') { fit(g); return; }
      zoom(g, act === 'in' ? STEP : 1 / STEP, g.clientWidth / 2, g.clientHeight / 2);
    });
    return box;
  }

  /** Bound ONCE per graph — a re-layout rebuilds the drawing, never the handlers. */
  function bind(g) {
    if (g.dcBound) return;
    g.dcBound = true;
    var drag = null;

    g.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0 || !g.classList.contains(LAID)) return;
      if (ev.target.closest && ev.target.closest('.dc-graph-zoom')) return;
      var v = view(g);
      drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, tx: v.tx, ty: v.ty, moved: false };
    });

    g.addEventListener('pointermove', function (ev) {
      if (!drag || ev.pointerId !== drag.id) return;
      var dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (!drag.moved) {
        if (Math.abs(dx) + Math.abs(dy) < 4) return;   // a click is not a pan
        drag.moved = true;
        g.classList.add(DRAGGING);
        // Captured only once it IS a drag: capturing on pointerdown would retarget the
        // pointerup to the graph and cost every node its click.
        try { g.setPointerCapture(drag.id); } catch (err) { /* not fatal — the drag still tracks */ }
      }
      var v = view(g);
      v.tx = drag.tx + dx;
      v.ty = drag.ty + dy;
      clamp(g);
      apply(g);
      ev.preventDefault();
    });

    g.addEventListener('pointerup', function (ev) {
      if (!drag || ev.pointerId !== drag.id) return;
      var moved = drag.moved;
      try { if (moved) g.releasePointerCapture(drag.id); } catch (err) { /* already released */ }
      drag = null;
      g.classList.remove(DRAGGING);
      if (moved) return;
      var n = nodeAt(g, ev.target);
      var idx = n ? n.dcIdx : null;
      focus(g, idx !== null && g.dcFocus !== idx ? idx : null);
    });

    g.addEventListener('pointercancel', function () {
      drag = null;
      g.classList.remove(DRAGGING);
    });

    // Ctrl/⌘-wheel — which is also how a trackpad pinch arrives. A plain wheel is left to
    // the transcript it is scrolling.
    g.addEventListener('wheel', function (ev) {
      if (!ev.ctrlKey && !ev.metaKey) return;
      ev.preventDefault();
      var r = g.getBoundingClientRect();
      zoom(g, Math.exp(-ev.deltaY * 0.0022), ev.clientX - r.left, ev.clientY - r.top);
    }, { passive: false });

    g.addEventListener('mouseover', function (ev) {
      var n = nodeAt(g, ev.target);
      if (n) hover(g, n.dcIdx);
    });
    g.addEventListener('mouseout', function (ev) {
      if (nodeAt(g, ev.target)) hover(g, null);
    });

    g.addEventListener('keydown', function (ev) {
      var k = ev.key;
      var n = nodeAt(g, ev.target);
      if (n && (k === 'Enter' || k === ' ')) {
        ev.preventDefault();
        focus(g, g.dcFocus === n.dcIdx ? null : n.dcIdx);
        return;
      }
      if (k === 'Escape') { focus(g, null); return; }
      var v = view(g);
      if (k === '+' || k === '=') { ev.preventDefault(); zoom(g, STEP, g.clientWidth / 2, g.clientHeight / 2); }
      else if (k === '-' || k === '_') { ev.preventDefault(); zoom(g, 1 / STEP, g.clientWidth / 2, g.clientHeight / 2); }
      else if (k === '0') { ev.preventDefault(); fit(g); }
      else if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') {
        ev.preventDefault();
        if (k === 'ArrowLeft') v.tx += NUDGE;
        if (k === 'ArrowRight') v.tx -= NUDGE;
        if (k === 'ArrowUp') v.ty += NUDGE;
        if (k === 'ArrowDown') v.ty -= NUDGE;
        clamp(g);
        apply(g);
      }
    });
  }

  /** Back to the author's markup: the nodes return as the graph's own children, in order. */
  function clear(g) {
    g.classList.remove(LAID);
    g.classList.remove(TIGHT);
    g.classList.remove(FOCUSED);
    g.classList.remove(ZOOMED);
    g.style.height = '';
    g.dcFocus = null;
    g.dcMap = null;
    g.dcBox = null;
    g.dcView = null;
    if (g.dcStage && g.dcStage.parentNode === g) {
      kids(g.dcStage).forEach(function (el) { if (isNode(el)) g.appendChild(el); });
      g.removeChild(g.dcStage);
    }
    g.dcStage = null;
    kids(g).forEach(function (el) {
      if (el.classList.contains('dc-graph-svg') || el.classList.contains('dc-edge-label')
        || el.classList.contains('dc-graph-zoom')) g.removeChild(el);
      else if (isNode(el)) {
        el.style.left = ''; el.style.top = ''; el.style.width = '';
        el.classList.remove('dc-node--on');
        el.classList.remove('dc-node--near');
      }
    });
  }

  function measure(nodes) {
    return nodes.map(function (n) {
      var r = n.getBoundingClientRect();
      return { w: Math.ceil(r.width), h: Math.ceil(r.height) };
    });
  }

  var seq = 0;
  function layout(g) {
    clear(g);
    var W = g.clientWidth;
    var data = read(g);
    if (!data.nodes.length || !W) return;
    var r = rank(data.nodes.length, data.edges);
    var sizes = measure(data.nodes);
    data.edges.forEach(function (e) {
      if (!e.label) return;
      var probe = document.createElement('span');
      probe.className = 'dc-edge-label';
      probe.textContent = e.label;
      g.appendChild(probe);
      e.labelW = Math.ceil(probe.getBoundingClientRect().width);
      g.removeChild(probe);
    });
    var ranks = build(data.nodes, data.edges, r, sizes);
    order(ranks);
    // A chain runs left to right when the whole row measurably fits; anything that branches,
    // and any chain that would wrap, runs top down. `data-dir` may ask for either; a request
    // for a row that does not fit is refused the same way.
    var chain = ranks.every(function (rk) { return rk.length === 1; })
      && !data.edges.some(function (e) { return e.back; });
    var want = g.getAttribute('data-dir');
    var horizontal = want === 'right' || (want !== 'down' && chain);
    var labelled = data.edges.some(function (e) { return !!e.label; });
    var size = horizontal ? place(ranks, true, Infinity, labelled, false, GAP) : null;
    if (horizontal && size.w > W) { horizontal = false; size = null; }
    if (!horizontal) {
      // Natural size first; a rank too wide for the pane shrinks every label a step; a rank
      // still too wide splits into staggered lines. Never a horizontal scroll, never a clip.
      size = place(ranks, false, W, labelled, false, GAP);
      if (!size) {
        g.classList.add(TIGHT);
        sizes = measure(data.nodes);
        ranks = build(data.nodes, data.edges, r, sizes);
        order(ranks);
        size = place(ranks, false, W, labelled, false, 16) || place(ranks, false, W, labelled, true, 16);
      }
    }
    var gid = 'dcg' + (++seq);
    g.classList.add(LAID);
    // The drawing lives on a STAGE: one element to centre, pan and scale, so no node ever
    // has to know where the view is.
    var stage = document.createElement('div');
    stage.className = 'dc-graph-stage';
    var boxes = [];
    ranks.forEach(function (rk) {
      rk.forEach(function (it) {
        if (it.node === null) return;
        var n = data.nodes[it.node];
        n.style.left = it.x + 'px';
        n.style.top = it.y + 'px';
        n.style.width = it.w + 'px';
        n.dcIdx = it.node;
        if (!n.hasAttribute('tabindex')) n.setAttribute('tabindex', '0');
        stage.appendChild(n);
        boxes[it.node] = { x: it.x, y: it.y, w: it.w, h: it.h };
      });
    });
    g.dcStage = stage;
    g.appendChild(stage);
    draw(stage, data.edges, horizontal, { w: size.w, h: size.h }, gid);
    var labelBoxes = labels(stage, data.edges, boxes);
    // What the block is tall enough for and what the view centres: the nodes AND whatever
    // a label had to step outside them to stay legible.
    var box = { x: 0, y: 0, r: size.w, b: size.h };
    labelBoxes.forEach(function (l) {
      if (l.x < box.x) box.x = l.x;
      if (l.y < box.y) box.y = l.y;
      if (l.x + l.w > box.r) box.r = l.x + l.w;
      if (l.y + l.h > box.b) box.b = l.y + l.h;
    });
    g.dcBox = { x: box.x, y: box.y, w: box.r - box.x, h: box.b - box.y };
    g.dcMap = { nodes: data.nodes, edges: data.edges };
    g.dcFocus = null;
    g.style.height = g.dcBox.h + 'px';
    g.appendChild(chrome(g));
    if (!g.hasAttribute('tabindex')) g.setAttribute('tabindex', '0');
    bind(g);
    fit(g);
    g.setAttribute('data-laid-width', String(W));
  }

  function all() {
    return [].slice.call(document.querySelectorAll('.dc-graph, .dc-flow'));
  }
  function layoutAll() { all().forEach(layout); }

  function start() {
    layoutAll();
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function (entries) {
        entries.forEach(function (en) {
          var g = en.target;
          if (String(g.clientWidth) !== g.getAttribute('data-laid-width')) layout(g);
        });
      });
      all().forEach(function (g) { ro.observe(g); });
    }
    // The embedded reading face lands after first paint and changes every node's width.
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(layoutAll);
    window.addEventListener('load', layoutAll);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
