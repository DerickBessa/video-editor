// PiCam — motion design semântico sobre o TALKING HEAD do reel "Prompt Injection".
//
// Este componente NÃO é a animação técnica (essa é PromptInjection.jsx, tela cheia). Aqui a
// imagem protagonista é o Derick falando, e o motion existe para dizer visualmente o que a
// frase diz. Overlay transparente; `add-overlay` compõe sobre o vídeo da câmera.
//
// ---------------------------------------------------------------------------------------
// A FAIXA (band) — por que todo gráfico vive no topo
//
// Medido em `temp/pi-faces.json` (track-faces, 638 amostras): em NENHUM momento do material
// aproveitado o topo da caixa do rosto sobe acima de y=782px, e a verificação visual com guias
// (temp/sheet-guide.jpg) mostra o cabelo tocando ~740px no ponto mais alto. Logo:
//
//     y 0 .. 660   parede vazia  -> GRÁFICOS   (com ~80px de folga para o cabelo)
//     y 700 ..1300 ele           -> nunca tocar
//     y ~1460      peito         -> LEGENDA (DeckCaption, y=76)
//
// 660 não é estética, é o número medido menos a folga. Mexer nele encosta gráfico em cabelo.
//
// ---------------------------------------------------------------------------------------
// A REGRA DA LEGENDA QUE CEDE
//
// O briefing pede legenda o vídeo inteiro E pede que palavras-chave apareçam na tela em
// vermelho, com X e risco. Fazer as duas coisas ao mesmo tempo escreve a MESMA palavra duas
// vezes no mesmo frame. Então: quando a faixa renderiza as próprias palavras faladas
// (ÉTICA/BOM SENSO/REGRAS, PROMPT INJECTION, os chips de conteúdo externo, o carimbo NÃO
// CONFIÁVEL), o bloco de legenda correspondente é omitido em `pi-captions.json`. A palavra
// falada continua na tela — maior e com significado. As janelas cedidas estão listadas lá.
//
// Timing em SEGUNDOS contra o corte (temp/pi-hook.json / temp/pi-mit.json), convertido por
// useVideoConfig().fps na leitura — o mesmo fonte serve draft 30fps e entrega 60fps.
import React from 'react';
import {
  AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring, random, Easing,
} from 'remotion';
import { DeckCaption } from './DeckCaption.jsx';

/* ------------------------------------------------------------------ tokens */

const FONT = '"Segoe UI", Inter, system-ui, -apple-system, sans-serif';
const MONO = '"Cascadia Code", "JetBrains Mono", Consolas, "Courier New", monospace';

// Paleta com os papéis que o briefing pediu. O ciano aqui é uma EXCEÇÃO consciente ao house
// style §1 (que o reserva para concorrência): o briefing pediu azul/ciano para "elementos
// técnicos e sistema". Registrado em docs/prompt-injection-reel-roteiro.md.
const WHITE = '#ffffff';
const RED   = '#ff4d6d';   // alerta, erro, bloqueio, rejeição — e só isso
const GREEN = '#4DFF88';   // proteção, permitido, fluxo seguro
const CYAN  = '#5BD6FF';   // sistema / técnico (chrome, bordas, rótulos de estrutura)
const ACCENT = '#FFD400';  // o fluxo vivo (pacote em trânsito, ênfase de quantidade)
const STEEL = '#8FA3BF';   // estrutura inerte
const CYAN_HOT = '#22D3FF';  // ciano saturado — só no hero de abertura
const RED_HOT  = '#FF2D3A';  // vermelho puro — só no hero de abertura
const PREVIEW_BG = '#05070C';

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' };
const VW = 1080;
const SAFE_X = 60;
const BAND_BOTTOM = 660;

/* --------------------------------------------------------------- time base */

function useT() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return { t: frame / fps, fps };
}

/* -------------------------------------------------------- easing vocabulary */
// Um preset só para tudo é o que faz motion parecer "componente React transicionando".

/** HERO: termo/palavra entrando. Rápido, overshoot curto, assenta firme. */
function easeHero(t, fps, delay = 0) {
  return spring({ frame: (t - delay) * fps, fps, config: { damping: 13, mass: 0.5, stiffness: 220 } });
}
/** Chrome de interface: sem overshoot. Interface não quica. */
function easeUI(t, from, to) {
  return interpolate(t, [from, to], [0, 1], { ...CLAMP, easing: Easing.out(Easing.cubic) });
}
/** Objeto pesado (escudo): inércia visível. */
function easeHeavy(t, fps, delay = 0) {
  return spring({ frame: (t - delay) * fps, fps, config: { damping: 26, mass: 1.6, stiffness: 90 } });
}
/** Pacote percorrendo uma aresta. */
function easeFlow(t, from, to) {
  return interpolate(t, [from, to], [0, 1], { ...CLAMP, easing: Easing.inOut(Easing.cubic) });
}

/** Oscilação com decaimento DEPOIS do movimento principal — inércia, não dança. */
function settleWobble(t, at, { amp = 4, freq = 6, decay = 0.34 } = {}) {
  const dt = t - at;
  if (dt < 0) return 0;
  return Math.sin(dt * freq * Math.PI * 2) * amp * Math.exp(-dt / decay);
}

/** Shake só em impacto. Nunca ambiente. */
function impactShake(t, at, { amp = 8, dur = 0.2 } = {}) {
  const dt = t - at;
  if (dt < 0 || dt > dur) return 0;
  return Math.sin(dt * 60) * amp * (1 - dt / dur);
}

/** Janela de fade em segundos. Paradas forçadas crescentes: `interpolate` lança exceção em
 *  range não-monotônico, e derrubar o render é pior que um fade de duração zero. */
function fadeWin(t, stops) {
  const EPS = 1e-4;
  const r = [stops[0]];
  for (let i = 1; i < 4; i++) r.push(Math.max(stops[i], r[i - 1] + EPS));
  return interpolate(t, r, [0, 1, 1, 0], CLAMP);
}

/** Clamp de spring: o spring do Remotion passa de 1 no overshoot e pode ir abaixo de 0 antes
 *  do delay. Usar direto como opacity gera frame fora de faixa. */
function s01(v) {
  return Math.min(1, Math.max(0, v));
}

