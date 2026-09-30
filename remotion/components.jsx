// The reusable motion-graphics library.
//
// These exist for the things ASS/libass genuinely cannot draw: a syntax-coloured
// code block, a terminal with a typing cursor, a browser chrome, a phone frame.
// Anything that is just styled text belongs in `captions`, which is far cheaper
// than spinning up a headless browser.
//
// Every component renders on a TRANSPARENT background and is composited over
// the video by ffmpeg afterwards. That keeps Remotion out of the video pipeline
// proper — it produces an overlay, it does not own the render.
//
// Shared conventions:
//   - sizes are in px against the composition size the caller chose
//   - each component animates IN over `enterFrames` and OUT over `exitFrames`
//   - springs are used for anything that should feel physical; linear
//     interpolation for anything that should feel mechanical (progress bars)
import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring, Img } from 'remotion';
import { BruteForceRaceCondition, TOTAL_SECONDS as BRUTE_FORCE_RACE_CONDITION_SECONDS } from './scenes/BruteForceRaceCondition.jsx';
import { DeckCaption } from './scenes/DeckCaption.jsx';
import { DeckHook } from './scenes/DeckHook.jsx';
import { DeckClickBurst } from './scenes/DeckClickBurst.jsx';
import { PromptInjection, TOTAL_SECONDS as PROMPT_INJECTION_SECONDS } from './scenes/PromptInjection.jsx';
import { PiCam, PiOverlay } from './scenes/PiCam.jsx';

export { BRUTE_FORCE_RACE_CONDITION_SECONDS, PROMPT_INJECTION_SECONDS };

/* ------------------------------------------------------------- primitives */

const FONT = '"Segoe UI", Inter, system-ui, -apple-system, sans-serif';
const MONO = '"Cascadia Code", "JetBrains Mono", Consolas, "Courier New", monospace';

/** Fade + rise on entry, fade on exit. The house transition. */
function useEnterExit({ enterFrames = 12, exitFrames = 10 } = {}) {
  const frame = useCurrentFrame();
  const { durationInFrames, fps } = useVideoConfig();

  const enter = spring({ frame, fps, config: { damping: 200, mass: 0.6 }, durationInFrames: enterFrames });
  const exit = interpolate(
    frame,
    [durationInFrames - exitFrames, durationInFrames],
    [1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );
  return { opacity: enter * exit, enter, exit, frame };
}

const shadow = '0 8px 40px rgba(0,0,0,0.45)';

/* ------------------------------------------------------------ text pieces */

export function Title({ text = 'Title', subtitle, color = '#ffffff', accent = '#FFD400', size = 92, position = 'center' }) {
  const { opacity, enter } = useEnterExit({ enterFrames: 14 });
  const justify = position === 'top' ? 'flex-start' : position === 'bottom' ? 'flex-end' : 'center';
  return (
    <AbsoluteFill style={{ justifyContent: justify, alignItems: 'center', padding: '8%', opacity }}>
      <div style={{ transform: `translateY(${(1 - enter) * 30}px)`, textAlign: 'center' }}>
        <div style={{
          fontFamily: FONT, fontWeight: 800, fontSize: size, color, lineHeight: 1.08,
          textShadow: shadow, letterSpacing: '-0.02em',
        }}>{text}</div>
        {subtitle && (
          <div style={{
            fontFamily: FONT, fontWeight: 600, fontSize: size * 0.42, color: accent,
            marginTop: size * 0.18, textShadow: shadow,
          }}>{subtitle}</div>
        )}
      </div>
    </AbsoluteFill>
  );
}

export function Subtitle({ text = 'Subtitle', color = '#ffffff', size = 46 }) {
  const { opacity } = useEnterExit();
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', paddingBottom: '12%', opacity }}>
      <div style={{
        fontFamily: FONT, fontWeight: 600, fontSize: size, color,
        background: 'rgba(0,0,0,0.55)', padding: '0.5em 0.9em', borderRadius: 14, textShadow: shadow,
      }}>{text}</div>
    </AbsoluteFill>
  );
}

export function LowerThird({ title = 'Name', subtitle = 'Role', accent = '#FFD400' }) {
  const { opacity, enter } = useEnterExit({ enterFrames: 16 });
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'flex-start', padding: '6%', opacity }}>
      <div style={{
        transform: `translateX(${(1 - enter) * -60}px)`,
        background: 'rgba(12,12,16,0.88)', borderLeft: `8px solid ${accent}`,
        padding: '22px 34px', borderRadius: '0 14px 14px 0', boxShadow: shadow,
      }}>
        <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: 52, color: '#fff' }}>{title}</div>
        <div style={{ fontFamily: FONT, fontWeight: 500, fontSize: 30, color: accent, marginTop: 6 }}>{subtitle}</div>
      </div>
    </AbsoluteFill>
  );
}

