/* ============================================================
   Roteirizador MB — motor de roteirização por proximidade
   ============================================================ */

const STORAGE_KEY = "roteirizador_pta_config_v1";

const state = {
  config: loadConfig(),
  rawRows: [],       // linhas originais do CSV (uma por câmara)
  stores: [],         // lojas agregadas (peso/m3/caixas somados)
  routes: [],          // rotas geradas
  map: null,
  layers: { depots: null, routes: [], stops: [] },
  selectedRouteId: null,
  colorByRoute: {},
  busy: false,
  _runToken: 0,
  hasPalletData: false,
  detalhePorLoja: null, // codigo da loja -> {congelado, resfriado, seco, total}
  saStores: [], // lojas "encaixe" (rota em branco/EXT no pedido) — ver nota em importRows()
};

const PALETTE = [
  "#1E6E8C", "#DE7A1E", "#2E7D4F", "#8C4FA6", "#C1432B",
  "#0E7C7B", "#B4790F", "#4C63B6", "#94874B", "#2B8CA1",
  "#B0508B", "#5A8F3C", "#C25C9B", "#3C6E9E", "#A85B2E",
];

/* ---------------- Config persistence ---------------- */
// As configurações (veículos, depósitos, zonas, limites) ficam salvas no navegador e não se
// perdem de um dia pro outro — só a importação do pedido (rotas do dia) é que é sempre nova.
// O merge campo-a-campo (em vez de só usar o que foi salvo) garante que, se um campo novo for
// adicionado numa atualização do sistema, quem já tinha configuração salva não perde esse campo
// (ele entra com o valor padrão em vez de ficar undefined).
function defaultConfig() {
  return {
    depots: DEFAULT_DEPOTS.map(d => ({ ...d })),
    vehicles: DEFAULT_VEHICLES.map(v => ({ ...v })),
    zoneDepot: { ...DEFAULT_ZONE_DEPOT },
    zoneVehicle: { ...DEFAULT_ZONE_VEHICLE },
    zoneOverrides: DEFAULT_ZONE_OVERRIDES.map(z => ({ ...z })),
    zoneMaxStops: { ...DEFAULT_ZONE_MAX_STOPS },
    zoneTransportadora: { ...DEFAULT_ZONE_TRANSPORTADORA },
    loadMin: 60, prepMin: 60, speedKmh: 45, roadFactor: 1.3, stopMin: 20, maxStopsPerRoute: 10,
    windowToleranceMin: 10,
  };
}
// Dicionários chave→zona que merecem merge CAMPO-A-CAMPO (não só objeto inteiro): permite que
// zonas novas adicionadas numa atualização (ex.: uma zona de viagem nova) apareçam pra quem já
// tinha config salva, sem apagar as zonas que a pessoa já tinha personalizado manualmente.
const ZONE_KEYED_CONFIG_FIELDS = ["zoneDepot", "zoneVehicle", "zoneMaxStops", "zoneTransportadora"];

function loadConfig() {
  const defaults = defaultConfig();
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && typeof saved === "object") {
      const merged = { ...defaults, ...saved };
      ZONE_KEYED_CONFIG_FIELDS.forEach(key => {
        merged[key] = { ...defaults[key], ...(saved[key] || {}) };
      });
      return merged;
    }
  } catch (e) {}
  return defaults;
}
function saveConfig() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.config));
}

/* ---------------- Utilities ---------------- */
function toast(msg, kind = "") {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "toast show" + (kind ? " " + kind : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.className = "toast"), 3200);
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function fmtNum(n, dec = 1) {
  return Number(n).toLocaleString("pt-BR", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function colorForIndex(i) { return PALETTE[i % PALETTE.length]; }

function depotBySigla(sigla) {
  return state.config.depots.find(d => d.sigla === sigla);
}

/* ---------------- Janela de horário de entrega da loja (Call.ORDDETS1) ----------------
   O valor vem como um horário (HH:MM), mas o "MM" não é minuto de verdade — é um código da
   operação: "01" = a loja só recebe A PARTIR daquele horário (sem limite máximo); "02" = a
   loja só recebe EXATAMENTE naquele horário (nem antes, nem depois). Qualquer outro valor (ou
   em branco) é só referência, sem virar restrição na roteirização. */
function parseHorarioJde(raw) {
  if (raw === undefined || raw === null) return null;
  const str = String(raw).trim();
  if (!str) return null;
  // Aceita "10:02", "10.02", "10h02" ou dígitos corridos ("1002", "802") — sempre HH + código
  // de 2 dígitos, com backtrack automático pra hora de 1 dígito quando faltar dígito (ex: "802").
  const m = str.match(/^(\d{1,2})[:h.]?(\d{2})$/i);
  if (!m) return null;
  const hour = parseInt(m[1], 10);
  const code = m[2];
  if (isNaN(hour) || hour < 0 || hour > 23) return null;
  const type = code === "01" ? "from" : code === "02" ? "exact" : "free";
  return { hour, type };
}

function effectiveHorario(store) {
  return store.horarioOverride || store.horario || null;
}

function horarioLabel(h) {
  if (!h) return "Sem horário preferencial";
  const hh = String(h.hour).padStart(2, "0") + ":00";
  if (h.type === "from") return `Obrigatório — só recebe a partir de ${hh}`;
  if (h.type === "exact") return `Obrigatório — só recebe exatamente às ${hh}`;
  return `Preferência: ${hh} (não obrigatório)`;
}

function horarioBadgeText(h) {
  if (!h) return "🕐 —";
  const hh = String(h.hour).padStart(2, "0") + ":00";
  if (h.type === "from") return `🕐 ≥ ${hh}`;
  if (h.type === "exact") return `🕐 = ${hh}`;
  return `🕐 ${hh}`;
}

// Pequena correção de ordem: entre paradas com janela obrigatória (from/exact), garante que
// a sequência siga a ordem cronológica das janelas — sem isso o motor (sobretudo os fallbacks
// TomTom/local, que não resolvem janela de horário nativamente) poderia visitar uma loja das
// 14h antes de uma loja das 09h só por estarem geograficamente próximas.
function enforceWindowOrder(orderedStores) {
  const arr = [...orderedStores];
  let changed = true, guard = 0;
  while (changed && guard < 300) {
    changed = false; guard++;
    for (let i = 0; i < arr.length - 1; i++) {
      const hA = effectiveHorario(arr[i]);
      const hB = effectiveHorario(arr[i + 1]);
      if (hA && hB && hA.type !== "free" && hB.type !== "free" && hA.hour > hB.hour) {
        [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
        changed = true;
      }
    }
  }
  return arr;
}

// Confere, pelo horário de chegada estimado (buildTimeline), se cada loja com janela obrigatória
// foi respeitada — marca a loja e a rota como "violado" pra dar destaque visual, já que nem
// sempre dá pra cumprir 100% (rotas compartilhadas por várias lojas com janelas apertadas).
function validateRouteWindows(route) {
  route._horarioViolado = false;
  if (!route.stores.length) return;
  const tl = buildTimeline(route);
  const tolMs = (state.config.windowToleranceMin || 10) * 60000;
  tl.arrivals.forEach(({ store, arrival }) => {
    store._horarioViolado = false;
    const h = effectiveHorario(store);
    if (!h || h.type === "free") return;
    const target = new Date(arrival);
    target.setHours(h.hour, 0, 0, 0);
    if (h.type === "from") {
      if (arrival.getTime() + 1000 < target.getTime()) store._horarioViolado = true;
    } else if (h.type === "exact") {
      if (Math.abs(arrival.getTime() - target.getTime()) > tolMs) store._horarioViolado = true;
    }
    if (store._horarioViolado) route._horarioViolado = true;
  });
}

/* ---------------- CSV import & aggregation ---------------- */
// Lê .csv (via PapaParse) ou .xlsx/.xls (via SheetJS) e devolve sempre um array de objetos
// {coluna: valor}, igual nos dois formatos, pros parsers de importRows/importDetalhe não
// precisarem saber a diferença.
// Detecta se o .csv é UTF-8 ou Latin-1/CP1252 antes de ler — sem isso, um arquivo salvo no
// encoding "errado" faz colunas com acento (é o caso de "2º Nº do Item" no Detalhe do pedido)
// não baterem com o esperado, e a importação falha com um erro confuso de "coluna não
// encontrada" sem ficar claro o motivo. Um UTF-8 válido decodifica sem erro em modo estrito;
// Latin-1/CP1252 de verdade (bytes soltos fora de sequência UTF-8) não decodifica.
function detectCsvEncoding(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return "UTF-8"; // BOM explícito
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return "UTF-8";
  } catch (e) {
    return "ISO-8859-1";
  }
}

function readTabularFile(file, onRows, onError) {
  const isExcel = /\.xlsx?$/i.test(file.name);
  if (isExcel) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: "array", cellDates: false });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { defval: "", raw: false });
        onRows(rows);
      } catch (err) { onError(err); }
    };
    reader.onerror = () => onError(new Error("Falha ao ler o arquivo Excel."));
    reader.readAsArrayBuffer(file);
  } else {
    file.arrayBuffer()
      .then(buf => {
        Papa.parse(file, {
          header: true, skipEmptyLines: true, encoding: detectCsvEncoding(buf),
          complete: (res) => onRows(res.data),
          error: onError,
        });
      })
      .catch(onError);
  }
}

function handleFile(file) {
  readTabularFile(file,
    (rows) => {
      try { importRows(rows, file.name); }
      catch (err) { console.error(err); toast("Erro ao ler o arquivo: " + err.message, "danger"); }
    },
    (err) => toast("Erro ao ler o arquivo: " + err.message, "danger")
  );
}

function importRows(rows, fileName) {
  const required = ["CUST.LAT", "CUST.LONG", "CALL.TEXT03", "CALL.USER01", "CALL.USER02", "CALL.USER04"];
  const cols = Object.keys(rows[0] || {});
  const missing = required.filter(r => !cols.includes(r));
  if (missing.length) {
    toast("Colunas não encontradas no CSV: " + missing.join(", "), "danger");
    return;
  }

  state.rawRows = rows.filter(r => r["CUST.LAT"] && r["CUST.LONG"]);

  // Agrupa por loja (CUST.ID + código da loja)
  const byStore = new Map();
  for (const r of state.rawRows) {
    const key = (r["CUST.ID"] || r["CALL.ID"] || r["CALL.TEXT03"]) + "|" + r["CALL.TEXT03"];
    const lat = parseFloat(r["CUST.LAT"]);
    const lng = parseFloat(r["CUST.LONG"]);
    if (!byStore.has(key)) {
      byStore.set(key, {
        id: key,
        custId: r["CUST.ID"] || r["CALL.ID"] || "",
        codigo: r["CALL.TEXT03"] || "",
        zona: (r["CALL.TDATA15"] || "").trim().toUpperCase(),
        origemJde: (r["CALL.DEPOTID"] || "").trim().toUpperCase(),
        lat, lng,
        peso: 0, m3: 0, caixas: 0,
        horarioRaw: r["CALL.ORDDETS1"] || "",
        horario: parseHorarioJde(r["CALL.ORDDETS1"]),
        horarioOverride: null,
        rows: [],
        porCamara: {}, // congelado/resfriado/seco -> {peso, m3, caixas, rows} — ver camaraKeyFromRow()
      });
    }
    const s = byStore.get(key);
    const peso = parseFloat(String(r["CALL.USER01"]).replace(",", ".")) || 0;
    const m3 = parseFloat(String(r["CALL.USER02"]).replace(",", ".")) || 0;
    const caixas = parseFloat(String(r["CALL.USER04"]).replace(",", ".")) || 0;
    s.peso += peso; s.m3 += m3; s.caixas += caixas;
    s.rows.push(r);

    const camKey = camaraKeyFromRow(r);
    if (camKey) {
      if (!s.porCamara[camKey]) s.porCamara[camKey] = { peso: 0, m3: 0, caixas: 0, rows: [] };
      s.porCamara[camKey].peso += peso;
      s.porCamara[camKey].m3 += m3;
      s.porCamara[camKey].caixas += caixas;
      s.porCamara[camKey].rows.push(r);
    }
  }

  state.stores = Array.from(byStore.values());

  // "Encaixes (SA)": lojas cuja rota já vem em branco ou "EXT" no pedido do JDE (não entraram
  // na roteirização automática do dia — encaixe manual noutra rota). A coluna exata que carrega
  // essa informação no arquivo ainda precisa ser confirmada numa planilha de exemplo real antes
  // de ligar a detecção aqui (classificar errado numa planilha de produção é pior que não
  // classificar) — o painel "Encaixes" já existe na tela, só fica vazio até isso ser confirmado.
  state.saStores = [];

  document.getElementById("brand-sub").textContent =
    `${fileName} · ${state.stores.length} lojas`;

  if (state.detalhePorLoja) applyPalletDataToStores();

  runClustering();
  toast(`${state.stores.length} lojas importadas. Calculando rotas...`);
  document.getElementById("mapEmpty").style.display = "none";
  document.getElementById("legend").style.display = "block";
}

/* ---------------- Detalhe de pedido (paletização) — opcional ---------------- */
function handleDetalheFile(file) {
  readTabularFile(file,
    (rows) => {
      try { importDetalhe(rows, file.name); }
      catch (err) { console.error(err); toast("Erro ao ler o detalhe de pedido: " + err.message, "danger"); }
    },
    (err) => toast("Erro ao ler o detalhe de pedido: " + err.message, "danger")
  );
}