/** Respiração: micro-movimento para nada ficar morto na tela. */
function breathe(t, { amp = 2, freq = 0.32, phase = 0 } = {}) {
  return Math.sin((t + phase) * freq * Math.PI * 2) * amp;
}

function pulse(t, { freq = 0.5, phase = 0 } = {}) {
  return 0.5 + 0.5 * Math.sin((t + phase) * freq * Math.PI * 2);
}

const SHADOW = '0 2px 0 rgba(0,0,0,0.45), 0 0 14px rgba(0,0,0,0.6), 0 8px 30px rgba(0,0,0,0.55)';

/* ------------------------------------------------------------- primitivas */

/** Scrim de legibilidade. A parede tem um projetor RGB girando atrás — sem isto, texto branco
 *  sobre a mancha vermelha/azul perde contraste em movimento. Gradiente, não caixa: o fundo
 *  continua visível, que é o que o briefing pediu ("fundo do meu vídeo preservado"). */
function Scrim({ alpha }) {
  if (alpha <= 0.01) return null;
  return (
    <div style={{
      position: 'absolute', left: 0, right: 0, top: 0, height: 900,
      background: 'linear-gradient(to bottom,'
        + ' rgba(4,6,11,0.46) 0%,'
        + ' rgba(4,6,11,0.40) 38%,'
        + ' rgba(4,6,11,0.24) 66%,'
        + ' rgba(4,6,11,0.08) 85%,'
        + ' rgba(4,6,11,0) 100%)',
      opacity: alpha,
    }} />
  );
}

/** Estilhaços de impacto — cinco, não cinquenta. Determinístico via random(seed). */
function Shards({ t, at, x, y, color = RED, n = 5, spread = 150, dur = 0.34 }) {
  const dt = t - at;
  if (dt < 0 || dt > dur) return null;
  const p = dt / dur;
  return (
    <>
      {Array.from({ length: n }).map((_, i) => {
        const dir = i % 2 ? 1 : -1;
        const sx = dir * (34 + random(`sx${at}${i}`) * spread) * p;
        const sy = (random(`sy${at}${i}`) - 0.5) * spread * 0.85 * p;
        return (
          <div key={i} style={{
            position: 'absolute', left: x, top: y,
            width: 4 + random(`sw${at}${i}`) * 11, height: 3,
            background: color, opacity: (1 - p) * 0.9, borderRadius: 2,
            transform: `translate(-50%,-50%) translate(${sx}px, ${sy}px) rotate(${dir * p * 42}deg)`,
          }} />
        );
      })}
    </>
  );
}

/** Cápsula de dado em trânsito. Mesma forma usada pela animação técnica, de propósito: o
 *  espectador vê o mesmo objeto nas duas metades do vídeo. */
function Packet({ x, y, color = ACCENT, label, smear = 0 }) {
  return (
    <div style={{ position: 'absolute', left: x, top: y }}>
      {smear > 0.05 && [1, 2, 3].map(i => (
        <div key={i} style={{
          position: 'absolute', left: 0, top: 0,
          transform: `translate(-50%,-50%) translateX(${-i * 18 * smear}px)`,
          opacity: 0.3 / i, filter: `blur(${i * 1.4}px)`,
          padding: '9px 20px', borderRadius: 999, background: color, whiteSpace: 'nowrap',
          fontFamily: MONO, fontSize: 26, fontWeight: 700, color: 'transparent',
        }}>{label}</div>
      ))}
      <div style={{
        position: 'absolute', left: 0, top: 0, transform: 'translate(-50%,-50%)',
        padding: '9px 20px', borderRadius: 999, background: color, whiteSpace: 'nowrap',
        fontFamily: MONO, fontSize: 26, fontWeight: 700, color: '#08111f',
        boxShadow: `0 0 26px ${color}88`,
      }}>{label}</div>
    </div>
  );
}

/** Nó/chip do diagrama. */
function Node({ x, y, w, h, label, sub, tone = CYAN, alpha = 1, scale = 1, glow = 0 }) {
  return (
    <div style={{
      position: 'absolute', left: x, top: y, width: w, height: h,
      transform: `translate(-50%,-50%) scale(${scale})`, opacity: alpha,
      border: `2px solid ${tone}`,
      borderRadius: 14, background: 'rgba(8,14,26,0.55)',
      boxShadow: glow > 0.02 ? `0 0 ${18 + glow * 30}px ${tone}${glow > 0.5 ? 'aa' : '66'}` : 'none',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4,
    }}>
      <div style={{
        fontFamily: FONT, fontWeight: 900, fontSize: 46, color: WHITE,
        letterSpacing: '-0.02em', textShadow: SHADOW, whiteSpace: 'nowrap',
      }}>{label}</div>
      {sub && <div style={{ fontFamily: MONO, fontSize: 22, color: STEEL, letterSpacing: '0.08em' }}>{sub}</div>}
    </div>
  );
}

/** Uma palavra que aparece, é rejeitada e fica riscada.
 *  A rejeição é três coisas acontecendo juntas, não um fade: o ✕ carimba, o risco é DESENHADO
 *  da esquerda para a direita (scaleX de uma barra, não opacity), e a linha inteira treme por
 *  0,2s. Fade sozinho lê como "sumiu"; isto lê como "foi cancelado". */
