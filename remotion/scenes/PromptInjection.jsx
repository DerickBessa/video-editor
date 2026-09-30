// Reel: Prompt Injection — a arquitetura de uma aplicação de IA, e como um dado vira instrução.
//
// DIFERENÇA ESTRUTURAL PARA A VINHETA ANTERIOR (BruteForceRaceCondition):
// aquela é uma `<Series>` de cenas que se sucedem. Esta NÃO é. Aqui existe **um único espaço
// visual** — um mundo 2.5D em coordenadas absolutas — e uma **câmera** que navega por ele.
// Nenhum elemento "aparece do nada por corte": ele nasce em algum ponto do mundo, a câmera vai
// até ele, e ele se transforma no elemento seguinte. É isso que separa motion design de
// apresentação de slides, e foi o pedido explícito.
//
// Consequência prática: todo componente recebe o TEMPO GLOBAL `t` (segundos desde o frame 0) e
// decide sozinho seu ciclo de vida. Não há `useCurrentFrame()` relativo a uma Sequence.
//
// TIMING É AUTORADO EM SEGUNDOS (nunca em frames), convertido por `useVideoConfig().fps` na
// leitura — o mesmo fonte renderiza a 30fps (draft) e 60fps (entrega) sem timing dobrar.
import React, { useEffect, useState } from 'react';
import {
  AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring, random,
  Easing, delayRender, continueRender,
} from 'remotion';

/* ------------------------------------------------------------------ tokens */

const FONT = '"Segoe UI", Inter, system-ui, -apple-system, sans-serif';
const MONO = '"Cascadia Code", "JetBrains Mono", Consolas, "Courier New", monospace';

// Paleta deliberadamente CURTA — três papéis, nada decorativo.
const ACCENT = '#FFD400';                 // amarelo da casa: o fluxo vivo, o que está acontecendo
const WHITE  = '#ffffff';                 // texto principal
const RED    = '#ff4d6d';                 // a injeção — e SÓ a injeção
const STEEL  = '#8FA3BF';                 // estrutura inerte: bordas, rótulos, arestas dormentes
const STEEL_DIM = 'rgba(143,163,191,0.26)';
const PREVIEW_BG = '#05070C';             // preview apenas; a entrega renderiza com bg={null}

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' };

// 9:16. Mesma safe area da casa: 60px de cada lado, 960px úteis.
const SAFE_X = 60;
const VW = 1080, VH = 1920;

/* --------------------------------------------------------------- time base */

function useT() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return { t: frame / fps, fps, frame };
}

/* -------------------------------------------------------- easing vocabulary */
//
// Um preset só para tudo é o que faz motion parecer "componente React transicionando".
// Cada família abaixo serve a um tipo de objeto, com massa diferente.

