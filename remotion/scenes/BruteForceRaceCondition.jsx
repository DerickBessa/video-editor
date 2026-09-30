// Vinheta: Brute Force -> Race Condition (analogia do restaurante).
// See docs/vinheta-race-condition-roteiro.md for the shot-by-shot script this implements.
//
// v3 — polish pass: choreography, continuity, depth, easing vocabulary, secondary motion,
// motion blur, fps-agnostic timing.
//
// TIMING IS AUTHORED IN SECONDS, NEVER IN FRAMES. Every scene length and every internal beat
// is a number of seconds, converted through `useVideoConfig().fps` at read time. That is what
// lets the same source render correctly at 30fps (fast drafts) and 60fps (delivery, matching
// the 60fps source footage) without any timing drifting or doubling.
import React, { useEffect, useState } from 'react';
import {
  AbsoluteFill, Series, useCurrentFrame, useVideoConfig, interpolate, spring, random,
  Easing, delayRender, continueRender,
} from 'remotion';
import {
  Lock, User, ChefHat, Sandwich, Ticket, TicketCheck, CreditCard, Eye, Zap,
  Check, X, Clock, MessageCircle, Skull, Receipt, Server,
} from 'lucide-react';

const FONT = '"Segoe UI", Inter, system-ui, -apple-system, sans-serif';
const MONO = '"Cascadia Code", "JetBrains Mono", Consolas, "Courier New", monospace';
const ACCENT = '#FFD400';      // house yellow — request/track A
const TRACK_B = '#4DD8FF';     // cyan, used ONLY to separate concurrent track B
const WHITE = '#ffffff';
const GREEN = '#4dff88';
const RED = '#ff4d6d';

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' };

// 9:16 safe area. Hero type is sized so that its widest line fits inside 1080 - 2*SAFE_X even
// after the master camera's largest zoom on that scene. Overflow is allowed ONLY where a camera
// move motivates it (pushing into the vault display, the title collision) and always resolves.
const SAFE_X = 60;

// ---------------------------------------------------------------------------------------------
// TIMING LOCKED TO THE NARRATION.
//
// Source: `temp/narr2-tight.mp3` (57.2s), the recorded take with its breathing pauses tightened
// and the joke pause re-inserted — see `scripts/retime-narration.mjs`. Every scene boundary below
// is an actual word onset in that file, so the animation cuts ON what is being said. Do not
// "round" these numbers; they are measurements, not preferences.
//
//   0.00  "O brute force, na analogia simples..."      -> vault
//   4.80  "senha de quatro dígitos"                    -> PIN aparece
//   6.04  "cada dígito vai de zero a nove"             -> dígitos giram
//   8.42  "dez mil combinações"                        -> hero 10.000
//  10.04  "na mão, tu vai demorar"                     -> manual
//  13.66  "agora bota um loop"                         -> loop
//  16.90  (stop, 2 frames antes do "Tcharam" em 16.96) -> crack / 5837
//  19.10  "agora imagina isso"                         -> morph (cápsula se forma)
//  20.12  "no restaurante"                             -> request dispara
//  21.32  "o mesmo garçom sendo chamado"               -> spam
//  22.56  "mil vezes"                                  -> pico do caos
//  27.11  fim de "...te dá um tiro"                    -> FREEZE + caveira
//  27.63  "tô brincando"                               -> caos desmonta
//  28.57  "race condition é o seguinte"                -> título
//  29.82  "só sobrou um hambúrguer"                    -> estoque = 1
//  31.34  "eu pergunto"                                -> race (A)
//  32.10  "tem hambúrguer?"                            -> A dispara
//  32.98  "ele responde que tem"                       -> A lê 1
//  36.82  "outra pessoa pergunta a mesma coisa"        -> B entra
//  38.92  "o sistema olha de novo"                     -> B chega no estoque
//  41.38  "o sistema fala, tem"                        -> A e B com READ=1 juntos
//  42.96  "pronto"                                     -> bug
//  43.54  "dois pedidos aceitos"                       -> CREATE ORDER A/B
//  44.94  "mas só tinha um hambúrguer"                 -> 1x1 / 2x2
//  46.62  "isso é race condition"                      -> impacto + timeline
//  48.70  "leram o mesmo estado"                       -> barras READ + overlap
//  51.22  "antes de que uma delas pudesse alterá-lo"   -> barras WRITE / conflito
//  52.84  "agora imagina isso com o estoque..."        -> generalização
//  57.22  fim da narração                              -> pressão na API (só visual)
//  59.00  fim                                          -> corta pra câmera
// ---------------------------------------------------------------------------------------------

/** Scene lengths in SECONDS, derived from the anchors above (each = next anchor - this one). */
export const SCENE_SECONDS = {
  vault: 10.04,      // cofre -> push into display -> digits spin -> combos explode -> 10.000
  manual: 3.62,      // tentativa na mão, propositalmente lenta
  loop: 3.24,        // terminal + contador acelerando até virar textura
  crack: 2.20,       // 5837 hero freeze, landing no "Tcharam"
  morph: 1.30,       // 5837 SE TRANSFORMA em REQUEST #5837 e atravessa a câmera
  restaurant: 8.173, // escalada de caos + freeze da piada + "tô brincando"
  title: 1.247,      // RACE / CONDITION colidem
  stock: 1.52,       // só sobrou 1
  race: 11.62,       // A e B — o vai-e-vem completo, o ápice
  bug: 3.66,         // dois pedidos, 1 != 2
  timeline: 6.22,    // impacto + READ/WRITE desenhados progressivamente
  generalize: 4.38,  // morph contínuo, o bug permanece
  api: 1.78,         // pressão na API -> cut, sem revelar rate limit
};
export const TOTAL_SECONDS = Object.values(SCENE_SECONDS).reduce((a, b) => a + b, 0); // 59.00

const ORDER = Object.keys(SCENE_SECONDS);
/** Absolute start time (seconds) of each scene — used by the camera rig. */
export const STARTS = (() => {
  const out = {};
  let acc = 0;
  for (const k of ORDER) { out[k] = acc; acc += SCENE_SECONDS[k]; }
  return out;
})();

/* --------------------------------------------------------------- time base */

/** Local scene time in seconds, plus fps. Everything downstream works in seconds. */
function useT() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return { t: frame / fps, fps, frame };
}

/* ------------------------------------------------------- easing vocabulary */
//
// Deliberately NOT one spring for everything — a single preset is what makes motion read as
// "React component transitioned" rather than as objects with different mass. Each family below
// is used for one kind of thing, so a hero word and a heavy panel do not move alike.

/** HERO text/number: snaps in fast, brief overshoot, firm settle. */
function easeHero(t, fps, delay = 0) {
  return spring({ frame: (t - delay) * fps, fps, config: { damping: 13, mass: 0.5, stiffness: 220 } });
}
/** UI chrome: clean ease-out, essentially no overshoot. */
function easeUI(t, from, to) {
  return interpolate(t, [from, to], [0, 1], { ...CLAMP, easing: Easing.out(Easing.cubic) });
}
/** HEAVY object: visible inertia, slower to settle. */
function easeHeavy(t, fps, delay = 0) {
  return spring({ frame: (t - delay) * fps, fps, config: { damping: 24, mass: 1.7, stiffness: 85 } });
}
/** REQUEST/projectile: builds speed, then rips. */
function easeRequest(t, from, to) {
  return interpolate(t, [from, to], [0, 1], { ...CLAMP, easing: Easing.bezier(0.55, 0, 0.85, 0.35) });
}
/** MICRO element: simple, low-attention. */
function easeMicro(t, from, to) {
  return interpolate(t, [from, to], [0, 1], { ...CLAMP, easing: Easing.out(Easing.quad) });
}

/** Secondary motion: a decaying oscillation AFTER the main move lands, so things carry
 *  inertia instead of stopping dead on the last frame of their spring. */
function settleWobble(t, at, { amp = 5, freq = 7, decay = 0.32 } = {}) {
  const dt = t - at;
  if (dt < 0) return 0;
  return Math.sin(dt * freq * Math.PI * 2) * amp * Math.exp(-dt / decay);
}

/** Impact shake — only ever on a hit, never ambient. */
function impactShake(t, at, { amp = 9, dur = 0.22 } = {}) {
  const dt = t - at;
  if (dt < 0 || dt > dur) return 0;
  return Math.sin(dt * 60) * amp * (1 - dt / dur);
}

