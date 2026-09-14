# Roteirizador MB

Sistema web para gerar automaticamente a roteirização de cargas a partir do pedido
exportado do JDE, substituindo a etapa manual do Paragon. O motor de roteirização tenta,
nessa ordem, três caminhos — cada rota individual mostra um selo indicando qual foi usado:

1. **OpenRouteService / VROOM** — o melhor caminho (clusteriza, sequencia e calcula tudo
   junto pela malha viária real). Hoje está pronto no código mas **sem chave válida** — veja
   abaixo.
2. **TomTom** — matriz de distância real (Matrix Routing v2) pra sequenciar as paradas, mais
   a rota final (Calculate Route v1) pela malha viária real, com trânsito. É o que está ativo
   hoje, com a chave já embutida em `api/tomtom.js`. Roteiriza como **caminhão** (todo veículo
   nosso é um caminhão — 3/4, VUC, Truck ou Carreta, nenhum é tratado como carro), evitando via
   com restrição de caminhão (viaduto baixo, ponte com limite de peso, rua com proibição de
   caminhão etc.) — usa peso total e comprimento/largura/altura de cada veículo, configuráveis
   em Configurações → "Dimensões do veículo" (valores estimados por classe; ajustem pra bater
   com a frota real). A geometria desenhada no mapa é a resposta real da TomTom (nunca linha
   reta, interpolação ou desenho manual) — ver detalhes e como testar em
   "Integração TomTom — rota real pelas ruas" mais abaixo.
3. **Estimativa local** — linha reta × fator de rota, usada só se as duas APIs falharem. Uma
   rota nesse estado mostra o selo "estimado" com o motivo real da falha no `title` (passe o
   mouse) — nunca esconde silenciosamente que a API de rota real não funcionou.

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
   Se você editar o `.csv` manualmente (ex.: corrigir a lat/long de uma loja) numa planilha com
   configuração regional que usa `;` como separador de lista (comum em português do Brasil), a
   planilha pode não reconhecer a `,` do arquivo original como separador — todo o conteúdo cai
   numa coluna só, e ao salvar de novo como CSV essa coluna vira "uma linha inteira dentro de um
   campo só" (aspas dobradas por fora). O sistema detecta esse padrão e desembrulha sozinho antes
   de importar (loga um aviso no console: `[import] "<arquivo>" veio com a linha inteira dentro
   de um campo só...`) — mas se puder, edite o CSV num editor de texto simples, ou confirme que
   a planilha está usando `,` como separador ao salvar, pra evitar o problema na origem.
2. O motor agrupa as lojas em rotas automaticamente, respeitando:
   - o depósito de origem que o próprio JDE já define (`CALL.DEPOTID`),
   - exceções de cross-dock cadastradas em Configurações (botão no topo),
   - capacidade de M³, KG e posições de palete por câmara, por tipo de veículo,
   - limite de paradas por rota (geral ou por zona — ex.: MG limitado a 7),
   - horário de entrega obrigatório da loja (ver seção abaixo),
   - distância e tempo reais de viagem (via TomTom, ou ORS se configurado).
3. Revise no mapa e na lista de rotas — arraste uma loja de uma rota para outra se precisar
   ajustar (isso volta aquela rota para estimativa local, já que a sequência real precisaria
   ser recalculada — use "Reagrupar" para mandar tudo de volta pra API). A barra de busca/ações
   fica fixa no topo da lista ao rolar. O botão "⇄ Trocar lojas" abre duas cópias da lista de
   rotas lado a lado (cada uma expande/seleciona independente da outra) com mais espaço pra
   arrastar entre rotas distantes na lista, um mapa das rotas em cima (clique numa linha — no
   mapa ou no card da rota, em qualquer coluna — pra destacar ela por cima das outras; dá pra
   destacar uma rota de cada coluna ao mesmo tempo; o botão "▲ Ocultar mapa" recolhe mapa +
   Encaixes pra sobrar mais espaço pra lista quando não precisar do mapa), e os Encaixes (SA)
   também aparecem ali (clique numa loja de encaixe pra ver ela marcada no mapa e comparar com
   as rotas destacadas). As setinhas ▲▼ ao lado de cada loja mudam a ordem de entrega dentro da
   mesma rota (também volta pra estimativa local, pelo mesmo motivo do arrastar entre rotas).
   Uma rota destacada no mapa (por clique na linha ou pela busca abaixo) mostra também um número
   (1, 2, 3...) em cima de cada loja, na ordem de entrega. O campo de busca no topo do modal
   filtra as duas colunas por nome de rota ou código de loja — quando sobra uma única rota, ela
   já é destacada sozinha no mapa, sem precisar clicar em mais nada. O ícone 🗑 em cada rota
   exclui ela: se ainda tiver loja, elas voltam pro painel de Encaixes (SA) em vez de sumir
   (só uma rota já vazia — em branco ou esvaziada por arrastar tudo pra outro lugar — é removida
   sem perguntar nada).
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