/** HERO: termo técnico entrando. Rápido, overshoot curto, assenta firme. */
function easeHero(t, fps, delay = 0) {
  return spring({ frame: (t - delay) * fps, fps, config: { damping: 13, mass: 0.5, stiffness: 220 } });
}
/** UI/chrome: sem overshoot. Interface não quica. */
function easeUI(t, from, to) {
  return interpolate(t, [from, to], [0, 1], { ...CLAMP, easing: Easing.out(Easing.cubic) });
}
/** Painel pesado (camada de sistema, card grande): inércia visível. */
function easeHeavy(t, fps, delay = 0) {
  return spring({ frame: (t - delay) * fps, fps, config: { damping: 26, mass: 1.6, stiffness: 90 } });
}
/** Pacote de dados percorrendo o pipeline: ganha velocidade e assenta. */
function easeFlow(t, from, to) {
  return interpolate(t, [from, to], [0, 1], { ...CLAMP, easing: Easing.inOut(Easing.cubic) });
}
/** Elemento de baixa atenção. */
function easeMicro(t, from, to) {
  return interpolate(t, [from, to], [0, 1], { ...CLAMP, easing: Easing.out(Easing.quad) });
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

/** Janela de fade em segundos. Paradas forçadas estritamente crescentes: `interpolate` lança
 *  exceção em range não-monotônico, e derrubar o render é pior que um fade de duração zero. */
function fadeWin(t, stops) {
  const EPS = 1e-4;
  const r = [stops[0]];
  for (let i = 1; i < 4; i++) r.push(Math.max(stops[i], r[i - 1] + EPS));
  return interpolate(t, r, [0, 1, 1, 0], CLAMP);
}

/** Respiração: micro-movimento para nada ficar morto na tela. Amplitude em px, 1–3. */
function breathe(t, { amp = 2, freq = 0.32, phase = 0 } = {}) {
  return Math.sin((t + phase) * freq * Math.PI * 2) * amp;
}

/** Glow pulsando — mesma ideia, no brilho. Retorna 0..1. */
function pulse(t, { freq = 0.5, phase = 0 } = {}) {
  return 0.5 + 0.5 * Math.sin((t + phase) * freq * Math.PI * 2);
}

/* =====================================================================================
 * BEATS — cravados na narração retimada `temp/pi-narr-tight.mp3` (87,36s).
 *
 * Cada número abaixo é o ONSET REAL de uma palavra nessa gravação, medido em
 * `temp/pi-narr-tight.json`. São medições, não preferências: não arredondar.
 *
 * Origem do arquivo (reproduzível):
 *   1. `narração do video prompt injection.m4a` (96,5s) — o take bruto
 *   2. tomada falha removida: 64,95s–71,60s (ele erra "…que a IA lê", para e refaz)
 *   3. `scripts/retime-narration.mjs` + `temp/pi-retime.json` (respiratórias -> 0,20s,
 *      13 pausas dramáticas protegidas ou estendidas)
 *   4. re-transcrito: os tempos mudaram, e a animação ancora nos NOVOS
 * ===================================================================================== */

export const BEATS = {
  // ato 1 — a interface de chat
  open:            0.00,   // "Primeiro,"            — a UI já existe; a frase entra nela
  appWord:         1.22,   // "aplicação"
  modelWord:       2.98,   // "modelo"               — o LLM aparece lá embaixo, como destino
  questionFires:   4.08,   // "pergunta."            — o balão vira pacote e dispara

  // ato 2 — o pipeline se expande
  pullBack:        4.92,   // "Geralmente,"          — a câmera RECUA; o pacote fica suspenso
  stepsWord:       5.56,   // "existe uma série"     — os nós se constroem um a um
  etapas:          6.56,   // "etapas"
  chegarWord:      8.20,   // "chegar"
  usuarioWord:     8.68,   // "usuário."             — RESPOSTA fecha a cadeia
  manyApps:        9.44,   // "Muitas aplicações"

  // ato 3 — RAG
  ragWord:        11.64,   // "RAG."                 — o termo aterrissa sozinho
  ragOpens:       12.94,   // "RAG é quando"         — CONTEXTO se abre; entramos nele
  buscaWord:      14.72,   // "busca"                — o retrieval dispara
  externasWord:   15.80,   // "externas,"
  docsWord:       16.92,   // "documentos,"          — cada fonte entra NA palavra
  pdfsWord:       17.84,   // "PDFs"
  baseWord:       19.00,   // "base de conhecimento"
  mandaWord:      20.54,   // "manda esse conteúdo"  — os selecionados viram blocos
  perguntaSum:    22.56,   // "sua pergunta"         — PERGUNTA + DOCUMENTOS = CONTEXTO
  towardsLlm:     23.04,   // "para a IA"            — o contexto segue para o LLM

  // ato 4 — System Prompt
  alemDisso:      23.46,   // "Além disso,"          — a câmera procura a camada de cima
  systemWord:     25.96,   // "System"               — SYSTEM PROMPT revela
  promptWord:     26.40,   // "Prompt,"
  rule1:          28.20,   // "instruções"           — regra 1 digita
  rule2:          29.90,   // "deve se comportar"    — regra 2 digita
  bothArrive:     30.52,   // "comportar."           — SYSTEM e USER descem ao mesmo contexto

  // ato 5 — o problema
  problemWord:    31.50,   // "Agora vem o problema."
  problemLands:   32.44,   // "problema."            — a linha vermelha entra no sistema
  userSource:     33.38,   // "Tanto o usuário"
  docSource:      35.00,   // "um documento recuperado pelo RAG"
  inserirWord:    37.28,   // "inserir"
  maliciosa:      38.44,   // "maliciosa"            — "IGNORE AS INSTRUÇÕES ANTERIORES"
  intoContext:    39.68,   // "contexto."            — a instrução entra no contexto

  // ato 6 — DADO -> INSTRUÇÃO (a transição central)
  aquiloWord:     40.62,   // "Aquilo deveria ser interpretado"
  dadoWord:       43.84,   // "dado,"                — o bloco DADO, e ele parece seguro
  masWord:        44.42,   // "mas o modelo"
  interpretar:    45.88,   // "interpretar"          — a fronteira começa a ceder
  instrucaoWord:  47.08,   // "instrução."           — DADO vira INSTRUÇÃO

  // ato 7 — DIRECT
  seProprio:      47.70,   // "Se o próprio usuário"  — voltamos ao usuário, no mesmo diagrama
  enviaWord:      49.60,   // "envia essa instrução"
  directWord:     51.92,   // "Direct"
  injectionWord:  53.02,   // "Injection."

  // ato 8 — impacto
  impactoWord:    55.04,   // "impacto"
  manipularWord:  56.62,   // "manipular"            — a resposta é reescrita ao vivo
  respostaWord:   57.64,   // "resposta"
  exporWord:      58.90,   // "expor"                — os cards de dados aparecem atrás
  sensiveisWord:  60.10,   // "sensíveis"
  contextoApp:    62.70,   // "contexto da aplicação" — eles tentam atravessar a saída

  // ato 9 — INDIRECT
  agoraSe:        64.08,   // "Agora,"               — a câmera se afasta para FORA da aplicação
  escondidaWord:  66.30,   // "escondida"            — a instrução dentro do documento
  pdfWord:        67.10,   // "PDF,"
  siteWord:       67.82,   // "site"
  mailWord:       68.76,   // "e-mail"
  lerWord:        69.32,   // "ler,"                 — o RAG puxa o documento externo
  indirectWord:   70.50,   // "Indirect"
  indirectEnd:    71.68,   // "Injection."

  // ato 10 — agente e ferramentas
  perigosoWord:   72.54,   // "E aqui fica ainda mais perigoso."
  agenteWord:     76.52,   // "agente"               — o LLM vira nó central
  apisWord:       77.62,   // "APIs,"                — cada ferramenta entra NA sua palavra
  mailsWord:      78.56,   // "e-mails,"
  arquivosWord:   79.06,   // "arquivos"
  sistemasWord:   79.82,   // "outros sistemas,"
  injecaoWord:    81.32,   // "a injeção"            — ela percorre PROMPT -> AGENTE -> TOOL
  executeWord:    83.48,   // "execute"
  acaoWord:       84.08,   // "uma ação"             — a tool recebe a chamada; alerta
  atacanteWord:   85.08,   // "o atacante"
  endWord:        86.66,   // "realizar."            — frame conceitual final
};

/** Duração total. A narração termina em 87,14s; o frame conceitual final segura mais ~1,9s
 *  para o corte de volta para a câmera não atropelar a última palavra. */
export const TOTAL_SECONDS = 89.0;

/* ===================================================================== world primitives */
//
// O mundo é um plano 2D em coordenadas absolutas (px na escala 1). A câmera anda por ele.
// Nada aqui usa `<Series>`: não existem cenas que se substituem, existe UM espaço e um ponto
// de vista que se move. Cada elemento decide sozinho quando nasce, transforma e morre, sempre
// a partir do tempo GLOBAL.

/** Meia-extensão do SVG de mundo. Grande o bastante para conter o documento externo do ato
 *  INDIRECT, que vive fora da fronteira da aplicação. */
const WORLD = 2400;

/** SVG em coordenadas de mundo: (0,0) do viewBox = origem do mundo. */
function WorldSvg({ children, style }) {
  return (
    <svg
      width={WORLD * 2}
      height={WORLD * 2}
      viewBox={`${-WORLD} ${-WORLD} ${WORLD * 2} ${WORLD * 2}`}
      style={{ position: 'absolute', left: -WORLD, top: -WORLD, overflow: 'visible', ...style }}
    >
      {children}
    </svg>
  );
}

/** Caixa posicionada pelo CENTRO em coordenadas de mundo. */
function Box({ x, y, w, h, style, children }) {
  return (
    <div style={{
      position: 'absolute', left: x - w / 2, top: y - h / 2, width: w, height: h,
      boxSizing: 'border-box', ...style,
    }}>{children}</div>
  );
}

/* ------------------------------------------------------------------ bezier deterministico */
//
// `<animateMotion>` do SVG não é determinístico frame a frame num render headless — a posição
// depende do relógio do documento, não do frame. Todo movimento sobre curva é calculado aqui.

const cub = (a, b, c, d, u) => {
  const m = 1 - u;
  return m * m * m * a + 3 * m * m * u * b + 3 * m * u * u * c + u * u * u * d;
};
const bezPoint = (P, u) => ({
  x: cub(P[0].x, P[1].x, P[2].x, P[3].x, u),
  y: cub(P[0].y, P[1].y, P[2].y, P[3].y, u),
});
const bezPath = P => `M ${P[0].x} ${P[0].y} C ${P[1].x} ${P[1].y}, ${P[2].x} ${P[2].y}, ${P[3].x} ${P[3].y}`;

/** Curva que SAI e CHEGA na vertical — o formato de ligação do pipeline. */
function curveV(from, to, k = 0.5) {
  const dy = to.y - from.y;
  return [from, { x: from.x, y: from.y + dy * k }, { x: to.x, y: to.y - dy * k }, to];
}
/** Curva que sai na horizontal e chega na vertical — fontes externas convergindo. */
function curveHV(from, to, k = 0.6) {
  const dx = to.x - from.x, dy = to.y - from.y;
  return [from, { x: from.x + dx * k, y: from.y }, { x: to.x, y: to.y - dy * k }, to];
}

/* ------------------------------------------------------------------------------- arestas */

/** Aresta que SE DESENHA. `p` 0..1 controla o quanto já foi traçado.
 *  `pathLength="1"` normaliza qualquer curva, então o mesmo dash serve para todas. */
function Edge({ P, p = 1, color = STEEL_DIM, width = 2, dash = null, glow = 0, opacity = 1 }) {
  if (p <= 0.001) return null;
  return (
    <>
      {glow > 0 && (
        <path d={bezPath(P)} fill="none" stroke={color} strokeWidth={width + 7}
          opacity={opacity * glow * 0.16} pathLength="1"
          strokeDasharray="1 1" strokeDashoffset={1 - p} strokeLinecap="round" />
      )}
      <path
        d={bezPath(P)} fill="none" stroke={color} strokeWidth={width} opacity={opacity}
        pathLength="1"
        strokeDasharray={dash ? dash : '1 1'}
        strokeDashoffset={dash ? 0 : 1 - p}
        strokeLinecap="round"
      />
    </>
  );
}

/** Ponta de seta no fim de uma curva, orientada pela tangente real. */
function ArrowHead({ P, at = 1, color = STEEL, size = 11, opacity = 1 }) {
  const a = bezPoint(P, Math.max(0, at - 0.02));
  const b = bezPoint(P, at);
  const ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  return (
    <g transform={`translate(${b.x} ${b.y}) rotate(${ang})`} opacity={opacity}>
      <path d={`M ${-size} ${-size * 0.62} L 0 0 L ${-size} ${size * 0.62}`}
        fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
    </g>
  );
}

/* --------------------------------------------------------------------------------- cards */

/** Card de sistema. Vocabulário visual da casa para "um nó de arquitetura":
 *  fundo quase preto, borda fina, cantos marcados, rótulo em mono espaçado.
 *  `active` (0..1) acende a borda e o glow — é assim que o nó "de que estamos falando"
 *  domina a atenção sem que nada mais se mexa. */
function NodeCard({
  x, y, w = 330, h = 116, label, sub, icon: Icon, accent = ACCENT,
  active = 0, appear = 1, t = 0, float = 0, dim = 0, danger = 0, children, style,
}) {
  if (appear <= 0.002) return null;
  const col = danger > 0.5 ? RED : accent;
  const border = `rgba(${danger > 0.5 ? '255,77,109' : '143,163,191'}, ${0.20 + active * 0.0})`;
  const bob = float ? breathe(t, { amp: float, freq: 0.24, phase: x * 0.01 }) : 0;
  return (
    <Box x={x} y={y + bob} w={w} h={h} style={{
      opacity: appear * (1 - dim * 0.82),
      transform: `scale(${0.88 + 0.12 * appear})`,
      ...style,
    }}>
      <div style={{
        position: 'absolute', inset: 0, borderRadius: 16,
        background: 'linear-gradient(180deg, rgba(16,22,34,0.94) 0%, rgba(9,12,20,0.94) 100%)',
        border: `1.5px solid ${border}`,
        boxShadow: active > 0.01
          ? `0 0 ${24 + active * 34}px ${col}${active > 0.6 ? '3a' : '22'}, inset 0 1px 0 rgba(255,255,255,0.05)`
          : 'inset 0 1px 0 rgba(255,255,255,0.04)',
      }} />
      {/* borda ativa desenhada por cima, para o acender não mexer no layout */}
      {active > 0.01 && (
        <div style={{
          position: 'absolute', inset: 0, borderRadius: 16,
          border: `1.5px solid ${col}`, opacity: active,
        }} />
      )}
      {/* cantos — o detalhe que faz ler como interface, não como retângulo */}
      {[[0, 0], [1, 0], [0, 1], [1, 1]].map(([cx, cy], i) => (
        <div key={i} style={{
          position: 'absolute', width: 12, height: 12,
          left: cx ? undefined : 9, right: cx ? 9 : undefined,
          top: cy ? undefined : 9, bottom: cy ? 9 : undefined,
          borderTop: cy ? 'none' : `2px solid ${col}`,
          borderBottom: cy ? `2px solid ${col}` : 'none',
          borderLeft: cx ? 'none' : `2px solid ${col}`,
          borderRight: cx ? `2px solid ${col}` : 'none',
          opacity: 0.25 + active * 0.65,
        }} />
      ))}
      <div style={{
        position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
        justifyContent: 'center', gap: 14, padding: '0 18px',
      }}>
        {Icon && <Icon size={h * 0.32} color={active > 0.3 ? col : STEEL} strokeWidth={1.5} />}
        <div style={{ textAlign: Icon ? 'left' : 'center' }}>
          <div style={{
            fontFamily: MONO, fontWeight: 700, fontSize: h * 0.235, letterSpacing: '0.13em',
            color: active > 0.3 ? WHITE : 'rgba(255,255,255,0.72)', whiteSpace: 'nowrap',
          }}>{label}</div>
          {sub && (
            <div style={{
              fontFamily: MONO, fontSize: h * 0.155, letterSpacing: '0.08em',
              color: active > 0.3 ? col : STEEL, marginTop: 4, opacity: 0.85, whiteSpace: 'nowrap',
            }}>{sub}</div>
          )}
        </div>
      </div>
      {children}
    </Box>
  );
}

/* --------------------------------------------------------------------- tipografia cinética */

/** Termo técnico entrando. Não é fade: as letras SOBEM de dentro de uma máscara, com stagger,
 *  e uma régua se desenha por baixo. Curto e marcante — depois o termo VIRA rótulo do diagrama
 *  (via `to`), em vez de sumir e ser substituído por outra coisa. */
function TermReveal({
  text, at, t, from, to = null, color = ACCENT, sub = null, out = null, mono = false,
}) {
  const { fps } = useT();
  const dt = t - at;
  if (dt < -0.02) return null;

  // morph hero -> rótulo no diagrama
  const m = to ? easeFlow(t, to.at, to.at + (to.dur ?? 0.7)) : 0;
  const x = from.x + (to ? (to.x - from.x) * m : 0);
  const y = from.y + (to ? (to.y - from.y) * m : 0);
  const size = from.size + (to ? (to.size - from.size) * m : 0);

  const alive = out ? fadeWin(t, [at - 0.02, at + 0.06, out - 0.28, out]) : easeMicro(t, at - 0.02, at + 0.08);
  if (alive <= 0.004) return null;

  const chars = [...text];
  const rule = easeUI(t, at + 0.10, at + 0.44);
  const wob = settleWobble(t, at + 0.26, { amp: 2.0, freq: 6.5 });

  return (
    <div style={{
      position: 'absolute', left: x, top: y + wob, transform: 'translate(-50%,-50%)',
      opacity: alive, display: 'flex', flexDirection: 'column', alignItems: 'center',
      whiteSpace: 'nowrap', pointerEvents: 'none',
    }}>
      <div style={{ display: 'flex', overflow: 'hidden', paddingBottom: size * 0.1 }}>
        {chars.map((c, i) => {
          const p = easeHero(t, fps, at + i * 0.028);
          return (
            <span key={i} style={{
              display: 'inline-block',
              transform: `translateY(${(1 - p) * size * 1.05}px)`,
              fontFamily: mono ? MONO : FONT, fontWeight: mono ? 700 : 900,
              fontSize: size, lineHeight: 1.02, color,
              letterSpacing: mono ? '0.08em' : '-0.02em',
              textShadow: `0 0 ${size * 0.45}px ${color}44`,
            }}>{c === ' ' ? ' ' : c}</span>
          );
        })}
      </div>
      <div style={{
        height: 2, width: `${rule * 100}%`, background: color, opacity: 0.85 * (1 - m * 0.75),
        marginTop: size * 0.06, alignSelf: 'center',
      }} />
      {sub && (
        <div style={{
          fontFamily: MONO, fontSize: size * 0.2, letterSpacing: '0.22em', color: STEEL,
          marginTop: size * 0.16, opacity: easeUI(t, at + 0.26, at + 0.6) * (1 - m),
        }}>{sub}</div>
      )}
    </div>
  );
}

/** Linha digitada com cursor. Usada só onde o conteúdo É texto de sistema (as regras do
 *  System Prompt, a instrução maliciosa dentro do documento). */
function TypeLine({ text, at, t, cps = 26, size = 22, color = 'rgba(255,255,255,0.80)', cursor = true }) {
  const dt = t - at;
  if (dt < 0) return null;
  const n = Math.min(text.length, Math.floor(dt * cps));
  const done = n >= text.length;
  const blink = Math.floor((t - at) * 2.2) % 2 === 0;
  return (
    <div style={{ fontFamily: MONO, fontSize: size, color, letterSpacing: '0.02em', lineHeight: 1.5 }}>
      {text.slice(0, n)}
      {cursor && (!done || blink) && (
        <span style={{
          display: 'inline-block', width: size * 0.5, height: size * 0.98, background: ACCENT,
          opacity: done ? (blink ? 0.9 : 0) : 0.9, transform: 'translateY(2px)', marginLeft: 2,
        }} />
      )}
    </div>
  );
}

/* --------------------------------------------------------------------------- pacote/fluxo */

/** O pacote de dados. É o mesmo objeto do começo ao fim do vídeo: nasce como a mensagem do
 *  usuário, atravessa o pipeline, entra no contexto, e mais tarde é ele que carrega a
 *  instrução maliciosa. Por isso ele tem `label` e `color` variáveis, e não versões diferentes.
 *
 *  Smear direcional feito à mão (não `<Trail>`: ver docs/MOTION-HOUSE-STYLE.md §9). */
function Packet({ x, y, label = null, color = ACCENT, speed = 0, scale = 1, opacity = 1, angle = 0 }) {
  if (opacity <= 0.004) return null;
  const w = label ? 20 + label.length * 13 : 30;
  const h = 34;
  const body = (
    <div style={{
      width: w * scale, height: h * scale, borderRadius: 999,
      background: color, boxShadow: `0 0 ${26 * scale}px ${color}88`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: MONO, fontWeight: 800, fontSize: 17 * scale, color: '#0a0d14',
      letterSpacing: '0.08em', whiteSpace: 'nowrap',
    }}>{label}</div>
  );
  return (
    <div style={{
      position: 'absolute', left: x, top: y, opacity,
      transform: `translate(-50%,-50%) rotate(${angle}deg)`,
    }}>
      {speed > 0.05 && (
        <div style={{ position: 'absolute', inset: 0 }}>
          {[1, 2, 3].map(i => (
            <div key={i} style={{
              position: 'absolute', inset: 0,
              transform: `translateY(${-i * 22 * speed}px)`,
              opacity: (0.30 / i) * opacity,
              filter: `blur(${i * 1.5}px)`,
            }}>{body}</div>
          ))}
        </div>
      )}
      {body}
    </div>
  );
}

/* ------------------------------------------------------------------------------- ambiente */

/** Grade técnica de fundo. Existe para dar profundidade e para a câmera ter contra o quê se
 *  mover — sem ela um pan sobre fundo liso é invisível. Fica num plano de parallax mais lento. */
function GridField({ t, tint = ACCENT, heat = 0 }) {
  const drift = (t * 7) % 90;
  return (
    <AbsoluteFill style={{ opacity: 0.55 }}>
      <AbsoluteFill style={{
        backgroundImage:
          `linear-gradient(rgba(143,163,191,0.055) 1px, transparent 1px),` +
          `linear-gradient(90deg, rgba(143,163,191,0.055) 1px, transparent 1px)`,
        backgroundSize: '90px 90px',
        backgroundPosition: `${drift}px ${drift}px`,
      }} />
      {/* luz lenta atravessando — o frame nunca fica quimicamente estático */}
      <AbsoluteFill style={{
        background:
          `radial-gradient(760px 900px at ${50 + Math.sin(t * 0.13) * 22}% ${38 + Math.cos(t * 0.1) * 18}%,` +
          ` ${tint}${heat > 0.5 ? '16' : '0e'} 0%, transparent 70%)`,
      }} />
    </AbsoluteFill>
  );
}

/** Partículas discretas. Densidade percebida > contagem literal: poucas, lentas, pequenas. */
function Motes({ t, count = 26, color = STEEL, seed = 'm' }) {
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {Array.from({ length: count }).map((_, i) => {
        const s = `${seed}-${i}`;
        const life = 6 + random(s + 'l') * 6;
        const born = random(s + 'b') * life;
        const age = (t + born) % life;
        const op = fadeWin(age, [0, 1.1, life - 1.4, life]) * (0.10 + random(s + 'o') * 0.22);
        if (op <= 0.004) return null;
        const x = random(s + 'x') * 100;
        const y = random(s + 'y') * 100 - age * (0.10 + random(s + 'v') * 0.22);
        const r = 1.6 + random(s + 'r') * 2.4;
        return (
          <div key={i} style={{
            position: 'absolute', left: `${x}%`, top: `${((y % 100) + 100) % 100}%`,
            width: r, height: r, borderRadius: '50%', background: color, opacity: op,
          }} />
        );
      })}
    </AbsoluteFill>
  );
}

