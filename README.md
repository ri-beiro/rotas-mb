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
   - exceções de cross-dock cadastradas na aba Configurações,
   - capacidade de M³ e KG por tipo de veículo,
   - distância e tempo reais de viagem (via TomTom, ou ORS se configurado).
3. Revise no mapa e na lista de rotas — arraste uma loja de uma rota para outra se precisar
   ajustar (isso volta aquela rota para estimativa local, já que a sequência real precisaria
   ser recalculada — use "Reagrupar" para mandar tudo de volta pra API).
4. Clique em "Exportar para o JDE" para gerar o CSV de retorno.

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

