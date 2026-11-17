// The 3D product studio: real garment meshes (models/*.glb), fabric materials with knit and fleece surface
// detail, the prints placed on the garment surface, soft studio lighting that turns with the camera like a
// turntable shoot, and orbit controls with inertia, zoom, preset views and an optional slow turn.
import * as THREE from './vendor/three/three.module.min.js';
import { OrbitControls } from './vendor/three/OrbitControls.js';
import { GLTFLoader } from './vendor/three/GLTFLoader.js';
import { RoomEnvironment } from './vendor/three/RoomEnvironment.js';
import { MeshoptDecoder } from './vendor/three/meshopt_decoder.module.js';

// ---------------------------------------------------------------- the products
// Decal rects are in metres on the garment: [left, bottom, right, top] as seen from the side the print is on.
// side 1 prints face the front, side -1 the back. depth limits which layer of fabric takes the print.
const BONE = '#ddd0bf', BLACK = '#1d1d1e';
const FRONT = [0.03, 0.4], BACK = [0.04, 0.152];
const PRODUCTS = {
  'Signature Tee': { model: 'tee', color: '#262626', fabric: 'jersey', wash: 1,
    decals: [['signature-chest', 1, [0.053, 0.551, 0.193, 0.673], FRONT], ['signature-back', -1, [-0.188, 0.222, 0.222, 0.755], BACK],
             ['tee-label', 1, [-0.02, 0.749, 0.0275, 0.794], [-0.12, -0.035]]] },
  'Summit Tee': { model: 'tee', color: BONE, fabric: 'jersey',
    decals: [['summit-chest', 1, [0.053, 0.551, 0.193, 0.673], FRONT], ['summit-back', -1, [-0.198, 0.259, 0.2, 0.751], BACK],
             ['tee-label', 1, [-0.02, 0.749, 0.0275, 0.794], [-0.12, -0.035]]] },
  'Lily Hoodie': { model: 'hoodie', color: BLACK, fabric: 'fleece',
    decals: [['lily-chest', 1, [-0.10, 0.582, 0.108, 0.642], FRONT], ['lily-back', -1, [-0.23, 0.184, 0.17, 0.662], BACK]] },
  'Clean Contrast Hoodie': { model: 'hoodie', color: BONE, fabric: 'fleece',
    decals: [['contrast-chest', 1, [-0.123, 0.554, 0.121, 0.614], FRONT], ['contrast-back', -1, [-0.192, 0.368, 0.192, 0.621], BACK]] },
  'Everyday Sweatpants, bone': { model: 'pants', color: BONE, fabric: 'fleece',
    decals: [['sweats-bone-thigh', 1, [0.053, 0.596, 0.187, 0.753], FRONT]] },
  'Everyday Sweatpants, black': { model: 'pants', color: BLACK, fabric: 'fleece',
    decals: [['sweats-black-thigh', 1, [0.067, 0.596, 0.194, 0.748], FRONT]] },
  'Ribbed Beanie, bone': { model: 'beanie', color: BONE, fabric: 'knit',
    decals: [['beanie-cuff', 1, [-0.0867, 0.0383, 0.0867, 0.0561], [0.04, 0.2]]] },
  'Ribbed Beanie, pink': { model: 'beanie', color: '#d93a96', fabric: 'knit',
    decals: [['beanie-cuff', 1, [-0.0867, 0.0383, 0.0867, 0.0561], [0.04, 0.2]]] }
};
export function has(label) { return !!PRODUCTS[label]; }