/* ===================================================================== mapa do mundo */
//
// Tudo vive num único plano. A câmera navega; nada "corta". As coordenadas abaixo são o
// layout inteiro do vídeo — dá para ler a arquitetura do Reel só olhando esta tabela.

const B = BEATS;

/** A coluna do pipeline. Espaçamento de 310px entre centros, card de 116px de altura:
 *  194px de respiro entre nós, que é o que permite a aresta existir e ser lida. */
const N = {
  user:   { x: 0, y: -620 },
  app:    { x: 0, y: -310 },
  ctx:    { x: 0, y:    0 },
  llm:    { x: 0, y:  310 },
  answer: { x: 0, y:  620 },
};

/** Fontes do RAG — entram de pontos diferentes da tela, como pedido. */
const SRC = {
  docs: { x: -338, y: -455, label: 'DOCUMENTOS' },
  pdfs: { x:  338, y: -455, label: 'PDFs' },
  base: { x: -338, y:  455, label: 'BASE DE CONHECIMENTO' },
  db:   { x:  338, y:  455, label: 'BANCO DE DADOS' },
};

/** Camada privilegiada: fora da coluna, acima e à direita. Ela desce para o MESMO contexto. */
const SYS = { x: 300, y: -900 };

/** Fronteira da aplicação — só aparece quando a câmera se afasta, no ato INDIRECT. */
const BOUNDARY = { x: 0, y: -60, w: 980, h: 1640 };

/** O documento externo vive FORA dessa fronteira. É esse o ponto do ato. */
const EXTDOC = { x: -700, y: 1190 };

/** Ferramentas do agente, em anel em volta do LLM. */
// Todas abaixo do agente. Em anel completo, duas ferramentas caem na mesma faixa horizontal do
// nó CONTEXTO — e aí o espectador lê "API ao lado do contexto" em vez de "API pendurada no
// agente". Em 9:16 não há largura para resolver isso de outro jeito.
const TOOLS = [
  { key: 'api',    label: 'API',             x: -385, y:  560, at: B.apisWord },
  { key: 'mail',   label: 'E-MAIL',          x:  385, y:  560, at: B.mailsWord },
  { key: 'files',  label: 'ARQUIVOS',        x: -385, y:  810, at: B.arquivosWord },
  { key: 'db',     label: 'BANCO DE DADOS',  x:  385, y:  810, at: B.sistemasWord },
  { key: 'sys',    label: 'SISTEMA INTERNO', x:    0, y: 1010, at: B.sistemasWord + 0.30 },
];

/* ------------------------------------------------------------------------------ câmera */
//
// UMA câmera contínua, com keyframes em segundos. É ela que costura o vídeo: não existe
// "cena 3", existe o momento em que a câmera entra no nó CONTEXTO. Cada keyframe existe
// porque a narração pede um ponto de vista diferente — nenhum movimento é decorativo.
//
// Regra de composição: `z` é escolhido para que o conteúdo do momento caiba nos 960px úteis
// (1080 - 2*60). Largura visível = 1080 / z.

const CAM_KEYS = [
  //   t                        x     y      z    por quê
  [0.00,                        0,  -360, 1.00],  // a conversa, com o LLM já visível lá embaixo
  [B.modelWord,                 0,  -300, 1.02],  // o destino ganha peso
  [B.questionFires,             0,  -240, 1.04],  // a pergunta dispara
  [B.pullBack,                  0,  -150, 0.92],  // começa a recuar
  [B.pullBack + 0.9,            0,     0, 0.74],  // o fluxo se expande: a cadeia inteira em quadro
  [B.usuarioWord + 0.5,         0,     0, 0.74],
  [B.ragWord - 0.35,            0,     0, 0.78],  // um respiro para o termo RAG aterrissar
  [B.ragOpens,                  0,     0, 0.90],  // entrando no nó CONTEXTO
  [B.buscaWord,                 0,     0, 0.92],
  [B.mandaWord,                 0,     0, 0.94],
  [B.towardsLlm,                0,    60, 0.90],  // o contexto segue para o LLM
  [B.alemDisso + 0.5,         150,  -430, 0.72],  // a câmera sobe e acha a camada privilegiada
  [B.systemWord,              190,  -640, 0.80],  // SYSTEM PROMPT domina o quadro
  [B.rule2,                   170,  -560, 0.78],
  [B.bothArrive,               90,  -300, 0.70],  // recua: os dois caminhos chegam ao contexto
  [B.problemWord,               0,   -60, 0.86],  // o clima muda; fecha sobre o contexto
  [B.userSource,                0,  -200, 0.76],  // as duas origens possíveis
  [B.inserirWord,               0,   -40, 0.94],
  [B.intoContext,               0,     0, 1.00],  // dentro do contexto
  [B.aquiloWord,                0,     0, 1.06],  // o bloco DADO
  [B.instrucaoWord,             0,     0, 1.10],  // a fronteira cede
  [B.instrucaoWord + 0.10,      0,     0, 1.12],  // segura no bloco recém-transformado
  [48.70,                       0,  -230, 0.74],  // só então volta ao usuário, no MESMO diagrama
  [B.directWord,                0,  -170, 0.78],
  [B.impactoWord,               0,   330, 0.86],  // desce para a saída do modelo
  [B.exporWord,                 0,   430, 0.80],  // os dados sensíveis atrás da resposta
  [B.contextoApp,               0,   470, 0.78],
  [B.agoraSe,                   0,   240, 0.58],  // AFASTA: a fronteira da aplicação aparece
  [B.agoraSe + 1.35,         -340,   770, 0.50],  // o documento externo, fora dela
  [B.escondidaWord,          -700,  1190, 0.78],  // ENTRA nele: a instrução tem que ser LIDA
  [B.mailWord,               -690,  1170, 0.80],
  [B.lerWord,                -430,   780, 0.56],  // recua enquanto ele é puxado para dentro
  [B.indirectWord,            -80,   240, 0.60],
  [B.perigosoWord,              0,   300, 0.70],  // o LLM vira o centro
  [B.agenteWord,                0,   620, 0.80],  // o anel de ferramentas, centrado no quadro
  [B.injecaoWord,               0,   620, 0.80],
  [B.executeWord,            -170,   470, 0.86],  // acompanha a chamada até a tool
  [B.acaoWord + 0.5,            0,   560, 0.76],
  [B.atacanteWord,              0,   481, 0.82],  // frame conceitual final, centrado na cadeia
  [TOTAL_SECONDS,               0,   492, 0.85],  // drift lentíssimo até o corte
];

function useCamera(t) {
  // `interpolate` lança exceção em range não-monotônico. Os tempos vêm de beats da narração e
  // dois keyframes podem colidir legitimamente ao mexer num beat — derrubar o render inteiro no
  // meio é muito pior do que um trecho de câmera com duração zero. Mesma decisão de `fadeWin`.
  const ts = [];
  for (let i = 0; i < CAM_KEYS.length; i++) {
    ts.push(i === 0 ? CAM_KEYS[i][0] : Math.max(CAM_KEYS[i][0], ts[i - 1] + 1e-3));
  }
  const ease = { ...CLAMP, easing: Easing.inOut(Easing.cubic) };
  const x = interpolate(t, ts, CAM_KEYS.map(k => k[1]), ease);
  const y = interpolate(t, ts, CAM_KEYS.map(k => k[2]), ease);
  const z = interpolate(t, ts, CAM_KEYS.map(k => k[3]), ease);
  // Drift permanente de poucos pixels: o quadro nunca fica perfeitamente parado.
  const dx = Math.cos(t * 0.21) * 5;
  const dy = Math.sin(t * 0.27) * 6;
  return { x: x + dx, y: y + dy, z };
}

/** Mundo -> tela. Os termos técnicos são desenhados em ESPAÇO DE TELA (senão encolhem junto
 *  com a câmera e ficam ilegíveis nos planos abertos), mas precisam pousar exatamente sobre
 *  o elemento do diagrama. É esta função que costura os dois espaços. */
function w2s(cam, wx, wy) {
  return { x: VW / 2 + (wx - cam.x) * cam.z, y: VH / 2 + (wy - cam.y) * cam.z };
}

/** Janela de vida em segundos, com fades próprios. */
function vis(t, a, b, fi = 0.34, fo = 0.40) {
  return fadeWin(t, [a, a + fi, b - fo, b]);
}

/* ===================================================================== ato 1 — a conversa */
//
// Continuidade: este card NÃO desaparece quando o pipeline aparece. Ele ENCOLHE e vira o nó
// USUÁRIO. É o mesmo objeto do primeiro ao último frame — por isso o nó "usuário" não existe
// separado em lugar nenhum do arquivo.

function ChatToUserNode({ t }) {
  const { fps } = useT();
  const collapse = easeFlow(t, B.pullBack, B.pullBack + 0.85);
  const build = easeHeavy(t, fps, 0.02);

  const w = interpolate(collapse, [0, 1], [700, 330]);
  const h = interpolate(collapse, [0, 1], [700, 116]);
  const y = interpolate(collapse, [0, 1], [-560, N.user.y]);
  const chrome = 1 - easeUI(t, B.pullBack, B.pullBack + 0.42);   // conteúdo sai antes da forma
  const nodeLabel = easeUI(t, B.pullBack + 0.46, B.pullBack + 0.86);

  // O usuário vira a ORIGEM do ataque no ato DIRECT: a mesma caixa, outra cor.
  const hot = easeUI(t, B.seProprio, B.seProprio + 0.5) * (1 - easeUI(t, B.impactoWord, B.impactoWord + 0.6));
  const active = Math.max(
    easeUI(t, 0, 0.6) * (1 - easeUI(t, B.pullBack + 0.6, B.pullBack + 1.2)),
    easeUI(t, B.userSource, B.userSource + 0.4) * (1 - easeUI(t, B.docSource, B.docSource + 0.4)),
    hot,
  );
  const col = hot > 0.4 ? RED : ACCENT;
  const bob = breathe(t, { amp: 2.2, freq: 0.21 });
  // Ele existe desde o frame 0, mas o frame conceitual final é AGENTE -> TOOL -> AÇÃO: manter a
  // coluna de cima ali em cima seria exatamente a poluição que o briefing pediu para evitar.
  const alive = fadeWin(t, [0, 0.01, B.agenteWord - 0.5, B.agenteWord + 0.3]);
  if (alive <= 0.004) return null;

  // A bolha do usuário: digita, é enviada, e então DESTACA e vira o pacote.
  const bubbleIn = easeHero(t, fps, 1.62);
  const sent = easeUI(t, B.questionFires - 0.10, B.questionFires + 0.16);

  return (
    <Box x={0} y={y + bob} w={w} h={h} style={{
      opacity: alive * (1 - dimOutside(t) * 0.82), transform: `scale(${0.9 + 0.1 * build})`,
    }}>
      {/* casca */}
      <div style={{
        position: 'absolute', inset: 0, borderRadius: interpolate(collapse, [0, 1], [26, 16]),
        background: 'linear-gradient(180deg, rgba(16,22,34,0.95) 0%, rgba(9,12,20,0.96) 100%)',
        border: `1.5px solid rgba(${hot > 0.4 ? '255,77,109' : '143,163,191'},0.22)`,
        boxShadow: active > 0.01 ? `0 0 ${26 + active * 38}px ${col}2e` : 'none',
      }} />
      {active > 0.01 && (
        <div style={{
          position: 'absolute', inset: 0, borderRadius: interpolate(collapse, [0, 1], [26, 16]),
          border: `1.5px solid ${col}`, opacity: active * 0.9,
        }} />
      )}

      {/* conteúdo do chat — some antes da forma encolher, senão vira papa ilegível */}
      {chrome > 0.01 && (
        <div style={{ position: 'absolute', inset: 0, opacity: chrome, overflow: 'hidden', borderRadius: 26 }}>
          {/* barra de título */}
          <div style={{
            position: 'absolute', left: 0, right: 0, top: 0, height: 66,
            borderBottom: '1px solid rgba(143,163,191,0.14)', display: 'flex',
            alignItems: 'center', padding: '0 24px', gap: 10,
          }}>
            {[0, 1, 2].map(i => (
              <div key={i} style={{
                width: 9, height: 9, borderRadius: '50%',
                background: 'rgba(143,163,191,0.30)',
              }} />
            ))}
            <div style={{
              fontFamily: MONO, fontSize: 19, letterSpacing: '0.16em', color: STEEL,
              marginLeft: 12, opacity: 0.8,
            }}>ASSISTENTE</div>
          </div>

          {/* mensagens anteriores, deliberadamente sem texto legível: são contexto, não conteúdo */}
          {[[0, 300, 0.26], [1, 210, 0.18]].map(([i, bw, op]) => (
            <div key={i} style={{
              position: 'absolute', left: 30, top: 108 + i * 64, width: bw, height: 42,
              borderRadius: 14, background: `rgba(143,163,191,${op})`,
              opacity: easeUI(t, 0.5 + i * 0.16, 0.9 + i * 0.16),
            }} />
          ))}

          {/* a pergunta do usuário */}
          <div style={{
            position: 'absolute', right: 30, top: 246,
            transform: `translateY(${(1 - bubbleIn) * 26}px) scale(${interpolate(sent, [0, 1], [1, 0.82])})`,
            opacity: bubbleIn * (1 - sent),
            background: 'rgba(255,212,0,0.12)', border: '1.5px solid rgba(255,212,0,0.45)',
            borderRadius: '16px 16px 4px 16px', padding: '16px 22px', maxWidth: 480,
          }}>
            <TypeLine text="qual o status do meu pedido?" at={1.72} t={t} cps={22} size={25}
              color="rgba(255,255,255,0.9)" />
          </div>

          {/* campo de entrada, com o cursor piscando — microinteração, não decoração */}
          <div style={{
            position: 'absolute', left: 26, right: 26, bottom: 24, height: 68, borderRadius: 16,
            border: '1.5px solid rgba(143,163,191,0.18)', display: 'flex', alignItems: 'center',
            padding: '0 20px', gap: 10,
          }}>
            <div style={{
              width: 2, height: 26, background: ACCENT,
              opacity: Math.floor(t * 2.1) % 2 === 0 ? 0.85 : 0.12,
            }} />
          </div>
        </div>
      )}

      {/* rótulo do nó, entrando enquanto o chat sai */}
      {nodeLabel > 0.01 && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
          justifyContent: 'center', gap: 14, opacity: nodeLabel,
        }}>
          <div style={{
            fontFamily: MONO, fontWeight: 700, fontSize: 27, letterSpacing: '0.14em',
            color: active > 0.3 ? WHITE : 'rgba(255,255,255,0.72)',
          }}>USUÁRIO</div>
        </div>
      )}
    </Box>
  );
}

