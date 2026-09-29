// env.ts — the two physical sets: a sunlit kitchen-studio table, and a bottling line with SCARA capping arms.
// Every set returns { group, update() }. The capping arms are solved with closed-form 2-link IK and the
// screw motion is kinematically exact (cap descends exactly one thread pitch per turn).
import * as THREE from 'three';
import { BOT, createBottle, shellMaterial } from './bottle';
import { CAP, createPlainCap } from './cap';
import { Dust } from './effects';
import {
  TAU, catenary, clamp, concreteMaps, easeInOutCubic, easeInOutSine, easeOutBack, glowMat, lerp, mulberry32, pnoise, procMaps, roundedBox, rubberMaps, setRod, V3, woodMaps,
} from './kit';

const V2 = THREE.Vector2;

// ───────────────────────────── backdrop dome ─────────────────────────────
export class Backdrop {
  mesh: THREE.Mesh;
  private top = { value: new THREE.Color() };
  private bottom = { value: new THREE.Color() };
  constructor() {
    const m = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { uTop: this.top, uBottom: this.bottom },
      vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'varying vec3 vD; uniform vec3 uTop; uniform vec3 uBottom; void main(){ float t = smoothstep(-0.05, 0.6, vD.y); gl_FragColor = vec4(mix(uBottom, uTop, t), 1.0); }',
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1800, 32, 16), m);
    this.mesh.renderOrder = -20;
    this.mesh.frustumCulled = false;
    this.mesh.userData.noDepth = true;
  }
  set(top: THREE.Color, bottom: THREE.Color) {
    this.top.value.copy(top);
    this.bottom.value.copy(bottom);
  }
}

/**
 * Image-based-lighting environment for PMREM. Deliberately gentle: sky-blue dome, warm floor and three
 * softboxes of radiance ≤ 3 — so clearcoat / glass pick up soft coloured reflections instead of white blobs.
 */
export function createEnvironmentScene() {
  const s = new THREE.Scene();
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(40, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: { uTop: { value: new THREE.Color('#3f8fd2') }, uMid: { value: new THREE.Color('#c9dfeb') }, uBottom: { value: new THREE.Color('#8a745c') } },
      vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `varying vec3 vD; uniform vec3 uTop, uMid, uBottom;
        void main(){ float y = vD.y; vec3 c = y > 0.0 ? mix(uMid, uTop, smoothstep(0.0, 0.7, y)) : mix(uMid, uBottom, smoothstep(0.0, -0.45, y)); gl_FragColor = vec4(c * 0.85, 1.0); }`,
    }),
  );
  const panel = (w: number, h: number, color: string, k: number, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k), side: THREE.DoubleSide }));
    m.position.set(x, y, z);
    m.lookAt(0, 0, 0);
    return m;
  };
  s.add(dome, panel(18, 12, '#fff1dc', 3.0, 12, 22, 16), panel(10, 18, '#bfe2ff', 1.5, -24, 12, -14), panel(14, 10, '#ffffff', 0.8, -18, 8, 20));
  return s;
}

function stripeTexture() {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 128;
  const g = c.getContext('2d')!;
  for (let i = 0; i < 8; i++) {
    g.fillStyle = i % 2 ? '#fff7ee' : '#ff8f70';
    g.fillRect(0, i * 16, 32, 16);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1, 3);
  return t;
}

// ───────────────────────────── studio ─────────────────────────────
export interface StudioSet {
  group: THREE.Group;
  floorMat: THREE.MeshBasicMaterial;
  update(t: number): void;
}

