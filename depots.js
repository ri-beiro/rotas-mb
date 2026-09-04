// Base de Centros de Distribuição — atualizada a partir de "Cross_Dockings_MB_8.xlsx" (planilha
// oficial de CDs/cross-dockings da MB). Pode ser sobrescrita pelo usuário na tela de Configurações.
// "operadora" é só informativo (quem opera o CD fisicamente) — não interfere na roteirização.
const DEFAULT_DEPOTS = [
  { sigla: "CDFT", nome: "CD São Paulo", uf: "SP", cidade: "Osasco", lat: -23.478188, long: -46.773398, operadora: "Martin Brower" },
  { sigla: "CDGR", nome: "CD Guarulhos", uf: "SP", cidade: "Guarulhos", lat: -23.428506, long: -46.421267, operadora: "Martin Brower" },
  { sigla: "CDJC", nome: "CD Jacareí", uf: "SP", cidade: "Jacareí", lat: -23.279434, long: -46.003174, operadora: "Martin Brower" },
  { sigla: "CDJD", nome: "CD Jundiaí", uf: "SP", cidade: "Jundiaí", lat: -23.146658, long: -46.942003, operadora: "Martin Brower" },
  { sigla: "CDPR", nome: "CD Curitiba", uf: "PR", cidade: "Curitiba", lat: -25.531322, long: -49.32876, operadora: "Martin Brower" },
  { sigla: "CDSC", nome: "CD Itajaí", uf: "SC", cidade: "Itajaí", lat: -26.913795, long: -48.703071, operadora: "Prodelog" },
  { sigla: "CDRS", nome: "CD Sapucaia do Sul", uf: "RS", cidade: "Sapucaia do Sul", lat: -29.805248, long: -51.17514, operadora: "Prodelog" },
  // "CDNE" — antigo "CDPE" (mesma cidade, Cabo de Santo Agostinho). Renomeado pra bater com a
  // planilha oficial de cross-dockings. Se o JDE ainda mandar CALL.DEPOTID="CDPE" pra alguma
  // loja, o motor cai no fallback por zona (zoneDepot.PE) e resolve certo do mesmo jeito.
  { sigla: "CDNE", nome: "CD Nordeste (Cabo de Santo Agostinho)", uf: "PE", cidade: "Cabo de Santo Agostinho", lat: -8.266313, long: -35.01286, operadora: "Martin Brower" },
  { sigla: "CDAM", nome: "CD Manaus", uf: "AM", cidade: "Manaus", lat: -3.051, long: -59.988 },
  { sigla: "CDCE", nome: "CD Maracanaú", uf: "CE", cidade: "Maracanaú", lat: -3.842266, long: -38.588804, operadora: "Prodelog" },
  { sigla: "CDBA", nome: "CD Simões Filho", uf: "BA", cidade: "Simões Filho", lat: -12.833945, long: -38.403211, operadora: "Prodelog" },
  { sigla: "CDPI", nome: "CD Teresina", uf: "PI", cidade: "Teresina", lat: -5.11449, long: -42.771161, operadora: "Prodelog" },
  { sigla: "CDDF", nome: "CD Brasília", uf: "DF", cidade: "Brasília", lat: -15.764116, long: -47.936349, operadora: "SGT" },
  { sigla: "CDGO", nome: "CD Aparecida de Goiânia", uf: "GO", cidade: "Aparecida de Goiânia", lat: -16.821216, long: -49.210545, operadora: "SGT" },
  { sigla: "CDMT", nome: "CD Várzea Grande", uf: "MT", cidade: "Várzea Grande", lat: -15.634902, long: -56.209574, operadora: "SGT" },
  { sigla: "CDMG", nome: "CD Betim", uf: "MG", cidade: "Betim", lat: -19.956763, long: -44.131883, operadora: "Prodelog" },
  { sigla: "CDRJ", nome: "CD Duque de Caxias", uf: "RJ", cidade: "Duque de Caxias", lat: -22.748293, long: -43.289511, operadora: "Martin Brower / Logmam" },
  { sigla: "CDES", nome: "CD Cariacica", uf: "ES", cidade: "Cariacica", lat: -20.280274, long: -40.398129, operadora: "Logmam" },
];
// Observações sobre a planilha oficial que NÃO entraram na base acima:
// - "CDMA" (Manaus, operadora "Juruá") aparece na planilha sem endereço/coordenadas (só "-") e
//   com UF "MA" (Maranhão) enquanto a cidade é Manaus (AM) — provavelmente um cadastro ainda
//   incompleto do lado de vocês. Mantive "CDAM" como já estava (coordenadas reais confirmadas)
//   em vez de trocar pra um registro sem dado nenhum. Confirmem qual sigla/operadora vale hoje
//   pra Manaus antes de eu mexer nisso.