export function Callout({ text = 'Look here', color = '#FFD400', x = 0.5, y = 0.5, size = 40 }) {
  const { opacity, enter } = useEnterExit();
  return (
    <AbsoluteFill style={{ opacity }}>
      <div style={{
        position: 'absolute', left: `${x * 100}%`, top: `${y * 100}%`,
        transform: `translate(-50%,-50%) scale(${0.85 + enter * 0.15})`,
        background: color, color: '#111', fontFamily: FONT, fontWeight: 800, fontSize: size,
        padding: '0.4em 0.8em', borderRadius: 12, boxShadow: shadow, whiteSpace: 'nowrap',
      }}>{text}</div>
    </AbsoluteFill>
  );
}

export function Notification({ title = 'Notification', body = '', icon = '🔔', accent = '#4DA3FF' }) {
  const { opacity, enter } = useEnterExit({ enterFrames: 18 });
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-start', alignItems: 'flex-end', padding: '5%', opacity }}>
      <div style={{
        transform: `translateY(${(1 - enter) * -50}px)`,
        display: 'flex', gap: 18, alignItems: 'center', minWidth: 420,
        background: 'rgba(24,24,28,0.94)', border: `1px solid ${accent}55`,
        padding: '20px 26px', borderRadius: 18, boxShadow: shadow,
      }}>
        <div style={{ fontSize: 44 }}>{icon}</div>
        <div>
          <div style={{ fontFamily: FONT, fontWeight: 700, fontSize: 30, color: '#fff' }}>{title}</div>
          {body && <div style={{ fontFamily: FONT, fontSize: 24, color: '#b9b9c4', marginTop: 4 }}>{body}</div>}
        </div>
      </div>
    </AbsoluteFill>
  );
}

/* ------------------------------------------------------------- indicators */

export function ProgressBar({ progress = null, color = '#FFD400', height = 14, position = 'bottom' }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  // A progress bar should be mechanical, so this is linear, not a spring.
  const value = progress === null ? frame / Math.max(1, durationInFrames - 1) : progress;
  return (
    <AbsoluteFill style={{ justifyContent: position === 'top' ? 'flex-start' : 'flex-end' }}>
      <div style={{ width: '100%', height, background: 'rgba(255,255,255,0.16)' }}>
        <div style={{ width: `${Math.min(1, Math.max(0, value)) * 100}%`, height: '100%', background: color }} />
      </div>
    </AbsoluteFill>
  );
}

export function CircleHighlight({ x = 0.5, y = 0.5, radius = 0.14, color = '#FFD400', thickness = 8 }) {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const draw = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 20 });
  const { exit } = useEnterExit({ enterFrames: 1 });
  const r = radius * width;
  const circumference = 2 * Math.PI * r;
  return (
    <AbsoluteFill style={{ opacity: exit }}>
      <svg width="100%" height="100%" style={{ position: 'absolute' }}>
        <circle
          cx={`${x * 100}%`} cy={`${y * 100}%`} r={r}
          fill="none" stroke={color} strokeWidth={thickness} strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - draw)}
          transform={`rotate(-90 ${x * 100} ${y * 100})`}
          style={{ transformOrigin: `${x * 100}% ${y * 100}%` }}
        />
      </svg>
    </AbsoluteFill>
  );
}

export function Arrow({ fromX = 0.2, fromY = 0.5, toX = 0.7, toY = 0.5, color = '#FFD400', thickness = 8 }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const draw = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 18 });
  const { exit } = useEnterExit({ enterFrames: 1 });
  const endX = fromX + (toX - fromX) * draw;
  const endY = fromY + (toY - fromY) * draw;
  return (
    <AbsoluteFill style={{ opacity: exit }}>
      <svg width="100%" height="100%" style={{ position: 'absolute' }}>
        <defs>
          <marker id="head" orient="auto" markerWidth="4" markerHeight="4" refX="2" refY="2">
            <path d="M0,0 L4,2 L0,4 Z" fill={color} />
          </marker>
        </defs>
        <line
          x1={`${fromX * 100}%`} y1={`${fromY * 100}%`}
          x2={`${endX * 100}%`} y2={`${endY * 100}%`}
          stroke={color} strokeWidth={thickness} strokeLinecap="round"
          markerEnd={draw > 0.9 ? 'url(#head)' : undefined}
        />
      </svg>
    </AbsoluteFill>
  );
}

/* -------------------------------------------------- code and screen mocks */

/**
 * Minimal token colouring. A real highlighter (Shiki, Prism) would be better
 * and much heavier; this covers the keywords and strings that actually carry
 * meaning in a short clip.
 */
