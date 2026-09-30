# Motion house style — APROVADO

> **Status: aprovado pelo Derick em 2026-09-09**, na vinheta Brute Force → Race Condition
> (`remotion/scenes/BruteForceRaceCondition.jsx`, entregue em
> `output/overlays/bfrc-final-60fps-alpha.mov`).
>
> Este documento existe para que o resultado seja **reproduzível em vídeos futuros**, e para que
> ninguém "conserte" por engano um valor que foi escolhido de propósito. Se for mexer em algo
> aqui, mexa sabendo que está saindo de um resultado já aprovado.

Referência de ritmo: conteúdo tech vertical de alta retenção (Reels/TikTok), não apresentação
educacional. O espectador precisa entender a história **mesmo sem áudio**, e a animação nunca
compete com a narração.

---

## 1. Paleta

| Papel | Valor |
|---|---|
| Destaque / trilha A | `#FFD400` (amarelo da casa) |
| Trilha B (só onde há concorrência) | `#4DD8FF` (ciano) |
| Texto principal | `#ffffff` |
| Sucesso | `#4dff88` |
| Erro / o bug | `#ff4d6d` |
| Caveira (punchline) | `#ff2d50` |
| Fundo de preview | `#04140b` (verde bem escuro) — **preview apenas** |

O ciano existe **só** para separar duas trilhas simultâneas. Não é uma segunda cor de marca; não
usar fora de cenas de concorrência.

O overlay final **nunca** leva fundo bakeado (`bg={null}`).

## 2. Tipografia

- Display: `"Segoe UI", Inter, system-ui, -apple-system, sans-serif`, weight 900, `letter-spacing: -0.03em`
- Mono (código, números, requests): `"Cascadia Code", "JetBrains Mono", Consolas, monospace`

Hierarquia agressiva: **uma coisa importante por vez**. Texto grande é reservado a conceitos-chave
(`10.000`, `5837`, `RACE CONDITION`, `ESTOQUE = 1`, `1 HAMBÚRGUER / 2 PEDIDOS`). Elementos
explicativos ficam claramente menores.

## 3. Safe area (9:16)

`SAFE_X = 60px` de cada lado. Orçamento útil de largura: **960px** em 1080.

Regra de dimensionamento de texto hero:

```
largura estimada ≈ nº de caracteres × 0.60 × fontSize
```

Essa largura, **multiplicada pelo zoom máximo da câmera naquela cena**, tem que caber em 960px.
Foi assim que se descobriu que `10.000` a 290px media ~1107px e estourava.

Overflow só é permitido quando **um movimento de câmera o motiva** (push-in para dentro do display
do cofre, colisão do título) e **sempre resolve** para um enquadramento limpo. Se parece que "o
elemento escapou sem querer", é bug.

## 4. Vocabulário de easing

Nunca um único spring para tudo — preset único é o que faz o motion parecer "componente React
transicionando" em vez de objetos com massas diferentes.

| Família | Uso | Config |
|---|---|---|
| `easeHero` | texto/número hero | spring `damping 13, mass 0.5, stiffness 220` — entra rápido, overshoot curto, settle firme |
| `easeUI` | chrome de interface | `Easing.out(Easing.cubic)` — praticamente sem overshoot |
| `easeHeavy` | objeto pesado (o cofre) | spring `damping 24, mass 1.7, stiffness 85` — inércia visível |
| `easeRequest` | projétil / request | `Easing.bezier(0.55, 0, 0.85, 0.35)` — ganha velocidade e rasga |
| `easeMicro` | elemento de baixa atenção | `Easing.out(Easing.quad)` |

**Cuidado que já custou caro:** para uma entrada vinda de fora do canvas, usar ease-**out**, nunca
ease-in. Ease-in começa com velocidade zero — o elemento fica fora da tela e o frame fica vazio.

## 5. Secondary motion

Depois que o movimento principal termina, o elemento **não para morto**:

- `settleWobble(t, at, { amp, freq, decay })` — oscilação com decaimento exponencial. Isso é
  inércia, não "dança".
- `impactShake(t, at, { amp, dur })` — **só** em impacto, nunca ambiente.

Proporção: ação principal ~12 frames, settle secundário +5–10 frames.

