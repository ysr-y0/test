// bottle.ts — PET soda bottle: lathe-turned shell with threaded PCO-style neck finish, liquid, label,
// rising CO₂ bubbles, an X-ray shell, and a kinetic-theory gas simulation of the headspace.
import * as THREE from 'three';
import { TAU, clamp, helixTube, mulberry32, noDepth, paperMaps, smoothstep, V3 } from './kit';
import { CAP, createBand } from './cap';
import { Arrows } from './effects';

export const BOT = {
  R: 3.25, // body radius (Ø 6.5 cm, 500 ml class)
  NECK_R: 1.24,
  RING_R: 1.68,
  RING_Y: 17.42,
  RING_T: 0.24,
  TOP_Y: 19.35,
  SEAT_Y: 18.12, // cap skirt bottom when fully screwed on
  FILL_Y: 15.7,
  WALL: 0.07,
};

// [radius, y] control points — Catmull-Rom smoothed into a turned profile
const CTRL: [number, number][] = [
  [0.0, 0.62], [0.9, 0.5], [1.9, 0.26], [2.55, 0.03], [2.85, 0.06], [3.08, 0.3], [3.2, 0.8], [3.25, 1.5],
  [3.25, 3], [3.25, 6], [3.25, 9], [3.25, 11.8], [3.16, 12.35], [3.25, 12.9], [3.22, 13.3], [3.08, 13.95],
  [2.75, 14.6], [2.25, 15.3], [1.78, 15.95], [1.42, 16.55], [1.28, 17.0], [1.24, 17.4], [1.24, BOT.TOP_Y],
];
const PROFILE = new THREE.SplineCurve(CTRL.map(([r, y]) => new THREE.Vector2(r, y)))
  .getPoints(300)
  .map((p) => new THREE.Vector2(Math.max(p.x, 0.001), p.y));
const TAB = PROFILE.filter((p) => p.y >= 12);

/** Outer radius of the bottle at height y. */
export function rAt(y: number) {
  if (y < 12) return BOT.R;
  if (y <= TAB[0].y) return TAB[0].x;
  const last = TAB[TAB.length - 1];
  if (y >= last.y) return last.x;
  let lo = 0;
  let hi = TAB.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (TAB[m].y <= y) lo = m;
    else hi = m;
  }
  const a = TAB[lo];
  const b = TAB[hi];
  return a.x + ((b.x - a.x) * (y - a.y)) / (b.y - a.y || 1);
}