**Validação com um terceiro pedido real** (CDGR, 242 lojas — mesmo arquivo de entrada usado
tanto pelo sistema quanto pela pessoa que roteirizou manualmente no Paragon, o que permite
comparar as duas saídas ponto a ponto): o sistema gerou 34 rotas contra 37 do Paragon, com
depósito 100% igual em todas as 240 lojas roteirizadas por ele — mas essa comparação revelou
dois problemas reais, corrigidos:
1. **Transportadora não cadastrada para as zonas do cross-dock de Jundiaí** — `SO` e `PC`
   caíam no código de veículo simples (`3/4` em vez de `YES-3/4-GR`) porque só `CP` estava
   cadastrada como `YES` nessas 4 zonas (a quarta, `NT`, não apareceu neste pedido — se
   aparecer com transportadora diferente de `YES` num pedido futuro, ajustar a tabela).
2. **Exportar com lojas em "Encaixes (SA)" pendentes gerava um CSV incompleto, sem avisar
   nada**: 2 lojas desse pedido não tinham pré-rota (`CALL.TEXT01` vazio) e foram
   corretamente paradas nos Encaixes — mas o botão "Exportar" só percorre `state.routes`, e
   sem checar os Encaixes o arquivo final sairia faltando 2 pedidos reais de cliente, sem
   nenhum aviso na tela (o Paragon, feito manualmente, incluiu as duas). Agora exportar com
   Encaixes pendente é bloqueado, com o nome de cada loja pendente na mensagem.

Uma terceira diferença apareceu na mesma comparação: em 11 lojas de SO/PC, o Paragon consolidou
um grupo delas num Truck só, enquanto o sistema manteve vários "3/4" separados (mesmas lojas,
mesmo depósito, veículo diferente) — porque o motor fixa o veículo por zona (uma tabela zona →
veículo só) e nunca tenta sozinho "promover" pra um veículo maior quando várias rotas pequenas
caberiam consolidadas.

## Sugestão de consolidar veículo (nunca automática)

Em vez de o motor decidir isso sozinho, depois de cada "Reagrupar" ele verifica se alguma
zona/depósito ficou com **mais de uma rota do mesmo veículo** que, juntas, caberiam num veículo
maior do seu cadastro em **menos rotas** (testa cada outro veículo com M³ e KG maiores, usando o
mesmo bin-packing por capacidade já existente, e fica com a opção que reduzir mais o número de
rotas). Se achar alguma, abre um popup — **"Sugestão: juntar rotas num veículo maior?"** — com
cada oportunidade lado a lado: as rotas de hoje (código, paradas, m³, kg) à esquerda, a proposta
(quantas rotas novas, com quantas paradas/m³/kg cada) à direita. Nada é aplicado sozinho: só
depois de clicar **"Aplicar"** — em cada oportunidade separadamente — as rotas antigas somem e
a(s) nova(s) entra(m) no lugar (você pode nomear/reordenar/mover lojas normalmente depois,
igual qualquer outra rota); "Ignorar" descarta só aquela sugestão e mantém as rotas como estão.
Fechar o popup sem clicar em nada não muda nada.

## Integração TomTom — rota real pelas ruas

O mapa desenha exatamente a geometria (`legs[].points`) que a **TomTom Calculate Route v1**
devolve — nunca linha reta entre pontos, interpolação manual ou cálculo geométrico local. Como
funciona, ponta a ponta:

- **Onde é chamada**: `buildTomTomRouteFromOrder()` em `app.js` monta os waypoints na ordem
  `CD → loja 1 → loja 2 → ... → loja N → CD` e chama `POST /api/tomtom` (nosso proxy) com
  `{ op: "route", payload: { waypoints, ...vehicleSpec } }`. `api/tomtom.js` (só ele tem a
  chave) monta a URL real:
  `https://api.tomtom.com/routing/1/calculateRoute/{waypoints}/json?key=...&routeType=fastest&traffic=true&travelMode=truck&routeRepresentation=polyline&vehicleCommercial=true&vehicleWeight=...&vehicleLength=...&vehicleWidth=...&vehicleHeight=...`
  e repassa a resposta (status e corpo) direto pro frontend.
- **A ordem das paradas nunca é alterada por essa chamada**: Calculate Route é um roteador
  ponto-a-ponto-a-ponto, não um otimizador — ele calcula o caminho exatamente na sequência
  enviada. Quem decide a sequência (nearest-neighbor + 2-opt na roteirização automática, ou
  você arrastando/usando as setas de reordenar numa rota já existente) roda **antes**; essa
  função só pega a ordem já pronta e busca a geometria real dela.