/* ============================================================ a espinha: arestas e nós */

/** Âncoras nas bordas dos cards (card = 116px de altura -> ±58 do centro). */
const A = {
  userOut: { x: 0, y: N.user.y + 58 },
  appIn:   { x: 0, y: N.app.y - 58 },
  appOut:  { x: 0, y: N.app.y + 58 },
  ctxIn:   { x: 0, y: N.ctx.y - 58 },
  ctxOut:  { x: 0, y: N.ctx.y + 58 },
  llmIn:   { x: 0, y: N.llm.y - 58 },
  llmOut:  { x: 0, y: N.llm.y + 58 },
  ansIn:   { x: 0, y: N.answer.y - 58 },
};

const SEGMENTS = [
  { P: curveV(A.userOut, A.appIn), at: B.stepsWord },
  // 6,20 e não 6,56: a linha tem que LIDERAR o pacote, nunca ser alcançada por ele.
  { P: curveV(A.appOut, A.ctxIn),  at: 6.20 },
  { P: curveV(A.ctxOut, A.llmIn),  at: 7.10 },
  { P: curveV(A.llmOut, A.ansIn),  at: 7.74 },
];

/** Aresta provisória do ato 1: USUÁRIO -> LLM, direto, como o espectador imagina que seja.
 *  Ela não é apagada — os nós novos nascem EM CIMA dela. É literalmente o "o fluxo se expande". */
const NAIVE = curveV(A.userOut, A.llmIn, 0.42);

/** Quando o pacote está dentro de um card ele some e o card pulsa. Isso lê muito melhor do que
 *  o pacote passando por cima do card, e é o que dá a sensação de "atravessar o sistema". */
function nodePulse(t, packet, nodeY) {
  if (!packet.visible || Math.abs(packet.x) > 90) return 0;
  const d = Math.abs(packet.y - nodeY);
  return d < 64 ? interpolate(d, [0, 64], [1, 0], CLAMP) : 0;
}

/* ------------------------------------------------------------------------------ o pacote */
//
// UM objeto, a vida inteira do vídeo. Ele nasce como a mensagem do usuário, atravessa o
// pipeline, e mais tarde é ele mesmo que carrega a instrução maliciosa — trocando de cor e de
// rótulo, nunca sendo substituído por outro elemento. A continuidade do Reel mora aqui.

function packetState(t) {
  const off = { x: 0, y: 0, visible: false, label: null, color: ACCENT, speed: 0, scale: 1 };

  // 1) a bolha vira pacote e se solta da conversa
  if (t >= B.questionFires - 0.06 && t < B.pullBack) {
    const p = easeFlow(t, B.questionFires, B.pullBack - 0.1);
    return {
      x: interpolate(p, [0, 1], [150, 0]),
      y: interpolate(p, [0, 1], [-645, A.userOut.y]),
      visible: true, label: 'PERGUNTA', color: ACCENT,
      speed: interpolate(p, [0, 0.35, 1], [0.2, 0.6, 0.05], CLAMP), scale: 1,
    };
  }
  // 2) suspenso: a câmera recua e o caminho até o LLM se revela cheio de etapas
  if (t >= B.pullBack && t < B.stepsWord) {
    return { ...off, x: 0, y: A.userOut.y, visible: true, label: 'PERGUNTA', speed: 0 };
  }
  // 3) percorre a cadeia inteira, na velocidade da frase
  if (t >= B.stepsWord && t < 8.95) {
    const p = easeFlow(t, B.stepsWord + 0.04, 8.55);
    const y = interpolate(p, [0, 1], [A.userOut.y, A.ansIn.y]);
    const dp = easeFlow(t + 0.05, B.stepsWord + 0.04, 8.55) - p;
    return {
      x: 0, y, visible: p < 0.995, label: 'PERGUNTA', color: ACCENT,
      speed: Math.min(1, dp * 26), scale: 1,
    };
  }
  // 4) ato DIRECT: o MESMO pacote volta, agora vermelho e carregando a instrução
  if (t >= B.enviaWord && t < B.impactoWord - 0.4) {
    const p = easeFlow(t, B.enviaWord + 0.15, B.injectionWord - 0.25);
    const y = interpolate(p, [0, 1], [A.userOut.y, A.llmIn.y]);
    const dp = easeFlow(t + 0.05, B.enviaWord + 0.15, B.injectionWord - 0.25) - p;
    return {
      x: 0, y, visible: p < 0.99, label: 'INSTRUÇÃO', color: RED,
      speed: Math.min(1, dp * 26), scale: 1,
    };
  }
  // 5) ato AGENTE: a injeção atravessa PROMPT -> AGENTE -> TOOL
  if (t >= B.injecaoWord && t < B.acaoWord + 0.9) {
    const toTool = TOOLS[0];                       // API — a primeira ferramenta nomeada
    const p1 = easeFlow(t, B.injecaoWord, B.executeWord - 0.15);
    if (p1 < 1) {
      const y = interpolate(p1, [0, 1], [N.ctx.y - 260, A.llmIn.y]);
      const dp = easeFlow(t + 0.05, B.injecaoWord, B.executeWord - 0.15) - p1;
      return { x: 0, y, visible: true, label: 'INSTRUÇÃO', color: RED, speed: Math.min(1, dp * 26), scale: 1 };
    }
    const p2 = easeFlow(t, B.executeWord, B.acaoWord + 0.18);
    const P = curveHV({ x: -196, y: N.llm.y + 46 }, { x: toTool.x, y: toTool.y - 54 }, 0.55);
    const pt = bezPoint(P, p2);
    const nxt = bezPoint(P, Math.min(1, p2 + 0.04));
    return {
      x: pt.x, y: pt.y, visible: p2 < 0.985, label: 'INSTRUÇÃO', color: RED,
      speed: Math.min(1, Math.hypot(nxt.x - pt.x, nxt.y - pt.y) / 22),
      scale: interpolate(p2, [0, 1], [1, 0.86]),
      angle: (Math.atan2(nxt.y - pt.y, nxt.x - pt.x) * 180) / Math.PI + 90,
    };
  }
  return off;
}

/* ======================================================================== ato 3 — RAG */
//
// O nó CONTEXTO se abre e entramos nele. A busca é DISPARADA de dentro para fora — quatro
// pulsos saindo para o escuro — e cada fonte só existe quando o pulso chega nela, na palavra
// em que ela é dita. Depois os documentos selecionados voltam encolhidos e viram blocos de
// contexto. É a mesma matéria atravessando o sistema, nunca ícones novos aparecendo por fade.

const SRC_META = [
  // `lands` = quando o documento recuperado CHEGA no painel. É o mesmo instante em que o bloco
  // correspondente aparece lá dentro — se o pulso e o bloco não coincidirem, o retrieval deixa
  // de ler como uma coisa só e vira dois efeitos soltos.
  { key: 'docs', ...SRC.docs, at: B.docsWord,        picked: true,  short: 'DOC', lands: 21.02 },
  { key: 'pdfs', ...SRC.pdfs, at: B.pdfsWord,        picked: true,  short: 'PDF', lands: 21.28 },
  { key: 'base', ...SRC.base, at: B.baseWord,        picked: true,  short: 'KB',  lands: 21.54 },
  { key: 'db',   ...SRC.db,   at: B.baseWord + 0.55, picked: false, short: 'DB',  lands: null },
];

/** Curva entre o painel CONTEXTO e cada fonte. Mesma curva serve para ir (query) e voltar
 *  (documento recuperado) — é por isso que o retrieval lê como ida e volta, e não como dois
 *  movimentos sem relação. */
const SRC_CURVE = SRC_META.reduce((acc, s) => {
  const sx = Math.sign(s.x), sy = Math.sign(s.y);
  acc[s.key] = curveHV({ x: sx * 180, y: sy * 74 }, { x: s.x, y: s.y - sy * 44 }, 0.5);
  return acc;
}, {});

const RAG_PICK_AT = B.mandaWord - 0.45;      // a seleção acontece pouco antes de "manda"
const RAG_END = B.alemDisso + 0.30;

function SourceCard({ s, t }) {
  const appear = fadeWin(t, [s.at - 0.12, s.at + 0.22, RAG_END + 0.2, RAG_END + 0.6]);
  if (appear <= 0.004) return null;
  // Selecionado: a borda acende e o card dá um passo à frente. Não-selecionado: esmaece.
  const sel = s.picked ? easeUI(t, RAG_PICK_AT, RAG_PICK_AT + 0.3) : 0;
  const rej = s.picked ? 0 : easeUI(t, RAG_PICK_AT + 0.1, RAG_PICK_AT + 0.5);
  // Depois de virar bloco de contexto, o card fonte se apaga: a matéria mudou de lugar.
  const spent = s.picked ? easeUI(t, B.mandaWord + 0.25, B.mandaWord + 0.7) : 0;
  const pop = easeHero(t, 60, s.at);
  return (
    <NodeCard
      x={s.x} y={s.y} w={310} h={86} label={s.label}
      accent={ACCENT}
      active={sel * (1 - spent * 0.7)}
      appear={appear * (1 - rej * 0.55) * (1 - spent * 0.62)}
      t={t} float={2}
      style={{ transform: `scale(${(0.86 + 0.14 * pop) * (1 + sel * 0.03 - spent * 0.08)})` }}
    />
  );
}

/** Pulso viajando numa curva. Fino, rápido, sem rótulo: é uma consulta, não um objeto. */
function Pulse({ P, p, color = ACCENT, opacity = 1, size = 9 }) {
  if (opacity <= 0.004 || p < 0 || p > 1) return null;
  const pt = bezPoint(P, p);
  return (
    <circle cx={pt.x} cy={pt.y} r={size} fill={color} opacity={opacity}
      style={{ filter: `drop-shadow(0 0 ${size * 2}px ${color})` }} />
  );
}

/** Bloco de contexto — o documento depois de recuperado, já encolhido. */
function ContextChip({ x, y, label, color = ACCENT, opacity = 1, scale = 1, danger = false }) {
  if (opacity <= 0.004) return null;
  return (
    <div style={{
      position: 'absolute', left: x, top: y, transform: `translate(-50%,-50%) scale(${scale})`,
      opacity,
      padding: '9px 16px', borderRadius: 9,
      background: danger ? 'rgba(255,77,109,0.14)' : 'rgba(255,212,0,0.11)',
      border: `1.4px solid ${danger ? RED : color}`,
      fontFamily: MONO, fontWeight: 700, fontSize: 21, letterSpacing: '0.1em',
      color: danger ? '#ffd7de' : 'rgba(255,255,255,0.92)', whiteSpace: 'nowrap',
    }}>{label}</div>
  );
}

/* ============================================ o nó CONTEXTO — ele abre, e entramos nele */
//
// O mesmo nó abre duas vezes, e isso é proposital: a primeira para mostrar o RAG enchendo o
// contexto, a segunda para mostrar a fronteira DADO/INSTRUÇÃO cedendo DENTRO dele. O ataque
// acontece exatamente onde o espectador já aprendeu que as coisas se juntam.

const CTX_OPEN_RAG = [B.ragOpens - 0.25, RAG_END];
// Fecha só em 49,2 e não em `seProprio`: a travessia DADO->INSTRUÇÃO pousa em 47,08 e a
// narração emenda a frase seguinte 0,6s depois. Fechar junto com a fala daria ao beat central
// do vídeo meio segundo de tela. O painel segura o resultado enquanto ele fala "essa instrução"
// — que é exatamente o bloco que está na tela.
const CTX_OPEN_DATA = [B.intoContext - 0.9, 49.2];

function ctxOpen(t) {
  const a = fadeWin(t, [CTX_OPEN_RAG[0], CTX_OPEN_RAG[0] + 0.55, CTX_OPEN_RAG[1] - 0.5, CTX_OPEN_RAG[1]]);
  const b = fadeWin(t, [CTX_OPEN_DATA[0], CTX_OPEN_DATA[0] + 0.6, CTX_OPEN_DATA[1] - 0.45, CTX_OPEN_DATA[1]]);
  return { open: Math.max(a, b), rag: a, data: b };
}

/** Troca de rótulo por máscara: o texto antigo sobe e sai, o novo sobe e entra, dentro do
 *  MESMO recorte. Não é cross-fade — é a mesma caixa dizendo outra coisa. */
