# Reel "Prompt Injection" — roteiro técnico da animação

Implementado em `remotion/scenes/PromptInjection.jsx`. Este documento existe pelo mesmo motivo
que `docs/vinheta-race-condition-roteiro.md`: para que os números não pareçam arbitrários e para
que ninguém "conserte" depois um valor que foi medido.

Segue o motion house style (`docs/MOTION-HOUSE-STYLE.md`) em tudo, **menos** numa decisão
estrutural, descrita abaixo.

---

## 1. A diferença estrutural: não é uma `<Series>`

A vinheta aprovada é uma sequência de cenas (`<Series.Sequence>`), com uma câmera-mestra correndo
por baixo dos cortes. Aqui o pedido foi explícito: *"não quero uma apresentação de slides animada
… composição contínua, elementos se transformando entre cenas"*.

Por isso este componente **não tem cenas**. Tem:

- **um mundo** — um plano 2D em coordenadas absolutas (`N`, `SRC`, `SYS`, `TOOLS`, `EXTDOC`),
- **uma câmera** — `CAM_KEYS`, keyframes `(t, x, y, z)` em segundos,
- **elementos com ciclo de vida próprio**, todos lendo o mesmo tempo global.

Consequência: nada "aparece por corte". Cada componente decide quando nasce, transforma e morre.
O custo é que o arquivo inteiro compartilha um espaço de coordenadas — mexer num `y` move o que
está em volta. O ganho é que a continuidade é estrutural, não um efeito aplicado depois.

### Os três objetos que carregam a continuidade

| Objeto | Vira | Onde |
|---|---|---|
| O card de chat | o nó **USUÁRIO** (encolhe, o conteúdo sai antes da forma) | `ChatToUserNode` |
| O pacote da pergunta | o pacote da **instrução maliciosa** (mesma cápsula, outra cor e outro rótulo) | `packetState` |
| O nó **LLM** | o nó **AGENTE** (mesma caixa, `MorphLabel`, ganha anel e ferramentas) | `LlmNode` |

Não existe um "card de agente" separado no arquivo. Se existisse, a transformação seria um corte
disfarçado.

---

## 2. A narração é a diretora

### Origem do áudio (reproduzível)

O arquivo que o Derick indicou (`narração da animação prompt injection.m4a`, 222s) é **outro**:
contém o gancho, as mitigações e a despedida, com vários retakes. A narração da animação é
`narração do video prompt injection.m4a` (96,5s).

```
1. take bruto                          96,51s
2. remove a tomada falha 64,95–71,60s  89,86s   (ele erra "…que a IA lê", para e refaz limpo)
3. retime das pausas                   87,36s   (scripts/retime-narration.mjs + temp/pi-retime.json)
4. re-transcrição                               os tempos mudaram; a animação ancora nos NOVOS
```

Comandos:

```bash
ffmpeg -i "<take bruto>" -filter_complex \
  "[0:a]atrim=0:64.95,asetpts=PTS-STARTPTS[a0];[0:a]atrim=71.60,asetpts=PTS-STARTPTS[a1];[a0][a1]concat=n=2:v=0:a=1[out]" \
  -map "[out]" -c:a pcm_s16le temp/pi-narr-cut.wav
ve transcribe temp/pi-narr-cut.wav --language pt --model large-v3-turbo --out temp/pi-narr-cut.json
node scripts/retime-narration.mjs temp/pi-narr-cut.wav temp/pi-narr-cut.json temp/pi-narr-tight.mp3 temp/pi-retime.json
ve transcribe temp/pi-narr-tight.mp3 --language pt --model large-v3-turbo --out temp/pi-narr-tight.json
```

### A tomada falha que o Whisper escondeu

O Whisper **não transcreveu** 6,5s de fala entre "PDF," e "site," — ele engoliu a tomada errada
inteira e emendou as duas metades como se fossem uma frase só. No transcript isso aparece como um
silêncio de 6,46s que **não existe**: `silencedetect -36dB` não acusa nada ali porque o trecho tem
energia de fala (-16 a -19 dBFS).

Só a varredura de energia mostra o que houve:

```bash
ffmpeg -ss 63 -to 73 -i narr.m4a -af \
  "aresample=8000,asetnsamples=800,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-" \
  -f null -
```

```
64,75  fim de "…da aplicação."
64,78–65,28  silêncio
65,28–71,05  TOMADA FALHA  ("…em um PDF, site, e-mail que a IA lê…" — ele se perde)
71,05–71,88  silêncio
71,88        tomada boa, limpa até o fim
```

