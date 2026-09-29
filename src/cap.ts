// cap.ts — parametric bottle caps. One topology, two plan shapes (rounded-square ↔ ribbed circle)
// joined by a morph target, so the square cap can literally become the round cap.
// Heat-map / stress / bulge is done in-shader on top of MeshPhysicalMaterial (onBeforeCompile).
import * as THREE from 'three';
import { TAU, glowMat, helixTube, plasticMaps, roundedBox, V3 } from './kit';

export const CAP = {
  H: 1.6, // total cap height (cm, 1 unit = 1 cm; cap drawn ~1.2x real for legibility)
  R: 1.85, // round cap outer radius
  A: 1.72, // square cap half side
  N: 36, // superellipse exponent (sharp ~90° corners)
  R_IN: 1.46, // inner wall radius
  CEIL: 1.28, // underside of the top plate
  FIL: 0.2, // top edge fillet
  BAND_H: 0.42,
  BAND_R: 1.72,
  CORNER: 1.687, // corner point of the square cap (x = z)
  PITCH: 0.27, // right-hand thread pitch (PCO-1881 style)
};

const SEG = 288;
const RIBS = 44;
const CREAM = '#ece2cc'; // warm cream — stays cream under the key instead of clipping to white

const planRound = (th: number) => {
  const rib = Math.pow(0.5 + 0.5 * Math.cos(th * RIBS), 0.6);
  return CAP.R - 0.06 * (1 - rib);
};
const planSquare = (th: number) => {
  const c = Math.abs(Math.cos(th));
  const s = Math.abs(Math.sin(th));
  const n = CAP.N;
  return CAP.A / Math.pow(Math.pow(c, n) + Math.pow(s, n), 1 / n);
};

interface Ring {
  a: number;
  b: number;
  y: number;
}
function ringSpecs(): Ring[] {
  const out: Ring[] = [];
  const fr = CAP.FIL;
  for (let k = 0; k <= 3; k++) {
    const u = k / 3;
    out.push({ a: u, b: (1 - u) * CAP.R_IN, y: 0 });
  }
  out.push({ a: 1, b: 0, y: 0 }); // duplicate ring => hard edge between underside and wall
  const wallN = 6;
  for (let k = 1; k <= wallN; k++) out.push({ a: 1, b: 0, y: (k / wallN) * (CAP.H - fr) });
  for (let k = 1; k <= 6; k++) {
    const be = (k / 6) * (Math.PI / 2);
    out.push({ a: 1, b: -fr + fr * Math.cos(be), y: CAP.H - fr + fr * Math.sin(be) });
  }
  for (let k = 1; k <= 8; k++) {
    const s = 1 - k / 8;
    out.push({ a: s, b: -s * fr, y: CAP.H });
  }
  return out;
}

