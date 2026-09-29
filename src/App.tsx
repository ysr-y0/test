import { useEffect, useRef, useState } from 'react';
import { Engine } from './engine';
import { Hud } from './Hud';

type ExportState = { phase: 'idle' } | { phase: 'rendering'; p: number } | { phase: 'error'; msg: string };

export default function App() {
  const host = useRef<HTMLDivElement>(null);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [exp, setExp] = useState<ExportState>({ phase: 'idle' });

  useEffect(() => {
    if (!host.current) return;
    let dead = false;
    const eng = new Engine(host.current);
    eng
      .init()
      .then(() => {
        if (dead) {
          eng.dispose();
          return;
        }
        setEngine(eng);
        eng.start();
        setReady(true);
      })
      .catch((e) => {
        console.error(e);
        if (!dead) setFailed(true);
      });
    return () => {
      dead = true;
      eng.dispose();
    };
  }, []);

  const download = async () => {
    if (!engine || exp.phase === 'rendering') return;
    setExp({ phase: 'rendering', p: 0 });
    let lastUi = 0;
    try {
      const blob = await engine.exportVideo((p) => {
        const now = performance.now();
        if (now - lastUi > 120 || p >= 1) {
          lastUi = now;
          setExp({ phase: 'rendering', p });
        }
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'why-bottle-caps-are-round.mp4';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      setExp({ phase: 'idle' });
    } catch (e) {
      console.error(e);
      setExp({ phase: 'error', msg: e instanceof Error ? e.message : 'Export failed.' });
    }
  };

  const busy = exp.phase === 'rendering';
  const ui = { fontFamily: 'Inter, system-ui, sans-serif' } as const;

  return (
    <div style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: '#bfe3f0' }}>
      <div ref={host} style={{ position: 'absolute', inset: 0 }} />
      <Hud engine={engine} hidden={busy} />

      {/* download button — top-right, clear of the caption band */}
      {ready && !busy && (
        <button
          onClick={download}
          title="Download the 24-second reel (MP4, 30 fps)"
          style={{
            ...ui,
            position: 'absolute',
            top: 16,
            right: 16,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 16px 10px 13px',
            borderRadius: 999,
            border: '1px solid rgba(255,255,255,0.35)',
            background: 'rgba(16,36,72,0.55)',
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
            color: '#fff',
            fontSize: 14,
            fontWeight: 700,
            cursor: 'pointer',
            boxShadow: '0 6px 20px rgba(8,22,52,0.25)',
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3v12" />
            <path d="M7 10l5 5 5-5" />
            <path d="M5 21h14" />
          </svg>
          Download MP4
        </button>
      )}

      {/* export overlay */}
      {(busy || exp.phase === 'error') && (
        <div style={{ ...ui, position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: 'rgba(12,30,64,0.72)', backdropFilter: 'blur(6px)', color: '#fff' }}>
          <div style={{ width: 'min(360px, 80vw)', textAlign: 'center' }}>
            {busy ? (
              <>
                <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 14 }}>Rendering video… {Math.round(exp.p * 100)}%</div>
                <div style={{ height: 10, borderRadius: 99, background: 'rgba(255,255,255,0.18)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${exp.p * 100}%`, background: 'linear-gradient(90deg,#ffd45c,#ff9a5c)', borderRadius: 99, transition: 'width 120ms linear' }} />
                </div>
                <div style={{ fontSize: 13, opacity: 0.75, marginTop: 12 }}>Frame-exact 30 fps render — the file will be exactly 24 seconds with no dropped frames.</div>
              </>
            ) : (
              exp.phase === 'error' && (
                <>
                  <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 10 }}>Couldn't export the video</div>
                  <div style={{ fontSize: 13, opacity: 0.8, marginBottom: 16 }}>{exp.msg}</div>
                  <button onClick={() => setExp({ phase: 'idle' })} style={{ ...ui, padding: '8px 18px', borderRadius: 999, border: 'none', background: '#ffd45c', color: '#12294a', fontWeight: 700, cursor: 'pointer' }}>
                    OK
                  </button>
                </>
              )
            )}
          </div>
        </div>
      )}

      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'grid',
          placeItems: 'center',
          background: 'radial-gradient(circle at 50% 45%, #eaf7f8 0%, #a9d9ec 70%)',
          opacity: ready ? 0 : 1,
          transition: 'opacity 700ms ease',
          pointerEvents: ready ? 'none' : 'auto',
        }}
      >
        {failed ? <div style={{ ...ui, color: '#1c3a63', fontWeight: 600 }}>WebGL 2 is required to play this piece.</div> : <div className="cap-spinner" />}
      </div>
    </div>
  );
}
