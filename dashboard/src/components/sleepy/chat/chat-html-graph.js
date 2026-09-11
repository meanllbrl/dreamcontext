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
 * every edge as one smooth SVG path with an arrowhead and its label at the midpoint. It
 * re-lays on width change, so one block is right at 380px and in the fullscreen deck.
 *
 * It stays inside the block: no message out, no network, no host. Everything it
 * touches is markup the author already wrote, plus the `<svg>` and label spans it adds.
 * Before it runs — or when it cannot — the nodes are plain inline chips in written order:
 * a legible degradation, never a blank.
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
      // The label of a routed edge sits ON its middle waypoint, so that waypoint is as wide
      // as the label: the rank makes room for it instead of the label landing on a node.
      if (e.labelW && path.length > 2) {
        var mid = path[Math.floor(path.length / 2)];
        if (mid.node === null) mid.w = Math.max(mid.w, e.labelW + 8);
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

  function draw(g, edges, horizontal, size, gid) {
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
    var labels = [];
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
      if (e.label) {
        var mid = pts.length === 2
          ? { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }
          : pts[Math.floor(pts.length / 2)];
        labels.push({ x: mid.x, y: mid.y, text: e.label });
      }
    });
    g.insertBefore(svg, g.firstChild);
    labels.forEach(function (l) {
      var s = document.createElement('span');
      s.className = 'dc-edge-label';
      s.textContent = l.text;
      s.style.left = l.x + 'px';
      s.style.top = l.y + 'px';
      g.appendChild(s);
    });
  }

  function clear(g) {
    g.classList.remove(LAID);
    g.classList.remove(TIGHT);
    g.style.height = '';
    kids(g).forEach(function (el) {
      if (el.classList.contains('dc-graph-svg') || el.classList.contains('dc-edge-label')) g.removeChild(el);
      else if (isNode(el)) { el.style.left = ''; el.style.top = ''; el.style.width = ''; }
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
    g.style.height = size.h + 'px';
    ranks.forEach(function (rk) {
      rk.forEach(function (it) {
        if (it.node === null) return;
        var n = data.nodes[it.node];
        n.style.left = it.x + 'px';
        n.style.top = it.y + 'px';
        n.style.width = it.w + 'px';
      });
    });
    draw(g, data.edges, horizontal, { w: Math.max(size.w, W), h: size.h }, gid);
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
