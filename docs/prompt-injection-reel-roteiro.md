# Reel "Prompt Injection" — o corte completo (câmera + animação)

Entregue em `output/prompt-injection-reel-COMPLETO.mp4` — **2:27, 1080x1920, 60fps, −14,0 LUFS**.

Este documento é sobre o vídeo INTEIRO. A animação técnica de 89s tem o seu próprio documento
(`docs/prompt-injection-roteiro.md`) e não foi tocada aqui — ela entra como está.

O que existe aqui e não existia antes: o **talking head editado**, a **legenda viva** e o
**motion semântico sobre a câmera** (`remotion/scenes/PiCam.jsx`).

---

## 1. Estrutura

| # | Trecho | Fonte | Duração |
|---|---|---|---|
| 1 | Gancho (câmera) | `0920 (2).mp4`, 4 trechos | 22,1s |
| 2 | Explicação técnica | `output/prompt-injection-reel.mp4` (pronta) | 89,0s |
| 3 | Mitigações + CTA (câmera) | `0920 (2).mp4`, 7 trechos | 35,9s |
| | **total** | | **147,0s** |

Os dois cortes de volta são **corte seco**, que é o default da casa. O gancho termina com o hero
`PROMPT INJECTION` na tela e corta para a animação; a animação termina no frame conceitual
(PROMPT INJECTION ↓ AGENTE ↓ TOOL/API ↓ AÇÃO) e corta para ele perguntando "como a gente pode
mitigar". Os dois cortes são motivados pela fala, então não precisam de transição.

---

## 2. Seleção de tomadas — a gravação tem retakes, e um deles quase passou

O material bruto (170,1s) não é uma tomada limpa: ele repete linhas até acertar. A regra aplicada
foi **a última tomada completa vence**, porque é a que ele parou de refazer.

| Linha | Tomadas no bruto | Usada |
|---|---|---|
| "a primeira… menor privilégio" | 49,5s / 65,3s (abandonada) / 72,1s / **82,8s** | 82,8s |
| "mesmo que ela peça…" | 99,1s / 109,0s / **117,0s** | 117,0s |
| "ignorando…" | 12,3s / **22,1s** | 22,1s |
| "terceiro, trate documentos…" | 139,9s (ver abaixo) | 139,9s |

Descartados também: `"É tipo…"` (126,4s, frase abandonada) e `"Obrigado."` (166,9s, fora da peça).

### A tomada que o Whisper escondeu — de novo, e de outro jeito

`docs/MOTION-HOUSE-STYLE.md` §12b passo 6 manda **conferir por energia o que o Whisper não
transcreve**. Foi o que salvou o terceiro item.

O transcript diz uma frase contínua: *"Terceiro, trate documentos, sites e mensagens externas"*.
A varredura de energia diz outra coisa:

```
136,85–137,30  "sites"
137,30–139,95  −90 dBFS  <- SILÊNCIO DIGITAL, 2,65s. Ele parou.
139,95–144,10  ele recomeça a frase do zero
```

O Whisper não marcou isso como pausa: ele **esticou a palavra "mensagens" de 137,66 até 143,56**
— 5,9 segundos em uma palavra — e emendou as duas metades. Sem a varredura, o corte teria ficado
*"trate documentos, sites e… Terceiro, trate documentos, sites e mensagens externas"*.

Na produção anterior o mesmo passo pegou uma tomada falha escondida num silêncio de 6,46s. Agora
apareceu como **uma palavra longa demais**. A regra prática que sai daqui:

> Palavra com duração implausível (>1,5s) é sinal de emenda, não de ênfase. Confira por energia.

---

## 3. Áudio — medido antes de tratar

| | valor | decisão |
|---|---|---|
| ruído nas pausas | **−91 dBFS** | a gravação **já tem noise gate**. Denoise foi **descartado**: não havia piso para reduzir e o `afftdn` só acrescentaria artefato. |
| LRA da fala | **2,3 / 1,9 LU** | dinâmica já plana. `compress-voice` **descartado** — comprimir de novo é o que deixa voz "artificial", que o briefing proibiu. |
| loudness câmera | −17,3 / −17,7 LUFS | |
| loudness animação | **−14,2 LUFS** | **degrau de 3,3 dB na emenda** — audível. |

Tratamento aplicado: high-pass 80 Hz + normalização EBU R128 para **−14 LUFS** nos dois trechos de
câmera, casando com a animação. Nada além disso. O master final fecha em **−14,0 LUFS / −0,9 dBTP**.

---

## 4. Layout — os números vieram do `track-faces`, não do olho

`ve track-faces` (638 amostras) sobre o bruto:

