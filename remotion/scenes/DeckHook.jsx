// DeckHook — hero typography for the opening line of a short.
//
// This is deliberately NOT the caption system. A caption's job is to be readable and get out of
// the way; a hook's job is to stop the scroll. So the composition is built line by line as the
// sentence is spoken, with different weights and sizes per line, and it pays off on one word.
//
// Here the payoff is literal: the line is "sabe um jeito muito simples de QUEBRAR um SITE?", and
// the word SITE breaks in half on screen. The visual does what the sentence says.
//
// Timing is in SECONDS against the footage, same convention as DeckCaption.
import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, Easing, random } from 'remotion';

const FONT = '"Segoe UI", Inter, system-ui, -apple-system, sans-serif';
const WHITE = '#ffffff';
const ACCENT = '#FFD400';
const BREAK_RED = '#FF3B30';   // SITE — the word that breaks, so it reads as damage
const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' };

// Word onsets, measured from the transcript:
//   "sabe" 0.00 · "muito" 0.52 · "de/quebrar" 1.18 · "site?" 1.62
const L1_AT = 0.00;   // SABE UM JEITO
const L2_AT = 0.52;   // muito simples
const L3_AT = 1.18;   // DE QUEBRAR UM
const TENSION_AT = 1.32; // on the word "quebrar" — the composition starts to strain
const SITE_AT = 1.62; // SITE lands whole
const BREAK_AT = 1.86; // and splits
const OUT_AT = 2.28;

const SHADOW = [
  '0 3px 0 rgba(0,0,0,0.5)',
  '0 0 16px rgba(0,0,0,0.8)',
  '0 8px 34px rgba(0,0,0,0.7)',
].join(', ');

/** Entry shared by every line: quick scale-up, small rise, ease-out, tiny overshoot. */
function entry(t, at, { dur = 0.16, from = 0.9, rise = 26 } = {}) {
  const p = interpolate(t, [at, at + dur], [0, 1], { ...CLAMP, easing: Easing.out(Easing.cubic) });
  const over = interpolate(t, [at + dur, at + dur + 0.1], [1, 0], CLAMP);
  return {
    opacity: p,
    scale: from + (1 - from) * p + over * 0.012,
    dy: (1 - p) * rise,
  };
}