function StruckWord({ t, fps, at, text, y, x = SAFE_X + 78, size = 70, win }) {
  const KILL = at + 0.30;
  const a = fadeWin(t, win);
  if (a <= 0.005) return null;

  const inP = s01(easeHero(t, fps, at));
  const dead = t >= KILL;
  const killP = easeUI(t, KILL, KILL + 0.17);
  const xP = s01(easeHero(t, fps, KILL));
  const shake = impactShake(t, KILL, { amp: 5, dur: 0.2 });
  const flash = interpolate(t, [KILL, KILL + 0.13], [1, 0], CLAMP);

  const wpx = text.length * 0.575 * size;

  return (
    <div style={{
      position: 'absolute', left: x, top: y, opacity: a,
      transform: `translateY(-50%) translateX(${(1 - inP) * -46 + shake}px)`,
      display: 'flex', alignItems: 'center', gap: 22,
    }}>
      {/* ✕ — carimba no momento da rejeição, não antes */}
      <div style={{
        width: 52, height: 52, flex: '0 0 auto',
        transform: `scale(${xP}) rotate(${(1 - xP) * -40}deg)`,
        opacity: xP,
      }}>
        <svg viewBox="0 0 52 52" width="52" height="52">
          <line x1="8" y1="8" x2="44" y2="44" stroke={RED} strokeWidth="7" strokeLinecap="round" />
          <line x1="44" y1="8" x2="8" y2="44" stroke={RED} strokeWidth="7" strokeLinecap="round" />
        </svg>
      </div>

      <div style={{ position: 'relative', opacity: inP }}>
        {/* flash de rejeição atrás da palavra */}
        <div style={{
          position: 'absolute', left: -14, right: -14, top: -8, bottom: -8,
          background: RED, opacity: flash * 0.3, borderRadius: 8,
        }} />
        <div style={{
          fontFamily: FONT, fontWeight: 900, fontSize: size, whiteSpace: 'nowrap',
          letterSpacing: '-0.03em', textShadow: SHADOW,
          color: dead ? RED : WHITE,
          transform: `scale(${1 + (1 - inP) * 0.06})`,
        }}>{text}</div>
        {/* o risco: desenhado, com origem à esquerda */}
        <div style={{
          position: 'absolute', left: -10, top: '52%', height: 7, width: wpx + 20,
          background: RED, borderRadius: 4, transformOrigin: 'left center',
          transform: `scaleX(${killP})`, boxShadow: `0 0 16px ${RED}aa`,
        }} />
      </div>

      <Shards t={t} at={KILL} x={wpx * 0.5 + 74} y={size * 0.5} n={5} spread={130} />
    </div>
  );
}

/* =====================================================================================
 * PARTE 1 — GANCHO  (corte temp/pi-hook-norm.mp4, 22,08s)
 *
 * Onsets medidos em temp/pi-hook.json. Não arredondar.
 * ===================================================================================== */

const H = {
  // abertura (hero tipografico) — cada linha entra NA palavra
  L1: 0.00, QUE_A: 0.96, IA: 1.80, NAO: 1.98, PERFEITA: 2.38, STRIKE: 2.66, OPEN_OUT: 3.06,
  IMAGINA: 3.60, IA_NODE: 4.50, OBEDECER: 5.40, MANDA: 7.00,
  IGNORANDO: 7.96, ETICA: 8.78, SENSO: 9.92, REGRAS: 10.80, RECEBEU: 11.44,
  G3_OUT: 13.06,
  CONHECER: 19.80, PROMPT: 20.32, INJECTION: 21.06,
  END: 22.08,
};

/** ABERTURA — hero tipográfico, no formato do gancho aprovado ("QUEBRAR UM SITE").
 *
 *  A frase inteira é UMA composição centrada na tela, construída linha a linha na palavra.
 *  Fica por cima dele de propósito: a pilha vai de y 481 a 1099, ou seja, cobre testa e olhos
 *  e para logo acima da boca (~1127px, medido). É essa proporção que faz o gancho ocupar o
 *  quadro em vez de flutuar no canto — e é o que o vídeo de referência faz.
 *
 *  Sem contorno preto: testado e rejeitado pelo Derick. A legibilidade vem da sombra pesada
 *  abaixo mais o scrim da faixa.
 *
 *  O PAGAMENTO: "PERFEITA" nasce VERDE e vira VERMELHA conforme o risco passa por cima. Não é
 *  um flip no fim — a palavra vermelha é revelada por `clipPath` acionado pelo MESMO `strikeP`
 *  que desenha a linha, então a cor troca exatamente sob a ponta do risco. A imagem faz o que
 *  a frase diz, no instante em que ela diz.
 *
 *  Larguras conferidas (nº de caracteres × 0,58 × fontSize ≤ 960px úteis):
 *      EU VOU TE MOSTRAR  17 × 0,58 × 78  = 769
 *      PERFEITA            8 × 0,58 × 160 = 742
 */
function HookOpening({ t, fps }) {
  const a = fadeWin(t, [-0.5, -0.2, H.OPEN_OUT, H.OPEN_OUT + 0.26]);
  if (a <= 0.005) return null;

  const line = (at, rise = 30, from = 0.88) => {
    const sp = s01(easeHero(t, fps, at));
    return {
      opacity: easeUI(t, at, at + 0.11),
      transform: `translateY(${(1 - sp) * rise}px) scale(${from + (1 - from) * sp})`,
    };
  };

  const strikeP = easeUI(t, H.STRIKE, H.STRIKE + 0.24);
  const shake = impactShake(t, H.STRIKE, { amp: 11, dur: 0.24 });

  // Sombra mais pesada que a do resto do vídeo: sem contorno, é ela que segura o texto
  // grande sobre o cabelo escuro e sobre a parede clara ao mesmo tempo.
  const HERO_SHADOW = [
    '0 4px 0 rgba(0,0,0,0.55)',
    '0 0 18px rgba(0,0,0,0.85)',
    '0 10px 38px rgba(0,0,0,0.75)',
  ].join(', ');

  const txt = (size, color) => ({
    fontFamily: FONT, fontWeight: 900, fontSize: size, color,
    letterSpacing: '-0.035em', lineHeight: 1.0, whiteSpace: 'nowrap',
    textShadow: HERO_SHADOW,
  });

  return (
    <AbsoluteFill style={{ opacity: a }}>
      <div style={{
        position: 'absolute', left: '50%', top: 840,
        transform: `translate(-50%,-50%) translateX(${shake}px)`,
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
      }}>
        <div style={{ ...txt(78, WHITE), ...line(H.L1, 22) }}>EU VOU TE MOSTRAR</div>
        <div style={{ ...txt(58, 'rgba(255,255,255,0.88)'), ...line(H.QUE_A, 18) }}>QUE A</div>
        <div style={{ ...txt(180, CYAN_HOT), ...line(H.IA, 34, 0.7) }}>IA</div>
        <div style={{ ...txt(110, ACCENT), ...line(H.NAO, 24) }}>NÃO É</div>

        {/* PERFEITA — verde, e o risco a transforma em vermelha ao passar */}
        <div style={{ position: 'relative', ...line(H.PERFEITA, 30, 0.8) }}>
          <div style={txt(160, GREEN)}>PERFEITA</div>
          <div style={{
            ...txt(160, RED_HOT),
            position: 'absolute', left: 0, top: 0,
            clipPath: `inset(0 ${(1 - strikeP) * 100}% 0 0)`,
          }}>PERFEITA</div>
          <div style={{
            position: 'absolute', left: -18, right: -18, top: '53%', height: 11,
            background: RED_HOT, borderRadius: 6, transformOrigin: 'left center',
            transform: `scaleX(${strikeP})`,
            boxShadow: `0 0 18px ${RED_HOT}, 0 2px 6px rgba(0,0,0,0.7)`,
          }} />
          <Shards t={t} at={H.STRIKE + 0.2} x={380} y={90} n={5} spread={250} color={RED_HOT} />
        </div>
      </div>
    </AbsoluteFill>
  );
}