/** Fade window expressed in seconds. The stops are forced strictly increasing before they reach
 *  `interpolate`, which throws on a non-monotonic range — with beat times derived from scene
 *  length and seeded birth times, two stops can legitimately collide, and a hard crash mid-render
 *  is a much worse outcome than a zero-length fade. */
function fadeWin(t, stops) {
  const EPS = 1e-4;
  const r = [stops[0]];
  for (let i = 1; i < 4; i++) r.push(Math.max(stops[i], r[i - 1] + EPS));
  return interpolate(t, r, [0, 1, 1, 0], CLAMP);
}

/* ------------------------------------------------------------- primitives */

/** Hero word/number. Sized to actually own the frame (see `size` call sites: these are the
 *  60-85%-of-width moments), with anticipation -> action -> overshoot -> settle. */
function HeroText({ text, sub, size = 200, color = WHITE, accent = ACCENT, hitAt = null, style = {} }) {
  const { t, fps } = useT();
  const p = easeHero(t, fps);
  // Anticipation: a hair of counter-scale before it slams in.
  const antic = interpolate(t, [0, 0.06], [0.94, 1], CLAMP);
  const shake = hitAt != null ? impactShake(t, hitAt) : 0;
  const wob = settleWobble(t, 0.28, { amp: 2.5, freq: 6 });
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', ...style }}>
      <div style={{
        transform: `scale(${(0.72 + 0.28 * p) * antic}) translate(${shake}px, ${wob}px)`,
        textAlign: 'center',
      }}>
        <div style={{
          fontFamily: FONT, fontWeight: 900, fontSize: size, color, letterSpacing: '-0.03em',
          lineHeight: 0.96, textShadow: '0 12px 60px rgba(0,0,0,0.65)',
        }}>{text}</div>
        {sub && (
          <div style={{
            fontFamily: FONT, fontWeight: 800, fontSize: size * 0.2, color: accent,
            marginTop: size * 0.06, letterSpacing: '0.06em',
          }}>{sub}</div>
        )}
      </div>
    </AbsoluteFill>
  );
}

/** One PIN slot. Digits roll while `spinning`; the roll speed itself ramps, so the reel reads
 *  as accelerating rather than as a constant flicker. */
function PinBoxes({ spinning, spinStart = 0, size = 1 }) {
  const { t } = useT();
  const speed = interpolate(t, [spinStart, spinStart + 1.6], [6, 34], CLAMP);
  const phase = Math.floor(t * speed);
  return (
    <div style={{ display: 'flex', gap: 18 * size }}>
      {[0, 1, 2, 3].map(i => {
        const shown = spinning ? Math.floor(random(`pin-${i}-${phase}`) * 10) : 0;
        return (
          <div key={i} style={{
            width: 112 * size, height: 140 * size, borderRadius: 14 * size, background: '#0c0c0c',
            border: `${4 * size}px solid ${ACCENT}`, display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontFamily: MONO, fontWeight: 800,
            fontSize: 74 * size, color: WHITE,
          }}>{shown}</div>
        );
      })}
    </div>
  );
}

/** One parallax plane of drifting combination numbers. `depth` drives size, opacity, blur and
 *  how much the camera push displaces it — that spread is what sells 2D layers as space. */
function ComboPlane({ count, seed, depth, t, appearAt, camPush }) {
  // depth: 0 = far background, 1 = foreground rushing past the lens.
  const size = interpolate(depth, [0, 1], [17, 62]);
  const baseOpacity = interpolate(depth, [0, 1], [0.22, 0.55]);
  const blur = interpolate(depth, [0, 1], [0.4, 3.2]);
  const parallax = interpolate(depth, [0, 1], [0.25, 2.4]);
  const speed = interpolate(depth, [0, 1], [0.06, 0.42]);

  return (
    <AbsoluteFill style={{ filter: `blur(${blur}px)` }}>
      {Array.from({ length: count }).map((_, i) => {
        const s = `${seed}-${i}`;
        const born = appearAt + random(s + 'b') * 1.5;
        const life = 1.6 + random(s + 'l') * 1.4;
        const op = fadeWin(t, [born, born + 0.18, born + life - 0.3, born + life]) * baseOpacity;
        if (op <= 0.004) return null;
        const dir = random(s + 'd') > 0.5 ? 1 : -1;
        const x = 6 + random(s + 'x') * 88 + dir * (t - born) * speed * 100;
        const y = 4 + random(s + 'y') * 92;
        const val = Math.floor(random(s + 'v' + Math.floor(t * 9)) * 10000).toString().padStart(4, '0');
        return (
          <div key={i} style={{
            position: 'absolute', left: `${x}%`, top: `${y}%`, opacity: op,
            transform: `translate(-50%,-50%) translateY(${camPush * parallax * -34}px)`,
            fontFamily: MONO, color: ACCENT, fontSize: size, fontWeight: 700, whiteSpace: 'nowrap',
          }}>{val}</div>
        );
      })}
    </AbsoluteFill>
  );
}

/** Icon + label + big value. Used for estoque/cupom/saldo/ingresso. */
function StatPanel({ icon: Icon, label, value, badge, valueColor = WHITE, iconSize = 150, valueSize = 150 }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <Icon size={iconSize} color={WHITE} strokeWidth={1.2} />
      <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: 40, color: ACCENT, marginTop: 10, letterSpacing: '0.1em' }}>{label}</div>
      <div style={{ fontFamily: FONT, fontWeight: 900, fontSize: valueSize, color: valueColor, lineHeight: 1 }}>{value}</div>
      {badge && (
        <div style={{
          marginTop: 16, background: ACCENT, color: '#111', fontFamily: FONT, fontWeight: 800,
          fontSize: 30, padding: '8px 22px', borderRadius: 999, display: 'flex', alignItems: 'center', gap: 8,
        }}>{badge}</div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- 1. cofre */
//
// One continuous move: push into the display, digits spin, combos escape the display and
// stream past the lens, camera pulls back to find the field already full, and 10.000 lands as
// the consequence of that field — not as a new slide.

function SceneVault() {
  const { t, fps } = useT();
  const D = SCENE_SECONDS.vault;

  // Beats locked to the narration: 4.80 "senha de quatro dígitos", 6.04 "de zero a nove",
  // 8.42 "dez mil combinações".
  const PIN_AT = 4.80, SPIN_AT = 6.04, HERO_AT = 8.42;

  const enter = easeHeavy(t, fps);                       // heavy object: the vault has mass
  const rot = interpolate(t, [0, 0.8], [-7, 0], { ...CLAMP, easing: Easing.out(Easing.cubic) });
  const landWob = settleWobble(t, 0.62, { amp: 6, freq: 5.5, decay: 0.4 });

  // Camera pushes in as he names the digits, holds through the spin, then pulls back so the
  // combination field is already full by the time "dez mil" lands.
  const camPush = interpolate(t, [PIN_AT - 1.0, PIN_AT + 0.4, SPIN_AT + 1.5, HERO_AT - 0.5],
    [0, 1, 1, 0.05], { ...CLAMP, easing: Easing.inOut(Easing.cubic) });
  // Overflow here is motivated (the camera is pushing INTO the display) and it pulls back out,
  // but 2.5 threw the outer PIN slots well past the edge for longer than read as deliberate.
  const camZoom = interpolate(camPush, [0, 1], [1, 2.05]);

  const showPin = t > PIN_AT - 0.5;
  const spinning = t > SPIN_AT && t < HERO_AT - 0.7;
  const vaultOpacity = fadeWin(t, [0, 0.25, HERO_AT - 0.5, HERO_AT - 0.12]);
  const heroOpacity = fadeWin(t, [HERO_AT - 0.14, HERO_AT + 0.02, D - 0.3, D - 0.02]);
  const heroIn = t >= HERO_AT - 0.14;

  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
      {/* BACKGROUND plane — slow, small, dim */}
      <ComboPlane count={16} seed="bg" depth={0} t={t} appearAt={SPIN_AT + 0.15} camPush={camPush} />

      {/* MIDGROUND — the vault itself */}
      <div style={{
        opacity: vaultOpacity,
        transform: `scale(${(0.68 + 0.32 * enter) * camZoom}) rotate(${rot}deg) translateY(${landWob}px)`,
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 34,
      }}>
        <Lock size={168} color={WHITE} strokeWidth={1.25} />
        {showPin && <PinBoxes spinning={spinning} spinStart={2.2} />}
      </div>

      {/* FOREGROUND — big blurred combos rushing past the lens */}
      <ComboPlane count={10} seed="fg" depth={1} t={t} appearAt={SPIN_AT + 1.05} camPush={camPush} />
      <ComboPlane count={22} seed="mid" depth={0.45} t={t} appearAt={SPIN_AT + 0.55} camPush={camPush} />

      {heroIn && (
        <div style={{ position: 'absolute', inset: 0, opacity: heroOpacity }}>
          {/* 10.000 owns the frame while still landing inside the safe area: at 290 it measured
              ~1107px against a 960px budget once the master camera zoom was applied. */}
          <HeroText text="10.000" sub="COMBINAÇÕES" size={242} hitAt={0.02} style={{ position: 'absolute' }} />
        </div>
      )}
    </AbsoluteFill>
  );
}

/* ------------------------------------------------- 2. tentativa na mão */

function SceneManual() {
  const { t } = useT();
  const D = SCENE_SECONDS.manual;
  // Four tries spread across the line "na mão, tu vai demorar pra caralho pra poder fazer isso".
  // The slowness IS the joke, so the tries stay sparse instead of filling the time.
  const STEP = D / 4.4;
  const step = Math.min(3, Math.floor(t / STEP));
  const clockSpin = t * 150;
  // Deliberate dead-stop before the loop: everything drains in the last ~0.3s.
  const out = fadeWin(t, [0, 0.16, D - 0.34, D - 0.12]);
  const stepPop = easeMicro(t - step * STEP, 0, 0.1);

  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', opacity: out }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 26 }}>
        <Clock size={74} color={WHITE} strokeWidth={1.4} style={{ transform: `rotate(${clockSpin}deg)` }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 20, transform: `scale(${0.94 + 0.06 * stepPop})` }}>
          <div style={{ fontFamily: MONO, color: WHITE, fontSize: 92, fontWeight: 800 }}>
            {String(step).padStart(4, '0')}
          </div>
          <X size={64} color={RED} strokeWidth={2.4} />
        </div>
        <div style={{ fontFamily: MONO, color: ACCENT, fontSize: 34 }}>{step + 1} / 10.000</div>
      </div>
    </AbsoluteFill>
  );
}