```
topo da caixa do rosto   mínimo 782px   mediana 914px
posição horizontal       cx 0,44 .. 0,56  (ele fica centralizado)
```

Com a verificação visual por guias (cabelo encosta em ~740px no pior frame), a tela se divide em
três faixas que **não se invadem**:

```
y    0 .. 660   GRÁFICOS   parede vazia, verificada frame a frame
y  700 ..1300   ELE        nunca tocar
y ~1421 (74%)   LEGENDA    abaixo do queixo (1244px), acima da UI do Instagram
```

660 é o número medido menos a folga. Está escrito no topo de `PiCam.jsx` justamente para ninguém
"arrumar" depois. Os punch-ins são de no máximo **1,06** e com foco em (0,51 / 0,55) — nessa
escala o cabelo sobe ~25px, o que a folga absorve.

---

## 5. A regra da legenda que cede

O briefing pede **legenda o vídeo inteiro** e, ao mesmo tempo, pede que as palavras-chave
apareçam na tela em vermelho, com X e risco. As duas coisas juntas escrevem a **mesma palavra
duas vezes no mesmo frame**.

Solução: quando a faixa de cima está renderizando as próprias palavras faladas, o bloco de
legenda daquele instante é omitido. A palavra continua na tela — maior, colorida e com
significado. Janelas cedidas:

| Trecho | s | Quem carrega a fala |
|---|---|---|
| gancho | 2,38–3,55 | carimbo `NÃO É PERFEITA` |
| gancho | 5,92–6,76 | `TUDO` |
| gancho | 8,78–11,34 | `ÉTICA` / `BOM SENSO` / `REGRAS` riscadas |
| gancho | 20,32–22,08 | hero `PROMPT INJECTION` |
| mitigação | 20,22–23,46 | chips `DOCUMENTOS` / `SITES` / `MENSAGENS` |
| mitigação | 24,32–25,42 | carimbo `NÃO CONFIÁVEL` |
| mitigação | 33,50–35,88 | `@DECKDEV` |

Fora dessas janelas a legenda cobre **100% da fala**: 14 blocos no gancho, 26 na mitigação
(`remotion/data/pi-hook.json`, `pi-mit.json`). Mexer numa legenda é editar dados, não código.

---

## 6. O motion, beat a beat

Todos os tempos são onsets reais medidos em `temp/pi-hook.json` / `temp/pi-mit.json`. Não arredondar.

### Gancho

| s | palavra | o que acontece |
|---|---|---|
| 1,80 | "IA" | nasce o chip `IA` no centro da faixa |
| 2,38 | "perfeita" | risco vermelho no chip + carimbo `NÃO É PERFEITA` com shake e 5 estilhaços |
| 3,60 | "Imagina" | **o mesmo chip** desliza para a direita e encolhe — vira o destino do fluxo, não some |
| 5,40 | "obedecer" | `ALGUÉM` nasce à esquerda, aresta tracejada liga os dois |
| 5,92 | "tudo" | `TUDO` em amarelo, a única coisa grande na tela — a quantidade É o ponto da frase |
| 7,00 | "manda" | pacote `ORDEM` percorre a aresta e some dentro do chip `IA`, que pulsa |
| 8,78 / 9,92 / 10,80 | "ética" / "bom senso" / "regras" | cada palavra entra branca e **0,30s depois é rejeitada**: ✕ carimba, o risco é DESENHADO da esquerda para a direita, a linha treme 0,2s e solta 5 estilhaços |
| 11,44 | "recebeu" | `VINDAS DO PRÓPRIO SISTEMA` em ciano sob as três — planta o system prompt |
| 13,56 | "Na verdade" | **a faixa esvazia**. Punch-in 1,06. O briefing pediu pausa visual; silêncio é uma decisão, não um buraco |
| 20,32 | "Prompt" | `PROMPT` pousa, deslocado, com um vão à direita e um caret vermelho piscando nele |
| 21,06 | "Injection" | `INJECTION` **entra à força** de fora do quadro com smear direcional, empurra `PROMPT`, a moldura pisca vermelho, shake + estilhaços |

O hero é a única animação do gancho que ilustra o próprio nome do conceito: a palavra é
*injetada* na outra.

### Mitigações

A faixa aqui **não repete o título falado** ("menor privilégio", "validação no backend") — esse
texto é da legenda. A faixa mostra o **número** e o **diagrama**: o que a frase significa, não o
que ela diz. Foi assim que a tela parou de ter a mesma palavra escrita duas vezes.

