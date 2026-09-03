// Base de Centros de Distribuição (extraída de Base_CDs_MB.xlsx)
// Pode ser sobrescrita pelo usuário importando uma planilha atualizada na tela de Configurações.
const DEFAULT_DEPOTS = [
  { sigla: "CDFT", nome: "CD São Paulo", uf: "SP", cidade: "Osasco", lat: -23.5042, long: -46.7766 },
  { sigla: "CDGR", nome: "CD Guarulhos", uf: "SP", cidade: "Guarulhos", lat: -23.4475, long: -46.4172 },
  { sigla: "CDJC", nome: "CD Jacareí", uf: "SP", cidade: "Jacareí", lat: -23.3289, long: -45.9624 },
  { sigla: "CDPR", nome: "CD Curitiba", uf: "PR", cidade: "Curitiba", lat: -25.5398, long: -49.2736 },
  { sigla: "CDSC", nome: "CD Itajaí", uf: "SC", cidade: "Itajaí", lat: -26.9388, long: -48.6751 },
  { sigla: "CDPE", nome: "CD Recife", uf: "PE", cidade: "Cabo de Santo Agostinho", lat: -8.2831, long: -34.9667 },
  { sigla: "CDAM", nome: "CD Manaus", uf: "AM", cidade: "Manaus", lat: -3.051, long: -59.988 },
  { sigla: "CDCE", nome: "CD Maracanaú", uf: "CE", cidade: "Maracanaú", lat: -3.8767, long: -38.6217 },
  { sigla: "CDBA", nome: "CD Simões Filho", uf: "BA", cidade: "Simões Filho", lat: -12.7842, long: -38.3975 },
  { sigla: "CDPI", nome: "CD Teresina", uf: "PI", cidade: "Teresina", lat: -5.1114, long: -42.7869 },
  { sigla: "CDDF", nome: "CD Brasília", uf: "DF", cidade: "Brasília", lat: -15.7865, long: -47.9351 },
  { sigla: "CDGO", nome: "CD Aparecida de Goiânia", uf: "GO", cidade: "Aparecida de Goiânia", lat: -16.7628, long: -49.255 },
  { sigla: "CDMT", nome: "CD Várzea Grande", uf: "MT", cidade: "Várzea Grande", lat: -15.6567, long: -56.126 },
  { sigla: "CDMG", nome: "CD Betim", uf: "MG", cidade: "Betim", lat: -19.9836, long: -44.2025 },
  { sigla: "CDRJ", nome: "CD Duque de Caxias", uf: "RJ", cidade: "Duque de Caxias", lat: -22.7533, long: -43.3105 },
];

// Tipos de veículo padrão e seus limites (editável na tela de Configurações).
// Além de M³/KG, cada veículo tem limite de posições de palete — total e por câmara
// (congelado/resfriado/seco). O motor respeita os dois limites ao mesmo tempo: o que
// estourar primeiro define quando fecha a rota.
const DEFAULT_VEHICLES = [
  { codigo: "3/4", nome: "3/4 (padrão)", m3: 10.0, kg: 4000, longaDistancia: false,
    palletTotal: 8, palletCongelado: 4, palletResfriado: 2, palletSeco: 4 },
  { codigo: "VUC", nome: "VUC", m3: 8.0, kg: 4000, longaDistancia: false,
    palletTotal: 6, palletCongelado: 2, palletResfriado: 2, palletSeco: 2 },
  { codigo: "TRUCK", nome: "Truck (viagem/direta)", m3: 20.0, kg: 8000, longaDistancia: true,
    palletTotal: 16, palletCongelado: 8, palletResfriado: 4, palletSeco: 8 },
];

// Regra padrão: depósito por ZONA logística do pedido (CALL.TDATA15 no arquivo do JDE).
// Só é usada quando a linha do CSV não traz CALL.DEPOTID, ou como referência na tela de config —
// na prática o motor prioriza o CALL.DEPOTID que já vem pronto do JDE (ver app.js).
const DEFAULT_ZONE_DEPOT = {
  SP: "CDGR", RJ: "CDGR", ES: "CDGR", MG: "CDMG", GO: "CDGO", DF: "CDDF",
  BA: "CDBA", MT: "CDMT", PR: "CDPR", SC: "CDSC", PE: "CDPE", CE: "CDCE",
  AM: "CDAM", PI: "CDPI",
};

// Regra padrão: veículo por zona (exceção — o resto usa "3/4")
const DEFAULT_ZONE_VEHICLE = {
  MG: "VUC",
};

// Zonas em que TRUCK é liberado quando a rota estoura o limite do veículo padrão (rotas longas)
const DEFAULT_ZONE_ALLOW_TRUCK = ["BA", "MT", "AM", "PI", "CE", "PE", "GO", "DF", "NO", "TM", "SM", "LT"];

// Limite de paradas por rota, por zona — sobrepõe o "Máximo de paradas por rota" geral da tela
// de Configurações só pra zonas listadas aqui (ex.: MG limitado a 7 paradas por operação local).
const DEFAULT_ZONE_MAX_STOPS = { MG: 7 };

// Exceções de cross-dock: zona que deve ser atendida por um depósito diferente do que o
// JDE indicou em CALL.DEPOTID (regra manual da operação).
// Ex: em SP, lojas das zonas CP/NT/SO/PC eram atendidas por Jundiaí no processo antigo — como
// Jundiaí não está cadastrado na base de CDs enviada, mantemos o depósito do JDE (CDGR) como
// padrão e deixamos sinalizado para o usuário confirmar/cadastrar o depósito correto.
const DEFAULT_ZONE_OVERRIDES = [
  { zona: "CP", depot: "CDGR", observacao: "Antigo: atendido por Jundiaí — depósito não cadastrado na base. Confirmar." },
  { zona: "NT", depot: "CDGR", observacao: "Antigo: atendido por Jundiaí — depósito não cadastrado na base. Confirmar." },
  { zona: "SO", depot: "CDGR", observacao: "Antigo: atendido por Jundiaí — depósito não cadastrado na base. Confirmar." },
  { zona: "PC", depot: "CDGR", observacao: "Antigo: atendido por Jundiaí — depósito não cadastrado na base. Confirmar." },
];