function highlight(line) {
  const parts = [];
  const re = /(\/\/.*$|#.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(const|let|var|function|return|if|else|for|while|import|from|export|async|await|class|new|try|catch|def|print|npm|npx|docker|git|sudo|cd|ls|echo)\b|\b(\d+(?:\.\d+)?)\b/g;
  let last = 0, m;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) parts.push({ t: line.slice(last, m.index), c: '#d6deeb' });
    if (m[1]) parts.push({ t: m[1], c: '#5f7e97' });
    else if (m[2]) parts.push({ t: m[2], c: '#ecc48d' });
    else if (m[3]) parts.push({ t: m[3], c: '#c792ea' });
    else if (m[4]) parts.push({ t: m[4], c: '#f78c6c' });
    last = re.lastIndex;
  }
  if (last < line.length) parts.push({ t: line.slice(last), c: '#d6deeb' });
  return parts;
}

function WindowChrome({ title, accent = '#2b2b35', children, width = '86%' }) {
  const { opacity, enter } = useEnterExit({ enterFrames: 16 });
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', opacity }}>
      <div style={{
        width, transform: `scale(${0.94 + enter * 0.06})`,
        background: '#0f1117', borderRadius: 16, overflow: 'hidden', boxShadow: shadow,
        border: '1px solid #22242e',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', background: accent,
        }}>
          {['#ff5f57', '#febc2e', '#28c840'].map(c => (
            <div key={c} style={{ width: 14, height: 14, borderRadius: '50%', background: c }} />
          ))}
          {title && (
            <div style={{
              fontFamily: MONO, fontSize: 22, color: '#9aa0b4', marginLeft: 14,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{title}</div>
          )}
        </div>
        {children}
      </div>
    </AbsoluteFill>
  );
}

export function CodeBlock({ code = 'const x = 1;', title = 'example.js', fontSize = 28, typing = false }) {
  const frame = useCurrentFrame();
  const lines = String(code).split('\n');
  // Typing reveals whole LINES, not characters: character-by-character reads as
  // a gimmick and is unreadable at short durations.
  const visible = typing ? Math.min(lines.length, Math.floor(frame / 6) + 1) : lines.length;

  return (
    <WindowChrome title={title}>
      <div style={{ padding: '26px 30px', fontFamily: MONO, fontSize, lineHeight: 1.55 }}>
        {lines.slice(0, visible).map((line, i) => (
          <div key={i} style={{ display: 'flex', gap: 18 }}>
            <span style={{ color: '#3c4257', minWidth: '2.2em', textAlign: 'right', userSelect: 'none' }}>{i + 1}</span>
            <span style={{ whiteSpace: 'pre' }}>
              {highlight(line).map((p, j) => <span key={j} style={{ color: p.c }}>{p.t}</span>)}
            </span>
          </div>
        ))}
      </div>
    </WindowChrome>
  );
}

export function Terminal({ lines = ['$ npm install'], title = 'bash', fontSize = 28, cursor = true }) {
  const frame = useCurrentFrame();
  const list = Array.isArray(lines) ? lines : String(lines).split('\n');
  const visible = Math.min(list.length, Math.floor(frame / 10) + 1);
  const blink = Math.floor(frame / 15) % 2 === 0;

  return (
    <WindowChrome title={title} accent="#1b1b22">
      <div style={{ padding: '26px 30px', fontFamily: MONO, fontSize, lineHeight: 1.6, minHeight: '3em' }}>
        {list.slice(0, visible).map((line, i) => {
          const isCommand = String(line).trimStart().startsWith('$');
          return (
            <div key={i} style={{ color: isCommand ? '#7ee787' : '#c9d1d9', whiteSpace: 'pre-wrap' }}>
              {line}
              {cursor && i === visible - 1 && blink && (
                <span style={{ background: '#7ee787', marginLeft: 4 }}>&nbsp;</span>
              )}
            </div>
          );
        })}
      </div>
    </WindowChrome>
  );
}

export function BrowserWindow({ url = 'https://example.com', children, image }) {
  const { opacity, enter } = useEnterExit({ enterFrames: 16 });
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', opacity }}>
      <div style={{
        width: '88%', transform: `scale(${0.94 + enter * 0.06})`,
        background: '#fff', borderRadius: 16, overflow: 'hidden', boxShadow: shadow,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px', background: '#e9ecf1' }}>
          {['#ff5f57', '#febc2e', '#28c840'].map(c => (
            <div key={c} style={{ width: 13, height: 13, borderRadius: '50%', background: c }} />
          ))}
          <div style={{
            flex: 1, marginLeft: 12, background: '#fff', borderRadius: 999, padding: '8px 18px',
            fontFamily: FONT, fontSize: 22, color: '#5a6272',
          }}>{url}</div>
        </div>
        <div style={{ minHeight: 220, background: '#fbfcfe' }}>
          {image ? <Img src={image} style={{ width: '100%', display: 'block' }} /> : children}
        </div>
      </div>
    </AbsoluteFill>
  );
}

export function PhoneFrame({ image, children, color = '#111318' }) {
  const { opacity, enter } = useEnterExit({ enterFrames: 18 });
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', opacity }}>
      <div style={{
        transform: `scale(${0.92 + enter * 0.08})`,
        width: '46%', aspectRatio: '9 / 19.5', background: color, borderRadius: 52,
        padding: 14, boxShadow: shadow,
      }}>
        <div style={{ width: '100%', height: '100%', background: '#000', borderRadius: 40, overflow: 'hidden', position: 'relative' }}>
          <div style={{
            position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)',
            width: '32%', height: 26, background: color, borderRadius: 999, zIndex: 2,
          }} />
          {image ? <Img src={image} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : children}
        </div>
      </div>
    </AbsoluteFill>
  );
}

