// engine.ts — renderer, post stack, timing loop, and frame-exact MP4 export.
//
// Performance design (same visuals, far less GPU work per frame):
//  • ONE depth pre-pass: GTAO renders normals+depth at half resolution; the depth-of-field pass reuses that
//    depth texture instead of re-rendering the whole scene (BokehPass did a second full scene render).
//  • MSAA ×4 main pass on a HalfFloat target, bloom at half res (internal), grade pass skips its 12-tap whip
//    blur entirely when no whip is active.
//  • 2048² PCF-soft shadow map (sub-millimetre texels over the hero frustum).
//  • Adaptive pixel ratio: holds 60 fps by trimming resolution only when frames actually drop, and restores
//    it when there is headroom.
//
// Export: deterministic offline render at exactly 30 fps × 24 s → WebCodecs H.264 → MP4. Every frame is rendered
// at a fixed timestep regardless of how long it takes, so the file has no dropped frames and the exact duration.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { DURATION, Director } from './director';
import type { CamOut } from './director';
import { createEnvironmentScene } from './env';
import { FONT_STACK, drawCaptions } from './captions';

const GRADE = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uBlur: { value: 0 },
    uBlurDir: { value: new THREE.Vector2(1, 0) },
    uCA: { value: 0.0018 },
    uVig: { value: 0.85 },
    uGrain: { value: 0.012 },
    uFade: { value: 0 },
    uFadeColor: { value: new THREE.Color('#bfe3f0') },
    uRes: { value: new THREE.Vector2(1, 1) },
    uSat: { value: 1.12 },
    uCon: { value: 1.05 },
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uTime, uBlur, uCA, uVig, uGrain, uFade, uSat, uCon; uniform vec2 uBlurDir, uRes; uniform vec3 uFadeColor;
    varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main(){
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);
      vec2 ca = c * uCA * (1.0 + r2 * 2.0);
      vec3 col;
      if (uBlur > 0.00005) {
        // 12-tap directional whip blur (only on cuts)
        col = vec3(0.0);
        for (int i = 0; i < 12; i++) {
          float f = float(i) / 11.0 - 0.5;
          vec2 o = uBlurDir * uBlur * f;
          col.r += texture2D(tDiffuse, vUv + o + ca).r;
          col.g += texture2D(tDiffuse, vUv + o).g;
          col.b += texture2D(tDiffuse, vUv + o - ca).b;
        }
        col /= 12.0;
      } else {
        col = vec3(texture2D(tDiffuse, vUv + ca).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - ca).b);
      }
      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = max(mix(vec3(lum), col, uSat), 0.0);
      col = max((col - 0.18) * uCon + 0.18, 0.0);
      col *= 1.0 - r2 * uVig * 0.6;
      col += (hash(vUv * uRes + fract(uTime) * 91.7) - 0.5) * uGrain;
      col = mix(col, uFadeColor, uFade);
      gl_FragColor = vec4(col, 1.0);
    }`,
};

/** Circle-of-confusion depth of field, gathering over a golden-angle disk, reading GTAO's depth buffer. */
const DOF = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    cameraNear: { value: 0.3 },
    cameraFar: { value: 4000 },
    focus: { value: 30 },
    aperture: { value: 0.0005 },
    maxblur: { value: 0.008 },
    aspect: { value: 1 },
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    #include <packing>
    uniform sampler2D tDiffuse; uniform sampler2D tDepth;
    uniform float cameraNear, cameraFar, focus, aperture, maxblur, aspect;
    varying vec2 vUv;
    float dist(vec2 uv){ return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, cameraNear, cameraFar); }
    float cocAt(float z){ return clamp((z - focus) * aperture, -maxblur, maxblur); }
    void main(){
      vec4 base = texture2D(tDiffuse, vUv);
      float r = abs(cocAt(dist(vUv)));
      if (r < 0.00035) { gl_FragColor = base; return; }
      vec3 acc = base.rgb;
      float wsum = 1.0;
      for (int i = 0; i < 24; i++) {
        float fi = float(i) + 0.5;
        float rr = sqrt(fi / 24.0) * r;
        float a = fi * 2.39996323;
        vec2 uv = vUv + vec2(cos(a), sin(a) * aspect) * rr;
        // a sample only contributes if its own blur disk reaches this pixel → no sharp-edge halos
        float w = clamp(abs(cocAt(dist(uv))) / max(rr, 1e-5), 0.0, 1.0);
        acc += texture2D(tDiffuse, uv).rgb * w;
        wsum += w;
      }
      gl_FragColor = vec4(acc / wsum, base.a);
    }`,
};