export function createStudio(): StudioSet {
  const group = new THREE.Group();
  const wm = woodMaps();
  const tableMat = new THREE.MeshPhysicalMaterial({ map: wm.map, normalMap: wm.normalMap, roughnessMap: wm.roughnessMap, roughness: 0.6, clearcoat: 0.25, clearcoatRoughness: 0.35, normalScale: new V2(0.6, 0.6) });
  const table = new THREE.Mesh(roundedBox(170, 6, 110, 1.2, 4), tableMat);
  table.position.y = -3;
  table.receiveShadow = true;
  table.castShadow = true;
  group.add(table);

  // unlit floor, colour-locked to the backdrop's bottom colour → an endless seamless studio cyclorama
  const floorMat = new THREE.MeshBasicMaterial({ color: '#e3f4f4' });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -75;
  group.add(floor);

  // tall glass of soda with ice + striped straw (far left)
  const tum = new THREE.Group();
  const gp = [[0.001, 0], [3.1, 0], [3.5, 0.35], [3.95, 14], [3.75, 14.05], [3.62, 13.8], [3.3, 1.5], [0.001, 1.5]].map(([x, y]) => new V2(x, y));
  const glass = new THREE.Mesh(new THREE.LatheGeometry(gp, 64), shellMaterial(0.3));
  glass.renderOrder = 2;
  const sodaMat = new THREE.MeshPhysicalMaterial({ color: '#ffa64a', roughness: 0.1, clearcoat: 1, emissive: '#ff8a2a', emissiveIntensity: 0.12, transparent: true, opacity: 0.86 });
  const soda = new THREE.Mesh(new THREE.LatheGeometry([[0.001, 1.55], [3.22, 1.55], [3.62, 11.2], [0.001, 11.2]].map(([x, y]) => new V2(x, y)), 48), sodaMat);
  soda.renderOrder = 1;
  const foam = new THREE.Mesh(new THREE.CylinderGeometry(3.6, 3.62, 0.35, 48), new THREE.MeshPhysicalMaterial({ color: '#fff0d8', roughness: 0.6 }));
  foam.position.y = 11.35;
  tum.add(soda, foam, glass);
  const iceMat = new THREE.MeshPhysicalMaterial({ color: '#e8f6ff', transparent: true, opacity: 0.55, roughness: 0.05, clearcoat: 1 });
  const rr = mulberry32(3);
  for (let i = 0; i < 3; i++) {
    const ice = new THREE.Mesh(roundedBox(2.6, 2.6, 2.6, 0.55), iceMat);
    ice.position.set((i - 1) * 1.6 + (rr() - 0.5), 10.4 + rr() * 0.8, (rr() - 0.5) * 1.6);
    ice.rotation.set(rr() * 3, rr() * 3, rr() * 3);
    ice.renderOrder = 3;
    tum.add(ice);
  }
  const straw = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 19, 16), new THREE.MeshPhysicalMaterial({ map: stripeTexture(), roughness: 0.35, clearcoat: 0.6 }));
  straw.position.set(1.0, 10.5, 0.3);
  straw.rotation.z = -0.14;
  straw.castShadow = true;
  tum.add(straw);
  tum.position.set(-36, 0, -28);
  tum.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = true;
  });
  group.add(tum);

  // citrus
  const peel = procMaps({
    size: 256,
    repeat: [2, 1],
    strength: 1.3,
    height: (u, v) => 0.6 * pnoise(u * 48, v * 48, 48, 48, 7) + 0.4 * pnoise(u * 96, v * 96, 96, 96, 8),
    color: (u, v, h) => {
      const n = pnoise(u * 6, v * 6, 6, 6, 4);
      return [255 - 14 * h, 150 + 24 * n - 22 * h, 44 + 20 * n];
    },
    rough: (_u, _v, h) => 0.45 + 0.25 * h,
  });
  const orangeMat = new THREE.MeshPhysicalMaterial({ map: peel.map, normalMap: peel.normalMap, roughnessMap: peel.roughnessMap, clearcoat: 0.25, roughness: 0.5 });
  const fruit = (x: number, z: number, r: number, sx = 1, mat = orangeMat) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(r, 48, 32), mat);
    m.scale.set(sx, 1, 1);
    m.position.set(x, r * 0.98, z);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
  };
  fruit(36, -26, 3.5);
  fruit(43, -19, 3.1);
  fruit(28, -34, 2.7, 1.22, new THREE.MeshPhysicalMaterial({ color: '#ffe27a', roughness: 0.5, clearcoat: 0.2, normalMap: peel.normalMap }));

  // shelf with soft-focus bottles (far background)
  const shelfMat = new THREE.MeshStandardMaterial({ color: '#f4e9d6', roughness: 0.85 });
  const shelf = new THREE.Mesh(roundedBox(240, 3, 18, 0.8), shelfMat);
  shelf.position.set(0, 21.5, -98);
  shelf.receiveShadow = true;
  group.add(shelf);
  const liq = ['#7fd6a4', '#ff8fa3', '#ffd166', '#7cc4ff', '#ffa64a', '#c8a2ff', '#7fd6a4'];
  for (let i = 0; i < 7; i++) {
    const b = createBottle({ lite: true });
    b.liquid.material = new THREE.MeshPhysicalMaterial({ color: liq[i], roughness: 0.12, clearcoat: 1, emissive: liq[i], emissiveIntensity: 0.12, transparent: true, opacity: 0.86 });
    b.label.material = new THREE.MeshPhysicalMaterial({ color: liq[(i + 3) % 7], roughness: 0.55 });
    b.root.position.set(-90 + i * 30, 23, -98);
    b.root.scale.setScalar(1.0);
    group.add(b.root);
  }
  // soft window panel + mullions (bright far-away shape for depth of field)
  const win = new THREE.Group();
  const pane = new THREE.Mesh(new THREE.PlaneGeometry(70, 92), glowMat('#ffe9c2', 1.08, false));
  pane.userData.noDepth = true;
  win.add(pane);
  const mull = new THREE.MeshStandardMaterial({ color: '#f7efe2', roughness: 0.8 });
  const m1 = new THREE.Mesh(roundedBox(72, 2.4, 2, 0.4), mull);
  const m2 = new THREE.Mesh(roundedBox(2.4, 94, 2, 0.4), mull);
  const m3 = new THREE.Mesh(roundedBox(72, 2.4, 2, 0.4), mull);
  m1.position.y = 0;
  m3.position.y = 26;
  win.add(m1, m2, m3);
  win.position.set(-82, 58, -190);
  group.add(win);

  const dust = new Dust(260, [120, 60, 90]);
  group.add(dust.points);

  return { group, floorMat, update: (t) => dust.update(t) };
}