// ---------------------------------------------------------------- fabric surfaces, drawn once
// Each is a small tile: a normal map in RGB and a soft tone variation in alpha, as raw data so nothing is
// premultiplied. Sewn pieces use them projected from three sides; the beanie uses its own UVs.
function periodicNoise(n, period, seed) {
  const g = new Float32Array(period * period);
  let s = seed * 9301 + 49297;
  for (let i = 0; i < g.length; i++) { s = (s * 9301 + 49297) % 233280; g[i] = s / 233280; }
  const out = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const fx = (x / n) * period, fy = (y / n) * period, ix = Math.floor(fx), iy = Math.floor(fy), ux = fx - ix, uy = fy - iy;
    const sx = ux * ux * (3 - 2 * ux), sy = uy * uy * (3 - 2 * uy);
    const a = g[(iy % period) * period + (ix % period)], b = g[(iy % period) * period + ((ix + 1) % period)];
    const c = g[((iy + 1) % period) * period + (ix % period)], d = g[((iy + 1) % period) * period + ((ix + 1) % period)];
    out[y * n + x] = (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
  }
  return out;
}
function fbmTile(n, base, oct, seed) {
  const out = new Float32Array(n * n); let amp = 1, tot = 0;
  for (let o = 0; o < oct; o++) { const t = periodicNoise(n, base << o, seed + o * 17); for (let i = 0; i < out.length; i++) out[i] += t[i] * amp; tot += amp; amp *= 0.5; }
  for (let i = 0; i < out.length; i++) out[i] /= tot;
  return out;
}
function tile(kind) {
  const n = 256, H = new Float32Array(n * n);
  const fine = fbmTile(n, 32, 3, kind.length * 7), slub = fbmTile(n, 6, 3, 31), tone = fbmTile(n, 4, 4, 53);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const u = x / n, v = y / n, i = y * n + x;
    let h = 0;
    if (kind === 'jersey') {
      // fine knit columns with a little slub, like heavyweight cotton
      const col = u * 64, row = v * 48, du = col - Math.floor(col) - 0.5, dv = row - Math.floor(row);
      const loop = Math.exp(-((Math.abs(du) - 0.22 + 0.18 * (dv - 0.5)) ** 2) / 0.012);
      h = 0.35 * loop + 0.45 * fine[i] + 0.5 * slub[i];
    } else if (kind === 'fleece') {
      h = 0.7 * fine[i] + 0.3 * slub[i];                       // brushed and soft, no visible weave
    } else if (kind === 'rib') {
      const c = Math.cos(u * Math.PI * 2 * 12);
      h = 0.75 * Math.pow(0.5 + 0.5 * c, 0.6) + 0.25 * fine[i];
    } else {                                                    // knit: one stitch per tile, a V over the rib
      const du = u < 0.5 ? u : u - 1;                           // centred on the rib's crest at u = 0
      const lobe = (s) => Math.exp(-(((du - s * (0.13 + 0.1 * (v - 0.5))) ** 2) / 0.006 + ((v - 0.5) ** 2) / 0.14));
      const purl = Math.exp(-(((Math.abs(du) - 0.5) ** 2) / 0.01 + ((v - 0.5) ** 2) / 0.06));
      h = Math.max(lobe(1), lobe(-1)) * 0.9 + purl * 0.35 + 0.12 * fine[i];
    }
    H[i] = h;
  }
  const d = new Uint8Array(n * n * 4), k = kind === 'knit' ? 2.6 : kind === 'rib' ? 3.2 : 2.2;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x;
    const dx = (H[y * n + ((x + 1) % n)] - H[y * n + ((x + n - 1) % n)]) * k;
    const dy = (H[((y + 1) % n) * n + x] - H[((y + n - 1) % n) * n + x]) * k;
    const L = Math.hypot(dx, dy, 1);
    d[i * 4] = ((-dx / L) * 0.5 + 0.5) * 255; d[i * 4 + 1] = ((-dy / L) * 0.5 + 0.5) * 255; d[i * 4 + 2] = ((1 / L) * 0.5 + 0.5) * 255;
    d[i * 4 + 3] = tone[i] * 255;
  }
  const t = new THREE.DataTexture(d, n, n, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true; t.anisotropy = 8; t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true;
  return t;
}
const tiles = {};
const tileOf = (k) => tiles[k] || (tiles[k] = tile(k));
// metres per tile, and how strongly the surface detail shows
const SURF = { jersey: [0.03, 0.55], fleece: [0.05, 0.45], rib: [0.03, 0.9], knit: [1, 0.85] };