Por isso o corte é feito **antes** da transcrição de referência, e não pelo `retime`: o transcript
daquela região é inutilizável de qualquer jeito. É o passo 6 do house style (§12b) valendo na
prática — e desta vez o que o Whisper escondeu não foi uma interjeição, foi um take inteiro.

### Pausas

13 pausas tratadas (`temp/pi-retime.json`). As respiratórias vão para 0,20–0,34s; oito são
protegidas ou **estendidas** porque a animação acontece dentro delas:

| Depois de | s | Por quê |
|---|---|---|
| "RAG." | 0,60 | o termo aterrissa e fica sozinho na tela |
| "comportar." | 0,50 | pivô tonal, antes de "Agora vem o problema" |
| "problema." | 0,60 | é neste silêncio que a linha vermelha entra no sistema |
| "contexto." | 0,45 | antes do bloco DADO aparecer, ainda seguro |
| "Injection." (1ª) | 0,55 | DIRECT assenta no diagrama |
| "aplicação." | 0,50 | a câmera se afasta para fora da aplicação |
| "APIs," | 0,42 | cada ferramenta entra na sua palavra; a API precisa do seu instante |
| "sistemas," | 0,40 | beat antes da instrução percorrer até a tool |

---

## 3. Duração — o conflito com o briefing

O briefing pede **no máximo 60s** e, ao mesmo tempo, proíbe alterar o texto da narração e acelerar
a voz. Com esta gravação as duas coisas não coexistem: depois de remover a tomada falha e apertar
todas as respiratórias sobram **87,36s de fala**. A animação foi construída em **89,0s**
(87,14s de fala + 1,86s no frame conceitual final, para o corte de volta para a câmera não
atropelar a última palavra).

Para chegar a 60s seria preciso cortar conteúdo. O corte mais barato, em ordem de custo didático
crescente:

| Corte | Economiza | Perda |
|---|---|---|
| ato do impacto (54,2–64,1s: "E o impacto pode ir desde manipular…") | 9,9s | o exemplo concreto de vazamento |
| explicação do RAG (14,0–21,2s: "…como documentos, PDFs ou uma base de conhecimento") | 7,2s | o "como" do RAG; sobra o "que" |
| System Prompt (23,5–31,0s) | 7,5s | uma das sete ideias do objetivo final |
| "E aqui fica ainda mais perigoso" (72,5–74,8s) | 2,3s | só respiro |

Cortando impacto + a enumeração do RAG + o respiro chega-se a ~69s; para 60s o System Prompt
também teria de cair, e aí o vídeo perde o item 3 dos sete objetivos declarados. **Recomendação:
manter 89s** — Reels aceita até 90s no feed padrão — ou regravar a narração já no ritmo de 60s.

---

## 4. Mapa de beats

Todos em `BEATS`, no topo do componente, com o texto falado ao lado de cada um. São onsets reais
medidos em `temp/pi-narr-tight.json`. **Não arredondar.**

