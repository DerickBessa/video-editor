// DeckClickBurst — a login button being clicked once, twice, then hammered until it breaks.
//
// Illustrates the setup line of the video: "clica uma vez, beleza. Clica duas vezes, beleza
// também. E quando esse cara clica MIL vezes?". The button survives the first two beats and is
// destroyed by the third, which is the whole point of the sentence.
//
// Times are in SECONDS on the footage timeline, anchored to word onsets in the take:
//   "clica"(3.84) "uma vez"(4.12) · "clica"(5.60) "duas vezes"(5.88) · "clica"(11.48) "mil"(11.86)
import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, Easing, random } from 'remotion';

const FONT = '"Segoe UI", Inter, system-ui, -apple-system, sans-serif';
const ACCENT = '#FFD400';
const WHITE = '#ffffff';
const RED = '#FF3B30';
const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' };

// Three beats. Each: when the cursor arrives, the moments it presses, when it leaves.
const BEATS = [
  { in: 3.80, clicks: [4.32], out: 5.02, gone: 5.26 },
  { in: 5.56, clicks: [5.96, 6.44], out: 7.02, gone: 7.26 },
  { in: 11.45, clicks: null, out: 14.05, gone: 14.35 },   // third beat is the barrage
];
// The barrage: clicks accelerate, then the button gives out.
const RAMP_FROM = 11.90;
const BURST_AT = 13.18;
const RAMP_TO = BURST_AT;

/** How hard the button is pressed right now: 1 = fully down, 0 = at rest. */
function pressAmount(t, clickTimes) {
  let v = 0;
  for (const c of clickTimes) {
    const dt = t - c;
    if (dt >= 0 && dt < 0.16) {
      // down fast, back up with a little ease
      v = Math.max(v, dt < 0.05 ? dt / 0.05 : 1 - (dt - 0.05) / 0.11);
    }
  }
  return v;
}