export function DeckHook({ y = 44 }) {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const t = frame / fps;

  const e1 = entry(t, L1_AT);
  const e2 = entry(t, L2_AT, { rise: 18 });
  const e3 = entry(t, L3_AT, { from: 0.86, rise: 30 });
  const e4 = entry(t, SITE_AT, { dur: 0.13, from: 0.78, rise: 0 });

  // Tension: from "quebrar" until the break, the stack tightens very slightly and jitters. It
  // should be felt, not seen.
  const tension = interpolate(t, [TENSION_AT, BREAK_AT], [0, 1], CLAMP);
  const preShake = t > TENSION_AT && t < BREAK_AT
    ? Math.sin(t * 90) * tension * 2.2 : 0;

  // The break itself: a hard impact, the halves separate, then settle a little further apart.
  const bp = interpolate(t, [BREAK_AT, BREAK_AT + 0.09], [0, 1], { ...CLAMP, easing: Easing.out(Easing.quad) });
  const drift = interpolate(t, [BREAK_AT + 0.09, OUT_AT], [0, 1], { ...CLAMP, easing: Easing.out(Easing.cubic) });
  const gap = bp * 42 + drift * 16;             // px each half travels outward
  const tilt = bp * 2.4 + drift * 0.8;          // deg, opposite per half
  const dropY = drift * 9;

  // Impact shake on the whole stack — short, decaying, never ambient.
  const dt = t - BREAK_AT;
  const shake = dt >= 0 && dt < 0.2 ? Math.sin(dt * 130) * 14 * (1 - dt / 0.2) : 0;

  // Chromatic split: 3 frames only. A glitch is an event, not decoration.
  const chroma = t >= BREAK_AT && t < BREAK_AT + 0.055
    ? interpolate(t, [BREAK_AT, BREAK_AT + 0.055], [10, 0], CLAMP) : 0;

  // Motion blur on the separation, faked with a couple of trailing copies.
  const smear = interpolate(t, [BREAK_AT, BREAK_AT + 0.12], [1, 0], CLAMP);

  const out = interpolate(t, [OUT_AT, OUT_AT + 0.18], [1, 0], CLAMP);
  if (out <= 0) return null;

  const SITE_SIZE = width * 0.30;
  const line = (size, weight = 900) => ({
    fontFamily: FONT, fontWeight: weight, fontSize: size, color: WHITE,
    letterSpacing: '-0.02em', textShadow: SHADOW, lineHeight: 1.02, whiteSpace: 'nowrap',
  });

  const half = (text, dir) => (
    <span style={{
      display: 'inline-block',
      transform: `translateX(${dir * gap}px) rotate(${dir * tilt}deg) translateY(${dropY}px)`,
    }}>{text}</span>
  );

  // `abs` is explicit: inferring it from dx===0 made the motion-blur copy (which has no x
  // offset) fall back into flow and stack a second SITE underneath the first.
  const siteStack = (color, dx = 0, opacity = 1, abs = false) => (
    <div style={{
      ...line(SITE_SIZE),
      color, opacity,
      ...(abs ? { position: 'absolute', left: 0, right: 0, top: 0 } : { position: 'relative' }),
      transform: `translateX(${dx}px)`,
      display: 'flex', justifyContent: 'center',
    }}>
      {half('SI', -1)}{half('TE', +1)}
    </div>
  );

  return (
    <AbsoluteFill style={{ opacity: out }}>
      <div style={{
        position: 'absolute', left: '50%', top: `${y}%`,
        transform: `translate(-50%,-50%) translateX(${shake + preShake}px)`,
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        gap: width * 0.012, width: width * 0.9,
      }}>
        <div style={{
          ...line(width * 0.088), opacity: e1.opacity,
          transform: `scale(${e1.scale}) translateY(${e1.dy}px)`,
        }}>SABE UM JEITO</div>

        <div style={{
          ...line(width * 0.062, 800), opacity: e2.opacity,
          transform: `scale(${e2.scale}) translateY(${e2.dy}px)`,
        }}>
          MUITO <span style={{ color: ACCENT }}>SIMPLES</span>
        </div>

        <div style={{
          ...line(width * 0.105), opacity: e3.opacity,
          transform: `scale(${e3.scale}) translateY(${e3.dy}px) scaleY(${1 + tension * 0.03})`,
        }}>DE QUEBRAR UM</div>

        {/* SITE — the biggest element, and the one that breaks. */}
        <div style={{
          position: 'relative', opacity: e4.opacity,
          transform: `scale(${e4.scale})`, marginTop: width * 0.006,
        }}>
          {chroma > 0.1 && <>{siteStack('#ff3355', -chroma, 0.55, true)}{siteStack('#33e0ff', chroma, 0.55, true)}</>}
          {smear > 0.02 && siteStack(BREAK_RED, 0, smear * 0.28, true)}
          {siteStack(BREAK_RED)}
        </div>
      </div>

      {/* A few shards thrown off by the impact — sparse, and gone in under a third of a second. */}
      {dt >= 0 && dt < 0.32 && Array.from({ length: 7 }).map((_, i) => {
        const p = dt / 0.32;
        const dir = i % 2 ? 1 : -1;
        const sx = dir * (60 + random(`hx${i}`) * 190) * p;
        const sy = (random(`hy${i}`) - 0.5) * 150 * p;
        return (
          <div key={i} style={{
            position: 'absolute', left: '50%', top: `${y + 9}%`,
            width: 5 + random(`hw${i}`) * 12, height: 4,
            background: i % 3 === 0 ? ACCENT : WHITE, opacity: (1 - p) * 0.85,
            transform: `translate(-50%,-50%) translate(${sx}px, ${sy}px) rotate(${dir * p * 40}deg)`,
          }} />
        );
      })}
    </AbsoluteFill>
  );
}