| s | palavra | o que acontece |
|---|---|---|
| 0,00 | "Primeiro," | a interface de chat já existe; a frase entra nela |
| 2,98 | "modelo" | o LLM aparece lá embaixo — o destino ganha peso |
| 4,08 | "pergunta." | a bolha se solta e vira pacote |
| 4,92 | "Geralmente," | **a câmera recua**; o pacote fica suspenso no ar |
| 5,56 | "existe uma série" | APLICAÇÃO nasce em cima da linha ingênua |
| 6,56 | "etapas" | CONTEXTO nasce; o pacote atravessa a cadeia |
| 7,74 | "resposta" | RESPOSTA fecha a cadeia |
| 11,64 | "RAG." | termo hero, o mundo cai para 26% de opacidade, letras sobem com máscara |
| 12,94 | "RAG é quando" | RAG vira badge do CONTEXTO; o nó **abre** |
| 14,72 | "busca" | quatro consultas disparam de dentro para fora |
| 16,92 / 17,84 / 19,00 | "documentos," / "PDFs" / "base de conhecimento" | cada fonte **nasce quando o pulso chega nela** |
| 20,54 | "manda esse conteúdo" | 3 de 4 selecionadas voltam encolhidas |
| 22,56 | "sua pergunta" | a PERGUNTA entra: `PERGUNTA + DOC + PDF + KB` |
| 25,96 | "System" | a câmera sobe e acha a camada privilegiada |
| 28,20 / 29,90 | "instruções" / "deve se comportar" | as duas regras digitam |
| 30,52 | "comportar." | SYSTEM e USER descem ao **mesmo** contexto |
| 31,50 | "Agora vem o problema." | vinheta vermelha, varredura lenta, grade esquenta |
| 35,00 | "documento recuperado" | volta o MESMO PDF que o RAG trouxe, agora hostil |
| 38,44 | "maliciosa" | "IGNORE AS INSTRUÇÕES ANTERIORES" digita dentro dele |
| 43,84 | "dado," | o bloco **DADO**, cinza, na zona de baixo. Parece seguro |
| 45,88 → 47,08 | "interpretar" → "instrução." | a fronteira **se parte** em "interpretar" e o bloco termina a travessia exatamente em "instrução." — DADO → INSTRUÇÃO. O painel segura o resultado até 49,2s, senão o beat central do vídeo teria 0,6s de tela |
| 51,92 | "Direct" | hero DIRECT → vira rótulo da aresta USUÁRIO→APLICAÇÃO |
| 56,62 | "manipular" | a resposta é **reescrita ao vivo** (ruído determinístico) |
| 58,90 | "expor" | três cards de dados nascem atrás da resposta |
| 62,70 | "contexto da aplicação" | dois tentam atravessar a saída; a fronteira acende |
| 64,08 | "Agora," | **a câmera se afasta** e a aplicação inteira vira um objeto com fronteira |
| 66,30 | "escondida" | a instrução dentro do documento externo |
| 67,10 / 67,82 / 68,76 | "PDF," / "site" / "e-mail" | as três abas do documento acendem uma por palavra |
| 69,32 | "ler," | o documento é puxado para dentro pela mesma curva do RAG |
| 70,50 | "Indirect" | hero INDIRECT |
| 76,52 | "agente" | LLM → AGENTE: mesma caixa, `MorphLabel`, ganha anel |
| 77,62 → 79,82 | "APIs," / "e-mails," / "arquivos" / "sistemas," | cada ferramenta entra **na sua palavra** |
| 81,32 | "a injeção" | o pacote vermelho desce pelo agente |
| 84,08 | "uma ação" | a API recebe a chamada; alerta discreto, nada destrutivo |
| 85,08 | "o atacante" | frame conceitual: PROMPT INJECTION ↓ AGENTE ↓ TOOL/API ↓ AÇÃO |

---

## 5. Decisões visuais e o porquê

**Paleta de três papéis.** Amarelo `#FFD400` = o fluxo vivo. Vermelho `#ff4d6d` = a injeção, e
**só** ela. Aço `#8FA3BF` = estrutura inerte (bordas, rótulos, arestas dormentes). O ciano da casa
não aparece: o house style reserva ele para cenas de concorrência, e aqui não há duas trilhas
simultâneas. Três cores é também o que faz o vermelho significar alguma coisa quando entra.

**Termos técnicos em espaço de tela.** `HeroTerms` desenha fora da câmera e depois pousa o termo
sobre o diagrama via `w2s()`. Se os termos vivessem no mundo, encolheriam com a câmera — e no ato
INDIRECT (`z = 0,47`) ficariam ilegíveis exatamente no momento em que o termo precisa dominar.
Durante os quatro heroes o mundo cai para 26% de opacidade (`heroDim`), por até ~1,5s.

**O pacote some dentro dos cards.** Quando ele chega a um nó, desaparece e o nó pulsa
(`nodePulse`). Passar por cima do card lê como "um ponto deslizando na tela"; sumir dentro dele lê
como atravessar o sistema.

**A fronteira DADO/INSTRUÇÃO não some: ela se parte.** Duas metades que se afastam, giram poucos
graus e ganham gradiente vermelho, mais cinco estilhaços (cinco, não cinquenta). O bloco muda de
zona, de `border-radius` (12 → 5: de dado arredondado para comando angular), de cor, e ganha um
caret `>` que só existe depois da travessia — agora é uma ordem. O rótulo troca por máscara
(`MorphLabel`), não por cross-fade: é a mesma caixa dizendo outra coisa.

**A busca do RAG é ida e volta pela MESMA curva.** `SRC_CURVE` serve para a consulta saindo e para
o documento voltando. Reusar a curva é o que faz o retrieval ler como um movimento só.

**Uma das quatro fontes não é selecionada.** O BANCO DE DADOS esmaece em vez de voltar. Nem tudo
que existe é recuperado — e isso prepara a ideia de que o modelo só vaza aquilo a que teve acesso.

