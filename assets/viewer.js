// The 3D viewer. Each piece is built as a real mesh: the cut-out front and back are puffed out into a soft
// body (thicker in the middle, thin at the edges), lit, and turned freely with a drag. Pinch or scroll zooms.
(function () {
  var dlg = document.getElementById('viewer');
  if (!dlg) return;
  var stage = dlg.querySelector('.viewer__stage'), canvas = dlg.querySelector('canvas');
  var nameEl = dlg.querySelector('.viewer__name'), priceEl = dlg.querySelector('.viewer__price');
  var factsEl = dlg.querySelector('.viewer__facts'), hint = dlg.querySelector('.viewer__hint');
  var picks = dlg.querySelector('.viewer__picks'), flat = dlg.querySelector('.viewer__flat');
  var still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var PLAIN = { bone: '#dccfbe', black: '#171615' };

  // the pieces, read from the collection tiles so the viewer never drifts from the page
  var items = [];
  document.querySelectorAll('#collection .tile').forEach(function (tile) {
    var spin = tile.querySelector('[data-spin]');
    if (!spin) return;
    var name = tile.querySelector('h3').textContent, price = tile.querySelector('.tile__price').textContent;
    var swatches = tile.querySelectorAll('.swatch'), first = items.length;
    if (swatches.length) {
      swatches.forEach(function (s) {
        items.push({ name: name, price: price, facts: s.dataset.name + ' fleece, cuffed ankle', label: name + ', ' + s.dataset.name.toLowerCase(),
          front: s.dataset.src, back: null, tone: s.dataset.tone, swatch: s });
      });
    } else {
      items.push({ name: name, price: price, facts: tile.querySelector('.tile__facts').textContent, label: name,
        front: spin.querySelector('.spin__face').getAttribute('src'), back: spin.dataset.back || null, tone: spin.dataset.tone });
    }
    function pickIndex() {
      for (var i = first; i < items.length; i++) if (items[i].swatch && items[i].swatch.getAttribute('aria-pressed') === 'true') return i;
      return first;
    }
    var btn = tile.querySelector('.spin__open');
    if (btn) btn.addEventListener('click', function () { open(pickIndex()); });
    // a plain click on the piece opens it too; a drag only turns it in place
    var x0 = 0, y0 = 0;
    spin.addEventListener('pointerdown', function (e) { x0 = e.clientX; y0 = e.clientY; });
    spin.addEventListener('click', function (e) {
      if (e.target === btn) return;
      if (Math.abs(e.clientX - x0) < 6 && Math.abs(e.clientY - y0) < 6) open(pickIndex());
    });
  });

  items.forEach(function (it, i) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'viewer__pick'; b.setAttribute('aria-label', it.label); b.setAttribute('aria-pressed', 'false');
    var im = new Image(); im.src = it.front; im.alt = ''; im.draggable = false; b.appendChild(im);
    b.addEventListener('click', function () { show(i); });
    picks.appendChild(b); it.button = b;
  });

  var libP, T, renderer, scene, camera, model, raf = 0, current = -1, token = 0;
  var yaw = 0, pitch = 0, vyaw = 0, zoom = 1, ar = 1, lastTouch = 0, held = false;

  function lib() {
    return libP || (libP = new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = 'assets/vendor/three.min.js';
      s.onload = function () { res(window.THREE); }; s.onerror = rej; document.head.appendChild(s);
    }));
  }
  function load(src) {
    return new Promise(function (res, rej) { var im = new Image(); im.onload = function () { res(im); }; im.onerror = rej; im.src = src; });
  }
  function size(src) { return [src.naturalWidth || src.width, src.naturalHeight || src.height]; }

  // how far each cell of the cut-out sits from its edge, turned into a rounded thickness
  function heights(src) {
    var wh = size(src), cw = 210, ch = Math.round(cw * wh[1] / wh[0]);
    var c = document.createElement('canvas'); c.width = cw; c.height = ch;
    var g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(src, 0, 0, cw, ch);
    var a = g.getImageData(0, 0, cw, ch).data, d = new Float32Array(cw * ch), x, y, i, BIG = 1e4;
    for (i = 0; i < cw * ch; i++) d[i] = a[i * 4 + 3] > 110 ? BIG : 0;
    function at(px, py) { return px < 0 || py < 0 || px >= cw || py >= ch ? 0 : d[py * cw + px]; }
    for (y = 0; y < ch; y++) for (x = 0; x < cw; x++) { i = y * cw + x; if (d[i]) d[i] = Math.min(d[i], at(x - 1, y) + 1, at(x, y - 1) + 1, at(x - 1, y - 1) + 1.41, at(x + 1, y - 1) + 1.41); }
    for (y = ch - 1; y >= 0; y--) for (x = cw - 1; x >= 0; x--) { i = y * cw + x; if (d[i]) d[i] = Math.min(d[i], at(x + 1, y) + 1, at(x, y + 1) + 1, at(x + 1, y + 1) + 1.41, at(x - 1, y + 1) + 1.41); }
    var R = cw * 0.16, depth = 0.15 * Math.min(1, (wh[0] / wh[1]) / 0.8), z = new Float32Array(cw * ch);
    for (i = 0; i < cw * ch; i++) { var t = 1 - Math.min(d[i] / R, 1); z[i] = depth * Math.sqrt(1 - t * t); }
    var SEAL = 0.03;   // the two halves overlap a little at the outline, so no gap shows at the seam
    for (var pass = 0; pass < 3; pass++) {       // soften the steps: a box blur across, then down
      var o = new Float32Array(cw * ch), r = 3, k, sum, n;
      for (y = 0; y < ch; y++) for (x = 0; x < cw; x++) {
        sum = 0; n = 0;
        for (k = -r; k <= r; k++) if (x + k >= 0 && x + k < cw) { sum += z[y * cw + x + k]; n++; }
        o[y * cw + x] = sum / n;
      }
      for (y = 0; y < ch; y++) for (x = 0; x < cw; x++) {
        sum = 0; n = 0;
        for (k = -r; k <= r; k++) if (y + k >= 0 && y + k < ch) { sum += o[(y + k) * cw + x]; n++; }
        z[y * cw + x] = sum / n;
      }
    }
    for (i = 0; i < cw * ch; i++) z[i] -= SEAL;
    return { cw: cw, ch: ch, z: z };
  }
  // the back of a piece that was only drawn from the front: the same outline, mirrored, with the print and
  // cords taken out by a median filter so only the fabric and its shading are left
  function plainBack(img, tone) {
    var wh = size(img), sw = 120, sh = Math.round(sw * wh[1] / wh[0]), R = 9;
    var small = document.createElement('canvas'); small.width = sw; small.height = sh;
    var sg = small.getContext('2d', { willReadFrequently: true });
    sg.translate(sw, 0); sg.scale(-1, 1); sg.drawImage(img, 0, 0, sw, sh); sg.setTransform(1, 0, 0, 1, 0, 0);
    var id = sg.getImageData(0, 0, sw, sh), a = id.data, out = new Uint8ClampedArray(a.length), x, y, dx, dy, list = [];
    var base = PLAIN[tone] || PLAIN.bone, fill = [parseInt(base.slice(1, 3), 16), parseInt(base.slice(3, 5), 16), parseInt(base.slice(5, 7), 16)];
    for (y = 0; y < sh; y++) for (x = 0; x < sw; x++) {
      list.length = 0;
      for (dy = -R; dy <= R; dy += 2) for (dx = -R; dx <= R; dx += 2) {
        var px = x + dx, py = y + dy; if (px < 0 || py < 0 || px >= sw || py >= sh) continue;
        var j = (py * sw + px) * 4; if (a[j + 3] > 200) list.push(a[j] + a[j + 1] + a[j + 2]);
      }
      var o = (y * sw + x) * 4, lum;
      if (list.length) { list.sort(function (p, q) { return p - q; }); lum = list[list.length >> 1] / 3; }
      else lum = (fill[0] + fill[1] + fill[2]) / 3;
      var scale = lum / ((fill[0] + fill[1] + fill[2]) / 3);      // keep the fabric colour, carry over the light and shade
      out[o] = fill[0] * scale; out[o + 1] = fill[1] * scale; out[o + 2] = fill[2] * scale; out[o + 3] = 255;
    }
    id.data.set(out); sg.putImageData(id, 0, 0);
    var c = document.createElement('canvas'); c.width = wh[0]; c.height = wh[1];
    var g = c.getContext('2d');
    g.translate(wh[0], 0); g.scale(-1, 1); g.drawImage(img, 0, 0); g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-in'; g.imageSmoothingQuality = 'high'; g.drawImage(small, 0, 0, wh[0], wh[1]);
    return c;
  }
  function shell(src, tone) {
    var hf = heights(src), wh = size(src);
    var geo = new T.PlaneGeometry(2 * wh[0] / wh[1], 2, hf.cw - 1, hf.ch - 1), pos = geo.attributes.position;
    for (var i = 0; i < pos.count; i++) pos.setZ(i, hf.z[i]);
    geo.computeVertexNormals();
    var tex = new T.Texture(src); tex.encoding = T.sRGBEncoding; tex.anisotropy = renderer.capabilities.getMaxAnisotropy(); tex.needsUpdate = true;
    var mat = new T.MeshPhongMaterial({ map: tex, alphaTest: 0.5, shininess: tone === 'black' ? 7 : 4,
      specular: new T.Color(tone === 'black' ? 0x191715 : 0x0c0b0a) });
    return new T.Mesh(geo, mat);
  }
  function clear() {
    if (!model) return;
    model.children.forEach(function (m) { m.geometry.dispose(); m.material.map.dispose(); m.material.dispose(); });
    scene.remove(model); model = null;
  }
  function setup() {
    renderer = new T.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
    renderer.outputEncoding = T.sRGBEncoding; renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    scene = new T.Scene(); camera = new T.PerspectiveCamera(30, 1, 0.1, 50);
    scene.add(new T.AmbientLight(0xffffff, 0.66));
    var key = new T.DirectionalLight(0xffffff, 0.5); key.position.set(-1.6, 2.2, 4); scene.add(key);
    var rim = new T.DirectionalLight(0xffffff, 0.18); rim.position.set(3, 0.5, 1.5); scene.add(rim);
  }
  function fit() {
    var w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h || !renderer) return;
    renderer.setSize(w, h, false); camera.aspect = w / h;
    var tan = Math.tan(15 * Math.PI / 180), reach = Math.max(1, ar) * 1.12;   // room to turn without clipping
    camera.position.z = Math.max(1.22 / tan, reach / (tan * camera.aspect)) * zoom;
    camera.updateProjectionMatrix();
  }
  function frame(t) {
    raf = dlg.open ? requestAnimationFrame(frame) : 0;
    if (!model) return;
    if (!held) {
      if (Math.abs(vyaw) > 0.0004) { yaw += vyaw; vyaw *= 0.94; }
      else if (!still && t - lastTouch > 2200) yaw += 0.006;        // drifts round on its own when left alone
    }
    model.rotation.set(pitch, yaw, 0);
    renderer.render(scene, camera);
  }

  function show(i) {
    var it = items[i], mine = ++token;
    current = i;
    items.forEach(function (o, k) { o.button.setAttribute('aria-pressed', String(k === i)); });
    nameEl.textContent = it.name; priceEl.textContent = it.price; factsEl.textContent = it.facts;
    hint.textContent = 'Loading';
    flat.hidden = true;
    Promise.all([lib(), load(it.front), it.back ? load(it.back) : null]).then(function (r) {
      if (mine !== token) return;
      T = r[0];
      if (!renderer) setup();
      clear();
      var front = r[1], wh = size(front);
      ar = wh[0] / wh[1];
      model = new T.Group();
      model.add(shell(front, it.tone));
      var back = shell(r[2] || plainBack(front, it.tone), it.tone); back.rotation.y = Math.PI; model.add(back);
      scene.add(model);
      yaw = -0.5; pitch = 0.06; vyaw = 0; zoom = 1; lastTouch = performance.now() - 1200;
      fit();
      hint.textContent = it.back ? 'Drag to rotate. Scroll or pinch to zoom.' : 'Drag to rotate. The back of this piece is plain.';
      if (!raf) raf = requestAnimationFrame(frame);
    }).catch(function () {          // no WebGL or a blocked file: show the piece flat instead of nothing
      if (mine !== token) return;
      flat.src = it.front; flat.alt = it.label; flat.hidden = false; hint.textContent = '3D is not available in this browser.';
    });
  }
  function open(i) {
    if (!dlg.open) dlg.showModal();
    show(i);
  }
  window.mtOpenViewer = open;

  // drag to rotate, with a throw; two fingers or the wheel to zoom
  var pts = {}, pinch = 0;
  function count() { return Object.keys(pts).length; }
  function spread() { var k = Object.keys(pts); return Math.hypot(pts[k[0]].x - pts[k[1]].x, pts[k[0]].y - pts[k[1]].y); }
  stage.addEventListener('pointerdown', function (e) {
    pts[e.pointerId] = { x: e.clientX, y: e.clientY }; stage.setPointerCapture(e.pointerId);
    held = true; vyaw = 0; stage.classList.add('is-held');
    if (count() === 2) pinch = spread();
  });
  stage.addEventListener('pointermove', function (e) {
    var p = pts[e.pointerId]; if (!p) return;
    var dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
    if (count() === 2) { var s = spread(); if (pinch) zoom = Math.max(0.55, Math.min(1.5, zoom * pinch / s)); pinch = s; fit(); return; }
    yaw += dx * 0.011; vyaw = dx * 0.011;
    pitch = Math.max(-0.75, Math.min(0.75, pitch + dy * 0.007));
  });
  function up(e) {
    delete pts[e.pointerId]; pinch = 0;
    if (!count()) { held = false; stage.classList.remove('is-held'); lastTouch = performance.now(); if (still) vyaw = 0; }
  }
  stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
  stage.addEventListener('wheel', function (e) {
    e.preventDefault(); zoom = Math.max(0.55, Math.min(1.5, zoom * (e.deltaY > 0 ? 1.08 : 0.926))); lastTouch = performance.now(); fit();
  }, { passive: false });
  stage.addEventListener('dblclick', function () { yaw = 0; pitch = 0; zoom = 1; vyaw = 0; fit(); });
  dlg.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft') { yaw -= 0.3; lastTouch = performance.now(); }
    if (e.key === 'ArrowRight') { yaw += 0.3; lastTouch = performance.now(); }
  });
  window.addEventListener('resize', fit);
  dlg.addEventListener('close', function () { token++; cancelAnimationFrame(raf); raf = 0; });
})();
