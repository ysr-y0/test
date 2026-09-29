// effects.ts — arrows (pressure vectors), spray/foam particles, flow lines, rigid-body physics (cannon-es),
// dust motes, shock rings. Everything here is instanced or Points-based; nothing allocates per frame.
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { glowMat, glowTexture, mulberry32, noDepth, unitCylinder, clamp, easeOutCubic } from './kit';

// ───────────────────────────── Arrows ─────────────────────────────
const _o = new THREE.Object3D();
const _up = new THREE.Vector3(0, 1, 0);
export class Arrows {
  group = new THREE.Group();
  shaft: THREE.InstancedMesh;
  head: THREE.InstancedMesh;
  private base: THREE.Color;
  private col = new THREE.Color();
  private zero = new THREE.Matrix4().makeScale(0, 0, 0);
  constructor(public count: number, color: string, intensity = 1.7) {
    this.base = new THREE.Color(color).multiplyScalar(intensity);
    const mat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    this.shaft = new THREE.InstancedMesh(unitCylinder(), mat, count);
    this.head = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1, 14), mat, count);
    for (let i = 0; i < count; i++) {
      this.shaft.setMatrixAt(i, this.zero);
      this.head.setMatrixAt(i, this.zero);
      this.shaft.setColorAt(i, this.base);
      this.head.setColorAt(i, this.base);
    }
    this.shaft.frustumCulled = false;
    this.head.frustumCulled = false;
    this.shaft.renderOrder = 5; // after the (blended) cap so vectors are never painted over
    this.head.renderOrder = 5;
    this.group.add(this.shaft, this.head);
    noDepth(this.group);
    this.group.traverse((o) => noDepth(o));
  }
  /** Writes arrow i: tail at pos, pointing along unit dir. gain (0..1) scales brightness and size. */
  set(i: number, pos: THREE.Vector3, dir: THREE.Vector3, len: number, thick: number, gain = 1) {
    const g = clamp(gain);
    if (g <= 0.001) return this.hide(i);
    const L = len * (0.35 + 0.65 * g);
    const T = thick * (0.5 + 0.5 * g);
    _o.quaternion.setFromUnitVectors(_up, dir);
    _o.position.copy(pos).addScaledVector(dir, L / 2);
    _o.scale.set(T, L, T);
    _o.updateMatrix();
    this.shaft.setMatrixAt(i, _o.matrix);
    const hh = T * 4.6;
    _o.position.copy(pos).addScaledVector(dir, L + hh / 2);
    _o.scale.set(T * 2.6, hh, T * 2.6);
    _o.updateMatrix();
    this.head.setMatrixAt(i, _o.matrix);
    this.col.copy(this.base).multiplyScalar(g);
    this.shaft.setColorAt(i, this.col);
    this.head.setColorAt(i, this.col);
  }
  hide(i: number) {
    this.shaft.setMatrixAt(i, this.zero);
    this.head.setMatrixAt(i, this.zero);
  }
  hideAll() {
    for (let i = 0; i < this.count; i++) this.hide(i);
    this.flush();
  }
  flush() {
    this.shaft.instanceMatrix.needsUpdate = true;
    this.head.instanceMatrix.needsUpdate = true;
    if (this.shaft.instanceColor) this.shaft.instanceColor.needsUpdate = true;
    if (this.head.instanceColor) this.head.instanceColor.needsUpdate = true;
  }
}