function buildGeometry(plan: (t: number) => number) {
  const rings = ringSpecs();
  const cols = SEG + 1;
  const rows = rings.length;
  const pos = new Float32Array(cols * rows * 3);
  const uv = new Float32Array(cols * rows * 2);
  for (let j = 0; j < rows; j++) {
    const rg = rings[j];
    for (let i = 0; i < cols; i++) {
      const th = (TAU * i) / SEG;
      const r = Math.max(0, rg.a * plan(th) + rg.b);
      const o = (j * cols + i) * 3;
      pos[o] = r * Math.cos(th);
      pos[o + 1] = rg.y;
      pos[o + 2] = -r * Math.sin(th);
      uv[(j * cols + i) * 2] = (i / SEG) * 3;
      uv[(j * cols + i) * 2 + 1] = j / (rows - 1);
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < SEG; i++) {
      const a = j * cols + i;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const nr = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let j = 0; j < rows; j++) {
    const i0 = j * cols;
    const i1 = j * cols + SEG;
    const nx = nr.getX(i0) + nr.getX(i1);
    const ny = nr.getY(i0) + nr.getY(i1);
    const nz = nr.getZ(i0) + nr.getZ(i1);
    const l = Math.hypot(nx, ny, nz) || 1;
    nr.setXYZ(i0, nx / l, ny / l, nz / l);
    nr.setXYZ(i1, nx / l, ny / l, nz / l);
  }
  nr.needsUpdate = true;
  return g;
}

let _round: THREE.BufferGeometry | null = null;
let _square: THREE.BufferGeometry | null = null;
let _inner: THREE.BufferGeometry | null = null;
export function capRoundGeometry() {
  return (_round ??= buildGeometry(planRound));
}
/** Square base geometry carrying the round shape as morph target 0. */
export function capMorphGeometry() {
  if (_square) return _square;
  const sq = buildGeometry(planSquare);
  const rd = capRoundGeometry();
  sq.morphAttributes.position = [rd.getAttribute('position') as THREE.BufferAttribute];
  sq.morphAttributes.normal = [rd.getAttribute('normal') as THREE.BufferAttribute];
  sq.morphTargetsRelative = false;
  _square = sq;
  return sq;
}
export function capInnerGeometry() {
  return (_inner ??= new THREE.LatheGeometry(
    [new THREE.Vector2(CAP.R_IN, 0), new THREE.Vector2(CAP.R_IN, CAP.CEIL), new THREE.Vector2(CAP.R_IN - 0.1, CAP.CEIL + 0.03), new THREE.Vector2(0.001, CAP.CEIL + 0.03)],
    72,
  ));
}

export interface CapUniforms {
  uBulge: { value: number };
  uHeatMix: { value: number };
  uRound: { value: number };
  uTime: { value: number };
  uHeatAmp: { value: number };
  uC0: { value: THREE.Color };
  uC1: { value: THREE.Color };
  uC2: { value: THREE.Color };
  uC3: { value: THREE.Color };
}
export function makeCapUniforms(): CapUniforms {
  return {
    uBulge: { value: 0 },
    uHeatMix: { value: 0 },
    uRound: { value: 0 },
    uTime: { value: 0 },
    uHeatAmp: { value: 1 },
    uC0: { value: new THREE.Color('#4a86d8') },
    uC1: { value: new THREE.Color('#3fbf9c') },
    uC2: { value: new THREE.Color('#f5cf50') },
    uC3: { value: new THREE.Color('#e2453a') },
  };
}

const VERT_DECL = /* glsl */ `
uniform float uBulge;
uniform float uRound;
varying float vCorner;
varying float vHd;
`;
const VERT_BODY = /* glsl */ `
{
  vec2 pa = abs(position.xz);
  float hd = length(pa - vec2(${CAP.CORNER.toFixed(3)}));
  float w = exp(-hd * hd / (2.0 * 0.55 * 0.55));
  vCorner = w;
  vHd = hd;
  float r = length(transformed.xz);
  vec2 dir = transformed.xz / max(r, 1e-4);
  float hR = clamp(1.0 - transformed.y / ${CAP.H.toFixed(2)}, 0.0, 1.0);
  float flare = hR * hR;
  float edge = smoothstep(1.15, 1.75, r);
  float b = uBulge * (1.0 - uRound);
  transformed.xz += dir * b * (0.36 * w * (0.30 + 0.70 * flare) + 0.07 * (1.0 - w) * flare) * edge;
}
`;
const FRAG_DECL = /* glsl */ `
uniform float uHeatMix;
uniform float uRound;
uniform float uTime;
uniform float uHeatAmp;
uniform vec3 uC0;
uniform vec3 uC1;
uniform vec3 uC2;
uniform vec3 uC3;
varying float vCorner;
varying float vHd;
vec3 heatmap(float h) {
  h = clamp(h, 0.0, 1.0);
  if (h < 0.34) return mix(uC0, uC1, h / 0.34);
  if (h < 0.68) return mix(uC1, uC2, (h - 0.34) / 0.34);
  return mix(uC2, uC3, (h - 0.68) / 0.32);
}
`;
const FRAG_BODY = /* glsl */ `
float hh = mix(0.05 + 0.95 * vCorner + 0.06 * sin(uTime * 7.0 - vHd * 3.0) * vCorner, 0.335 + 0.02 * sin(uTime * 4.0), uRound);
hh *= uHeatAmp;
vec3 hc = heatmap(hh);
diffuseColor.rgb = mix(diffuseColor.rgb, hc, uHeatMix);
`;
const FRAG_EMIT = /* glsl */ `
{
  float hh2 = mix(0.05 + 0.95 * vCorner, 0.335, uRound) * uHeatAmp;
  vec3 hc2 = heatmap(hh2);
  totalEmissiveRadiance += hc2 * uHeatMix * (0.08 + 0.55 * smoothstep(0.62, 0.92, hh2));
}
`;

export function capMaterial(u: CapUniforms, color = CREAM) {
  const pm = plasticMaps();
  const m = new THREE.MeshPhysicalMaterial({
    color,
    roughness: 0.46,
    metalness: 0,
    clearcoat: 0.35,
    clearcoatRoughness: 0.25,
    sheen: 0.25,
    sheenColor: new THREE.Color('#ffffff'),
    normalMap: pm.normalMap,
    normalScale: new THREE.Vector2(0.35, 0.35),
    roughnessMap: pm.roughnessMap,
    envMapIntensity: 0.65,
    transparent: true, // stays in the transparent pass so X-ray fading needs no recompile
  });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_DECL)
      .replace('#include <morphtarget_vertex>', '#include <morphtarget_vertex>\n' + VERT_BODY);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_DECL)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAG_BODY)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + FRAG_EMIT);
  };
  m.customProgramCacheKey = () => 'capheat-v1';
  return m;
}