| s | palavra | o que acontece |
|---|---|---|
| 2,78 | "três" | `01` `02` `03` entram em sequência — ele está com **três dedos na mão** nesse instante |
| 6,86 | "só mexe" | lista de permissões: `ler o pedido ✓ PERMITIDO` / `alterar preço ✕ NEGADO` / `apagar dados ✕ NEGADO` |
| 8,04 | "realmente precisa" | a linha PERMITIDA acende — só o que ela precisa |
| 14,08 | "peça" | pacote `AÇÃO` sai da `IA` rumo ao `SERVIDOR` |
| 16,12 | "verifica" | barra de varredura percorre o card do servidor |
| 17,26 | "pode de fato acontecer" | o pacote **bate no gate e volta**, vira vermelho, `✕ BLOQUEADO` |
| 20,46 / 21,48 / 22,24 | "documentos" / "sites" / "mensagens" | um chip por palavra |
| 24,32 | "não confiável" | os três ficam com borda tracejada vermelha e o carimbo `NÃO CONFIÁVEL` bate embaixo deles |
| 28,18 | "prompt" | escudo `PROMPT` em ciano |
| 29,05→29,80 | "única" | o pacote `INSTRUÇÃO` **atravessa o escudo** |
| 29,80 | "barreira" | o escudo **se parte em duas metades** que se afastam e giram — mesma gramática da fronteira DADO/INSTRUÇÃO da animação técnica. Rima interna proposital: é o mesmo vídeo |
| 33,50 | "segue" | `@DECKDEV` em verde |

---

## 7. Decisões e desvios — o que foi feito diferente e por quê

**Ciano para "sistema/técnico" contraria o house style §1.** O house style reserva ciano para
cenas de concorrência. O briefing pediu explicitamente "azul/ciano para elementos técnicos e
sistema". Seguimos o briefing. Não há conflito visual porque a animação técnica não usa ciano.

**Não há legenda sobre os 89s de animação.** O briefing pede legenda no vídeo inteiro; a animação
é uma peça tipográfica de tela cheia, com câmera navegando um mundo 2D — não existe faixa livre
onde uma legenda não cubra o diagrama, e ela foi construída para ser entendida **sem áudio**.
Pôr legenda ali destruiria a peça que já está aprovada. Se for para mudar, é uma decisão de
recortar a animação, não de acrescentar texto.

**"Vem comigo" não existe na gravação.** O briefing pedia essa fala como transição para a
explicação. Ela não foi gravada. O corte seco depois de "Prompt Injection" faz o mesmo trabalho.

**2:27 é mais longo que os 90s típicos de Reels.** O Instagram aceita até 3 minutos. Os 89s da
animação já eram um conflito conhecido e documentado (`prompt-injection-roteiro.md` §3), e o
material de câmera foi apertado ao máximo sem acelerar a voz — 170,1s de bruto viraram 58,0s.
Encurtar mais exige cortar conteúdo, e isso é decisão editorial, não técnica.

