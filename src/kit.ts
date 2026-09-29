// kit.ts — primitives, easing, seeded RNG, procedural PBR map generation (canvas is used ONLY
// to author source textures), cached geometry helpers, catenary solver, palettes.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

export const TAU = Math.PI * 2;
export const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const invLerp = (a: number, b: number, x: number) => clamp((x - a) / (b - a));
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
export const easeInCubic = (t: number) => t * t * t;
export const easeOutQuint = (t: number) => 1 - Math.pow(1 - t, 5);
export const easeInOutSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2;
export const easeOutBack = (t: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
export const easeOutElastic = (t: number) => {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return Math.pow(2, -9 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
};

/** Seeded RNG (mulberry32) so every loop of the piece is identical. */
export function mulberry32(seed: number) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Vertical field of view (degrees) for a real lens on a 24mm-tall sensor (35mm full frame). */
export const lensToFov = (mm: number) => THREE.MathUtils.radToDeg(2 * Math.atan(12 / mm));

// ───────────────────────────── palettes ─────────────────────────────
export interface Palette {
  skyTop: string;
  skyBottom: string;
  ground: string;
  keyLight: string;
  rimLight: string;
  accent: string;
  fill: string;
}
// mid-tone, saturated sets: the subject is the brightest thing in frame, the background never goes white
export const PAL: Record<'studio' | 'xray' | 'macro' | 'factory', Palette> = {
  studio: { skyTop: '#3a8ccf', skyBottom: '#9ccbe6', ground: '#d4a874', keyLight: '#fff1dc', rimLight: '#9fd4ff', accent: '#ffb347', fill: '#dff0ff' },
  xray: { skyTop: '#1d4c8c', skyBottom: '#4685bd', ground: '#4b80b0', keyLight: '#e2f3ff', rimLight: '#7fe3f0', accent: '#ffe38a', fill: '#a8d4f5' },
  macro: { skyTop: '#2c7abd', skyBottom: '#93c4e0', ground: '#d2a876', keyLight: '#fff0da', rimLight: '#9fe0ff', accent: '#ff8a70', fill: '#d6ecff' },
  factory: { skyTop: '#4699d3', skyBottom: '#a9d3e6', ground: '#c4cfd1', keyLight: '#fff4e2', rimLight: '#a5dcff', accent: '#6fe0a0', fill: '#e4f2ff' },
};

// ───────────────────────────── noise ─────────────────────────────
function hash2(x: number, y: number, s: number) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}
/** Tileable value noise: (x,y) in lattice units, periods px,py (integers). */
export function pnoise(x: number, y: number, px: number, py: number, seed: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const mx = (v: number) => ((v % px) + px) % px;
  const my = (v: number) => ((v % py) + py) % py;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(mx(xi), my(yi), seed);
  const b = hash2(mx(xi + 1), my(yi), seed);
  const c = hash2(mx(xi), my(yi + 1), seed);
  const d = hash2(mx(xi + 1), my(yi + 1), seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
/** Tileable fbm for u,v in [0,1). */
export function fbmT(u: number, v: number, px: number, py: number, oct: number, seed: number) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let ax = px;
  let ay = py;
  for (let o = 0; o < oct; o++) {
    sum += amp * pnoise(u * ax, v * ay, ax, ay, seed + o * 31);
    norm += amp;
    amp *= 0.5;
    ax *= 2;
    ay *= 2;
  }
  return sum / norm;
}

// ───────────────────────────── PBR map authoring ─────────────────────────────
export interface MapSet {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
}
interface MapOpts {
  size?: number;
  height: (u: number, v: number) => number;
  color: (u: number, v: number, h: number) => [number, number, number];
  rough: (u: number, v: number, h: number) => number;
  strength?: number;
  repeat?: [number, number];
}
export function procMaps(o: MapOpts): MapSet {
  const S = o.size ?? 256;
  const H = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) H[y * S + x] = o.height(x / S, y / S);
  const mk = () => {
    const c = document.createElement('canvas');
    c.width = S;
    c.height = S;
    const ctx = c.getContext('2d')!;
    return { c, ctx, img: ctx.createImageData(S, S) };
  };
  const A = mk();
  const N = mk();
  const R = mk();
  const k = (o.strength ?? 1.5) * (S / 32);
  const at = (x: number, y: number) => H[((y + S) % S) * S + ((x + S) % S)];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const h = H[y * S + x];
      const u = x / S;
      const v = y / S;
      const col = o.color(u, v, h);
      A.img.data[i] = col[0];
      A.img.data[i + 1] = col[1];
      A.img.data[i + 2] = col[2];
      A.img.data[i + 3] = 255;
      const dx = (at(x + 1, y) - at(x - 1, y)) * k;
      const dy = (at(x, y + 1) - at(x, y - 1)) * k;
      const l = Math.hypot(dx, dy, 1);
      N.img.data[i] = (-dx / l * 0.5 + 0.5) * 255;
      N.img.data[i + 1] = (dy / l * 0.5 + 0.5) * 255;
      N.img.data[i + 2] = (1 / l * 0.5 + 0.5) * 255;
      N.img.data[i + 3] = 255;
      const r = clamp(o.rough(u, v, h)) * 255;
      R.img.data[i] = r;
      R.img.data[i + 1] = r;
      R.img.data[i + 2] = r;
      R.img.data[i + 3] = 255;
    }
  }
  A.ctx.putImageData(A.img, 0, 0);
  N.ctx.putImageData(N.img, 0, 0);
  R.ctx.putImageData(R.img, 0, 0);
  const rep = o.repeat ?? [1, 1];
  const wrap = (t: THREE.CanvasTexture, srgb: boolean) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(rep[0], rep[1]);
    t.anisotropy = 8;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  };
  return { map: wrap(new THREE.CanvasTexture(A.c), true), normalMap: wrap(new THREE.CanvasTexture(N.c), false), roughnessMap: wrap(new THREE.CanvasTexture(R.c), false) };
}