/* ------------------------------------------------------ 3. loop / terminal */
//
// Hierarchy fix: the code is CONTEXT (dimmed, small, only the two meaningful tokens lit), the
// counter is the PROTAGONIST (large, centre-stage). The code block is deliberately cropped by
// the frame edge as part of the camera language, not accidentally overflowing.

function SceneLoop() {
  const { t } = useT();
  const D = SCENE_SECONDS.loop;
  const cut = easeUI(t, 0, 0.18);                       // hard cut in
  const punch = interpolate(t, [0, 0.3], [1.18, 1], { ...CLAMP, easing: Easing.out(Easing.cubic) });
  const out = fadeWin(t, [0, 0.1, D - 0.18, D - 0.02]);

  // Counter accelerates: sparse discrete tries -> a blurred texture.
  const rate = interpolate(t, [0.3, D - 0.3], [7, 90], { ...CLAMP, easing: Easing.in(Easing.quad) });
  const phase = Math.floor(t * rate);
  const val = Math.floor(random(`try-${phase}`) * 10000).toString().padStart(4, '0');
  const blur = interpolate(t, [0.6, D - 0.4], [0, 5], CLAMP);
  const streak = interpolate(t, [1.2, D - 0.3], [0, 1], CLAMP);

  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', opacity: out * cut }}>
      <div style={{ transform: `scale(${punch})`, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 46 }}>
        {/* Context, not protagonist: dimmed, fully contained, only the two meaningful tokens
            lit. It must FIT — clipping it mid-token read as a broken layout, not as a
            close-up, because there was no camera move motivating the crop. */}
        <div style={{
          fontFamily: MONO, fontSize: 27, background: '#0b0b0b', border: '2px solid rgba(255,212,0,0.28)',
          borderRadius: 14, padding: '20px 26px', whiteSpace: 'pre', lineHeight: 1.5,
          color: 'rgba(255,255,255,0.34)',
        }}>
          {'for '}<span style={{ color: ACCENT }}>{'(pin = 0; pin <= 9999; pin++)'}</span>{' {\n  '}
          <span style={{ color: WHITE, fontWeight: 700 }}>tryPassword(pin)</span>{'\n}'}
        </div>

        {/* Protagonist: the counter. */}
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 22 }}>
          {/* Speed streaks behind the number — cheap directional-blur illusion. */}
          {streak > 0.02 && Array.from({ length: 5 }).map((_, i) => (
            <div key={i} style={{
              position: 'absolute', left: -30 - i * 26, top: '50%', width: 90 + i * 40, height: 5,
              background: ACCENT, opacity: streak * (0.22 - i * 0.035), transform: 'translateY(-50%)',
            }} />
          ))}
          <div style={{
            fontFamily: MONO, fontWeight: 800, fontSize: 132, color: WHITE, filter: `blur(${blur}px)`,
          }}>{val}</div>
          <X size={64} color={RED} strokeWidth={2.4} style={{ opacity: interpolate(t, [0, 1.4], [1, 0.25], CLAMP) }} />
        </div>
      </div>
    </AbsoluteFill>
  );
}

/* ---------------------------------------------------------- 4. 5837 hero */

function SceneCrack() {
  const { t, fps } = useT();
  const D = SCENE_SECONDS.crack;
  const p = easeHero(t, fps);
  const shake = impactShake(t, 0.02, { amp: 14, dur: 0.26 });
  const wob = settleWobble(t, 0.3, { amp: 3, freq: 6 });
  const out = fadeWin(t, [0, 0.06, D - 0.2, D - 0.02]);

  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', opacity: out }}>
      <Particles atSec={0.05} count={30} />
      <div style={{
        transform: `scale(${0.8 + 0.2 * p}) translate(${shake}px, ${wob}px)`,
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 26 }}>
          <div style={{ fontFamily: MONO, fontWeight: 900, fontSize: 250, color: GREEN, lineHeight: 1 }}>5837</div>
          <Check size={112} color={GREEN} strokeWidth={2.8} />
        </div>
        {/* Lands on the spoken "Tcharam", which is 0.06s after this scene starts — the number
            reveal deliberately beats the word by a couple of frames. */}
        <div style={{
          fontFamily: FONT, fontWeight: 800, fontSize: 46, color: ACCENT, letterSpacing: '0.1em',
          opacity: fadeWin(t, [0.06, 0.20, D - 0.25, D - 0.05]),
        }}>TA-DAAA</div>
      </div>
    </AbsoluteFill>
  );
}

function Particles({ atSec, count = 24, color = ACCENT, spread = 1.0 }) {
  const { t } = useT();
  const dt = t - atSec;
  if (dt < 0 || dt > spread) return null;
  const p = dt / spread;
  const eased = Easing.out(Easing.cubic)(p);
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {Array.from({ length: count }).map((_, i) => {
        const a = (i / count) * Math.PI * 2 + random(`pa-${i}`) * 0.4;
        const d = eased * (200 + random(`pd-${i}`) * 260);
        return (
          <div key={i} style={{
            position: 'absolute', left: '50%', top: '50%',
            transform: `translate(-50%,-50%) translate(${Math.cos(a) * d}px, ${Math.sin(a) * d}px)`,
            width: 12, height: 12, borderRadius: '50%', background: color, opacity: (1 - p) * 0.9,
          }} />
        );
      })}
    </AbsoluteFill>
  );
}

/* ------------------------------------- 5. 5837 -> REQUEST #5837 -> câmera */
//
// The signature transition. The number does not cut to the request — it BECOMES it: the check
// mark drops away, a capsule draws itself around the digits, "REQUEST #" slides in, the whole
// pill loads backwards (anticipation) and then rips past the lens with motion blur.

