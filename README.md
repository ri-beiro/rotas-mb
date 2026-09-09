# Roteirizador MB

Sistema web para gerar automaticamente a roteirização de cargas a partir do pedido
exportado do JDE, substituindo a etapa manual do Paragon. O motor de roteirização tenta,
nessa ordem, três caminhos — cada rota individual mostra um selo indicando qual foi usado:

1. **OpenRouteService / VROOM** — o melhor caminho (clusteriza, sequencia e calcula tudo
   junto pela malha viária real). Hoje está pronto no código mas **sem chave válida** — veja
   abaixo.
2. **TomTom** — matriz de distância real + rota considerando trânsito. É o que está ativo
   hoje, com a chave já embutida em `api/tomtom.js`.
3. **Estimativa local** — linha reta × fator de rota, usada só se as duas APIs falharem.

## Chaves já configuradas

- **TomTom**: embutida em `api/tomtom.js` (constante `EMBEDDED_TOMTOM_KEY`). Uma segunda
  chave ficou comentada logo abaixo, como reserva.
- **Mapbox**: embutida em `app.js` (constante `MAPBOX_TOKEN`), usada só para os tiles do
  mapa (token público, sem risco de expor no navegador).
- **OpenRouteService**: a chave que você me passou (`sk-or-v1-...`) é do **OpenRouter.ai**
  (um serviço de IA/LLM), não do OpenRouteService — não vai funcionar aqui. Se quiser ativar
  o motor 1 (o mais preciso, faz tudo numa chamada só), gere uma chave em
  openrouteservice.org/dev e me passe, ou adicione você mesmo em `api/optimize.js`
  (constante `EMBEDDED_ORS_KEY`, seguindo o mesmo padrão do TomTom) ou como variável de
  ambiente `ORS_API_KEY` na hospedagem.

**Trocar/rotacionar uma chave depois**: edite a constante `EMBEDDED_*` no respectivo arquivo
em `api/`, ou defina a variável de ambiente correspondente na hospedagem (ela tem prioridade
sobre o valor embutido).

## Deploy (Vercel — recomendado)

1. Suba esta pasta inteira para um repositório no GitHub.
2. Importe o repositório na Vercel (vercel.com → Add New Project). Não precisa mudar
   nenhuma configuração — as chaves já estão no código.
3. Deploy.

Rodando localmente: `npx vercel dev` (não precisa de `.env` — as chaves já estão embutidas).
Se você só abrir o `index.html` direto no navegador (sem `/api` disponível), o sistema roda
com a estimativa local, já que as funções serverless não existem fora de um deploy/`vercel dev`.

## Como usar

1. Importe o pedido exportado do JDE (Painel de Controle da Interface) — aceita `.csv` ou `.xlsx`.
2. O motor agrupa as lojas em rotas automaticamente, respeitando:
   - o depósito de origem que o próprio JDE já define (`CALL.DEPOTID`),
   - exceções de cross-dock cadastradas em Configurações (botão no topo),
   - capacidade de M³, KG e posições de palete por câmara, por tipo de veículo,
   - limite de paradas por rota (geral ou por zona — ex.: MG limitado a 7),
   - horário de entrega obrigatório da loja (ver seção abaixo),
   - distância e tempo reais de viagem (via TomTom, ou ORS se configurado).
3. Revise no mapa e na lista de rotas — arraste uma loja de uma rota para outra se precisar
   ajustar (isso volta aquela rota para estimativa local, já que a sequência real precisaria
   ser recalculada — use "Reagrupar" para mandar tudo de volta pra API). O botão "⇄ Trocar
   lojas" abre duas cópias da lista de rotas lado a lado, com mais espaço pra arrastar entre
   rotas distantes na lista.
4. Clique em "Exportar para o JDE" para gerar o CSV de retorno.

## Horário de entrega da loja (Call.ORDDETS1)

A coluna `CALL.ORDDETS1` do pedido traz um horário (`HH:MM`) onde o "MM" na verdade é um código
da operação, não minuto de verdade:

- **`01`** — a loja só recebe **a partir** daquele horário (ex.: `10:01` → a partir das 10:00).
- **`02`** — a loja só recebe **exatamente** naquele horário (ex.: `10:02` → só às 10:00, nem
  antes nem depois).
- Qualquer outro valor (ou em branco) é só referência, não vira restrição.

Na lista de rotas, cada loja mostra um selo de horário (🕐) — laranja para "a partir de",
vermelho para "exatamente", e um contorno vermelho extra se a sequência calculada não bate com
o horário. Clique no selo pra editar o horário e o tipo de restrição manualmente. Os horários
obrigatórios entram como restrição real no motor de roteirização (inclusive no ORS/VROOM, via
`time_windows`, quando a chave estiver configurada); nos motores TomTom/local — que não resolvem
janela de horário nativamente — o sistema reordena as paradas pra tentar respeitar a cronologia
das janelas e sinaliza com um aviso quando não é totalmente possível.