function MorphLabel({ from, to, p, size = 46, colorFrom = WHITE, colorTo = RED }) {
  const h = size * 1.24;
  return (
    <div style={{ position: 'relative', height: h, overflow: 'hidden', minWidth: size * 6 }}>
      <div style={{
        position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        transform: `translateY(${-p * h}px)`, opacity: 1 - Math.pow(p, 2.2),
        fontFamily: FONT, fontWeight: 900, fontSize: size, letterSpacing: '0.04em', color: colorFrom,
      }}>{from}</div>
      <div style={{
        position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        transform: `translateY(${(1 - p) * h}px)`, opacity: Math.pow(p, 0.6),
        fontFamily: FONT, fontWeight: 900, fontSize: size, letterSpacing: '0.04em', color: colorTo,
        textShadow: `0 0 ${size * 0.5}px ${colorTo}66`,
      }}>{to}</div>
    </div>
  );
}

function ContextNode({ t, packet }) {
  const { fps } = useT();
  const o = ctxOpen(t);
  const born = easeHero(t, fps, B.etapas);
  if (born <= 0.001) return null;
  // Fica vivo até a injeção sair dele no ato do agente — é de dentro do contexto que ela vem.
  const alive = fadeWin(t, [B.etapas, B.etapas + 0.2, B.injecaoWord + 0.35, B.injecaoWord + 1.15]);
  if (alive <= 0.004) return null;

  const w = interpolate(o.open, [0, 1], [330, 760]);
  const h = interpolate(o.open, [0, 1], [116, o.data > o.rag ? 470 : 300]);

  const pulseIn = nodePulse(t, packet, N.ctx.y);
  const activeRag = easeUI(t, B.ragOpens, B.ragOpens + 0.4) * (1 - easeUI(t, RAG_END - 0.4, RAG_END));
  // O painel só fica vermelho quando a fronteira começa a ceder. Enquanto o bloco é DADO ele
  // tem que PARECER seguro — uma borda vermelha antes da hora entrega a virada.
  const danger = easeUI(t, B.interpretar, B.instrucaoWord);
  const col = danger > 0.35 ? RED : ACCENT;
  const active = Math.max(pulseIn, activeRag * 0.75, danger * 0.9,
    easeUI(t, B.perguntaSum, B.perguntaSum + 0.3) * (1 - easeUI(t, B.alemDisso, B.alemDisso + 0.4)));
  const bob = breathe(t, { amp: 2, freq: 0.19, phase: 3 });

  // ---- conteúdo A: os blocos que o RAG trouxe
  // Os quatro lugares já existem — vazios — desde que o painel abre. Um contexto vazio com
  // slots reservados diz "estou esperando o retrieval"; um painel liso durante 8s diz "faltou
  // desenhar alguma coisa aqui". A diferença é a mesma linha de código.
  const ragChips = [
    { label: 'PERGUNTA', x: -190, w: 140, at: B.perguntaSum },
    { label: 'DOC', x: -25, w: 78, at: 21.02 },
    { label: 'PDF', x: 105, w: 78, at: 21.28 },
    { label: 'KB', x: 222, w: 64, at: 21.54 },
  ];
  const plus = easeUI(t, B.perguntaSum + 0.12, B.perguntaSum + 0.4);
  const slots = easeUI(t, B.ragOpens + 0.35, B.ragOpens + 0.9);
  const scan = easeUI(t, B.buscaWord - 0.1, B.buscaWord + 0.3)
    * (1 - easeUI(t, B.perguntaSum - 0.2, B.perguntaSum + 0.2));

  // ---- conteúdo B: a fronteira DADO / INSTRUÇÃO
  const laneIn = easeUI(t, B.aquiloWord - 0.2, B.aquiloWord + 0.5);
  // Antecipação em "interpretar" (45,88), pouso em "instrução." (47,08). O house style manda
  // o reveal chegar ANTES da palavra; aqui a fronteira começa a ceder enquanto ele diz o verbo.
  const cross = easeFlow(t, B.interpretar + 0.25, B.instrucaoWord + 0.14);   // a travessia
  const crack = easeUI(t, B.interpretar + 0.10, B.instrucaoWord - 0.25);     // a fronteira cede
  const blockIn = easeHero(t, fps, B.intoContext);
  const blockY = interpolate(cross, [0, 1], [96, -104]);
  const shake = impactShake(t, B.interpretar + 0.35, { amp: 7, dur: 0.26 });

  return (
    <Box x={0} y={N.ctx.y + bob} w={w} h={h} style={{ opacity: alive, transform: `scale(${0.9 + 0.1 * born})` }}>
      <div style={{
        position: 'absolute', inset: 0, borderRadius: 16,
        background: 'linear-gradient(180deg, rgba(16,22,34,0.95) 0%, rgba(9,12,20,0.96) 100%)',
        border: `1.5px solid rgba(${danger > 0.35 ? '255,77,109' : '143,163,191'},0.22)`,
        boxShadow: `0 0 ${26 + active * 40}px ${col}${active > 0.5 ? '33' : '1a'}, inset 0 1px 0 rgba(255,255,255,0.04)`,
      }} />
      {active > 0.01 && (
        <div style={{
          position: 'absolute', inset: 0, borderRadius: 16, border: `1.5px solid ${col}`, opacity: active * 0.95,
        }} />
      )}

      {/* rótulo: centralizado quando fechado, vira cabeçalho quando abre */}
      <div style={{
        position: 'absolute',
        left: interpolate(o.open, [0, 1], [0, 26]), right: interpolate(o.open, [0, 1], [0, 26]),
        top: interpolate(o.open, [0, 1], [0, 20]),
        height: interpolate(o.open, [0, 1], [h, 34]),
        display: 'flex', alignItems: 'center',
        justifyContent: o.open > 0.5 ? 'flex-start' : 'center',
      }}>
        <div style={{
          fontFamily: MONO, fontWeight: 700,
          fontSize: interpolate(o.open, [0, 1], [27, 22]), letterSpacing: '0.16em',
          color: active > 0.3 ? WHITE : 'rgba(255,255,255,0.72)',
        }}>CONTEXTO</div>
      </div>
      {o.open > 0.5 && (
        <div style={{
          position: 'absolute', left: 26, right: 26, top: 60, height: 1,
          background: 'rgba(143,163,191,0.16)', opacity: o.open,
        }} />
      )}

      {/* ------------------------------------------------ A) o que o RAG juntou */}
      {/* barra de retrieval: mostra que o sistema está buscando, e some quando o contexto fecha */}
      {o.rag > 0.02 && scan > 0.01 && (
        <div style={{
          position: 'absolute', left: 26, right: 26, top: 104, height: 3, opacity: scan * o.rag * 0.9,
          overflow: 'hidden', background: 'rgba(143,163,191,0.10)',
        }}>
          <div style={{
            position: 'absolute', top: 0, bottom: 0, width: '26%',
            left: `${((t - B.buscaWord) * 34) % 126 - 26}%`,
            background: `linear-gradient(90deg, transparent, ${ACCENT}, transparent)`, opacity: 0.8,
          }} />
        </div>
      )}
      {/* os lugares reservados */}
      {o.rag > 0.02 && slots > 0.01 && ragChips.map(c => {
        const filled = easeUI(t, c.at - 0.1, c.at + 0.2);
        if (filled > 0.98) return null;
        return (
          <div key={`slot-${c.label}`} style={{
            position: 'absolute', left: w / 2 + c.x, top: h / 2 + 46,
            transform: 'translate(-50%,-50%)', width: c.w, height: 44, borderRadius: 9,
            border: '1.4px dashed rgba(143,163,191,0.42)',
            background: 'rgba(143,163,191,0.05)',
            opacity: slots * o.rag * (1 - filled),
          }} />
        );
      })}
      {o.rag > 0.02 && ragChips.map(c => {
        const inChip = easeHero(t, fps, c.at);
        if (inChip <= 0.01) return null;
        return (
          <ContextChip
            key={c.label}
            x={w / 2 + c.x} y={h / 2 + 46 - (1 - inChip) * 16}
            label={c.label} opacity={inChip * o.rag} scale={0.86 + 0.14 * inChip}
          />
        );
      })}
      {o.rag > 0.02 && plus > 0.01 && (
        <div style={{
          position: 'absolute', left: w / 2 - 105, top: h / 2 + 46, transform: 'translate(-50%,-50%)',
          fontFamily: MONO, fontSize: 30, color: ACCENT, fontWeight: 700, opacity: plus * o.rag,
        }}>+</div>
      )}

      {/* ------------------------------------------------ B) a fronteira DADO / INSTRUÇÃO */}
      {o.data > 0.02 && laneIn > 0.01 && (
        <>
          <div style={{
            position: 'absolute', left: 28, top: h / 2 - 150, opacity: laneIn * 0.85 * o.data,
            fontFamily: MONO, fontSize: 18, letterSpacing: '0.22em',
            color: crack > 0.5 ? RED : STEEL,
          }}>INSTRUCTION</div>
          <div style={{
            position: 'absolute', left: 28, top: h / 2 + 20, opacity: laneIn * 0.85 * o.data,
            fontFamily: MONO, fontSize: 18, letterSpacing: '0.22em', color: STEEL,
          }}>DATA</div>

          {/* A FRONTEIRA. Ela não some: ela se parte, e as duas metades se afastam. */}
          {[-1, 1].map(side => (
            <div key={side} style={{
              position: 'absolute',
              left: side < 0 ? 26 : w / 2 + crack * 26,
              width: (w - 52) / 2 - crack * 26,
              top: h / 2 - 34 + side * crack * 7,
              height: 2, opacity: laneIn * o.data,
              background: crack > 0.02 ? `linear-gradient(90deg, ${STEEL_DIM}, ${RED})` : STEEL_DIM,
              transform: `rotate(${side * crack * 0.55}deg)`,
            }} />
          ))}

          {/* estilhaços da fronteira — 5 elementos, não 50 */}
          {crack > 0.05 && Array.from({ length: 5 }).map((_, i) => {
            const s = `shard-${i}`;
            const dt = Math.max(0, t - (B.interpretar + 0.15));
            const op = Math.max(0, 1 - dt / 0.7) * o.data;
            if (op <= 0.01) return null;
            return (
              <div key={i} style={{
                position: 'absolute',
                left: w / 2 + (random(s + 'x') - 0.5) * (w - 120),
                top: h / 2 - 34 + (random(s + 'y') - 0.5) * 16 - dt * 40 * (0.5 + random(s + 'v')),
                width: 14 + random(s + 'w') * 22, height: 2,
                background: RED, opacity: op * 0.8,
                transform: `rotate(${(random(s + 'r') - 0.5) * 70}deg)`,
              }} />
            );
          })}

          {/* O BLOCO. É o mesmo do começo ao fim: muda de zona, de forma, de cor e de nome. */}
          {blockIn > 0.01 && (
            <div style={{
              position: 'absolute', left: w / 2, top: h / 2 + blockY,
              transform: `translate(-50%,-50%) translateX(${shake}px) scale(${0.84 + 0.16 * blockIn})`,
              opacity: o.data,
              minWidth: 430, padding: '16px 22px',
              borderRadius: interpolate(cross, [0, 1], [12, 5]),
              background: `rgba(${cross > 0.4 ? '255,77,109' : '143,163,191'},${0.09 + cross * 0.07})`,
              border: `1.6px solid ${cross > 0.4 ? RED : 'rgba(143,163,191,0.5)'}`,
              boxShadow: cross > 0.1 ? `0 0 ${cross * 44}px ${RED}44` : 'none',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
            }}>
              <MorphLabel from="DADO" to="INSTRUÇÃO" p={cross} size={42}
                colorFrom="rgba(255,255,255,0.92)" colorTo={RED} />
              <div style={{
                fontFamily: MONO, fontSize: 19, letterSpacing: '0.04em',
                color: cross > 0.4 ? '#ffd7de' : 'rgba(255,255,255,0.55)',
                display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap',
              }}>
                {/* o caret de comando só existe depois da travessia: agora é uma ORDEM */}
                <span style={{ color: RED, opacity: cross, width: cross * 14, overflow: 'hidden' }}>&gt;</span>
                IGNORE AS INSTRUÇÕES ANTERIORES
              </div>
            </div>
          )}
        </>
      )}
    </Box>
  );
}

/* ========================================================== ato 4 — a camada privilegiada */
//
// O System Prompt não entra por fade: a CÂMERA sobe e encontra uma camada que já estava lá,
// fora da coluna, acima e atrás da conversa. É a diferença entre "apareceu um card novo" e
// "existe uma parte da aplicação que o usuário não vê".

const SYS_W = 560, SYS_H = 300;
const SYS_EDGE = [
  { x: SYS.x, y: SYS.y + SYS_H / 2 },
  { x: SYS.x, y: SYS.y + SYS_H / 2 + 300 },
  { x: SYS.x - 20, y: N.ctx.y - 250 },
  { x: 62, y: A.ctxIn.y },
];