function importDetalhe(rows, fileName) {
  const cols = Object.keys(rows[0] || {});
  const colLoja = "Nome da Ref. Vendas";
  const colQtd = "Quantidade";
  const colItem1 = "2º Nº do Item";
  const colItem2 = "3º Nº do Item";
  if (!cols.includes(colLoja) || !cols.includes(colQtd) || (!cols.includes(colItem1) && !cols.includes(colItem2))) {
    toast(`Colunas esperadas não encontradas (preciso de "${colLoja}", "${colQtd}" e "${colItem1}").`, "danger");
    return;
  }

  const byLoja = {};
  let totalLinhas = 0, semProduto = 0, semPaletizacao = 0, ok = 0;

  rows.forEach(r => {
    const loja = (r[colLoja] || "").toString().trim();
    const qtd = parseFloat(String(r[colQtd]).replace(",", ".")) || 0;
    if (!loja || !qtd) return;
    totalLinhas++;

    const code = r[colItem1] || r[colItem2];
    const product = findProduct(code);
    if (!product) { semProduto++; return; }
    if (!product.paletizacao) { semPaletizacao++; return; }

    const fracoesPallet = qtd / product.paletizacao;
    if (!byLoja[loja]) byLoja[loja] = { congelado: 0, resfriado: 0, seco: 0 };
    if (product.familia === "CON") byLoja[loja].congelado += fracoesPallet;
    else if (product.familia === "RES") byLoja[loja].resfriado += fracoesPallet;
    else byLoja[loja].seco += fracoesPallet;
    ok++;
  });

  // arredonda pra cima UMA VEZ por câmara (não por produto) — assume que produtos
  // diferentes da MESMA câmara podem dividir palete misto; câmaras diferentes, não.
  Object.values(byLoja).forEach(d => {
    d.congelado = Math.max(0, Math.ceil(d.congelado - 1e-9));
    d.resfriado = Math.max(0, Math.ceil(d.resfriado - 1e-9));
    d.seco = Math.max(0, Math.ceil(d.seco - 1e-9));
  });

  state.detalhePorLoja = byLoja;
  state.hasPalletData = true;
  applyPalletDataToStores();

  document.getElementById("btnImportarDetalhe").textContent = `✓ Detalhe do pedido (${Object.keys(byLoja).length} lojas)`;
  document.getElementById("btnImportarDetalhe").classList.add("btn-primary");

  const coverage = totalLinhas ? Math.round((ok / totalLinhas) * 100) : 0;
  toast(`Detalhe importado: ${ok} de ${totalLinhas} linhas casadas com a base de produtos (${coverage}%). Recalculando...`, coverage > 70 ? "success" : "");

  if (state.stores.length) runClustering();
}

function applyPalletDataToStores() {
  if (!state.detalhePorLoja) return;
  state.stores.forEach(s => {
    const d = state.detalhePorLoja[s.codigo];
    if (d) {
      s.palletCongelado = d.congelado;
      s.palletResfriado = d.resfriado;
      s.palletSeco = d.seco;
      s.palletTotal = d.congelado + d.resfriado + d.seco;
    } else {
      s.palletCongelado = s.palletResfriado = s.palletSeco = s.palletTotal = 0;
    }
  });
}

/* ---------------- Cross-dock & vehicle resolution ---------------- */
function resolveDepotForStore(store) {
  // 1) exceção manual de cross-dock por zona (prioridade máxima)
  const override = state.config.zoneOverrides.find(z => z.zona === store.zona);
  if (override) return override.depot;
  // 2) o próprio JDE já manda o depósito de origem em CALL.DEPOTID — é a fonte da verdade
  if (store.origemJde && depotBySigla(store.origemJde)) return store.origemJde;
  // 3) fallback: tabela de depósito padrão por zona
  return state.config.zoneDepot[store.zona] || state.config.depots[0]?.sigla;
}

function resolveVehicleForStore(store) {
  return state.config.zoneVehicle[store.zona] || "3/4";
}

function maxStopsForZone(zona) {
  return state.config.zoneMaxStops[zona] || state.config.maxStopsPerRoute || 10;
}

function transportadoraForZone(zona) {
  return state.config.zoneTransportadora[zona] || "";
}

// União de todas as zonas conhecidas (depósito padrão, veículo padrão, transportadora, limite de
// paradas) — usada pra montar as tabelas da tela de Configurações, já que uma zona de rota direta
// (ex.: "TO", "AC") pode ter veículo/transportadora definidos sem ter um depósito próprio.
function allKnownZones() {
  const set = new Set([
    ...Object.keys(state.config.zoneDepot),
    ...Object.keys(state.config.zoneVehicle),
    ...Object.keys(state.config.zoneMaxStops),
    ...Object.keys(state.config.zoneTransportadora),
  ]);
  return Array.from(set).sort();
}

/* ---------------- Clustering engine (varredura polar + bin packing) ---------------- */
/* ---------------- Motor de roteirização: ORS/VROOM → TomTom → local ---------------- */
const ORS_ENDPOINT = "/api/optimize";
const TOMTOM_ENDPOINT = "/api/tomtom";
const MAPBOX_TOKEN = "pk.eyJ1IjoicmliZWlyb21ibHVjYXMiLCJhIjoiY21zejAzOWN2MDUydDJ5cG1pazVrZXVlaiJ9.xK13vXsC1e40NmMCdJhOjA";

function groupStores() {
  const groups = new Map(); // "depot|veiculo|zona" -> lista de lojas
  for (const store of state.stores) {
    store.depot = resolveDepotForStore(store);
    store.vehicleCode = resolveVehicleForStore(store);
    const key = store.depot + "|" + store.vehicleCode + "|" + store.zona;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(store);
  }
  return groups;
}

async function runClustering() {
  if (!state.stores.length) return;
  const myRun = ++state._runToken;
  setBusy(true);

  const groups = groupStores();
  const collected = [];

  for (const [key, stores] of groups.entries()) {
    const [depotSigla, vehicleCode, zona] = key.split("|");
    const depot = depotBySigla(depotSigla);
    const vehicle = state.config.vehicles.find(v => v.codigo === vehicleCode) || state.config.vehicles[0];
    if (!depot || !vehicle) continue;

    let groupRoutes;
    try {
      groupRoutes = await optimizeGroupViaORS(depot, vehicle, stores, zona);
    } catch (errOrs) {
      console.warn(`ORS indisponível para ${key} (${errOrs.message}), tentando TomTom...`);
      try {
        groupRoutes = await optimizeGroupViaTomTom(depot, vehicle, stores, zona);
      } catch (errTomTom) {
        console.warn(`TomTom também indisponível para ${key} (${errTomTom.message}), usando estimativa local.`);
        groupRoutes = clusterGroupLocally(depot, vehicle, stores, zona);
      }
    }
    collected.push(...groupRoutes);
  }

  if (myRun !== state._runToken) return; // uma importação/recálculo mais recente já rodou

  // numeração final e cores
  let seq = 1;
  collected.forEach(r => {
    r.seq = seq;
    r.id = "r" + seq;
    const prefix = (r.zona || r.depot.sigla.replace("CD", "")).slice(0, 2).toUpperCase();
    r.code = `${prefix}${String(seq).padStart(3, "0")}F`;
    seq++;
  });

  state.routes = collected;
  computeUsage();
  renderAll();
  setBusy(false);

  const counts = {};
  collected.forEach(r => { counts[r.engine] = (counts[r.engine] || 0) + 1; });
  if (counts.ors && !counts.tomtom && !counts.local) {
    toast("Rotas calculadas com distância real (OpenRouteService).", "success");
  } else if (counts.tomtom && !counts.local) {
    toast("Rotas calculadas com distância real (TomTom).", "success");
  } else if (counts.local) {
    toast(`${counts.local} rota(s) usaram estimativa local — verifique as chaves de API configuradas.`, "");
  } else {
    toast("Rotas calculadas.", "success");
  }
}

function setBusy(isBusy) {
  state.busy = isBusy;
  document.getElementById("btnExport").disabled = isBusy || !state.routes.length;
  document.getElementById("btnRecalcular").disabled = isBusy;
  document.getElementById("btnRecalcular").textContent = isBusy ? "Calculando..." : "Reagrupar";
}

/* ---- Caminho 1: OpenRouteService / VROOM (rotas reais) ---- */
async function optimizeGroupViaORS(depot, vehicle, stores, zona) {
  const vehicleCount = estimateVehicleCount(vehicle, stores, zona);
  const profile = vehicle.codigo === "TRUCK" ? "driving-hgv" : "driving-car";
  const serviceSec = Math.round((state.config.stopMin || 20) * 60);

  // Mesma linha do tempo usada no timeline de exportação (buildTimeline): carregamento + preparo
  // antes de sair do depósito. Janela de horário obrigatória da loja (from/exact) vira restrição
  // real pro VROOM, na mesma escala de segundos-do-dia que a janela do veículo.
  const depotDepartSec = Math.round(((state.config.loadMin || 0) + (state.config.prepMin || 0)) * 60);
  const dayEndSec = depotDepartSec + 16 * 3600;
  const toleranceSec = (state.config.windowToleranceMin || 10) * 60;

  const payload = {
    jobs: stores.map((s, i) => {
      const job = { id: i + 1, location: [s.lng, s.lat], delivery: deliveryVector(s), service: serviceSec };
      const h = effectiveHorario(s);
      if (h && h.type === "from") {
        job.time_windows = [[Math.max(depotDepartSec, h.hour * 3600), dayEndSec]];
      } else if (h && h.type === "exact") {
        job.time_windows = [[Math.max(depotDepartSec, h.hour * 3600 - toleranceSec), h.hour * 3600 + toleranceSec]];
      }
      return job;
    }),
    vehicles: Array.from({ length: vehicleCount }, (_, i) => ({
      id: i + 1,
      profile,
      start: [depot.long, depot.lat],
      end: [depot.long, depot.lat],
      capacity: capacityVector(vehicle),
      max_tasks: maxStopsForZone(zona),
      time_window: [depotDepartSec, dayEndSec],
    })),
    options: { g: true },
  };

  const res = await fetch(ORS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  if (!data.routes || !data.routes.length) {
    // nada retornado (ex: 0 rotas viáveis) — cai no fallback local
    throw new Error("Nenhuma rota retornada pelo otimizador.");
  }

  const routes = data.routes.map(r => {
    const jobSteps = r.steps.filter(s => s.type === "job");
    const ordered = jobSteps.map(s => stores[s.id - 1]);
    const stepData = jobSteps.map((s, i) => ({
      arrivalSec: s.arrival,
      distFromPrevM: i === 0 ? (s.distance || 0) : (s.distance || 0) - (jobSteps[i - 1].distance || 0),
    }));
    return {
      depot, vehicle, zona,
      stores: ordered,
      engine: "ors",
      geometry: r.geometry ? decodePolyline(r.geometry) : null,
      stepData,
      totalDistanceM: r.distance || 0,
      totalDurationSec: r.duration || 0,
    };
  });

  // avisa se alguma loja do grupo não coube em nenhuma rota (raro, com a folga que damos)
  if (data.unassigned && data.unassigned.length) {
    const unassignedStores = data.unassigned.map(u => stores[u.id - 1]).filter(Boolean);
    if (unassignedStores.length) {
      routes.push({
        depot, vehicle, zona, stores: unassignedStores, engine: "unassigned",
        geometry: null, stepData: [],
      });
      toast(`${unassignedStores.length} loja(s) da zona ${zona} não coube em nenhuma rota — revise manualmente.`, "danger");
    }
  }

  return routes;
}

function estimateVehicleCount(vehicle, stores, zona) {
  const totalM3 = stores.reduce((a, s) => a + s.m3, 0);
  const totalKg = stores.reduce((a, s) => a + s.peso, 0);
  const byM3 = Math.ceil(totalM3 / vehicle.m3);
  const byKg = Math.ceil(totalKg / vehicle.kg);
  let estimate = Math.max(byM3, byKg, 1);
  if (state.hasPalletData) {
    const totalCon = stores.reduce((a, s) => a + (s.palletCongelado || 0), 0);
    const totalRes = stores.reduce((a, s) => a + (s.palletResfriado || 0), 0);
    const totalSec = stores.reduce((a, s) => a + (s.palletSeco || 0), 0);
    const totalPal = stores.reduce((a, s) => a + (s.palletTotal || 0), 0);
    estimate = Math.max(estimate,
      Math.ceil(totalCon / (vehicle.palletCongelado || 1)),
      Math.ceil(totalRes / (vehicle.palletResfriado || 1)),
      Math.ceil(totalSec / (vehicle.palletSeco || 1)),
      Math.ceil(totalPal / (vehicle.palletTotal || 1)));
  }
  estimate = Math.max(estimate, Math.ceil(stores.length / maxStopsForZone(zona)));
  estimate += 2; // folga pra evitar "unassigned"
  return Math.min(estimate, stores.length);
}

// Vetor de "entrega" de uma loja / "capacidade" de um veículo, na mesma ordem de dimensões.
// Sem detalhe de pedido importado, usa só [kg, m³×1000] (como sempre foi). Com o detalhe
// importado, adiciona posições de palete por câmara + total como dimensões extras — o
// VROOM/ORS já resolve otimização multi-dimensional nativamente.
function deliveryVector(s) {
  const base = [Math.max(1, Math.round(s.peso)), Math.max(1, Math.round(s.m3 * 1000))];
  if (!state.hasPalletData) return base;
  return [...base, s.palletCongelado || 0, s.palletResfriado || 0, s.palletSeco || 0, s.palletTotal || 0];
}
function capacityVector(vehicle) {
  const base = [Math.round(vehicle.kg), Math.round(vehicle.m3 * 1000)];
  if (!state.hasPalletData) return base;
  return [...base, vehicle.palletCongelado, vehicle.palletResfriado, vehicle.palletSeco, vehicle.palletTotal];
}

function decodePolyline(encoded, precision = 5) {
  let index = 0, lat = 0, lng = 0;
  const factor = Math.pow(10, precision);
  const coords = [];
  while (index < encoded.length) {
    let shift = 0, result = 0, b;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    coords.push([lat / factor, lng / factor]);
  }
  return coords;
}

/* ---- Caminho 2: TomTom (matriz de distância real + rota com trânsito) ---- */
async function optimizeGroupViaTomTom(depot, vehicle, stores, zona) {
  const travelMode = vehicle.codigo === "TRUCK" ? "truck" : "car";
  // separa em "lotes" já respeitando capacidade (mesma lógica de bin-packing do fallback local) —
  // a matriz do TomTom tem limite de tamanho, então cada rota candidata vira uma chamada pequena.
  const bins = binPackByCapacity(depot, vehicle, stores, zona);
  const routes = [];

  for (const bin of bins) {
    if (bin.length === 1) {
      routes.push(await buildSingleStopTomTomRoute(depot, vehicle, bin, zona, travelMode));
      continue;
    }
    if (bin.length > 24) {
      // lote grande demais pra matriz síncrona — ordena por vizinho mais próximo (haversine) e
      // ainda assim busca a rota real (geometria/tempo) via Calculate Route.
      const ordered = enforceWindowOrder(twoOptStops(depot, nearestNeighborHaversine(depot, bin), (a, b) => haversineKm(a.lat, a.lng, b.lat, b.lng)));
      routes.push(await buildTomTomRouteFromOrder(depot, vehicle, ordered, zona, travelMode));
      continue;
    }

    const points = [{ lat: depot.lat, lng: depot.long }, ...bin.map(s => ({ lat: s.lat, lng: s.lng }))];
    const matrixPayload = {
      origins: points.map(p => ({ point: { latitude: p.lat, longitude: p.lng } })),
      destinations: points.map(p => ({ point: { latitude: p.lat, longitude: p.lng } })),
      options: { departAt: "any", traffic: "historical", travelMode },
    };
    const res = await fetch(TOMTOM_ENDPOINT, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "matrix", payload: matrixPayload }),
    });
    const data = await res.json();
    if (!res.ok || data.error || !data.data) throw new Error(data.error || `HTTP ${res.status}`);

    const n = points.length;
    const cost = Array.from({ length: n }, () => new Array(n).fill(Infinity));
    data.data.forEach(cell => {
      if (cell.routeSummary) cost[cell.originIndex][cell.destinationIndex] = cell.routeSummary.travelTimeInSeconds;
    });

    // vizinho mais próximo pela matriz real (índice 0 = depósito)
    const visited = new Array(n).fill(false);
    visited[0] = true;
    let curIdx = 0;
    let orderIdx = [];
    for (let step = 0; step < n - 1; step++) {
      let bestIdx = -1, bestCost = Infinity;
      for (let j = 1; j < n; j++) {
        if (!visited[j] && cost[curIdx][j] < bestCost) { bestCost = cost[curIdx][j]; bestIdx = j; }
      }
      if (bestIdx === -1) break; // sobrou alguma célula sem rota — usa o que já foi ordenado
      visited[bestIdx] = true;
      orderIdx.push(bestIdx);
      curIdx = bestIdx;
    }
    // melhoria 2-opt usando a matriz de distância REAL (não linha reta) — desfaz cruzamentos
    orderIdx = twoOptByMatrix(orderIdx, cost);
    let ordered = orderIdx.map(i => bin[i - 1]);
    // qualquer loja que não entrou (célula com erro) vai no fim, pela ordem original
    bin.forEach(s => { if (!ordered.includes(s)) ordered.push(s); });
    ordered = enforceWindowOrder(ordered);

    routes.push(await buildTomTomRouteFromOrder(depot, vehicle, ordered, zona, travelMode));
  }

  return routes;
}

