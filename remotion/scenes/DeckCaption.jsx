// DeckCaption — the Deck Dev short-form caption system.
//
// Reusable across videos: the component knows nothing about any particular script. It takes a
// list of blocks and renders whichever one is active for the current frame, as a transparent
// overlay that ffmpeg composites onto the footage.
//
// Block shape (see remotion/data/*.json):
//   { s, e, l, y?, big?, cta? }
//     s, e  start/end in SECONDS on the FOOTAGE timeline (not frames — the overlay must render
//           correctly at whatever fps the footage happens to be)
//     l     1-2 lines of text; wrap any part in *asterisks* to highlight it in the accent colour
//     y     vertical anchor as a % of height (default 72 = lower third). Raise it when the
//           default would sit on top of the subject's hands, a prop, or a graphic.
//     big   hero moment — a step up in size, for a punchline or a key term
//     cta   the call to action — largest, with its own punch
//
// There are deliberately NO captions during full-screen animation: that is expressed simply by
// leaving a gap in the block list, so the overlay is transparent there.
import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, Easing } from 'remotion';

const FONT = '"Segoe UI", Inter, system-ui, -apple-system, sans-serif';
const WHITE = '#ffffff';
const ACCENT = '#FFD400';
const GREEN = '#4DFF88';   // reserved for the CTA — same green the animation uses for success
const RED   = '#ff4d6d';   // alert / error / what is being rejected
const CYAN  = '#5BD6FF';   // technical term, system-side

// `hlColor` picks which of these the *highlighted* runs use. The default stays ACCENT so every
// existing block list keeps rendering exactly as before.
const HL_COLORS = { accent: ACCENT, green: GREEN, red: RED, cyan: CYAN };

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' };

// Sizes as a fraction of composition width, so the system scales with the canvas. Kept
// deliberately modest: a caption is support, and at the previous values it was taking up far
// too much of a 9:16 frame.
const SIZE = { normal: 0.068, big: 0.082, cta: 0.090 };

// Entry is fast — ~7 frames at 60fps. Long enough to read as animated, short enough that it
// never lags behind the word being spoken.
const ENTER_SEC = 0.115;

/** Split "TU VAI USAR *RATE LIMIT*" into runs, marking the highlighted ones. */
function parseRuns(line) {
  return line.split('*').map((text, i) => ({ text, hl: i % 2 === 1 })).filter(r => r.text !== '');
}

function Line({ line, size, shadow, hlColor = ACCENT, tracking = '-0.02em' }) {
  return (
    <div style={{
      fontFamily: FONT, fontWeight: 900, fontSize: size, lineHeight: 1.12,
      letterSpacing: tracking, textShadow: shadow, textAlign: 'center',
      whiteSpace: 'nowrap',
    }}>
      {parseRuns(line).map((r, i) => (
        <span key={i} style={{ color: r.hl ? hlColor : WHITE }}>{r.text}</span>
      ))}
    </div>
  );
}

/** `offset` shifts this render's window along the footage timeline, so a long video can be
 *  covered by a few short overlays instead of one enormous one — captions usually occupy a
 *  couple of windows with full-screen graphics in between, and rendering the empty middle is
 *  pure waste. Block times stay absolute; only the render window moves. */
export function DeckCaption({ blocks = [], offset = 0, debug = false }) {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const t = frame / fps + offset;

  const b = blocks.find(x => t >= x.s && t < x.e);
  if (!b) return debug ? <AbsoluteFill /> : null;

  const kind = b.cta ? 'cta' : b.big ? 'big' : 'normal';
  const y = (b.y ?? 72) / 100;

  // Auto-fit: a hero size that is right for "MIL VEZES" runs straight off the edges on a line
  // like "CINCO TENTATIVAS". Rather than hand-tuning a size per block (which would drift the
  // moment the script changes), shrink whichever block needs it so the longest line always
  // lands inside the safe width. `nowrap` means overflow would be silent clipping otherwise.
  const SAFE_W = width * 0.86;
  const CHAR_W = 0.58;                     // ≈ advance of this weight, in em
  const longest = Math.max(...b.l.map(line => line.replace(/\*/g, '').length));
  const wanted = width * SIZE[kind];
  const size = Math.min(wanted, SAFE_W / (longest * CHAR_W));

  // Enter: scale up from 94%, rise a few px, fade in. Ease-out, no bounce.
  const p = interpolate(t, [b.s, b.s + ENTER_SEC], [0, 1],
    { ...CLAMP, easing: Easing.out(Easing.cubic) });
  // A hero block gets a touch more travel, so emphasis reads without a different animation.
  const from = kind === 'normal' ? 0.955 : 0.925;
  let scale = from + (1 - from) * p;
  const dy = (1 - p) * (kind === 'normal' ? 14 : 22);

  // `fx: "term"` — a named technical term (BRUTE FORCE, RACE CONDITION, RATE LIMIT). These are
  // the words the whole video is about, so they get their own entrance: the letters start
  // tracked-out and close up, with a small extra punch on the scale. Deliberately one gesture
  // and nothing more — it must not turn into a different design language every time.
  const isTerm = b.fx === 'term';
  const termP = isTerm
    ? interpolate(t, [b.s, b.s + 0.26], [0, 1], { ...CLAMP, easing: Easing.out(Easing.cubic) })
    : 1;
  const tracking = isTerm
    ? `${interpolate(termP, [0, 1], [0.16, -0.02])}em`
    : '-0.02em';
  if (isTerm) scale *= 1 + (1 - termP) * 0.06;

  const hlColor = HL_COLORS[b.hlColor] || ACCENT;

  // Exit is simpler than entry: consecutive blocks swap directly to keep the pace up, and only
  // a block with a real gap after it fades.
  const next = blocks.find(x => x.s >= b.e);
  const hasGap = !next || next.s - b.e > 0.12;
  const out = hasGap
    ? interpolate(t, [b.e - 0.09, b.e], [1, 0], CLAMP)
    : 1;

  // Outline-ish shadow: enough to hold up over skin, wall and dark UI without looking like a
  // TV subtitle box.
  const shadow = [
    '0 2px 0 rgba(0,0,0,0.55)',
    '0 0 12px rgba(0,0,0,0.75)',
    '0 6px 26px rgba(0,0,0,0.65)',
  ].join(', ');

  return (
    <AbsoluteFill style={{ opacity: p * out }}>
      <div style={{
        position: 'absolute', left: '50%', top: `${y * 100}%`,
        transform: `translate(-50%, -50%) translateY(${dy}px) scale(${scale})`,
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: size * 0.1,
        // Keeps a long line inside the safe area instead of running off the edges.
        maxWidth: width * 0.86,
      }}>
        {b.l.map((line, i) => (
          <Line key={i} line={line} size={size} shadow={shadow} hlColor={hlColor} tracking={tracking} />
        ))}
      </div>
    </AbsoluteFill>
  );
}