- **Parâmetros de caminhão enviados** (todos suportados oficialmente pela Calculate Route API):
  `travelMode=truck`, `vehicleCommercial=true`, `vehicleWeight` (kg, peso bruto total),
  `vehicleLength`/`vehicleWidth`/`vehicleHeight` (metros) — lidos de cada veículo em
  `depots.js`/Configurações (`comprimento`, `largura`, `altura`, `pesoTotalKg`). Centralizado
  por classe de veículo (3/4, VUC, Truck, Carreta com valores próprios, já que a frota tem 4
  perfis de caminhão bem diferentes) em vez de 4 constantes globais únicas — um só lugar por
  veículo, editável em Configurações, sem valor espalhado pelo resto do código.
- **Nenhum fallback esconde erro**: se a TomTom responder com erro (`detailedError`), com HTTP
  diferente de 2xx, ou até com HTTP 200 mas sem nenhum ponto de geometria (`legs[].points`
  vazio — tratado como falha, não como sucesso), a função lança uma exceção com a mensagem
  real da TomTom. Isso propaga pro selo da rota ("estimado", com o motivo real no tooltip) ou,
  no botão de recalcular (abaixo), vira um toast vermelho com o erro — nunca uma linha reta
  desenhada por baixo do selo "rota real".
- **Recalcular rota real sem reordenar**: cada card de rota tem um botão **↻** (ao lado do
  "Ver caminhão") — "Recalcular rota real pelas ruas (TomTom)". Ele pega `route.stores`
  **exatamente como está** (útil depois de mover/reordenar uma loja manualmente, o que derruba
  o selo pra "estimado") e busca só a geometria/distância/tempo reais daquela sequência, sem
  rodar nenhum otimizador.
- **Logs de diagnóstico** (nunca incluem a API key):
  - Frontend (console do navegador): `[TomTom route] enviando — N pontos, waypoints=..., veículo={...}`
    antes da chamada, e depois `[TomTom route] OK — N pontos, HTTP 200, XXXms, Y pontos de
    geometria retornados, Zkm/Wmin` ou `[TomTom route] FALHA — ... — <mensagem real da TomTom>`.
  - Servidor (`api/tomtom.js`, aparece no log da função na Vercel): `[api/tomtom] -> op=route
    pontos=N url=...&key=***...` (URL com a key sempre mascarada) antes da chamada, e
    `[api/tomtom] <- op=route HTTP 200 em XXXms geometria=Ypts` ou, em erro,
    `[api/tomtom] <- op=route FALHA HTTP ### em XXXms — resposta TomTom: {...}` com o corpo de
    erro real da TomTom.
- **A API key nunca chega ao navegador**: o frontend só conhece a URL relativa `/api/tomtom`;
  a chave (`TOMTOM_API_KEY` como variável de ambiente, com fallback pra uma chave embutida em
  `api/tomtom.js`) só existe no código que roda no servidor (função serverless da Vercel).

**Teste que rodei** (não deu pra chamar `api.tomtom.com` de verdade a partir deste ambiente de
desenvolvimento — a política de rede daqui bloqueia esse domínio especificamente, confirmado com
`curl` retornando `403` na tentativa de conexão; não é algo que eu consiga contornar por
software, é um bloqueio de rede do ambiente). Testei tudo o que dava pra testar sem a chamada de
rede real, simulando as respostas da TomTom (sucesso com geometria, erro `detailedError`, HTTP
200 sem geometria, falha de rede) com uma rota de teste (CD + 4 lojas) via Playwright + mock de
`/api/tomtom`, e confirmei:
1. ✅ A chamada é montada corretamente (waypoints na ordem certa, parâmetros de veículo certos).
2. ✅ Uma resposta 200 com geometria é aceita e os pontos viram a linha desenhada no mapa.
3. ✅ A ordem das paradas enviada é sempre exatamente `route.stores` no momento da chamada —
   nunca reordenada por essa função, inclusive depois de reordenar manualmente e clicar ↻.
4. ✅ Um erro real da TomTom (`detailedError.message`) aparece de verdade (antes só mostrava
   "HTTP 400" genérico) — testado tanto na chamada automática quanto no botão ↻.
5. ✅ HTTP 200 com `legs[].points` vazio agora é tratado como falha (antes "sucedia" com
   `geometry: null`, badge dizendo "rota real" sem ter rota nenhuma desenhada).
6. ✅ Nenhuma linha do console do navegador contém a API key.
7. ✅ `api/tomtom.js` mascara a key em todo log (`key=***`), tanto no sucesso quanto no erro.

**O que só dá pra confirmar com a chave e a rede reais** (ou seja, no seu deploy Vercel, ou
localmente se sua rede não bloquear `api.tomtom.com`): que a TomTom realmente devolve HTTP 200 e
geometria válida pra coordenadas reais da sua operação, e que a linha desenhada acompanha as
ruas visualmente (não só estruturalmente). Depois de importar um pedido e clicar em "Reagrupar"
(ou no botão ↻ de uma rota existente), abra o console do navegador (F12) — as linhas
`[TomTom route] OK — ...` ou `[TomTom route] FALHA — ...` mostram exatamente o que aconteceu; se
quiser, me mande essas linhas (sem a key, elas nunca a incluem) que eu ajudo a interpretar.

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