async function buildSingleStopTomTomRoute(depot, vehicle, bin, zona, travelMode) {
  try {
    return await buildTomTomRouteFromOrder(depot, vehicle, bin, zona, travelMode);
  } catch (e) {
    return buildRouteLocal(depot, vehicle, bin, zona);
  }
}

async function buildTomTomRouteFromOrder(depot, vehicle, orderedStores, zona, travelMode) {
  const waypoints = [
    `${depot.lat},${depot.long}`,
    ...orderedStores.map(s => `${s.lat},${s.lng}`),
    `${depot.lat},${depot.long}`,
  ].join(":");

  const res = await fetch(TOMTOM_ENDPOINT, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ op: "route", payload: { waypoints, travelMode } }),
  });
  const data = await res.json();
  if (!res.ok || data.error || !data.routes || !data.routes.length) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }

  const route = data.routes[0];
  const legs = route.legs || [];
  // primeira e última perna são depósito→primeira loja e última loja→depósito
  const storeLegs = legs.slice(0, legs.length); // legs[i] liga waypoint i ao i+1
  let cumSec = 0, cumM = 0;
  const stepData = [];
  orderedStores.forEach((s, i) => {
    const leg = storeLegs[i]; // perna que TERMINA nessa loja
    const legSec = leg?.summary?.travelTimeInSeconds || 0;
    const legM = leg?.summary?.lengthInMeters || 0;
    cumSec += legSec; cumM += legM;
    stepData.push({ arrivalSec: cumSec, distFromPrevM: legM });
  });
  const lastLeg = storeLegs[storeLegs.length - 1];
  const totalDurationSec = (route.summary?.travelTimeInSeconds) ?? (cumSec + (lastLeg?.summary?.travelTimeInSeconds || 0));
  const totalDistanceM = (route.summary?.lengthInMeters) ?? cumM;

  const geometry = [];
  legs.forEach(leg => (leg.points || []).forEach(p => geometry.push([p.latitude, p.longitude])));

  return {
    depot, vehicle, zona,
    stores: orderedStores,
    engine: "tomtom",
    geometry: geometry.length ? geometry : null,
    stepData,
    totalDistanceM,
    totalDurationSec,
  };
}

// Mesma ideia do twoOptStops, mas usando índices numa matriz de custo real (TomTom),
// em vez de distância em linha reta. seq[0] é sempre o depósito (índice 0 na matriz).
function twoOptByMatrix(orderIdx, costMatrix) {
  let seq = [0, ...orderIdx];
  let improved = true, iterations = 0;
  while (improved && iterations < 60) {
    improved = false;
    iterations++;
    for (let i = 1; i < seq.length - 1; i++) {
      for (let j = i + 1; j < seq.length; j++) {
        const a = seq[i - 1], b = seq[i], c = seq[j], d = seq[j + 1];
        const before = costMatrix[a][b] + (d !== undefined ? costMatrix[c][d] : 0);
        const after = costMatrix[a][c] + (d !== undefined ? costMatrix[b][d] : 0);
        if (after + 1e-9 < before) {
          const seg = seq.slice(i, j + 1).reverse();
          seq.splice(i, seg.length, ...seg);
          improved = true;
        }
      }
    }
  }
  return seq.slice(1);
}

function nearestNeighborHaversine(depot, stores) {
  const remaining = [...stores];
  const ordered = [];
  let cur = { lat: depot.lat, lng: depot.long };
  while (remaining.length) {
    let bestIdx = 0, bestDist = Infinity;
    remaining.forEach((s, i) => {
      const d = haversineKm(cur.lat, cur.lng, s.lat, s.lng);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    });
    const chosen = remaining.splice(bestIdx, 1)[0];
    ordered.push(chosen);
    cur = { lat: chosen.lat, lng: chosen.lng };
  }
  return ordered;
}

function binPackByCapacity(depot, vehicle, stores, zona) {
  const maxStops = maxStopsForZone(zona);
  const withAngle = stores.map(s => ({ s, angle: Math.atan2(s.lat - depot.lat, s.lng - depot.long) }));
  withAngle.sort((a, b) => a.angle - b.angle);
  const bins = [];
  let current = [], cur = { m3: 0, kg: 0, con: 0, res: 0, sec: 0, tot: 0 };
  const flush = () => { if (current.length) bins.push(current); current = []; cur = { m3: 0, kg: 0, con: 0, res: 0, sec: 0, tot: 0 }; };
  for (const { s } of withAngle) {
    const wouldExceed =
      cur.m3 + s.m3 > vehicle.m3 ||
      cur.kg + s.peso > vehicle.kg ||
      current.length >= maxStops ||
      (state.hasPalletData && (
        cur.con + (s.palletCongelado || 0) > vehicle.palletCongelado ||
        cur.res + (s.palletResfriado || 0) > vehicle.palletResfriado ||
        cur.sec + (s.palletSeco || 0) > vehicle.palletSeco ||
        cur.tot + (s.palletTotal || 0) > vehicle.palletTotal
      ));
    if (current.length > 0 && wouldExceed) flush();
    current.push(s);
    cur.m3 += s.m3; cur.kg += s.peso;
    cur.con += s.palletCongelado || 0; cur.res += s.palletResfriado || 0;
    cur.sec += s.palletSeco || 0; cur.tot += s.palletTotal || 0;
  }
  flush();
  return mergeAdjacentBins(vehicle, bins, maxStops);
}

// A varredura polar acima é uma versão do "sweep algorithm" clássico de VRP — monta os bins em
// ordem angular e fecha um bin assim que a próxima loja não cabe mais (Next-Fit). O problema
// conhecido do Next-Fit: uma vez fechado, um bin nunca é reaproveitado, mesmo que sobre bastante
// capacidade nele e a loja seguinte (por ângulo, ou seja, geograficamente vizinha) fosse pequena
// o bastante pra caber. Isso gera muito mais rotas do que o necessário. Esse passo de
// consolidação tenta juntar bins ADJACENTES (vizinhos no próprio sweep, logo também vizinhos no
// mapa) sempre que a soma das duas cargas ainda cabe no veículo e no limite de paradas — só isso
// já aproxima bastante a taxa de ocupação por rota do que uma roteirização manual bem feita
// consegue, sem abrir mão da proximidade geográfica que o sweep já garante.
function mergeAdjacentBins(vehicle, bins, maxStops) {
  const totals = (bin) => bin.reduce((acc, s) => {
    acc.m3 += s.m3; acc.kg += s.peso;
    acc.con += s.palletCongelado || 0; acc.res += s.palletResfriado || 0;
    acc.sec += s.palletSeco || 0; acc.tot += s.palletTotal || 0;
    return acc;
  }, { m3: 0, kg: 0, con: 0, res: 0, sec: 0, tot: 0 });

  let merged = bins.map(b => [...b]);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < merged.length - 1; i++) {
      const a = merged[i], b = merged[i + 1];
      if (a.length + b.length > maxStops) continue;
      const ta = totals(a), tb = totals(b);
      const cabe =
        ta.m3 + tb.m3 <= vehicle.m3 &&
        ta.kg + tb.kg <= vehicle.kg &&
        (!state.hasPalletData || (
          ta.con + tb.con <= vehicle.palletCongelado &&
          ta.res + tb.res <= vehicle.palletResfriado &&
          ta.sec + tb.sec <= vehicle.palletSeco &&
          ta.tot + tb.tot <= vehicle.palletTotal
        ));
      if (cabe) {
        merged.splice(i, 2, [...a, ...b]);
        changed = true;
        break; // reinicia a varredura — os índices mudaram
      }
    }
  }
  return merged;
}

/* ---- Caminho 3: fallback local (varredura polar + bin packing por haversine) ---- */
function clusterGroupLocally(depot, vehicle, stores, zona) {
  const bins = binPackByCapacity(depot, vehicle, stores, zona);
  return bins.map(bin => buildRouteLocal(depot, vehicle, bin, zona));
}

function buildRouteLocal(depot, vehicle, stores, zona) {
  const remaining = [...stores];
  const ordered = [];
  let cur = { lat: depot.lat, lng: depot.long };
  while (remaining.length) {
    let bestIdx = 0, bestDist = Infinity;
    remaining.forEach((s, i) => {
      const d = haversineKm(cur.lat, cur.lng, s.lat, s.lng);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    });
    const chosen = remaining.splice(bestIdx, 1)[0];
    ordered.push(chosen);
    cur = { lat: chosen.lat, lng: chosen.lng };
  }
  const improved = enforceWindowOrder(twoOptStops(depot, ordered, (a, b) => haversineKm(a.lat, a.lng, b.lat, b.lng)));
  return { depot, vehicle, zona, stores: improved, engine: "local", geometry: null, stepData: [] };
}