export function createBand() {
  const pts = [new THREE.Vector2(1.3, 0), new THREE.Vector2(CAP.BAND_R - 0.03, 0), new THREE.Vector2(CAP.BAND_R, 0.03), new THREE.Vector2(CAP.BAND_R, CAP.BAND_H - 0.03), new THREE.Vector2(CAP.BAND_R - 0.03, CAP.BAND_H), new THREE.Vector2(1.3, CAP.BAND_H)];
  const geo = new THREE.LatheGeometry(pts, 96);
  const pm = plasticMaps();
  const mat = new THREE.MeshPhysicalMaterial({ color: CREAM, roughness: 0.45, clearcoat: 0.3, normalMap: pm.normalMap, normalScale: new THREE.Vector2(0.3, 0.3), side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** Plain round cap (factory line). Shares geometry; colour per material. */
export function createPlainCap(color: string) {
  const g = new THREE.Group();
  const pm = plasticMaps();
  const mat = new THREE.MeshPhysicalMaterial({ color, roughness: 0.4, clearcoat: 0.5, clearcoatRoughness: 0.2, normalMap: pm.normalMap, normalScale: new THREE.Vector2(0.3, 0.3) });
  const body = new THREE.Mesh(capRoundGeometry(), mat);
  const inner = new THREE.Mesh(capInnerGeometry(), new THREE.MeshStandardMaterial({ color, roughness: 0.6, side: THREE.DoubleSide }));
  body.castShadow = true;
  inner.castShadow = false;
  g.add(body, inner);
  return g;
}

function crackTube(points: number[][], radius: number) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => V3(p[0], p[1], p[2])), false, 'catmullrom', 0.15);
  const tubular = 64;
  const radial = 5;
  const geo = new THREE.TubeGeometry(curve, tubular, radius, radial, false);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: '#4a3530' }));
  return {
    mesh,
    set: (k: number) => geo.setDrawRange(0, Math.floor(Math.max(0, Math.min(1, k)) * tubular) * radial * 6),
  };
}

export interface CapRig {
  /** Origin at the cap's mid-height: pivot for twist, transform driven by physics after ejection. */
  holder: THREE.Group;
  /** Geometry origin at the skirt bottom. */
  root: THREE.Group;
  body: THREE.Mesh;
  uniforms: CapUniforms;
  bridges: THREE.InstancedMesh;
  markers: THREE.Group;
  setMarkers(a: number): void;
  setMarkers4(a: number[]): void;
  setCrack(k: number): void;
  setRound(k: number): void;
  setBridges(k: number): void;
  setXray(k: number): void;
  liner: THREE.Mesh;
  reset(): void;
}