function SceneMorph() {
  const { t, fps } = useT();
  const D = SCENE_SECONDS.morph;

  const checkOut = interpolate(t, [0, 0.18], [1, 0], { ...CLAMP, easing: Easing.in(Easing.quad) });
  const capsule = easeUI(t, 0.1, 0.42);                 // outline draws itself
  const label = easeUI(t, 0.3, 0.58);                   // "REQUEST #" slides in
  // The pill fires exactly on the word "restaurante" (1.02s into this scene), so the whip that
  // carries us into the restaurant is caused by the word, not merely near it.
  const FIRE_AT = 1.02;
  const load = interpolate(t, [FIRE_AT - 0.34, FIRE_AT], [0, -80], { ...CLAMP, easing: Easing.out(Easing.cubic) });
  const fire = easeRequest(t, FIRE_AT, D - 0.02);       // then rips

  // The flight is short and the pill FADES OUT while it is still whole. Travelling the full
  // width meant the last thing on screen was the pill's left edge — a lone "R" hanging at the
  // frame border for several frames, which read as a broken component rather than as speed.
  const travel = load + fire * 780;
  const zScale = interpolate(fire, [0, 0.5, 1], [1, 1.35, 1.5]);    // stretches toward the lens
  const stretch = interpolate(fire, [0, 0.35, 1], [1, 1.18, 1.3]);  // slight horizontal smear
  const flyOpacity = interpolate(fire, [0, 0.3, 0.62], [1, 0.95, 0], CLAMP);
  const speed = interpolate(t, [FIRE_AT, FIRE_AT + 0.13], [0, 1], CLAMP);

  const pill = (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14,
      border: `4px solid ${ACCENT}`, borderRadius: 999, background: 'rgba(10,10,10,0.92)',
      padding: '20px 40px', whiteSpace: 'nowrap',
      clipPath: `inset(0 ${(1 - capsule) * 100}% 0 0 round 999px)`,
    }}>
      <span style={{
        fontFamily: MONO, fontWeight: 800, fontSize: 62, color: ACCENT,
        opacity: label, transform: `translateX(${(1 - label) * -40}px)`,
      }}>REQUEST #</span>
      <span style={{ fontFamily: MONO, fontWeight: 900, fontSize: 62, color: WHITE }}>5837</span>
    </div>
  );

  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', overflow: 'visible' }}>
      <Check size={112} color={GREEN} strokeWidth={2.8}
        style={{ position: 'absolute', opacity: checkOut, transform: `translateX(150px) scale(${checkOut})` }} />

      {/* Directional smear, hand-rolled. `<Trail>` from @remotion/motion-blur re-renders its
          children against lagged frames, which re-ran the capsule's reveal clipPath from near
          zero — the pill collapsed to a tiny rounded badge showing only the "R". These copies
          share one already-computed style object, so every layer is the same fully-drawn pill,
          just offset and dimmed. */}
      <div style={{
        transform: `translateX(${travel}px) scale(${zScale}) scaleX(${stretch})`,
        opacity: flyOpacity,
      }}>
        {speed > 0.05 && (
          <div style={{ position: 'absolute', inset: 0 }}>
            {[1, 2, 3].map(i => (
              <div key={i} style={{
                position: 'absolute', inset: 0,
                transform: `translateX(${-i * 26 * speed}px)`,
                opacity: 0.34 / i,
                filter: `blur(${i * 1.4}px)`,
              }}>{pill}</div>
            ))}
          </div>
        )}
        {pill}
      </div>

      {/* The streak carries the eye out of frame and INTO the next scene — it outlives the pill
          on purpose, so the exit is a line of speed rather than a fragment of a component. */}
      <div style={{
        position: 'absolute', top: '50%', left: 0, height: 4,
        width: `${interpolate(fire, [0, 1], [0, 130])}%`,
        background: `linear-gradient(90deg, transparent, ${ACCENT})`,
        opacity: interpolate(fire, [0, 0.25, 0.9, 1], [0, 0.85, 0.85, 0], CLAMP),
      }} />
    </AbsoluteFill>
  );
}

/* --------------------------------------------------------- 6. restaurante */
//
// Chaos escalates in stages (x1 -> x1000) with bubbles living on three depth planes; the camera
// pushes in as pressure builds; at the "38" line EVERYTHING freezes; then it all falls away.

// Scene starts at 20.40 of the narration. Beats, in scene-local seconds:
//   0.92 "o mesmo garçom sendo chamado"   2.16 "mil vezes"
//   6.71 fim de "...te dá um tiro"        7.23 "tô brincando"
// The escalation is pulled forward so the x1000 peak lands ON "mil vezes", and then the chaos
// holds — the hold is what makes the freeze land, and he keeps talking over it.
const CHAOS_STAGES = [
  { at: 0.0, label: 'x1' }, { at: 0.92, label: 'x10' }, { at: 1.35, label: 'x100' },
  { at: 1.72, label: 'x300' }, { at: 2.16, label: 'x1000' },
];
const CHAOS_PEAK = 2.16;  // "mil vezes"
const FREEZE_AT = 6.71;   // "...dar um ti—" — everything stops
const JOKE_AT = 7.23;     // "tô brincando" — everything drops

function SceneRestaurant() {
  const { t: rawT, fps } = useT();
  const D = SCENE_SECONDS.restaurant;
  // Hard freeze: clamp the clock so every animated value stops dead, not just the visuals.
  const t = rawT < FREEZE_AT ? rawT : (rawT < JOKE_AT ? FREEZE_AT : rawT);

  const stage = CHAOS_STAGES.filter(s => t >= s.at).pop() || CHAOS_STAGES[0];
  const intensity = interpolate(t, [0.4, CHAOS_PEAK + 0.3], [0, 1], CLAMP);
  const camZoom = interpolate(t, [0.4, FREEZE_AT], [1, 1.34], { ...CLAMP, easing: Easing.in(Easing.quad) });
  const punch = rawT >= CHAOS_PEAK && rawT < CHAOS_PEAK + 0.5
    ? interpolate(rawT, [CHAOS_PEAK, CHAOS_PEAK + 0.16], [1.1, 1], CLAMP) : 1;
  const waiterShake = intensity > 0.35 ? Math.sin(t * 34) * intensity * 13 : 0;
  const barPulse = intensity > 0.7 ? 1 + Math.sin(t * 16) * 0.05 : 1;
  const barW = interpolate(t, [0.4, CHAOS_PEAK + 0.3], [3, 100], CLAMP);

  const drop = rawT >= JOKE_AT ? easeUI(rawT, JOKE_AT, JOKE_AT + 0.5) : 0;
  const chaosOpacity = (1 - drop) * fadeWin(rawT, [0, 0.12, D - 0.02, D - 0.01]);

  // The skull owns the frame outright: everything behind it is blurred and darkened so nothing
  // competes for attention during the beat.
  const SKULL_IN = FREEZE_AT + 0.08;
  const skullPhase = fadeWin(rawT, [SKULL_IN, SKULL_IN + 0.14, JOKE_AT - 0.08, JOKE_AT]);
  const bgBlur = skullPhase * 16;
  const bgDim = skullPhase * 0.82;
  const skullPop = easeHero(rawT, fps, SKULL_IN);
  const skullHit = impactShake(rawT, SKULL_IN + 0.02, { amp: 12, dur: 0.24 });
  const skullWob = settleWobble(rawT, SKULL_IN + 0.3, { amp: 4, freq: 6 });
  const stageIdx = CHAOS_STAGES.indexOf(stage);
  const stagePop = easeHero(t, fps, stage.at);

  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
      {/* Everything that can be upstaged by the skull lives inside this blur/dim group. */}
      <AbsoluteFill style={{ filter: bgBlur > 0.05 ? `blur(${bgBlur}px)` : undefined }}>
      {/* Bubbles on three planes: far/dim, normal, and huge ones crossing the lens. */}
      <ChaosBubbles t={t} intensity={intensity} opacity={chaosOpacity} drop={drop} />

      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div style={{
        opacity: chaosOpacity,
        transform: `scale(${camZoom * punch}) translateY(${drop * 420}px)`,
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 40,
      }}>
        <div style={{ display: 'flex', gap: 84, alignItems: 'center' }}>
          <User size={100} color={WHITE} strokeWidth={1.25} />
          <div style={{ fontFamily: FONT, fontWeight: 900, color: WHITE, fontSize: 52 }}>GARÇOM!</div>
          <ChefHat size={100} color={WHITE} strokeWidth={1.25}
            style={{ transform: `translate(${waiterShake}px, ${waiterShake * 0.4}px)` }} />
        </div>

        <div key={stageIdx} style={{
          fontFamily: MONO, color: ACCENT, fontWeight: 900, fontSize: 76,
          transform: `scale(${0.8 + 0.2 * stagePop})`,
        }}>{stage.label}</div>

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
          <div style={{ fontFamily: MONO, color: 'rgba(255,255,255,0.75)', fontSize: 26, letterSpacing: '0.16em' }}>REQUESTS</div>
          <div style={{
            width: 460, height: 24, background: 'rgba(255,255,255,0.1)', borderRadius: 12,
            overflow: 'hidden', transform: `scaleY(${barPulse})`,
          }}>
            <div style={{ width: `${barW}%`, height: '100%', background: ACCENT }} />
          </div>
        </div>
      </div>
      </AbsoluteFill>
      </AbsoluteFill>

      {/* Dark scrim over the blurred chaos — the skull's stage. */}
      {bgDim > 0.01 && (
        <AbsoluteFill style={{ background: `rgba(0,0,0,${bgDim})`, zIndex: 40 }} />
      )}

      {/* The joke: freeze, a beat of nothing, then the reveal. No weapon, no violence — the
          skull IS the punchline, so it sits above every other layer and nothing shares the
          frame with it. */}
      {skullPhase > 0.01 && (
        <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
          <div style={{
            opacity: skullPhase,
            transform: `scale(${0.55 + 0.45 * skullPop}) translate(${skullHit}px, ${skullWob}px)`,
            filter: `drop-shadow(0 0 70px rgba(255,45,80,0.75)) drop-shadow(0 22px 60px rgba(0,0,0,0.9))`,
          }}>
            <Skull size={620} color="#ff2d50" strokeWidth={1.15} />
          </div>
        </AbsoluteFill>
      )}

      {rawT >= JOKE_AT && (
        <div style={{
          position: 'absolute', fontFamily: FONT, color: WHITE, fontWeight: 800, fontSize: 52,
          zIndex: 60,
          opacity: fadeWin(rawT, [JOKE_AT, JOKE_AT + 0.12, D - 0.35, D - 0.1]),
          transform: `scale(${0.9 + 0.1 * easeUI(rawT, JOKE_AT, JOKE_AT + 0.2)})`,
        }}>tô brincando</div>
      )}
    </AbsoluteFill>
  );
}