// Melhoria de rota clássica (2-opt): desfaz cruzamentos/zigue-zague testando inverter
// trechos da sequência sempre que isso reduzir a distância total. O depósito fica fixo
// como ponto de partida; só a ordem das paradas é otimizada.
function twoOptStops(depot, stores, distFn) {
  if (stores.length < 3) return stores;
  const seq = [{ lat: depot.lat, lng: depot.long }, ...stores];
  let improved = true, iterations = 0;
  while (improved && iterations < 60) {
    improved = false;
    iterations++;
    for (let i = 1; i < seq.length - 1; i++) {
      for (let j = i + 1; j < seq.length; j++) {
        const a = seq[i - 1], b = seq[i], c = seq[j], d = seq[j + 1];
        const before = distFn(a, b) + (d ? distFn(c, d) : 0);
        const after = distFn(a, c) + (d ? distFn(b, d) : 0);
        if (after + 1e-9 < before) {
          const seg = seq.slice(i, j + 1).reverse();
          seq.splice(i, seg.length, ...seg);
          improved = true;
        }
      }
    }
  }
  return seq.slice(1);
}

function computeUsage() {
  state.routes.forEach((r, i) => {
    r.m3 = r.stores.reduce((a, s) => a + s.m3, 0);
    r.kg = r.stores.reduce((a, s) => a + s.peso, 0);
    r.caixas = r.stores.reduce((a, s) => a + s.caixas, 0);
    r.palletCongelado = r.stores.reduce((a, s) => a + (s.palletCongelado || 0), 0);
    r.palletResfriado = r.stores.reduce((a, s) => a + (s.palletResfriado || 0), 0);
    r.palletSeco = r.stores.reduce((a, s) => a + (s.palletSeco || 0), 0);
    r.palletTotal = r.stores.reduce((a, s) => a + (s.palletTotal || 0), 0);
    state.colorByRoute[r.id] = colorForIndex(i);
    validateRouteWindows(r);
  });
}

/* ---------------- Rendering: KPIs ---------------- */
/* ---------------- Diagrama de carregamento (Load Planning) ---------------- */
const CAMARA_LABELS = { congelado: "CONGELADO", resfriado: "RESFRIADO", seco: "SECO" };
// O pedido principal do JDE já vem com uma linha por câmara, marcada em CALL.TDATA05
// ("Congelados"/"Resfriados"/"Secos") — confirmado comparando um pedido real roteirizado com o
// mesmo pedido finalizado no Paragon. Isso dá m³/kg/caixas EXATOS por câmara (não só a
// paletização por produto do "Detalhe do pedido", que é uma aproximação por SKU).
const CAMARA_LABEL_TO_KEY = { congelados: "congelado", resfriados: "resfriado", secos: "seco" };
function camaraKeyFromRow(r) {
  const raw = String(r["CALL.TDATA05"] || "").trim().toLowerCase();
  return CAMARA_LABEL_TO_KEY[raw] || null;
}
// ordem física frente→fundo (cabine → portas): congelado fica mais perto da unidade de
// frio, seco fica mais perto das portas traseiras.
const CAMARA_ORDER = ["congelado", "resfriado", "seco"];
// paleta de parada — tons discretos e corporativos, cicla se houver muitas paradas na mesma câmara
const STOP_PALETTE = ["#1E4E6B", "#2C7194", "#3F8FAE", "#6BAAC2", "#8FC0D3", "#4C7C97"];

function capacityStatus(pct) {
  if (pct > 100) return "excedido";
  if (pct >= 80) return "atencao";
  return "normal";
}
const STATUS_LABEL = { normal: "Normal", atencao: "Atenção", excedido: "Capacidade excedida" };

let truckModalCtx = null; // { route, highlightStop }

function openTruckModal(route) {
  truckModalCtx = { route, highlightStop: null };
  renderTruckModal();
  document.getElementById("truckModal").classList.add("show");
}
function closeTruckModal() { document.getElementById("truckModal").classList.remove("show"); truckModalCtx = null; }

function renderTruckModal() {
  if (!truckModalCtx) return;
  const { route, highlightStop } = truckModalCtx;
  const v = route.vehicle;

  const pctPallet = v.palletTotal ? (route.palletTotal / v.palletTotal) * 100 : 0;
  const pctM3 = (route.m3 / v.m3) * 100;
  const status = capacityStatus(Math.max(pctPallet, pctM3));

  document.getElementById("truckModalTitle").textContent = route.code;
  document.getElementById("truckModalSub").textContent =
    `${v.nome} · ${route.depot.sigla} → ${route.stores.length} parada${route.stores.length === 1 ? "" : "s"}`;
  const pill = document.getElementById("lpStatusPill");
  pill.textContent = status === "excedido" ? `⚠ CAPACIDADE EXCEDIDA · ${Math.round(Math.max(pctPallet, pctM3))}%` : STATUS_LABEL[status];
  pill.className = "lp-status-pill " + status;

  document.getElementById("lpCapacityPanel").innerHTML = buildCapacityPanelHtml(route, status);
  document.getElementById("truckSvgWrap").innerHTML = buildTruckSvg(route, highlightStop);
  document.getElementById("lpLegend").innerHTML = buildLegendHtml(route, highlightStop);

  const warnBox = document.getElementById("lpNoDataWarning");
  const nenhumaLojaComDado = route.stores.every(s => !state.detalhePorLoja || !state.detalhePorLoja[s.codigo]);
  if (nenhumaLojaComDado) {
    warnBox.style.display = "block";
    warnBox.textContent = "Nenhuma loja desta rota foi encontrada no arquivo de \"Detalhe do pedido\" importado — por isso o caminhão aparece sem carga. Confira se o arquivo de detalhe é do mesmo pedido/dia desta rota.";
  } else {
    warnBox.style.display = "none";
  }

  document.querySelectorAll(".lp-chip[data-stop]").forEach(chip => {
    chip.addEventListener("click", () => {
      const s = chip.dataset.stop;
      truckModalCtx.highlightStop = (truckModalCtx.highlightStop === s) ? null : s;
      renderTruckModal();
    });
  });
}

function buildCapacityPanelHtml(route, status) {
  const v = route.vehicle;
  const pctPallet = v.palletTotal ? Math.round((route.palletTotal / v.palletTotal) * 100) : 0;
  const bar = (pct) => {
    const st = capacityStatus(pct);
    return `<div class="lp-stat-bar"><div class="lp-stat-bar-fill ${st}" style="width:${Math.min(100, pct)}%"></div></div>`;
  };
  return `
    <div class="lp-stat">
      <span class="lp-stat-label">Ocupação</span>
      <span class="lp-stat-value">${pctPallet}%</span>
      ${bar(pctPallet)}
    </div>
    <div class="lp-stat">
      <span class="lp-stat-label">Volume</span>
      <span class="lp-stat-value">${fmtNum(route.m3)} <span class="lp-stat-max">/ ${fmtNum(v.m3)} m³</span></span>
      ${bar((route.m3 / v.m3) * 100)}
    </div>
    <div class="lp-stat">
      <span class="lp-stat-label">Peso</span>
      <span class="lp-stat-value">${fmtNum(route.kg, 0)} <span class="lp-stat-max">/ ${fmtNum(v.kg, 0)} kg</span></span>
      ${bar((route.kg / v.kg) * 100)}
    </div>
    <div class="lp-stat">
      <span class="lp-stat-label">Pallets</span>
      <span class="lp-stat-value">${route.palletTotal} <span class="lp-stat-max">/ ${v.palletTotal}</span></span>
      ${bar(pctPallet)}
    </div>
    <div class="lp-stat">
      <span class="lp-stat-label">Caixas</span>
      <span class="lp-stat-value">${route.caixas.toFixed(0)}</span>
    </div>
  `;
}

function buildLegendHtml(route, highlightStop) {
  const chips = route.stores.map((s, i) => {
    const stopNum = String(i + 1).padStart(2, "0");
    const color = STOP_PALETTE[i % STOP_PALETTE.length];
    const dimmed = highlightStop && highlightStop !== stopNum ? "dimmed" : "";
    const arrow = i < route.stores.length - 1 ? `<span class="lp-seq-arrow">→</span>` : "";
    return `<span class="lp-chip ${dimmed}" data-stop="${stopNum}">
      <span class="lp-chip-dot" style="background:${color}"></span>${stopNum} · ${s.codigo}
    </span>${arrow}`;
  }).join("");
  return `
    <span class="lp-legend-label">Sequência de descarga</span>
    ${chips}
    <span class="lp-chip lp-chip-free"><span class="lp-chip-dot"></span>Espaço livre</span>
    <span class="lp-legend-note">Clique numa parada pra destacar a carga dela no caminhão</span>
  `;
}

// Monta, por câmara, os segmentos de carga em ordem de parada — parada 01 fica mais perto
// da porta (carregada por último, desce primeiro), padrão LIFO usado em load planning real.
function buildCargoSegments(route) {
  const out = {};
  CAMARA_ORDER.forEach(key => {
    const max = route.vehicle["pallet" + key[0].toUpperCase() + key.slice(1)];
    if (!max) return;
    const segments = route.stores.map((s, i) => ({
      stopIndex: i + 1,
      stopLabel: String(i + 1).padStart(2, "0"),
      storeCode: s.codigo,
      pallets: s["pallet" + key[0].toUpperCase() + key.slice(1)] || 0,
      color: STOP_PALETTE[i % STOP_PALETTE.length],
    })).filter(seg => seg.pallets > 0);
    const used = segments.reduce((a, s) => a + s.pallets, 0);
    out[key] = { segments, max, used };
  });
  return out;
}

const CAMARA_DOT = { congelado: "#3D7A99", resfriado: "#2C8C7A", seco: "#A9895A" };

function buildTruckSvg(route, highlightStop) {
  const camaraData = buildCargoSegments(route);
  const camaras = CAMARA_ORDER.map(key => ({ key, ...camaraData[key] })).filter(c => c.max);
  const totalMax = camaras.reduce((a, c) => a + c.max, 0) || 1;

  const W = 900, H = 250;
  const cabX = 12, cabW = 136; // ~15% da largura total — a carga é o foco, não o caminhão
  const bedX = cabX + cabW + 16, bedY = 40, bedH = 130;
  const bedW = W - 24 - bedX;
  const groundY = bedY + bedH + 28;
  const floorY = bedY + bedH - 8;
  const iconTop = bedY + 22;
  const iconH = floorY - iconTop;

  let x = bedX;
  let groups = "", dividers = "";
  camaras.forEach((c, i) => {
    const w = (c.max / totalMax) * bedW;
    groups += buildCamaraGroup(c, x, bedY, w, iconTop, iconH, floorY, highlightStop);
    if (i > 0) dividers += `<line x1="${x.toFixed(1)}" y1="${bedY + 2}" x2="${x.toFixed(1)}" y2="${floorY + 6}" stroke="#B9C2C8" stroke-width="1.4" stroke-dasharray="1 3"/>`;
    x += w;
  });

  const nAxles = bedW > 420 ? 3 : 2;
  let trailerAxles = "";
  for (let i = 0; i < nAxles; i++) {
    const ax = bedX + 40 + i * ((bedW - 80) / Math.max(1, nAxles - 1) || 0);
    trailerAxles += sideWheel(ax, groundY);
  }

  return `
    <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:Manrope,Arial,sans-serif">
      <defs>
        <linearGradient id="depthShade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#0B1F2A" stop-opacity="0.07"/>
          <stop offset="18%" stop-color="#0B1F2A" stop-opacity="0"/>
        </linearGradient>
        <pattern id="overflowHatch" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
          <line x1="0" y1="0" x2="0" y2="6" stroke="#C1432B" stroke-width="1.8"/>
        </pattern>
      </defs>

      <line x1="0" y1="${groundY + 18}" x2="${W}" y2="${groundY + 18}" stroke="#E3E8EB" stroke-width="1.4"/>

      <!-- rodas -->
      ${sideWheel(cabX + 44, groundY)}
      ${trailerAxles}
      <!-- chassi -->
      <rect x="${cabX + cabW}" y="${groundY - 4}" width="${bedX - (cabX + cabW) + 8}" height="6" fill="#A6AEB4"/>

      <!-- cabine (contexto — deliberadamente discreta) -->
      <path d="M ${cabX} ${bedY + 34}
               L ${cabX} ${bedY + 14}
               Q ${cabX} ${bedY} ${cabX + 16} ${bedY}
               L ${cabX + cabW * 0.4} ${bedY}
               L ${cabX + cabW * 0.58} ${bedY + 20}
               L ${cabX + cabW} ${bedY + 20}
               L ${cabX + cabW} ${bedY + bedH}
               L ${cabX} ${bedY + bedH}
               L ${cabX} ${bedY + 34} Z"
        fill="#EEF1F3" stroke="#163B4A" stroke-width="1.6"/>
      <path d="M ${cabX + cabW * 0.42} ${bedY + 3} L ${cabX + cabW * 0.56} ${bedY + 19} L ${cabX + 12} ${bedY + 19} L ${cabX + 12} ${bedY + 3} Z"
        fill="#B9CEDA" stroke="#163B4A" stroke-width="1"/>
      <circle cx="${cabX + 5}" cy="${bedY + bedH * 0.5}" r="2.4" fill="#DE9A1E"/>

      <!-- baú (contexto, carga por dentro é o foco) -->
      <rect x="${bedX}" y="${bedY}" width="${bedW}" height="${bedH}" fill="#FBFCFC" stroke="#163B4A" stroke-width="1.8"/>
      <rect x="${bedX}" y="${bedY}" width="${bedW}" height="${bedH * 0.4}" fill="url(#depthShade)"/>
      <line x1="${bedX}" y1="${floorY}" x2="${bedX + bedW}" y2="${floorY}" stroke="#163B4A" stroke-width="1.2" opacity="0.35"/>

      ${groups}
      ${dividers}
      <rect x="${bedX}" y="${bedY}" width="${bedW}" height="${bedH}" fill="none" stroke="#163B4A" stroke-width="1.8"/>

      <!-- portas traseiras -->
      <line x1="${bedX + bedW - 1.5}" y1="${bedY}" x2="${bedX + bedW - 1.5}" y2="${bedY + bedH}" stroke="#163B4A" stroke-width="1.2" opacity="0.6"/>
      <circle cx="${bedX + bedW - 6}" cy="${bedY + 9}" r="1.6" fill="#163B4A"/>
      <circle cx="${bedX + bedW - 6}" cy="${bedY + bedH - 9}" r="1.6" fill="#163B4A"/>
    </svg>
  `;
}