// ───────────────────────────── factory ─────────────────────────────
const BELT_TOP = 6;
const PITCH = 16; // bottle pitch on the belt
export const FACTORY_RATE = 1 / 0.62; // capping cycles per second
const SEAT = BELT_TOP + BOT.SEAT_Y;
const HOVER = SEAT + 9;
const L1 = 10.5;
const L2 = 10.5;
const ARM_D = 15;
const PSI_S = Math.PI / 2;
const PSI_F = Math.atan2(5.1, 14.1);
const Y1 = 41;
const Y2 = 44.2;
const TURNS = 3;
const FEED_X = ARM_D * Math.cos(PSI_F);
const FEED_DZ = -ARM_D + ARM_D * Math.sin(PSI_F);

interface Slot {
  bottle: ReturnType<typeof createBottle>;
  cap: THREE.Group;
}
interface Lane {
  z: number;
  off: number;
  maps: THREE.CanvasTexture[];
  slots: Slot[];
  chuckCap: THREE.Group;
  feeder: THREE.Group[];
  link1: THREE.Group;
  link2: THREE.Group;
  chuck: THREE.Group;
  jaws: THREE.Mesh[];
  spindle: THREE.Mesh;
  motor: THREE.Mesh;
  beaconMat: THREE.MeshStandardMaterial;
}

const capRot = (b: number) => (((b * 2.399963) % 1) + 1) % 1 * TAU;
const meshOf = (g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0, cast = true) => {
  const me = new THREE.Mesh(g, m);
  me.position.set(x, y, z);
  me.castShadow = cast;
  me.receiveShadow = true;
  return me;
};

export interface FactorySet {
  group: THREE.Group;
  update(clock: number): void;
}