/** Deterministic bubble field across three depth planes. ~46 nodes stand in for a thousand
 *  calls — perceived density, not literal count. */
function ChaosBubbles({ t, intensity, opacity, drop }) {
  const planes = [
    { n: 20, depth: 0.15, key: 'far' },
    { n: 18, depth: 0.55, key: 'mid' },
    { n: 8, depth: 1.0, key: 'near' },
  ];
  return (
    <AbsoluteFill style={{ opacity }}>
      {planes.map(pl => {
        const size = interpolate(pl.depth, [0, 1], [20, 108]);
        const blur = interpolate(pl.depth, [0, 1], [0, 3.4]);
        const op = interpolate(pl.depth, [0, 1], [0.35, 0.85]);
        const drift = interpolate(pl.depth, [0, 1], [10, 150]);
        return (
          <AbsoluteFill key={pl.key} style={{ filter: `blur(${blur}px)` }}>
            {Array.from({ length: pl.n }).map((_, i) => {
              const s = `${pl.key}-${i}`;
              // Each bubble has a fixed birth time — never a threshold flip, so no 1-frame pops.
              const born = 0.4 + random(s + 'b') * (CHAOS_PEAK + 0.2);
              if (t < born) return null;
              const gate = intensity >= random(s + 'g') * 0.85 ? 1 : 0;
              if (!gate) return null;
              const o = fadeWin(t, [born, born + 0.22, FREEZE_AT - 0.06, FREEZE_AT]) * op * (1 - drop);
              if (o <= 0.004) return null;
              const x = 4 + random(s + 'x') * 92;
              const y = 4 + random(s + 'y') * 92 - (t - born) * drift * 0.06;
              return (
                <div key={i} style={{
                  position: 'absolute', left: `${x}%`, top: `${y}%`, opacity: o,
                  transform: `translate(-50%,-50%) translateY(${drop * 500}px)`,
                }}>
                  <MessageCircle size={size} color={ACCENT} strokeWidth={2} />
                </div>
              );
            })}
          </AbsoluteFill>
        );
      })}
    </AbsoluteFill>
  );
}

/* -------------------------------------------------- 7. título colidindo */
//
// RACE flies in from the left, CONDITION from the right; they collide mid-frame with a shake,
// overflowing the edges ON PURPOSE, and only then does the camera pull back to reveal the whole
// lockup — so the crop is motivated instead of looking like a layout bug.

function SceneTitle() {
  const { t } = useT();
  const D = SCENE_SECONDS.title;
  // Ease-OUT on the fly-in: the words must cover most of the distance immediately. With an
  // ease-in they left the frame empty for the first ~0.2s, since they start off-canvas and an
  // ease-in begins at zero velocity — a visible dead beat right after the restaurant cut.
  const inA = interpolate(t, [0, 0.3], [0, 1], { ...CLAMP, easing: Easing.out(Easing.cubic) });
  const dxL = interpolate(inA, [0, 1], [-1000, 0]);
  const dxR = interpolate(inA, [0, 1], [1000, 0]);
  const hit = impactShake(t, 0.3, { amp: 20, dur: 0.3 });
  const wob = settleWobble(t, 0.34, { amp: 6, freq: 7, decay: 0.3 });
  // Pull back AFTER the collision to reveal the full lockup. It starts well past the frame
  // edges (crop = the collision is too big to contain) and settles at a size that genuinely
  // FITS — the overflow has to resolve, or it just reads as a layout bug that never got fixed.
  // Peak scale kept low enough that even mid-collision the lockup stays inside the 1080 frame —
  // the collision energy comes from the fly-in speed and the shake, not from overscaling the
  // words past the edges. It still resolves to a fully safe-area-clean lockup.
  const pull = interpolate(t, [0.34, 1.0], [1.12, 1], { ...CLAMP, easing: Easing.out(Easing.cubic) });
  const out = fadeWin(t, [0, 0.04, D - 0.3, D - 0.05]);
  const glitch = t > 0.3 && t < 0.42 ? (Math.floor(t * 60) % 2 ? 9 : -9) : 0;

  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', opacity: out }}>
      <div style={{ transform: `scale(${pull}) translate(${hit}px, ${wob}px)`, display: 'flex', gap: 26, alignItems: 'baseline' }}>
        <span style={{
          fontFamily: FONT, fontWeight: 900, fontSize: 112, color: WHITE, letterSpacing: '-0.03em',
          transform: `translateX(${dxL + glitch}px)`,
        }}>RACE</span>
        <span style={{
          fontFamily: FONT, fontWeight: 900, fontSize: 112, color: ACCENT, letterSpacing: '-0.03em',
          transform: `translateX(${dxR - glitch}px)`,
        }}>CONDITION</span>
      </div>
    </AbsoluteFill>
  );
}

/* ------------------------------------------------------------ 8. estoque */

function SceneStock() {
  const { t, fps } = useT();
  const D = SCENE_SECONDS.stock;
  const p = easeHero(t, fps, 0.1);
  const wob = settleWobble(t, 0.42, { amp: 4, freq: 6 });
  const creep = interpolate(t, [0, D], [1, 1.07]);       // slow push, keeps the frame alive
  const out = fadeWin(t, [0, 0.16, D - 0.25, D - 0.03]);
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', opacity: out }}>
      <div style={{ transform: `scale(${(0.82 + 0.18 * p) * creep}) translateY(${wob}px)` }}>
        <StatPanel icon={Sandwich} label="ESTOQUE" value="1" valueSize={230}
          badge={<>ÚLTIMO <Sandwich size={22} color="#111" strokeWidth={2} /></>} />
      </div>
    </AbsoluteFill>
  );
}

/* ------------------------------------------ 9. RACE — A e B em PARALELO */
//
// THE apex. In v2 client A and client B were separate sequential scenes, which showed A
// finishing before B even started — the exact opposite of the concept. Both tracks now live on
// one timeline and stay on screen together.
//
// Retimed to the narration, which walks through the whole exchange out loud, so the scene now
// STAGES that exchange beat by beat instead of firing both requests at once. Scene-local times
// (scene starts at 31.34 of the track):
//
//   0.00  "eu pergunto"                          -> cliente A entra
//   0.76  "tem hambúrguer?"                      -> request A sobe
//   1.64  "ele responde que tem"                 -> A lê 1, resposta desce
//   3.04  "só que antes de registrar o pedido"   -> pedido A fica PENDENTE (o estoque não cai)
//   5.48  "outra pessoa pergunta a mesma coisa"  -> cliente B entra, request B sobe
//   7.58  "o sistema olha de novo"               -> B chega no mesmo estoque
//   10.04 "o sistema fala, tem"                  -> B lê 1; os dois READ=1 juntos
const A_ENTER = 0.00, A_ASK = 0.76, A_READ = 1.64, A_PENDING = 3.04;
const B_ENTER = 5.48, B_ASK = 5.90, B_CHECK = 7.58, B_READ = 10.04;

