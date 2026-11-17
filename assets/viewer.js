// The 3D viewer: the dialog, the piece picker and the view controls. The studio itself (assets/studio.js)
// loads on first open, so the page pays nothing for it until someone asks to see a piece in 3D.
(function () {
  var dlg = document.getElementById('viewer');
  if (!dlg) return;
  var stage = dlg.querySelector('.viewer__stage'), canvas = dlg.querySelector('canvas');
  var nameEl = dlg.querySelector('.viewer__name'), priceEl = dlg.querySelector('.viewer__price');
  var factsEl = dlg.querySelector('.viewer__facts'), hint = dlg.querySelector('.viewer__hint');
  var picks = dlg.querySelector('.viewer__picks'), flat = dlg.querySelector('.viewer__flat');
  var tools = dlg.querySelector('.viewer__tools'), autoBtn = dlg.querySelector('[data-auto]');
  var still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var HINT = window.matchMedia('(pointer: coarse)').matches ? 'Drag to turn. Pinch to zoom.' : 'Drag to turn. Scroll to zoom. Double-click to reset.';

  // the pieces, read from the collection tiles so the viewer never drifts from the page
  var items = [];
  document.querySelectorAll('#collection .tile').forEach(function (tile) {
    var spin = tile.querySelector('[data-spin]');
    if (!spin) return;
    var name = tile.querySelector('h3').textContent, price = tile.querySelector('.tile__price').textContent;
    var swatches = tile.querySelectorAll('.swatch'), first = items.length;
    if (swatches.length) {
      swatches.forEach(function (s) {
        items.push({ name: name, price: price, facts: s.dataset.facts, label: name + ', ' + s.dataset.name.toLowerCase(), front: s.dataset.src, swatch: s });
      });
    } else {
      items.push({ name: name, price: price, facts: tile.querySelector('.tile__facts').textContent, label: name, front: spin.querySelector('.spin__face').getAttribute('src') });
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

  var studioP = null, S = null, token = 0;
  function studio() {
    return studioP || (studioP = import('./studio.js').then(function (m) {
      S = m;
      m.init(canvas, { onGrab: function () { setAuto(false); } });
      return m;
    }));
  }
  function setAuto(on) {
    if (!autoBtn) return;
    autoBtn.setAttribute('aria-pressed', String(on));
    if (S) S.auto(on);
  }

  function show(i) {
    var it = items[i], mine = ++token;
    items.forEach(function (o, k) { o.button.setAttribute('aria-pressed', String(k === i)); });
    nameEl.textContent = it.name; priceEl.textContent = it.price; factsEl.textContent = it.facts;
    hint.textContent = 'Loading the 3D model';
    flat.hidden = true; tools.hidden = false;
    studio().then(function (m) {
      if (mine !== token) return;
      if (!m.has(it.label)) throw new Error('no model');
      m.resize();
      return m.show(it.label).then(function () {
        if (mine !== token) return;
        hint.textContent = HINT;
        setAuto(autoBtn && autoBtn.getAttribute('aria-pressed') === 'true');
      });
    }).catch(function (err) {          // no WebGL or a blocked file: show the piece flat instead of nothing
      if (mine !== token) return;
      if (window.console) console.warn('3D viewer:', err);
      flat.src = it.front; flat.alt = it.label; flat.hidden = false; tools.hidden = true;
      hint.textContent = '3D is not available in this browser.';
    });
  }
  function open(i) {
    if (!dlg.open) dlg.showModal();
    if (S) { S.run(true); S.resize(); }
    show(i);
  }
  window.mtOpenViewer = open;
  window.mtViewerPose = function (theta, phi) { if (S) { S.run(false); S.pose(theta, phi); S.render(); } };   // for checks: one still frame

  tools.addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b || !S) return;
    if (b.dataset.view) { setAuto(false); S.view(b.dataset.view); }
    else if (b.hasAttribute('data-reset')) { setAuto(false); S.reset(); }
    else if (b.hasAttribute('data-auto')) setAuto(b.getAttribute('aria-pressed') !== 'true');
  });
  dlg.addEventListener('keydown', function (e) {
    if (!S) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); S.turn(-0.4); }
    if (e.key === 'ArrowRight') { e.preventDefault(); S.turn(0.4); }
  });
  stage.addEventListener('wheel', function (e) { e.preventDefault(); }, { passive: false });
  window.addEventListener('resize', function () { if (S && dlg.open) S.resize(); });
  if (window.ResizeObserver) new ResizeObserver(function () { if (S && dlg.open) S.resize(); }).observe(stage);
  dlg.addEventListener('close', function () { token++; if (S) S.run(false); setAuto(false); });
  if (still && autoBtn) autoBtn.hidden = true;
})();