## 6. Câmera

Pensar como câmera mesmo sendo 2D. Um "master zoom" corre **por baixo dos cortes de cena**, com
keyframes em segundos, para um ato inteiro ler como um movimento contínuo — e reseta só onde a
narrativa reseta. Mais um drift permanente de poucos pixels (`sin`/`cos` lento) para o frame nunca
ficar perfeitamente estático.

Movimento de câmera precisa **dirigir atenção**. Não mover sem motivo.

## 7. Profundidade

Três planos com parallax, mesmo em 2D. Quanto mais na frente: maior, mais opaco, mais borrado,
mais rápido, mais deslocamento com o push da câmera.

```
depth 0.0  → size 17px, opacity 0.22, blur 0.4px, parallax 0.25, speed 0.06
depth 1.0  → size 62px, opacity 0.55, blur 3.2px, parallax 2.40, speed 0.42
```

**Densidade percebida > contagem literal.** ~46 nós de DOM representam mil chamadas. Nunca criar
milhares de elementos.

## 8. Continuidade — a regra mais importante

```
ANTICIPATION → ACTION → IMPACT → SETTLE → TRANSITION
```

Uma cena **causa** a próxima. O protagonista de uma cena idealmente gera o protagonista da
seguinte. Evitar `cena A → fade → cena B`.

Exemplo canônico aprovado: `5837` não corta para `REQUEST #5837` — ele **vira**: o ✓ cai, a
cápsula se desenha em volta, "REQUEST #" desliza para dentro, a pílula carrega para trás
(anticipation) e dispara com smear; a linha de velocidade **sobrevive à cápsula** e leva o olho
para a cena seguinte.

Testes de qualidade, antes de dar uma cena por pronta:
1. Removendo o texto, ainda dá para saber para onde olhar? Se não, o motion está fraco.
2. Essa cena poderia ser feita só com opacity + scale? Se sim, ainda está simples demais.

## 9. Motion blur

**Não usar `<Trail>` do `@remotion/motion-blur` em elementos cuja aparência depende do frame
atual.** Ele re-renderiza os filhos contra frames defasados; num elemento com `clipPath` de
revelação isso re-executa a revelação quase do zero. Foi exatamente isso que fez a cápsula
`REQUEST #5837` colapsar num badge minúsculo mostrando só o "R".

Padrão aprovado — smear direcional próprio, sobre um style **já computado**:

```jsx
{speed > 0.05 && (
  <div style={{ position: 'absolute', inset: 0 }}>
    {[1, 2, 3].map(i => (
      <div key={i} style={{
        position: 'absolute', inset: 0,
        transform: `translateX(${-i * 26 * speed}px)`,
        opacity: 0.34 / i,
        filter: `blur(${i * 1.4}px)`,
      }}>{element}</div>
    ))}
  </div>
)}
{element}
```

## 10. Timing fps-agnostic

**Todo timing é autorado em SEGUNDOS**, convertido com `useVideoConfig().fps` na leitura. Nada
preso a 30fps. Isso é o que permite renderizar o mesmo fonte a 30fps (draft rápido) e 60fps
(entrega, casando com a fonte 60fps) sem timing dobrar ou encolher.

```js
function useT() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return { t: frame / fps, fps, frame };
}
```

Durações de cena vivem num objeto `SCENE_SECONDS` exportado, para que scripts externos (o cue
sheet de SFX) leiam os mesmos números e não saiam de sincronia.

## 11. Determinismo

- Todo aleatório usa `random(seed)` do Remotion. Nunca `Math.random()`.
- Elemento nunca aparece por 1 frame: sempre `fadeWin` com entrada de ≥4 frames.
- Nunca usar limiar que "vira" (`if (random(s) > intensity)`) para fazer algo aparecer — isso
  pisca. Usar **tempo de nascimento fixo** por elemento.
- `fadeWin` força as paradas estritamente crescentes antes do `interpolate`, que lança exceção em
  range não-monotônico. Com beats derivados de duração de cena, duas paradas podem colidir
  legitimamente — derrubar o render no meio é bem pior que um fade de duração zero.

## 12. Fontes