## Encaixes (SA) e rota em branco

Quando uma loja chega com `CALL.TEXT01` em branco ou marcado "EXT" no pedido do JDE (não entrou
em nenhuma rota de faturamento do dia), ela é tratada como um encaixe ("SA") e aparece num painel
próprio acima da lista de rotas, pra ser arrastada loja por loja pra uma rota existente — não
entra na roteirização automática. Confirmado com um pedido real (a coluna existe e vem vazia
exatamente nesses casos); se o arquivo importado não tiver essa coluna, ninguém vira encaixe.

Use o botão "+ Rota" pra criar uma rota em branco (nome vazio, editável) — útil tanto para
receber encaixes quanto para dividir a carga de uma loja que não cabe inteira num veículo
menor. Clique no nome de qualquer rota pra renomeá-la.

## Dividir a carga de uma loja por câmara

Com o "Detalhe do pedido" importado, cada loja na lista de rotas mostra um botão 📦 com o total
de posições de palete. Clicar nele abre a quebra por câmara (congelado/resfriado/seco) e permite
mover só uma parte pra outra rota — útil quando o veículo é limitado (ex.: só cabe 3/4 num local)
e a loja não cabe inteira num só caminhão: uma parte segue numa rota, o resto noutra.

- **Mover a câmara inteira** (a quantidade cheia que aparece por padrão): o pedido principal já
  vem com uma linha por câmara (`CALL.TDATA05` = Congelados/Resfriados/Secos), então o sistema
  move as linhas de pedido de verdade pro destino — m³/kg/caixas exatos, sem duplicar nem perder
  nada no export. Pode exportar normalmente depois.
- **Mover só uma fração** (ex.: 1 de 3 posições): não dá pra separar uma linha de pedido ao meio,
  então o m³/kg/caixas movido é uma aproximação proporcional à fração de paletes. Por segurança,
  o CSV de exportação fica bloqueado enquanto existir uma divisão parcial pendente — mova a
  câmara inteira (ou a loja inteira) antes de exportar.

## Arquivos

- `index.html` — estrutura da página
- `styles.css` — sistema de design
- `app.js` — motor de roteirização (ORS → TomTom → local), mapa (Mapbox), edição e exportação
- `depots.js` — base de depósitos (CDs) e regras padrão — editável também pela tela de Configurações
- `api/optimize.js` — proxy para o OpenRouteService (motor 1)
- `api/tomtom.js` — proxy para o TomTom (motor 2) — chave já embutida
- `vercel.json` — configuração mínima das funções serverless

## Paletização (opcional)

Além de M³/KG, o sistema pode calcular **posições de palete por câmara** (congelado,
resfriado, seco) — um limite mais realista, já que um veículo trava por posição de palete
antes de encher o m³.

- **`products.js`** já vem com a base de produtos (peso, cubagem, paletização por SKU),
  limpa e deduplicada a partir da planilha de dimensões. Não precisa reimportar isso todo
  dia — só regenerar quando o cadastro de produto mudar bastante.
- No topo da tela, o botão **"+ Detalhe do pedido (paletização)"** importa o pedido linha a
  linha (loja + produto + quantidade) — aceita `.csv` ou `.xlsx` direto, sem precisar
  converter nada. É diário, junto com o pedido principal. Colunas esperadas: `Nome da Ref.
  Vendas` (loja), `2º Nº do Item` (código do produto) e `Quantidade`.
- Sem esse arquivo importado, o sistema funciona normalmente só com M³/KG — a paletização é
  um adicional, não uma dependência.

**Como o cálculo é feito:** para cada produto do pedido, `frações de palete = quantidade ÷
paletização do produto`. Essas frações são somadas por câmara (congelado/resfriado/seco) —
ou seja, produtos diferentes da mesma câmara podem dividir o mesmo palete — e só então
arredondadas pra cima, uma vez por câmara. Isso modela palete misto dentro da mesma
temperatura (câmaras diferentes nunca dividem palete, o que bate com a realidade). Ainda é
uma aproximação — não simula o encaixe físico real das caixas — mas erra sempre pro lado
seguro (tende a superestimar levemente, nunca subestimar).

## Diagrama do caminhão (Load Planning)

Quando o detalhe do pedido está importado, cada card de rota ganha um botão **"🚚 Ver
caminhão"** — abre um módulo de load planning no estilo de ferramentas reais (LoadXpert,
CargoWiz): cada posição de palete é desenhada individualmente na fileira (base + caixas +
etiqueta da parada + indicador de câmara), não mais um bloco genérico. Ordem de descarga
segue o padrão real (LIFO): parada 01 sempre mais perto da porta.