const memo: Record<string, MapSet> = {};
const once = (key: string, f: () => MapSet) => (memo[key] ??= f());

export const woodMaps = () =>
  once('wood', () =>
    procMaps({
      size: 512,
      repeat: [2, 1.4],
      strength: 1.1,
      height: (u, v) => {
        const g = 0.6 * pnoise(u * 3, v * 70, 3, 70, 1) + 0.4 * pnoise(u * 6, v * 140, 6, 140, 2);
        const f = (v * 5) % 1;
        const seam = Math.min(f, 1 - f) < 0.006 ? -0.5 : 0;
        return g * 0.35 + seam;
      },
      color: (u, v, h) => {
        const g = pnoise(u * 2, v * 36, 2, 36, 5);
        const line = Math.pow(pnoise(u * 4, v * 90, 4, 90, 9), 3);
        const f = (v * 5) % 1;
        const seam = Math.min(f, 1 - f) < 0.006 ? 0.55 : 1;
        const plank = 0.94 + 0.08 * hash2(Math.floor(v * 5), 3, 7);
        const t = clamp(g * 0.7 + line * 0.5 + h * 0.2);
        // honey / amber wood — saturated enough to stay warm under a bright key
        return [
          (222 - 66 * t) * seam * plank,
          (166 - 70 * t) * seam * plank,
          (104 - 58 * t) * seam * plank,
        ];
      },
      rough: (_u, _v, h) => 0.5 + 0.35 * h,
    }),
  );

export const concreteMaps = () =>
  once('concrete', () =>
    procMaps({
      size: 512,
      repeat: [10, 10],
      strength: 1.2,
      height: (u, v) => fbmT(u, v, 6, 6, 5, 4),
      color: (u, v, h) => {
        const n = fbmT(u, v, 3, 3, 3, 8);
        const c = 214 + 18 * (n - 0.5) + 14 * (h - 0.5);
        return [c - 6, c, c + 4];
      },
      rough: (_u, _v, h) => 0.78 + 0.2 * h,
    }),
  );

export const plasticMaps = () =>
  once('plastic', () =>
    procMaps({
      size: 256,
      repeat: [6, 3],
      strength: 0.6,
      height: (u, v) => 0.6 * pnoise(u * 64, v * 64, 64, 64, 3) + 0.4 * pnoise(u * 128, v * 128, 128, 128, 4),
      color: (_u, _v, h) => {
        const c = 246 - 8 * h;
        return [c, c - 2, c - 8];
      },
      rough: (_u, _v, h) => 0.32 + 0.22 * h,
    }),
  );

export const paperMaps = () =>
  once('paper', () =>
    procMaps({
      size: 256,
      repeat: [1, 1],
      strength: 0.7,
      height: (u, v) => 0.5 * pnoise(u * 90, v * 90, 90, 90, 12) + 0.5 * pnoise(u * 30, v * 200, 30, 200, 13),
      color: (_u, _v, h) => {
        const c = 250 - 10 * h;
        return [c, c, c];
      },
      rough: (_u, _v, h) => 0.5 + 0.2 * h,
    }),
  );

export const rubberMaps = () =>
  once('rubber', () =>
    procMaps({
      size: 256,
      repeat: [30, 2],
      strength: 1.3,
      height: (u, v) => {
        const cleat = Math.pow(0.5 + 0.5 * Math.sin(u * TAU * 2), 6);
        return 0.55 * cleat + 0.25 * pnoise(u * 64, v * 64, 64, 64, 6) + 0.2 * pnoise(u * 16, v * 16, 16, 16, 7);
      },
      color: (_u, _v, h) => {
        const c = 1 - 0.18 * h;
        return [122 * c, 158 * c, 186 * c];
      },
      rough: (_u, _v, h) => 0.75 + 0.2 * h,
    }),
  );

