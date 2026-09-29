// captions.ts — single source of truth for caption content, layout and animation.
// The live HUD (DOM) and the video exporter (2D canvas composite) both use these exact functions,
// so the downloaded MP4 matches what plays on screen.

export interface Word {
  w: string;
  c: string;
  emoji?: boolean;
}
export interface Caption {
  t0: number;
  t1: number;
  accent: string;
  lines: Word[][];
}

// on-screen text is exactly the brief's — nothing invented; timings match the voiceover beats (24s cut)
export const CAPTIONS: Caption[] = [
  { t0: 0.15, t1: 2.65, accent: '#ffd45c', lines: [[{ w: 'BETTER', c: '#ffffff' }, { w: 'GRIP?', c: '#ffd45c' }]] },
  { t0: 2.9, t1: 6.45, accent: '#ffb08a', lines: [[{ w: 'HIGH', c: '#ffffff' }, { w: 'PRESSURE', c: '#ffb08a' }]] },
  { t0: 6.7, t1: 10.65, accent: '#ff8a78', lines: [[{ w: 'STRESS', c: '#ffffff' }], [{ w: 'CONCENTRATION', c: '#ff8a78' }]] },
  { t0: 10.9, t1: 15.05, accent: '#ff8a78', lines: [[{ w: 'SEAL', c: '#ffffff' }, { w: 'FAILURE', c: '#ff8a78' }, { w: '💥', c: '#ffffff', emoji: true }]] },
  { t0: 15.3, t1: 22.8, accent: '#8df0b8', lines: [[{ w: 'EQUAL', c: '#ffffff' }, { w: 'FORCE', c: '#8df0b8' }]] },
];

/** Caption band: the block's BOTTOM edge sits here (fraction of frame height); multi-line grows upward. */
export const CAPTION_BOTTOM = 0.93;
/** The widest line must fit inside this fraction of the frame width. */
export const SAFE_W = 0.86;
export const baseFontPx = (W: number, H: number) => Math.min(W * 0.1, H * 0.088);

// em-based metrics shared by DOM and canvas
export const LINE_BOX = 1.16; // line-height 1.04 + 0.06 padding top & bottom
export const BAR_H = 0.085;
export const BAR_GAP = 0.14;
export const WORD_GAP = 0.24;
export const LETTER_SP = 0.012;
export const FONT_STACK = "'Lilita One','Baloo 2','Fredoka',Impact,sans-serif";
export const OUTLINE = '#1c3a63';