export function TweetCard({ name = 'Name', handle = '@handle', text = 'Post text', avatar, likes = '1.2K' }) {
  const { opacity, enter } = useEnterExit({ enterFrames: 16 });
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', opacity }}>
      <div style={{
        width: '78%', transform: `scale(${0.94 + enter * 0.06})`,
        background: '#fff', borderRadius: 22, padding: '32px 36px', boxShadow: shadow,
      }}>
        <div style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
          <div style={{ width: 68, height: 68, borderRadius: '50%', overflow: 'hidden', background: '#dfe3ea', flexShrink: 0 }}>
            {avatar && <Img src={avatar} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
          </div>
          <div>
            <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: 32, color: '#0f1419' }}>{name}</div>
            <div style={{ fontFamily: FONT, fontSize: 26, color: '#536471' }}>{handle}</div>
          </div>
        </div>
        <div style={{ fontFamily: FONT, fontSize: 34, color: '#0f1419', marginTop: 22, lineHeight: 1.35 }}>{text}</div>
        <div style={{ fontFamily: FONT, fontSize: 24, color: '#536471', marginTop: 22 }}>♡ {likes}</div>
      </div>
    </AbsoluteFill>
  );
}

export function ImageCard({ image, caption, radius = 20 }) {
  const { opacity, enter } = useEnterExit({ enterFrames: 16 });
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', opacity }}>
      <div style={{ width: '76%', transform: `scale(${0.94 + enter * 0.06})`, boxShadow: shadow, borderRadius: radius, overflow: 'hidden', background: '#111' }}>
        {image && <Img src={image} style={{ width: '100%', display: 'block' }} />}
        {caption && (
          <div style={{ fontFamily: FONT, fontSize: 28, color: '#fff', padding: '18px 24px', background: 'rgba(0,0,0,0.75)' }}>
            {caption}
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
}

/** A before/after code diff — the one code visual ASS truly cannot fake. */
export function CodeDiff({ removed = [], added = [], title = 'diff', fontSize = 26 }) {
  const rows = [
    ...(Array.isArray(removed) ? removed : String(removed).split('\n')).map(t => ({ t, kind: '-' })),
    ...(Array.isArray(added) ? added : String(added).split('\n')).map(t => ({ t, kind: '+' })),
  ].filter(r => r.t !== '');
  const frame = useCurrentFrame();
  const visible = Math.min(rows.length, Math.floor(frame / 5) + 1);

  return (
    <WindowChrome title={title}>
      <div style={{ padding: '24px 0', fontFamily: MONO, fontSize, lineHeight: 1.6 }}>
        {rows.slice(0, visible).map((r, i) => (
          <div key={i} style={{
            padding: '2px 30px', whiteSpace: 'pre',
            background: r.kind === '+' ? 'rgba(63,185,80,0.16)' : 'rgba(248,81,73,0.16)',
            color: r.kind === '+' ? '#7ee787' : '#ffa198',
          }}>{r.kind} {r.t}</div>
        ))}
      </div>
    </WindowChrome>
  );
}

/** Everything the render tool can be asked for, by name. */
export const COMPONENTS = {
  Title, Subtitle, Caption: Subtitle, Callout, LowerThird, Notification,
  ProgressBar, CircleHighlight, Arrow,
  CodeBlock, Terminal, BrowserWindow, PhoneFrame, TweetCard, ImageCard, CodeDiff,
  BruteForceRaceCondition, DeckCaption, DeckHook, DeckClickBurst, PromptInjection,
  PiCam, PiOverlay,
};