export const fabricMaps = () =>
  once('fabric', () =>
    procMaps({
      size: 256,
      repeat: [3, 3],
      strength: 1.4,
      height: (u, v) => {
        const a = 0.5 + 0.5 * Math.sin(u * TAU * 48);
        const b = 0.5 + 0.5 * Math.sin(v * TAU * 48);
        return 0.5 * a * b + 0.5 * Math.max(a, b) * 0.4 + 0.1 * pnoise(u * 32, v * 32, 32, 32, 2);
      },
      color: (_u, _v, h) => {
        const c = 0.82 + 0.3 * h;
        return [86 * c, 176 * c, 190 * c];
      },
      rough: () => 0.88,
    }),
  );

// ───────────────────────────── sprites ─────────────────────────────
let _glow: THREE.CanvasTexture | null = null;
/** Soft radial falloff used for glow sprites and dust motes (a source texture only). */
export function glowTexture() {
  if (_glow) return _glow;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  gr.addColorStop(0.6, 'rgba(255,255,255,0.12)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  _glow = new THREE.CanvasTexture(c);
  _glow.colorSpace = THREE.SRGBColorSpace;
  return _glow;
}

// ───────────────────────────── geometry helpers ─────────────────────────────
const boxCache = new Map<string, THREE.BufferGeometry>();
export function roundedBox(w: number, h: number, d: number, r = 0.1, seg = 3) {
  const key = `${w}|${h}|${d}|${r}|${seg}`;
  let g = boxCache.get(key);
  if (!g) {
    g = new RoundedBoxGeometry(w, h, d, seg, Math.min(r, Math.min(w, h, d) * 0.49));
    boxCache.set(key, g);
  }
  return g;
}

let _unitCyl: THREE.CylinderGeometry | null = null;
export function unitCylinder() {
  return (_unitCyl ??= new THREE.CylinderGeometry(1, 1, 1, 20, 1));
}
const _Y = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
/** Positions/orients a unit cylinder (radius 1, height 1) as a rod between two live points. */
export function setRod(m: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3, r: number) {
  _dir.subVectors(b, a);
  const len = _dir.length() || 1e-6;
  m.position.copy(a).addScaledVector(_dir, 0.5);
  m.quaternion.setFromUnitVectors(_Y, _dir.divideScalar(len));
  m.scale.set(r, len, r);
}

class HelixCurve extends THREE.Curve<THREE.Vector3> {
  constructor(private radius: number, private pitch: number, private turns: number, private a0: number) {
    super();
  }
  getPoint(t: number, target = new THREE.Vector3()) {
    const a = this.a0 + t * this.turns * TAU;
    return target.set(this.radius * Math.cos(a), this.pitch * this.turns * t, -this.radius * Math.sin(a));
  }
}
/** Right-handed helical thread (rises while turning counter-clockwise seen from +Y). */
export function helixTube(radius: number, pitch: number, turns: number, tube: number, a0 = 0, radial = 6) {
  return new THREE.TubeGeometry(new HelixCurve(radius, pitch, turns, a0), Math.ceil(turns * 56), tube, radial, false);
}

/** True catenary between two points for a cable of given length (solved by bisection). */
export function catenary(a: THREE.Vector3, b: THREE.Vector3, length: number, n = 32): THREE.Vector3[] {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const D = Math.hypot(dx, dz) || 1e-6;
  const h = b.y - a.y;
  const chord = Math.hypot(D, h);
  const Ls = Math.max(length, chord * 1.0008);
  const target = Math.sqrt(Math.max(Ls * Ls - h * h, D * D));
  let lo = 0.01;
  let hi = 1e5;
  for (let i = 0; i < 90; i++) {
    const c = Math.sqrt(lo * hi);
    const f = 2 * c * Math.sinh(D / (2 * c));
    if (f > target) lo = c;
    else hi = c;
  }
  const c = Math.sqrt(lo * hi);
  const x0 = D / 2 - c * Math.atanh(clamp(h / Ls, -0.999, 0.999));
  const ux = dx / D;
  const uz = dz / D;
  const y0 = Math.cosh(-x0 / c);
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    const x = (i / n) * D;
    const y = c * (Math.cosh((x - x0) / c) - y0);
    pts.push(new THREE.Vector3(a.x + ux * x, a.y + y, a.z + uz * x));
  }
  return pts;
}

/** HDR emissive-only material for true light emitters (bloom picks these up at threshold ≥ 1). */
export function glowMat(color: string, intensity = 1.6, additive = true) {
  const c = new THREE.Color(color).multiplyScalar(intensity);
  return new THREE.MeshBasicMaterial({
    color: c,
    transparent: true,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    depthWrite: false,
    fog: false,
  });
}

/** Marks meshes that must be skipped by depth-based post passes (AO / DOF). */
export function noDepth<T extends THREE.Object3D>(o: T): T {
  o.userData.noDepth = true;
  return o;
}

export const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