const cl = (x: number) => Math.min(1, Math.max(0, x));
const easeOutBack = (t: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInCubic = (t: number) => t * t * t;

export const isLive = (c: Caption, t: number) => t >= c.t0 - 0.01 && t <= c.t1 + 0.4;

/** Per-letter state: opacity, vertical offset (em), rotation (deg), scale. Pure function of time. */
export function letterAnim(c: Caption, i: number, t: number) {
  const tin = t - c.t0 - i * 0.035;
  const p = cl(tin / 0.4);
  const q = cl((t - (c.t1 - 0.3) - i * 0.012) / 0.28);
  return {
    op: cl(tin / 0.1) * (1 - q),
    y: (1 - easeOutCubic(p)) * 0.7 + easeInCubic(q) * 0.5 + Math.sin(t * 3.2 + i * 0.7) * 0.018 * p,
    rot: (1 - easeOutCubic(p)) * -12 + easeInCubic(q) * 8,
    s: Math.max(easeOutBack(p) * (1 - easeInCubic(q)), 0.0001),
  };
}
export function barAnim(c: Caption, t: number) {
  const bp = cl((t - c.t0 - 0.12) / 0.45);
  const bq = cl((t - (c.t1 - 0.3)) / 0.28);
  return { s: Math.max(easeOutBack(bp) * (1 - easeInCubic(bq)), 0.0001), op: cl((t - c.t0 - 0.12) / 0.1) * (1 - bq) };
}

// ───────────────────────── canvas renderer (used by the exporter) ─────────────────────────
function lineWidthEm(ctx: CanvasRenderingContext2D, line: Word[], fs: number) {
  let w = 0;
  line.forEach((word, wi) => {
    for (const ch of Array.from(word.w)) w += ctx.measureText(ch).width / fs + LETTER_SP;
    if (wi < line.length - 1) w += WORD_GAP;
  });
  return w;
}

/** Scrim + captions, composited over a rendered frame. */
export function drawCaptions(ctx: CanvasRenderingContext2D, t: number, W: number, H: number) {
  // bottom scrim (matches the DOM gradient)
  const g = ctx.createLinearGradient(0, H, 0, H * 0.62);
  g.addColorStop(0, 'rgba(12,30,64,0.36)');
  g.addColorStop(0.55, 'rgba(12,30,64,0.13)');
  g.addColorStop(1, 'rgba(12,30,64,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, H * 0.62, W, H * 0.38);

  for (const c of CAPTIONS) {
    if (!isLive(c, t)) continue;
    const base = baseFontPx(W, H);
    ctx.font = `${base}px ${FONT_STACK}`;
    const maxEm = Math.max(...c.lines.map((l) => lineWidthEm(ctx, l, base)));
    const fs = Math.floor(maxEm * base > W * SAFE_W ? (W * SAFE_W) / maxEm : base);
    ctx.font = `${fs}px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    const blockH = (c.lines.length * LINE_BOX + BAR_GAP + BAR_H) * fs;
    const top = H * CAPTION_BOTTOM - blockH;
    let li = 0;
    let n = 0; // running letter index in reading order (same as the DOM)
    for (const line of c.lines) {
      const lw = lineWidthEm(ctx, line, fs) * fs;
      let x = W / 2 - lw / 2;
      const lineTop = top + li * LINE_BOX * fs;
      const originY = lineTop + 0.892 * fs; // transform-origin 50% 80% of the 1.04em letter box
      line.forEach((word, wi) => {
        for (const ch of Array.from(word.w)) {
          const cw = ctx.measureText(ch).width;
          const a = letterAnim(c, n++, t);
          if (a.op > 0.003) {
            ctx.save();
            ctx.globalAlpha = a.op;
            ctx.translate(x + cw / 2, originY + a.y * fs);
            ctx.rotate((a.rot * Math.PI) / 180);
            ctx.scale(a.s, a.s);
            const ty = (0.58 - 0.892) * fs;
            if (!word.emoji) {
              // soft cast shadow + hard drop + outline + fill (mirrors the DOM text-shadow stack)
              ctx.shadowColor = 'rgba(8,22,52,0.45)';
              ctx.shadowBlur = 0.14 * fs;
              ctx.shadowOffsetY = 0.16 * fs;
              ctx.fillStyle = '#12294a';
              ctx.strokeStyle = '#12294a';
              ctx.lineWidth = 0.09 * fs;
              ctx.strokeText(ch, 0, ty + 0.1 * fs);
              ctx.fillText(ch, 0, ty + 0.1 * fs);
              ctx.shadowColor = 'transparent';
              ctx.strokeStyle = OUTLINE;
              ctx.strokeText(ch, 0, ty);
            } else {
              ctx.shadowColor = 'rgba(8,22,52,0.55)';
              ctx.shadowBlur = 0.05 * fs;
              ctx.shadowOffsetY = 0.06 * fs;
            }
            ctx.fillStyle = word.c;
            ctx.fillText(ch, 0, ty);
            ctx.restore();
          }
          x += cw + LETTER_SP * fs;
        }
        if (wi < line.length - 1) x += WORD_GAP * fs;
      });
      li++;
    }
    // accent bar
    const b = barAnim(c, t);
    if (b.op > 0.003) {
      const bw = Math.max(W * 0.96 * 0.36, 1.2 * fs) * b.s;
      const bh = BAR_H * fs;
      const by = top + c.lines.length * LINE_BOX * fs + BAR_GAP * fs;
      ctx.save();
      ctx.globalAlpha = b.op;
      ctx.shadowColor = 'rgba(8,22,52,0.5)';
      ctx.shadowBlur = 0.12 * fs;
      ctx.shadowOffsetY = 0.04 * fs;
      ctx.fillStyle = c.accent;
      ctx.beginPath();
      ctx.roundRect(W / 2 - bw / 2, by, bw, bh, bh / 2);
      ctx.fill();
      ctx.restore();
    }
  }
}