`delayRender`/`continueRender` com `document.fonts.ready` **e um timeout de segurança de 3s**, para
o render nunca travar por causa de uma fonte que não carrega.

## 12b. Narração — corte de silêncio e sincronia (APROVADO)

> Aprovado pelo Derick em 2026-09-09: *"essa configuração de áudio que tu fez na narração ficou
> perfeita, também essa verificação de silêncio útil ou inútil, ficou incrível"*.

### O princípio: nem todo silêncio é desperdício

Um corte de silêncio cego destrói o vídeo. As pausas se dividem em duas categorias e **têm que
ser tratadas de forma oposta**:

| Tipo | O que é | O que fazer |
|---|---|---|
| **Respiratória** | ele parando pra respirar entre frases | encurtar para ~0,20s |
| **Dramática** | setup de piada, tensão antes da virada, beat antes do reveal | **preservar** — e às vezes **estender** |

Como identificar uma dramática: ela **coincide com um beat da animação**. Se a animação congela,
dá punch-in ou revela algo naquele ponto, a pausa é parte da edição, não sobra.

Na vinheta aprovada, as 4 dramáticas eram: antes do "Tcharam" (reveal do 5837), no "...um tiro"
(freeze da caveira), depois de "tô brincando" (reset), e depois de "só tinha um hambúrguer"
(o beat do `1 ≠ 2`).

### A ferramenta

`scripts/retime-narration.mjs` — corta pausa a pausa a partir da transcrição word-level:

```bash
ve transcribe narracao.mp3 --language pt --out temp/narr.json
node scripts/retime-narration.mjs narracao.mp3 temp/narr.json temp/narr-tight.mp3
```

Valores que funcionaram (mexer só com motivo):

```js
const MIN_GAP = 0.30;        // abaixo disso é ritmo natural de fala, não encostar
const DEFAULT_TARGET = 0.20; // respiratórias vão pra cá
const HEAD_KEEP = 0.08;
const TAIL_KEEP = 0.20;
```

Beats protegidos ficam num array declarativo, ancorados **na palavra que a pausa segue** (com
`nth` quando a palavra se repete), cada um com o motivo escrito:

```js
{ after: 'tiro,', target: 0.60, why: 'FREEZE da caveira — a tomada emendou, o silêncio é inserido' }
```

`target` maior que a pausa real **insere** silêncio. Isso não é hipotético: na tomada aprovada
ele emendou "...te dá um tiro, eu tô brincando" sem respirar, e o freeze da caveira não tinha
onde existir. Inserir 0,60s ali salvou a piada sem regravar.

Só a parte **estendida** é silêncio digital; onde a pausa é apenas encurtada, o room tone real é
preservado — é isso que evita o "pumping" de 26 emendas seguidas.

### Por que não usar `ve remove-silence`

- É tudo-ou-nada por pausa: não sabe preservar nem estender. Na vinheta ele **apagava inteira**
  a pausa da piada.
- Recusa entrada só-áudio: o filtergraph mapeia `[0:v]`. O `--dry-run` passa e o render quebra.

Ele continua certo pra vídeo. Pra narração, use o script acima.

### Ordem de trabalho

```
1. transcrever         -> ve transcribe (word-level)
2. classificar pausas  -> dramáticas vs respiratórias
3. cortar              -> retime-narration.mjs
4. RE-transcrever      -> os timestamps mudaram; a animação ancora nos novos
5. ancorar a animação  -> SCENE_SECONDS e beats internos = onsets de palavra
6. verificar por energia o que o Whisper não transcreve
```

**O passo 6 não é opcional.** O Whisper não transcreve interjeições ("Tcharam") e erra fronteiras
de palavra — ele reportou "tiro" e "tô brincando" colados quando havia 0,515s de silêncio entre
eles. Confira com:

```bash
ffmpeg -ss <t> -to <t> -i audio.mp3 -af "silencedetect=n=-38dB:d=0.10" -f null -
```

### Regras de sincronia

- Beat visual dispara **na palavra**, não perto dela. Os números em `SCENE_SECONDS` viram
  medições, não preferências — não arredondar.