**As ferramentas ficam todas ABAIXO do agente, não em anel completo.** Num anel, duas delas caem
na mesma faixa horizontal do nó CONTEXTO, e o espectador lê "API ao lado do contexto" em vez de
"API pendurada no agente". Em 9:16 não há largura para resolver isso de outro jeito. Pelo mesmo
motivo as arestas são roteadas por nível: uma curva genérica até ARQUIVOS passava por dentro do
card da API, e uma linha cruzando um card lê como se as duas ferramentas estivessem ligadas.

**As faixas da fronteira são DATA e INSTRUCTION (em inglês); o bloco é DADO → INSTRUÇÃO.** Com as
duas em português, "INSTRUÇÃO" aparecia duas vezes na mesma linha — o rótulo da faixa e o do
bloco — e a transformação ficava ilegível. O briefing pedia os dois vocabulários de qualquer
forma.

**O painel do CONTEXTO abre com os quatro lugares já reservados, vazios.** Entre a abertura e a
chegada do primeiro documento passam ~8s. Um painel liso durante 8s lê como "faltou desenhar
alguma coisa aqui"; slots tracejados mais uma barra de varredura leem como "o sistema está
buscando". É a mesma quantidade de código.

**O alerta na tool é discreto.** Um `! CHAMADA NÃO AUTORIZADA` pulsando e um shake de 0,3s. O
briefing pediu explicitamente para não mostrar um ataque destrutivo: o ponto é que o impacto saiu
do texto, não que algo explodiu.

---

## 6. Armadilhas encontradas nesta produção

Todas registradas em `ROADMAP.md`. Resumo:

- **`sourceHash()` do `remotion-render` não descia em subpastas** — toda edição em
  `remotion/scenes/` reusava um bundle velho e renderizava a versão anterior do componente, em
  silêncio. Parece exatamente com "minha mudança não fez nada".
- **`anullsrc` é infinito; `atrim=duration=0` nunca termina.** Uma pausa protegida cujo alvo
  *igualava* a pausa real caía nesse caso por erro de float e o ffmpeg escrevia até acabar o disco
  (1,37 GB de mp3 antes de eu matar).
- **`--duration` do `remotion-render` era limitado a 60s**, assumindo que overlay é inserto curto.
- **Keyframes de câmera derivados de beats podem colidir.** `interpolate` lança exceção em range
  não-monotônico e derruba o render no meio; `useCamera` agora força as paradas crescentes, como
  `fadeWin` já fazia.

---

## 7. Pipeline de render e entrega

Mesma lógica da vinheta aprovada (house style §14): o preview é derivado **do próprio master com
alpha**, nunca de um segundo render — assim preview e entrega são garantidamente o mesmo conteúdo.

```bash
# draft rápido para QA visual (30fps, ~9 min)
ve remotion-render PromptInjection --duration 89 --fps 30 --codec vp8 --out temp/pi-draft.webm

# master de entrega: 60fps, h264, fundo bakeado. NÃO use prores/alpha aqui — ver ROADMAP.md
ve remotion-render PromptInjection --duration 89 --fps 60 --codec h264 --crf 14    --out temp/pi-60fps-src.mp4

# entrega: só muxa a narração. O vídeo sai bit a bit igual ao render.
#  - NÃO converter range de cor: o render sai yuvj420p e está CORRETO. Converter para tv-range
#    esmaga os pretos de 5,5,12 para 2,3,10 — medido, não suposto. Ver ROADMAP.md.
#  - NUNCA -shortest: a animação segue 1,86s além da última palavra
ffmpeg -i temp/pi-60fps-src.mp4 -i temp/pi-narr-tight.mp3   -filter_complex "[1:a]apad=whole_dur=89[a]" -map 0:v:0 -map "[a]"   -c:v copy -c:a aac -b:a 192k -movflags +faststart output/prompt-injection-reel.mp4
```

### QA obrigatório

```bash
# frames vazios e flicker de 1 frame, no vídeo inteiro
ffmpeg -i output/overlays/prompt-injection-60fps-alpha.mov \
  -vf "alphaextract,scale=96:170,signalstats,metadata=print:file=-" -f null -

# alpha real, não fundo preto fingindo transparência
ffmpeg -ss 40 -i output/overlays/prompt-injection-60fps-alpha.mov -vf alphaextract -frames:v 1 -y temp/alpha.png
```

Conferir também: texto cortado sem intenção, termo hero colidindo com rótulo do diagrama,
aresta apontando para um nó que já morreu, e a sincronia dos quatro heroes com a palavra.