**"Ignorando" — tomada 2 em vez da tomada 1.** A tomada 1 (*"ignorando lógica, ignorando ética,
regras e bom senso"*) tem uma hesitação de 0,76s no meio da lista. A tomada 2 é fluente e
acrescenta *"que ela recebeu do próprio sistema"*, que planta o system prompt — o conceito de que
a explicação inteira depende. Custo: perde-se a palavra "lógica", e a emenda cria um corte no
meio da frase. O corte cai exatamente sob a maior animação do gancho, que o cobre. Para voltar
atrás basta trocar `21.95-27.25` por `12.30-17.90` na lista de trechos.

---

## 8. Pipeline reproduzível

```bash
# 1. cortes (seleção de tomadas, em tempo do BRUTO)
ve cut-video temp/pi-cam-src.mp4 --keep "0.00-3.25,7.45-11.98,21.95-27.25,28.30-37.25" --out temp/pi-hook-cut.mp4
ve cut-video temp/pi-cam-src.mp4 --keep "41.40-45.25,83.55-89.65,95.60-98.80,117.05-122.95,139.80-147.80,151.85-155.75,158.25-163.15" --out temp/pi-mit-cut.mp4

# 2. áudio (só isto — ver §3)
ve normalize-audio temp/pi-hook-cut.mp4 --target-lufs -14 --true-peak -1.5 --highpass 80 --out temp/pi-hook-norm.mp4
ve normalize-audio temp/pi-mit-cut.mp4  --target-lufs -14 --true-peak -1.5 --highpass 80 --out temp/pi-mit-norm.mp4

# 3. RE-transcrever: os tempos mudaram, o motion ancora nos NOVOS
ve transcribe temp/pi-hook-norm.mp4 --language pt --model large-v3-turbo --out temp/pi-hook.json
ve transcribe temp/pi-mit-norm.mp4  --language pt --model large-v3-turbo --out temp/pi-mit.json

# 4. punch-ins
ve zoom-video temp/pi-hook-norm.mp4 --events "13.56-16.55@1.06:0.51,0.55;19.80-22.06@1.05:0.51,0.55" --out temp/pi-hook-z.mp4
ve zoom-video temp/pi-mit-norm.mp4  --events "28.08-31.00@1.06:0.51,0.55" --out temp/pi-mit-z.mp4

# 5. overlay (motion + legenda num render só) — prores, alpha real. NÃO usar vp8 (ver ROADMAP)
ve remotion-render PiOverlay --props remotion/data/pi-hook.json --duration 22.08 --fps 60 --codec prores --out temp/pi-hook-ovl.mov
ve remotion-render PiOverlay --props remotion/data/pi-mit.json  --duration 35.88 --fps 60 --codec prores --out temp/pi-mit-ovl.mov

# 6. composição
ffmpeg -i temp/pi-<p>-z.mp4 -i temp/pi-<p>-ovl.mov -filter_complex \
  "[0:v]fps=60[b];[b][1:v]overlay=format=auto:shortest=1,format=yuv420p[v]" \
  -map "[v]" -map 0:a -c:v libx264 -crf 18 -preset medium -r 60 -c:a aac -b:a 192k temp/pi-<p>-comp.mp4

# 7. montagem final — atenção ao range de cor da animação (ver §9)
ffmpeg -i temp/pi-hook-comp.mp4 -i output/prompt-injection-reel.mp4 -i temp/pi-mit-comp.mp4 -filter_complex \
 "[0:v]fps=60,format=yuv420p,setsar=1[v0];\
  [1:v]scale=in_range=pc:out_range=tv,fps=60,format=yuv420p,setsar=1[v1];\
  [2:v]fps=60,format=yuv420p,setsar=1[v2];\
  [0:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0];\
  [1:a]aformat=...[a1];[2:a]aformat=...[a2];\
  [v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[v][a]" \
 -map "[v]" -map "[a]" -c:v libx264 -crf 17 -preset slow -pix_fmt yuv420p -color_range tv \
 -c:a aac -b:a 192k -movflags +faststart output/prompt-injection-reel-COMPLETO.mp4
```

---

## 9. A emenda de range de cor — medida, não suposta

Os três pedaços não combinam sozinhos:

| | pix_fmt | range | matriz |
|---|---|---|---|
| câmera (composto) | yuv420p | **tv** | bt709 |
| animação | yuvj420p | **pc** | bt470bg |

Concatenar assim entrega um arquivo em que um dos lados é interpretado errado. Quatro variantes
foram medidas contra o frame original da animação (erro médio em RGB, sobre o frame inteiro):

| receita | erro | fundo (ref 4,8 5,5 10,1) |
|---|---|---|
| `scale=in_range=pc:out_range=tv` + `-color_range tv` | **0,76** | 6,0 4,6 10,5 ✔ |
| só `format=yuv420p` + `-color_range tv` | 0,76 | 6,0 4,6 10,5 ✔ |
| qualquer variante com **`-colorspace bt709`** | 2,11 | 2,7 3,7 7,8 ✘ pretos esmagados |
| `scale=...:out_color_matrix=bt709` | 2,11 | 2,7 3,7 7,8 ✘ |

**A conclusão refina o que o ROADMAP já dizia:** quem esmaga os pretos não é a conversão de
range — é **forçar a matriz/colorspace**, que faz o ffmpeg inserir uma conversão a mais. A
receita usada converte o range e **não menciona colorspace**.

---

## 10. QA do entregável

```
duração        147,07s        1080x1920, 60fps, h264 yuv420p
loudness       −14,0 LUFS     LRA 2,7 LU     true peak −0,9 dBTP
frames pretos  0              (YAVG mínimo 21,5 — ver abaixo)
```

**`ve qa-video` reporta "48,7% do vídeo é preto". É falso positivo** e foi verificado: nenhum
frame tem YAVG abaixo de 2. O que o detector está vendo é a animação, que roda sobre fundo
quase-preto por projeto (YAVG médio 22,8, contra 92,5 do gancho e 89,2 da mitigação). Conferir
por YAVG antes de acreditar nesse aviso em qualquer peça com motion graphics escuro.

Conferido também: as duas emendas (sem salto de enquadramento nem de nível), nenhum gráfico
encostando no cabelo, nenhuma legenda sobre o rosto, e a sincronia dos beats com a palavra.