function sideWheel(cx, groundY) {
  return `<g><circle cx="${cx}" cy="${groundY}" r="13" fill="#20262C"/><circle cx="${cx}" cy="${groundY}" r="5.5" fill="#8A97A3"/></g>`;
}

// Reduz a carga de uma câmara a uma lista de "posições" (1 por palete), já na ordem visual
// esquerda→direita: vazio (fundo) → parada mais distante → ... → parada 01 (porta).
function buildCamaraSlots(c) {
  const filled = [];
  [...c.segments].sort((a, b) => b.stopIndex - a.stopIndex).forEach(seg => {
    for (let i = 0; i < seg.pallets; i++) filled.push({ stopLabel: seg.stopLabel, storeCode: seg.storeCode, color: seg.color });
  });
  const overflowCount = Math.max(0, c.used - c.max);
  const emptyCount = Math.max(0, c.max - c.used);
  const units = [];
  for (let i = 0; i < emptyCount; i++) units.push({ empty: true });
  filled.forEach((u, i) => units.push({ ...u, overflow: i < overflowCount }));
  return units;
}

function buildCamaraGroup(c, x, y, w, iconTop, iconH, floorY, highlightStop) {
  const units = buildCamaraSlots(c);
  const slotW = w / Math.max(1, units.length);
  const over = c.used > c.max;

  let leadingEmpty = 0;
  while (leadingEmpty < units.length && units[leadingEmpty].empty) leadingEmpty++;
  const emptyW = leadingEmpty * slotW;

  let emptyBlock = "";
  if (emptyW > 3) {
    emptyBlock = `
      <rect x="${x.toFixed(1)}" y="${iconTop.toFixed(1)}" width="${emptyW.toFixed(1)}" height="${iconH.toFixed(1)}"
        fill="#FBFCFC" stroke="#D7DEE3" stroke-width="1" stroke-dasharray="3 2"/>
      ${Array.from({ length: 3 }, (_, i) => `<line x1="${(x + 6).toFixed(1)}" y1="${(iconTop + iconH * (0.28 + i * 0.22)).toFixed(1)}" x2="${(x + emptyW - 6).toFixed(1)}" y2="${(iconTop + iconH * (0.28 + i * 0.22)).toFixed(1)}" stroke="#E3E8EB" stroke-width="1"/>`).join("")}
      ${emptyW > 58 ? `<text x="${(x + emptyW / 2).toFixed(1)}" y="${(iconTop + iconH / 2 + 3).toFixed(1)}" text-anchor="middle" font-size="8" font-weight="700" letter-spacing="0.04em" fill="#A7B1B8">ESPAÇO LIVRE</text>` : ""}
    `;
  }

  let icons = "";
  for (let i = leadingEmpty; i < units.length; i++) {
    const ux = x + i * slotW;
    icons += buildPalletIcon(ux, slotW, iconTop, iconH, floorY, units[i], highlightStop, c.key);
  }

  const dotColor = CAMARA_DOT[c.key];
  return `
    <g>
      <circle cx="${(x + 5).toFixed(1)}" cy="${(y + 9).toFixed(1)}" r="3" fill="${dotColor}"/>
      <text x="${(x + 12).toFixed(1)}" y="${(y + 12).toFixed(1)}" font-size="9" font-weight="700" letter-spacing="0.04em"
        fill="#4A5560">${CAMARA_LABELS[c.key]} · ${c.used}/${c.max}</text>
      ${emptyBlock}
      ${icons}
    </g>
  `;
}

function buildPalletIcon(x, w, iconTop, iconH, floorY, unit, highlightStop, camaraKey) {
  if (unit.empty) return "";
  const dimmed = highlightStop && highlightStop !== unit.stopLabel;
  const gap = w > 10 ? 2 : 0.6;
  const iw = w - gap;
  const baseH = Math.min(6, iconH * 0.09);
  const boxTop = iconTop + iconH * 0.14;
  const boxH = (floorY - baseH) - boxTop;
  const fill = unit.overflow ? "url(#overflowHatch)" : unit.color;
  const stroke = unit.overflow ? "#C1432B" : unit.color;
  const showBadge = iw >= 17;
  const dotColor = CAMARA_DOT[camaraKey];

  let separators = "";
  if (iw > 20) {
    separators += `<line x1="${x.toFixed(1)}" y1="${(boxTop + boxH * 0.5).toFixed(1)}" x2="${(x + iw).toFixed(1)}" y2="${(boxTop + boxH * 0.5).toFixed(1)}" stroke="#FFFFFF" stroke-width="1" opacity="0.32"/>`;
    if (iw > 30) separators += `<line x1="${(x + iw * 0.5).toFixed(1)}" y1="${boxTop.toFixed(1)}" x2="${(x + iw * 0.5).toFixed(1)}" y2="${(boxTop + boxH).toFixed(1)}" stroke="#FFFFFF" stroke-width="1" opacity="0.32"/>`;
  }

  return `
    <g class="lp-cargo-block" opacity="${dimmed ? 0.25 : 1}">
      <title>Parada ${unit.stopLabel} · Loja ${unit.storeCode}${unit.overflow ? " — EXCEDE A CAPACIDADE" : ""}\n1 posição de palete · ${CAMARA_LABELS[camaraKey]}</title>
      <rect x="${x.toFixed(1)}" y="${boxTop.toFixed(1)}" width="${iw.toFixed(1)}" height="${boxH.toFixed(1)}" rx="1.5"
        fill="${fill}" fill-opacity="0.94" stroke="${stroke}" stroke-width="${unit.overflow ? 1.6 : 1}"/>
      ${separators}
      <rect x="${x.toFixed(1)}" y="${(floorY - baseH).toFixed(1)}" width="${iw.toFixed(1)}" height="${baseH.toFixed(1)}" fill="#8A97A3"/>
      ${showBadge ? `
        <rect x="${x.toFixed(1)}" y="${(boxTop - 1).toFixed(1)}" width="${iw.toFixed(1)}" height="12" fill="#163B4A" fill-opacity="0.88"/>
        <text x="${(x + iw / 2).toFixed(1)}" y="${(boxTop + 8).toFixed(1)}" text-anchor="middle" font-size="8.5" font-weight="700" fill="#FFFFFF">${unit.stopLabel}</text>
      ` : ""}
      ${iw >= 10 ? `<circle cx="${(x + iw - 4).toFixed(1)}" cy="${(boxTop + boxH - 5).toFixed(1)}" r="2" fill="${dotColor}" stroke="#FFFFFF" stroke-width="0.6"/>` : ""}
    </g>
  `;
}

function renderKpis() {
  const el = document.getElementById("kpis");
  const totalRoutes = state.routes.length;
  const totalCaixas = state.routes.reduce((a, r) => a + r.caixas, 0);
  const totalKg = state.routes.reduce((a, r) => a + r.kg, 0);
  const totalM3 = state.routes.reduce((a, r) => a + r.m3, 0);
  const overCap = state.routes.filter(r => r.m3 > r.vehicle.m3 || r.kg > r.vehicle.kg).length;

  el.innerHTML = `
    <div class="kpi"><div class="v">${totalRoutes}</div><div class="l">rotas</div></div>
    <div class="kpi"><div class="v">${totalCaixas.toFixed(0)}</div><div class="l">caixas</div></div>
    <div class="kpi"><div class="v">${fmtNum(totalKg, 0)}</div><div class="l">kg</div></div>
    <div class="kpi"><div class="v">${fmtNum(totalM3, 1)}</div><div class="l">m³</div></div>
    <div class="kpi ${overCap ? "alert" : ""}"><div class="v">${overCap}</div><div class="l">acima da capacidade</div></div>
  `;
}

/* ---------------- Rendering: route list ---------------- */
function palletGaugesHtml(route) {
  const dims = [
    ["CON", route.palletCongelado, route.vehicle.palletCongelado],
    ["RES", route.palletResfriado, route.vehicle.palletResfriado],
    ["SEC", route.palletSeco, route.vehicle.palletSeco],
    ["TOTAL", route.palletTotal, route.vehicle.palletTotal],
  ];
  const cells = dims.map(([label, used, max]) => {
    const over = used > max;
    const pct = max ? Math.min(100, (used / max) * 100) : 0;
    return `
      <div class="gauge">
        <div class="gauge-label"><span>plt ${label}</span><span>${used}/${max}</span></div>
        <div class="gauge-bar"><div class="gauge-fill ${over ? "over" : (pct > 85 ? "warn" : "")}" style="width:${pct}%"></div></div>
      </div>`;
  }).join("");
  return `<div class="route-gauges pallet-gauges">${cells}</div>`;
}

function renderRouteList() {
  const list = document.getElementById("routeList");
  const empty = document.getElementById("rotas-empty");
  const content = document.getElementById("rotas-content");

  if (!state.routes.length) {
    empty.style.display = "block";
    content.style.display = "none";
    return;
  }
  empty.style.display = "none";
  content.style.display = "block";

  const q = (document.getElementById("routeSearch").value || "").toLowerCase();

  list.innerHTML = "";
  state.routes.forEach(route => {
    const matches = !q || (route.code || "").toLowerCase().includes(q) ||
      route.stores.some(s => s.codigo.toLowerCase().includes(q));
    if (!matches) return;

    const card = buildRouteCardEl(route);
    list.appendChild(card);

    if (route.id === state.selectedRouteId) {
      const scrollFn = () => { if (typeof card.scrollIntoView === "function") card.scrollIntoView({ behavior: "smooth", block: "nearest" }); };
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(scrollFn); else scrollFn();
    }
  });
}

// Construção do card de rota isolada num função própria porque é usada em três lugares com os
// MESMOS dados (mesma referência de `route`, só o elemento DOM é outro): a lista lateral, e as
// duas colunas espelhadas do modal "Trocar lojas entre rotas" — arrastar de uma coluna pra
// outra funciona porque as duas leem/escrevem o mesmo `state.routes`, só a exibição é duplicada.
function buildRouteCardEl(route) {
  const color = state.colorByRoute[route.id];
  const overM3 = route.m3 > route.vehicle.m3;
  const overKg = route.kg > route.vehicle.kg;

  const card = document.createElement("div");
  card.className = "route-card" + (route.id === state.selectedRouteId ? " open selected" : "") +
    (route.engine === "unassigned" ? " route-danger" : "");
  card.dataset.routeId = route.id;

  const engineLabels = {
    ors: ["ok", "rota real · ORS", "Distância e sequência calculadas pela malha viária real (OpenRouteService)"],
    tomtom: ["ok", "rota real · TomTom", "Distância e sequência calculadas pela malha viária real, com trânsito (TomTom)"],
    unassigned: ["danger", "sem rota", "Não coube em nenhum veículo — mova manualmente"],
    local: ["warn", "estimado", "APIs indisponíveis — estimativa por linha reta"],
    manual: ["", "manual", "Rota criada manualmente — arraste lojas pra cá"],
  };
  const [badgeClass, badgeText, badgeTitle] = engineLabels[route.engine] || engineLabels.local;
  const engineBadge = `<span class="route-engine ${badgeClass}" title="${badgeTitle}">${badgeText}</span>`;
  const maxStops = maxStopsForZone(route.zona);
  const stopCountBadge = `<span class="route-stop-count${route.stores.length > maxStops ? " over" : ""}" title="Limite de paradas configurado pra esta zona: ${maxStops}">${route.stores.length}/${maxStops}</span>`;
  const horarioWarnBadge = route._horarioViolado
    ? `<span class="route-engine danger" title="Uma ou mais lojas desta rota têm horário obrigatório (🕐) que a sequência calculada não cumpre — confira loja por loja">⚠ horário</span>`
    : "";
  const transportadora = transportadoraForZone(route.zona);
  const transportadoraBadge = transportadora
    ? `<span class="route-engine" style="background:var(--primary-tint);color:var(--primary-2)" title="Transportadora padrão desta zona">${transportadora}</span>`
    : "";

  card.innerHTML = `
    <div class="route-head">
      <div class="route-swatch" style="background:${color}"></div>
      <div>
        <div class="route-code" title="Clique pra renomear">${route.code || `<span class="route-code-placeholder">Nomear rota…</span>`}</div>
        <div class="route-depot">${route.depot.sigla} · ${stopCountBadge} paradas ${engineBadge}${horarioWarnBadge}${transportadoraBadge}</div>
      </div>
      <div class="spacer"></div>
      <button class="route-truck-icon-btn truck-view-btn" data-route-id="${route.id}" title="Ver caminhão desta rota">+</button>
      <select class="route-vehicle" title="Trocar o veículo desta rota">
        ${state.config.vehicles.map(v => `<option value="${v.codigo}" ${v.codigo === route.vehicle.codigo ? "selected" : ""}>${v.codigo}</option>`).join("")}
      </select>
    </div>
    <div class="route-gauges">
      <div class="gauge">
        <div class="gauge-label"><span>M³</span><span>${fmtNum(route.m3)}/${fmtNum(route.vehicle.m3)}</span></div>
        <div class="gauge-bar"><div class="gauge-fill ${overM3 ? "over" : (route.m3 / route.vehicle.m3 > 0.85 ? "warn" : "")}" style="width:${Math.min(100, route.m3 / route.vehicle.m3 * 100)}%"></div></div>
      </div>
      <div class="gauge">
        <div class="gauge-label"><span>KG</span><span>${fmtNum(route.kg, 0)}/${fmtNum(route.vehicle.kg, 0)}</span></div>
        <div class="gauge-bar"><div class="gauge-fill ${overKg ? "over" : (route.kg / route.vehicle.kg > 0.85 ? "warn" : "")}" style="width:${Math.min(100, route.kg / route.vehicle.kg * 100)}%"></div></div>
      </div>
    </div>
    ${state.hasPalletData ? palletGaugesHtml(route) : ""}
    <div class="route-stops"></div>
  `;

  const stopsWrap = card.querySelector(".route-stops");
  route.stores.forEach((s, i) => stopsWrap.appendChild(buildStopRowEl(s, i, route)));

  card.querySelector(".route-head").addEventListener("click", () => selectRoute(route.id));

  attachRouteCodeEditor(card.querySelector(".route-code"), route);

  const vehicleSelect = card.querySelector(".route-vehicle");
  vehicleSelect.addEventListener("click", (e) => e.stopPropagation());
  vehicleSelect.addEventListener("change", (e) => {
    e.stopPropagation();
    const novoVeiculo = state.config.vehicles.find(v => v.codigo === e.target.value);
    if (!novoVeiculo) return;
    route.vehicle = novoVeiculo;
    renderAll();
    toast(`${route.code || "Rota"} agora usa ${novoVeiculo.codigo}. Confira a capacidade.`);
  });

  const truckBtn = card.querySelector(".truck-view-btn");
  if (truckBtn) truckBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!state.hasPalletData) {
      toast("Importe o \"Detalhe do pedido\" (botão no topo) pra ver a carga do caminhão por posição de palete.", "");
      return;
    }
    openTruckModal(route);
  });

  card.addEventListener("dragover", (e) => { e.preventDefault(); card.classList.add("drag-over"); });
  card.addEventListener("dragleave", () => card.classList.remove("drag-over"));
  card.addEventListener("drop", (e) => onStopDrop(e, route.id));

  return card;
}