export function createCap(): CapRig {
  const uniforms = makeCapUniforms();
  const holder = new THREE.Group();
  holder.name = 'capHolder';
  const root = new THREE.Group();
  root.position.y = -CAP.H / 2;
  holder.add(root);

  const body = new THREE.Mesh(capMorphGeometry(), capMaterial(uniforms));
  body.castShadow = true;
  body.receiveShadow = true;
  root.add(body);

  const inner = new THREE.Mesh(capInnerGeometry(), new THREE.MeshStandardMaterial({ color: '#efe6d4', roughness: 0.6, side: THREE.DoubleSide }));
  root.add(inner);
  const liner = new THREE.Mesh(new THREE.CylinderGeometry(CAP.R_IN - 0.04, CAP.R_IN - 0.04, 0.08, 48), new THREE.MeshPhysicalMaterial({ color: '#dfeaf0', roughness: 0.6, emissive: '#ffd58a', emissiveIntensity: 0 }));
  liner.position.y = CAP.CEIL - 0.03;
  root.add(liner);
  const thread = new THREE.Mesh(helixTube(CAP.R_IN - 0.05, CAP.PITCH, 2.6, 0.055, 0.6), new THREE.MeshStandardMaterial({ color: '#efe6d4', roughness: 0.55 }));
  thread.position.y = 0.2;
  root.add(thread);

  // twelve tamper bridges between skirt and band
  const bridges = new THREE.InstancedMesh(roundedBox(0.16, 0.2, 0.09, 0.03), new THREE.MeshStandardMaterial({ color: CREAM, roughness: 0.5 }), 12);
  const d = new THREE.Object3D();
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    d.position.set(Math.cos(a) * (CAP.BAND_R - 0.1), -0.05, -Math.sin(a) * (CAP.BAND_R - 0.1));
    d.rotation.set(0, a, 0);
    d.scale.setScalar(1);
    d.updateMatrix();
    bridges.setMatrixAt(i, d.matrix);
  }
  bridges.castShadow = true;
  root.add(bridges);

  // cracks
  const cr = [
    crackTube([[1.05, 1.62, 0.98], [1.28, 1.62, 1.3], [1.52, 1.62, 1.42], [1.66, 1.5, 1.62], [1.73, 1.25, 1.6], [1.69, 1.0, 1.72], [1.74, 0.72, 1.68], [1.7, 0.45, 1.74], [1.74, 0.12, 1.7]], 0.03),
    crackTube([[1.62, 1.61, 1.42], [1.6, 1.62, 1.0], [1.56, 1.62, 0.55]], 0.024),
    crackTube([[1.66, 1.5, 1.72], [1.35, 1.5, 1.74], [1.05, 1.42, 1.73], [0.7, 1.5, 1.74]], 0.024),
  ];
  const crackGroup = new THREE.Group();
  cr.forEach((c) => {
    c.set(0);
    crackGroup.add(c.mesh);
  });
  root.add(crackGroup);

  // right-angle marks (diagram symbol) at the four corners of the top face —
  // one material per corner so they can pop in sequence (clockwise from the front-right)
  const markers = new THREE.Group();
  const markMats: THREE.MeshBasicMaterial[] = [];
  const c0 = 1.5;
  const e = 0.42;
  const order: [number, number][] = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  for (const [sx, sz] of order) {
    const mm = glowMat('#fff6de', 1.5, false);
    mm.opacity = 0;
    markMats.push(mm);
    const a = new THREE.Mesh(roundedBox(0.04, 0.02, e, 0.008, 1), mm);
    a.position.set(sx * (c0 - e), CAP.H + 0.012, sz * (c0 - e / 2));
    const b = new THREE.Mesh(roundedBox(e, 0.02, 0.04, 0.008, 1), mm);
    b.position.set(sx * (c0 - e / 2), CAP.H + 0.012, sz * (c0 - e));
    a.renderOrder = 5;
    b.renderOrder = 5;
    markers.add(a, b);
  }
  root.add(markers);

  const rig: CapRig = {
    holder,
    root,
    body,
    uniforms,
    bridges,
    markers,
    setMarkers: (a) => {
      for (const mm of markMats) mm.opacity = a;
      markers.visible = a > 0.01;
    },
    setMarkers4: (arr) => {
      for (let i = 0; i < 4; i++) markMats[i].opacity = arr[i] ?? 0;
      markers.visible = arr.some((a) => a > 0.01);
    },
    setCrack: (k) => cr.forEach((c, i) => c.set((k - i * 0.18) / 0.7)),
    setRound: (k) => {
      uniforms.uRound.value = k;
      if (body.morphTargetInfluences) body.morphTargetInfluences[0] = k;
    },
    setBridges: (k) => {
      bridges.visible = k > 0.5;
    },
    liner,
    setXray: (k) => {
      const m = body.material as THREE.MeshPhysicalMaterial;
      m.opacity = 1 - 0.66 * k;
      m.depthWrite = k < 0.05;
      inner.visible = k < 0.05;
      thread.visible = k < 0.05;
    },
    reset: () => {
      uniforms.uBulge.value = 0;
      uniforms.uHeatMix.value = 0;
      uniforms.uHeatAmp.value = 1;
      rig.setRound(0);
      rig.setCrack(0);
      rig.setBridges(1);
      rig.setMarkers(0);
      holder.visible = true;
      (liner.material as THREE.MeshPhysicalMaterial).emissiveIntensity = 0;
      rig.setXray(0);
    },
  };
  body.renderOrder = 3;
  body.userData.keepDepth = true;
  return rig;
}