function SystemLayer({ t }) {
  const { fps } = useT();
  const alive = fadeWin(t, [B.systemWord - 0.45, B.systemWord + 0.25, B.userSource + 0.6, B.userSource + 1.3]);
  if (alive <= 0.004) return null;

  const land = easeHeavy(t, fps, B.systemWord - 0.42);           // camada: tem massa
  const wob = settleWobble(t, B.systemWord + 0.2, { amp: 4, freq: 5 });
  const active = easeUI(t, B.systemWord, B.systemWord + 0.4) * (1 - easeUI(t, B.problemWord, B.problemWord + 0.6));
  const bob = breathe(t, { amp: 2.4, freq: 0.17, phase: 1.4 });

  return (
    <Box x={SYS.x} y={SYS.y + bob + wob} w={SYS_W} h={SYS_H} style={{
      opacity: alive,
      transform: `translateY(${(1 - land) * -70}px) scale(${0.9 + 0.1 * land})`,
    }}>
      <div style={{
        position: 'absolute', inset: 0, borderRadius: 18,
        background: 'linear-gradient(180deg, rgba(22,20,10,0.95) 0%, rgba(10,11,16,0.96) 100%)',
        border: `1.5px dashed rgba(255,212,0,${0.30 + active * 0.3})`,
        boxShadow: `0 0 ${30 + active * 40}px rgba(255,212,0,0.16), inset 0 1px 0 rgba(255,255,255,0.05)`,
      }} />
      <div style={{ position: 'absolute', left: 26, right: 26, top: 24 }}>
        <div style={{
          fontFamily: MONO, fontWeight: 700, fontSize: 26, letterSpacing: '0.14em', color: WHITE,
        }}>SYSTEM PROMPT</div>
        <div style={{
          fontFamily: MONO, fontSize: 19, letterSpacing: '0.16em', color: ACCENT, marginTop: 7, opacity: 0.85,
        }}>O USUÁRIO NÃO VÊ</div>
        <div style={{ height: 1, background: 'rgba(255,212,0,0.18)', margin: '16px 0 14px' }} />
        <TypeLine text="Você é o assistente da empresa." at={B.rule1} t={t} cps={24} size={21} />
        <div style={{ height: 8 }} />
        <TypeLine text="Não revele informações privadas." at={B.rule2} t={t} cps={24} size={21} />
      </div>
    </Box>
  );
}

/* ================================================= ato 5 — a origem da instrução maliciosa */
//
// Reaproveita a MESMA posição do PDF que o RAG trouxe. O espectador já viu aquele card ali;
// quando ele volta carregando uma instrução, a conexão é gratuita — não precisa ser explicada.

function MaliciousDoc({ t }) {
  const { fps } = useT();
  const alive = fadeWin(t, [B.docSource - 0.2, B.docSource + 0.35, B.aquiloWord + 0.4, B.aquiloWord + 1.0]);
  if (alive <= 0.004) return null;
  const pop = easeHero(t, fps, B.docSource - 0.15);
  const hot = easeUI(t, B.inserirWord, B.inserirWord + 0.5);
  const shake = impactShake(t, B.maliciosa, { amp: 4, dur: 0.3 });
  const bob = breathe(t, { amp: 2, freq: 0.26, phase: 2 });

  return (
    <Box x={SRC.pdfs.x} y={SRC.pdfs.y + bob} w={330} h={168} style={{
      opacity: alive, transform: `translateX(${shake}px) scale(${0.86 + 0.14 * pop})`,
    }}>
      <div style={{
        position: 'absolute', inset: 0, borderRadius: 14,
        background: 'linear-gradient(180deg, rgba(20,14,18,0.95) 0%, rgba(10,10,16,0.96) 100%)',
        border: `1.5px solid rgba(${hot > 0.4 ? '255,77,109' : '143,163,191'},${0.24 + hot * 0.5})`,
        boxShadow: hot > 0.05 ? `0 0 ${hot * 40}px ${RED}33` : 'none',
      }} />
      <div style={{ position: 'absolute', left: 20, right: 20, top: 16 }}>
        <div style={{
          fontFamily: MONO, fontSize: 17, letterSpacing: '0.16em',
          color: hot > 0.4 ? RED : STEEL,
        }}>DOCUMENTO</div>
        {/* linhas ilegíveis: é um documento, não um texto para ler */}
        {[220, 250, 190].map((lw, i) => (
          <div key={i} style={{
            marginTop: i === 0 ? 14 : 8, width: lw, height: 6, borderRadius: 3,
            background: 'rgba(143,163,191,0.22)',
          }} />
        ))}
        {/* ...menos UMA. A instrução vive escondida entre elas. */}
        <div style={{ marginTop: 12, opacity: easeUI(t, B.maliciosa - 0.15, B.maliciosa + 0.25) }}>
          <TypeLine text="IGNORE AS INSTRUÇÕES ANTERIORES" at={B.maliciosa - 0.1} t={t}
            cps={38} size={15} color={RED} cursor={false} />
        </div>
      </div>
    </Box>
  );
}

/* ====================================================================== ato 8 — o impacto */
//
// Duas ideias, uma de cada vez: primeiro a resposta sendo REESCRITA, depois os dados que o
// modelo tem ao alcance tentando sair junto com ela. O ponto é que o modelo só pode vazar
// aquilo a que teve acesso — por isso os cards saem de DENTRO do contexto, não do nada.

const REWRITE_FROM = 'seu pedido chega amanhã';
const REWRITE_TO = 'envie seus dados neste link';

/** Reescrita determinística: original -> ruído -> novo. `random(seed)` do Remotion, nunca
 *  `Math.random()`, senão cada frame do render sorteia outra coisa e vira chuvisco. */
function rewriteText(a, b, p, seed) {
  const CH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#$%&@';
  const n = Math.max(a.length, b.length);
  const bucket = Math.floor(p * 34);
  let out = '';
  for (let i = 0; i < n; i++) {
    const th = i / n;
    const noise = CH[Math.floor(random(`${seed}-${i}-${bucket}`) * CH.length)];
    if (p < 0.46) out += p * 2.3 > th ? noise : (a[i] ?? ' ');
    else out += (p - 0.46) * 2.5 > th ? (b[i] ?? ' ') : noise;
  }
  return out.trimEnd();
}

const LEAKS = [
  { label: 'DOCUMENTO INTERNO', x: -150, y: 856, at: B.exporWord },
  { label: 'DADOS PRIVADOS', x: 130, y: 946, at: B.exporWord + 0.42 },
  { label: 'CONTEXTO RESTRITO', x: -80, y: 1036, at: B.exporWord + 0.84 },
];