function SceneRace() {
  const { t } = useT();
  const D = SCENE_SECONDS.race;
  const out = fadeWin(t, [0, 0.16, D - 0.25, D - 0.03]);
  const bothRead = t >= B_READ;
  // The stock number pulses only while a read is actually landing on it.
  const readPulse = (t >= A_READ && t < A_READ + 0.5) || (t >= B_READ && t < B_READ + 0.6)
    ? 1 + Math.sin(t * 22) * 0.03 : 1;

  return (
    <AbsoluteFill style={{ opacity: out }}>
      <svg style={{ position: 'absolute', inset: 0 }} viewBox="0 0 1080 1920" preserveAspectRatio="none">
        <Connector d="M 250 560 L 540 1010" color={ACCENT} t={t} from={A_ASK} to={A_READ} />
        <Connector d="M 830 560 L 540 1010" color={TRACK_B} t={t} from={B_ASK} to={B_READ} />
      </svg>

      <Track side="left" name="CLIENTE A" color={ACCENT} t={t}
        enter={A_ENTER} ask={A_ASK} read={A_READ} />
      <Track side="right" name="CLIENTE B" color={TRACK_B} t={t}
        enter={B_ENTER} ask={B_ASK} read={B_READ} checkAt={B_CHECK} />

      {/* The shared state both tracks read. */}
      <div style={{ position: 'absolute', left: '50%', top: '56%', transform: 'translate(-50%,-50%)', textAlign: 'center' }}>
        <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: 40, color: 'rgba(255,255,255,0.8)', letterSpacing: '0.12em' }}>ESTOQUE</div>
        <div style={{
          fontFamily: FONT, fontWeight: 900, fontSize: 190, color: ACCENT, lineHeight: 1,
          transform: `scale(${readPulse})`,
        }}>1</div>
      </div>

      {/* The crux, held on screen through the long middle of the narration: A was answered but
          never wrote, so the stock is still 1 when B arrives. This is the beat the whole bug
          hangs on, and it is exactly what he is describing while it sits there. */}
      {t >= A_PENDING && (
        <div style={{
          position: 'absolute', left: '50%', top: '72%', transform: 'translate(-50%,-50%)',
          opacity: fadeWin(t, [A_PENDING, A_PENDING + 0.25, D - 0.35, D - 0.1]),
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
        }}>
          <div style={{
            border: `3px dashed ${ACCENT}`, borderRadius: 14, padding: '12px 26px',
            fontFamily: MONO, fontWeight: 800, fontSize: 30, color: ACCENT,
            opacity: 0.55 + Math.sin(t * 4.5) * 0.3,
          }}>PEDIDO A — NÃO REGISTRADO</div>
          <div style={{ fontFamily: MONO, fontSize: 25, color: 'rgba(255,255,255,0.62)' }}>ESTOQUE AINDA = 1</div>
        </div>
      )}

      {bothRead && (
        <div style={{
          position: 'absolute', left: '50%', bottom: '6%', transform: 'translateX(-50%)',
          display: 'flex', alignItems: 'center', gap: 18,
          opacity: fadeWin(t, [B_READ + 0.1, B_READ + 0.3, D - 0.25, D - 0.05]),
        }}>
          <Eye size={54} color={WHITE} strokeWidth={1.5} />
          <span style={{ fontFamily: FONT, fontWeight: 800, fontSize: 38, color: WHITE }}>OS DOIS LERAM 1</span>
        </div>
      )}
    </AbsoluteFill>
  );
}

/** One track of the exchange: the client, the request travelling up, an optional explicit
 *  "check stock" beat, and the READ result that stays pinned once it lands. */
function Track({ side, name, color, t, enter, ask, read, checkAt }) {
  const left = side === 'left';
  const x = left ? 23 : 77;
  const travel = easeRequest(t, ask, read);
  const chipX = left ? 23 + travel * 27 : 77 - travel * 27;
  const chipY = 29 + travel * 24;
  const chipOpacity = fadeWin(t, [ask, ask + 0.1, read - 0.06, read + 0.02]);
  const readOpacity = fadeWin(t, [read, read + 0.12, 999, 1000]);
  const entered = easeUI(t, enter, enter + 0.32);

  return (
    <>
      <div style={{
        position: 'absolute', left: `${x}%`, top: '20%',
        transform: `translate(-50%, ${(1 - entered) * -70}px)`, opacity: entered,
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
      }}>
        <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: 34, color }}>{name}</div>
        <User size={86} color={color} strokeWidth={1.3} />
      </div>

      {chipOpacity > 0.01 && (
        <div style={{
          position: 'absolute', left: `${chipX}%`, top: `${chipY}%`, transform: 'translate(-50%,-50%)',
          opacity: chipOpacity, background: 'rgba(10,10,10,0.92)', border: `3px solid ${color}`,
          borderRadius: 999, padding: '12px 26px', fontFamily: MONO, fontWeight: 700,
          fontSize: 27, color: WHITE, whiteSpace: 'nowrap',
        }}>GET /hamburger</div>
      )}

      {/* "o sistema olha de novo" — B gets an explicit check beat before its answer. */}
      {checkAt != null && t >= checkAt && t < read && (
        <div style={{
          position: 'absolute', left: `${left ? 27 : 73}%`, top: '40%', transform: 'translate(-50%,-50%)',
          opacity: fadeWin(t, [checkAt, checkAt + 0.14, read - 0.08, read]), textAlign: 'center', whiteSpace: 'nowrap',
        }}>
          <div style={{ fontFamily: MONO, fontSize: 26, color: 'rgba(255,255,255,0.65)' }}>CHECK STOCK</div>
          <div style={{ fontFamily: MONO, fontWeight: 800, fontSize: 40, color }}>...</div>
        </div>
      )}

      {readOpacity > 0.01 && (
        <div style={{
          position: 'absolute', left: `${left ? 27 : 73}%`, top: '40%', transform: 'translate(-50%,-50%)',
          opacity: readOpacity, textAlign: 'center',
        }}>
          <div style={{ fontFamily: MONO, fontSize: 26, color: 'rgba(255,255,255,0.65)' }}>CHECK STOCK</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'center', marginTop: 4, whiteSpace: 'nowrap' }}>
            <span style={{ fontFamily: MONO, fontWeight: 800, fontSize: 44, color }}>READ → 1</span>
            <Check size={34} color={GREEN} strokeWidth={2.8} />
          </div>
        </div>
      )}
    </>
  );
}

/** An SVG connector that draws itself along the request's travel. */
function Connector({ d, color, t, from, to }) {
  const p = easeRequest(t, from, to);
  const opacity = fadeWin(t, [from, from + 0.1, 999, 1000]) * 0.75;
  return (
    <path d={d} stroke={color} strokeWidth={4} fill="none" strokeDasharray="600"
      strokeDashoffset={600 * (1 - p)} opacity={opacity} />
  );
}
/* ------------------------------------------------------------- 10. o bug */