// ---------------------------------------------------------------- materials
const texLoader = new THREE.TextureLoader();
const decalTex = {};
function decal(name) {
  if (!decalTex[name]) {
    decalTex[name] = texLoader.load('img/decals/' + name + '.png');
    decalTex[name].colorSpace = THREE.SRGBColorSpace; decalTex[name].anisotropy = 8;
  }
  return decalTex[name];
}
function material(p, part, hasUV) {
  const kind = part === 'rib' ? (p.fabric === 'knit' ? 'knit' : 'rib') : p.fabric;
  const cord = part === 'cord', tip = part === 'tip';
  const base = new THREE.Color(cord ? p.color : tip ? (p.color === BONE ? '#cfc2b0' : '#141414') : p.color);
  const dark = base.getHSL({}).l < 0.2;
  const m = new THREE.MeshPhysicalMaterial({
    color: base, roughness: tip ? 0.45 : dark ? 0.86 : 0.93, metalness: 0, vertexColors: true,
    sheen: tip ? 0 : 1, sheenRoughness: dark ? 0.55 : 0.8,
    sheenColor: new THREE.Color(dark ? '#5a5a5c' : '#ffffff').multiplyScalar(dark ? 1 : 0.22),
    envMapIntensity: dark ? 1.15 : 0.9
  });
  const surf = SURF[kind] || SURF.fleece;
  const uniforms = {
    uFab: { value: tileOf(kind) }, uFabScale: { value: 1 / surf[0] }, uFabStrength: { value: tip ? 0 : surf[1] },
    uWash: { value: p.wash && part !== 'cord' && part !== 'tip' ? 1 : 0 }
  };
  const decals = part === 'fabric' || (p.model === 'beanie' && part === 'rib') ? p.decals : [];
  decals.forEach((d, i) => {
    uniforms['uDec' + i] = { value: decal(d[0]) };
    uniforms['uDecRect' + i] = { value: new THREE.Vector4(...d[2]) };
    uniforms['uDecSide' + i] = { value: d[1] };
    uniforms['uDecZ' + i] = { value: new THREE.Vector2(...d[3]) };
  });
  const triplanar = !(hasUV && kind === 'knit');
  if (!triplanar) { m.normalMap = tileOf('knit'); m.normalScale.set(surf[1], surf[1]); }
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWNrm = normalize(mat3(modelMatrix) * objectNormal);');
    let decl = 'varying vec3 vWPos;\nvarying vec3 vWNrm;\nuniform sampler2D uFab;\nuniform float uFabScale;\nuniform float uFabStrength;\nuniform float uWash;\n';
    decals.forEach((d, i) => { decl += `uniform sampler2D uDec${i};\nuniform vec4 uDecRect${i};\nuniform float uDecSide${i};\nuniform vec2 uDecZ${i};\n`; });
    decl += `
vec4 mtDecal(sampler2D t, vec4 r, float side, vec2 zr, vec3 nW) {
  float x = vWPos.x * side;
  vec2 uv = vec2((x - r.x) / (r.z - r.x), (vWPos.y - r.y) / (r.w - r.y));
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
  float zz = vWPos.z * side;
  if (zz < zr.x || zz > zr.y) return vec4(0.0);
  vec4 c = texture2D(t, uv);
  c.a *= smoothstep(0.3, 0.6, nW.z * side);
  return c;
}
vec4 mtTri(vec3 p, vec3 w) {
  return texture2D(uFab, p.zy) * w.x + texture2D(uFab, p.xz) * w.y + texture2D(uFab, p.xy) * w.z;
}
`;
    let colour = `
vec3 mtN = normalize(vWNrm);
float mtInk = 0.0;
{
  vec3 bw = pow(abs(mtN), vec3(4.0)); bw /= (bw.x + bw.y + bw.z);
  float tone = mtTri(vWPos * uFabScale * 0.13, bw).a;          // gentle heather, a few centimetres across
  float wash = mtTri(vWPos * 3.2, bw).a;                      // the mottled fade of washed black cotton
  diffuseColor.rgb *= mix(0.93 + 0.14 * tone, 0.62 + 0.9 * smoothstep(0.25, 0.85, wash), uWash);
`;
    decals.forEach((d, i) => {
      colour += `  { vec4 dc = mtDecal(uDec${i}, uDecRect${i}, uDecSide${i}, uDecZ${i}, mtN);
    diffuseColor.rgb = mix(diffuseColor.rgb, dc.rgb * vColor.rgb, dc.a); mtInk = max(mtInk, dc.a); }\n`;
    });
    colour += '}\n';
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + decl)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + colour)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.62, mtInk * 0.7);');
    if (triplanar) {
      sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_maps>', `
{
  vec3 nW = normalize(vWNrm) * faceDirection;
  vec3 p = vWPos * uFabScale;
  vec3 bw = pow(abs(nW), vec3(4.0)); bw /= (bw.x + bw.y + bw.z);
  vec3 tx = texture2D(uFab, p.zy).xyz * 2.0 - 1.0;
  vec3 ty = texture2D(uFab, p.xz).xyz * 2.0 - 1.0;
  vec3 tz = texture2D(uFab, p.xy).xyz * 2.0 - 1.0;
  float k = uFabStrength * (1.0 - mtInk * 0.6);
  tx.xy *= k; ty.xy *= k; tz.xy *= k;
  tx = vec3(tx.xy + nW.zy, abs(tx.z) * nW.x);
  ty = vec3(ty.xy + nW.xz, abs(ty.z) * nW.y);
  tz = vec3(tz.xy + nW.xy, abs(tz.z) * nW.z);
  vec3 nn = normalize(tx.zyx * bw.x + ty.xzy * bw.y + tz.xyz * bw.z);
  normal = normalize((viewMatrix * vec4(nn, 0.0)).xyz);
}`);
    }
  };
  m.customProgramCacheKey = () => [p.model, part, kind, decals.length, triplanar].join('|');
  return m;
}

// ---------------------------------------------------------------- the studio
let renderer, scene, camera, controls, pmrem, floor, blob, product, holder, rig;
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const wasmOK = MeshoptDecoder.ready.then(() => true, () => false);
const cache = {};
const state = { anim: null, auto: false, onIdle: null, ready: false };

export function init(canvas, opts) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping; renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  scene = new THREE.Scene();
  pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.75;
  camera = new THREE.PerspectiveCamera(26, 1, 0.02, 30);
  scene.add(camera);
  // Lights ride with the camera, like a product turning on a turntable under fixed studio lights:
  // a large soft key from the upper left, a fill from the right, and two rims from behind that draw the
  // edges of dark garments.
  rig = new THREE.Group(); camera.add(rig);
  const target = new THREE.Object3D(); scene.add(target); state.target = target;
  const key = new THREE.DirectionalLight('#fff6ec', 2.1); key.position.set(-1.1, 3.0, 1.3); key.target = target;
  key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.radius = 6; key.shadow.bias = -0.0004; key.shadow.normalBias = 0.012;
  const fill = new THREE.DirectionalLight('#eef2ff', 0.65); fill.position.set(2.2, 0.4, 1.0); fill.target = target;
  const rimL = new THREE.DirectionalLight('#ffffff', 1.25); rimL.position.set(-1.8, 1.2, -2.4); rimL.target = target;
  const rimR = new THREE.DirectionalLight('#ffffff', 1.0); rimR.position.set(1.9, 0.9, -2.2); rimR.target = target;
  const top = new THREE.DirectionalLight('#ffffff', 0.45); top.position.set(0, 3, 0.2); top.target = target;
  rig.add(key, fill, rimL, rimR, top);
  state.key = key;
  // the floor: a soft contact shadow and the key light's shadow, nothing else
  floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.12, color: '#3b2a1d' }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d'), gr = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  gr.addColorStop(0, 'rgba(50,34,22,0.5)'); gr.addColorStop(0.45, 'rgba(50,34,22,0.2)'); gr.addColorStop(1, 'rgba(50,34,22,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
  const bt = new THREE.CanvasTexture(c); bt.colorSpace = THREE.SRGBColorSpace;
  blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: bt, transparent: true, depthWrite: false, toneMapped: false }));
  blob.rotation.x = -Math.PI / 2; scene.add(blob);
  holder = new THREE.Group(); scene.add(holder);

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true; controls.dampingFactor = 0.075; controls.rotateSpeed = 0.75; controls.zoomSpeed = 0.8;
  controls.enablePan = false;
  controls.minPolarAngle = Math.PI * 0.2; controls.maxPolarAngle = Math.PI * 0.6;
  controls.autoRotateSpeed = 1.6;
  controls.addEventListener('start', () => { state.anim = null; if (opts && opts.onGrab) opts.onGrab(); });
  canvas.addEventListener('dblclick', () => reset());
  state.ready = true;
  resize();
  renderer.setAnimationLoop(frame);
  return { renderer };
}

function frame() {
  if (!product) return;
  if (state.anim) {
    const a = state.anim, t = Math.min(1, (performance.now() - a.t0) / a.ms), e = 1 - Math.pow(1 - t, 3);
    const s = new THREE.Spherical(lerp(a.from.radius, a.to.radius, e), lerp(a.from.phi, a.to.phi, e), a.from.theta + a.dTheta * e);
    camera.position.setFromSpherical(s).add(controls.target);
    if (t >= 1) state.anim = null;
  }
  controls.update();
  // the studio environment turns with the camera too
  const az = Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z);
  scene.environmentRotation.set(0, az, 0);
  renderer.render(scene, camera);
}
const lerp = (a, b, t) => a + (b - a) * t;

export function resize() {
  if (!renderer) return;
  const el = renderer.domElement, w = el.clientWidth, h = el.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  if (product) frameIt(false);
}

let fit = { dist: 2, center: new THREE.Vector3() };
function frameIt(resetView) {
  const box = new THREE.Box3().setFromObject(product), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  let rxz = 0;
  product.traverse(o => {
    if (!o.isMesh) return;
    const p = o.geometry.attributes.position, v = new THREE.Vector3();
    for (let i = 0; i < p.count; i += 7) { v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld); rxz = Math.max(rxz, Math.hypot(v.x - c.x, v.z - c.z)); }
  });
  const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)), tanH = tanV * camera.aspect;
  // far enough that the whole piece stays in frame from every side, sleeves and hood included
  const dist = Math.max((size.y / 2) * 1.32 / tanV, (rxz * 1.15) / tanH) + rxz * 0.55;
  fit = { dist, center: c, size, rxz };
  controls.target.copy(c); state.target.position.copy(c);
  controls.minDistance = dist * 0.42; controls.maxDistance = dist * 1.45;
  // shadow camera and floor sized to the piece
  const k = state.key, r = Math.max(size.x, size.y, size.z) * 0.75;
  k.shadow.camera.left = -r; k.shadow.camera.right = r; k.shadow.camera.top = r; k.shadow.camera.bottom = -r;
  k.shadow.camera.near = 0.05; k.shadow.camera.far = 8; k.shadow.camera.updateProjectionMatrix();
  const fy = box.min.y - size.y * 0.07;
  floor.position.set(c.x, fy, c.z); floor.scale.set(r * 6, r * 6, 1);
  blob.position.set(c.x, fy + 0.001, c.z); blob.scale.set(Math.max(size.x, size.z) * 1.25, Math.max(size.x, size.z) * 0.9, 1);
  if (resetView) {
    camera.position.setFromSpherical(new THREE.Spherical(dist, VIEWS.home.phi, VIEWS.home.theta)).add(c);
    controls.update();
  } else {
    const off = camera.position.clone().sub(c).setLength(clampN(camera.position.distanceTo(c), controls.minDistance, controls.maxDistance));
    camera.position.copy(c).add(off);
  }
}
const clampN = (v, a, b) => Math.max(a, Math.min(b, v));

const VIEWS = {
  home: { theta: -0.48, phi: Math.PI * 0.46 },
  front: { theta: 0, phi: Math.PI * 0.47 }, back: { theta: Math.PI, phi: Math.PI * 0.47 },
  left: { theta: Math.PI / 2, phi: Math.PI * 0.47 }, right: { theta: -Math.PI / 2, phi: Math.PI * 0.47 }
};
export function view(name, ms) {
  if (!product) return;
  const v = VIEWS[name], from = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
  const radius = name === 'home' ? fit.dist : from.radius;
  let d = v.theta - from.theta; d = Math.atan2(Math.sin(d), Math.cos(d));
  state.anim = { t0: performance.now(), ms: ms || 900, from, to: { radius, phi: v.phi }, dTheta: d };
}
export function reset() { view('home', 900); }
export function turn(d) {
  if (!product) return;
  const from = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
  state.anim = { t0: performance.now(), ms: 420, from, to: { radius: from.radius, phi: from.phi }, dTheta: d };
}
export function run(on) { if (renderer) renderer.setAnimationLoop(on ? frame : null); }
export function auto(on) { state.auto = on; controls.autoRotate = on; }

// A model is a GLB file. Hosts that don't serve .glb get the same bytes as base64 in a .glb.json file.
function fetchModel(u) {
  const glb = (b) => { const v = new Uint8Array(b, 0, 4); if (String.fromCharCode(v[0], v[1], v[2], v[3]) !== 'glTF') throw new Error('not a model'); return b; };
  return fetch(u).then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); }).then(glb)
    .catch(() => fetch(u + '.json').then(r => { if (!r.ok) throw new Error('model missing'); return r.json(); }).then(j => {
      const bin = atob(j.glb), out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return glb(out.buffer);
    }));
}
export function show(label) {
  const p = PRODUCTS[label];
  // compressed models need WebAssembly to unpack; where a page blocks it, fetch the plain copies instead
  const url = wasmOK.then(ok => 'models/' + (ok ? '' : 'plain/') + p.model + '.glb');
  const got = cache[p.model] || (cache[p.model] = url.then(fetchModel).then(buf => new Promise((res, rej) => loader.parse(buf, '', (g) => res(g.scene), rej))));
  return got.then((src) => {
    if (product) { holder.remove(product); product.traverse(o => { if (o.isMesh) o.material.dispose(); }); }
    product = src.clone(true);
    product.traverse(o => {
      if (!o.isMesh) return;
      const part = (o.material && o.material.name) || o.name || 'fabric';
      o.material = material(p, part.replace(/[^a-z]/g, ''), !!o.geometry.attributes.uv);
      o.castShadow = true; o.receiveShadow = false;   // the floor takes the shadow; folds and cavities are shaded by the baked occlusion
    });
    holder.add(product);
    product.updateMatrixWorld(true);
    frameIt(true);
    return true;
  });
}
// for checks: put the camera at an exact angle
export function pose(theta, phi) {
  state.anim = null;
  camera.position.setFromSpherical(new THREE.Spherical(fit.dist, phi, theta)).add(controls.target);
  controls.update();
}
export function render() { if (product) { controls.update(); renderer.render(scene, camera); } }