- Reveal cômico antecipa a fala em 2-4 frames. O `5837` aparece **antes** do "Tcharam".
- Se a narração inverte a ordem lógica, a animação se inverte junto: ele diz "isso é race
  condition" **antes** de explicar, então o impacto abre a cena e o diagrama se constrói embaixo
  da explicação.
- Uma cena que dobra de duração é **reencenada**, não esticada. `race` foi de 5,2s → 11,6s e
  ganhou o card "PEDIDO A — NÃO REGISTRADO / ESTOQUE AINDA = 1" pra ocupar o trecho em que ele
  explica que o pedido não foi registrado.

### Mixagem

`ve add-sfx --duck` **quando há voz** (dipa os efeitos sob a fala), `--no-duck` quando não há.
Errar isso faz os SFX brigarem com a narração.

Ao juntar áudio e vídeo, **nunca usar `-shortest`** se a animação continua depois da narração —
ele corta o final. Preencher com silêncio:

```bash
ffmpeg -i video.webm -i narr.mp3 -filter_complex "[1:a]apad=whole_dur=<dur>[a]" \
  -map 0:v:0 -map "[a]" -c:v libx264 -crf 20 -pix_fmt yuv420p -c:a aac out.mp4
```

## 13. Sound design

Mapa: movimento→whoosh, entrada→pop, impacto→hit, contador→ticks, erro→click, sucesso→ding,
glitch→digital, punchline→**silêncio**.

A voz é sempre a protagonista; SFX sempre abaixo. Não colocar som em tudo — depois de alguns
segundos o espectador ignora.

**Silêncios propositais** (tão importantes quanto os efeitos): antes do loop, ao encontrar a senha,
na piada da "38", no reveal `1 ≠ 2`, e imediatamente antes de voltar para a câmera.

Padrão: `CAOS → SILÊNCIO → IMPACTO`.

Cues ficam num arquivo gerado (`scripts/make-vinheta-cues.mjs` → `docs/vinheta-sfx-cues.md`) que
lê `SCENE_SECONDS` do componente, para o som continuar sincronizável fora do MOV.

## 14. Pipeline de render

```bash
# 1. draft rápido (30fps) para QA visual
ve remotion-render <Comp> --duration <s> --fps 30 --codec vp8 --out temp/check.webm

# 2. overlay final — ProRes 4444, alpha real, 60fps, SEM fundo
ve remotion-render <Comp> --duration <s> --fps 60 --codec prores \
   --props '{"bg":null}' --out output/overlays/final-60fps-alpha.mov

# 3. preview COMPOSTO A PARTIR do MOV com alpha (não um segundo render)
ffmpeg -f lavfi -i "color=c=0x04140b:s=1080x1920:r=60:d=<s>" -i final-60fps-alpha.mov \
  -filter_complex "[0:v][1:v]overlay=format=auto,format=yuv420p" \
  -c:v libx264 -crf 18 -r 60 -an temp/preview-silent.mp4

# 4. SFX no preview
node tools/add-sfx.mjs temp/preview-silent.mp4 --events "$(cat temp/sfx-events.txt)" \
  --min-gap 0.03 --max-per-minute 80 --no-duck --out output/overlays/final-preview.mp4
```

Derivar o preview **do próprio MOV com alpha** garante que preview e entrega sejam exatamente o
mesmo conteúdo, e economiza um render inteiro.

`ve add-sfx` só aceita h264/aac — não aceita VP8 nem PCM em MP4. Converter antes.

## 15. QA obrigatório antes de dar por pronto

A implementação está pronta quando o **render** está bom, não quando o JSX compila.

```bash
# frames vazios + flicker de 1 frame, no vídeo inteiro
ffmpeg -i final.mov -vf "alphaextract,scale=96:170,signalstats,metadata=print:file=-" -f null -

# alpha real (não fundo preto fingindo transparência)
ffmpeg -ss <t> -i final.mov -vf alphaextract -frames:v 1 -y probe.png
# esperado: min 0, max 255, maioria dos pixels totalmente transparente
```

Checar também: texto cortado sem intenção, fonte carregando atrasada, salto entre `Series`,
z-index errado, overflow acidental.

Na entrega aprovada: **2.856 frames, 0 frames vazios, 0 flicker**, alpha 97,3% transparente.
