// director.ts — the 24-second timeline (cut to the voiceover). Builds the world, then every frame turns time `t` into:
// bottle / cap / hand poses, physics + particle steps (slow-motion aware), palette, lights and camera.
import * as THREE from 'three';
import { BOT, createBottle } from './bottle';
import { CAP, createCap } from './cap';
import { Arrows, FlowLines, Physics, ShockRing, Spray, glowSprite } from './effects';
import { Backdrop, createFactory, createStudio } from './env';
import { loadHand } from './hand';
import type { HandRig } from './hand';
import { PAL, TAU, clamp, easeInCubic, easeInOutCubic, easeOutCubic, lensToFov, lerp, mulberry32, roundedBox, smoothstep, V3 } from './kit';
import type { Palette } from './kit';

export const DURATION = 24;

interface Key {
  t: number;
  tx: number;
  ty: number;
  tz: number;
  az: number;
  el: number;
  rad: number;
  lens: number;
  ap: number;
}
interface Shot {
  t0: number;
  t1: number;
  keys: Key[];
}
const K = (t: number, tx: number, ty: number, tz: number, az: number, el: number, rad: number, lens: number, ap = 1): Key => ({ t, tx, ty, tz, az, el, rad, lens, ap });
const FIELDS: (keyof Key)[] = ['tx', 'ty', 'tz', 'az', 'el', 'rad', 'lens', 'ap'];

function hermite(keys: Key[], field: keyof Key, t: number) {
  const n = keys.length;
  if (t <= keys[0].t) return keys[0][field];
  if (t >= keys[n - 1].t) return keys[n - 1][field];
  let i = 0;
  while (i < n - 2 && t > keys[i + 1].t) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const dt = b.t - a.t;
  const s = (t - a.t) / dt;
  const slope = (j: number) => {
    const p = keys[Math.max(0, j - 1)];
    const q = keys[Math.min(n - 1, j + 1)];
    return (q[field] - p[field]) / (q.t - p.t || 1);
  };
  const s2 = s * s;
  const s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * a[field] + (s3 - 2 * s2 + s) * dt * slope(i) + (-2 * s3 + 3 * s2) * b[field] + (s3 - s2) * dt * slope(i + 1);
}

export interface CamOut {
  focus: number;
  aperture: number;
  blurDir: THREE.Vector2;
  blurAmt: number;
  fade: number;
  vig: number;
}

const UP = V3(0, 1, 0);
const CAP_MID = BOT.SEAT_Y + CAP.H / 2;

const _palCache: Partial<Record<keyof typeof PAL, Record<'skyTop' | 'skyBottom' | 'key' | 'rim' | 'fill' | 'ground', THREE.Color>>> = {};
function palColors(name: keyof typeof PAL) {
  let c = _palCache[name];
  if (!c) {
    const p = PAL[name];
    c = { skyTop: new THREE.Color(p.skyTop), skyBottom: new THREE.Color(p.skyBottom), key: new THREE.Color(p.keyLight), rim: new THREE.Color(p.rimLight), fill: new THREE.Color(p.fill), ground: new THREE.Color(p.ground) };
    _palCache[name] = c;
  }
  return c;
}

export class Director {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(30, 1, 0.3, 4000);
  aspect = 1;
  // physically-based light units (no legacy π factor). Key 1.35 → a white surface facing it lands at ≈0.43,
  // + hemisphere + soft IBL ≈ 0.8 total: bright and saturated, highlights never clipping to white.
  key = new THREE.DirectionalLight('#fff1dc', 1.35);
  rim = new THREE.DirectionalLight('#8fd0ff', 0.85);
  fill = new THREE.DirectionalLight('#dff0ff', 0.3);
  hemi = new THREE.HemisphereLight('#dff1ff', '#f0d9c0', 0.38);
  private backdrop = new Backdrop();
  private studio = createStudio();
  private factory = createFactory();
  private bottle = createBottle();
  private cap = createCap();
  private hand: HandRig | null = null;
  private spray = new Spray();
  private physics = new Physics();
  private ring = new ShockRing();
  private bigArrows = new Arrows(14, '#ffd970', 2.0);
  private radial = new Arrows(48, '#8ff0b8', 1.5);
  private funnel: FlowLines;
  private greenRing: FlowLines;
  private hot: THREE.Sprite[] = [];
  private hits: THREE.Sprite[] = [];
  private shardMat = new THREE.MeshPhysicalMaterial({ color: '#f6f0e2', roughness: 0.45, clearcoat: 0.4 });
  private shards: THREE.Mesh[] = [];
  private rng = mulberry32(4242);
  private shots: Shot[] = [];
  private prevT = -1;
  private simT = 0;
  private snapSim = -1;
  private carryJet = 0;
  private carryGey = 0;
  private carryLeak = 0;
  private flying = false;
  private fClock = 0;
  private palCur!: Record<'skyTop' | 'skyBottom' | 'key' | 'rim' | 'fill' | 'ground', THREE.Color>;
  private white = new THREE.Color('#ffffff');
  private palTarget = 'studio' as keyof typeof PAL;
  private tmp = V3();
  private tmp2 = V3();
  private tmpQ = new THREE.Quaternion();
  private lookM = new THREE.Matrix4();
  private fs = 1;