function labelTexture() {
  const W = 1536;
  const H = 512;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const gr = g.createLinearGradient(0, 0, 0, H);
  gr.addColorStop(0, '#ffa64f');
  gr.addColorStop(1, '#ff7f52');
  g.fillStyle = gr;
  g.fillRect(0, 0, W, H);
  const rng = mulberry32(5);
  // flowing wave band
  g.fillStyle = '#fff6e6';
  g.beginPath();
  g.moveTo(0, H * 0.78);
  for (let x = 0; x <= W; x += 8) g.lineTo(x, H * 0.78 + Math.sin((x / W) * TAU * 3) * 20);
  g.lineTo(W, H);
  g.lineTo(0, H);
  g.closePath();
  g.fill();
  g.fillStyle = '#3fb8a8';
  g.beginPath();
  g.moveTo(0, H * 0.72);
  for (let x = 0; x <= W; x += 8) g.lineTo(x, H * 0.72 + Math.sin((x / W) * TAU * 3 + 0.6) * 20);
  for (let x = W; x >= 0; x -= 8) g.lineTo(x, H * 0.75 + Math.sin((x / W) * TAU * 3 + 0.6) * 20);
  g.closePath();
  g.fill();
  // bubbles
  for (let i = 0; i < 90; i++) {
    const x = rng() * W;
    const y = rng() * H * 0.72;
    const r = 5 + rng() * rng() * 46;
    g.strokeStyle = 'rgba(255,246,230,0.75)';
    g.fillStyle = 'rgba(255,246,230,0.22)';
    g.lineWidth = 3;
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fill();
    g.stroke();
  }
  // orange slice emblems
  for (const cx of [384, 1152]) {
    const cy = H * 0.4;
    g.fillStyle = '#fff1d4';
    g.beginPath();
    g.arc(cx, cy, 104, 0, TAU);
    g.fill();
    g.fillStyle = '#ffc45c';
    g.beginPath();
    g.arc(cx, cy, 90, 0, TAU);
    g.fill();
    g.strokeStyle = '#fff1d4';
    g.lineWidth = 6;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TAU;
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(cx + Math.cos(a) * 88, cy + Math.sin(a) * 88);
      g.stroke();
    }
    g.fillStyle = '#ffe1a0';
    g.beginPath();
    g.arc(cx, cy, 14, 0, TAU);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

interface Assets {
  shell: THREE.BufferGeometry;
  liquid: THREE.BufferGeometry;
  label: THREE.BufferGeometry;
  ring: THREE.BufferGeometry;
  thread: THREE.BufferGeometry;
  rim: THREE.BufferGeometry;
  labelTex: THREE.CanvasTexture;
}
let _assets: Assets | null = null;
function assets(): Assets {
  if (_assets) return _assets;
  const liq: THREE.Vector2[] = [new THREE.Vector2(0.001, 0.7), new THREE.Vector2(2.9, 0.7)];
  for (const p of PROFILE) if (p.y >= 1.0 && p.y <= BOT.FILL_Y) liq.push(new THREE.Vector2(Math.max(p.x - 0.1, 0.01), p.y));
  liq.push(new THREE.Vector2(Math.max(rAt(BOT.FILL_Y) - 0.1, 0.01), BOT.FILL_Y), new THREE.Vector2(0.001, BOT.FILL_Y));
  const label = new THREE.CylinderGeometry(BOT.R + 0.035, BOT.R + 0.035, 6.4, 128, 1, true);
  label.translate(0, 7.0, 0);
  const ring = new THREE.CylinderGeometry(BOT.RING_R, BOT.RING_R, BOT.RING_T, 72);
  ring.translate(0, BOT.RING_Y + BOT.RING_T / 2, 0);
  const thread = helixTube(BOT.NECK_R, CAP.PITCH, 3.3, 0.075, 0.6, 6);
  thread.translate(0, 18.2, 0);
  const rim = new THREE.TorusGeometry(BOT.NECK_R, 0.05, 8, 48);
  rim.rotateX(Math.PI / 2);
  rim.translate(0, BOT.TOP_Y, 0);
  _assets = { shell: new THREE.LatheGeometry(PROFILE, 128), liquid: new THREE.LatheGeometry(liq, 96), label, ring, thread, rim, labelTex: labelTexture() };
  return _assets;
}

export function shellMaterial(opacity: number) {
  const m = new THREE.MeshPhysicalMaterial({
    color: '#cfe6f5',
    roughness: 0.06,
    metalness: 0,
    transparent: true,
    opacity,
    clearcoat: 0.6,
    clearcoatRoughness: 0.08,
    ior: 1.5,
    envMapIntensity: 0.85, // gentle: the env is soft and coloured, so highlights read as glass, not white paint
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace(
      '#include <opaque_fragment>',
      `float fres = pow(1.0 - abs(dot(normalize(vViewPosition), normal)), 3.0);
       diffuseColor.a = clamp(diffuseColor.a + fres * 0.32, 0.0, 1.0);
       #include <opaque_fragment>`,
    );
  };
  m.customProgramCacheKey = () => 'petshell-v1';
  return m;
}

let _lite: { shell: THREE.Material; liquid: THREE.Material; label: THREE.Material; ring: THREE.Material; thread: THREE.Material } | null = null;
function liteMats() {
  if (_lite) return _lite;
  const A = assets();
  const pm = paperMaps();
  _lite = {
    shell: shellMaterial(0.26),
    liquid: new THREE.MeshPhysicalMaterial({ color: '#ff8c24', roughness: 0.12, clearcoat: 0.8, emissive: '#ff6a10', emissiveIntensity: 0.12, transparent: true, opacity: 0.9 }),
    label: new THREE.MeshPhysicalMaterial({ map: A.labelTex, roughnessMap: pm.roughnessMap, normalMap: pm.normalMap, normalScale: new THREE.Vector2(0.25, 0.25), roughness: 0.55, clearcoat: 0.25 }),
    ring: shellMaterial(0.5),
    thread: shellMaterial(0.5),
  };
  return _lite;
}

// ───────────────────────────── bubbles ─────────────────────────────
class Bubbles {
  mesh: THREE.InstancedMesh;
  private N = 240;
  private ang = new Float32Array(this.N);
  private rho = new Float32Array(this.N);
  private y = new Float32Array(this.N);
  private spd = new Float32Array(this.N);
  private size = new Float32Array(this.N);
  private ph = new Float32Array(this.N);
  private o = new THREE.Object3D();
  constructor() {
    const r = mulberry32(31);
    for (let i = 0; i < this.N; i++) {
      this.ang[i] = r() * TAU;
      this.rho[i] = Math.sqrt(r());
      this.y[i] = 0.9 + r() * (BOT.FILL_Y - 1.2);
      this.spd[i] = 4 + r() * 9;
      this.size[i] = 0.04 + Math.pow(r(), 2.2) * 0.09;
      this.ph[i] = r() * TAU;
    }
    const mat = new THREE.MeshPhysicalMaterial({ color: '#fff7ea', roughness: 0.08, transparent: true, opacity: 0.6, emissive: '#fff1d6', emissiveIntensity: 0.25 });
    this.mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 8, 6), mat, this.N);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1.5; // after the liquid, before the glass shell
    noDepth(this.mesh);
  }
  update(dt: number, t: number, onPop?: (x: number, z: number) => void) {
    for (let i = 0; i < this.N; i++) {
      this.y[i] += this.spd[i] * dt;
      if (this.y[i] > BOT.FILL_Y - 0.06) {
        const rr = (rAt(BOT.FILL_Y) - 0.15) * this.rho[i];
        if (onPop) onPop(Math.cos(this.ang[i]) * rr, Math.sin(this.ang[i]) * rr);
        this.y[i] = 0.9 + (i % 7) * 0.05;
      }
      const yy = this.y[i];
      const rr = (yy < 12 ? BOT.R - 0.22 : rAt(yy) - 0.2) * this.rho[i];
      const sw = Math.sin(t * 3.1 + this.ph[i]) * 0.05;
      this.o.position.set(Math.cos(this.ang[i]) * rr + sw, yy, Math.sin(this.ang[i]) * rr + Math.cos(t * 2.7 + this.ph[i]) * 0.05);
      this.o.scale.setScalar(this.size[i] * (1 + 0.25 * (yy / BOT.FILL_Y)));
      this.o.updateMatrix();
      this.mesh.setMatrixAt(i, this.o.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ───────────────────────────── gas (kinetic theory) ─────────────────────────────
export class GasSim {
  group = new THREE.Group();
  readonly N = 132;
  arrows = new Arrows(44, '#ffe7a6', 1.7);
  hitRate = 0;
  private p = new Float32Array(this.N * 3);
  private v = new Float32Array(this.N * 3);
  private q: THREE.Quaternion[] = [];
  private ax: THREE.Vector3[] = [];
  private w = new Float32Array(this.N);
  private act = new Uint8Array(this.N);
  private age = new Float32Array(this.N);
  private cMesh: THREE.InstancedMesh;
  private oMesh: THREE.InstancedMesh;
  private rng = mulberry32(99);
  private o = new THREE.Object3D();
  private dq = new THREE.Quaternion();
  private tmp = new THREE.Vector3();
  private budget = 0;
  private hitAge = new Float32Array(44).fill(9);
  private hitPos: THREE.Vector3[] = [];
  private hitDir: THREE.Vector3[] = [];
  private hitCursor = 0;
  private hitCount = 0;
  private hitAcc = 0;
  constructor() {
    for (let i = 0; i < this.N; i++) {
      this.q.push(new THREE.Quaternion());
      this.ax.push(new THREE.Vector3(1, 0, 0));
    }
    for (let i = 0; i < 44; i++) {
      this.hitPos.push(V3());
      this.hitDir.push(V3(0, 1, 0));
    }
    const sg = new THREE.SphereGeometry(1, 20, 14);
    const cMat = new THREE.MeshPhysicalMaterial({ color: '#6f819a', roughness: 0.3, clearcoat: 1, emissive: '#3c4f6c', emissiveIntensity: 0.35 });
    const oMat = new THREE.MeshPhysicalMaterial({ color: '#f2664f', roughness: 0.28, clearcoat: 1, emissive: '#d84a35', emissiveIntensity: 0.4 });
    this.cMesh = new THREE.InstancedMesh(sg, cMat, this.N);
    this.oMesh = new THREE.InstancedMesh(sg, oMat, this.N * 2);
    this.cMesh.frustumCulled = false;
    this.oMesh.frustumCulled = false;
    this.cMesh.renderOrder = 2;
    this.oMesh.renderOrder = 2;
    noDepth(this.cMesh);
    noDepth(this.oMesh);
    this.group.add(this.cMesh, this.oMesh, this.arrows.group);
    this.reset(64);
  }
  reset(n: number) {
    this.act.fill(0);
    this.hitAge.fill(9);
    this.hitRate = 0;
    this.budget = 0;
    const r = this.rng;
    for (let i = 0; i < n; i++) {
      this.act[i] = 1;
      this.age[i] = 1;
      const y = BOT.FILL_Y + 0.4 + r() * (BOT.TOP_Y - 0.4 - BOT.FILL_Y - 0.5);
      const rm = Math.max(0.05, rAt(y) - BOT.WALL - 0.32);
      const a = r() * TAU;
      const rr = rm * Math.sqrt(r());
      this.p[i * 3] = Math.cos(a) * rr;
      this.p[i * 3 + 1] = y;
      this.p[i * 3 + 2] = Math.sin(a) * rr;
      this.randomVel(i);
    }
  }
  private randomVel(i: number) {
    const r = this.rng;
    const g = () => (r() + r() + r() + r() - 2) * 1.7; // ~gaussian (Maxwell components)
    this.v[i * 3] = g() * 22;
    this.v[i * 3 + 1] = g() * 22;
    this.v[i * 3 + 2] = g() * 22;
    this.ax[i].set(r() - 0.5, r() - 0.5, r() - 0.5).normalize();
    this.w[i] = 2 + r() * 7;
    this.q[i].set(r() - 0.5, r() - 0.5, r() - 0.5, r() - 0.5).normalize();
  }
  /** A CO₂ bubble pops at the liquid surface and releases a molecule into the headspace. */
  spawn(x: number, z: number) {
    if (this.budget < 1) return;
    for (let i = 0; i < this.N; i++) {
      if (!this.act[i]) {
        this.budget -= 1;
        this.act[i] = 1;
        this.age[i] = 0;
        const k = 0.28;
        this.p[i * 3] = x * k;
        this.p[i * 3 + 1] = BOT.FILL_Y + 0.35;
        this.p[i * 3 + 2] = z * k;
        this.randomVel(i);
        this.v[i * 3 + 1] = Math.abs(this.v[i * 3 + 1]) + 10;
        return;
      }
    }
  }
  private pushHit(x: number, y: number, z: number, dx: number, dy: number, dz: number) {
    this.hitCount++;
    if (this.rng() > 0.22) return;
    const k = this.hitCursor;
    this.hitCursor = (this.hitCursor + 1) % 44;
    this.hitAge[k] = 0;
    this.hitPos[k].set(x, y, z);
    this.hitDir[k].set(dx, dy, dz);
  }
  update(dt: number, spawnRate = 15) {
    this.budget = Math.min(6, this.budget + dt * spawnRate);
    const yMax = BOT.TOP_Y - 0.22;
    const yMin = BOT.FILL_Y + 0.26;
    let alive = 0;
    for (let i = 0; i < this.N; i++) {
      const o3 = i * 3;
      if (!this.act[i]) {
        this.o.scale.set(0, 0, 0);
        this.o.updateMatrix();
        this.cMesh.setMatrixAt(i, this.o.matrix);
        this.oMesh.setMatrixAt(i * 2, this.o.matrix);
        this.oMesh.setMatrixAt(i * 2 + 1, this.o.matrix);
        continue;
      }
      alive++;
      this.age[i] += dt;
      this.p[o3] += this.v[o3] * dt;
      this.p[o3 + 1] += this.v[o3 + 1] * dt;
      this.p[o3 + 2] += this.v[o3 + 2] * dt;
      if (this.p[o3 + 1] > yMax) {
        this.p[o3 + 1] = yMax;
        if (this.v[o3 + 1] > 0) {
          this.v[o3 + 1] = -this.v[o3 + 1];
          this.pushHit(this.p[o3], yMax, this.p[o3 + 2], 0, 1, 0);
        }
      }
      if (this.p[o3 + 1] < yMin) {
        this.p[o3 + 1] = yMin;
        if (this.v[o3 + 1] < 0) this.v[o3 + 1] = -this.v[o3 + 1];
      }
      const rr = Math.hypot(this.p[o3], this.p[o3 + 2]);
      const rmax = rAt(this.p[o3 + 1]) - BOT.WALL - 0.32;
      if (rr > rmax && rr > 1e-5) {
        const nx = this.p[o3] / rr;
        const nz = this.p[o3 + 2] / rr;
        const s = (rAt(this.p[o3 + 1] + 0.05) - rAt(this.p[o3 + 1] - 0.05)) / 0.1;
        const nl = Math.hypot(1, s);
        const nr = 1 / nl;
        const ny = -s / nl;
        const vn = (this.v[o3] * nx + this.v[o3 + 2] * nz) * nr + this.v[o3 + 1] * ny;
        if (vn > 0) {
          this.v[o3] -= 2 * vn * nr * nx;
          this.v[o3 + 1] -= 2 * vn * ny;
          this.v[o3 + 2] -= 2 * vn * nr * nz;
          this.pushHit(this.p[o3], this.p[o3 + 1], this.p[o3 + 2], nx * nr, ny, nz * nr);
        }
        this.p[o3] = nx * rmax;
        this.p[o3 + 2] = nz * rmax;
      }
      // spin
      this.dq.setFromAxisAngle(this.ax[i], this.w[i] * dt);
      this.q[i].premultiply(this.dq).normalize();
      this.tmp.set(1, 0, 0).applyQuaternion(this.q[i]);
      const sc = smoothstep(0, 0.3, this.age[i]);
      this.o.quaternion.identity();
      this.o.position.set(this.p[o3], this.p[o3 + 1], this.p[o3 + 2]);
      this.o.scale.setScalar(0.13 * sc);
      this.o.updateMatrix();
      this.cMesh.setMatrixAt(i, this.o.matrix);
      for (let s2 = 0; s2 < 2; s2++) {
        const sg = s2 === 0 ? 1 : -1;
        this.o.position.set(this.p[o3] + this.tmp.x * 0.29 * sg * sc, this.p[o3 + 1] + this.tmp.y * 0.29 * sg * sc, this.p[o3 + 2] + this.tmp.z * 0.29 * sg * sc);
        this.o.scale.setScalar(0.118 * sc);
        this.o.updateMatrix();
        this.oMesh.setMatrixAt(i * 2 + s2, this.o.matrix);
      }
    }
    this.cMesh.instanceMatrix.needsUpdate = true;
    this.oMesh.instanceMatrix.needsUpdate = true;
    // arrows (pressure vectors)
    for (let k = 0; k < 44; k++) {
      this.hitAge[k] += dt;
      const a = this.hitAge[k];
      const life = 0.6;
      if (a >= life) {
        this.arrows.hide(k);
        continue;
      }
      const g = a < 0.1 ? a / 0.1 : 1 - (a - 0.1) / (life - 0.1);
      const len = 0.5;
      const d = this.hitDir[k];
      const P = this.hitPos[k];
      this.tmp.set(P.x - d.x * (len + 0.2), P.y - d.y * (len + 0.2), P.z - d.z * (len + 0.2));
      this.arrows.set(k, this.tmp, d, len, 0.032, g);
    }
    this.arrows.flush();
    this.hitAcc += dt;
    if (this.hitAcc > 0.25) {
      this.hitRate = this.hitRate * 0.5 + (this.hitCount / this.hitAcc) * 0.5;
      this.hitCount = 0;
      this.hitAcc = 0;
    }
    return alive;
  }
}

// ───────────────────────────── bottle rig ─────────────────────────────
export interface BottleRig {
  root: THREE.Group;
  shell: THREE.Mesh;
  liquid: THREE.Mesh;
  label: THREE.Mesh;
  band: THREE.Mesh;
  bubbles?: Bubbles;
  gas?: GasSim;
  glow?: THREE.PointLight;
  setXray(k: number, scan?: number): void;
  update(t: number, dt: number, gasRate?: number): void;
}

const xrayVert = `varying vec3 vN; varying vec3 vV; varying float vY;
void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); vY = position.y; gl_Position = projectionMatrix * mv; }`;
const xrayFrag = `varying vec3 vN; varying vec3 vV; varying float vY; uniform float uOpacity; uniform float uTime; uniform float uScan; uniform vec3 uColor;
void main(){
  float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 1.6);
  float lines = smoothstep(0.93, 1.0, sin(vY * 6.0 - uTime * 0.9)) * 0.5;
  float cut = 1.0 - smoothstep(uScan - 0.5, uScan, vY);
  float dd = (vY - uScan) * 2.2;
  float edge = exp(-dd * dd) * 1.6 * step(uScan, 19.4);
  float a = uOpacity * ((0.10 + 0.9 * f + lines * 0.7) * cut + edge * 0.6);
  vec3 col = uColor * (0.35 + 1.5 * f + lines + edge);
  gl_FragColor = vec4(col, a);
}`;

export function createBottle(opts: { lite?: boolean } = {}): BottleRig {
  const A = assets();
  const root = new THREE.Group();
  const lite = !!opts.lite;
  const pm = paperMaps();
  const mats = lite
    ? liteMats()
    : {
        shell: shellMaterial(0.24),
        // liquid does not write depth so the fizz bubbles inside it stay visible
        liquid: new THREE.MeshPhysicalMaterial({ color: '#ff8c24', roughness: 0.12, clearcoat: 0.8, clearcoatRoughness: 0.1, emissive: '#ff6a10', emissiveIntensity: 0.12, transparent: true, opacity: 0.9, depthWrite: false }),
        label: new THREE.MeshPhysicalMaterial({ map: A.labelTex, roughnessMap: pm.roughnessMap, normalMap: pm.normalMap, normalScale: new THREE.Vector2(0.25, 0.25), roughness: 0.55, clearcoat: 0.25, transparent: true }),
        ring: shellMaterial(0.5),
        thread: shellMaterial(0.5),
      };
  const liquid = new THREE.Mesh(A.liquid, mats.liquid);
  liquid.renderOrder = 1;
  const shell = new THREE.Mesh(A.shell, mats.shell);
  shell.renderOrder = 2;
  const label = new THREE.Mesh(A.label, mats.label);
  label.castShadow = true;
  const ring = new THREE.Mesh(A.ring, mats.ring);
  ring.renderOrder = 2;
  const thread = new THREE.Mesh(A.thread, mats.thread);
  thread.renderOrder = 2;
  const rim = new THREE.Mesh(A.rim, mats.ring);
  rim.renderOrder = 2;
  const band = createBand();
  band.position.y = BOT.SEAT_Y - CAP.BAND_H;
  liquid.castShadow = !lite;
  shell.castShadow = false; // clear PET must not throw a solid shadow
  if (!lite) {
    // hero bottle stays in AO / depth-of-field depth even though its materials are blended
    shell.userData.keepDepth = true;
    liquid.userData.keepDepth = true;
    label.userData.keepDepth = true;
  }
  root.add(liquid, shell, label, ring, thread, rim, band);

  const rig: BottleRig = {
    root,
    shell,
    liquid,
    label,
    band,
    setXray: () => {},
    update: () => {},
  };
  if (lite) return rig;

  const bubbles = new Bubbles();
  const gas = new GasSim();
  gas.group.visible = false;
  root.add(bubbles.mesh, gas.group);
  const U = { uOpacity: { value: 0 }, uTime: { value: 0 }, uScan: { value: 40 }, uColor: { value: new THREE.Color('#9fe6f2') } };
  const xmat = new THREE.ShaderMaterial({ uniforms: U, vertexShader: xrayVert, fragmentShader: xrayFrag, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false });
  const xshell = new THREE.Mesh(A.shell, xmat);
  xshell.renderOrder = 4;
  xshell.visible = false;
  noDepth(xshell);
  const xring = new THREE.Mesh(A.ring, xmat);
  xring.renderOrder = 4;
  xring.visible = false;
  root.add(xshell, xring);
  const glow = new THREE.PointLight('#ffd28a', 0, 9, 1.6);
  glow.position.set(0, BOT.TOP_Y - 0.6, 0);
  root.add(glow);
  rig.bubbles = bubbles;
  rig.gas = gas;
  rig.glow = glow;

  rig.setXray = (k, scan = 40) => {
    const kk = clamp(k);
    (mats.shell as THREE.MeshPhysicalMaterial).opacity = 0.24 * (1 - kk);
    shell.visible = kk < 0.995;
    xshell.visible = kk > 0.005;
    xring.visible = kk > 0.005;
    U.uOpacity.value = kk;
    U.uScan.value = kk >= 0.999 ? 40 : scan;
    (mats.liquid as THREE.MeshPhysicalMaterial).opacity = 0.9 - 0.55 * kk;
    (mats.liquid as THREE.MeshPhysicalMaterial).emissiveIntensity = 0.12 + 0.3 * kk;
    (mats.label as THREE.MeshPhysicalMaterial).opacity = 1 - smoothstep(0.05, 0.55, kk);
    label.visible = kk < 0.56;
    gas.group.visible = kk > 0.02;
  };
  rig.update = (t, dt, gasRate = 15) => {
    U.uTime.value = t;
    bubbles.update(dt, t, gas.group.visible ? (x, z) => gas.spawn(x, z) : undefined);
    if (gas.group.visible) gas.update(dt, gasRate);
  };
  return rig;
}