function SceneBug() {
  const { t, fps } = useT();
  const D = SCENE_SECONDS.bug;
  const out = fadeWin(t, [0, 0.1, D - 0.2, D - 0.02]);

  // Scene starts at 42.96 ("pronto"). Beats: 0.58 "dois pedidos aceitos",
  // 1.98 "mas só tinha um hambúrguer", 3.14 end of that word -> the hit.
  const ORDERS_AT = 0.58, COUNTS_AT = 1.98, HIT_AT = 3.14;

  const ordersIn = t >= 0.1 && t < COUNTS_AT - 0.1;
  const countsIn = t >= COUNTS_AT - 0.15 && t < HIT_AT - 0.16;
  const silence = t >= HIT_AT - 0.16 && t < HIT_AT;   // deliberate held beat before the hit
  const finalIn = t >= HIT_AT;
  const pushIn = interpolate(t, [HIT_AT - 0.2, HIT_AT + 0.45], [1, 1.16], { ...CLAMP, easing: Easing.out(Easing.cubic) });
  const hitP = easeHero(t, fps, HIT_AT);
  const glitchOn = t >= HIT_AT && t < HIT_AT + 0.08;  // glitch is an EVENT: ~3 frames, then gone
  const gx = glitchOn ? (Math.floor(t * 90) % 2 ? 12 : -12) : 0;

  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', opacity: out }}>
      {ordersIn && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 28, alignItems: 'center' }}>
          <OrderRow label="CREATE ORDER A" pedido="PEDIDO #101" color={ACCENT} t={t} at={ORDERS_AT - 0.42} />
          <OrderRow label="CREATE ORDER B" pedido="PEDIDO #102" color={TRACK_B} t={t} at={ORDERS_AT - 0.26} />
        </div>
      )}

      {countsIn && (
        <div style={{ display: 'flex', gap: 110, opacity: fadeWin(t, [COUNTS_AT - 0.15, COUNTS_AT, HIT_AT - 0.3, HIT_AT - 0.16]) }}>
          <PopStat icon={Sandwich} label="ESTOQUE" value="1" t={t} at={COUNTS_AT} fps={fps} />
          <PopStat icon={Receipt} label="PEDIDOS" value="2" t={t} at={COUNTS_AT + 0.26} fps={fps} valueColor={RED} />
        </div>
      )}

      {silence && <div style={{ opacity: 0 }} />}

      {finalIn && (
        <div style={{
          transform: `scale(${pushIn * (0.86 + 0.14 * hitP)}) translateX(${gx}px)`,
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
          opacity: fadeWin(t, [HIT_AT, HIT_AT + 0.08, D - 0.12, D - 0.02]),
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 40 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Sandwich size={54} color={WHITE} strokeWidth={1.5} />
              <span style={{ fontFamily: FONT, fontWeight: 900, fontSize: 52, color: WHITE }}>× 1</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Receipt size={54} color={RED} strokeWidth={1.5} />
              <span style={{ fontFamily: FONT, fontWeight: 900, fontSize: 52, color: RED }}>× 2</span>
            </div>
          </div>
          <div style={{
            fontFamily: FONT, fontWeight: 900, fontSize: 170, color: RED, marginTop: 6,
          }}>1 ≠ 2</div>
        </div>
      )}
    </AbsoluteFill>
  );
}

function OrderRow({ label, pedido, color, t, at }) {
  const created = fadeWin(t, [at, at + 0.08, at + 0.5, at + 0.62]);
  const done = t >= at + 0.5;
  const pop = easeUI(t, at + 0.5, at + 0.66);
  return (
    <div style={{ height: 62, display: 'flex', alignItems: 'center' }}>
      {!done ? (
        <span style={{ fontFamily: MONO, fontWeight: 700, fontSize: 40, color: 'rgba(255,255,255,0.8)', opacity: created }}>{label}</span>
      ) : (
        <span style={{
          display: 'flex', alignItems: 'center', gap: 12,
          transform: `scale(${0.86 + 0.14 * pop})`,
        }}>
          <span style={{ fontFamily: MONO, fontWeight: 800, fontSize: 46, color }}>{pedido}</span>
          <Check size={38} color={GREEN} strokeWidth={2.8} />
        </span>
      )}
    </div>
  );
}

function PopStat({ icon, label, value, valueColor, t, at, fps }) {
  const p = easeHero(t, fps, at);
  const wob = settleWobble(t, at + 0.3, { amp: 3, freq: 6 });
  return (
    <div style={{ transform: `scale(${0.7 + 0.3 * p}) translateY(${wob}px)` }}>
      <StatPanel icon={icon} label={label} value={value} valueColor={valueColor} iconSize={150} valueSize={185} />
    </div>
  );
}

/* -------------------------------------------------------- 11. a timeline */
//
// Order flipped for the narration: he says "isso é race condition" FIRST and only then explains
// the mechanism, so the impact now opens the scene and the diagram builds under the explanation.
// The bars are drawn in two stages — READ while he says they read the same state, WRITE while he
// says one of them had not updated it yet — instead of appearing pre-built.
//
// Scene-local beats (scene starts at 46.62 of the track):
//   0.00 "isso é race condition"                  -> impacto
//   2.08 "duas requisições leram o mesmo estado"  -> barras READ + overlap
//   4.60 "antes de que uma delas pudesse alterá-lo" -> barras WRITE + conflito
const TL_IMPACT = 0.0, TL_READ = 2.08, TL_WRITE = 4.60;

function SceneTimeline() {
  const { t, fps } = useT();
  const D = SCENE_SECONDS.timeline;
  const out = fadeWin(t, [0, 0.12, D - 0.22, D - 0.03]);

  const impact = t < TL_READ - 0.25;
  const impactP = easeHero(t, fps, TL_IMPACT);
  const impactOut = fadeWin(t, [0, 0.1, TL_READ - 0.45, TL_READ - 0.25]);

  const drawRead = easeUI(t, TL_READ, TL_READ + 0.9);
  const drawWrite = easeUI(t, TL_WRITE, TL_WRITE + 0.7);
  const overlapOn = t >= TL_READ + 0.7;
  const overlapGlow = overlapOn ? 0.4 + Math.sin((t - TL_READ - 0.7) * 7) * 0.3 : 0;
  const showState = t >= TL_READ + 0.85;
  const showConflict = t >= TL_WRITE + 0.5;

  const BAR_W = 860;   // ~80% of the 1080 canvas
  const readW = 0.36, writeW = 0.3, bOffset = 0.16;

  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', opacity: out }}>
      {impact && (
        <div style={{
          transform: `scale(${0.82 + 0.18 * impactP})`, opacity: impactOut,
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
        }}>
          <Zap size={104} color={ACCENT} strokeWidth={1.7} />
          <div style={{ fontFamily: FONT, fontWeight: 900, fontSize: 124, color: WHITE, textAlign: 'center', lineHeight: 0.98 }}>RACE<br />CONDITION</div>
        </div>
      )}

      {!impact && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 40 }}>
          <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 34 }}>
            <TLRow label="A" color={ACCENT} offset={0} readW={readW} writeW={writeW}
              w={BAR_W} drawRead={drawRead} drawWrite={drawWrite} />
            <TLRow label="B" color={TRACK_B} offset={bOffset} readW={readW} writeW={writeW}
              w={BAR_W} drawRead={drawRead} drawWrite={drawWrite} />
            {/* Overlap region — the whole point of the diagram, so it pulses. */}
            {overlapOn && (
              <div style={{
                position: 'absolute', left: 52 + BAR_W * bOffset, top: -8,
                width: BAR_W * (readW - bOffset), height: 'calc(100% + 16px)',
                border: `3px solid ${ACCENT}`, borderRadius: 12,
                opacity: easeUI(t, TL_READ + 0.7, TL_READ + 0.95),
                background: `rgba(255,212,0,${overlapGlow * 0.18})`,
                boxShadow: `0 0 ${overlapGlow * 40}px rgba(255,212,0,${overlapGlow * 0.5})`,
              }} />
            )}
          </div>

          <div style={{ textAlign: 'center', height: 150 }}>
            {showState && (
              <div style={{
                fontFamily: FONT, fontWeight: 900, fontSize: 54, color: ACCENT,
                opacity: fadeWin(t, [TL_READ + 0.85, TL_READ + 1.05, TL_WRITE + 0.9, TL_WRITE + 1.15]),
              }}>MESMO ESTADO</div>
            )}
            {showConflict && (
              <div style={{
                marginTop: 10, display: 'flex', alignItems: 'center', gap: 14, justifyContent: 'center',
                opacity: easeUI(t, TL_WRITE + 0.5, TL_WRITE + 0.75),
              }}>
                <Zap size={44} color={RED} strokeWidth={2} />
                <span style={{ fontFamily: FONT, fontWeight: 900, fontSize: 54, color: RED }}>WRITE EM CONFLITO</span>
              </div>
            )}
          </div>
        </div>
      )}
    </AbsoluteFill>
  );
}

/** One request's lane. READ and WRITE are drawn independently so the diagram can build in step
 *  with what is being said, rather than arriving complete. */
function TLRow({ label, color, offset, readW, writeW, w, drawRead, drawWrite }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
      <div style={{ width: 32, fontFamily: MONO, color, fontWeight: 800, fontSize: 34 }}>{label}</div>
      <div style={{ position: 'relative', width: w, height: 40, background: 'rgba(255,255,255,0.07)', borderRadius: 10 }}>
        <div style={{
          position: 'absolute', left: w * offset, width: w * readW * drawRead, height: '100%',
          background: color, opacity: 0.55, borderRadius: 10,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: MONO, fontSize: 22, fontWeight: 800, color: '#0a0a0a', overflow: 'hidden',
        }}>READ 1</div>
        <div style={{
          position: 'absolute', left: w * (offset + readW), width: w * writeW * drawWrite, height: '100%',
          background: color, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: MONO, fontSize: 22, fontWeight: 800, color: '#0a0a0a', overflow: 'hidden',
        }}>WRITE</div>
      </div>
    </div>
  );
}
/* --------------------------------------------------- 12. generalização */
//
// The object morphs; the bug does not. "1 → 2" stays pinned on screen across all four cases,
// which is the actual message.