function HookGraphics() {
  const { t, fps } = useT();

  /* ---- G2: "imagina se uma IA começasse a obedecer tudo..." ----------------------
   * O nó IA nasce em "uma IA" (4,50) e ALGUÉM em "obedecer" (5,40) — cada um na sua
   * palavra. A palavra TUDO foi REMOVIDA da faixa a pedido do Derick: ela competia com o
   * diagrama e virava ruído. Ela agora vive só na legenda (pi-hook.json, 5,90-6,76). */
  const iaBorn = fadeWin(t, [H.IA_NODE - 0.28, H.IA_NODE - 0.02, H.IGNORANDO - 0.05, H.IGNORANDO + 0.22]);
  const iaSpring = s01(easeHero(t, fps, H.IA_NODE - 0.26));
  const algA = fadeWin(t, [H.OBEDECER - 0.30, H.OBEDECER - 0.05, H.IGNORANDO - 0.05, H.IGNORANDO + 0.18]);
  const algSpring = s01(easeHero(t, fps, H.OBEDECER - 0.28));
  const lineP = easeUI(t, H.OBEDECER, H.OBEDECER + 0.42);
  const PK_FROM = H.MANDA, PK_TO = H.MANDA + 0.62;
  const pkP = easeFlow(t, PK_FROM, PK_TO);
  const pkLive = t >= PK_FROM - 0.02 && t <= PK_TO + 0.10;
  const pkX = interpolate(pkP, [0, 1], [300, 760], CLAMP);
  const iaHit = fadeWin(t, [PK_TO - 0.04, PK_TO + 0.06, PK_TO + 0.26, PK_TO + 0.5]);

  /* ---- G3: ÉTICA / BOM SENSO / REGRAS -------------------------------------------- */
  const sysA = fadeWin(t, [H.RECEBEU - 0.05, H.RECEBEU + 0.25, H.G3_OUT, H.G3_OUT + 0.28]);
  const sysP = easeUI(t, H.RECEBEU, H.RECEBEU + 0.45);

  /* ---- G5: PROMPT INJECTION ------------------------------------------------------
   * O termo não entra por corte nem por fade: INJECTION chega de fora do quadro, com smear,
   * e ENTRA à força — PROMPT é empurrado para a esquerda para abrir espaço. É a única
   * animação do gancho que ilustra o próprio nome do conceito. */
  const frameP = easeUI(t, H.CONHECER, H.PROMPT);
  const promptSpring = s01(easeHero(t, fps, H.PROMPT));
  const injP = s01(easeHero(t, fps, H.INJECTION));
  const injSmear = interpolate(t, [H.INJECTION, H.INJECTION + 0.16], [1, 0], CLAMP);
  const caretOn = t >= H.INJECTION - 0.26 && t < H.INJECTION + 0.04;
  const heroShake = impactShake(t, H.INJECTION + 0.04, { amp: 11, dur: 0.24 });
  const heroA = fadeWin(t, [H.CONHECER - 0.1, H.CONHECER + 0.2, H.END + 1, H.END + 1.1]);
  const promptDX = interpolate(injP, [0, 1], [92, 0], CLAMP);
  const injDX = interpolate(injP, [0, 1], [640, 0], CLAMP);
  const redFlash = interpolate(t, [H.INJECTION + 0.02, H.INJECTION + 0.2], [1, 0], CLAMP);

  const scrim = Math.max(
    fadeWin(t, [-0.5, -0.2, H.OPEN_OUT, H.OPEN_OUT + 0.28]),
    fadeWin(t, [H.IA_NODE - 0.55, H.IA_NODE - 0.2, H.IGNORANDO - 0.1, H.IGNORANDO + 0.25]),
    fadeWin(t, [H.ETICA - 0.45, H.ETICA - 0.05, H.G3_OUT, H.G3_OUT + 0.3]),
    fadeWin(t, [H.CONHECER - 0.35, H.CONHECER + 0.05, H.END + 1, H.END + 1.1]),
  );

  return (
    <AbsoluteFill>
      <Scrim alpha={scrim * 0.95} />

      <HookOpening t={t} fps={fps} />

      {/* o nó IA: nasce em "uma IA" e fica sendo o destino do fluxo */}
      {iaBorn > 0.005 && (
        <div style={{
          position: 'absolute', left: 0, top: 0, opacity: iaBorn,
          transform: `translateY(${breathe(t, { amp: 2.2 })}px)`,
        }}>
          <Node
            x={830} y={410} w={312} h={152}
            label="IA" sub="MODELO"
            tone={CYAN} scale={0.86 + 0.14 * iaSpring}
            glow={iaHit * 0.9 + 0.12}
          />
        </div>
      )}

      {/* ALGUÉM -> IA */}
      {algA > 0.005 && (
        <div style={{ position: 'absolute', left: 0, top: 0, opacity: algA }}>
          <Node
            x={250} y={410} w={312} h={152} label="ALGUÉM" sub="INPUT"
            tone={STEEL} scale={0.86 + 0.14 * algSpring}
          />
          <div style={{
            position: 'absolute', left: 412, top: 410, height: 3, width: 292,
            transformOrigin: 'left center', transform: `translateY(-50%) scaleX(${lineP})`,
            background: `repeating-linear-gradient(to right, ${STEEL} 0 14px, transparent 14px 26px)`,
            opacity: 0.85,
          }} />
          {lineP > 0.92 && (
            <div style={{
              position: 'absolute', left: 704, top: 410, transform: 'translate(-50%,-50%)',
              width: 0, height: 0, borderTop: '9px solid transparent', borderBottom: '9px solid transparent',
              borderLeft: `14px solid ${STEEL}`, opacity: easeUI(t, H.OBEDECER + 0.38, H.OBEDECER + 0.5),
            }} />
          )}
          {pkLive && (
            <Packet x={pkX} y={410} label="ORDEM" color={ACCENT}
              smear={interpolate(pkP, [0, 0.25, 0.8, 1], [0, 0.9, 0.5, 0], CLAMP)} />
          )}
        </div>
      )}

      {/* ---------------------------------------------------------------------- G3 */}
      <StruckWord t={t} fps={fps} at={H.ETICA} text="ÉTICA" y={250}
        win={[H.ETICA - 0.18, H.ETICA + 0.06, H.G3_OUT, H.G3_OUT + 0.3]} />
      <StruckWord t={t} fps={fps} at={H.SENSO} text="BOM SENSO" y={392}
        win={[H.SENSO - 0.18, H.SENSO + 0.06, H.G3_OUT, H.G3_OUT + 0.3]} />
      <StruckWord t={t} fps={fps} at={H.REGRAS} text="REGRAS" y={534}
        win={[H.REGRAS - 0.18, H.REGRAS + 0.06, H.G3_OUT, H.G3_OUT + 0.3]} />

      {/* de onde vieram as regras — a informação que o gancho precisa deixar plantada */}
      {sysA > 0.005 && (
        <div style={{ position: 'absolute', left: SAFE_X + 78, top: 628, opacity: sysA }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 20,
            transform: `translateX(${(1 - sysP) * -24}px)`,
          }}>
            <div style={{
              width: 6, height: 42, borderRadius: 3, background: CYAN, opacity: 0.95,
              transform: `scaleY(${sysP})`,
            }} />
            <div style={{
              fontFamily: MONO, fontSize: 36, fontWeight: 700, color: CYAN, letterSpacing: '0.03em',
              textShadow: SHADOW, opacity: 0.95, whiteSpace: 'nowrap',
            }}>VINDAS DO PRÓPRIO SISTEMA</div>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------------------- G5 */}
      {heroA > 0.005 && (
        <div style={{
          position: 'absolute', left: VW / 2, top: 400, opacity: heroA,
          transform: `translate(-50%,-50%) translateX(${heroShake}px)`,
        }}>
          <div style={{
            position: 'absolute', left: '50%', top: '50%', width: 960, height: 196,
            transform: 'translate(-50%,-50%)',
            border: `2px solid ${redFlash > 0.05 ? RED : CYAN}`, borderRadius: 16,
            opacity: frameP * (0.35 + redFlash * 0.65),
            boxShadow: redFlash > 0.05 ? `0 0 ${30 * redFlash}px ${RED}` : 'none',
            clipPath: `inset(0 ${(1 - frameP) * 100}% 0 0)`,
          }} />
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            whiteSpace: 'nowrap', gap: 20,
          }}>
            <div style={{
              fontFamily: FONT, fontWeight: 900, fontSize: 92, color: WHITE,
              letterSpacing: '-0.035em', textShadow: SHADOW,
              transform: `translateX(${promptDX}px) scale(${0.9 + 0.1 * promptSpring})`,
              opacity: promptSpring,
            }}>PROMPT</div>

            {/* caret de inserção: pisca no lugar exato onde a palavra vai entrar */}
            {caretOn && (
              <div style={{
                width: 8, height: 92, background: RED, borderRadius: 2,
                opacity: pulse(t, { freq: 6 }) > 0.5 ? 1 : 0.15,
                boxShadow: `0 0 18px ${RED}`,
              }} />
            )}

            <div style={{ position: 'relative', opacity: injP > 0.02 ? 1 : 0 }}>
              {injSmear > 0.05 && [1, 2, 3].map(i => (
                <div key={i} style={{
                  position: 'absolute', left: 0, top: 0,
                  fontFamily: FONT, fontWeight: 900, fontSize: 92, color: RED,
                  letterSpacing: '-0.035em', whiteSpace: 'nowrap',
                  transform: `translateX(${injDX + i * 40 * injSmear}px)`,
                  opacity: 0.3 / i, filter: `blur(${i * 1.6}px)`,
                }}>INJECTION</div>
              ))}
              <div style={{
                fontFamily: FONT, fontWeight: 900, fontSize: 92, color: RED,
                letterSpacing: '-0.035em', textShadow: SHADOW, whiteSpace: 'nowrap',
                transform: `translateX(${injDX}px)`,
              }}>INJECTION</div>
            </div>
          </div>
          <Shards t={t} at={H.INJECTION + 0.04} x={0} y={0} n={5} spread={240} color={RED} />
        </div>
      )}
    </AbsoluteFill>
  );
}