  constructor() {
    const s = this.scene;
    s.fog = new THREE.Fog('#e3f4f4', 160, 950);
    s.add(this.backdrop.mesh, this.studio.group, this.factory.group);
    this.factory.group.visible = false;

    // lights: shadow-casting key, coloured rim, soft fill, hemisphere
    const k = this.key;
    k.castShadow = true;
    k.shadow.mapSize.set(4096, 4096);
    k.shadow.bias = -0.0002;
    k.shadow.normalBias = 0.03;
    k.shadow.radius = 3;
    const sc = k.shadow.camera;
    sc.near = 10;
    sc.far = 260;
    sc.left = -46;
    sc.right = 46;
    sc.top = 46;
    sc.bottom = -46;
    s.add(k, k.target, this.rim, this.rim.target, this.fill, this.fill.target, this.hemi);

    // hero bottle + cap
    s.add(this.bottle.root, this.cap.holder, this.spray.group, this.ring.mesh);
    this.cap.holder.position.set(0, CAP_MID, 0);
    this.bottle.root.add(this.bigArrows.group);
    // impact flashes where pressure vectors strike the cap liner (beat 2)
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU;
      const s = glowSprite('#ffe9a8', 1.1, 1.8);
      s.position.set(Math.cos(a) * 0.7, BOT.TOP_Y - 0.35, Math.sin(a) * 0.7);
      s.visible = false;
      this.bottle.root.add(s);
      this.hits.push(s);
    }
    this.cap.root.add(this.radial.group);