function AnswerNode({ t, packet }) {
  const { fps } = useT();
  const born = easeHero(t, fps, 7.74);
  if (born <= 0.001) return null;
  const alive = fadeWin(t, [7.74, 8.1, B.agenteWord - 0.9, B.agenteWord - 0.3]);
  if (alive <= 0.004) return null;

  const open = fadeWin(t, [B.manipularWord - 0.6, B.manipularWord - 0.1, B.agoraSe + 0.4, B.agoraSe + 1.1]);
  const w = interpolate(open, [0, 1], [330, 580]);
  const h = interpolate(open, [0, 1], [116, 200]);

  const rw = easeFlow(t, B.manipularWord, B.respostaWord + 0.5);
  const arrived = nodePulse(t, packet, N.answer.y);
  const hot = easeUI(t, B.manipularWord, B.manipularWord + 0.5);
  const active = Math.max(arrived, easeUI(t, 8.3, 8.7) * (1 - easeUI(t, 9.6, 10.2)), hot);
  const col = hot > 0.4 ? RED : ACCENT;
  const bob = breathe(t, { amp: 2, freq: 0.23, phase: 5 });
  const shake = impactShake(t, B.manipularWord, { amp: 5, dur: 0.3 });

  return (
    <Box x={0} y={N.answer.y + bob} w={w} h={h} style={{
      opacity: alive * (1 - dimOutside(t) * 0.82), transform: `translateX(${shake}px) scale(${0.9 + 0.1 * born})`,
    }}>
      <div style={{
        position: 'absolute', inset: 0, borderRadius: 16,
        background: 'linear-gradient(180deg, rgba(16,22,34,0.96) 0%, rgba(9,12,20,0.97) 100%)',
        border: `1.5px solid rgba(${hot > 0.4 ? '255,77,109' : '143,163,191'},0.22)`,
        boxShadow: `0 0 ${24 + active * 36}px ${col}${active > 0.5 ? '33' : '18'}`,
      }} />
      {active > 0.01 && (
        <div style={{
          position: 'absolute', inset: 0, borderRadius: 16, border: `1.5px solid ${col}`, opacity: active * 0.9,
        }} />
      )}
      <div style={{
        position: 'absolute', left: 0, right: 0,
        top: interpolate(open, [0, 1], [0, 22]),
        height: interpolate(open, [0, 1], [h, 30]),
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <div style={{
          fontFamily: MONO, fontWeight: 700,
          fontSize: interpolate(open, [0, 1], [27, 21]), letterSpacing: '0.16em',
          color: active > 0.3 ? WHITE : 'rgba(255,255,255,0.72)',
        }}>RESPOSTA</div>
      </div>
      {open > 0.05 && (
        <div style={{
          position: 'absolute', left: 26, right: 26, top: 78, opacity: open,
          fontFamily: MONO, fontSize: 21, letterSpacing: '0.01em',
          color: rw > 0.5 ? '#ffd7de' : 'rgba(255,255,255,0.78)',
        }}>
          {rw <= 0.001 ? REWRITE_FROM : rewriteText(REWRITE_FROM, REWRITE_TO, rw, 'rw')}
        </div>
      )}
      {/* a fronteira de saída: o que passa daqui saiu da aplicação */}
      {open > 0.5 && (
        <div style={{
          position: 'absolute', left: 18, right: 18, bottom: -2, height: 2,
          background: RED, opacity: easeUI(t, B.contextoApp, B.contextoApp + 0.3) * 0.75,
          boxShadow: `0 0 14px ${RED}`,
        }} />
      )}
    </Box>
  );
}

/** Os dados que existem no contexto. Eles nascem ATRÁS da resposta e tentam atravessá-la. */
function LeakCards({ t }) {
  const alive = fadeWin(t, [B.exporWord - 0.2, B.exporWord + 0.4, B.agoraSe + 0.5, B.agoraSe + 1.2]);
  if (alive <= 0.004) return null;
  const lit = easeUI(t, B.sensiveisWord, B.sensiveisWord + 0.45);
  return (
    <>
      {LEAKS.map((c, i) => {
        const inn = easeUI(t, c.at, c.at + 0.45);
        if (inn <= 0.01) return null;
        // As duas primeiras tentam sair; a terceira fica — nem tudo vaza, e o ponto é o acesso.
        const tries = i < 2 ? easeFlow(t, B.contextoApp + i * 0.22, B.contextoApp + 0.95 + i * 0.22) : 0;
        // 742/752: a borda inferior do card de resposta está em 720. Eles PARAM na fronteira,
        // atravessando-a por alguns pixels. Levar até dentro do card leria como sobreposição.
        const stop = 742 + i * 10;
        const y = c.y - tries * (c.y - stop);
        const blocked = tries > 0.82 ? (1 - (tries - 0.82) / 0.18) : 1;
        return (
          <div key={c.label} style={{
            position: 'absolute', left: c.x, top: y,
            transform: `translate(-50%,-50%) translateY(${(1 - inn) * 26}px) scale(${0.88 + 0.12 * inn})`,
            opacity: alive * inn * (0.55 + lit * 0.45) * blocked,
            padding: '11px 18px', borderRadius: 9,
            background: 'rgba(255,77,109,0.10)',
            border: `1.4px solid rgba(255,77,109,${0.35 + lit * 0.45})`,
            fontFamily: MONO, fontSize: 19, letterSpacing: '0.1em',
            color: '#ffd7de', whiteSpace: 'nowrap',
            boxShadow: lit > 0.3 ? `0 0 ${lit * 24}px ${RED}33` : 'none',
          }}>{c.label}</div>
        );
      })}
    </>
  );
}

/* ================================================================== ato 9 — INDIRECT */
//
// A câmera se afasta até a aplicação inteira virar um objeto com fronteira. O documento vive
// FORA dela. O atacante nunca conversou com a IA — é isso que o enquadramento precisa dizer,
// antes de qualquer palavra aparecer.

const EXT_TABS = [
  { label: 'PDF', at: B.pdfWord },
  { label: 'SITE', at: B.siteWord },
  { label: 'E-MAIL', at: B.mailWord },
];

/** Curva do documento externo até o contexto, atravessando a fronteira da aplicação. */
const EXT_EDGE = curveHV(
  { x: EXTDOC.x + 300, y: EXTDOC.y - 150 },
  { x: -168, y: N.ctx.y + 40 },
  0.6,
);

function AppBoundary({ t }) {
  const alive = fadeWin(t, [B.agoraSe - 0.1, B.agoraSe + 0.9, B.agenteWord - 0.3, B.agenteWord + 0.5]);
  if (alive <= 0.004) return null;
  const draw = easeUI(t, B.agoraSe + 0.1, B.agoraSe + 1.5);
  return (
    <Box x={BOUNDARY.x} y={BOUNDARY.y} w={BOUNDARY.w} h={BOUNDARY.h} style={{ opacity: alive * draw * 0.9 }}>
      <div style={{
        position: 'absolute', inset: 0, borderRadius: 34,
        border: '2px dashed rgba(143,163,191,0.34)',
      }} />
      <div style={{
        position: 'absolute', left: 34, top: -30, padding: '0 14px',
        background: PREVIEW_BG === null ? 'transparent' : 'rgba(5,7,12,0.0)',
        fontFamily: MONO, fontSize: 38, letterSpacing: '0.24em', color: STEEL,
      }}>APLICAÇÃO</div>
    </Box>
  );
}

function ExternalDoc({ t }) {
  const { fps } = useT();
  const alive = fadeWin(t, [B.agoraSe + 0.7, B.agoraSe + 1.5, B.perigosoWord + 0.4, B.perigosoWord + 1.2]);
  if (alive <= 0.004) return null;
  const land = easeHeavy(t, fps, B.agoraSe + 0.8);
  const reveal = easeUI(t, B.escondidaWord, B.escondidaWord + 0.5);
  const pulled = easeUI(t, B.lerWord, B.lerWord + 0.6);
  const bob = breathe(t, { amp: 3, freq: 0.19, phase: 0.6 });

  return (
    <Box x={EXTDOC.x} y={EXTDOC.y + bob} w={640} h={430} style={{
      opacity: alive * (1 - pulled * 0.35),
      transform: `translateY(${(1 - land) * 60}px) scale(${(0.88 + 0.12 * land) * (1 - pulled * 0.06)})`,
    }}>
      <div style={{
        position: 'absolute', inset: 0, borderRadius: 14,
        background: 'linear-gradient(180deg, rgba(18,20,30,0.96) 0%, rgba(9,11,18,0.97) 100%)',
        border: `1.5px solid rgba(${reveal > 0.4 ? '255,77,109' : '143,163,191'},${0.22 + reveal * 0.4})`,
        boxShadow: reveal > 0.05 ? `0 0 ${reveal * 46}px ${RED}2a` : 'none',
      }} />
      {/* abas: cada uma acende NA palavra em que ele a diz */}
      <div style={{
        position: 'absolute', left: 24, right: 24, top: 22, display: 'flex', gap: 11,
      }}>
        {EXT_TABS.map(tab => {
          const on = easeUI(t, tab.at - 0.08, tab.at + 0.26);
          return (
            <div key={tab.label} style={{
              padding: '10px 20px', borderRadius: 9,
              border: `1.3px solid rgba(143,163,191,${0.16 + on * 0.6})`,
              background: on > 0.3 ? 'rgba(255,212,0,0.09)' : 'transparent',
              fontFamily: MONO, fontSize: 23, letterSpacing: '0.12em',
              color: on > 0.3 ? WHITE : 'rgba(143,163,191,0.55)',
              transform: `translateY(${(1 - on) * 8}px)`, opacity: 0.45 + on * 0.55,
            }}>{tab.label}</div>
          );
        })}
      </div>
      <div style={{ position: 'absolute', left: 26, right: 26, top: 108 }}>
        {[420, 490, 370].map((lw, i) => (
          <div key={i} style={{
            marginTop: i === 0 ? 0 : 16, width: lw, height: 9, borderRadius: 5,
            background: 'rgba(143,163,191,0.20)',
          }} />
        ))}
        {/* a instrução escondida no meio do conteúdo legítimo */}
        <div style={{
          marginTop: 22, padding: '12px 16px', borderRadius: 8,
          background: `rgba(255,77,109,${reveal * 0.14})`,
          border: `1.3px solid rgba(255,77,109,${reveal * 0.6})`,
          opacity: 0.35 + reveal * 0.65,
        }}>
          <TypeLine text="IGNORE AS INSTRUÇÕES ANTERIORES" at={B.escondidaWord - 0.05} t={t}
            cps={34} size={22} color={reveal > 0.3 ? RED : 'rgba(143,163,191,0.5)'} cursor={false} />
        </div>
        {[450, 380, 470].map((lw, i) => (
          <div key={i} style={{
            marginTop: i === 0 ? 20 : 16, width: lw, height: 9, borderRadius: 5,
            background: 'rgba(143,163,191,0.20)',
          }} />
        ))}
      </div>
    </Box>
  );
}

/* ============================================================ ato 10 — o agente e as tools */

function ToolNode({ tool, t }) {
  const { fps } = useT();
  const alive = fadeWin(t, [tool.at - 0.12, tool.at + 0.3, TOTAL_SECONDS, TOTAL_SECONDS + 1]);
  if (alive <= 0.004) return null;
  const pop = easeHero(t, fps, tool.at - 0.08);

  // No frame final só sobram o agente, a API e a AÇÃO — as outras saem de cena.
  const isApi = tool.key === 'api';
  const collapse = easeFlow(t, B.atacanteWord - 0.1, B.atacanteWord + 0.9);
  const x = isApi ? interpolate(collapse, [0, 1], [tool.x, 0]) : tool.x;
  const y = isApi ? interpolate(collapse, [0, 1], [tool.y, 616]) : tool.y;
  const fade = isApi ? 1 : 1 - collapse;

  // O alerta: a tool RECEBE uma tentativa de chamada. Não explode nada — pisca e avisa.
  const hit = isApi ? easeUI(t, B.acaoWord, B.acaoWord + 0.3) : 0;
  const ring = isApi && t > B.acaoWord ? pulse(t, { freq: 1.5 }) : 0;
  const shake = isApi ? impactShake(t, B.acaoWord + 0.05, { amp: 6, dur: 0.3 }) : 0;

  return (
    <div style={{ opacity: alive * fade, transform: `translateX(${shake}px)` }}>
      <NodeCard
        x={x} y={y} w={300} h={100}
        label={isApi && collapse > 0.5 ? 'TOOL / API' : tool.label}
        accent={hit > 0.3 ? RED : ACCENT}
        active={Math.max(easeUI(t, tool.at, tool.at + 0.35) * 0.55, hit, ring * hit * 0.6)}
        appear={0.86 + 0.14 * pop}
        t={t} float={2.4} danger={hit > 0.5 ? 1 : 0}
      />
      {hit > 0.02 && (
        <div style={{
          position: 'absolute', left: x, top: y - 82, transform: 'translate(-50%,-50%)',
          opacity: hit * (0.55 + ring * 0.45),
          fontFamily: MONO, fontSize: 18, letterSpacing: '0.16em', color: RED,
          whiteSpace: 'nowrap',
        }}>! CHAMADA NÃO AUTORIZADA</div>
      )}
    </div>
  );
}

/** O nó final AÇÃO — o ponto do ato inteiro: o impacto saiu do texto e virou efeito. */
function ActionNode({ t }) {
  const { fps } = useT();
  const at = B.atacanteWord + 0.55;
  const alive = fadeWin(t, [at, at + 0.5, TOTAL_SECONDS, TOTAL_SECONDS + 1]);
  if (alive <= 0.004) return null;
  const pop = easeHero(t, fps, at);
  return (
    <div style={{ opacity: alive }}>
      <NodeCard x={0} y={868} w={300} h={100} label="AÇÃO" accent={RED}
        active={0.9} appear={0.86 + 0.14 * pop} t={t} float={2} danger={1} />
    </div>
  );
}

/* ================================================================ nós restantes da coluna */

/** Quanto o resto da coluna se apaga enquanto estamos DENTRO de um nó. Sem isto a tela fica
 *  poluída exatamente nos momentos em que o espectador mais precisa de foco. */
function dimOutside(t) {
  const rag = fadeWin(t, [B.ragOpens - 0.2, B.ragOpens + 0.5, RAG_END - 0.4, RAG_END]);
  const data = fadeWin(t, [B.intoContext - 0.7, B.intoContext + 0.3, 48.7, 49.2]);
  // Enquanto a câmera está DENTRO do documento externo, a aplicação lá no canto não pode
  // competir por atenção — mas também não pode sumir, porque o ponto do ato é ela estar fora.
  const ext = fadeWin(t, [B.escondidaWord - 0.5, B.escondidaWord + 0.2, B.lerWord, B.lerWord + 0.5]) * 0.62;
  return Math.max(rag, data, ext) * 0.86;
}

function AppNode({ t, packet }) {
  const { fps } = useT();
  const born = easeHero(t, fps, B.stepsWord);
  if (born <= 0.001) return null;
  const alive = fadeWin(t, [B.stepsWord, B.stepsWord + 0.3, B.agenteWord - 0.4, B.agenteWord + 0.4]);
  if (alive <= 0.004) return null;
  const active = Math.max(
    nodePulse(t, packet, N.app.y),
    easeUI(t, B.appWord, B.appWord + 0.4) * (1 - easeUI(t, B.appWord + 1.2, B.appWord + 1.8)),
  );
  return (
    <NodeCard x={0} y={N.app.y} w={330} h={116} label="APLICAÇÃO" active={active}
      appear={alive * (0.88 + 0.12 * born)} t={t} float={2} dim={dimOutside(t)} />
  );
}

/** O LLM. Ele existe desde o segundo 3 como DESTINO, e no ato final vira o AGENTE — mesmo nó,
 *  outro papel. Por isso não há um "card de agente" separado em lugar nenhum. */
function LlmNode({ t, packet }) {
  const { fps } = useT();
  const born = easeHero(t, fps, B.modelWord);
  if (born <= 0.001) return null;

  const toAgent = easeFlow(t, B.agenteWord - 0.15, B.agenteWord + 0.75);
  const w = interpolate(toAgent, [0, 1], [330, 392]);
  const h = interpolate(toAgent, [0, 1], [116, 140]);

  const hot = easeUI(t, B.injecaoWord, B.injecaoWord + 0.5);
  const active = Math.max(
    nodePulse(t, packet, N.llm.y),
    easeUI(t, B.modelWord, B.modelWord + 0.5) * (1 - easeUI(t, B.pullBack, B.pullBack + 0.6)),
    toAgent * 0.7, hot,
  );
  const col = hot > 0.4 ? RED : ACCENT;
  const bob = breathe(t, { amp: 2, freq: 0.2, phase: 4 });
  const ring = pulse(t, { freq: 0.42 });

  return (
    <Box x={0} y={N.llm.y + bob} w={w} h={h} style={{
      opacity: 1 - dimOutside(t) * 0.82, transform: `scale(${0.9 + 0.1 * born})`,
    }}>
      {/* anel do agente: ele passa a ter alcance, e o alcance é visível antes das tools */}
      {toAgent > 0.02 && (
        <div style={{
          position: 'absolute', left: '50%', top: '50%',
          width: w + 120 + ring * 14, height: h + 120 + ring * 14,
          transform: 'translate(-50%,-50%)', borderRadius: 999,
          border: `1.4px solid ${col}`, opacity: toAgent * (0.14 + ring * 0.12),
        }} />
      )}
      <div style={{
        position: 'absolute', inset: 0, borderRadius: interpolate(toAgent, [0, 1], [16, 22]),
        background: 'linear-gradient(180deg, rgba(16,22,34,0.96) 0%, rgba(9,12,20,0.97) 100%)',
        border: `1.5px solid rgba(${hot > 0.4 ? '255,77,109' : '143,163,191'},0.22)`,
        boxShadow: `0 0 ${26 + active * 42}px ${col}${active > 0.5 ? '35' : '18'}`,
      }} />
      {active > 0.01 && (
        <div style={{
          position: 'absolute', inset: 0, borderRadius: interpolate(toAgent, [0, 1], [16, 22]),
          border: `1.5px solid ${col}`, opacity: active * 0.95,
        }} />
      )}
      <div style={{
        position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {toAgent < 0.02 ? (
          <div style={{
            fontFamily: MONO, fontWeight: 700, fontSize: 30, letterSpacing: '0.18em',
            color: active > 0.3 ? WHITE : 'rgba(255,255,255,0.72)',
          }}>LLM</div>
        ) : (
          <MorphLabel from="LLM" to="AGENTE" p={toAgent} size={34}
            colorFrom="rgba(255,255,255,0.86)" colorTo={WHITE} />
        )}
      </div>
    </Box>
  );
}

/* ========================================================================== arestas */
//
// Todas as ligações do vídeo num lugar só. Cada uma se DESENHA quando a narração chega nela —
// nenhuma aparece pronta — e algumas são reusadas em dois momentos diferentes (a curva do RAG
// serve para a consulta e para o documento voltando), que é o que faz o retrieval ler como
// ida-e-volta e não como dois efeitos sem relação.

// As arestas são roteadas por NÍVEL, não por uma fórmula só. Uma curva genérica do agente até
// ARQUIVOS passava por dentro do card da API — e uma linha cruzando um card lê como se as duas
// ferramentas estivessem ligadas entre si.
const AGENT_EDGES = TOOLS.map(tool => {
  const sx = Math.sign(tool.x) || 0;
  const to = { x: tool.x, y: tool.y - 50 };
  if (sx === 0) {
    // saída pelo fundo do agente (meia-altura 70), senão a linha nasce dentro dele
    return { key: tool.key, at: tool.at, P: curveV({ x: 0, y: N.llm.y + 78 }, to, 0.5) };
  }
  if (tool.y < 700) {
    // 1º nível: sai pela lateral do agente e chega no topo do card
    return { key: tool.key, at: tool.at, P: curveHV({ x: sx * 196, y: N.llm.y + 46 }, to, 0.5) };
  }
  // 2º nível: desce colado ao centro até PASSAR do card de cima, e só então abre para fora
  return {
    key: tool.key,
    at: tool.at,
    P: [
      { x: sx * 132, y: N.llm.y + 72 },
      { x: sx * 132, y: 690 },
      { x: tool.x, y: 700 },
      to,
    ],
  };
});

function Edges({ t, packet }) {
  const dim = dimOutside(t);

  // ato 1: a ligação ingênua USUÁRIO -> LLM
  const naiveDraw = easeUI(t, B.modelWord - 0.1, B.modelWord + 0.7);
  const naiveOut = 1 - easeUI(t, B.stepsWord, B.stepsWord + 0.6);

  // as quatro etapas reais
  // A aresta CONTEXTO->LLM sobrevive um pouco mais: é por ela que a injeção desce até o agente.
  const spineOut = easeUI(t, B.agenteWord - 0.6, B.agenteWord + 0.2);
  const ctxOut = easeUI(t, B.injecaoWord + 0.4, B.injecaoWord + 1.1);
  const segs = SEGMENTS.map((s, i) => ({
    ...s,
    p: easeUI(t, s.at, s.at + 0.5),
    out: i === 2 ? 1 - ctxOut : 1 - spineOut,
  }));

  // system -> contexto
  const sysDraw = easeUI(t, B.bothArrive - 0.35, B.bothArrive + 0.55);
  const sysAlive = fadeWin(t, [B.bothArrive - 0.4, B.bothArrive + 0.2, B.userSource + 0.6, B.userSource + 1.3]);

  // RAG: consulta saindo, documento voltando
  const ragAlive = fadeWin(t, [B.buscaWord - 0.2, B.buscaWord + 0.35, RAG_END, RAG_END + 0.4]);

  // a instrução maliciosa descendo do documento para o contexto
  const malP = easeFlow(t, B.intoContext - 0.45, B.intoContext + 0.35);
  const malAlive = fadeWin(t, [B.intoContext - 0.5, B.intoContext - 0.1, B.aquiloWord + 0.3, B.aquiloWord + 0.9]);

  // documento externo -> contexto, atravessando a fronteira
  const extDraw = easeUI(t, B.lerWord - 0.1, B.lerWord + 0.9);
  const extAlive = fadeWin(t, [B.lerWord - 0.2, B.lerWord + 0.3, B.perigosoWord + 0.5, B.perigosoWord + 1.2]);
  const extPulse = easeFlow(t, B.lerWord + 0.15, B.indirectWord - 0.15);

  // cadeia final
  const finalDraw = easeUI(t, B.atacanteWord + 0.35, B.atacanteWord + 1.1);

  return (
    <WorldSvg>
      {/* --- coluna do pipeline --- */}
      {naiveOut > 0.01 && (
        <Edge P={NAIVE} p={naiveDraw} color={STEEL_DIM} width={2.4} opacity={naiveOut * 0.9} />
      )}
      {segs.map((s, i) => s.p > 0.01 && (
        <g key={i} opacity={(1 - dim * 0.9) * s.out}>
          <Edge P={s.P} p={s.p} color={STEEL_DIM} width={2.4} />
          <ArrowHead P={s.P} at={s.p} color="rgba(143,163,191,0.5)" size={10} opacity={s.p} />
        </g>
      ))}

      {/* rótulos curtos das duas origens, no momento em que ambas chegam ao contexto */}
      {sysAlive > 0.01 && (
        <g opacity={sysAlive}>
          <Edge P={SYS_EDGE} p={sysDraw} color="rgba(255,212,0,0.55)" width={2.4} glow={sysDraw} />
          <ArrowHead P={SYS_EDGE} at={sysDraw} color={ACCENT} size={11} opacity={sysDraw} />
          <text x={334} y={N.app.y - 96} fill={ACCENT} fontFamily={MONO} fontSize="34"
            letterSpacing="4" opacity={0.85 * easeUI(t, B.bothArrive + 0.2, B.bothArrive + 0.7)}>
            INSTRUÇÕES
          </text>
          <text x={-306} y={N.app.y - 96} fill={STEEL} fontFamily={MONO} fontSize="34"
            letterSpacing="4" opacity={0.8 * easeUI(t, B.bothArrive + 0.35, B.bothArrive + 0.85)}>
            PROMPT
          </text>
        </g>
      )}

      {/* --- RAG --- */}
      {ragAlive > 0.01 && SRC_META.map(s => {
        const P = SRC_CURVE[s.key];
        const query = easeUI(t, B.buscaWord, s.at + 0.1);                 // a consulta chega NA palavra
        const back = s.picked ? easeFlow(t, B.mandaWord, s.lands) : 0;
        return (
          <g key={s.key} opacity={ragAlive}>
            <Edge P={P} p={query} color={s.picked ? 'rgba(255,212,0,0.40)' : STEEL_DIM} width={2} />
            {query < 1 && <Pulse P={P} p={query} color={ACCENT} opacity={query > 0.02 ? 1 : 0} size={7} />}
            {back > 0.002 && back < 0.995 && (
              <Pulse P={P} p={1 - back} color={ACCENT} size={10} />
            )}
          </g>
        );
      })}

      {/* --- a instrução maliciosa entrando no contexto --- */}
      {malAlive > 0.01 && (() => {
        const P = SRC_CURVE.pdfs;
        return (
          <g opacity={malAlive}>
            <Edge P={P} p={1} color="rgba(255,77,109,0.45)" width={2.2} glow={malP} />
            {malP > 0.01 && malP < 0.99 && <Pulse P={P} p={1 - malP} color={RED} size={11} />}
          </g>
        );
      })()}

      {/* --- documento externo atravessando a fronteira da aplicação --- */}
      {extAlive > 0.01 && (
        <g opacity={extAlive}>
          <Edge P={EXT_EDGE} p={extDraw} color="rgba(255,77,109,0.5)" width={2.4} glow={extDraw} />
          <ArrowHead P={EXT_EDGE} at={extDraw} color={RED} size={11} opacity={extDraw} />
          {extPulse > 0.01 && extPulse < 0.99 && <Pulse P={EXT_EDGE} p={extPulse} color={RED} size={11} />}
        </g>
      )}

      {/* --- agente -> ferramentas --- */}
      {AGENT_EDGES.map(e => {
        const p = easeUI(t, e.at - 0.05, e.at + 0.55);
        if (p <= 0.01) return null;
        // TODAS recolhem, a da API inclusive: no frame final ela já virou a cadeia vertical.
        const isApi = e.key === 'api';
        const out = 1 - easeFlow(t, B.atacanteWord - 0.1, B.atacanteWord + 0.7);
        const hot = isApi ? easeUI(t, B.executeWord, B.executeWord + 0.4) : 0;
        return (
          <g key={e.key} opacity={out}>
            <Edge P={e.P} p={p} color={hot > 0.3 ? 'rgba(255,77,109,0.6)' : STEEL_DIM}
              width={2.2} glow={hot} />
            <ArrowHead P={e.P} at={p} color={hot > 0.3 ? RED : 'rgba(143,163,191,0.5)'} size={9} opacity={p} />
          </g>
        );
      })}

      {/* --- cadeia conceitual final: AGENTE -> TOOL/API -> AÇÃO --- */}
      {finalDraw > 0.01 && (
        <g opacity={finalDraw}>
          <Edge P={curveV({ x: 0, y: 116 }, { x: 0, y: N.llm.y - 76 }, 0.5)} p={finalDraw}
            color="rgba(255,77,109,0.55)" width={2.6} glow={0.7} />
          <Edge P={curveV({ x: 0, y: N.llm.y + 72 }, { x: 0, y: 562 }, 0.5)} p={finalDraw}
            color="rgba(255,77,109,0.55)" width={2.6} glow={0.7} />
          <Edge P={curveV({ x: 0, y: 668 }, { x: 0, y: 816 }, 0.5)} p={easeUI(t, B.atacanteWord + 0.6, B.atacanteWord + 1.2)}
            color="rgba(255,77,109,0.55)" width={2.6} glow={0.7} />
        </g>
      )}
    </WorldSvg>
  );
}

/* ======================================================= termos técnicos (espaço de tela) */
//
// Desenhados FORA da câmera e depois pousados sobre o diagrama via `w2s`. Se vivessem no
// mundo, encolheriam junto com a câmera — e nos planos abertos (z = 0,47 no ato INDIRECT)
// ficariam ilegíveis exatamente no momento em que o termo precisa dominar a tela.

function HeroTerms({ t, cam }) {
  const land = (wx, wy, size) => {
    const p = w2s(cam, wx, wy);
    return { x: p.x, y: p.y, size: size * cam.z };
  };
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <TermReveal
        text="RAG" at={B.ragWord - 0.12} t={t} sub="BUSCA EXTERNA"
        from={{ x: VW / 2, y: VH * 0.34, size: 168 }}
        to={{ ...land(250, -113, 26), at: B.ragOpens, dur: 0.75 }}
        out={RAG_END - 0.2}
      />
      <TermReveal
        text="DIRECT" at={B.directWord - 0.1} t={t} sub="PROMPT INJECTION"
        from={{ x: VW / 2, y: VH * 0.40, size: 122 }}
        to={{ ...land(0, -466, 25), at: B.injectionWord + 0.35, dur: 0.8 }}
        out={B.impactoWord + 0.2}
      />
      <TermReveal
        text="INDIRECT" at={B.indirectWord - 0.1} t={t} sub="PROMPT INJECTION"
        from={{ x: VW / 2, y: VH * 0.34, size: 108 }}
        to={{ ...land(-250, 640, 26), at: B.indirectEnd + 0.3, dur: 0.8 }}
        out={B.perigosoWord + 0.7}
      />
      <TermReveal
        text="PROMPT INJECTION" at={B.atacanteWord - 0.25} t={t}
        from={{ x: VW / 2, y: VH * 0.30, size: 84 }}
        to={{ ...land(0, 44, 42), at: B.atacanteWord + 0.5, dur: 0.85 }}
      />
    </AbsoluteFill>
  );
}

/** Quanto o mundo se apaga para o termo dominar. Curto, e só nos quatro termos. */
function heroDim(t) {
  const win = (a, b) => fadeWin(t, [a - 0.2, a + 0.15, b - 0.3, b]);
  return 0.74 * Math.max(
    win(B.ragWord, B.ragOpens + 0.2),
    win(B.directWord, B.injectionWord + 0.45),
    win(B.indirectWord, B.indirectEnd + 0.4),
    win(B.atacanteWord - 0.15, B.atacanteWord + 0.6),
  );
}

/* ============================================================================== clima */
//
// "Agora vem o problema" não é um jumpscare: é o ambiente mudando de lado. Vinheta vermelha
// que respira, e uma banda de varredura lenta. Nada pisca, nada corta.

function Mood({ t }) {
  const danger = easeUI(t, B.problemWord, B.problemLands + 0.8);
  if (danger <= 0.004) return null;
  const br = pulse(t, { freq: 0.16 });
  const scanY = ((t * 9) % 140) - 20;
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <AbsoluteFill style={{
        background: `radial-gradient(120% 78% at 50% 50%, transparent 42%, rgba(255,77,109,${(0.026 + br * 0.018) * danger}) 100%)`,
      }} />
      <div style={{
        position: 'absolute', left: 0, right: 0, top: `${scanY}%`, height: '3%',
        background: `linear-gradient(180deg, transparent, rgba(255,77,109,${0.016 * danger}), transparent)`,
      }} />
    </AbsoluteFill>
  );
}

/* =============================================================================== raiz */

export function PromptInjection({ bg = PREVIEW_BG }) {
  const { t } = useT();
  const cam = useCamera(t);
  const packet = packetState(t);
  const dim = heroDim(t);

  // As métricas de texto precisam estar estáveis antes do primeiro frame, senão preview e
  // render divergem. Timeout de segurança: nunca travar um render por causa de uma fonte.
  const [handle] = useState(() => delayRender('load-fonts'));
  useEffect(() => {
    let done = false;
    const finish = () => { if (!done) { done = true; continueRender(handle); } };
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      document.fonts.ready.then(finish).catch(finish);
    } else finish();
    const timer = setTimeout(finish, 3000);
    return () => clearTimeout(timer);
  }, [handle]);

  const heat = t > B.problemWord ? 1 : 0;

  return (
    <AbsoluteFill style={{ backgroundColor: bg || 'transparent', overflow: 'hidden' }}>
      {/* plano de fundo — parallax mais lento, para a câmera ter contra o quê se mover */}
      <AbsoluteFill style={{
        transform: `scale(${1 + (cam.z - 1) * 0.3}) translate(${-cam.x * 0.14}px, ${-cam.y * 0.14}px)`,
      }}>
        <GridField t={t} tint={heat ? RED : ACCENT} heat={heat} />
        <Motes t={t} color={heat ? RED : STEEL} />
      </AbsoluteFill>

      {/* O MUNDO. Uma única transformação de câmera; tudo o mais vive em coordenadas fixas. */}
      <AbsoluteFill style={{ opacity: 1 - dim }}>
        <div style={{
          position: 'absolute', left: '50%', top: '50%', width: 0, height: 0,
          transform: `scale(${cam.z}) translate(${-cam.x}px, ${-cam.y}px)`,
        }}>
          <AppBoundary t={t} />
          <Edges t={t} packet={packet} />

          {SRC_META.map(s => <SourceCard key={s.key} s={s} t={t} />)}
          <MaliciousDoc t={t} />
          <ExternalDoc t={t} />
          <SystemLayer t={t} />

          <ChatToUserNode t={t} />
          <AppNode t={t} packet={packet} />
          <ContextNode t={t} packet={packet} />
          <LlmNode t={t} packet={packet} />
          {/* antes da resposta: o que vaza tem que passar POR TRÁS dela, não por cima */}
          <LeakCards t={t} />
          <AnswerNode t={t} packet={packet} />

          {TOOLS.map(tool => <ToolNode key={tool.key} tool={tool} t={t} />)}
          <ActionNode t={t} />

          {packet.visible && (
            <Packet x={packet.x} y={packet.y} label={packet.label} color={packet.color}
              speed={packet.speed} scale={packet.scale} angle={packet.angle || 0} />
          )}
        </div>
      </AbsoluteFill>

      <HeroTerms t={t} cam={cam} />
      <Mood t={t} />
    </AbsoluteFill>
  );
}