const CASES = [
  { Icon: Sandwich, label: 'ESTOQUE' },
  { Icon: Ticket, label: 'CUPOM' },
  { Icon: CreditCard, label: 'SALDO' },
  { Icon: TicketCheck, label: 'INGRESSO' },
];

function SceneGeneralize() {
  const { t, fps } = useT();
  const D = SCENE_SECONDS.generalize;
  // Each morph lands on its own spoken word (scene starts at 52.84):
  //   "estoque" 1.34   "cupom" 2.10   "saldo" 2.88   "ingresso" 3.90
  // Uneven on purpose — he does not list them at a metronome pace.
  const ONSETS = [1.34, 2.10, 2.88, 3.90];
  let idx = 0;
  for (let i = 0; i < ONSETS.length; i++) if (t >= ONSETS[i] - 0.14) idx = i;
  const local = t - (ONSETS[idx] - 0.14);
  const c = CASES[idx];
  const out = fadeWin(t, [0, 0.12, D - 0.14, D - 0.02]);

  // Morph: the outgoing icon compresses and the incoming one expands through the same axis.
  const flip = easeUI(local, 0, 0.22);
  const scaleX = idx === 0 && local < 0.22 ? 1 : Math.abs(Math.cos((1 - flip) * Math.PI / 2));
  const settle = settleWobble(t, ONSETS[idx] + 0.12, { amp: 3, freq: 7 });

  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', opacity: out }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18 }}>
          <div style={{ transform: `scaleX(${scaleX}) translateY(${settle}px)` }}>
            <c.Icon size={190} color={WHITE} strokeWidth={1.2} />
          </div>
          <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: 46, color: ACCENT, letterSpacing: '0.1em' }}>{c.label}</div>
          {/* The constant: same bug, different object. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 28, marginTop: 10 }}>
            <span style={{ fontFamily: FONT, fontWeight: 900, fontSize: 132, color: WHITE }}>1</span>
            <span style={{ fontFamily: FONT, fontWeight: 900, fontSize: 86, color: 'rgba(255,255,255,0.5)' }}>→</span>
            <span style={{ fontFamily: FONT, fontWeight: 900, fontSize: 132, color: RED }}>2</span>
          </div>
      </div>
    </AbsoluteFill>
  );
}

/* --------------------------------------- 13. pressão na API (sem payoff) */
//
// Ends on the QUESTION, never the answer: requests pile onto an API and the whole thing cuts to
// full transparency. "RATE LIMIT" is deliberately absent — that line is Derick's, on camera.

function SceneApi() {
  const { t, fps } = useT();
  const D = SCENE_SECONDS.api;
  const p = easeHero(t, fps, 0.05);
  const load = interpolate(t, [0.3, D - 0.35], [0, 1], { ...CLAMP, easing: Easing.in(Easing.quad) });
  const count = Math.round(interpolate(load, [0, 1], [3, 500]));
  const shake = load > 0.45 ? Math.sin(t * 44) * load * 7 : 0;
  // Hard cut to nothing on the last beat — the silence before the camera answers.
  const out = interpolate(t, [D - 0.3, D - 0.16], [1, 0], { ...CLAMP, easing: Easing.in(Easing.cubic) });

  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', opacity: out }}>
      {Array.from({ length: 26 }).map((_, i) => {
        const s = `api-${i}`;
        const born = 0.3 + random(s + 'b') * (D - 1.0);
        if (t < born) return null;
        const prog = easeRequest(t, born, born + 0.5);
        if (prog >= 1) return null;
        const a = random(s + 'a') * Math.PI * 2;
        const dist = (1 - prog) * 900;
        return (
          <div key={i} style={{
            position: 'absolute', left: '50%', top: '50%',
            transform: `translate(-50%,-50%) translate(${Math.cos(a) * dist}px, ${Math.sin(a) * dist}px)`,
            width: 46, height: 6, borderRadius: 3, background: ACCENT, opacity: 0.35 + prog * 0.5,
          }} />
        );
      })}

      <div style={{ transform: `scale(${0.85 + 0.15 * p}) translate(${shake}px, 0)`, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
        <div style={{
          border: `5px solid ${ACCENT}`, borderRadius: 22, padding: '30px 62px',
          background: 'rgba(10,10,10,0.9)', display: 'flex', alignItems: 'center', gap: 20,
        }}>
          <Server size={72} color={ACCENT} strokeWidth={1.6} />
          <span style={{ fontFamily: MONO, fontWeight: 900, fontSize: 76, color: WHITE }}>API</span>
        </div>
        <div style={{ fontFamily: MONO, fontWeight: 800, fontSize: 62, color: load > 0.6 ? RED : WHITE }}>
          {count} req/s
        </div>
      </div>
    </AbsoluteFill>
  );
}

/* ------------------------------------------------------------------ root */

const PREVIEW_BG = '#04140b';   // preview only; the delivery MOV renders with bg={null}

/** Master camera. Runs UNDER the scene cuts so an act reads as one continuous move, and resets
 *  only where the story resets (the RACE CONDITION title). Every keyframe is in SECONDS. */
function useCamera(t) {
  const zoom = interpolate(
    t,
    [0, STARTS.manual, STARTS.loop, STARTS.crack, STARTS.morph, STARTS.restaurant,
      STARTS.title - 0.01, STARTS.title, STARTS.stock, STARTS.race, STARTS.bug,
      STARTS.timeline, STARTS.generalize, STARTS.api, TOTAL_SECONDS],
    [1, 1.06, 1.02, 1.10, 1.16, 1.04,
      1.30, 1.00, 1.03, 1.00, 1.05,
      1.00, 1.04, 1.02, 1.12],
    CLAMP,
  );
  // A drift of a few pixels keeps the frame from ever being perfectly static.
  const driftY = Math.sin(t * 0.55) * 5;
  const driftX = Math.cos(t * 0.4) * 4;
  return { zoom, driftX, driftY };
}

export function BruteForceRaceCondition({ bg = PREVIEW_BG }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const { zoom, driftX, driftY } = useCamera(t);

  // Fonts must be fully laid out before the first frame is captured, or text metrics shift
  // between preview and render.
  const [handle] = useState(() => delayRender('load-fonts'));
  useEffect(() => {
    let done = false;
    const finish = () => { if (!done) { done = true; continueRender(handle); } };
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      document.fonts.ready.then(finish).catch(finish);
    } else finish();
    const timer = setTimeout(finish, 3000);   // never hang a render on a font that never loads
    return () => clearTimeout(timer);
  }, [handle]);

  const sec = k => Math.round(SCENE_SECONDS[k] * fps);

  return (
    <AbsoluteFill style={{ backgroundColor: bg || 'transparent' }}>
      <AbsoluteFill style={{
  transform: `scale(${zoom}) translate(${driftX}px, ${driftY}px)`,
  translate: "2.8px 33.7px"
}}>
        <Series>
          <Series.Sequence durationInFrames={sec('vault')}><SceneVault /></Series.Sequence>
          <Series.Sequence durationInFrames={sec('manual')}><SceneManual /></Series.Sequence>
          <Series.Sequence durationInFrames={sec('loop')}><SceneLoop /></Series.Sequence>
          <Series.Sequence durationInFrames={sec('crack')}><SceneCrack /></Series.Sequence>
          <Series.Sequence durationInFrames={sec('morph')}><SceneMorph /></Series.Sequence>
          <Series.Sequence durationInFrames={sec('restaurant')}><SceneRestaurant /></Series.Sequence>
          <Series.Sequence durationInFrames={sec('title')}><SceneTitle /></Series.Sequence>
          <Series.Sequence durationInFrames={sec('stock')}><SceneStock /></Series.Sequence>
          <Series.Sequence durationInFrames={sec('race')}><SceneRace /></Series.Sequence>
          <Series.Sequence durationInFrames={sec('bug')}><SceneBug /></Series.Sequence>
          <Series.Sequence durationInFrames={sec('timeline')}><SceneTimeline /></Series.Sequence>
          <Series.Sequence durationInFrames={sec('generalize')}><SceneGeneralize /></Series.Sequence>
          <Series.Sequence durationInFrames={sec('api')}><SceneApi /></Series.Sequence>
        </Series>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}
