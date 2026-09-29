// hand.ts — a real rigged human hand (WebXR generic-hand GLB, MIT licence, loaded from the jsDelivr CDN).
// The skinned mesh is posed through its own bones using a hinge-constrained CCD IK solver so the fingertips
// land on the cap surface. Bone frames follow the WebXR convention (-Z along the bone, -Y out of the palm).
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CAP } from './cap';
import { clamp, fabricMaps, V3 } from './kit';

const URLS = [
  'https://cdn.jsdelivr.net/npm/@webxr-input-profiles/assets@1.0/dist/profiles/generic-hand/right.glb',
  'https://unpkg.com/@webxr-input-profiles/assets@1.0/dist/profiles/generic-hand/right.glb',
  'https://cdn.jsdelivr.net/npm/@webxr-input-profiles/assets@1.0/dist/profiles/generic-hand/left.glb',
];

interface Joint {
  bone: THREE.Object3D;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  scale: THREE.Vector3;
}
interface Chain {
  name: string;
  j: Joint[];
  thumb: boolean;
  first: number; // index of the first flexing joint
  theta: number[];
  lo: number[];
  hi: number[];
  len: number;
  grip: THREE.Vector3;
  open: THREE.Vector3;
}

export interface HandRig {
  /** Twist pivot: sits at the cap centre. The director rotates it about +Y together with the cap. */
  group: THREE.Group;
  /** +1 if the fingers point toward +X in the gripping pose, -1 toward -X. */
  fingerSide: number;
  setOffset(v: THREE.Vector3): void;
  setPose(k: number): void;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const tmpM = new THREE.Matrix4();

function relMat(obj: THREE.Object3D | null, root: THREE.Object3D, out: THREE.Matrix4) {
  out.identity();
  let o = obj;
  while (o && o !== root) {
    o.updateMatrix();
    out.premultiply(o.matrix);
    o = o.parent;
  }
  return out;
}

/** Races the mirrors; first successful GLB wins, hard timeout so the loading screen can never hang. */
function loadGLB() {
  const loader = new GLTFLoader();
  return new Promise<Awaited<ReturnType<GLTFLoader['loadAsync']>>>((resolve, reject) => {
    let failed = 0;
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        reject(new Error('hand glb timeout'));
      }
    }, 12000);
    URLS.forEach((url) => {
      loader
        .loadAsync(url)
        .then((g) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(g);
        })
        .catch((e) => {
          failed++;
          if (failed === URLS.length && !done) {
            done = true;
            clearTimeout(timer);
            reject(e);
          }
        });
    });
  });
}

export async function loadHand(): Promise<HandRig | null> {
  let gltf;
  try {
    gltf = await loadGLB();
  } catch (e) {
    console.warn('[hand] GLB unavailable', e);
    return null;
  }
  try {
    return buildRig(gltf.scene);
  } catch (e) {
    console.warn('[hand] rig failed', e);
    return null;
  }
}