Painel de capacidade no topo (ocupação, volume, peso, pallets, caixas — cada um com barra
e status normal/atenção/excedido), fora do desenho. Legenda embaixo com sequência de
descarga (01 → 02 → 03...) — clicar numa parada destaca só a carga dela nos três
compartimentos e esmaece o resto. Passar o mouse num palete mostra loja, parada e câmara.

Espaço livre aparece como piso vazio de verdade (contorno tracejado + grade sutil), nunca
uma área branca genérica. Estouro de capacidade marca só o(s) palete(s) que excedem
(hachura vermelha), não o compartimento inteiro — a carga nunca fica escondida.

## Cotas das APIs

TomTom e Mapbox têm cota gratuita mensal generosa para o volume de uma operação diária
(uma chamada de matriz + uma de rota por lote de cada roteirização). Se algum dia a cota
estourar num dia, o sistema cai sozinho pra estimativa local e avisa na tela — nenhuma rota
é perdida, só fica menos precisa.

## Veículo e transportadora por zona, e consolidação de rotas

Comparando um pedido real roteirizado pelo sistema com o mesmo pedido finalizado no Paragon
(depois do ajuste manual), duas coisas ficaram claras e foram corrigidas:

1. **O sistema estava gerando muito mais rotas do que precisava** (num exemplo real, 169
   rotas contra 51 do Paragon pro mesmo pedido — média de ~2 paradas/rota contra ~6,5 do
   Paragon). A causa: o agrupamento por varredura angular (sweep) fecha uma rota assim que a
   próxima loja não cabe mais no veículo atual e **nunca reaproveita** esse espaço sobrando —
   um problema clássico do algoritmo "Next-Fit". Agora, depois da varredura, um passo de
   consolidação tenta juntar rotas **vizinhas** (logo, também próximas no mapa) sempre que a
   carga somada ainda cabe no veículo e no limite de paradas — sem abrir mão da proximidade
   geográfica que a varredura já garante.
2. **Veículo por zona estava errado pra várias zonas**: o sistema forçava Truck sempre pra
   BA/MT/GO/DF/AM/PI/CE/PE, mas a planilha oficial de transportadoras e o comparativo com o
   Paragon mostram que BA/MT/GO/DF usam 3/4 na imensa maioria das rotas — só zonas de
   **rota direta/viagem** (sem cross-dock local: BS, IG, JF, NF, SR, TO, ML, GS, RO, SM, MS,
   TM, NO, MD, RP, SJ) usam Truck o tempo todo, e AC usa Carreta (28 posições de palete,
   veículo novo adicionado). Isso agora é uma única tabela "Veículo padrão por zona" em
   Configurações (o antigo "Zonas com Truck liberado" foi removido, por ser uma segunda regra
   sobreposta e desatualizada).

A tabela "Transportadora padrão por zona" (também nova) é só informativa — mostra no card da
rota e no arquivo de export qual transportadora atende cada zona (ex.: `RJ → LOGMAN`). No
export, quando a zona tem transportadora cadastrada, o veículo sai no formato composto que o
Paragon realmente usa (ex.: `PRO-VUC-GR`, `SGT-TRU-GR`) em vez do código simples (`VUC`,
`TRUCK`) — confirmado comparando com um arquivo finalizado real. Sem transportadora
cadastrada pra zona, cai no código simples de sempre. `SP`/`LN`/`LT`/`VP` usam frota própria
(`MBR`) e `CP` usa `YES` — confirmado num segundo pedido real (região de CDGR), depois de
adicionados os dois com o mesmo teste comparativo do item 1.

**Validação com um segundo pedido real** (CDGR, 238 lojas): o sistema (com a consolidação
acima) gerou 38 rotas — o Paragon, pro mesmo pedido, gerou 41. Antes da consolidação, o mesmo
pedido teria gerado perto de 100 rotas (é o que um export gerado com uma versão desatualizada
mostrou) — a melhoria é real, não só de um caso isolado.

## Base de depósitos (CDs)

Atualizada a partir de uma planilha oficial de cross-dockings da MB: endereços/coordenadas
mais precisos, dois erros de sinal de coordenada corrigidos (CDES e o depósito antigo "CDPE",
que tinham latitude/longitude positiva por engano — o que colocaria o depósito no meio do
oceano), e três depósitos novos cadastrados: **CDES** (Cariacica/ES — antes as lojas do ES
caíam no CDGR por falta de cadastro), **CDJD** (Jundiaí/SP — resolve a exceção antiga de
cross-dock de SP que ficava sinalizada como "confirmar"), e **CDRS** (Sapucaia do Sul/RS). O
antigo "CDPE" foi renomeado pra **CDNE** (mesma cidade, Cabo de Santo Agostinho — só o código
mudou, pra bater com o cadastro oficial); se o JDE ainda mandar `CDPE` pra alguma loja, o
motor cai no fallback por zona e resolve certo do mesmo jeito.