/* =====================================================================================
 * PARTE 2 — MITIGAÇÕES  (corte temp/pi-mit-norm.mp4, 35,88s)
 *
 * Onsets medidos em temp/pi-mit.json.
 *
 * Aqui a faixa NÃO repete o título falado ("menor privilégio", "validação no backend"): esse
 * texto é da legenda. A faixa mostra o NÚMERO e o DIAGRAMA — o que a frase significa, não o
 * que ela diz. Foi assim que a tela parou de ter a mesma palavra escrita duas vezes.
 * ===================================================================================== */

const M = {
  TRES: 2.78,
  P1: 3.82, SO_MEXE: 6.86, PRECISA: 8.04, P1_OUT: 9.92,
  P2: 10.14, PECA: 13.24, VOA: 14.08, VERIFICA: 16.12, VEREDITO: 17.26, P2_OUT: 19.02,
  P3: 19.20, DOCS: 20.46, SITES: 21.48, MSGS: 22.24, NAO_CONF: 24.32, P3_OUT: 26.70,
  PROMPT_W: 28.18, PIERCE: 29.05, BARREIRA: 29.80, SHIELD_OUT: 31.00,
  SEGUE: 33.50, END: 35.88,
};

/** Trilha 01·02·03. Pequena e no topo: dá estrutura sem virar apresentação corporativa. */
function Tracker({ t, fps }) {
  const a = fadeWin(t, [M.TRES - 0.05, M.TRES + 0.2, M.P3_OUT, M.P3_OUT + 0.3]);
  if (a <= 0.005) return null;
  const active = t >= M.P3 ? 2 : t >= M.P2 ? 1 : t >= M.P1 ? 0 : -1;
  return (
    <div style={{
      position: 'absolute', left: VW / 2, top: 132, opacity: a,
      transform: 'translate(-50%,-50%)', display: 'flex', gap: 18,
    }}>
      {['01', '02', '03'].map((n, i) => {
        const born = s01(easeHero(t, fps, M.TRES + i * 0.11));
        const on = i === active;
        const done = i < active;
        return (
          <div key={n} style={{
            transform: `scale(${0.5 + 0.5 * born}) translateY(${(1 - born) * -14}px)`,
            opacity: born * (on ? 1 : done ? 0.5 : 0.36),
            fontFamily: MONO, fontWeight: 700, fontSize: 28, letterSpacing: '0.08em',
            color: on ? ACCENT : STEEL, padding: '6px 16px', borderRadius: 999,
            border: `2px solid ${on ? ACCENT : 'rgba(143,163,191,0.4)'}`,
            background: on ? 'rgba(255,212,0,0.12)' : 'transparent',
            boxShadow: on ? `0 0 18px ${ACCENT}55` : 'none',
            textShadow: SHADOW,
          }}>{n}</div>
        );
      })}
    </div>
  );
}