// ───────────────────────────── particle pool (drops / foam) ─────────────────────────────
class Pool {
  mesh: THREE.InstancedMesh;
  pos: Float32Array;
  vel: Float32Array;
  life: Float32Array;
  maxLife: Float32Array;
  size: Float32Array;
  state: Uint8Array;
  cursor = 0;
  constructor(private n: number, geo: THREE.BufferGeometry, mat: THREE.Material, private g: number, private drag: number, private stretch: boolean, private foam: boolean) {
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n);
    this.size = new Float32Array(n);
    this.state = new Uint8Array(n);
    this.clear();
  }
  clear() {
    const z = new THREE.Matrix4().makeScale(0, 0, 0);
    this.state.fill(0);
    for (let i = 0; i < this.n; i++) this.mesh.setMatrixAt(i, z);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, life: number) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.n;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.size[i] = size;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.state[i] = 1;
  }
  update(dt: number) {
    const k = Math.exp(-this.drag * dt);
    const d = new THREE.Vector3();
    for (let i = 0; i < this.n; i++) {
      const st = this.state[i];
      if (st === 0) continue;
      const o = i * 3;
      if (st === 1) {
        this.vel[o + 1] -= this.g * dt;
        this.vel[o] *= k;
        this.vel[o + 1] *= k;
        this.vel[o + 2] *= k;
        this.pos[o] += this.vel[o] * dt;
        this.pos[o + 1] += this.vel[o + 1] * dt;
        this.pos[o + 2] += this.vel[o + 2] * dt;
        this.life[i] -= dt;
        const s = this.size[i];
        if (this.pos[o + 1] < s * 0.6 && !this.foam) {
          if (Math.abs(this.pos[o]) < 80 && Math.abs(this.pos[o + 2]) < 50) {
            this.state[i] = 2;
            this.pos[o + 1] = 0.02;
            this.life[i] = 1.6;
            this.maxLife[i] = 1.6;
          } else if (this.pos[o + 1] < -60) this.state[i] = 0;
        }
        if (this.life[i] <= 0 && this.state[i] === 1) this.state[i] = 0;
      } else {
        this.life[i] -= dt;
        if (this.life[i] <= 0) this.state[i] = 0;
      }
      const s = this.size[i];
      if (this.state[i] === 0) {
        _o.scale.set(0, 0, 0);
        _o.updateMatrix();
        this.mesh.setMatrixAt(i, _o.matrix);
        continue;
      }
      _o.position.set(this.pos[o], this.pos[o + 1], this.pos[o + 2]);
      if (this.state[i] === 2) {
        const f = clamp(this.life[i] / this.maxLife[i]);
        _o.quaternion.identity();
        _o.scale.set(s * 2.6 * (0.6 + 0.4 * f), s * 0.2, s * 2.6 * (0.6 + 0.4 * f));
      } else if (this.foam) {
        const p = 1 - this.life[i] / this.maxLife[i];
        const sc = s * (0.5 + 1.1 * easeOutCubic(p)) * (1 - Math.pow(p, 4));
        _o.quaternion.identity();
        _o.scale.set(sc, sc, sc);
      } else if (this.stretch) {
        d.set(this.vel[o], this.vel[o + 1], this.vel[o + 2]);
        const sp = d.length();
        if (sp > 1e-3) _o.quaternion.setFromUnitVectors(_up, d.divideScalar(sp));
        const st2 = 1 + clamp(sp / 260) * 1.6;
        _o.scale.set(s, s * st2, s);
      }
      _o.updateMatrix();
      this.mesh.setMatrixAt(i, _o.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

export class Spray {
  group = new THREE.Group();
  drops: Pool;
  foam: Pool;
  private rng = mulberry32(2024);
  constructor() {
    const dropMat = new THREE.MeshPhysicalMaterial({ color: '#ffa23e', roughness: 0.06, clearcoat: 1, clearcoatRoughness: 0.03, emissive: '#ff8a26', emissiveIntensity: 0.22, transparent: true, opacity: 0.94 });
    const foamMat = new THREE.MeshPhysicalMaterial({ color: '#fff0d6', roughness: 0.55, emissive: '#ffd9a0', emissiveIntensity: 0.1, transparent: true, opacity: 0.92 });
    this.drops = new Pool(1100, new THREE.SphereGeometry(1, 10, 8), dropMat, 981, 0.25, true, false);
    this.foam = new Pool(320, new THREE.SphereGeometry(1, 10, 8), foamMat, 220, 1.5, false, true);
    this.group.add(this.drops.mesh, this.foam.mesh);
    this.group.traverse((o) => noDepth(o));
  }
  /** Emit n droplets along a cone. dir must be unit. */
  emit(p: THREE.Vector3, dir: THREE.Vector3, speed: number, spread: number, n: number, foamChance = 0.12) {
    const r = this.rng;
    for (let i = 0; i < n; i++) {
      const sx = (r() - 0.5) * 2 * spread;
      const sy = (r() - 0.5) * 2 * spread;
      const sz = (r() - 0.5) * 2 * spread;
      const vx = dir.x + sx;
      const vy = dir.y + sy;
      const vz = dir.z + sz;
      const l = Math.hypot(vx, vy, vz) || 1;
      const sp = speed * (0.55 + 0.75 * r());
      const jitter = 0.15;
      const px = p.x + (r() - 0.5) * jitter;
      const py = p.y + (r() - 0.5) * jitter;
      const pz = p.z + (r() - 0.5) * jitter;
      if (r() < foamChance) this.foam.emit(px, py, pz, (vx / l) * sp * 0.6, (vy / l) * sp * 0.6, (vz / l) * sp * 0.6, 0.16 + r() * 0.2, 1.1 + r() * 1.1);
      else this.drops.emit(px, py, pz, (vx / l) * sp, (vy / l) * sp, (vz / l) * sp, 0.05 + Math.pow(r(), 2) * 0.16, 3.5);
    }
  }
  update(dt: number) {
    this.drops.update(dt);
    this.foam.update(dt);
  }
  clear() {
    this.drops.clear();
    this.foam.clear();
  }
}

// ───────────────────────────── flow lines (force paths) ─────────────────────────────
export class FlowLines {
  group = new THREE.Group();
  private mats: THREE.ShaderMaterial[] = [];
  constructor(curves: THREE.Curve<THREE.Vector3>[], radius: number, color: string, intensity = 1.7, private speed = 0.9, funnel = true) {
    const col = new THREE.Color(color).multiplyScalar(intensity);
    curves.forEach((c, i) => {
      const geo = new THREE.TubeGeometry(c, 64, radius, 6, false);
      const mat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: { uTime: { value: 0 }, uAlpha: { value: 0 }, uColor: { value: col }, uOff: { value: i * 0.37 }, uFunnel: { value: funnel ? 1 : 0 } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: `varying vec2 vUv; uniform float uTime, uAlpha, uOff, uFunnel; uniform vec3 uColor;
          void main(){
            float p = fract(vUv.x * 2.0 - uTime * ${this.speed.toFixed(2)} + uOff);
            float comet = smoothstep(0.0, 0.03, p) * pow(1.0 - p, 2.6);
            float grow = mix(1.0, 0.25 + 0.75 * vUv.x, uFunnel);
            float a = (0.16 + 1.25 * comet) * grow * uAlpha;
            gl_FragColor = vec4(uColor, a);
          }`,
      });
      const m = new THREE.Mesh(geo, mat);
      m.frustumCulled = false;
      m.renderOrder = 5;
      noDepth(m);
      this.group.add(m);
      this.mats.push(mat);
    });
    noDepth(this.group);
  }
  set(t: number, alpha: number) {
    this.group.visible = alpha > 0.005;
    for (const m of this.mats) {
      m.uniforms.uTime.value = t;
      m.uniforms.uAlpha.value = alpha;
    }
  }
}

// ───────────────────────────── glowing sprite ─────────────────────────────
export function glowSprite(color: string, size: number, intensity = 1.6) {
  const m = new THREE.SpriteMaterial({ map: glowTexture(), color: new THREE.Color(color).multiplyScalar(intensity), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  const s = new THREE.Sprite(m);
  s.scale.setScalar(size);
  s.renderOrder = 5;
  noDepth(s);
  return s;
}

// ───────────────────────────── shock ring ─────────────────────────────
export class ShockRing {
  mesh: THREE.Mesh;
  private t = 99;
  constructor(color = '#fff4e0') {
    const g = new THREE.RingGeometry(0.86, 1, 96);
    g.rotateX(-Math.PI / 2);
    const mat = glowMat(color, 1.5);
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.visible = false;
    this.mesh.renderOrder = 5;
    noDepth(this.mesh);
  }
  trigger(p: THREE.Vector3) {
    this.mesh.position.copy(p);
    this.t = 0;
  }
  update(dt: number) {
    this.t += dt;
    const k = this.t / 0.55;
    this.mesh.visible = k < 1;
    if (k < 1) {
      const s = 0.6 + 12 * easeOutCubic(k);
      this.mesh.scale.set(s, 1, s);
      (this.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - k) * 0.9;
    }
  }
}

// ───────────────────────────── dust motes ─────────────────────────────
export class Dust {
  points: THREE.Points;
  private base: Float32Array;
  private ph: Float32Array;
  private attr: THREE.BufferAttribute;
  constructor(n = 240, box: [number, number, number] = [110, 60, 80]) {
    const r = mulberry32(77);
    this.base = new Float32Array(n * 3);
    this.ph = new Float32Array(n);
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      this.base[i * 3] = (r() - 0.5) * box[0];
      this.base[i * 3 + 1] = 1 + r() * box[1];
      this.base[i * 3 + 2] = (r() - 0.5) * box[2];
      this.ph[i] = r() * TAUX;
    }
    this.attr = new THREE.BufferAttribute(pos, 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', this.attr);
    const m = new THREE.PointsMaterial({ map: glowTexture(), size: 0.7, sizeAttenuation: true, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending, color: '#ffffff', fog: false });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
    noDepth(this.points);
  }
  update(t: number) {
    const p = this.attr.array as Float32Array;
    for (let i = 0; i < this.ph.length; i++) {
      const ph = this.ph[i];
      p[i * 3] = this.base[i * 3] + Math.sin(t * 0.21 + ph) * 3.2 + Math.sin(t * 0.53 + ph * 2.1) * 1.1;
      p[i * 3 + 1] = this.base[i * 3 + 1] + Math.sin(t * 0.17 + ph * 1.3) * 2.4;
      p[i * 3 + 2] = this.base[i * 3 + 2] + Math.cos(t * 0.19 + ph) * 3.0;
    }
    this.attr.needsUpdate = true;
  }
}
const TAUX = Math.PI * 2;

// ───────────────────────────── rigid-body physics (cannon-es) ─────────────────────────────
export interface Debris {
  body: CANNON.Body;
  mesh: THREE.Object3D;
  offset: THREE.Vector3;
}
export class Physics {
  world!: CANNON.World;
  debris: Debris[] = [];
  private acc = 0;
  private readonly fixed = 1 / 240;
  constructor() {
    this.build();
  }
  build() {
    this.world = new CANNON.World();
    this.world.gravity.set(0, -981, 0); // cm/s²
    this.world.allowSleep = true;
    (this.world.solver as CANNON.GSSolver).iterations = 16;
    this.world.defaultContactMaterial.friction = 0.45;
    this.world.defaultContactMaterial.restitution = 0.34;
    const ground = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
    ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    this.world.addBody(ground);
    const bottle = new CANNON.Body({ mass: 0, shape: new CANNON.Box(new CANNON.Vec3(3.25, 8.6, 3.25)), position: new CANNON.Vec3(0, 8.6, 0) });
    this.world.addBody(bottle);
    this.debris = [];
    this.acc = 0;
  }
  reset() {
    this.build();
  }
  addBox(half: [number, number, number], pos: THREE.Vector3, quat: THREE.Quaternion, vel: THREE.Vector3, ang: THREE.Vector3, mass: number, mesh: THREE.Object3D, offset = new THREE.Vector3()) {
    const b = new CANNON.Body({ mass, shape: new CANNON.Box(new CANNON.Vec3(half[0], half[1], half[2])) });
    b.position.set(pos.x, pos.y, pos.z);
    b.quaternion.set(quat.x, quat.y, quat.z, quat.w);
    b.velocity.set(vel.x, vel.y, vel.z);
    b.angularVelocity.set(ang.x, ang.y, ang.z);
    b.linearDamping = 0.02;
    b.angularDamping = 0.05;
    b.allowSleep = true;
    b.sleepSpeedLimit = 4;
    b.sleepTimeLimit = 0.4;
    this.world.addBody(b);
    const d = { body: b, mesh, offset };
    this.debris.push(d);
    return d;
  }
  step(dt: number) {
    this.acc += Math.min(dt, 0.05);
    let n = 0;
    while (this.acc >= this.fixed && n < 24) {
      this.world.step(this.fixed);
      this.acc -= this.fixed;
      n++;
    }
    const q = new THREE.Quaternion();
    const o = new THREE.Vector3();
    for (const d of this.debris) {
      const b = d.body;
      q.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
      o.copy(d.offset).applyQuaternion(q);
      d.mesh.position.set(b.position.x + o.x, b.position.y + o.y, b.position.z + o.z);
      d.mesh.quaternion.copy(q);
    }
  }
}
