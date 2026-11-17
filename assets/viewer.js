// The 3D viewer. Each piece is built as one solid body: the front and back share a single outline, are
// puffed out into a rounded form, and meet at a sealed seam. Drag turns it freely; pinch or scroll zooms.
(function () {
  var dlg = document.getElementById('viewer');
  if (!dlg) return;
  var stage = dlg.querySelector('.viewer__stage'), canvas = dlg.querySelector('canvas');
  var nameEl = dlg.querySelector('.viewer__name'), priceEl = dlg.querySelector('.viewer__price');
  var factsEl = dlg.querySelector('.viewer__facts'), hint = dlg.querySelector('.viewer__hint');
  var picks = dlg.querySelector('.viewer__picks'), flat = dlg.querySelector('.viewer__flat');
  var still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // how full each kind of piece is: depth is half the body's thickness (the piece is 2 units tall),
  // round is how far in from the outline the body keeps rising, as a share of the picture's width
  // Real proportions. A worn torso is about 0.4 times as deep as it is wide; a sleeve or leg is a round tube,
  // about 0.62 times its flat width deep; a beanie is nearly as deep as it is wide. Parts in between blend.
  // kBig applies to wide parts (the torso, the waist), kSmall to narrow ones (sleeves, legs, hood), split at
  // half-widths of `small` and `big` (the piece is 2 units tall). depth caps the half-depth.
  var FORMS = {
    top:    { depth: 0.24, kBig: 0.4, kSmall: 0.62, small: 0.14, big: 0.34 },
    pants:  { depth: 0.16, kBig: 0.42, kSmall: 0.62, small: 0.12, big: 0.3 },
    beanie: { depth: 0.62, kBig: 0.85, kSmall: 0.85, small: 0.2, big: 0.5 }
  };
  function formOf(name) { return /beanie/i.test(name) ? 'beanie' : /pants/i.test(name) ? 'pants' : 'top'; }

  // the pieces, read from the collection tiles so the viewer never drifts from the page
  var items = [];
  document.querySelectorAll('#collection .tile').forEach(function (tile) {
    var spin = tile.querySelector('[data-spin]');
    if (!spin) return;
    var name = tile.querySelector('h3').textContent, price = tile.querySelector('.tile__price').textContent;
    var swatches = tile.querySelectorAll('.swatch'), first = items.length;
    if (swatches.length) {
      swatches.forEach(function (s) {
        items.push({ name: name, price: price, facts: s.dataset.facts, label: name + ', ' + s.dataset.name.toLowerCase(),
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

  var libP, T, renderer, scene, camera, model, floor, raf = 0, token = 0;
  var yaw = 0, pitch = 0, vyaw = 0, zoom = 1, ar = 1, lastTouch = 0, held = false;

  // Sculpted models, when there are any: a GLB file per piece in models/, keyed by the item's label.
  // A piece without one is built from its mockups as below.
  var MODELS = {
    // 'Signature Tee': 'models/signature-tee.glb',
  };
  var loaderP;
  function gltf() {
    return loaderP || (loaderP = new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = 'assets/vendor/GLTFLoader.js';
      s.onload = function () { res(new T.GLTFLoader()); }; s.onerror = rej; document.head.appendChild(s);
    }));
  }
  function sculpted(url) {           // load a GLB, stand it up 2 units tall and centred on the turning axis
    return gltf().then(function (loader) {
      return new Promise(function (res, rej) { loader.load(url, function (g) { res(g.scene); }, null, rej); });
    }).then(function (obj) {
      var box = new T.Box3().setFromObject(obj), size = box.getSize(new T.Vector3()), c = box.getCenter(new T.Vector3());
      var k = 2 / size.y;
      obj.position.sub(c); var holder = new T.Group(); holder.add(obj); holder.scale.setScalar(k);
      obj.traverse(function (m) { if (m.isMesh && m.material) { m.material.side = T.DoubleSide; if (m.material.map) m.material.map.encoding = T.sRGBEncoding; } });
      ar = size.x / size.y;
      return holder;
    });
  }
  function lib() {
    return libP || (libP = new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = 'assets/vendor/three.min.js';
      s.onload = function () { res(window.THREE); }; s.onerror = rej; document.head.appendChild(s);
    }));
  }
  function load(src) {
    return new Promise(function (res, rej) { var im = new Image(); im.onload = function () { res(im); }; im.onerror = rej; im.src = src; });
  }

  // ---------- picture work: all on plain canvases, at the size of the front picture ----------
  function blank(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function pixels(c) { return c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height); }
  function drawn(src, w, h, flip) {
    var c = blank(w, h), g = c.getContext('2d', { willReadFrequently: true });
    if (flip) { g.translate(w, 0); g.scale(-1, 1); }
    g.drawImage(src, 0, 0, w, h);
    return c;
  }
  function solidMask(id, cut) {            // 1 where the picture is solid
    var n = id.width * id.height, m = new Uint8Array(n);
    for (var i = 0; i < n; i++) m[i] = id.data[i * 4 + 3] > cut ? 1 : 0;
    return m;
  }
  function flipMask(m, w, h) {
    var o = new Uint8Array(w * h);
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) o[y * w + x] = m[y * w + (w - 1 - x)];
    return o;
  }
  function shrink(m, w, h, r, grow) {      // erode by r pixels (or dilate when grow is set)
    var a = m, b, x, y, k, v, pass;
    for (pass = 0; pass < 2; pass++) {
      b = new Uint8Array(w * h);
      for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
        v = grow ? 0 : 1;
        for (k = -r; k <= r; k++) {
          var px = pass ? x : x + k, py = pass ? y + k : y;
          var s = px < 0 || py < 0 || px >= w || py >= h ? 0 : a[py * w + px];
          if (grow ? s : !s) { v = grow ? 1 : 0; break; }
        }
        b[y * w + x] = v;
      }
      a = b;
    }
    return a;
  }
  function box(m, w, h) {
    var x0 = w, x1 = 0, y0 = h, y1 = 0;
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) if (m[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return [x0, y0, x1 + 1, y1 + 1];
  }
  // Fabric everywhere: drop the faint fringe around a cut-out and spread the nearest fabric colour into every
  // empty pixel, so wherever the shared outline reaches past this picture there is cloth, not a hole.
  function fabric(c) {
    var w = c.width, h = c.height, id = pixels(c), d = id.data, keep = shrink(solidMask(id, 215), w, h, 10);
    var q = 4, sw = Math.ceil(w / q), sh = Math.ceil(h / q), n = sw * sh, col = new Float32Array(n * 3), has = new Uint8Array(n), cnt = new Uint16Array(n), x, y, i, j;
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      if (!keep[y * w + x]) continue;
      i = (y / q | 0) * sw + (x / q | 0); j = (y * w + x) * 4;
      col[i * 3] += d[j]; col[i * 3 + 1] += d[j + 1]; col[i * 3 + 2] += d[j + 2]; cnt[i]++;
    }
    for (i = 0; i < n; i++) if (cnt[i]) { col[i * 3] /= cnt[i]; col[i * 3 + 1] /= cnt[i]; col[i * 3 + 2] /= cnt[i]; has[i] = 1; }
    for (var pass = 0; pass < 220; pass++) {
      var add = [], any = false;
      for (y = 0; y < sh; y++) for (x = 0; x < sw; x++) {
        i = y * sw + x; if (has[i]) continue;
        var r = 0, g = 0, b = 0, k = 0, nb = [x > 0 ? i - 1 : -1, x < sw - 1 ? i + 1 : -1, y > 0 ? i - sw : -1, y < sh - 1 ? i + sw : -1];
        for (var t = 0; t < 4; t++) if (nb[t] >= 0 && has[nb[t]]) { r += col[nb[t] * 3]; g += col[nb[t] * 3 + 1]; b += col[nb[t] * 3 + 2]; k++; }
        if (k) add.push(i, r / k, g / k, b / k);
      }
      for (t = 0; t < add.length; t += 4) { i = add[t]; col[i * 3] = add[t + 1]; col[i * 3 + 1] = add[t + 2]; col[i * 3 + 2] = add[t + 3]; has[i] = 1; any = true; }
      if (!any) break;
    }
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      j = (y * w + x) * 4;
      if (!keep[y * w + x]) {               // blend the four nearest fill cells so the spread colour has no blocks
        var fx = Math.min(sw - 1.001, Math.max(0, x / q - 0.5)), fy = Math.min(sh - 1.001, Math.max(0, y / q - 0.5));
        var ix = fx | 0, iy = fy | 0, ux = fx - ix, uy = fy - iy, i00 = (iy * sw + ix) * 3, i10 = i00 + 3, i01 = i00 + sw * 3, i11 = i01 + 3;
        for (var ch2 = 0; ch2 < 3; ch2++)
          d[j + ch2] = (col[i00 + ch2] * (1 - ux) + col[i10 + ch2] * ux) * (1 - uy) + (col[i01 + ch2] * (1 - ux) + col[i11 + ch2] * ux) * uy;
      }
      d[j + 3] = 255;
    }
    return id;
  }
  function clothColour(id, mask) {           // the typical fabric colour: the middle of the inside pixels by brightness
    var d = id.data, list = [], i;
    for (i = 0; i < mask.length; i += 7) if (mask[i]) list.push(i);
    list.sort(function (a, b) { return (d[a * 4] + d[a * 4 + 1] + d[a * 4 + 2]) - (d[b * 4] + d[b * 4 + 1] + d[b * 4 + 2]); });
    var mid = list.slice(Math.floor(list.length * 0.35), Math.ceil(list.length * 0.65)), c = [0, 0, 0];
    mid.forEach(function (k) { c[0] += d[k * 4]; c[1] += d[k * 4 + 1]; c[2] += d[k * 4 + 2]; });
    return c.map(function (v) { return v / Math.max(1, mid.length); });
  }
  function cutTo(id, mask, base) {               // the shared outline, with a one pixel soft edge
    var w = id.width, h = id.height, d = id.data, x, y, k;
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      var s = 0, c = 0;
      for (k = -1; k <= 1; k++) for (var l = -1; l <= 1; l++) {
        var px = x + l, py = y + k; if (px < 0 || py < 0 || px >= w || py >= h) { c++; continue; }
        s += mask[py * w + px]; c++;
      }
      d[(y * w + x) * 4 + 3] = 255;   // fully opaque: the mesh gives the shape, and see-through pixels lose their colour on upload
    }
    // Toward the outline the picture is seen edge-on and smears, and front and back pictures differ in tone, so
    // fade into one shared cloth colour there: the sides read as one even piece of fabric.
    var soft = new Float32Array(w * h), tmp = new Float32Array(w * h), r = 26, sum, n, k2;
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) soft[y * w + x] = mask[y * w + x];
    for (var pass = 0; pass < 2; pass++) {
      for (y = 0; y < h; y++) { sum = 0; for (k2 = -r; k2 <= r; k2++) sum += x0v(soft, y, k2); for (x = 0; x < w; x++) { tmp[y * w + x] = sum / (2 * r + 1); sum += x0v(soft, y, x + r + 1) - x0v(soft, y, x - r); } }
      for (x = 0; x < w; x++) { sum = 0; for (k2 = -r; k2 <= r; k2++) sum += y0v(tmp, k2, x); for (y = 0; y < h; y++) { soft[y * w + x] = sum / (2 * r + 1); sum += y0v(tmp, y + r + 1, x) - y0v(tmp, y - r, x); } }
    }
    function x0v(a, yy, xx) { return xx < 0 || xx >= w ? 0 : a[yy * w + xx]; }
    function y0v(a, yy, xx) { return yy < 0 || yy >= h ? 0 : a[yy * w + xx]; }
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      var e = Math.min(1, Math.max(0, (soft[y * w + x] - 0.5) * 2)), t2 = e * e * (3 - 2 * e), f = 0.9 + 0.1 * t2, j2 = (y * w + x) * 4;
      for (var c2 = 0; c2 < 3; c2++) d[j2 + c2] = (base[c2] + (d[j2 + c2] - base[c2]) * t2) * f;
    }
    var out = blank(w, h); out.getContext('2d').putImageData(id, 0, 0);
    return out;
  }
  // A back for a piece that was only drawn from the front: the mirrored front with its print lifted out.
  // Print pixels are the ones far brighter or darker than the cloth around them; each is refilled from the
  // cloth just above and below it, which keeps the knit or fleece texture running through.
  function unprinted(c) {
    var w = c.width, h = c.height, id = pixels(c), d = id.data, q = 6, sw = Math.ceil(w / q), sh = Math.ceil(h / q), x, y, i, j;
    var lum = new Float32Array(sw * sh), ok = new Uint8Array(sw * sh);
    for (y = 0; y < sh; y++) for (x = 0; x < sw; x++) {
      j = (Math.min(h - 1, y * q + 3) * w + Math.min(w - 1, x * q + 3)) * 4;
      if (d[j + 3] > 200) { lum[y * sw + x] = (d[j] + d[j + 1] + d[j + 2]) / 3; ok[y * sw + x] = 1; }
    }
    var med = new Float32Array(sw * sh), list = [], R = 9;
    for (y = 0; y < sh; y++) for (x = 0; x < sw; x++) {
      list.length = 0;
      for (var dy = -R; dy <= R; dy += 2) for (var dx = -R; dx <= R; dx += 2) {
        var px = x + dx, py = y + dy; if (px < 0 || py < 0 || px >= sw || py >= sh || !ok[py * sw + px]) continue;
        list.push(lum[py * sw + px]);
      }
      list.sort(function (a, b) { return a - b; });
      med[y * sw + x] = list.length ? list[list.length >> 1] : -1;
    }
    var mark = new Uint8Array(w * h);
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      j = (y * w + x) * 4; if (d[j + 3] < 200) continue;
      var m = med[(y / q | 0) * sw + (x / q | 0)];
      if (m >= 0 && Math.abs((d[j] + d[j + 1] + d[j + 2]) / 3 - m) > 60) mark[y * w + x] = 1;
    }
    mark = shrink(mark, w, h, 5, true);
    var src = new Uint8ClampedArray(d);
    function good(px, py) { return py >= 0 && py < h && !mark[py * w + px] && src[(py * w + px) * 4 + 3] > 200; }
    for (x = 0; x < w; x++) {
      y = 0;
      while (y < h) {
        if (!mark[y * w + x]) { y++; continue; }
        var y0 = y; while (y < h && mark[y * w + x]) y++;
        var y1 = y - 1, len = y1 - y0 + 1;
        for (var yy = y0; yy <= y1; yy++) {
          var up = y0 - 1 - (yy - y0), dn = y1 + 1 + (y1 - yy), t = (yy - y0 + 0.5) / len;
          var gu = good(x, up), gd = good(x, dn);
          if (!gu && !gd) { up = y0 - 1; dn = y1 + 1; gu = good(x, up); gd = good(x, dn); if (!gu && !gd) continue; }
          if (!gu) t = 1; if (!gd) t = 0;
          var a = (up * w + x) * 4, b = (dn * w + x) * 4; j = (yy * w + x) * 4;
          for (var ch = 0; ch < 3; ch++) d[j + ch] = (gu ? src[a + ch] * (1 - t) : 0) + (gd ? src[b + ch] * t : 0);
        }
      }
    }
    var out = blank(w, h); out.getContext('2d').putImageData(id, 0, 0);
    return out;
  }

  // the two faces of one body: textures cut to the same outline, front as drawn and back as seen from behind
  function faces(frontImg, backImg) {
    var w = frontImg.naturalWidth, h = frontImg.naturalHeight;
    var f = drawn(frontImg, w, h), fm = solidMask(pixels(f), 128), fmBack = flipMask(fm, w, h), b, bm;
    if (backImg) {
      // stretch the drawn back so it fills the same box as the front does when seen from behind
      var raw = drawn(backImg, w, h), rb = box(solidMask(pixels(raw), 128), w, h), tb = box(fmBack, w, h);
      b = blank(w, h);
      b.getContext('2d', { willReadFrequently: true }).drawImage(raw, rb[0], rb[1], rb[2] - rb[0], rb[3] - rb[1], tb[0], tb[1], tb[2] - tb[0], tb[3] - tb[1]);
      bm = solidMask(pixels(b), 128);
      for (var i = 0; i < w * h; i++) bm[i] = bm[i] | fmBack[i];        // one outline for both faces
    } else {
      b = unprinted(drawn(frontImg, w, h, true));
      bm = fmBack;
    }
    bm = shrink(bm, w, h, 1);
    var fmAll = flipMask(bm, w, h);
    var fF = fabric(f), fB = fabric(b), base = clothColour(fF, fmAll);
    return { w: w, h: h, front: cutTo(fF, fmAll, base), back: cutTo(fB, bm, base), frontMask: fmAll, backMask: bm };
  }

  // how far each point sits from the outline, turned into a rounded thickness
  function heights(mask, w, h, form) {
    var cw = 300, ch = Math.round(cw * h / w), d = new Float32Array(cw * ch), x, y, i, BIG = 1e4;
    for (y = 0; y < ch; y++) for (x = 0; x < cw; x++) {
      var px = Math.round(x / (cw - 1) * (w - 1)), py = Math.round(y / (ch - 1) * (h - 1));
      d[y * cw + x] = mask[py * w + px] ? BIG : 0;
    }
    function at(px, py) { return px < 0 || py < 0 || px >= cw || py >= ch ? 0 : d[py * cw + px]; }
    for (y = 0; y < ch; y++) for (x = 0; x < cw; x++) { i = y * cw + x; if (d[i]) d[i] = Math.min(d[i], at(x - 1, y) + 1, at(x, y - 1) + 1, at(x - 1, y - 1) + 1.41, at(x + 1, y - 1) + 1.41); }
    for (y = ch - 1; y >= 0; y--) for (x = cw - 1; x >= 0; x--) { i = y * cw + x; if (d[i]) d[i] = Math.min(d[i], at(x + 1, y) + 1, at(x, y + 1) + 1, at(x + 1, y + 1) + 1.41, at(x - 1, y + 1) + 1.41); }
    function soften(a, r, passes) {            // a box blur across, then down
      for (var pass = 0; pass < passes; pass++) {
        var o = new Float32Array(cw * ch), k, sum, n;
        for (y = 0; y < ch; y++) for (x = 0; x < cw; x++) {
          sum = 0; n = 0;
          for (k = -r; k <= r; k++) if (x + k >= 0 && x + k < cw) { sum += a[y * cw + x + k]; n++; }
          o[y * cw + x] = sum / n;
        }
        for (y = 0; y < ch; y++) for (x = 0; x < cw; x++) {
          sum = 0; n = 0;
          for (k = -r; k <= r; k++) if (y + k >= 0 && y + k < ch) { sum += o[(y + k) * cw + x]; n++; }
          a[y * cw + x] = sum / n;
        }
      }
    }
    // Sculpt by inflation. Every point inside the outline belongs to the widest circle that fits inside the
    // outline and covers it: the torso's circle is big, a sleeve's or a leg's is small. Each point is then
    // raised to the surface of a tube of that radius, so the torso becomes round, the sleeves and legs become
    // tubes, the beanie a dome, and every part closes smoothly at its own edge.
    var R = new Float32Array(cw * ch), xx, yy;
    for (y = 1; y < ch - 1; y++) for (x = 1; x < cw - 1; x++) {
      i = y * cw + x; var r = d[i];
      if (r < 1.5) continue;
      if (r < d[i - 1] || r < d[i + 1] || r < d[i - cw] || r < d[i + cw] ||
          r < d[i - cw - 1] || r < d[i - cw + 1] || r < d[i + cw - 1] || r < d[i + cw + 1]) continue;   // medial points only
      var r2 = r * r, ri = Math.ceil(r);
      for (yy = Math.max(0, y - ri); yy <= Math.min(ch - 1, y + ri); yy++) for (xx = Math.max(0, x - ri); xx <= Math.min(cw - 1, x + ri); xx++) {
        var dx = xx - x, dy = yy - y;
        if (dx * dx + dy * dy <= r2 && R[yy * cw + xx] < r) R[yy * cw + xx] = r;
      }
    }
    for (i = 0; i < cw * ch; i++) if (d[i] > 0 && R[i] < d[i]) R[i] = d[i];
    soften(R, 3, 2);                             // parts flow into each other instead of meeting at a step
    var unit = (2 * w / h) / (cw - 1), z = new Float32Array(cw * ch);
    for (i = 0; i < cw * ch; i++) {
      if (d[i] <= 0) { z[i] = -0.006; continue; }
      var rr = Math.max(R[i], d[i]), q = Math.min(d[i], rr);
      var half = rr * unit, mix = Math.min(1, Math.max(0, (half - form.small) / (form.big - form.small)));
      var k = form.kSmall + (form.kBig - form.kSmall) * mix * mix * (3 - 2 * mix);
      z[i] = Math.min(form.depth, k * unit * Math.sqrt(Math.max(0, rr * rr - (rr - q) * (rr - q))));
    }
    soften(z, 1, 2);
    for (i = 0; i < cw * ch; i++) z[i] = d[i] > 0 ? z[i] - 0.006 : -0.006;
    var inside = new Uint8Array(cw * ch); for (i = 0; i < cw * ch; i++) inside[i] = d[i] > 0 ? 1 : 0;
    return { cw: cw, ch: ch, z: z, inside: inside };
  }
  // the folds and seams of the picture, without the fine weave: a soft copy used as a bump map, so the
  // big shapes catch the light as the piece turns but the surface doesn't look gritty
  function folds(tex) {
    var w = tex.width, h = tex.height, sm = blank(Math.max(1, w >> 3), Math.max(1, h >> 3)), out = blank(w, h);
    sm.getContext('2d').drawImage(tex, 0, 0, sm.width, sm.height);
    var g = out.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(sm, 0, 0, w, h);
    var t = new T.CanvasTexture(out); return t;
  }
  function shell(tex, mask, w, h, form, tone) {
    var hf = heights(mask, w, h, form);
    var geo = new T.PlaneGeometry(2 * w / h, 2, hf.cw - 1, hf.ch - 1), pos = geo.attributes.position;
    for (var i = 0; i < pos.count; i++) pos.setZ(i, hf.z[i]);
    // keep only triangles that touch the piece: its edge then runs along the grid, where the front and the
    // back meet vertex for vertex, so the seam is closed with no cut-out pixels to see through
    var idx = geo.index.array, kept = [];
    for (i = 0; i < idx.length; i += 3) if (hf.inside[idx[i]] || hf.inside[idx[i + 1]] || hf.inside[idx[i + 2]]) kept.push(idx[i], idx[i + 1], idx[i + 2]);
    geo.setIndex(kept);
    // pull each outside vertex of the edge in to where the outline actually runs, so the edge is smooth, not stepped
    var cwv = hf.cw, chv = hf.ch, used = new Uint8Array(pos.count);
    for (i = 0; i < kept.length; i++) used[kept[i]] = 1;
    var moved = new Float32Array(pos.count * 2);
    for (i = 0; i < pos.count; i++) {
      if (!used[i] || hf.inside[i]) continue;
      var vx = i % cwv, vy = (i / cwv) | 0, sx = 0, sy = 0, n = 0;
      for (var oy = -1; oy <= 1; oy++) for (var ox = -1; ox <= 1; ox++) {
        var nx = vx + ox, ny = vy + oy;
        if (nx < 0 || ny < 0 || nx >= cwv || ny >= chv || !hf.inside[ny * cwv + nx]) continue;
        sx += pos.getX(ny * cwv + nx); sy += pos.getY(ny * cwv + nx); n++;
      }
      if (n) { moved[i * 2] = pos.getX(i) * 0.5 + (sx / n) * 0.5; moved[i * 2 + 1] = pos.getY(i) * 0.5 + (sy / n) * 0.5; }
      else { moved[i * 2] = pos.getX(i); moved[i * 2 + 1] = pos.getY(i); }
    }
    for (i = 0; i < pos.count; i++) if (used[i] && !hf.inside[i]) { pos.setX(i, moved[i * 2]); pos.setY(i, moved[i * 2 + 1]); }
    geo.computeVertexNormals();
    var map = new T.Texture(tex); map.encoding = T.sRGBEncoding; map.anisotropy = renderer.capabilities.getMaxAnisotropy(); map.needsUpdate = true;
    var mat = new T.MeshStandardMaterial({ map: map, roughness: 1, metalness: 0, side: T.DoubleSide });   // matte, like cotton
    return new T.Mesh(geo, mat);
  }
  function clear() {
    if (!model) return;
    model.traverse(function (m) {
      if (!m.isMesh) return;
      m.geometry.dispose();
      [].concat(m.material).forEach(function (mt) { if (mt.map) mt.map.dispose(); if (mt.bumpMap) mt.bumpMap.dispose(); mt.dispose(); });
    });
    scene.remove(model); model = null;
  }
  function setup() {
    renderer = new T.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
    renderer.outputEncoding = T.sRGBEncoding; renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    scene = new T.Scene(); camera = new T.PerspectiveCamera(30, 1, 0.1, 50);
    scene.add(new T.HemisphereLight(0xffffff, 0xb9a796, 0.75));
    var key = new T.DirectionalLight(0xffffff, 0.75); key.position.set(-1.6, 2.2, 4); scene.add(key);
    var rim = new T.DirectionalLight(0xffffff, 0.3); rim.position.set(3, 0.5, 1.5); scene.add(rim);
    // a soft contact shadow on the floor, so the piece sits in the space instead of floating
    var sc = blank(256, 256), sg = sc.getContext('2d'), grad = sg.createRadialGradient(128, 128, 0, 128, 128, 128);
    grad.addColorStop(0, 'rgba(60,40,25,0.42)'); grad.addColorStop(0.55, 'rgba(60,40,25,0.16)'); grad.addColorStop(1, 'rgba(60,40,25,0)');
    sg.fillStyle = grad; sg.fillRect(0, 0, 256, 256);
    var st = new T.CanvasTexture(sc);
    floor = new T.Mesh(new T.PlaneGeometry(1, 1), new T.MeshBasicMaterial({ map: st, transparent: true, depthWrite: false }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = -1.04; scene.add(floor);
  }
  function shadowFor(r) { if (floor) floor.scale.set(Math.max(1.2, r * 2.1), 1, Math.max(0.55, r * 0.9)); }
  function fit() {
    shadowFor(ar);
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
    items.forEach(function (o, k) { o.button.setAttribute('aria-pressed', String(k === i)); });
    nameEl.textContent = it.name; priceEl.textContent = it.price; factsEl.textContent = it.facts;
    hint.textContent = 'Loading';
    flat.hidden = true;
    Promise.all([lib(), load(it.front), it.back ? load(it.back) : null]).then(function (r) {
      if (mine !== token) return;
      T = r[0];
      if (!renderer) setup();
      if (MODELS[it.label]) {
        return sculpted(MODELS[it.label]).then(function (obj) {
          if (mine !== token) return;
          clear(); model = obj; scene.add(model);
          yaw = -0.5; pitch = 0.06; vyaw = 0; zoom = 1; lastTouch = performance.now() - 1200;
          fit(); hint.textContent = 'Drag to rotate. Scroll or pinch to zoom.';
          if (!raf) raf = requestAnimationFrame(frame);
        });
      }
      if (!it.faces) it.faces = faces(r[1], r[2]);
      var fc = it.faces, form = FORMS[formOf(it.name)];
      clear();
      ar = fc.w / fc.h;
      model = new T.Group();
      model.add(shell(fc.front, fc.frontMask, fc.w, fc.h, form, it.tone));
      var back = shell(fc.back, fc.backMask, fc.w, fc.h, form, it.tone); back.rotation.y = Math.PI; model.add(back);
      scene.add(model);
      yaw = -0.5; pitch = 0.06; vyaw = 0; zoom = 1; lastTouch = performance.now() - 1200;
      fit();
      hint.textContent = 'Drag to rotate. Scroll or pinch to zoom.';
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
  window.mtViewerTurn = function (y, p) { yaw = y; pitch = p || 0; vyaw = 0; lastTouch = performance.now() + 1e7; };   // for checks

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