function Cursor({ size, press }) {
  // Classic arrow, nudged down-right on press so the click reads without a separate ripple.
  const d = press * 5;
  return (
    <svg width={size} height={size * 1.35} viewBox="0 0 24 32" style={{
      transform: `translate(${d}px, ${d}px) scale(${1 - press * 0.06})`,
      filter: 'drop-shadow(0 4px 10px rgba(0,0,0,0.85))',
    }}>
      <path d="M3 2 L3 24 L9 18.5 L13 27 L17 25 L13 17 L21 16 Z"
        fill={WHITE} stroke="#000" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

export function DeckClickBurst({ x = 30, y = 27 }) {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const t = frame / fps;

  const beat = BEATS.find(b => t >= b.in && t < b.gone);
  if (!beat) return null;

  const isBarrage = beat.clicks === null;
  const BW = width * 0.30;          // button width
  const BH = BW * 0.36;

  // --- click timing -------------------------------------------------------
  let clickTimes = beat.clicks || [];
  if (isBarrage) {
    // Accelerating barrage: interval shrinks from 130ms to 28ms.
    clickTimes = [];
    let c = RAMP_FROM;
    while (c < RAMP_TO) {
      clickTimes.push(c);
      const prog = (c - RAMP_FROM) / (RAMP_TO - RAMP_FROM);
      c += interpolate(prog, [0, 1], [0.13, 0.028], CLAMP);
    }
  }
  const press = t < BURST_AT || !isBarrage ? pressAmount(t, clickTimes) : 0;
  const clickCount = clickTimes.filter(c => t >= c).length;

  // --- entry / exit -------------------------------------------------------
  const enter = interpolate(t, [beat.in, beat.in + 0.22], [0, 1], { ...CLAMP, easing: Easing.out(Easing.cubic) });
  const leave = interpolate(t, [beat.out, beat.gone], [1, 0], { ...CLAMP, easing: Easing.in(Easing.quad) });
  const alpha = enter * leave;

  // --- barrage stress -----------------------------------------------------
  const stress = isBarrage
    ? interpolate(t, [RAMP_FROM, BURST_AT], [0, 1], CLAMP) : 0;
  const shake = stress > 0 && t < BURST_AT ? Math.sin(t * 120) * stress * 9 : 0;
  const burst = isBarrage && t >= BURST_AT;
  const bt = t - BURST_AT;

  // Flash on the frame the button gives out — 3 frames, then gone.
  const flash = burst && bt < 0.05 ? 1 - bt / 0.05 : 0;

  const cursorSize = width * 0.075;
  // The cursor sits on the button's lower-right, and rides the press.
  const cursorX = BW * 0.34;
  const cursorY = BH * 0.30;

  return (
    <AbsoluteFill style={{ opacity: alpha }}>
      <div style={{
        position: 'absolute', left: `${x}%`, top: `${y}%`,
        transform: `translate(-50%,-50%) translateX(${shake}px) scale(${0.9 + 0.1 * enter})`,
      }}>
        {/* The button — intact until the burst */}
        {!burst && (
          <div style={{
            width: BW, height: BH, borderRadius: BH * 0.28,
            background: stress > 0.6 ? `hsl(${48 - stress * 20} 100% ${52 - stress * 6}%)` : ACCENT,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: FONT, fontWeight: 900, fontSize: BH * 0.42, color: '#111',
            letterSpacing: '0.04em',
            transform: `scale(${1 - press * 0.055}) translateY(${press * BH * 0.03}px)`,
            boxShadow: press > 0.1
              ? `0 ${2 + press * 2}px 0 rgba(0,0,0,0.35)`
              : '0 8px 0 rgba(0,0,0,0.35), 0 14px 30px rgba(0,0,0,0.5)',
          }}>LOGIN</div>
        )}

        {/* Fragments — the button coming apart */}
        {burst && bt < 0.9 && Array.from({ length: 14 }).map((_, i) => {
          const p = Math.min(1, bt / 0.9);
          const ang = (i / 14) * Math.PI * 2 + random(`a${i}`) * 0.5;
          const dist = (0.35 + random(`d${i}`) * 0.9) * BW * 1.5 * Easing.out(Easing.quad)(p);
          const w = BW * (0.10 + random(`w${i}`) * 0.16);
          const h = BH * (0.16 + random(`h${i}`) * 0.34);
          return (
            <div key={i} style={{
              position: 'absolute', left: BW / 2, top: BH / 2,
              width: w, height: h, background: i % 5 === 0 ? RED : ACCENT,
              borderRadius: 3, opacity: 1 - p,
              transform: `translate(-50%,-50%) translate(${Math.cos(ang) * dist}px, ${Math.sin(ang) * dist + p * p * 90}px) rotate(${(random(`r${i}`) - 0.5) * 420 * p}deg)`,
            }} />
          );
        })}

        {/* Shockwave ring */}
        {burst && bt < 0.36 && (
          <div style={{
            position: 'absolute', left: BW / 2, top: BH / 2,
            width: BW * (0.3 + bt * 4.2), height: BW * (0.3 + bt * 4.2),
            marginLeft: -(BW * (0.3 + bt * 4.2)) / 2, marginTop: -(BW * (0.3 + bt * 4.2)) / 2,
            border: `${Math.max(1, 7 - bt * 18)}px solid ${ACCENT}`,
            borderRadius: '50%', opacity: 1 - bt / 0.36,
          }} />
        )}

        {flash > 0 && (
          <div style={{
            position: 'absolute', left: BW / 2, top: BH / 2, width: BW * 1.5, height: BW * 1.5,
            marginLeft: -BW * 0.75, marginTop: -BW * 0.75, borderRadius: '50%',
            background: `radial-gradient(circle, rgba(255,255,255,${flash * 0.85}) 0%, rgba(255,212,0,0) 65%)`,
          }} />
        )}

        {/* Click counter — only in the barrage, so the escalation is legible */}
        {isBarrage && clickCount > 0 && !burst && (
          <div style={{
            position: 'absolute', left: BW / 2, top: -BH * 0.72, transform: 'translateX(-50%)',
            fontFamily: FONT, fontWeight: 900, fontSize: BH * 0.5,
            color: stress > 0.55 ? RED : WHITE, whiteSpace: 'nowrap',
            textShadow: '0 3px 0 rgba(0,0,0,0.5), 0 0 14px rgba(0,0,0,0.8)',
          }}>{clickCount}×</div>
        )}

        {/* The cursor rides on top of everything, and leaves with the burst */}
        {!burst && (
          <div style={{ position: 'absolute', left: cursorX, top: cursorY }}>
            <Cursor size={cursorSize} press={press} />
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
}
