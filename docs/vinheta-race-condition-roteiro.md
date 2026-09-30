# Vinheta animada — Brute Force → Race Condition (restaurante)

Contexto e roteiro conforme passado por Derick em 2026-09-09, para uso na construção do
componente Remotion desta vinheta.

---

## Vídeo fonte

- Arquivo: `IMG_3459.MOV` (em `Downloads/`, 408s, 2160x3840 vertical, 60fps)
- Transcrição de referência: `temp/img3459-transcript.json`

## Ponto de corte

- **Entrada da animação:** trecho a partir de ~1:46–2:01 (106s–121s), onde no áudio original
  ele diz "eu vou te explicar bem rapidinho, vem cá" (múltiplas tomadas repetidas — usar o
  corte como ponto de entrada da vinheta, não a fala em si).
- **Saída da animação:** a animação termina **exatamente antes** da fala já existente no vídeo
  original "e sabe como é que tu se defende disso aí? com rate limit" (~168s no source). Nesse
  ponto corta de volta para a câmera, e o resto (explicação de rate limit + CTA "segue o Deck
  Dev") **já está gravado** e permanece como está — não faz parte desta animação.
- Ou seja, escopo da animação = só **Brute Force (cofre)** + **Race Condition (restaurante)**.

## Narração

- **Áudio novo**, gravado por Derick separadamente (não é o áudio original do IMG_3459).
- A animação é construída com beats/durações estimadas primeiro; a sincronização fina com o
  áudio real acontece depois que a narração for gravada (por tempo, ou por transcrição
  word-level como o resto do projeto já faz via `ve transcribe`).

## Roteiro (texto literal fornecido)

> O bruteforce em uma analogia bem simples, e o seguinte, imagina que tu tem um cofre e nesse
> cofre tem uma senha de 4[dígitos], entao se cada digito pode ir de 0 a 9 o cara tem X
> possibilidades, se voce for tentar fazer isso na mao voce vai demorar pra krl, agora imagina
> se voce tivesse um loop que fizesse todas as combinacoes ate acertar? ta-daaaa, agora imagina
> isso num restaurante, o mesmo garcom sendo chamado 1000 vezes pelo mesmo cara, ele ia puxar
> uma 38 e dar um ti.... to brincando, basicamente isso pode ser configurado como race
> condition.
>
> Race condition e o seguinte: imagina que tu tá num restaurante e só sobrou um hambúrguer.
>
> Eu chamo o garçom e pergunto: "tem hambúrguer?"
> Ele olha lá: "tem".
>
> Só que, antes dele registrar o meu pedido, outra pessoa chama outro garçom e pergunta a mesma
> coisa.
> O sistema olha de novo: "tem hambúrguer?"
> Tem.
>
> Pronto. Os dois pedidos foram aceitos… mas só tinha um hambúrguer.
>
> Isso é uma race condition.
>
> Duas requisições chegaram praticamente ao mesmo tempo, as duas verificaram o mesmo estado
> antes de uma delas conseguir alterar esse estado, e aí teu sistema fez merda.
>
> Agora imagina isso com estoque, cupom de uso único, saldo de uma conta ou compra de ingresso.

**[FIM DA ANIMAÇÃO AQUI — corta para a câmera, onde já existe gravado:]**

> E beleza: como é que a gente evita que um maluco consiga ficar martelando nossa API desse
> jeito? Rate limit. [...] (já gravado, não re-narrar)

## Beats de conteúdo (para dividir em cenas Remotion)

1. **Cofre / bruteforce:** cofre com 4 dígitos, 0-9 cada → X combinações. Testar na mão =
   lento. Loop testando todas as combinações até acertar = brute force.
2. **Transição pro restaurante:** mesmo garçom chamado 1000x pelo mesmo cliente (o "brute
   force" martelando). Piada da "38" é só falada na narração — **não precisa ser ilustrada**.
3. **Race condition — setup:** só sobrou 1 hambúrguer.
4. **Race condition — o bug:** dois clientes perguntam quase ao mesmo tempo, dois garçons
   checam "tem?" → "tem" **antes** de qualquer um dos dois registrar o pedido → os dois pedidos
   são aceitos, só tinha 1.
5. **Generalização:** mesma coisa vale pra estoque, cupom de uso único, saldo de conta, compra
   de ingresso.

## Estilo visual — CONFIRMADO

Formato 9:16, fundo transparente, paleta branco/preto/amarelo (`#FFD400`), no padrão dos
componentes existentes (`Terminal`, `CodeBlock`, `Notification`). Referência de ritmo:
conteúdo de programação estilo YuriDev — extremamente dinâmico, punch-ins, zooms, elementos
entrando/saindo o tempo todo, texto só pra destacar palavras-chave, nunca um parágrafo ou card
estático. A animação complementa a narração, não a lê em voz alta.

Explicitamente descartado: cards estáticos em sequência, parágrafos na tela, motion corporativo,
qualquer cena parada por muito tempo enquanto a narração continua.

## Roteiro visual cena a cena

> Este é o roteiro completo fornecido por Derick — a fonte de verdade para a implementação. Ver
> histórico da conversa em 2026-09-09 para o texto integral, cena por cena (1 a 10 + transição +
> final), com timings, beats, textos exatos na tela, e a piada da "38" (que é só falada, nunca
> ilustrada — a regra é congelar tudo, mostrar 💀 ou o garçom olhando pra câmera, silêncio
> visual, e só voltar ao normal quando ele disser "tô brincando").
>
> Resumo das cenas:
> 1. Cofre entra com impacto → título BRUTE FORCE → PIN `[0][0][0][0]` → dígitos girando →
>    enxame de combinações → `10.000 COMBINAÇÕES` com micro-shake.
> 2. Tentativa manual lenta e irritante (`0000 ❌`, pausa, `0001 ❌`...) → HARD CUT no "imagina
>    se você tivesse um loop" → `for` loop num terminal/code block → contador acelera até virar
>    blur → `5837 ✅` → FREEZE, destaque, partículas, `BRUTE FORCE — TA-DAAA ✨` sincronizado
>    com a narração.
> 3. Transição: o PIN vira `REQUEST #5837`, sai disparado lateralmente, câmera acompanha, entra
>    na interface do restaurante.
> 4. Cliente chama `GARÇOM!` (bolha), repete, acelera absurdamente (x10...x1000), garçom
>    trembling, `REQUESTS ████ 1000`, caos visual → piada da 38 (freeze, 💀, silêncio) →
>    "tô brincando" → tudo cai/desaparece rápido.
> 5. Reset: tela limpa, `RACE CONDITION` com glitch/duas cópias sobrepostas, some.
> 6. `🍔 ESTOQUE 1` grande, badge `ÚLTIMO 🍔`, câmera aproxima.
> 7. Cliente A: `GET /hamburger` viaja até o sistema, `CHECK STOCK... STOCK = 1`,
>    `200 — TEM ✅`, estoque continua em 1 (NÃO decrementa ainda).
> 8. Cliente B entra antes do pedido A ser registrado: split-screen, `REQUEST A`/`REQUEST B`
>    convergindo pro mesmo `ESTOQUE = 1`, ambos `TEM ✅`, `👀`.
> 9. `CREATE ORDER A` / `CREATE ORDER B` quase juntos, `PEDIDO #101 ✅` / `PEDIDO #102 ✅` (dois
>    POPs), `🍔×1` vs `🧾×2`, `1 ≠ 2`, freeze — a imagem que precisa fazer entender antes da
>    explicação terminar.
> 10. Explicação técnica: timeline READ/WRITE de A e B se sobrepondo, `MESMO ESTADO / MESMO
>     MOMENTO`, `💥 RACE CONDITION`. 2-4s, sem virar aula.
> 11. Generalização: hambúrguer morpha rápido (~0.5-1s cada) em cupom/saldo/ingresso, todos
>     convergem pra `RACE CONDITION`.
> 12. Final: pergunta em aberto (`???` ou requests batendo numa API), tudo sai de cena, fica
>     transparente, corta pra câmera exatamente antes de "e sabe como é que tu se defende disso
>     aí? com rate limit" — o payoff acontece na câmera, não na animação.

## Princípios de motion (regras gerais)

1. Nunca a mesma composição parada por muito tempo — mudança de escala/posição/elemento a cada
   ~1-2s.
2. `spring` para entradas importantes, `interpolate` para movimentos menores.
3. Overshoot em números e palavras-chave; micro-shake só em impactos; blur/motion quando
   números passam muito rápido.
4. Elementos secundários somem quando deixam de ser relevantes — hierarquia agressiva, uma
   coisa importante de cada vez.
5. Texto grande reservado a conceitos-chave: `BRUTE FORCE`, `10.000`, `RACE CONDITION`,
   `ESTOQUE = 1`, `PEDIDOS = 2`.
6. Precisa fazer sentido mesmo mudo, e não pode competir com a narração — mostra exatamente o
   que está sendo contado, não mais, não menos.

## Arquitetura técnica proposta

**Abordagem recomendada: uma única composição, várias cenas internas com `<Series>`.**

- Novo arquivo `remotion/scenes/BruteForceRaceCondition.jsx` (fora de `components.jsx` pra não
  inchar o arquivo principal — ele só passa a re-exportar e registrar em `COMPONENTS`).
- Internamente usa `<Series>` do Remotion pra encadear as ~12 cenas do roteiro como uma
  composição contínua (permite as transições "morphing"/"travel" do roteiro, que um encadeamento
  por `add-overlay` separado em vários arquivos não permitiria).
- Duração de cada cena como constantes em frames (30fps), mas expostas via prop
  `sceneDurations` com overrides opcionais — porque a narração real ainda não existe; a
  temporização fina roda depois que o áudio for gravado e transcrito (mesmo padrão de
  `ve transcribe` usado no resto do projeto), sem precisar reescrever a lógica das cenas.
- Estimativa inicial de timing (a recravar com a narração real), ~50s total, dentro do teto de
  60s do `remotion-render`:

  | Cena | Duração estimada |
  |---|---|
  | 1. Cofre + combinações + 10.000 | 8s |
  | 2. Manual lento → loop rápido → freeze/tada | 8s |
  | Transição (request viaja) | 1.5s |
  | 3. Restaurante caótico + piada da 38 | 7s |
  | 4. Reset / título RACE CONDITION | 2s |
  | 5. Estoque = 1 | 2.5s |
  | 6. Cliente A checa estoque | 3s |
  | 7. Cliente B — split race | 3s |
  | 8. O bug (pedidos 101/102, 1≠2) | 4s |
  | 9. Timeline técnica READ/WRITE | 3s |
  | 10. Generalização (4 exemplos) | 4s |
  | Final (saída, transparência) | 1.5s |
  | **Total** | **~50s** |

- **Primitivas visuais reutilizáveis** a construir (poucas, genéricas, parametrizadas — não uma
  componente única por cena):
  - `ImpactText` — texto/número grande com spring+overshoot+shake (título, `10.000`,
    `RACE CONDITION`, `ESTOQUE = 1`...).
  - `DigitReel` — dígito girando/blur, e o contador de tentativas acelerando até acertar o PIN.
  - `RequestChip` — pílula que representa uma requisição e viaja de um ponto a outro
    (`REQUEST #5837`, `GET /hamburger`, `CREATE ORDER A/B`).
  - `PersonBubble` — cliente/garçom com bolha de fala, suporta multiplicar instâncias (x10...
    x1000) pro caos do restaurante.
  - `StatPanel` — ícone + label + número grande + badge opcional (estoque, saldo, cupom,
    ingresso — reaproveitado nos 4 exemplos da generalização via `MorphCycle`).
  - `SplitCompare` — duas colunas simultâneas convergindo pro mesmo estado (cena 8).
  - `Timeline` — barras horizontais READ/WRITE se sobrepondo (cena 10).
  - Reaproveita direto o que já existe: `Terminal`/`CodeBlock` (loop for), `ProgressBar` (barra
    de requests).
- `remotion-render` já suporta tudo isso sem mudança (`--duration`, `--props`, 1080x1920/30fps
  já são o padrão do `Root.jsx`); só precisa registrar o novo componente em `COMPONENTS`.

**Alternativa descartada:** renderizar cada cena como um overlay separado e compor via múltiplas
chamadas de `ve add-overlay` em timestamps diferentes. Foi descartada porque quebra justamente
as transições que o roteiro pede (o PIN "virando" `REQUEST #5837`, o hambúrguer "morphando"
entre os 4 exemplos) — essas só funcionam dentro de uma timeline React contínua, e gerenciar 12
arquivos de overlay sincronizados manualmente é bem mais frágil do que uma composição única.

## Status — v1 construído

- Código: `remotion/scenes/BruteForceRaceCondition.jsx`, registrado em `COMPONENTS`.
- Ícones (lucide-react) em vez de emoji, a pedido — mais credibilidade num vídeo técnico.
- Fundo: `#04140b` (verde bem escuro) só para assistir o draft; o overlay real pra compositar
  no vídeo final deve voltar a ser transparente (prop `bg`, já preparada pra isso).
- Studio ao vivo em `npx remotion studio remotion/index.jsx` (útil pra iterar sem re-renderizar).
- Draft renderizado: `output/overlays/brute-force-race-condition-draft-sfx.mp4` (47.5s).

### Sound design — mapeamento pro catálogo existente (`assets/sfx/`)

O guia de SFX que você passou foi mapeado pros efeitos que já existem no catálogo
(`blip`, `click`, `ding`, `pop`, `riser`, `swoosh`, `thud`, `whoosh`) — não tem "record scratch"
nem "shimmer" dedicados ainda, então esses momentos ficaram só no silêncio (que já é o efeito
mais importante ali mesmo). Eventos aplicados via `ve add-sfx` (43 no total, `--min-gap 0.1
--max-per-minute 60 --no-duck` porque ainda não há narração para dar duck):

| Tempo (s) | Efeito | Motivo |
|---|---|---|
| 0.0 | whoosh | cofre entrando |
| 0.6 | thud | cofre bate no centro |
| 2.0 | click | PIN aparece |
| 7.0 → 7.6 | riser → thud | reveal do "10.000 COMBINAÇÕES" |
| 8–10 | click (x3) | tentativas manuais lentas |
| 11.0 | swoosh | hard cut pro loop |
| 14.6 → 15.0 | riser → ding | acha o PIN certo (silêncio logo antes) |
| 15.3 | blip | partículas do "ta-daaa" |
| 16.0 | whoosh | PIN vira REQUEST #5837 |
| 17.6 | ding | primeiro "GARÇOM!" |
| 20.7 / 22.5 | pop | milestone de caos / "tô brincando" |
| 24.9 + 25.05 | thud + thud (quase juntos) | reveal RACE CONDITION — o próprio som antecipa concorrência |
| 26.5 | ding | ESTOQUE = 1 |
| 29.6–31.3 | whoosh / click / ding | cliente A: request → check → 200 |
| 32.7–34.6 | swoosh / click+click / ding | cliente B: request → as duas leituras quase juntas |
| 35.0–35.65 | click+click / pop+pop | CREATE ORDER A/B, PEDIDO 101/102 |
| 38.3 | thud | "1 ≠ 2" — o impacto do bug |
| 40.5–41.4 | click / blip / thud | timeline técnica READ/WRITE → RACE CONDITION |
| 42.0–44.4 | whoosh (x3) → thud | generalização (estoque→cupom→saldo→ingresso) |
| 45.2 | riser | convergência final |
| 46.2 / 46.5 | click | callback ao brute force, corta pra câmera logo depois |

Isso é v1 — os tempos são os da animação (fixos), não da narração (que ainda não existe). Assim
que você gravar a voz, os SFX deste mapeamento se recalculam junto com o retiming das cenas.

## Status — v2 (motion/escala/continuidade)

Segunda passada, focada só em motion/escala/continuidade/som/tempo, sem mexer na identidade
visual. Mudanças reais:

- **Escala**: elementos-chave (10.000, RACE CONDITION, ESTOQUE=1, 1 HAMBÚRGUER/2 PEDIDOS, ícones
  principais) ~1.3-1.6x maiores.
- **Câmera contínua**: um "master zoom" (1.0→1.55) corre por baixo dos cortes de cena no arco
  cofre→loop→transição→restaurante, dando sensação de um push-in único; reseta pra 1.0 exatamente
  no corte pro título RACE CONDITION, depois um push mais suave carrega o resto até o fim.
- **Restaurante**: zoom de câmera embutido cresce com o caos (1→1.3), bolhas de notificação agora
  aparecem com fade determinístico (sem mais pop de 1 frame), label maior.
- **Race condition (split A/B)**: colunas maiores, linha "GET /hamburger" em cada lado, texto
  central maior — pensado pra dar pra entender só olhando, sem ler a explicação técnica.
- **Tempos mortos removidos**: cofre→loop (~5f), fim do restaurante + início do RACE CONDITION
  (~34f — a maior parte do problema; agora o glitch do título dispara no frame 1, sem hold em
  branco), cliente A→B (split já começa quase no corte, sem lag).
- **Bugs achados e corrigidos nesta passada**: "RACE CONDITION" ficava ilegível (as cópias
  coloridas do glitch pintavam por cima do texto branco por causa da ordem de empilhamento
  absolute/static do CSS); "CLIENTE B" colidia visualmente com a coluna direita do split.
- **Som**: os 43 eventos foram recalculados pros novos tempos de cena e reaplicados
  (`ve add-sfx`). O áudio da v1 NÃO estava mudo — era PCM num contêiner que o player padrão do
  Windows não decodifica bem; o mix real sempre teve sinal (conferido com `volumedetect`).
- **Export final**: `output/overlays/bfrc-v2-final-60fps-alpha.mov` — ProRes 4444, alpha real
  (`yuva444p12le`), 1080x1920, 60fps, sem fundo (transparente), pronto pra `ve add-overlay`.
  Preview pra assistir (fundo verde escuro + SFX): `output/overlays/bfrc-v2-preview.mp4`.

**Sobre o 60fps**: a animação continua sendo *calculada* a 30fps (todos os springs/interpolates
foram escritos nessas unidades) e o arquivo final é conformado pra 60fps via duplicação de frame
no ffmpeg — não é um recálculo nativo a 60fps. Reescrever toda a matemática de frames pra 60fps
nativo era um refactor arriscado de fazer nessa mesma passada; o resultado visual é idêntico (os
springs/interpolates do Remotion já produzem curvas suaves a 30fps), só a taxa de entrega do
arquivo é que passa a bater com o vídeo fonte. Se algum dia dividir o projeto entre várias
sessões de gravação a taxas diferentes isso pode importar mais — por ora não deveria ser
perceptível.

**Não fiz nesta passada** (por escopo/tempo): variação de pitch entre os whooshes de request A/B,
som de "record scratch" dedicado (ainda cai em silêncio puro), e não tripliquei o reveal
"RACE CONDITION" (o roteiro já tem duas aparições — no título e no fechamento técnico — evitei
uma terceira pra não ficar repetitivo).

## Status — v3 (polish pass) — ENTREGA ATUAL

Passada de acabamento: coreografia, continuidade, profundidade, easing, secondary motion,
motion blur, som e render. Direção de arte preservada (amarelo, verde escuro, tipografia,
ícones, estrutura narrativa).

### Correção estrutural

`SceneClientA` e `SceneClientB` eram cenas **sequenciais** — a animação que ensina concorrência
mostrava A terminar antes de B começar, o oposto do conceito. Viraram uma cena só (`SceneRace`)
com as duas trilhas na mesma timeline, ~0,27s de diferença, ambas vivas na tela ao mesmo tempo,
com conectores SVG convergindo no mesmo `ESTOQUE = 1`. Cliente A em amarelo, B em ciano
(`#4DD8FF`) só nessa cena, para separar as trilhas concorrentes.

### Timing fps-agnostic

Todo o timing foi reescrito em **segundos**, lido via `useVideoConfig().fps`. Nada mais está
preso a 30fps: o master agora é 60fps nativo (não mais conformado por duplicação de frame como
na v2), e o mesmo fonte renderiza corretamente a 30fps para drafts rápidos.

### Vocabulário de easing (fim da assinatura de preset)

`easeHero` (texto hero: entra rápido, overshoot curto, settle firme), `easeUI` (ease-out limpo),
`easeHeavy` (inércia, settle lento — o cofre), `easeRequest` (aceleração forte), `easeMicro`.
Mais `settleWobble()` (oscilação decaindo DEPOIS do movimento principal — inércia, não dança) e
`impactShake()` (só em impacto).

### Continuidade / profundidade

- Cofre: push-in físico até o display, dígitos giram, combinações escapam em **três planos de
  parallax** (foreground borrado e rápido / midground / background lento), câmera recua e o
  `10.000` chega como consequência do campo cheio.
- `5837` **se transforma** em `REQUEST #5837` (o ✓ cai, a cápsula se desenha, "REQUEST #"
  desliza), carrega para trás e dispara com smear direcional; a linha de velocidade sobrevive à
  cápsula e leva o olho para o restaurante.
- Restaurante: caos em estágios (x1→x1000), bolhas em três planos, câmera empurra conforme a
  pressão sobe.
- Título: `RACE` e `CONDITION` colidem no meio do frame.
- Câmera mestre em segundos por baixo dos cortes, resetando onde a narrativa reseta.

### Bugs achados e corrigidos nesta passada

- **`REQUEST #5837` virando um "R"**: o `<Trail>` do `@remotion/motion-blur` re-renderiza os
  filhos contra frames defasados, o que re-executava o `clipPath` de revelação da cápsula quase
  do zero — a pílula colapsava num badge minúsculo com só a primeira letra. Substituído por um
  smear direcional próprio (3 cópias com offset/blur/opacidade sobre um style já computado).
  `@remotion/motion-blur` deixou de ser usado por este componente.
- **Frame vazio na entrada do título**: a entrada usava easing ease-IN, que começa com
  velocidade zero — com as palavras fora do canvas, o frame ficava vazio por ~0,2s logo após o
  corte do restaurante. Trocado para ease-out.
- **Safe area**: `10.000` media ~1107px contra um orçamento de 960px depois do zoom da câmera
  (290 → 242); pico do título reduzido para caber dentro do frame; push-in do cofre de 2.5 →
  2.05. Overflow agora só onde há câmera motivando, e sempre resolve.
- **`READ → 1` quebrando em duas linhas** no lado do Cliente B (encostava na borda).
- **`fadeWin` defensivo**: as paradas são forçadas estritamente crescentes antes de chegar ao
  `interpolate`, que lança exceção em range não-monotônico — com beats derivados de duração de
  cena e tempos de nascimento com seed, duas paradas podem colidir legitimamente, e derrubar o
  render no meio é bem pior que um fade de duração zero.
- **Caveira da piada**: agora vermelha (`#ff2d50`), 620px, centralizada, na camada mais alta,
  com o caos inteiro desfocado (blur 16px) e escurecido (82%) atrás dela.

### QA de render (2.856 frames verificados)

- 0 frames vazios, 0 picos de cobertura de 1 frame (flicker).
- Alpha real medido no canal: mín 0 / máx 255, 97,3% totalmente transparente, 2,7% opaco —
  sem fundo bakeado, sem chroma key.
- Fontes carregadas via `delayRender`/`continueRender` com timeout de segurança de 3s.
- Todo `random()` é seeded (Remotion), determinístico frame a frame.

### Entregáveis

| Arquivo | O que é |
|---|---|
| `output/overlays/bfrc-final-60fps-alpha.mov` | **Overlay final** — ProRes 4444, 1080x1920, 60fps, alpha real, sem fundo. É este que entra no `ve add-overlay`. |
| `output/overlays/bfrc-final-preview.mp4` | Preview — H.264, 1080x1920, 60fps, fundo verde escuro + 47 SFX. |
| `docs/vinheta-sfx-cues.md` | Cue sheet de SFX (tempo, nome do cue, som, volume) para o som sobreviver fora do MOV. |
| `scripts/make-vinheta-cues.mjs` | Gera o cue sheet lendo `SCENE_SECONDS` do componente, para os cues não saírem de sincronia num retiming. |

O preview é composto A PARTIR do MOV com alpha, então preview e entrega são exatamente o mesmo
conteúdo — o preview não pode divergir do arquivo final.

### Ainda não feito

Variação de pitch entre os whooshes de request A/B e um "record scratch" dedicado: o catálogo
(`assets/sfx/`) não tem esses sons, e `ve add-sfx` mixa amostras sem pitch-shift. Os momentos
existem no cue sheet como silêncio, que ali já é o efeito principal.

## Em aberto

- Duração final exata (depende da narração real, ainda não gravada) — a tabela acima é a
  estimativa de trabalho.
- Timestamp exato de corte no source (106–121s é a faixa candidata pra entrada; saída é
  cravada — logo antes de "e sabe como é que tu se defende disso aí? com rate limit").