export class Engine {
  onTime?: (t: number) => void;
  director!: Director;
  private renderer!: THREE.WebGLRenderer;
  private composer!: EffectComposer;
  private gtao: GTAOPass | null = null;
  private dof: ShaderPass | null = null;
  private grade!: ShaderPass;
  private raf = 0;
  private last = 0;
  private t = 0;
  private disposed = false;
  private hidden: THREE.Object3D[] = [];
  private hiddenState: boolean[] = [];
  private lastCam: CamOut | null = null;
  private warned = false;
  private exporting = false;
  // adaptive resolution
  private pr = 1;
  private maxPr = 1.5;
  private perfAcc = 0;
  private perfN = 0;
  private coolUntil = 0;
  private startedAt = 0;

  constructor(private host: HTMLElement) {}

  async init() {
    const host = this.host;
    const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', alpha: false, stencil: false });
    const cssW = host.clientWidth || window.innerWidth;
    this.maxPr = Math.max(0.8, Math.min(window.devicePixelRatio || 1, 1.5, 2400 / Math.max(cssW, 1)));
    this.pr = Math.min(this.maxPr, 1.25);
    renderer.setPixelRatio(this.pr);
    // Khronos Neutral preserves hue/saturation in highlights
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 0.92;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;';
    host.appendChild(renderer.domElement);
    this.renderer = renderer;

    await new Promise((r) => requestAnimationFrame(() => r(null))); // let the loading screen paint first
    const director = new Director();
    this.director = director;
    await director.load(); // rigged GLB hand from CDN
    director.key.shadow.mapSize.set(2048, 2048);

    // soft, coloured image-based lighting
    const pm = new THREE.PMREMGenerator(renderer);
    const envScene = createEnvironmentScene();
    const env = pm.fromScene(envScene, 0.035, 0.1, 200).texture;
    pm.dispose();
    envScene.traverse((o) => {
      const me = o as THREE.Mesh;
      me.geometry?.dispose?.();
      (me.material as THREE.Material | undefined)?.dispose?.();
    });
    director.scene.environment = env;
    director.scene.environmentIntensity = 0.55;

    const w = host.clientWidth || window.innerWidth;
    const h = host.clientHeight || window.innerHeight;
    const rt = new THREE.WebGLRenderTarget(Math.round(w * this.pr), Math.round(h * this.pr), { type: THREE.HalfFloatType, samples: 4 });
    const composer = new EffectComposer(renderer, rt);
    composer.setPixelRatio(this.pr);
    composer.addPass(new RenderPass(director.scene, director.camera));
    this.composer = composer;

    this.collectHidden();
    try {
      const gtao = new GTAOPass(director.scene, director.camera, Math.round((w * this.pr) / 2), Math.round((h * this.pr) / 2));
      gtao.output = GTAOPass.OUTPUT.Default;
      gtao.blendIntensity = 0.8;
      gtao.updateGtaoMaterial({ radius: 1.8, distanceExponent: 1.2, thickness: 2, scale: 1.1, samples: 12, distanceFallOff: 1, screenSpaceRadius: false });
      gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, radiusExponent: 1, rings: 2, samples: 12 });
      // half-resolution AO / depth buffer (upsampled in the blend) — the single depth pre-pass of the frame
      const origSet = gtao.setSize.bind(gtao);
      gtao.setSize = (sw: number, sh: number) => origSet(Math.max(1, Math.round(sw / 2)), Math.max(1, Math.round(sh / 2)));
      const origRender = gtao.render.bind(gtao);
      gtao.render = (...args: Parameters<GTAOPass['render']>) => {
        this.hideForDepth(true);
        try {
          origRender(...args);
        } finally {
          this.hideForDepth(false);
        }
      };
      composer.addPass(gtao);
      this.gtao = gtao;
      const dof = new ShaderPass(DOF as never);
      const du = dof.uniforms as Record<string, THREE.IUniform>;
      du.tDepth.value = (gtao as unknown as { depthTexture: THREE.Texture }).depthTexture;
      du.cameraNear.value = director.camera.near;
      du.cameraFar.value = director.camera.far;
      composer.addPass(dof);
      this.dof = dof;
    } catch (e) {
      console.warn('[engine] GTAO/DOF unavailable', e);
    }
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(w / 2, h / 2), 0.22, 0.4, 1.0));
    this.grade = new ShaderPass(GRADE as never);
    composer.addPass(this.grade);
    composer.addPass(new OutputPass());

    this.applySize(w, h, this.pr);
    window.addEventListener('resize', this.resize);

    // pre-compile every shader path once (behind the loading screen)
    try {
      renderer.compile(director.scene, director.camera);
      for (const t of [0.6, 1.8, 4.0, 8.0, 11.9, 13.0, 16.3, 18.5, 22.0]) {
        const cam = director.update(t, 0.016);
        this.applyCam(cam, t, 0.016);
        composer.render(0.016);
      }
    } catch (e) {
      console.warn('[engine] warm-up render failed', e);
    }
    director.reset();
    this.t = 0;
  }

  private collectHidden() {
    const list: THREE.Object3D[] = [];
    this.director.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      const arr = m ? (Array.isArray(m) ? m : [m]) : [];
      const transparent = arr.some((x) => x && x.transparent);
      if (o.userData.noDepth || (transparent && !o.userData.keepDepth)) list.push(o);
    });
    this.hidden = list;
    this.hiddenState = new Array(list.length).fill(true);
  }
  private hideForDepth(hide: boolean) {
    const l = this.hidden;
    if (hide) {
      for (let i = 0; i < l.length; i++) {
        this.hiddenState[i] = l[i].visible;
        l[i].visible = false;
      }
    } else {
      for (let i = 0; i < l.length; i++) l[i].visible = this.hiddenState[i];
    }
  }

  /** Resize every buffer in the chain. w/h are CSS (or export) pixels, pr the pixel ratio. */
  private applySize(w: number, h: number, pr: number) {
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    const cam = this.director.camera;
    cam.aspect = w / h;
    this.director.aspect = cam.aspect;
    // subject lifted 12% of frame height: the bottom caption band stays clear of the action
    cam.setViewOffset(w, h, 0, Math.round(h * 0.12), w, h);
    this.grade.uniforms.uRes.value.set(w * pr, h * pr);
    if (this.dof) (this.dof.uniforms as Record<string, THREE.IUniform>).aspect.value = w / h;
  }

  private resize = () => {
    if (this.exporting) return;
    const w = this.host.clientWidth || window.innerWidth;
    const h = this.host.clientHeight || window.innerHeight;
    this.applySize(w, h, this.pr);
  };

  private applyCam(c: CamOut, t: number, dt: number) {
    if (this.dof) {
      const u = this.dof.uniforms as Record<string, THREE.IUniform>;
      u.focus.value = c.focus;
      u.aperture.value = c.aperture;
    }
    const g = this.grade.uniforms;
    g.uVig.value = 0.85 + Math.min(c.vig, 0.8);
    g.uBlur.value = c.blurAmt;
    g.uBlurDir.value.copy(c.blurDir);
    g.uCA.value = 0.0018 + 0.012 * Math.min(1, c.blurAmt / 0.03);
    g.uFade.value = c.fade;
    g.uTime.value = t + dt;
  }

  /** Adaptive resolution governor: trims pixel ratio only when frames drop, restores it with headroom. */
  private trackPerf(rawMs: number, now: number) {
    if (now - this.startedAt < 2500 || rawMs > 250) return; // ignore warm-up and tab-switch gaps
    this.perfAcc += rawMs;
    this.perfN++;
    if (this.perfN < 90) return;
    const avg = this.perfAcc / this.perfN;
    this.perfAcc = 0;
    this.perfN = 0;
    let next = this.pr;
    if (avg > 21 && this.pr > 0.8) {
      next = Math.max(0.8, this.pr - 0.15);
      this.coolUntil = now + 8000;
    } else if (avg < 17.6 && this.pr < this.maxPr && now > this.coolUntil) {
      next = Math.min(this.maxPr, this.pr + 0.1);
    }
    if (Math.abs(next - this.pr) > 1e-3) {
      this.pr = next;
      this.resize();
    }
  }

  start() {
    this.last = performance.now();
    this.startedAt = this.last;
    const loop = (now: number) => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      if (this.exporting) {
        this.last = now;
        return;
      }
      const raw = now - this.last;
      const dt = Math.min(Math.max(raw / 1000, 0), 1 / 20);
      this.last = now;
      this.trackPerf(raw, now);
      this.t += dt;
      if (this.t >= DURATION) this.t -= DURATION;
      try {
        this.lastCam = this.director.update(this.t, dt);
      } catch (err) {
        if (!this.warned) console.error('[director] update failed', err);
        this.warned = true;
      }
      if (this.lastCam) this.applyCam(this.lastCam, this.t, dt);
      this.composer.render(dt);
      this.onTime?.(this.t);
    };
    this.raf = requestAnimationFrame(loop);
  }

  static canExport() {
    return typeof window !== 'undefined' && 'VideoEncoder' in window && 'VideoFrame' in window;
  }

  /**
   * Offline, frame-exact render of the full piece to MP4 (H.264). Fixed 30 fps timestep → exactly DURATION
   * seconds, zero dropped frames, independent of machine speed. Captions are composited from captions.ts.
   */
  async exportVideo(onProgress: (p: number) => void): Promise<Blob> {
    if (!Engine.canExport()) throw new Error('This browser has no WebCodecs video encoder (use Chrome, Edge, or Safari 17+).');
    this.exporting = true;
    const FPS = 30;
    const N = Math.round(DURATION * FPS);
    let encoder: VideoEncoder | null = null;
    try {
      const fonts = (document as Document & { fonts?: { load: (f: string) => Promise<unknown> } }).fonts;
      await fonts?.load(`64px ${FONT_STACK}`).catch(() => {});

      // output size: short side 1080, matching the on-screen aspect (even dimensions for H.264)
      const cw = this.host.clientWidth || window.innerWidth;
      const ch = this.host.clientHeight || window.innerHeight;
      const aspect = cw / ch;
      const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
      let W: number;
      let H: number;
      if (aspect >= 1) {
        H = 1080;
        W = even(1080 * aspect);
        if (W > 1920) {
          W = 1920;
          H = even(1920 / aspect);
        }
      } else {
        W = 1080;
        H = even(1080 / aspect);
        if (H > 1920) {
          H = 1920;
          W = even(1920 * aspect);
        }
      }

      let config: VideoEncoderConfig | null = null;
      for (const codec of ['avc1.640028', 'avc1.4d0028', 'avc1.42e028', 'avc1.640032']) {
        const cfg: VideoEncoderConfig = { codec, width: W, height: H, bitrate: 16_000_000, framerate: FPS };
        try {
          const s = await VideoEncoder.isConfigSupported(cfg);
          if (s.supported) {
            config = cfg;
            break;
          }
        } catch {
          /* try next */
        }
      }
      if (!config) throw new Error('No supported H.264 encoder configuration was found.');

      const target = new ArrayBufferTarget();
      const muxer = new Muxer({ target, video: { codec: 'avc', width: W, height: H }, fastStart: 'in-memory' });
      let encErr: unknown = null;
      encoder = new VideoEncoder({
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
        error: (e) => {
          encErr = e;
        },
      });
      encoder.configure(config);

      this.applySize(W, H, 1);
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d')!;
      const dt = 1 / FPS;
      this.director.reset();
      const frameUs = 1e6 / FPS;
      for (let i = 0; i < N; i++) {
        const t = i / FPS;
        const cam = this.director.update(t, dt);
        this.applyCam(cam, t, dt);
        this.composer.render(dt);
        ctx.drawImage(this.renderer.domElement, 0, 0, W, H);
        drawCaptions(ctx, t, W, H);
        const frame = new VideoFrame(canvas, { timestamp: Math.round(i * frameUs), duration: Math.round(frameUs) });
        encoder.encode(frame, { keyFrame: i % (FPS * 2) === 0 });
        frame.close();
        if (encErr) throw encErr;
        onProgress((i + 1) / N);
        // back-pressure: never let the encoder queue grow (keeps memory flat and the page responsive)
        while (encoder.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 2));
        if (i % 3 === 0) await new Promise((r) => setTimeout(r, 0));
      }
      await encoder.flush();
      if (encErr) throw encErr;
      encoder.close();
      encoder = null;
      muxer.finalize();
      return new Blob([target.buffer as ArrayBuffer], { type: 'video/mp4' });
    } finally {
      if (encoder && encoder.state !== 'closed') encoder.close();
      this.exporting = false;
      this.director.reset();
      this.t = 0;
      this.resize();
      this.last = performance.now();
      this.startedAt = this.last;
    }
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resize);
    if (!this.renderer) return;
    this.director?.scene.traverse((o) => {
      const me = o as THREE.Mesh;
      me.geometry?.dispose?.();
      const m = me.material as THREE.Material | THREE.Material[] | undefined;
      if (m) for (const mm of Array.isArray(m) ? m : [m]) mm.dispose();
    });
    this.gtao?.dispose();
    this.composer?.dispose?.();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