function selectRoute(routeId) {
  const wasSelected = state.selectedRouteId === routeId;
  state.selectedRouteId = wasSelected ? null : routeId;
  renderRouteList();
  if (isSwapModalOpen()) renderSwapModal();
  if (wasSelected) renderMap(); else focusRouteOnMap(routeId);
}

// Clicar no nome da rota vira um campo de texto editável — usado tanto pra renomear rotas
// normais quanto pra dar nome às rotas em branco (nova rota manual / encaixe que precisou virar
// rota própria porque não coube em nenhuma loja/rota existente).
function attachRouteCodeEditor(codeEl, route) {
  codeEl.addEventListener("click", (e) => {
    e.stopPropagation();
    const input = document.createElement("input");
    input.className = "route-code-input";
    input.value = route.code || "";
    input.placeholder = "Nome da rota";
    codeEl.replaceWith(input);
    input.focus(); input.select();
    let done = false;
    const commit = () => { if (done) return; done = true; route.code = input.value.trim(); renderAll(); };
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") input.blur();
      else if (ev.key === "Escape") { done = true; renderAll(); }
    });
    input.addEventListener("blur", commit);
    input.addEventListener("click", (ev) => ev.stopPropagation());
  });
}

// Uma linha de loja — usada na lista de rotas, nas duas colunas do modal "Trocar lojas" e no
// painel de "Encaixes (SA)" (nesse último, `route` vem null: a loja ainda não pertence a
// nenhuma rota, só pode ser arrastada PARA uma).
function buildStopRowEl(s, i, route) {
  const row = document.createElement("div");
  row.className = "stop-row";
  row.draggable = true;
  row.dataset.storeId = s.id;
  row.dataset.fromRoute = route ? route.id : "SA";

  const h = effectiveHorario(s);
  const hClass = h ? (h.type === "exact" ? "exact" : h.type === "from" ? "from" : "") : "";
  const violado = s._horarioViolado ? " violado" : "";

  row.innerHTML = `
    <span class="stop-idx">${i + 1}</span>
    <span class="stop-name">${s.codigo}</span>
    <span class="stop-metric">${fmtNum(s.m3)} m³ · ${fmtNum(s.peso, 0)} kg</span>
    ${state.hasPalletData ? `<button class="stop-cam-btn" type="button" title="Ver/mover carga por câmara (congelado/resfriado/seco)">📦 ${s.palletTotal || 0}</button>` : ""}
    <button class="horario-badge ${hClass}${violado}" type="button">${horarioBadgeText(h)}</button>
  `;
  row.querySelector(".horario-badge").title = horarioLabel(h);

  row.addEventListener("dragstart", onStopDragStart);
  row.addEventListener("dragend", onStopDragEnd);

  row.querySelector(".horario-badge").addEventListener("click", (e) => {
    e.stopPropagation();
    openHorarioPopover(e.currentTarget, s);
  });

  const camBtn = row.querySelector(".stop-cam-btn");
  if (camBtn) camBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleStopCamDetail(row, s, route);
  });

  return row;
}

let dragPayload = null;
function onStopDragStart(e) {
  dragPayload = { storeId: e.currentTarget.dataset.storeId, fromRoute: e.currentTarget.dataset.fromRoute };
  e.currentTarget.classList.add("dragging");
}
function onStopDragEnd(e) { e.currentTarget.classList.remove("dragging"); }

function onStopDrop(e, targetRouteId) {
  e.preventDefault();
  e.currentTarget.classList.remove("drag-over");
  if (!dragPayload || dragPayload.fromRoute === targetRouteId) return;
  moveStoreToRoute(dragPayload.storeId, dragPayload.fromRoute, targetRouteId);
}

// `fromId` pode ser o id de uma rota OU o sentinel "SA" (loja ainda no painel de encaixes).
function findStoreContainer(fromId) {
  if (fromId === "SA") return { list: state.saStores, route: null };
  const route = state.routes.find(r => r.id === fromId);
  return route ? { list: route.stores, route } : null;
}

function moveStoreToRoute(storeId, fromId, targetRouteId) {
  const from = findStoreContainer(fromId);
  const toRoute = state.routes.find(r => r.id === targetRouteId);
  if (!from || !toRoute) return;

  const idx = from.list.findIndex(s => s.id === storeId);
  if (idx === -1) return;
  const [store] = from.list.splice(idx, 1);
  toRoute.stores.push(store);

  // edição manual invalida os dados de tempo/geometria vindos do otimizador — volta pra estimativa
  [from.route, toRoute].forEach(r => {
    if (r && (r.engine === "ors" || r.engine === "tomtom")) { r.engine = "local"; r.geometry = null; r.stepData = []; }
  });

  computeUsage();
  renderAll();
  toast(`${store.codigo} movida para ${toRoute.code || "rota sem nome"}. Confira a capacidade.`);
}

/* ---------------- Encaixes (SA) ---------------- */
function updateSaPanel() {
  const panel = document.getElementById("saPanel");
  const listEl = document.getElementById("saList");
  const countEl = document.getElementById("saCount");
  if (!panel || !listEl || !countEl) return;
  const stores = state.saStores || [];
  countEl.textContent = String(stores.length);
  panel.style.display = stores.length ? "block" : "none";
  listEl.innerHTML = "";
  stores.forEach((s, i) => listEl.appendChild(buildStopRowEl(s, i, null)));
}

/* ---------------- Modal "Trocar lojas entre rotas" ---------------- */
function renderSwapModal() {
  ["swapListA", "swapListB"].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = "";
    state.routes.forEach(route => el.appendChild(buildRouteCardEl(route)));
  });
}

/* ---------------- Janela de horário: edição inline (popover) ---------------- */
let activeHorarioPopover = null;
function closeHorarioPopover() {
  if (activeHorarioPopover) { activeHorarioPopover.remove(); activeHorarioPopover = null; }
}
document.addEventListener("click", (e) => {
  if (activeHorarioPopover && !activeHorarioPopover.contains(e.target)) closeHorarioPopover();
});

function openHorarioPopover(anchorEl, store) {
  closeHorarioPopover();
  const h = effectiveHorario(store) || { hour: 8, type: "free" };
  const pop = document.createElement("div");
  pop.className = "horario-pop";
  pop.innerHTML = `
    <div class="row"><label style="flex:1">Horário</label>
      <select class="hp-hour">${Array.from({ length: 24 }, (_, i) =>
        `<option value="${i}" ${i === h.hour ? "selected" : ""}>${String(i).padStart(2, "0")}:00</option>`).join("")}</select>
    </div>
    <div class="row"><label style="flex:1">Restrição</label>
      <select class="hp-type">
        <option value="free" ${h.type === "free" ? "selected" : ""}>Sem restrição (ref.)</option>
        <option value="from" ${h.type === "from" ? "selected" : ""}>Obrigatório: a partir do horário</option>
        <option value="exact" ${h.type === "exact" ? "selected" : ""}>Obrigatório: só naquele horário</option>
      </select>
    </div>
    <div class="actions">
      <button class="btn btn-sm btn-line" data-act="reset" type="button">Original</button>
      <button class="btn btn-sm btn-primary" data-act="save" type="button">Salvar</button>
    </div>
  `;
  document.body.appendChild(pop);
  const rect = anchorEl.getBoundingClientRect();
  pop.style.top = (rect.bottom + window.scrollY + 6) + "px";
  pop.style.left = Math.max(6, Math.min(rect.left + window.scrollX, window.innerWidth - 210)) + "px";
  activeHorarioPopover = pop;

  pop.addEventListener("click", (e) => e.stopPropagation());
  pop.querySelector('[data-act="save"]').addEventListener("click", () => {
    store.horarioOverride = {
      hour: parseInt(pop.querySelector(".hp-hour").value, 10),
      type: pop.querySelector(".hp-type").value,
    };
    closeHorarioPopover();
    computeUsage();
    renderAll();
    toast(`Horário de ${store.codigo} atualizado.`);
  });
  pop.querySelector('[data-act="reset"]').addEventListener("click", () => {
    store.horarioOverride = null;
    closeHorarioPopover();
    computeUsage();
    renderAll();
  });
}

/* ---------------- Carga por câmara (congelado/resfriado/seco) por loja ---------------- */
// Só existe quando o "Detalhe do pedido" foi importado (é dali que vem a posição de palete por
// câmara, por loja). Permite mover só uma câmara pra outra rota — a mesma loja acaba com dois
// (ou três) pontos de entrega, um por rota/veículo, pra caber num 3/4 que não aguenta o pedido
// inteiro de uma vez. A divisão de m³/kg/caixas é proporcional à fração de paletes movida —
// uma aproximação, já que o pedido principal não separa m³/kg por câmara linha a linha.
function toggleStopCamDetail(row, store, route) {
  const existing = row.nextElementSibling;
  if (existing && existing.classList.contains("stop-cam-detail")) { existing.remove(); return; }
  document.querySelectorAll(".stop-cam-detail").forEach(el => el.remove());
  if (!route) { toast("Arraste esta loja pra uma rota primeiro pra poder dividir a carga por câmara.", ""); return; }

  const detail = document.createElement("div");
  detail.className = "stop-cam-detail";
  detail.innerHTML = buildStopCamDetailHtml(store, route);
  row.after(detail);

  detail.querySelectorAll(".cam-row[data-cam]").forEach(camRow => {
    const key = camRow.dataset.cam;
    const btn = camRow.querySelector("button");
    if (!btn) return;
    btn.addEventListener("click", () => {
      const qty = parseInt(camRow.querySelector("input").value, 10) || 0;
      const targetRouteId = camRow.querySelector("select").value;
      if (!targetRouteId || qty <= 0) { toast("Escolha a rota destino e uma quantidade válida.", "danger"); return; }
      splitStoreCamera(store, route, key, qty, targetRouteId);
    });
  });
}

function buildStopCamDetailHtml(store, route) {
  const cams = [["congelado", "CONGELADO"], ["resfriado", "RESFRIADO"], ["seco", "SECO"]];
  const otherRoutes = state.routes.filter(r => r.id !== route.id);
  const routeOptions = otherRoutes.map(r =>
    `<option value="${r.id}">${r.code || "(sem nome)"} · ${r.stores.length} paradas</option>`).join("");
  const rows = cams.map(([key, label]) => {
    const propKey = "pallet" + key[0].toUpperCase() + key.slice(1);
    const qty = store[propKey] || 0;
    if (!qty) return `<div class="cam-row"><span class="cam-label">${label}</span><span>0 posições</span></div>`;
    return `
      <div class="cam-row" data-cam="${key}">
        <span class="cam-label">${label}</span>
        <span>${qty} plt</span>
        <input type="number" min="1" max="${qty}" value="${qty}" title="Quantas posições de palete mover" />
        <select title="Rota destino"><option value="">Mover p/ rota...</option>${routeOptions}</select>
        <button class="btn btn-sm btn-line" type="button">Mover</button>
      </div>`;
  }).join("");
  return rows + `<div class="hint" style="margin:4px 0 0">Mover a câmara inteira (quantidade cheia) separa certinho, linha a linha do pedido. Mover só uma parte é uma aproximação de m³/kg e trava a exportação até resolver.</div>`;
}