function MitGraphics() {
  const { t, fps } = useT();

  /* ---- 01: menor privilégio — a lista de permissões É a ideia --------------------- */
  const p1A = fadeWin(t, [M.SO_MEXE - 0.22, M.SO_MEXE + 0.05, M.P1_OUT, M.P1_OUT + 0.28]);
  const perms = [
    { label: 'ler o pedido', verdict: 'PERMITIDO', ok: true, at: M.SO_MEXE },
    { label: 'alterar preço', verdict: 'NEGADO', ok: false, at: M.SO_MEXE + 0.42 },
    { label: 'apagar dados', verdict: 'NEGADO', ok: false, at: M.SO_MEXE + 0.84 },
  ];
  const needGlow = fadeWin(t, [M.PRECISA, M.PRECISA + 0.18, M.PRECISA + 0.9, M.PRECISA + 1.3]);

  /* ---- 02: validação no backend — pedido barrado no gate -------------------------- */
  const p2A = fadeWin(t, [M.PECA - 0.28, M.PECA + 0.02, M.P2_OUT, M.P2_OUT + 0.28]);
  const FLY_FROM = M.VOA, FLY_TO = M.VOA + 0.75;
  const flyP = easeFlow(t, FLY_FROM, FLY_TO);
  const flyLive = t >= FLY_FROM - 0.02 && t <= M.VEREDITO + 0.9;
  const bounce = interpolate(t, [M.VEREDITO, M.VEREDITO + 0.16, M.VEREDITO + 0.5], [0, -54, -38], CLAMP);
  const flyX = interpolate(flyP, [0, 1], [360, 585], CLAMP) + (t >= M.VEREDITO ? bounce : 0);
  const scanP = interpolate(t, [M.VERIFICA, M.VEREDITO], [0, 1], CLAMP);
  const scanning = t >= M.VERIFICA && t < M.VEREDITO;
  const blockP = s01(easeHero(t, fps, M.VEREDITO));
  const blockA = fadeWin(t, [M.VEREDITO - 0.02, M.VEREDITO + 0.14, M.P2_OUT, M.P2_OUT + 0.26]);
  const gateShake = impactShake(t, M.VEREDITO, { amp: 7, dur: 0.22 });

  /* ---- 03: conteúdo externo — três chips carimbados ------------------------------- */
  const p3A = fadeWin(t, [M.DOCS - 0.28, M.DOCS + 0.02, M.P3_OUT, M.P3_OUT + 0.3]);
  const chips = [
    { label: 'DOCUMENTOS', at: M.DOCS, x: 216 },
    { label: 'SITES', at: M.SITES, x: VW / 2 },
    { label: 'MENSAGENS', at: M.MSGS, x: VW - 216 },
  ];
  const stampP = s01(easeHero(t, fps, M.NAO_CONF));
  const stampA = fadeWin(t, [M.NAO_CONF - 0.02, M.NAO_CONF + 0.12, M.P3_OUT, M.P3_OUT + 0.26]);
  const stampShake = impactShake(t, M.NAO_CONF, { amp: 9, dur: 0.24 });
  const hostile = t >= M.NAO_CONF;

  /* ---- fecho: o escudo PROMPT que não segura nada ---------------------------------
   * O escudo se PARTE em duas metades que se afastam — a mesma gramática da fronteira
   * DADO/INSTRUÇÃO da animação técnica. Rima interna proposital: é o mesmo vídeo. */
  const shA = fadeWin(t, [M.PROMPT_W - 0.3, M.PROMPT_W + 0.02, M.SHIELD_OUT, M.SHIELD_OUT + 0.3]);
  const shBorn = s01(easeHeavy(t, fps, M.PROMPT_W - 0.26));
  const pierceP = easeFlow(t, M.PIERCE, M.PIERCE + 0.78);
  const pierceLive = t >= M.PIERCE - 0.02 && t < M.PIERCE + 0.92;
  const breakP = s01(easeHero(t, fps, M.BARREIRA));
  const broken = t >= M.BARREIRA;
  const shShake = impactShake(t, M.BARREIRA, { amp: 10, dur: 0.24 });

  /* ---- CTA ------------------------------------------------------------------------ */
  const ctaA = fadeWin(t, [M.SEGUE - 0.15, M.SEGUE + 0.12, M.END + 1, M.END + 1.1]);
  const ctaP = s01(easeHero(t, fps, M.SEGUE));

  const scrim = Math.max(
    fadeWin(t, [M.TRES - 0.35, M.TRES, M.P3_OUT, M.P3_OUT + 0.3]),
    fadeWin(t, [M.PROMPT_W - 0.5, M.PROMPT_W, M.SHIELD_OUT, M.SHIELD_OUT + 0.3]),
    fadeWin(t, [M.SEGUE - 0.4, M.SEGUE, M.END + 1, M.END + 1.1]),
  );

  return (
    <AbsoluteFill>
      <Scrim alpha={scrim * 0.95} />
      <Tracker t={t} fps={fps} />

      {/* ------------------------------------------------------------------ item 01 */}
      {p1A > 0.005 && (
        <div style={{ position: 'absolute', left: VW / 2, top: 420, opacity: p1A, transform: 'translate(-50%,-50%)' }}>
          <div style={{
            width: 880, display: 'flex', flexDirection: 'column', gap: 14,
            transform: `translateY(${breathe(t, { amp: 2 })}px)`,
          }}>
            {perms.map(p => {
              const born = s01(easeHero(t, fps, p.at));
              if (born <= 0.01) return null;
              const glow = p.ok ? needGlow : 0;
              const c = p.ok ? GREEN : RED;
              return (
                <div key={p.label} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '14px 24px', borderRadius: 12,
                  border: `2px solid ${p.ok ? GREEN : 'rgba(255,77,109,0.55)'}`,
                  background: p.ok ? `rgba(77,255,136,${0.08 + glow * 0.12})` : 'rgba(255,77,109,0.07)',
                  opacity: born, transform: `translateX(${(1 - born) * -34}px)`,
                  boxShadow: glow > 0.02 ? `0 0 ${16 + glow * 22}px ${GREEN}55` : 'none',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                    <div style={{ width: 12, height: 12, borderRadius: 99, background: c, boxShadow: `0 0 12px ${c}` }} />
                    <span style={{ fontFamily: MONO, fontSize: 34, color: WHITE, textShadow: SHADOW }}>{p.label}</span>
                  </div>
                  <span style={{
                    fontFamily: MONO, fontSize: 28, fontWeight: 700, color: c,
                    letterSpacing: '0.06em', textShadow: SHADOW,
                  }}>{p.ok ? '✓ ' : '✕ '}{p.verdict}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ item 02 */}
      {p2A > 0.005 && (
        <div style={{ position: 'absolute', left: 0, top: 0, opacity: p2A }}>
          <Node x={180} y={430} w={240} h={140} label="IA" tone={CYAN} scale={0.95} />
          <div style={{
            position: 'absolute', left: 300, top: 430, height: 3, width: 350,
            transformOrigin: 'left center', transform: `translateY(-50%) scaleX(${easeUI(t, M.PECA, M.PECA + 0.4)})`,
            background: `repeating-linear-gradient(to right, ${STEEL} 0 12px, transparent 12px 22px)`,
          }} />
          <div style={{ transform: `translateX(${gateShake}px)` }}>
            <Node
              x={810} y={430} w={320} h={158} label="SERVIDOR" sub="VALIDA"
              tone={blockA > 0.05 ? GREEN : CYAN}
              glow={blockA * 0.8 + (scanning ? pulse(t, { freq: 2.2 }) * 0.4 : 0.1)}
            />
          </div>
          {/* barra de varredura durante "verifica" */}
          {scanning && (
            <div style={{
              position: 'absolute', left: 656, top: 430 - 72 + scanP * 144,
              width: 308, height: 5, opacity: 0.9, borderRadius: 3,
              background: `linear-gradient(to right, transparent, ${CYAN} 18%, #ffffff 50%, ${CYAN} 82%, transparent)`,
              boxShadow: `0 0 20px ${CYAN}`,
            }} />
          )}
          {flyLive && (
            <Packet x={flyX} y={430} label="AÇÃO" color={t >= M.VEREDITO ? RED : ACCENT}
              smear={interpolate(flyP, [0, 0.3, 0.85, 1], [0, 0.85, 0.4, 0], CLAMP)} />
          )}
          {blockA > 0.005 && (
            <div style={{
              position: 'absolute', left: 810, top: 578, opacity: blockA,
              transform: `translate(-50%,-50%) scale(${0.7 + 0.3 * blockP})`,
              fontFamily: MONO, fontWeight: 700, fontSize: 34, color: RED,
              letterSpacing: '0.07em', textShadow: SHADOW, whiteSpace: 'nowrap',
              border: `2px solid ${RED}`, borderRadius: 8, padding: '6px 18px',
              background: 'rgba(40,4,12,0.45)',
            }}>✕ BLOQUEADO</div>
          )}
        </div>
      )}

      {/* ------------------------------------------------------------------ item 03 */}
      {p3A > 0.005 && (
        <div style={{ position: 'absolute', left: 0, top: 0, opacity: p3A }}>
          {chips.map((c, i) => {
            const born = s01(easeHero(t, fps, c.at));
            if (born <= 0.01) return null;
            return (
              <div key={c.label} style={{
                position: 'absolute', left: c.x, top: 400,
                transform: `translate(-50%,-50%) scale(${0.8 + 0.2 * born}) translateY(${(1 - born) * 22 + breathe(t, { amp: 1.8, phase: i * 0.7 })}px)`,
                opacity: born,
              }}>
                <div style={{
                  width: 302, height: 144, borderRadius: 14,
                  border: `2px ${hostile ? 'dashed' : 'solid'} ${hostile ? RED : STEEL}`,
                  background: hostile ? 'rgba(48,6,16,0.45)' : 'rgba(8,14,26,0.5)',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8,
                }}>
                  {/* glifo simples — documento / janela / balão */}
                  <svg width="40" height="40" viewBox="0 0 40 40">
                    {i === 0 && <g stroke={hostile ? RED : CYAN} strokeWidth="2.6" fill="none">
                      <path d="M11 5h13l6 6v24H11z" /><path d="M24 5v6h6" /><path d="M16 20h11M16 26h11" />
                    </g>}
                    {i === 1 && <g stroke={hostile ? RED : CYAN} strokeWidth="2.6" fill="none">
                      <rect x="6" y="8" width="28" height="23" rx="3" /><path d="M6 15h28" />
                      <circle cx="11" cy="11.5" r="1.4" fill={hostile ? RED : CYAN} stroke="none" />
                    </g>}
                    {i === 2 && <g stroke={hostile ? RED : CYAN} strokeWidth="2.6" fill="none">
                      <path d="M7 9h26v18H18l-7 7v-7H7z" />
                    </g>}
                  </svg>
                  <div style={{
                    fontFamily: FONT, fontWeight: 900, fontSize: 31, letterSpacing: '-0.01em',
                    color: hostile ? RED : WHITE, textShadow: SHADOW, whiteSpace: 'nowrap',
                  }}>{c.label}</div>
                </div>
              </div>
            );
          })}
          {/* carimbo atravessando os três */}
          {stampA > 0.005 && (
            <div style={{
              position: 'absolute', left: VW / 2, top: 512, opacity: stampA,
              transform: `translate(-50%,-50%) rotate(-3.5deg) scale(${0.78 + 0.22 * stampP}) translateX(${stampShake}px)`,
            }}>
              <div style={{
                fontFamily: FONT, fontWeight: 900, fontSize: 60, color: RED,
                letterSpacing: '-0.02em', whiteSpace: 'nowrap', textShadow: SHADOW,
                border: `5px solid ${RED}`, borderRadius: 10, padding: '6px 28px',
                background: 'rgba(30,2,10,0.62)',
              }}>NÃO CONFIÁVEL</div>
              <Shards t={t} at={M.NAO_CONF} x={0} y={50} n={5} spread={230} />
            </div>
          )}
        </div>
      )}

      {/* --------------------------------------------------------------- o escudo */}
      {shA > 0.005 && (
        <div style={{
          position: 'absolute', left: VW / 2, top: 400, opacity: shA,
          transform: `translate(-50%,-50%) translateX(${shShake}px)`,
        }}>
          {[-1, 1].map(dir => (
            /* A JANELA de recorte é que se move, não o desenho dentro dela.
             * Animar o <svg> dentro de um overflow:hidden fixo faz a arte DESLIZAR atrás de
             * um buraco parado — o escudo lia como amassado com um entalhe, nunca como
             * partido ao meio. Movendo a janela, cada metade é uma peça rígida.
             * transformOrigin no centro do ESCUDO (borda interna de cada metade) mantém as
             * duas coladas durante a entrada, quando o scale ainda está subindo. */
            <div key={dir} style={{
              position: 'absolute', left: dir < 0 ? -95 : 95, top: 0,
              width: 190, height: 380, overflow: 'hidden',
              transform: `translate(-50%,-50%) translateX(${breakP * dir * 96}px)`
                + ` rotate(${breakP * dir * 7}deg) scale(${0.82 + 0.18 * shBorn})`,
              transformOrigin: dir < 0 ? '100% 50%' : '0% 50%',
            }}>
              <div style={{
                position: 'absolute', left: dir < 0 ? 0 : -190, top: 0, width: 380, height: 380,
              }}>
                <svg width="380" height="380" viewBox="0 0 300 300">
                  <path d="M150 18 L272 62 V158 C272 218 216 264 150 284 C84 264 28 218 28 158 V62 Z"
                    fill={broken ? 'rgba(48,6,16,0.45)' : 'rgba(8,20,34,0.5)'}
                    stroke={broken ? RED : CYAN} strokeWidth="4" />
                </svg>
              </div>
            </div>
          ))}
          <div style={{
            position: 'absolute', left: 0, top: 0, transform: 'translate(-50%,-50%)',
            fontFamily: FONT, fontWeight: 900, fontSize: 52, whiteSpace: 'nowrap',
            color: broken ? RED : WHITE, letterSpacing: '-0.02em', textShadow: SHADOW,
            opacity: shBorn * (broken ? interpolate(t, [M.BARREIRA, M.BARREIRA + 0.3], [1, 0.78], CLAMP) : 1),
          }}>PROMPT</div>

          {/* a instrução que atravessa: entra pela esquerda e SAI pela direita */}
          {pierceLive && (
            <Packet
              x={interpolate(pierceP, [0, 1], [-580, 580], CLAMP)} y={86}
              label="INSTRUÇÃO" color={RED}
              smear={interpolate(pierceP, [0, 0.25, 0.8, 1], [0.2, 0.95, 0.7, 0.2], CLAMP)}
            />
          )}
          <Shards t={t} at={M.BARREIRA} x={0} y={0} n={5} spread={240} />
        </div>
      )}

      {/* ------------------------------------------------------------------- CTA */}
      {ctaA > 0.005 && (
        <div style={{
          position: 'absolute', left: VW / 2, top: 400, opacity: ctaA,
          transform: `translate(-50%,-50%) scale(${0.82 + 0.18 * ctaP}) translateY(${settleWobble(t, M.SEGUE + 0.2, { amp: 3 })}px)`,
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16,
        }}>
          <div style={{
            fontFamily: FONT, fontWeight: 900, fontSize: 88, color: GREEN,
            letterSpacing: '-0.035em', textShadow: SHADOW, whiteSpace: 'nowrap',
          }}>@DECKDEV</div>
          <div style={{
            fontFamily: MONO, fontSize: 28, color: STEEL, letterSpacing: '0.16em',
            textShadow: SHADOW, opacity: easeUI(t, M.SEGUE + 0.18, M.SEGUE + 0.5),
          }}>EM TODAS AS REDES</div>
        </div>
      )}
    </AbsoluteFill>
  );
}

/* ---------------------------------------------------------------------------------- */

export function PiCam({ part = 'hook', bg = null }) {
  return (
    <AbsoluteFill style={{ background: bg === null ? 'transparent' : (bg || PREVIEW_BG) }}>
      {part === 'mit' ? <MitGraphics /> : <HookGraphics />}
    </AbsoluteFill>
  );
}

/** O overlay que vai para o compositor: motion semântico + legenda, num render só.
 *
 *  Dois renders separados custariam dois passes de ProRes 4444 de 1080x1920 e uma segunda
 *  composição em `add-overlay` — e abririam a chance de as duas camadas saírem de sincronia.
 *  Como as duas leem o MESMO tempo de composição, juntá-las aqui é o caminho seguro.
 *
 *  `blocks` vem de remotion/data/pi-<part>.json (o tool aceita --props <arquivo>), então mexer
 *  numa legenda é editar dados, não código.
 */
export function PiOverlay({ part = 'hook', blocks = [], bg = null }) {
  return (
    <AbsoluteFill style={{ background: bg === null ? 'transparent' : (bg || PREVIEW_BG) }}>
      <PiCam part={part} bg={null} />
      <DeckCaption blocks={blocks} />
    </AbsoluteFill>
  );
}