export function createFactory(): FactorySet {
  const group = new THREE.Group();
  const cm = concreteMaps();
  const floorMat = new THREE.MeshPhysicalMaterial({ map: cm.map, normalMap: cm.normalMap, roughnessMap: cm.roughnessMap, roughness: 0.8, clearcoat: 0.15, color: '#b9c9cc', normalScale: new V2(0.5, 0.5) });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(600, 400), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  group.add(floor);

  // walls (plaster, teal wainscot, glowing windows)
  const plaster = new THREE.MeshStandardMaterial({ color: '#e9d4b4', roughness: 0.9 });
  const teal = new THREE.MeshStandardMaterial({ color: '#5fb5ad', roughness: 0.7 });
  const back = meshOf(roundedBox(420, 140, 4, 0.5), plaster, 0, 70, -104, false);
  const wains = meshOf(roundedBox(420, 34, 4.6, 0.5), teal, 0, 17, -103.6, false);
  const left = meshOf(roundedBox(4, 140, 240, 0.5), plaster, -190, 70, 0, false);
  const right = meshOf(roundedBox(4, 140, 240, 0.5), plaster, 190, 70, 0, false);
  group.add(back, wains, left, right);
  const winMat = glowMat('#ffe6bf', 1.0, false);
  const frameMat = new THREE.MeshStandardMaterial({ color: '#fbf3e6', roughness: 0.8 });
  for (const x of [-120, -40, 40, 120]) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(42, 30), winMat);
    p.position.set(x, 92, -101.5);
    p.userData.noDepth = true;
    group.add(p);
    group.add(meshOf(roundedBox(44, 1.6, 1.4, 0.3), frameMat, x, 92, -101.2, false));
    group.add(meshOf(roundedBox(1.6, 32, 1.4, 0.3), frameMat, x, 92, -101.2, false));
  }
  // pipe runs + crates
  const pipeA = new THREE.MeshPhysicalMaterial({ color: '#5fb3b3', roughness: 0.4, metalness: 0.5 });
  const pipeB = new THREE.MeshPhysicalMaterial({ color: '#ff9a7a', roughness: 0.4, metalness: 0.4 });
  const p1 = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 400, 24), pipeA);
  p1.rotation.z = Math.PI / 2;
  p1.position.set(0, 66, -97);
  const p2 = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 400, 24), pipeB);
  p2.rotation.z = Math.PI / 2;
  p2.position.set(0, 72, -97);
  group.add(p1, p2);
  const crateCols = ['#ff9a7a', '#ffd166', '#7fd3c1'];
  crateCols.forEach((c, i) => group.add(meshOf(roundedBox(20, 13, 16, 1.2), new THREE.MeshStandardMaterial({ color: c, roughness: 0.6 }), -92 + (i % 2) * 2, 6.5 + Math.floor(i / 2) * 13, -80 + (i % 2) * 3)));

  const steel = new THREE.MeshPhysicalMaterial({ color: '#dfe7ee', metalness: 0.85, roughness: 0.32 });
  const bluegrey = new THREE.MeshPhysicalMaterial({ color: '#5f86ad', roughness: 0.45, clearcoat: 0.4 });
  const railMat = new THREE.MeshPhysicalMaterial({ color: '#5fb3b3', roughness: 0.4, clearcoat: 0.5 });
  const stripeMat = new THREE.MeshStandardMaterial({ color: '#ffd166', roughness: 0.7 });
  const jawMat = new THREE.MeshPhysicalMaterial({ color: '#fff7ee', roughness: 0.4, clearcoat: 0.5 });
  const rm = rubberMaps();

  const lanes: Lane[] = [];
  const cfgs = [
    { z: -34, cap: '#ff8f70', arm: '#ffb14a', off: 0.15 },
    { z: 0, cap: '#f6f0e2', arm: '#ff8f70', off: 0.42 },
    { z: 34, cap: '#7fd3c1', arm: '#ffd166', off: 0.68 },
  ];
  for (const cfg of cfgs) {
    const zl = cfg.z;
    const lg = new THREE.Group();
    group.add(lg);
    // conveyor
    const maps = [rm.map.clone(), rm.normalMap.clone(), rm.roughnessMap.clone()];
    maps.forEach((t) => (t.needsUpdate = true));
    const beltMat = new THREE.MeshPhysicalMaterial({ map: maps[0], normalMap: maps[1], roughnessMap: maps[2], roughness: 0.85, normalScale: new V2(0.7, 0.7) });
    lg.add(meshOf(roundedBox(136, 1.2, 13, 0.4, 2), beltMat, 0, BELT_TOP - 0.6, zl, false));
    lg.add(meshOf(roundedBox(138, 5.6, 1.6, 0.5), railMat, 0, BELT_TOP - 2.9, zl - 7.4));
    lg.add(meshOf(roundedBox(138, 5.6, 1.6, 0.5), railMat, 0, BELT_TOP - 2.9, zl + 7.4));
    lg.add(meshOf(roundedBox(150, 0.06, 1.2, 0.02, 1), stripeMat, 0, 0.04, zl + 12, false));
    lg.add(meshOf(roundedBox(150, 0.06, 1.2, 0.02, 1), stripeMat, 0, 0.04, zl - 12, false));
    // tunnels at both ends of the belt (hide the bottle spawn / despawn)
    for (const sx of [-1, 1]) {
      const hx = sx * 57;
      lg.add(meshOf(roundedBox(22, 2, 17, 0.6), railMat, hx, BELT_TOP + 26, zl));
      lg.add(meshOf(roundedBox(22, 27, 1.6, 0.5), railMat, hx, BELT_TOP + 12.5, zl - 7.6));
      lg.add(meshOf(roundedBox(22, 27, 1.6, 0.5), railMat, hx, BELT_TOP + 12.5, zl + 7.6));
    }
    // warning beacon on the exit tunnel, pulsing with the machine cycle
    const beaconMat = new THREE.MeshStandardMaterial({ color: '#ffb14a', emissive: '#ff8a2a', emissiveIntensity: 2, roughness: 0.4 });
    lg.add(meshOf(new THREE.CylinderGeometry(0.22, 0.3, 3, 12), bluegrey, 57, BELT_TOP + 28.5, zl));
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.85, 20, 14), beaconMat);
    beacon.position.set(57, BELT_TOP + 30.6, zl);
    lg.add(beacon);
    // capping arm (SCARA)
    const bz = zl - ARM_D;
    const coral = new THREE.MeshPhysicalMaterial({ color: cfg.arm, roughness: 0.35, clearcoat: 0.7, clearcoatRoughness: 0.2 });
    lg.add(meshOf(roundedBox(10, 2, 10, 0.6), bluegrey, 0, 1, bz));
    lg.add(meshOf(new THREE.CylinderGeometry(2.0, 2.5, Y1 - 2, 32), bluegrey, 0, 2 + (Y1 - 2) / 2, bz));
    lg.add(meshOf(new THREE.CylinderGeometry(3.1, 3.1, 2.6, 32), steel, 0, Y1 - 1.3, bz));
    const link1 = new THREE.Group();
    link1.position.set(0, Y1, bz);
    link1.add(meshOf(roundedBox(L1 + 5, 2.8, 4.6, 0.9), coral, L1 / 2, 0, 0));
    link1.add(meshOf(new THREE.CylinderGeometry(2.5, 2.5, 3.6, 32), steel, L1, 1.2, 0));
    lg.add(link1);
    const link2 = new THREE.Group();
    link2.add(meshOf(roundedBox(L2 + 5, 2.6, 4.2, 0.9), coral, L2 / 2, 0, 0));
    lg.add(link2);
    const motor = meshOf(new THREE.CylinderGeometry(2.3, 2.3, 3.8, 32), steel);
    lg.add(motor);
    const spindle = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 20), steel);
    spindle.castShadow = true;
    lg.add(spindle);
    const chuck = new THREE.Group();
    chuck.add(meshOf(new THREE.CylinderGeometry(2.3, 2.3, 2.0, 32), steel, 0, 0.3, 0));
    const jaws: THREE.Mesh[] = [];
    for (let k = 0; k < 3; k++) {
      const jw = meshOf(roundedBox(0.7, 2.3, 1.5, 0.22), jawMat, 0, -1.4, 0);
      jaws.push(jw);
      chuck.add(jw);
    }
    lg.add(chuck);
    // cap feeder tray with a magazine of caps
    const fx = FEED_X;
    const fz = zl + FEED_DZ;
    lg.add(meshOf(roundedBox(24, 1.4, 5.4, 0.4), steel, fx + 10, SEAT - 0.7, fz));
    lg.add(meshOf(roundedBox(24, 2.2, 0.5, 0.2), bluegrey, fx + 10, SEAT + 0.4, fz - 2.7));
    lg.add(meshOf(roundedBox(24, 2.2, 0.5, 0.2), bluegrey, fx + 10, SEAT + 0.4, fz + 2.7));
    for (const lx of [fx + 4, fx + 18]) lg.add(meshOf(new THREE.CylinderGeometry(1.1, 1.1, SEAT - 1.4, 16), bluegrey, lx, (SEAT - 1.4) / 2, fz));
    const feeder: THREE.Group[] = [];
    for (let k = 0; k < 4; k++) {
      const c = createPlainCap(cfg.cap);
      lg.add(c);
      feeder.push(c);
    }
    const chuckCap = createPlainCap(cfg.cap);
    lg.add(chuckCap);
    // pool of bottles riding the belt
    const slots: Slot[] = [];
    for (let k = 0; k < 8; k++) {
      const bottle = createBottle({ lite: true });
      const cap = createPlainCap(cfg.cap);
      lg.add(bottle.root, cap);
      slots.push({ bottle, cap });
    }
    // sagging cables from the ceiling gantry to the arm's gearbox (true catenary)
    for (const dx of [-5, 5]) {
      const pts = catenary(V3(dx * 3, 118, bz - 16), V3(dx * 0.35, Y1 + 0.4, bz), 82, 24);
      const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 48, 0.32, 8, false), new THREE.MeshStandardMaterial({ color: '#4e6a8a', roughness: 0.6 }));
      tube.castShadow = true;
      lg.add(tube);
    }
    lanes.push({ z: zl, off: cfg.off, maps, slots, chuckCap, feeder, link1, link2, chuck, jaws, spindle, motor, beaconMat });
  }

  const tmpA = V3();
  const tmpB = V3();
  const updateLane = (L: Lane, tau: number) => {
    const c = Math.floor(tau);
    const ph = tau - c;
    const u = c + easeInOutCubic(clamp(ph / 0.16));
    const f = Math.floor(u);
    // belt texture repeats 30× over 136 cm → one step of PITCH cm advances PITCH·30/136 tiles (belt & bottles stay locked)
    L.maps.forEach((t) => (t.offset.x = -u * ((PITCH * 30) / 136)));
    for (let i = 0; i < 8; i++) {
      const b = f - 3 + ((((i - (f - 3)) % 8) + 8) % 8);
      const bx = (u - b) * PITCH;
      const s = L.slots[i];
      s.bottle.root.position.set(bx, BELT_TOP, L.z);
      const capped = tau >= b - 0.16;
      s.cap.visible = capped;
      s.cap.position.set(bx, SEAT, L.z);
      s.cap.rotation.y = capRot(b);
    }
    // arm state machine over the cycle phase
    let psi = PSI_S;
    let y = HOVER;
    let hold = false;
    let closed = false;
    const base = capRot(c + 1);
    let spin = base + TURNS * TAU;
    if (ph < 0.16) {
      psi = lerp(PSI_S, PSI_F, easeInOutCubic(ph / 0.16));
    } else if (ph < 0.3) {
      psi = PSI_F;
      if (ph < 0.22) y = lerp(HOVER, SEAT, easeInOutCubic((ph - 0.16) / 0.06));
      else {
        y = lerp(SEAT, HOVER, easeInOutCubic((ph - 0.22) / 0.08));
        hold = true;
        closed = true;
      }
      if (ph >= 0.2 && ph < 0.22) closed = true;
    } else if (ph < 0.46) {
      psi = lerp(PSI_F, PSI_S, easeInOutCubic((ph - 0.3) / 0.16));
      hold = true;
      closed = true;
    } else if (ph < 0.84) {
      const p = (ph - 0.46) / 0.38;
      hold = true;
      closed = true;
      if (p < 0.3) y = lerp(HOVER, SEAT + CAP.PITCH * TURNS, easeInOutCubic(p / 0.3));
      else {
        const q = easeInOutSine((p - 0.3) / 0.7);
        y = SEAT + CAP.PITCH * TURNS * (1 - q); // one pitch of descent per turn — a true screw
        spin = base + TURNS * TAU * (1 - q);
      }
    } else if (ph < 0.92) {
      y = lerp(SEAT, HOVER, easeInOutCubic((ph - 0.84) / 0.08));
    }
    // 2-link IK (closed form)
    const bz = L.z - ARM_D;
    const tx = ARM_D * Math.cos(psi);
    const tz = bz + ARM_D * Math.sin(psi);
    const d = Math.min(Math.hypot(tx, tz - bz), L1 + L2 - 0.01);
    const cosE = clamp((d * d - L1 * L1 - L2 * L2) / (2 * L1 * L2), -1, 1);
    const E = Math.acos(cosE);
    const aT = Math.atan2(tz - bz, tx);
    const a1 = aT - Math.atan2(L2 * Math.sin(E), L1 + L2 * cosE);
    const j2x = L1 * Math.cos(a1);
    const j2z = bz + L1 * Math.sin(a1);
    const a2 = a1 + E;
    const ex = j2x + L2 * Math.cos(a2);
    const ez = j2z + L2 * Math.sin(a2);
    L.link1.rotation.y = -a1;
    L.link2.position.set(j2x, Y2, j2z);
    L.link2.rotation.y = -a2;
    L.motor.position.set(ex, Y2 + 3.0, ez);
    const chuckY = y + CAP.H + 0.9;
    L.chuck.position.set(ex, chuckY, ez);
    L.chuck.rotation.y = hold ? spin : base;
    const jr = closed ? 2.25 : 3.0;
    L.jaws.forEach((jw, k) => {
      const a = (k / 3) * TAU;
      jw.position.set(Math.cos(a) * jr, -1.4, Math.sin(a) * jr);
      jw.rotation.y = -a;
    });
    setRod(L.spindle, tmpA.set(ex, Y2 + 1, ez), tmpB.set(ex, chuckY + 1.2, ez), 0.9);
    L.beaconMat.emissiveIntensity = 1.4 + 1.2 * Math.sin(tau * TAU * 2);
    L.chuckCap.visible = hold;
    L.chuckCap.position.set(ex, y, ez);
    L.chuckCap.rotation.y = hold ? spin : base;
    // magazine of caps sliding toward the pick-up point
    const slide = easeInOutCubic(clamp((ph - 0.3) / 0.12));
    const fz = L.z + FEED_DZ;
    L.feeder.forEach((cp, o) => {
      // objects rotate through the magazine: slot k at the start of this cycle
      const k = (((o - c) % 4) + 4) % 4;
      let xk = FEED_X + 5.2 * (k - slide);
      let show = true;
      let sc = 1;
      if (k === 0) {
        if (ph < 0.22) xk = FEED_X;
        else if (ph < 0.42) {
          show = false;
          xk = FEED_X;
        } else {
          xk = FEED_X + 5.2 * 3;
          sc = Math.max(0.001, easeOutBack(clamp((ph - 0.42) / 0.12)));
        }
      }
      cp.visible = show;
      cp.position.set(xk, SEAT, fz);
      cp.scale.setScalar(sc);
      cp.rotation.y = capRot(o + 11);
    });
  };

  return {
    group,
    update: (clock) => {
      for (const L of lanes) updateLane(L, clock * FACTORY_RATE + L.off);
    },
  };
}