function splitStoreCamera(store, route, camara, qty, targetRouteId) {
  const targetRoute = state.routes.find(r => r.id === targetRouteId);
  if (!targetRoute) return;
  const key = "pallet" + camara[0].toUpperCase() + camara.slice(1);
  const have = store[key] || 0;
  qty = Math.min(qty, have);
  if (qty <= 0) return;

  // já existe uma parte dessa mesma loja na rota destino (de uma divisão anterior)? soma nela.
  const parentId = store.isSplitOf || store.id;
  let target = targetRoute.stores.find(s => (s.isSplitOf || s.id) === parentId && s !== store);
  if (!target) {
    target = { ...store, id: store.id + "_split_" + Date.now(), isSplitOf: parentId,
      m3: 0, peso: 0, caixas: 0, palletCongelado: 0, palletResfriado: 0, palletSeco: 0, palletTotal: 0,
      horarioOverride: store.horarioOverride, horario: store.horario,
      rows: [], porCamara: {}, isSplitExact: true };
    targetRoute.stores.push(target);
  }

  // Movendo a câmara INTEIRA (qty === have) e com a marcação por linha do pedido principal
  // (CALL.TDATA05, ver camaraKeyFromRow) disponível: dá pra mover as linhas de pedido de verdade
  // pro destino, com m³/kg/caixas exatos — sem duplicar nem perder nada no export. Movimento
  // PARCIAL (sobra câmara na loja de origem) não tem como mover linha por linha — cai na
  // aproximação proporcional de sempre, e fica marcado pra travar o export até resolver.
  const exact = qty === have && store.porCamara && store.porCamara[camara];
  let movedM3, movedKg, movedCx;

  if (exact) {
    const cam = store.porCamara[camara];
    movedM3 = cam.m3; movedKg = cam.peso; movedCx = cam.caixas;
    cam.rows.forEach(r => {
      const idx = store.rows.indexOf(r);
      if (idx !== -1) store.rows.splice(idx, 1);
    });
    target.rows.push(...cam.rows);
    target.porCamara[camara] = cam;
    delete store.porCamara[camara];
  } else {
    // m³/kg/caixas não são separados por câmara nesse caso — a fração movida é sobre o TOTAL de
    // paletes da loja (não só os dessa câmara): mover 1 de 2 posições de congelado numa loja que
    // tem 5 posições no total move 1/5 do m³/kg, não 1/2 (senão puxaria proporcionalmente m³ que
    // na real é de seco/resfriado, superestimando a carga movida).
    const totalPal = store.palletTotal || (store.palletCongelado || 0) + (store.palletResfriado || 0) + (store.palletSeco || 0);
    const shareOfStore = totalPal ? qty / totalPal : 0;
    movedM3 = store.m3 * shareOfStore; movedKg = store.peso * shareOfStore; movedCx = store.caixas * shareOfStore;
    target.isSplitExact = false;
  }

  store[key] = have - qty;
  store.palletTotal = Math.max(0, (store.palletTotal || 0) - qty);
  store.m3 -= movedM3; store.peso -= movedKg; store.caixas -= movedCx;
  target[key] = (target[key] || 0) + qty;
  target.palletTotal = (target.palletTotal || 0) + qty;
  target.m3 += movedM3; target.peso += movedKg; target.caixas += movedCx;

  // se a loja de origem não ficou com carga nenhuma, remove o registro vazio dessa rota.
  if ((store.palletTotal || 0) <= 0) {
    const idx = route.stores.indexOf(store);
    if (idx !== -1) route.stores.splice(idx, 1);
  }

  [route, targetRoute].forEach(r => {
    if (r.engine === "ors" || r.engine === "tomtom") { r.engine = "local"; r.geometry = null; r.stepData = []; }
  });

  computeUsage();
  renderAll();
  const obs = exact ? "" : " (divisão parcial — m³/kg é uma aproximação, exportação bloqueada até resolver)";
  toast(`${qty} posição(ões) de ${camara} de ${store.codigo} movida(s) para ${targetRoute.code || "rota sem nome"}.${obs}`);
}

/* ---------------- Map ---------------- */
function initMap() {
  state.map = L.map("map", { zoomControl: true }).setView([-15.78, -47.93], 4.4);
  L.tileLayer(
    `https://api.mapbox.com/styles/v1/mapbox/light-v11/tiles/{z}/{x}/{y}@2x?access_token=${MAPBOX_TOKEN}`,
    { attribution: "© Mapbox © OpenStreetMap", maxZoom: 19, tileSize: 512, zoomOffset: -1 }
  ).addTo(state.map);
  state.map.on("movestart", () => { state.map._userMoved = true; });
}

function renderMap() {
  state.layers.routes.forEach(l => state.map.removeLayer(l));
  state.layers.stops.forEach(l => state.map.removeLayer(l));
  if (state.layers.depots) state.map.removeLayer(state.layers.depots);
  state.layers.routes = [];
  state.layers.stops = [];

  const depotGroup = L.layerGroup();
  const usedDepots = new Set(state.routes.map(r => r.depot.sigla));
  usedDepots.forEach(sig => {
    const d = depotBySigla(sig);
    if (!d) return;
    const marker = L.marker([d.lat, d.long], {
      icon: L.divIcon({ className: "", html: `<div class="depot-marker">◆</div>`, iconSize: [26, 26] }),
    }).bindPopup(`<b>${d.sigla}</b><br>${d.nome}`);
    depotGroup.addLayer(marker);
  });
  depotGroup.addTo(state.map);
  state.layers.depots = depotGroup;

  const bounds = [];
  state.routes.forEach(route => {
    const color = state.colorByRoute[route.id];
    const straightLatlngs = [[route.depot.lat, route.depot.long], ...route.stores.map(s => [s.lat, s.lng])];
    const latlngs = route.geometry && route.geometry.length ? route.geometry : straightLatlngs;
    const line = L.polyline(latlngs, {
      color, weight: route.id === state.selectedRouteId ? 6 : 3,
      dashArray: (route.engine === "ors" || route.engine === "tomtom") ? null : "6 4",
      opacity: state.selectedRouteId ? (route.id === state.selectedRouteId ? 0.95 : 0.1) : 0.68,
    }).addTo(state.map);
    line.on("click", () => {
      const wasSelected = state.selectedRouteId === route.id;
      state.selectedRouteId = wasSelected ? null : route.id;
      renderRouteList();
      if (wasSelected) renderMap(); else focusRouteOnMap(route.id);
    });
    state.layers.routes.push(line);
    latlngs.forEach(ll => bounds.push(ll));

    route.stores.forEach((s, i) => {
      const isSelected = state.selectedRouteId === route.id;
      const isOtherSelected = state.selectedRouteId && !isSelected;
      let marker;
      if (isOtherSelected) {
        // com outra rota selecionada, essa nem aparece — reduz poluição visual
        return;
      } else if (!state.selectedRouteId) {
        // nada selecionado: só um pontinho discreto por loja, sem número (evita poluir o mapa com 269 círculos numerados)
        marker = L.marker([s.lat, s.lng], {
          icon: L.divIcon({ className: "", html: `<div class="stop-dot" style="background:${color}"></div>`, iconSize: [10, 10] }),
        }).bindPopup(`<b>${s.codigo}</b><br>${route.code} · parada ${i + 1}<br>${fmtNum(s.m3)} m³ · ${fmtNum(s.peso, 0)} kg`);
        marker.on("click", () => {
          state.selectedRouteId = route.id;
          renderRouteList();
          focusRouteOnMap(route.id);
        });
      } else {
        // rota selecionada: marcador numerado normal, só das paradas dela
        marker = L.marker([s.lat, s.lng], {
          icon: L.divIcon({
            className: "", html: `<div class="stop-marker" style="border-color:${color};color:${color}">${i + 1}</div>`,
            iconSize: [22, 22],
          }),
        }).bindPopup(`<b>${s.codigo}</b><br>${route.code} · parada ${i + 1}<br>${fmtNum(s.m3)} m³ · ${fmtNum(s.peso, 0)} kg`);
      }
      state.map.addLayer(marker);
      state.layers.stops.push(marker);
    });
  });

  if (bounds.length && !state.map._userMoved) {
    state.map.fitBounds(bounds, { padding: [40, 40] });
  }
}

function focusRouteOnMap(routeId) {
  renderMap();
  const route = state.routes.find(r => r.id === routeId);
  if (!route) return;
  const straightBounds = [[route.depot.lat, route.depot.long], ...route.stores.map(s => [s.lat, s.lng])];
  const bounds = route.geometry && route.geometry.length ? route.geometry : straightBounds;
  state.map.fitBounds(bounds, { padding: [70, 70], maxZoom: 13, animate: true, duration: 0.6 });
}

function renderLegend() {
  const wrap = document.getElementById("legendRows");
  wrap.innerHTML = state.routes.slice(0, 12).map(r => `
    <div class="legend-row">
      <div class="legend-dot" style="background:${state.colorByRoute[r.id]}"></div>
      <span>${r.code} · ${r.stores.length} paradas</span>
    </div>
  `).join("") + (state.routes.length > 12 ? `<div class="legend-row" style="color:var(--ink-faint)">+ ${state.routes.length - 12} rotas...</div>` : "");
}

function isSwapModalOpen() {
  const el = document.getElementById("swapModal");
  return !!el && el.classList.contains("show");
}

function renderAll() {
  renderKpis();
  renderRouteList();
  updateSaPanel();
  renderMap();
  renderLegend();
  if (isSwapModalOpen()) renderSwapModal();
}