function buildRig(root: THREE.Group): HandRig {
  root.updateMatrixWorld(true);
  const bones = new Map<string, THREE.Object3D>();
  let skinned: THREE.SkinnedMesh | null = null;
  root.traverse((o) => {
    // joints are normally Bones; fall back to plain nodes of the same name if the exporter left some out of the skin
    const k = norm(o.name);
    if (k && !(o as THREE.Mesh).isMesh && ((o as THREE.Bone).isBone || !bones.has(k))) bones.set(k, o);
    if ((o as THREE.SkinnedMesh).isSkinnedMesh && !skinned) skinned = o as THREE.SkinnedMesh;
  });
  const find = (name: string) => {
    const k = norm(name);
    const direct = bones.get(k);
    if (direct) return direct;
    for (const [key, b] of bones) if (key.startsWith(k)) return b;
    throw new Error('bone not found: ' + name);
  };
  const mkJoint = (name: string): Joint => {
    const bone = find(name);
    relMat(bone, root, tmpM);
    const j: Joint = { bone, pos: new THREE.Vector3(), quat: new THREE.Quaternion(), scale: new THREE.Vector3() };
    tmpM.decompose(j.pos, j.quat, j.scale);
    return j;
  };

  const wrist = mkJoint('wrist');
  const names = (f: string) => [`${f}-metacarpal`, `${f}-phalanx-proximal`, `${f}-phalanx-intermediate`, `${f}-phalanx-distal`, `${f}-tip`];
  const fingerNames = ['index-finger', 'middle-finger', 'ring-finger', 'pinky-finger'];
  const chains: Chain[] = [];
  for (const f of fingerNames) {
    const j = names(f).map(mkJoint);
    chains.push({ name: f, j, thumb: false, first: 1, theta: [0, 0, 0], lo: [-0.35, 0, 0], hi: [1.55, 1.95, 1.35], len: 0, grip: V3(), open: V3() });
  }
  chains.push({ name: 'thumb', j: ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'].map(mkJoint), thumb: true, first: 0, theta: [0, 0, 0], lo: [0, 0, 0], hi: [1.15, 1.25, 1.35], len: 0, grip: V3(), open: V3() });
  const byName = (n: string) => chains.find((c) => c.name === n)!;

  // ── hand frame in native units (F: fingers, T: thumb side, N: out of palm) ──
  const W = wrist.pos;
  const midTip = byName('middle-finger').j[4].pos;
  const L = midTip.distanceTo(W);
  const F = midTip.clone().sub(W).normalize();
  const iM = byName('index-finger').j[1].pos;
  const pM = byName('pinky-finger').j[1].pos;
  const T = iM.clone().sub(pM);
  T.addScaledVector(F, -T.dot(F)).normalize();
  const Ngeo = new THREE.Vector3().crossVectors(F, T).normalize();
  const yAxis = V3(0, 1, 0).applyQuaternion(wrist.quat);
  const zAxis = V3(0, 0, -1).applyQuaternion(wrist.quat);
  let palmSign = 0;
  if (Math.abs(yAxis.dot(Ngeo)) > 0.7 && zAxis.dot(F) > 0.5) palmSign = Math.sign(-yAxis.dot(Ngeo)); // palm = -Y (WebXR spec)
  if (!palmSign) {
    const d = byName('thumb').j[1].pos.clone().sub(W).dot(Ngeo);
    palmSign = Math.abs(d) > 1e-4 * L ? Math.sign(d) : 1;
  }
  const N = Ngeo.clone().multiplyScalar(palmSign);
  const sh = palmSign; // +1 → (F,T,N) right-handed

  const HAND_LEN = 17.5; // cm, wrist → middle fingertip
  const s = HAND_LEN / L;
  const u = 1 / s;

  const toNative = (f: number, t: number, n: number) => W.clone().addScaledVector(F, f * u).addScaledVector(T, t * u).addScaledVector(N, n * u);
  const coord = (p: THREE.Vector3) => {
    const d = p.clone().sub(W);
    return { f: d.dot(F) * s, t: d.dot(T) * s, n: d.dot(N) * s };
  };

  for (const c of chains) {
    const a = c.thumb ? 0 : 1;
    c.len = 0;
    for (let i = a; i < c.j.length - 1; i++) c.len += c.j[i + 1].pos.distanceTo(c.j[i].pos);
  }
  const mi = coord(byName('index-finger').j[1].pos);
  const mm = coord(byName('middle-finger').j[1].pos);
  const midF = (mi.f + mm.f) / 2;
  const midT = (mi.t + mm.t) / 2;

  // cap centre in hand frame (cm): under the knuckle row, cap top a little below the palm
  const Rc = CAP.R;
  const RR = Rc + 0.75;
  const Cf = midF - (Rc + 1.2);
  const Ct = midT - 0.4;
  const Cn = 4.4;
  const ang: Record<string, [number, number]> = {
    'index-finger': [42, 0.2],
    'middle-finger': [2, 0.2],
    'ring-finger': [-38, 0.1],
    'pinky-finger': [-72, 0.0],
  };
  for (const c of chains) {
    if (c.thumb) {
      const ph = (160 * Math.PI) / 180; // thumb pad opposes the fingers across the cap
      const r = Rc + 0.9;
      c.grip = toNative(Cf + r * Math.cos(ph), Ct + r * Math.sin(ph), Cn + 0.35);
      const d0 = c.j[3].pos.clone().sub(c.j[0].pos).normalize();
      c.open = c.j[0].pos.clone().addScaledVector(d0, c.len * 0.9).addScaledVector(N, c.len * 0.1).addScaledVector(T, c.len * 0.12);
    } else {
      const [deg, nz] = ang[c.name];
      const ph = (deg * Math.PI) / 180;
      c.grip = toNative(Cf + RR * Math.cos(ph), Ct + RR * Math.sin(ph), Cn + nz);
      const d = c.j[4].pos.clone().sub(c.j[1].pos).normalize();
      c.open = c.j[1].pos.clone().addScaledVector(d, c.len * 0.9).addScaledVector(N, c.len * 0.3);
    }
  }
  const capCenterNative = toNative(Cf, Ct, Cn);

  // ── world mapping ──
  const Bh = new THREE.Matrix4().makeBasis(F, T, N);
  const Fw = V3(sh, 0, 0);
  const Tw = V3(0, 0, 1);
  const Nw = V3(0, -1, 0);
  const Bw = new THREE.Matrix4().makeBasis(Fw, Tw, Nw);
  const Rm = new THREE.Matrix4().multiplyMatrices(Bw, Bh.clone().transpose());
  const Rq = new THREE.Quaternion().setFromRotationMatrix(Rm);

  const group = new THREE.Group();
  group.name = 'handPivot';
  const holder = new THREE.Group();
  holder.scale.setScalar(s);
  holder.quaternion.copy(Rq);
  const basePos = capCenterNative.clone().applyQuaternion(Rq).multiplyScalar(-s);
  holder.position.copy(basePos);
  group.add(holder);
  holder.add(root);

  // skin
  if (skinned) {
    const m = skinned as THREE.SkinnedMesh;
    m.frustumCulled = false;
    m.castShadow = true;
    m.receiveShadow = true;
    m.material = new THREE.MeshPhysicalMaterial({ color: '#efb595', roughness: 0.5, sheen: 0.55, sheenColor: new THREE.Color('#ffcbb2'), sheenRoughness: 0.4, clearcoat: 0.06, side: THREE.DoubleSide });
  }
  // sleeve so the wrist never ends in mid-air
  const fm = fabricMaps();
  const sleeveMat = new THREE.MeshPhysicalMaterial({ color: '#f7c95c', normalMap: fm.normalMap, roughnessMap: fm.roughnessMap, roughness: 0.9, sheen: 1, sheenColor: new THREE.Color('#fff0b8'), sheenRoughness: 0.5, side: THREE.DoubleSide });
  const sLen = 16 * u;
  const sR = 3.5 * u;
  const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(sR * 1.08, sR, sLen, 40, 1, true), sleeveMat);
  sleeve.quaternion.setFromUnitVectors(V3(0, 1, 0), F.clone().negate());
  sleeve.position.copy(W).addScaledVector(F, -sLen / 2 + 0.9 * u);
  sleeve.castShadow = true;
  sleeve.receiveShadow = true;
  const cuff = new THREE.Mesh(new THREE.TorusGeometry(sR * 1.04, 0.4 * u, 12, 48), sleeveMat);
  cuff.quaternion.setFromUnitVectors(V3(0, 0, 1), F);
  cuff.position.copy(W).addScaledVector(F, 0.9 * u);
  cuff.castShadow = true;
  holder.add(sleeve, cuff);

  // ── IK ──
  const P = Array.from({ length: 5 }, () => V3());
  const Q = Array.from({ length: 5 }, () => new THREE.Quaternion());
  const tv = V3();
  const qq = new THREE.Quaternion();
  const fk = (c: Chain, axis: THREE.Vector3, base: THREE.Quaternion) => {
    const n = c.j.length;
    for (let i = 0; i < c.first; i++) {
      P[i].copy(c.j[i].pos);
      Q[i].identity();
    }
    let cum = 0;
    for (let i = c.first; i <= n - 2; i++) {
      cum += c.theta[i - c.first];
      Q[i].setFromAxisAngle(axis, cum).multiply(base);
      if (i === c.first) P[i].copy(c.j[i].pos);
      else P[i].copy(P[i - 1]).add(tv.copy(c.j[i].pos).sub(c.j[i - 1].pos).applyQuaternion(Q[i - 1]));
    }
    P[n - 1].copy(P[n - 2]).add(tv.copy(c.j[n - 1].pos).sub(c.j[n - 2].pos).applyQuaternion(Q[n - 2]));
    Q[n - 1].copy(Q[n - 2]);
  };
  const e = V3();
  const t = V3();
  const cr = V3();
  const ccd = (c: Chain, axis: THREE.Vector3, base: THREE.Quaternion, target: THREE.Vector3) => {
    const n = c.j.length;
    for (let it = 0; it < 16; it++) {
      for (let i = n - 2; i >= c.first; i--) {
        fk(c, axis, base);
        e.copy(P[n - 1]).sub(P[i]);
        t.copy(target).sub(P[i]);
        e.addScaledVector(axis, -e.dot(axis));
        t.addScaledVector(axis, -t.dot(axis));
        if (e.lengthSq() < 1e-12 || t.lengthSq() < 1e-12) continue;
        const a = Math.atan2(axis.dot(cr.crossVectors(e, t)), e.dot(t));
        const k = i - c.first;
        c.theta[k] = clamp(c.theta[k] + a, c.lo[k], c.hi[k]);
      }
    }
    fk(c, axis, base);
  };
  const desired = new THREE.Matrix4();
  const parentRel = new THREE.Matrix4();
  const writeBones = (c: Chain) => {
    for (let i = c.first; i < c.j.length; i++) {
      const j = c.j[i];
      qq.copy(Q[i]).multiply(j.quat);
      desired.compose(P[i], qq, j.scale);
      relMat(j.bone.parent, root, parentRel);
      desired.premultiply(parentRel.invert());
      desired.decompose(j.bone.position, j.bone.quaternion, j.bone.scale);
      j.bone.updateMatrix();
    }
  };
  const target = V3();
  const axis = V3();
  const d = V3();
  const lat = V3();
  const base = new THREE.Quaternion();
  const ident = new THREE.Quaternion();
  const pose = (k: number) => {
    for (const c of chains) {
      target.lerpVectors(c.open, c.grip, k);
      if (c.thumb) {
        d.copy(c.j[3].pos).sub(c.j[0].pos).normalize();
        t.copy(target).sub(c.j[0].pos);
        axis.crossVectors(d, t);
        if (axis.lengthSq() < 1e-10) axis.copy(N);
        axis.normalize();
        ccd(c, axis, ident, target);
      } else {
        const p1 = c.j[1].pos;
        d.copy(c.j[4].pos).sub(p1).normalize();
        t.copy(target).sub(p1);
        lat.crossVectors(N, d).normalize();
        const f = t.dot(d);
        const l = t.dot(lat);
        const phi = clamp(Math.atan(l / (Math.abs(f) < 1e-6 ? 1e-6 : f)), -0.5, 0.5);
        base.setFromAxisAngle(N, phi);
        axis.crossVectors(d, N).normalize().applyQuaternion(base);
        ccd(c, axis, base, target);
      }
      writeBones(c);
    }
    root.updateMatrixWorld(true);
  };
  pose(0);

  return {
    group,
    fingerSide: sh,
    setOffset: (v) => holder.position.copy(basePos).add(v),
    setPose: (k) => pose(clamp(k)),
  };
}
