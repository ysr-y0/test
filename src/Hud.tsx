// Hud.tsx — live DOM caption layer. Content, layout metrics and animation come from captions.ts so the
// downloaded video is identical. Captions live in a reserved bottom band (bottom-anchored: two-line captions
// grow upward); the camera keeps the action in the clear upper area, so text never covers the hand or cap.
import { useEffect, useRef } from 'react';
import type { Engine } from './engine';
import {
  BAR_GAP, BAR_H, CAPTIONS, CAPTION_BOTTOM, FONT_STACK, LETTER_SP, LINE_BOX, OUTLINE, SAFE_W, WORD_GAP, barAnim, baseFontPx, isLive, letterAnim,
} from './captions';

const shadow = [
  `0.045em 0 0 ${OUTLINE}`, `-0.045em 0 0 ${OUTLINE}`, `0 0.045em 0 ${OUTLINE}`, `0 -0.045em 0 ${OUTLINE}`,
  `0.032em 0.032em 0 ${OUTLINE}`, `-0.032em 0.032em 0 ${OUTLINE}`, `0.032em -0.032em 0 ${OUTLINE}`, `-0.032em -0.032em 0 ${OUTLINE}`,
  `0 0.1em 0 #12294a`, `0 0.16em 0.14em rgba(8,22,52,0.45)`,
].join(',');

export function Hud({ engine, hidden }: { engine: Engine | null; hidden?: boolean }) {
  const root = useRef<HTMLDivElement>(null);

  // fit-to-frame layout (mount, resize, fonts ready)
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const caps = Array.from(el.querySelectorAll<HTMLElement>('[data-cap]'));
    const fit = () => {
      const W = el.clientWidth;
      const H = el.clientHeight;
      if (!W || !H) return;
      const base = baseFontPx(W, H);
      for (const c of caps) {
        c.style.fontSize = `${base}px`;
        let maxW = 0;
        for (const line of Array.from(c.querySelectorAll<HTMLElement>('[data-line]'))) maxW = Math.max(maxW, line.scrollWidth);
        const avail = W * SAFE_W;
        c.style.fontSize = `${Math.floor(maxW > avail ? (base * avail) / maxW : base)}px`;
        c.style.top = `${Math.round(H * CAPTION_BOTTOM)}px`;
      }
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    const fonts = (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts;
    fonts?.ready.then(fit).catch(() => {});
    const late = window.setTimeout(fit, 1500);
    return () => {
      ro.disconnect();
      window.clearTimeout(late);
    };
  }, []);

  // per-frame letter choreography driven by the engine clock
  useEffect(() => {
    if (!engine || !root.current) return;
    const items = Array.from(root.current.querySelectorAll<HTMLElement>('[data-cap]')).map((el) => ({
      el,
      c: CAPTIONS[Number(el.dataset.cap)],
      letters: Array.from(el.querySelectorAll<HTMLElement>('[data-l]')),
      bar: el.querySelector<HTMLElement>('[data-bar]'),
      shown: false,
    }));
    engine.onTime = (t: number) => {
      for (const it of items) {
        const live = isLive(it.c, t);
        if (live !== it.shown) {
          it.el.style.visibility = live ? 'visible' : 'hidden';
          it.shown = live;
        }
        if (!live) continue;
        it.letters.forEach((l, i) => {
          const a = letterAnim(it.c, i, t);
          l.style.opacity = String(a.op);
          l.style.transform = `translateY(${a.y}em) rotate(${a.rot}deg) scale(${a.s})`;
        });
        if (it.bar) {
          const b = barAnim(it.c, t);
          it.bar.style.transform = `scaleX(${b.s})`;
          it.bar.style.opacity = String(b.op);
        }
      }
    };
    return () => {
      engine.onTime = undefined;
    };
  }, [engine]);

  return (
    <div ref={root} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden', fontFamily: FONT_STACK, visibility: hidden ? 'hidden' : 'visible' }}>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '38%', background: 'linear-gradient(to top, rgba(12,30,64,0.36), rgba(12,30,64,0.13) 55%, rgba(12,30,64,0))' }} />
      {CAPTIONS.map((c, ci) => (
        <div
          key={ci}
          data-cap={ci}
          style={{
            position: 'absolute',
            left: '50%',
            top: `${CAPTION_BOTTOM * 100}%`,
            transform: 'translate(-50%, -100%)',
            width: '96%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            fontSize: '48px',
            lineHeight: 1.04,
            letterSpacing: `${LETTER_SP}em`,
            textAlign: 'center',
            visibility: 'hidden',
          }}
        >
          {c.lines.map((line, li) => (
            <div key={li} data-line style={{ display: 'flex', justifyContent: 'center', gap: `${WORD_GAP}em`, whiteSpace: 'nowrap', padding: `${(LINE_BOX - 1.04) / 2}em 0` }}>
              {line.map((word, wi) => (
                <span
                  key={wi}
                  style={{
                    display: 'inline-flex',
                    color: word.c,
                    textShadow: word.emoji ? 'none' : shadow,
                    filter: word.emoji ? 'drop-shadow(0 0.06em 0.05em rgba(8,22,52,0.55))' : undefined,
                  }}
                >
                  {Array.from(word.w).map((ch, i) => (
                    <span key={i} data-l style={{ display: 'inline-block', transformOrigin: '50% 80%', willChange: 'transform, opacity', opacity: 0 }}>
                      {ch}
                    </span>
                  ))}
                </span>
              ))}
            </div>
          ))}
          <div
            data-bar
            style={{
              height: `${BAR_H}em`,
              width: '36%',
              minWidth: '1.2em',
              background: c.accent,
              borderRadius: '999px',
              marginTop: `${BAR_GAP}em`,
              boxShadow: `0 0.04em 0.12em rgba(8,22,52,0.5), 0 0 0.35em ${c.accent}55`,
              transform: 'scaleX(0)',
              opacity: 0,
            }}
          />
        </div>
      ))}
    </div>
  );
}