/* ---------------- Config tab rendering ---------------- */
function renderConfigTab() {
  const tv = document.querySelector("#tblVehicles tbody");
  tv.innerHTML = "";
  state.config.vehicles.forEach((v, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input value="${v.codigo}" data-k="codigo" /></td>
      <td><input value="${v.nome}" data-k="nome" style="font-family:var(--font-ui)" /></td>
      <td><input type="number" step="0.1" value="${v.m3}" data-k="m3" /></td>
      <td><input type="number" value="${v.kg}" data-k="kg" /></td>
      <td><button class="btn btn-sm btn-line" data-del="1">✕</button></td>
    `;
    tr.querySelectorAll("input").forEach(inp => inp.addEventListener("change", (e) => {
      v[e.target.dataset.k] = e.target.type === "number" ? parseFloat(e.target.value) : e.target.value;
      saveConfig(); runClustering();
    }));
    tr.querySelector("[data-del]").addEventListener("click", () => {
      state.config.vehicles.splice(i, 1); saveConfig(); renderConfigTab(); runClustering();
    });
    tv.appendChild(tr);
  });

  const tp = document.querySelector("#tblPallets tbody");
  tp.innerHTML = "";
  state.config.vehicles.forEach(v => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${v.codigo}</td>
      <td><input type="number" value="${v.palletTotal ?? 0}" data-k="palletTotal" /></td>
      <td><input type="number" value="${v.palletCongelado ?? 0}" data-k="palletCongelado" /></td>
      <td><input type="number" value="${v.palletResfriado ?? 0}" data-k="palletResfriado" /></td>
      <td><input type="number" value="${v.palletSeco ?? 0}" data-k="palletSeco" /></td>
    `;
    tr.querySelectorAll("input").forEach(inp => inp.addEventListener("change", (e) => {
      v[e.target.dataset.k] = parseFloat(e.target.value) || 0;
      saveConfig(); runClustering();
    }));
    tp.appendChild(tr);
  });

  const tud = document.querySelector("#tblZoneDepot tbody");
  tud.innerHTML = "";
  Object.keys(state.config.zoneDepot).sort().forEach(zona => {
    const tr = document.createElement("tr");
    const options = state.config.depots.map(d => `<option value="${d.sigla}" ${d.sigla === state.config.zoneDepot[zona] ? "selected" : ""}>${d.sigla}</option>`).join("");
    tr.innerHTML = `<td>${zona}</td><td><select>${options}</select></td>`;
    tr.querySelector("select").addEventListener("change", (e) => {
      state.config.zoneDepot[zona] = e.target.value; saveConfig(); runClustering();
    });
    tud.appendChild(tr);
  });

  const tuv = document.querySelector("#tblZoneVehicle tbody");
  tuv.innerHTML = "";
  allKnownZones().forEach(zona => {
    const tr = document.createElement("tr");
    const current = state.config.zoneVehicle[zona] || "3/4";
    const options = state.config.vehicles.map(v => `<option value="${v.codigo}" ${v.codigo === current ? "selected" : ""}>${v.codigo}</option>`).join("");
    tr.innerHTML = `<td>${zona}</td><td><select>${options}</select></td>`;
    tr.querySelector("select").addEventListener("change", (e) => {
      state.config.zoneVehicle[zona] = e.target.value; saveConfig(); runClustering();
    });
    tuv.appendChild(tr);
  });

  const tut = document.querySelector("#tblZoneTransportadora tbody");
  tut.innerHTML = "";
  allKnownZones().forEach(zona => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${zona}</td><td><input value="${state.config.zoneTransportadora[zona] || ""}" placeholder="—" /></td>`;
    tr.querySelector("input").addEventListener("change", (e) => {
      const v = e.target.value.trim().toUpperCase();
      if (v) state.config.zoneTransportadora[zona] = v; else delete state.config.zoneTransportadora[zona];
      saveConfig(); renderAll();
    });
    tut.appendChild(tr);
  });

  const tms = document.querySelector("#tblZoneMaxStops tbody");
  tms.innerHTML = "";
  allKnownZones().forEach(zona => {
    const tr = document.createElement("tr");
    const current = state.config.zoneMaxStops[zona] || "";
    tr.innerHTML = `<td>${zona}</td><td><input type="number" min="1" placeholder="${state.config.maxStopsPerRoute || 10} (padrão)" value="${current}" /></td>`;
    tr.querySelector("input").addEventListener("change", (e) => {
      const v = parseInt(e.target.value, 10);
      if (v > 0) state.config.zoneMaxStops[zona] = v; else delete state.config.zoneMaxStops[zona];
      saveConfig(); runClustering();
    });
    tms.appendChild(tr);
  });

  const tzo = document.querySelector("#tblZoneOverride tbody");
  tzo.innerHTML = "";
  state.config.zoneOverrides.forEach((z, i) => {
    const tr = document.createElement("tr");
    const options = state.config.depots.map(d => `<option value="${d.sigla}" ${d.sigla === z.depot ? "selected" : ""}>${d.sigla}</option>`).join("");
    tr.innerHTML = `
      <td><input value="${z.zona}" data-k="zona" style="width:48px" /></td>
      <td><select>${options}</select></td>
      <td><span class="cfg-badge" title="${z.observacao || ""}">${z.observacao ? "confirmar" : ""}</span></td>
    `;
    tr.querySelector("input").addEventListener("change", (e) => { z.zona = e.target.value.toUpperCase(); saveConfig(); runClustering(); });
    tr.querySelector("select").addEventListener("change", (e) => { z.depot = e.target.value; z.observacao = ""; saveConfig(); renderConfigTab(); runClustering(); });
    tzo.appendChild(tr);
  });

  ["cfgLoadMin", "cfgPrepMin", "cfgSpeed", "cfgRoadFactor", "cfgStopMin", "cfgMaxStops", "cfgWindowTolerance"].forEach(id => {
    const el = document.getElementById(id);
    const map = { cfgLoadMin: "loadMin", cfgPrepMin: "prepMin", cfgSpeed: "speedKmh", cfgRoadFactor: "roadFactor", cfgStopMin: "stopMin", cfgMaxStops: "maxStopsPerRoute", cfgWindowTolerance: "windowToleranceMin" };
    el.value = state.config[map[id]];
    el.addEventListener("change", () => {
      state.config[map[id]] = parseFloat(el.value); saveConfig();
      if (id === "cfgMaxStops") runClustering();
      if (id === "cfgWindowTolerance") { computeUsage(); renderAll(); }
    });
  });
}

/* ---------------- Export ---------------- */
function buildTimeline(route) {
  const cfg = state.config;
  const base = new Date(2000, 0, 1, 0, 0, 0);
  const loadingStart = new Date(base);
  const shiftStart = new Date(base.getTime() + cfg.loadMin * 60000);
  const depotDepart = new Date(shiftStart.getTime() + cfg.prepMin * 60000);

  // Caminho real: usa os tempos/distâncias que o ORS/VROOM calculou pela malha viária.
  if ((route.engine === "ors" || route.engine === "tomtom") && route.stepData && route.stepData.length === route.stores.length) {
    const arrivals = route.stepData.map((step, i) => ({
      store: route.stores[i],
      dist: step.distFromPrevM / 1000,
      arrival: new Date(depotDepart.getTime() + step.arrivalSec * 1000),
    }));
    const depotReturn = new Date(depotDepart.getTime() + route.totalDurationSec * 1000);
    return {
      loadingStart, shiftStart, depotDepart, depotReturn, arrivals,
      totalDist: route.totalDistanceM / 1000,
      totalMin: route.totalDurationSec / 60,
    };
  }

  // Fallback: estimativa por linha reta × fator de rota.
  let cur = new Date(depotDepart);
  let curLat = route.depot.lat, curLng = route.depot.long;
  let totalDist = 0;
  const arrivals = [];

  route.stores.forEach(s => {
    const d = haversineKm(curLat, curLng, s.lat, s.lng) * cfg.roadFactor;
    totalDist += d;
    const travelMin = (d / cfg.speedKmh) * 60;
    cur = new Date(cur.getTime() + travelMin * 60000);
    arrivals.push({ store: s, dist: d, arrival: new Date(cur) });
    cur = new Date(cur.getTime() + cfg.stopMin * 60000);
    curLat = s.lat; curLng = s.lng;
  });

  const returnDist = haversineKm(curLat, curLng, route.depot.lat, route.depot.long) * cfg.roadFactor;
  const depotReturn = new Date(cur.getTime() + (returnDist / cfg.speedKmh) * 60 * 60000);
  totalDist += returnDist;

  return { loadingStart, shiftStart, depotDepart, depotReturn, arrivals, totalDist,
    totalMin: (depotReturn - depotDepart) / 60000 };
}

function fmtTime(d) {
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") + ":00";
}
function fmtMinAsHHMM(min) {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

function exportCsv() {
  if (!state.routes.length) return;

  const semNome = state.routes.filter(r => r.stores.length && !(r.code || "").trim());
  if (semNome.length) {
    toast(`Renomeie antes de exportar: rota(s) sem nome com carga (clique no nome da rota na lista).`, "danger");
    return;
  }

  // Divisão por câmara: quando foi a câmara INTEIRA que mudou de rota (isSplitExact), as linhas
  // reais do pedido já foram movidas junto (ver splitStoreCamera) — export sai certo. Quando foi
  // uma divisão PARCIAL (sobrou câmara na loja de origem), não tem como separar linha a linha
  // sem duplicar/perder pedido no CSV — trava só nesse caso.
  const temDivisaoAproximada = state.routes.some(r => r.stores.some(s => s.isSplitOf && s.isSplitExact === false));
  if (temDivisaoAproximada) {
    toast("Há loja(s) com divisão PARCIAL de câmara entre rotas — ainda não dá pra gerar o CSV certo nesse caso. Mova a câmara inteira (não uma fração dela), ou aguarde a próxima atualização.", "danger");
    return;
  }

  const header = buildExportHeader();
  const lines = [header.map(h => `"${h}"`).join(",")];

  state.routes.forEach((route, ri) => {
    const tl = buildTimeline(route);
    let pos = 0;
    tl.arrivals.forEach(({ store, dist, arrival }) => {
      store.rows.forEach(r => {
        pos++;
        const row = [
          store.custId, store.codigo, route.depot.sigla, r["CALL.ORDDETS3"] || "",
          route.code, r["CALL.TDATA05"] || "",
          fmtTime(tl.loadingStart), fmtTime(tl.shiftStart), fmtTime(tl.depotDepart), fmtTime(arrival), fmtTime(tl.depotReturn),
          ri + 1, pos, vehicleExportCode(route), dist.toFixed(2),
          fmtMinAsHHMM(tl.totalMin), tl.totalDist.toFixed(2),
        ];
        lines.push(row.map(v => `"${v}"`).join(","));
      });
    });
  });

  downloadCsv(lines);
  toast("Arquivo exportado. Pronto para devolver ao JDE.", "success");
}

// Formato composto observado no arquivo final do Paragon: "{TRANSPORTADORA}-{VEÍCULO}-GR" (ex.:
// "LOG-3/4-GR", "PRO-TRU-GR", "SGT-VUC-GR" — o sufixo "GR" aparece em toda linha, de todo
// depósito, num pedido real de exemplo comparado; o motivo exato não está confirmado, mas como é
// constante, replicá-lo deixa o CALL.DEPOTID... digo, o FN_JOHN_WB_MBBRAZILVEHICLE no formato que
// o JDE já espera. Só monta o composto quando a zona tem transportadora cadastrada — sem isso,
// cai no código de veículo simples de sempre, pra não inventar prefixo.
const TRANSPORTADORA_PREFIX = { PRODELOG: "PRO", LOGMAN: "LOG", SGT: "SGT" };
const VEHICLE_EXPORT_ABBR = { "3/4": "3/4", VUC: "VUC", TRUCK: "TRU", CARRETA: "CAR" };
function vehicleExportCode(route) {
  const transportadora = transportadoraForZone(route.zona);
  if (!transportadora) return route.vehicle.codigo;
  const prefix = TRANSPORTADORA_PREFIX[transportadora] || transportadora.slice(0, 3).toUpperCase();
  const abbr = VEHICLE_EXPORT_ABBR[route.vehicle.codigo] || route.vehicle.codigo;
  return `${prefix}-${abbr}-GR`;
}

function buildExportHeader() {
  return [
    "CALL.ID", "CALL.NAME", "CALL.DEPOTID", "CALL.ORDDETS3", "CALL.TDATA01", "CALL.TDATA05",
    "FN_JOHN_WB_MBBRAZILLOADINGSTART", "FN_JOHN_WB_MBBRAZILSHIFTSTART", "FN_JOHN_WB_MBBRAZILDEPOTDEPART",
    "FN_JOHN_WB_MBBRAZILCALLARRIVALTIME", "FN_JOHN_WB_MBBRAZILDEPOTRETURN",
    "CALL.ROUTENO", "CALL.ROUTEPOS", "FN_JOHN_WB_MBBRAZILVEHICLE", "CALL.TRVDISPRV",
    "FN_JOHN_WB_MBBROUTETIME", "FN_JOHN_WB_MBBROUTEDIST",
  ];
}

function downloadCsv(lines) {
  const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  a.href = url; a.download = `roteirizacao_${stamp}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ---------------- Wiring ---------------- */
function wireEvents() {
  document.getElementById("btnConfig").addEventListener("click", () => {
    renderConfigTab();
    document.getElementById("configModal").classList.add("show");
  });
  document.getElementById("configModalClose").addEventListener("click", () => {
    document.getElementById("configModal").classList.remove("show");
  });
  document.getElementById("configModal").addEventListener("click", (e) => {
    if (e.target.id === "configModal") document.getElementById("configModal").classList.remove("show");
  });

  document.getElementById("btnGerenciarRotas").addEventListener("click", () => {
    if (!state.routes.length) { toast("Importe um pedido e gere as rotas primeiro.", ""); return; }
    renderSwapModal();
    document.getElementById("swapModal").classList.add("show");
  });
  document.getElementById("swapModalClose").addEventListener("click", () => {
    document.getElementById("swapModal").classList.remove("show");
  });
  document.getElementById("swapModal").addEventListener("click", (e) => {
    if (e.target.id === "swapModal") document.getElementById("swapModal").classList.remove("show");
  });

  document.getElementById("btnNovaRota").addEventListener("click", () => {
    if (!state.stores.length) { toast("Importe um pedido primeiro.", ""); return; }
    const depot = state.config.depots[0];
    const vehicle = state.config.vehicles.find(v => v.codigo === "3/4") || state.config.vehicles[0];
    if (!depot || !vehicle) { toast("Cadastre ao menos um depósito e um veículo em Configurações.", "danger"); return; }
    state.routes.push({
      id: "r_manual_" + Date.now(), code: "", seq: null,
      depot, vehicle, zona: "", stores: [], engine: "manual", geometry: null, stepData: [],
    });
    computeUsage();
    renderAll();
    toast("Rota em branco criada — arraste lojas pra ela e clique no nome pra renomear.", "success");
  });

  const fileInput = document.getElementById("fileInput");
  const fileInputTop = document.getElementById("fileInputTop");
  const dropzone = document.getElementById("dropzone");

  fileInput.addEventListener("change", (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); });
  fileInputTop.addEventListener("change", (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); });
  document.getElementById("btnReimport").addEventListener("click", () => fileInputTop.click());

  const fileInputDetalhe = document.getElementById("fileInputDetalhe");
  fileInputDetalhe.addEventListener("change", (e) => { if (e.target.files[0]) handleDetalheFile(e.target.files[0]); });
  document.getElementById("btnImportarDetalhe").addEventListener("click", () => fileInputDetalhe.click());

  ["dragover", "dragenter"].forEach(evt => dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add("drag"); }));
  ["dragleave", "drop"].forEach(evt => dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove("drag"); }));
  dropzone.addEventListener("drop", (e) => { if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });

  document.getElementById("btnExport").addEventListener("click", exportCsv);
  document.getElementById("btnRecalcular").addEventListener("click", () => runClustering());
  document.getElementById("routeSearch").addEventListener("input", renderRouteList);

  document.getElementById("truckModalClose").addEventListener("click", closeTruckModal);
  document.getElementById("truckModal").addEventListener("click", (e) => {
    if (e.target.id === "truckModal") closeTruckModal();
  });
}

/* ---------------- Init ---------------- */
// wireEvents() e renderConfigTab() vêm ANTES do mapa de propósito: se o Leaflet ou os tiles do
// Mapbox falharem (CDN fora do ar, sem internet, bloqueio de rede corporativo), o resto do
// sistema — importar pedido, configurações, exportar — continua funcionando normalmente, só o
// mapa em si fica indisponível.
document.addEventListener("DOMContentLoaded", () => {
  renderConfigTab();
  wireEvents();
  try {
    initMap();
  } catch (err) {
    console.error("Falha ao iniciar o mapa:", err);
    toast("Não foi possível carregar o mapa (sem conexão ou CDN bloqueado) — o resto do sistema continua funcionando normalmente.", "danger");
  }
});