    // stress-flow lines: force funnelled from mid-sides into the four corners
    const y = CAP.H + 0.05;
    const c0 = 1.5;
    const curves: THREE.Curve<THREE.Vector3>[] = [];
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        curves.push(new THREE.CatmullRomCurve3([V3(sx * 1.36, y, 0), V3(sx * 1.4, y + 0.02, sz * 0.7), V3(sx * c0, y, sz * c0)]));
        curves.push(new THREE.CatmullRomCurve3([V3(0, y, sz * 1.36), V3(sx * 0.7, y + 0.02, sz * 1.4), V3(sx * c0, y, sz * c0)]));
        curves.push(new THREE.CatmullRomCurve3([V3(0, y, 0), V3(sx * 0.8, y + 0.03, sz * 0.8), V3(sx * c0, y, sz * c0)]));
        const h = glowSprite('#ff4a3a', 1.6, 1.6);
        h.position.set(sx * c0, y + 0.1, sz * c0);
        this.hot.push(h);
        this.cap.root.add(h);
      }
    }
    this.funnel = new FlowLines(curves, 0.038, '#ff9a86', 2.0, 1.2, true);
    this.cap.root.add(this.funnel.group);
    // smooth 360° green pressure rings (round cap)
    const ringCurve = (r: number, yy: number) => {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i < 72; i++) {
        const a = (i / 72) * TAU;
        pts.push(V3(Math.cos(a) * r, yy, -Math.sin(a) * r));
      }
      return new THREE.CatmullRomCurve3(pts, true);
    };
    this.greenRing = new FlowLines([ringCurve(CAP.R + 0.1, 0.8), ringCurve(1.35, CAP.H + 0.05)], 0.035, '#8ff0b8', 1.7, 0.7, false);
    this.cap.root.add(this.greenRing.group);

    this.bottle.gas!.group.visible = false;
    this.buildShots();
    this.reset();
  }

  async load() {
    this.hand = await loadHand();
    if (this.hand) {
      this.fs = this.hand.fingerSide;
      this.hand.group.visible = false;
      this.scene.add(this.hand.group);
      this.buildShots();
    }
  }

  get hasHand() {
    return !!this.hand;
  }

  private buildShots() {
    const f = this.fs;
    this.shots = [
      // 50mm: natural perspective while the hand grips and twists (voiceover: square caps / better grip)
      { t0: 0, t1: 2.8, keys: [K(0, -2.6 * f, 19.8, 0, 0.85 * f, 0.24, 13.0, 50), K(0.85, -1.8 * f, 19.4, 0, 0.62 * f, 0.19, 9.6, 50), K(1.3, -1.0 * f, 19.2, 0, 0.5 * f, 0.16, 7.2, 52), K(1.55, -0.6 * f, 19.1, 0, 0.44 * f, 0.15, 7.6, 50), K(2.8, 0, 19.0, 0, 0.3 * f, 0.13, 6.4, 50)] },
      // X-ray zoom into the bottle, on to the cap's corners, through the slow-motion failure (35mm → 100mm → 35mm)
      {
        t0: 2.8,
        t1: 15.2,
        keys: [
          K(2.8, 0, 10.2, 0, 0.5, 0.08, 12.5, 40, 0.5),
          K(3.9, 0, 13.8, 0, 0.35, 0.1, 7.2, 60, 0.8),
          K(4.8, 0, 16.6, 0, 0.1, 0.1, 4.2, 80, 1.0),
          K(5.6, 0, 18.0, 0, -0.15, 0.12, 3.0, 90, 1.1),
          K(6.4, 0, 18.7, 0, -0.3, 0.16, 2.8, 90, 1.3),
          K(7.5, 0, 19.5, 0, -0.05, 0.6, 3.2, 85, 1.5),
          K(8.6, 1.0, 19.5, 1.0, 0.785, 0.38, 2.3, 100, 1.7),
          K(9.8, 1.35, 19.3, 1.35, 1.0, 0.2, 1.8, 100, 1.8),
          K(10.8, 0.9, 19.2, 0.9, 0.75, 0.2, 2.7, 85, 1.5),
          K(11.8, 0.7, 19.1, 0.7, 0.62, 0.14, 3.2, 70, 1.2),
          K(12.8, 3.0, 29, 2.0, 0.45, 0.16, 11, 45, 0.8),
          K(14.0, 5.0, 24, 3.0, 0.3, 0.2, 15, 35, 0.6),
          K(15.2, 6.0, 20, 3.0, 0.2, 0.22, 16, 35, 0.6),
        ],
      },
      // macro on the cap while it becomes round and the pressure spreads
      { t0: 15.2, t1: 17.6, keys: [K(15.2, 0, 19.0, 0, 0.9, 0.5, 3.8, 85, 1.6), K(16.4, 0, 18.9, 0, 0.3, 0.38, 3.2, 85, 1.6), K(17.6, 0, 18.8, 0, -0.3, 0.28, 3.0, 85, 1.6)] },
      // bottling line: tight low push at the chuck, quick heli reveal, crane-up to plan view
      {
        t0: 17.6,
        t1: 24,
        keys: [
          K(17.6, 0, 27.2, 0, 0.75, 0.06, 7.5, 55, 1.4),
          K(19.0, 2, 27.5, -3, 0.3, 0.22, 12, 42, 1.1),
          K(20.4, 0, 26, -6, -0.3, 0.36, 25, 32, 0.8),
          K(21.6, 0, 22, -7, -0.55, 0.44, 48, 28, 0.6),
          K(22.8, 0, 20, -8, -0.9, 0.62, 53, 28, 0.6),
          K(24, 0, 18, -8, -1.15, 0.85, 57, 28, 0.6),
        ],
      },
    ];
  }

  // ───────────────────────── reset (loop restart) ─────────────────────────
  reset() {
    this.rng = mulberry32(4242); // deterministic: every loop and every export plays identically
    this.prevT = -1;
    this.simT = 0;
    this.snapSim = -1;
    this.flying = false;
    this.fClock = 0;
    this.carryJet = this.carryGey = this.carryLeak = 0;
    this.spray.clear();
    this.physics.reset();
    for (const m of this.shards) {
      this.scene.remove(m);
    }
    this.shards = [];
    this.cap.reset();
    this.cap.holder.position.set(0, CAP_MID, 0);
    this.cap.holder.rotation.set(0, 0, 0);
    this.cap.holder.quaternion.identity();
    this.bottle.band.position.set(0, BOT.SEAT_Y - CAP.BAND_H, 0);
    this.bottle.band.rotation.set(0, 0, 0);
    this.bottle.root.rotation.set(0, 0, 0);
    this.bottle.gas!.reset(90);
    this.palTarget = 'studio';
    this.snapPalette('studio');
    this.funnel.set(0, 0);
    this.greenRing.set(0, 0);
    this.radial.hideAll();
    this.bigArrows.hideAll();
    this.hot.forEach((h) => (h.visible = false));
    this.hits.forEach((h) => (h.visible = false));
  }

  private snapPalette(name: keyof typeof PAL) {
    const p: Palette = PAL[name];
    if (!this.palCur) {
      this.palCur = { skyTop: new THREE.Color(p.skyTop), skyBottom: new THREE.Color(p.skyBottom), key: new THREE.Color(p.keyLight), rim: new THREE.Color(p.rimLight), fill: new THREE.Color(p.fill), ground: new THREE.Color(p.ground) };
    }
    this.palCur.skyTop.set(p.skyTop);
    this.palCur.skyBottom.set(p.skyBottom);
    this.palCur.key.set(p.keyLight);
    this.palCur.rim.set(p.rimLight);
    this.palCur.fill.set(p.fill);
    this.palCur.ground.set(p.ground);
  }

  private simRate(t: number) {
    if (t < 11.65) return 1;
    if (t < 11.95) return lerp(1, 0.18, easeInOutCubic((t - 11.65) / 0.3));
    if (t < 14.0) return 0.18;
    if (t < 14.9) return lerp(0.18, 0.6, easeInOutCubic((t - 14.0) / 0.9));
    if (t < 15.2) return 0.6;
    return 1;
  }

  private spawnShards(twist: number) {
    const c = Math.cos(twist);
    const s = Math.sin(twist);
    for (let i = 0; i < 9; i++) {
      const r = this.rng;
      const sx = 0.22 + r() * 0.34;
      const sy = 0.12 + r() * 0.2;
      const sz = 0.2 + r() * 0.3;
      const m = new THREE.Mesh(roundedBox(1, 1, 1, 0.18, 1), this.shardMat);
      m.scale.set(sx, sy, sz);
      m.castShadow = true;
      this.scene.add(m);
      this.shards.push(m);
      const lx = 1.55 + r() * 0.2;
      const lz = 1.55 + r() * 0.2;
      const p = V3(lx * c + lz * s, 18.6 + r() * 0.9, -lx * s + lz * c);
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(r() * 3, r() * 3, r() * 3));
      const v = V3(0.7 * (60 + r() * 90) + (r() - 0.5) * 50, 70 + r() * 110, 0.7 * (60 + r() * 90) + (r() - 0.5) * 50);
      const w = V3((r() - 0.5) * 34, (r() - 0.5) * 34, (r() - 0.5) * 34);
      this.physics.addBox([sx / 2, sy / 2, sz / 2], p, q, v, w, 0.04, m);
    }
  }

  private launchCap() {
    const h = this.cap.holder;
    this.cap.setBridges(0);
    this.ring.trigger(V3(0, BOT.SEAT_Y + 0.1, 0));
    this.physics.addBox([CAP.A, CAP.H / 2, CAP.A], h.position.clone(), h.quaternion.clone(), V3(46, 205, 32), V3(6.5, 9, -5), 0.6, h);
    this.flying = true;
    this.snapSim = this.simT;
    this.bottle.band.position.y -= 0.05;
    this.bottle.band.rotation.z = 0.03;
    // opening burst
    for (const [cx, cz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const d = V3(cx, 0.3, cz).normalize();
      this.spray.emit(V3(cx * 2.1, 18.3, cz * 2.1), d, 330, 0.25, 60, 0.12);
    }
  }

  // ───────────────────────── per-frame ─────────────────────────
  update(t: number, dt: number): CamOut {
    if (t < this.prevT - 1e-3) this.reset();
    const prev = this.prevT;
    const crossed = (a: number) => prev < a && t >= a;
    const cap = this.cap;
    const bottle = this.bottle;
    const hand = this.hand;
    const fs = this.fs;

    // ── slow-motion aware simulation clock
    const rate = this.simRate(t);
    const sdt = Math.min(dt, 0.05) * rate;
    this.simT += sdt;

    // ── cuts / one-shot events (pinned to the voiceover)
    if (crossed(2.8)) {
      cap.reset();
      cap.holder.position.set(0, CAP_MID, 0);
      cap.holder.rotation.set(0, 0, 0);
      for (const m of this.shards) this.scene.remove(m);
      this.shards = [];
      this.physics.reset();
      this.spray.clear();
      bottle.gas!.reset(90);
      bottle.root.rotation.set(0, 0, 0);
      this.snapPalette('xray');
    }
    if (crossed(1.35)) this.spawnShards(0.67);
    if (crossed(11.8)) this.launchCap();
    if (crossed(15.2)) {
      cap.reset();
      cap.holder.position.set(0, CAP_MID, 0);
      cap.holder.rotation.set(0, 0, 0);
      cap.holder.quaternion.identity();
      cap.uniforms.uHeatMix.value = 1;
      this.flying = false;
      this.physics.reset();
      for (const m of this.shards) this.scene.remove(m);
      this.shards = [];
      this.spray.clear();
      bottle.band.position.set(0, BOT.SEAT_Y - CAP.BAND_H, 0);
      bottle.band.rotation.set(0, 0, 0);
      bottle.root.rotation.set(0, 0, 0);
    }
    if (crossed(17.6)) this.snapPalette('factory');

    // ── which set is on stage
    const inFactory = t >= 17.6;
    this.studio.group.visible = !inFactory;
    this.factory.group.visible = inFactory;
    bottle.root.visible = !inFactory;
    cap.holder.visible = !inFactory;
    this.spray.group.visible = !inFactory;

    // ── palette target
    this.palTarget = t < 2.8 ? 'studio' : t < 6.2 ? 'xray' : t < 17.6 ? 'macro' : 'factory';

    // ── BEAT 1 — hand twists the square cap, it cracks (VO: "Square bottle caps… ruin your beverage.")
    let twist = 0;
    let rise = 0;
    if (t < 2.8) {
      twist = 0.85 * easeInOutCubic(clamp((t - 0.8) / 0.75));
      rise = (CAP.PITCH * twist) / TAU;
      if (t > 1.35) {
        cap.setCrack(clamp((t - 1.35) / 0.22));
        const kick = Math.exp(-(t - 1.35) * 9);
        rise += 0.08 * kick;
        // fizz seeping from the crack
        if (t < 2.5) {
          this.carryLeak += 55 * (1 - (t - 1.35) / 1.15) * sdt;
          while (this.carryLeak >= 1) {
            this.carryLeak -= 1;
            this.spray.emit(V3(1.6, 18.9, 1.6), V3(0.7, 0.55, 0.7).normalize(), 95, 0.35, 1, 0.2);
          }
        }
      }
    }
    if (hand) {
      const show = t < 2.75;
      hand.group.visible = show;
      if (show) {
        const app = easeOutCubic(clamp(t / 0.8));
        const grip = easeInOutCubic(clamp((t - 0.25) / 0.55));
        const rel = easeInCubic(clamp((t - 1.45) / 0.65));
        const open = easeOutCubic(clamp((t - 1.4) / 0.3));
        const k = lerp(grip, 0.1, open);
        const shake = t > 1.35 ? Math.exp(-(t - 1.35) * 10) * Math.sin(t * 80) * 0.12 : 0;
        try {
          hand.setPose(k);
          hand.setOffset(this.tmp.set(-fs * (9 * (1 - app) + 8 * rel), 9 * (1 - app) + 13 * rel + shake, 3 * (1 - app) + 2.5 * rel));
          hand.group.position.set(0, CAP_MID + rise, 0);
          hand.group.rotation.y = twist;
        } catch (err) {
          console.warn('[hand] pose failed, hiding hand', err);
          hand.group.visible = false;
          this.hand = null;
        }
      }
    }

    // ── X-ray reveal (beat 2, VO: "Carbonated drinks build up intense internal gas pressure…") → back to solid (beat 3)
    let xk = 0;
    let scan = 40;
    if (t >= 2.8 && t < 6.2) {
      const p = clamp((t - 2.8) / 0.8);
      xk = easeInOutCubic(p);
      scan = lerp(-1, 21, p);
    } else if (t >= 6.2 && t < 7.4) {
      xk = 1 - easeInOutCubic((t - 6.2) / 1.2);
    }
    bottle.setXray(xk, scan);
    cap.setXray(xk);

    // ── BEAT 3/4 — stress map, flow, bulge, snap
    // VO beat 3 (6.6–10.8): "force gets jammed directly into the four sharp corners…"
    // VO beat 4 (10.8–15.2): "This warps the plastic, breaking the airtight seal…"
    const heatIn = smoothstep(6.4, 7.1, t);
    let heat = heatIn;
    let bulge = 0;
    let flowA = smoothstep(7.0, 7.7, t);
    // right-angle marks pop corner by corner, clockwise from the front-right
    const markA = [0, 1, 2, 3].map((c) => smoothstep(7.2 + c * 0.16, 7.7 + c * 0.16, t));
    if (t >= 10.6 && t < 15.2) {
      bulge = Math.pow(smoothstep(10.6, 11.8, t), 1.5);
      if (t >= 11.8) {
        bulge = lerp(1, 0.7, smoothstep(11.8, 13.4, t));
        heat = 1 - smoothstep(11.95, 13.1, t);
        flowA *= 1 - smoothstep(11.8, 12.1, t);
        for (let c = 0; c < 4; c++) markA[c] *= 1 - smoothstep(11.8, 12.0, t);
      }
    }
    if (t >= 15.2) {
      // beat 5a: the square cap turns into a circle; stress map relaxes into an even green ring
      // VO: "Round caps spread pressure equally across the entire circle…"
      heat = 1;
      const r = easeInOutCubic(clamp((t - 15.6) / 0.9));
      cap.setRound(r);
      flowA = 1 - smoothstep(15.6, 16.2, t);
      for (let c = 0; c < 4; c++) markA[c] = 1 - smoothstep(15.5 + c * 0.05, 16.0 + c * 0.05, t);
      bulge = 0;
    }
    if (t < 6.4) {
      heat = 0;
      flowA = 0;
      for (let c = 0; c < 4; c++) markA[c] = 0;
    }
    if (t >= 2.8 && t < 15.2) cap.setRound(0);
    cap.uniforms.uHeatMix.value = t < 17.6 ? heat : 0;
    cap.uniforms.uBulge.value = bulge;
    cap.uniforms.uHeatAmp.value = 1 + 0.14 * bulge + (t < 11.6 ? 0.09 * Math.sin(t * 6) * heat : 0);
    cap.uniforms.uTime.value = t;
    cap.setMarkers4(markA.map((a) => a * 0.95));
    this.funnel.set(t, flowA * (t < 17.6 ? 1 : 0));
    const pulse = 0.75 + 0.25 * Math.sin(t * 8);
    this.hot.forEach((h, i) => {
      h.visible = flowA > 0.02;
      const s = (1.3 + 0.35 * Math.sin(t * 8 + i)) * (0.4 + 0.6 * bulge + 0.4);
      h.scale.setScalar(s);
      (h.material as THREE.SpriteMaterial).opacity = flowA * pulse;
    });

    // ── cap transform (before it is released to the physics engine)
    if (!this.flying && t < 17.6) {
      const trem = bulge * 0.014 + heat * 0.004;
      cap.holder.position.set(Math.sin(t * 97) * trem, CAP_MID + rise + Math.sin(t * 131) * trem, Math.cos(t * 89) * trem);
      cap.holder.rotation.y = twist;
    }

    // ── droplets / geyser after the seal fails (sim-time driven → slow motion)
    if (this.flying) {
      const k = this.simT - this.snapSim;
      const inten = Math.exp(-k / 0.75);
      if (k < 2.2) {
        this.carryJet += 430 * inten * sdt;
        while (this.carryJet >= 1) {
          this.carryJet -= 1;
          const c = Math.floor(this.rng() * 4);
          const cx = c % 2 ? 1 : -1;
          const cz = c < 2 ? 1 : -1;
          this.spray.emit(V3(cx * 2.1, 18.25 + this.rng() * 0.4, cz * 2.1), this.tmp.set(cx, 0.3, cz).normalize(), 320, 0.22, 1, 0.1);
        }
      }
      if (k > 0.08 && k < 3.2) {
        this.carryGey += 380 * Math.exp(-(k - 0.08) / 1.1) * sdt;
        while (this.carryGey >= 1) {
          this.carryGey -= 1;
          this.spray.emit(this.tmp2.set(0, BOT.TOP_Y + 0.05, 0), UP, 250, 0.3, 1, 0.34);
        }
      }
      bottle.root.rotation.z = 0.014 * Math.exp(-k * 3) * Math.sin(k * 34);
      bottle.root.rotation.x = 0.01 * Math.exp(-k * 3) * Math.cos(k * 29);
    }
    if (t >= 2.8 && t < 10.6) {
      bottle.root.rotation.set(0, 0, 0);
    }
    this.physics.step(sdt);
    this.spray.update(sdt);
    this.ring.update(sdt);

    // ── bottle internals (bubbles, gas) — run on sim time so slow-mo slows the fizz too
    bottle.update(t, sdt, 30);
    const gas = bottle.gas!;
    if (xk > 0.02) {
      const appear = smoothstep(3.3, 3.9, t) * (1 - smoothstep(5.8, 6.3, t)) * xk;
      for (let i = 0; i < 14; i++) {
        const a = ((i % 12) / 12) * TAU;
        const r = i < 12 ? 0.62 : 0.2;
        const p = 0.65 + 0.35 * Math.sin(t * 9 + i * 1.3);
        this.bigArrows.set(i, this.tmp.set(Math.cos(a) * r, BOT.TOP_Y - 1.5, Math.sin(a) * r), UP, 1.3, 0.05, appear * p);
      }
      this.bigArrows.flush();
      const hit = clamp(gas.hitRate / 500);
      bottle.glow!.intensity = 7 * hit * xk;
      (cap.liner.material as THREE.MeshPhysicalMaterial).emissiveIntensity = 1.6 * hit;
      // the whole bottle shudders under the violent bombardment
      bottle.root.rotation.z = 0.005 * Math.sin(t * 43) * xk;
      bottle.root.rotation.x = 0.004 * Math.cos(t * 37) * xk;
      this.hits.forEach((s, i) => {
        s.visible = appear > 0.02;
        (s.material as THREE.SpriteMaterial).opacity = appear * (0.35 + 0.65 * Math.pow(0.5 + 0.5 * Math.sin(t * 17 + i * 2.4), 2));
        s.scale.setScalar(0.8 + 0.5 * appear + 0.2 * Math.sin(t * 23 + i));
      });
    } else {
      bottle.glow!.intensity = 0;
      (cap.liner.material as THREE.MeshPhysicalMaterial).emissiveIntensity = 0;
      this.hits.forEach((s) => (s.visible = false));
    }

    // ── beat 5a ring of equal force (VO: "spread pressure equally across the entire circle")
    if (t >= 15.2 && t < 17.6) {
      const g = smoothstep(16.2, 16.7, t);
      this.greenRing.set(t, g);
      const pulseR = 0.92 + 0.08 * Math.sin(t * 5);
      for (let i = 0; i < 48; i++) {
        const a = (i / 48) * TAU;
        const pop = clamp((t - 16.4 - i * 0.01) / 0.3);
        const gain = (1 - Math.pow(1 - pop, 3)) * pulseR;
        const d = this.tmp.set(Math.cos(a), 0, -Math.sin(a));
        this.tmp2.set(Math.cos(a) * (CAP.R + 0.22), 0.8, -Math.sin(a) * (CAP.R + 0.22));
        this.radial.set(i, this.tmp2, d, 0.55, 0.03, gain);
      }
      this.radial.flush();
    } else {
      this.greenRing.set(t, 0);
      if (t >= 17.6 || t < 15.2) this.radial.group.visible = false;
    }
    if (t >= 15.2 && t < 17.6) this.radial.group.visible = true;

    // ── factory (beat 5b, VO tail: "factory machines can screw them on in milliseconds")
    if (inFactory) {
      const speed = t < 21 ? 1 : lerp(1, 1.3, smoothstep(21, 23, t));
      this.fClock += Math.min(dt, 0.05) * speed;
      this.factory.update(this.fClock);
    } else {
      this.studio.update(t);
    }

    // ── palette / lights
    const tp = palColors(this.palTarget);
    const a = 1 - Math.exp(-Math.min(dt, 0.05) * 2.6);
    const pc = this.palCur;
    pc.skyTop.lerp(tp.skyTop, a);
    pc.skyBottom.lerp(tp.skyBottom, a);
    pc.key.lerp(tp.key, a);
    pc.rim.lerp(tp.rim, a);
    pc.fill.lerp(tp.fill, a);
    pc.ground.lerp(tp.ground, a);
    this.backdrop.set(pc.skyTop, pc.skyBottom);
    (this.scene.fog as THREE.Fog).color.copy(pc.skyBottom);
    this.studio.floorMat.color.copy(pc.skyBottom);
    this.key.color.copy(pc.key);
    this.rim.color.copy(pc.rim);
    this.fill.color.copy(pc.fill);
    this.hemi.color.copy(pc.skyTop).lerp(this.white, 0.6);
    this.hemi.groundColor.copy(pc.ground);

    const cam = this.updateCamera(t);
    this.prevT = t;
    return cam;
  }

  // ───────────────────────── camera ─────────────────────────
  private updateCamera(t: number): CamOut {
    const idx = this.shots.findIndex((s) => t >= s.t0 && t < s.t1);
    const si = idx < 0 ? this.shots.length - 1 : idx;
    const shot = this.shots[si];
    const v: Record<string, number> = {};
    for (const f of FIELDS) v[f] = hermite(shot.keys, f, Math.min(t, shot.t1));
    const cam = this.camera;
    const vfov = lensToFov(v.lens);
    const half = THREE.MathUtils.degToRad(vfov) / 2;
    const hHalf = Math.atan(Math.tan(half) * this.aspect);
    // ×1.14 framing margin: the subject fits inside the upper ~75% of frame, above the caption band
    let dist = (v.rad / Math.min(Math.sin(half), Math.sin(hHalf))) * 1.14;

    // whip-in on the cut (first 14%) + push-out on exit (last 12%)
    const len = shot.t1 - shot.t0;
    const cutIn = si > 0;
    const cutOut = si < this.shots.length - 1;
    let inK = 0;
    let outK = 0;
    const winIn = Math.min(0.14 * len, 0.45);
    const winOut = Math.min(0.12 * len, 0.4);
    const el = t - shot.t0;
    if (cutIn && el < winIn) {
      inK = 1 - easeOutCubic(clamp(el / winIn));
      dist *= 1 + 0.18 * inK;
    }
    if (cutOut && len - el < winOut) {
      outK = easeInCubic(clamp(1 - (len - el) / winOut));
      dist *= 1 + 0.1 * outK;
    }
    const target = this.tmp2.set(v.tx, v.ty, v.tz);
    const cp = cam.position;
    cp.set(target.x + dist * Math.cos(v.el) * Math.sin(v.az), target.y + dist * Math.sin(v.el), target.z + dist * Math.cos(v.el) * Math.cos(v.az));
    // handheld breathing + impact shakes
    let sh = 0;
    if (t > 1.35) sh += 0.8 * Math.exp(-(t - 1.35) * 7) * Math.sin(t * 75);
    if (t > 11.8) sh += 0.6 * Math.exp(-(t - 11.8) * 5) * Math.sin(t * 62);
    const bx = Math.sin(t * 1.7) * 0.0035 * dist + sh * 0.012 * dist;
    const by = Math.sin(t * 2.3) * 0.0025 * dist + sh * 0.009 * dist;
    this.lookM.lookAt(cp, target, UP);
    this.tmpQ.setFromRotationMatrix(this.lookM);
    cam.quaternion.copy(this.tmpQ);
    const right = this.tmp.set(1, 0, 0).applyQuaternion(this.tmpQ);
    cp.addScaledVector(right, bx);
    const up = this.tmp.set(0, 1, 0).applyQuaternion(this.tmpQ);
    cp.addScaledVector(up, by);
    cam.updateMatrixWorld();
    if (Math.abs(cam.fov - vfov) > 1e-4) {
      cam.fov = vfov;
      cam.updateProjectionMatrix();
    }

    // lighting rig follows the subject
    this.key.position.set(target.x + 36, target.y + 68, target.z + 46);
    this.key.target.position.copy(target);
    this.rim.position.set(target.x - 56, target.y + 40, target.z - 62);
    this.rim.target.position.copy(target);
    this.fill.position.set(target.x - 46, target.y + 22, target.z + 60);
    this.fill.target.position.copy(target);
    const big = t >= 17.6 ? 118 : 46;
    const sc = this.key.shadow.camera;
    if (sc.right !== big) {
      sc.left = -big;
      sc.right = big;
      sc.top = big;
      sc.bottom = -big;
      sc.far = t >= 17.6 ? 380 : 260;
      sc.updateProjectionMatrix();
    }
    if (t >= 17.6) this.key.position.set(target.x + 60, target.y + 120, target.z + 80);

    const blurK = Math.max(inK, outK);
    const dirSign = si % 2 === 0 ? 1 : -1;
    const focus = dist;
    const fadeIn = 1 - smoothstep(0, 0.4, t);
    const fadeOut = smoothstep(23.35, 24, t);
    // vignette kick on both impacts — the frame itself flinches
    let vig = 0;
    if (t > 1.35) vig += 0.5 * Math.exp(-(t - 1.35) * 4);
    if (t > 11.8) vig += 0.7 * Math.exp(-(t - 11.8) * 3);
    return {
      focus,
      aperture: (v.ap * 0.012) / Math.max(dist, 1),
      blurDir: this.blurDir.set(dirSign, 0.15 * dirSign),
      blurAmt: blurK * 0.03,
      fade: Math.max(fadeIn, fadeOut),
      vig,
    };
  }
  private blurDir = new THREE.Vector2();
}