// Tipos de veículo padrão e seus limites (editável na tela de Configurações) — capacidades de
// palete batendo com a planilha oficial de transportadoras/veículos por zona: 3/4 = 8 posições,
// VUC = 7, Truck = 16, Carreta = 28. Além de M³/KG, cada veículo tem limite de posições de
// palete — total e por câmara (congelado/resfriado/seco). O motor respeita os dois limites ao
// mesmo tempo: o que estourar primeiro define quando fecha a rota.
const DEFAULT_VEHICLES = [
  { codigo: "3/4", nome: "3/4 (padrão)", m3: 10.0, kg: 4000, longaDistancia: false,
    palletTotal: 8, palletCongelado: 4, palletResfriado: 2, palletSeco: 4 },
  { codigo: "VUC", nome: "VUC", m3: 8.5, kg: 4000, longaDistancia: false,
    palletTotal: 7, palletCongelado: 2, palletResfriado: 2, palletSeco: 3 },
  { codigo: "TRUCK", nome: "Truck (viagem/direta)", m3: 20.0, kg: 8000, longaDistancia: true,
    palletTotal: 16, palletCongelado: 8, palletResfriado: 4, palletSeco: 8 },
  // Capacidade de palete confirmada (28) na planilha oficial — m³/kg e a divisão por câmara não
  // vêm na planilha, estimados por proporção ao Truck (28/16 = 1.75x). Ajustar se tiverem o dado real.
  { codigo: "CARRETA", nome: "Carreta (rota direta longa)", m3: 35.0, kg: 14000, longaDistancia: true,
    palletTotal: 28, palletCongelado: 14, palletResfriado: 7, palletSeco: 14 },
];

// Regra padrão: depósito por ZONA logística do pedido (CALL.TDATA15 no arquivo do JDE).
// Só é usada quando a linha do CSV não traz CALL.DEPOTID, ou como referência na tela de config —
// na prática o motor prioriza o CALL.DEPOTID que já vem pronto do JDE (ver app.js).
const DEFAULT_ZONE_DEPOT = {
  SP: "CDGR", RJ: "CDRJ", ES: "CDES", MG: "CDMG", GO: "CDGO", DF: "CDDF",
  BA: "CDBA", MT: "CDMT", PR: "CDPR", SC: "CDSC", PE: "CDNE", CE: "CDCE",
  AM: "CDAM", PI: "CDPI", RS: "CDRS",
};

// Regra padrão: veículo por zona (exceção — o resto usa "3/4"). Confirmado com a planilha
// oficial "Transportadoras/veículo por zona": zonas normais (BA, MG, RJ, ES, DF, GO, MT...) usam
// 3/4 (ou VUC no caso de MG) — só as zonas "(viagem)"/rotas diretas de longa distância (sem
// cross-dock local) usam Truck ou Carreta o tempo todo. Isso substitui o antigo mecanismo
// separado de "zonas com Truck liberado", que forçava Truck pra BA/MT/GO/DF inteiras — errado:
// a planilha oficial e o comparativo com o Paragon mostram essas 4 zonas usando 3/4 na imensa
// maioria das rotas.
const DEFAULT_ZONE_VEHICLE = {
  MG: "VUC",
  // rotas diretas / viagem (sempre Truck, sem cross-dock local)
  BS: "TRUCK", IG: "TRUCK", JF: "TRUCK", NF: "TRUCK", SR: "TRUCK", TO: "TRUCK",
  ML: "TRUCK", GS: "TRUCK", RO: "TRUCK", SM: "TRUCK", MS: "TRUCK", TM: "TRUCK",
  NO: "TRUCK", MD: "TRUCK", RP: "TRUCK", SJ: "TRUCK",
  AC: "CARRETA",
  // sem confirmação na planilha nova — mantido do cadastro anterior (rotas historicamente longas)
  AM: "TRUCK", PI: "TRUCK", CE: "TRUCK", PE: "TRUCK",
};

// Limite de paradas por rota, por zona — sobrepõe o "Máximo de paradas por rota" geral da tela
// de Configurações só pra zonas listadas aqui (ex.: MG limitado a 7 paradas por operação local).
const DEFAULT_ZONE_MAX_STOPS = { MG: 7 };

// Transportadora padrão por zona — de "planilha_status_rotas.xlsx" (só informativo: aparece no
// card da rota e no export: cada zona só é atendida por uma transportadora específica).
const DEFAULT_ZONE_TRANSPORTADORA = {
  BA: "PRODELOG", MG: "PRODELOG", BS: "PRODELOG", IG: "PRODELOG",
  RJ: "LOGMAN", SF: "LOGMAN", ES: "LOGMAN", JF: "LOGMAN", NF: "LOGMAN", SR: "LOGMAN",
  DF: "SGT", GO: "SGT", MT: "SGT", TO: "SGT", ML: "SGT",
  GS: "SGT", RO: "PRODELOG", SM: "PRODELOG", AC: "PRODELOG",
  MS: "SGT", TM: "SGT", NO: "SGT", MD: "SGT", RP: "SGT", SJ: "SGT",
};

// Exceções de cross-dock: zona que deve ser atendida por um depósito diferente do que o JDE
// indicou em CALL.DEPOTID (regra manual da operação).
// Ex: em SP, lojas das zonas CP/NT/SO/PC são atendidas por Jundiaí — agora cadastrado como CDJD
// (antes ficava como "confirmar", pois Jundiaí não estava na base de CDs).
const DEFAULT_ZONE_OVERRIDES = [
  { zona: "CP", depot: "CDJD", observacao: "" },
  { zona: "NT", depot: "CDJD", observacao: "" },
  { zona: "SO", depot: "CDJD", observacao: "" },
  { zona: "PC", depot: "CDJD", observacao: "" },
];
