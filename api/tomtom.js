// Função serverless (Vercel) — proxy para as APIs do TomTom (Matrix Routing v2 e Calculate Route).
// A chave fica aqui no servidor. Tem um valor padrão embutido (a pedido do usuário, pra já
// testar sem precisar configurar nada) — mas se a variável de ambiente TOMTOM_API_KEY existir
// no ambiente de hospedagem, ela tem prioridade. Troque/rotacione a chave quando quiser.

const EMBEDDED_TOMTOM_KEY = "ujtv2lt427F9TDOrKUQ2cEARa2AQ1y8m";
// Segunda chave fornecida — não usada por padrão, fica aqui como reserva caso a primeira
// estoure a cota ou seja revogada: u41UNSl5b7DnEzkd0mjvQ0SozWqJw3DC

// Troca a API key por "***" em qualquer URL antes de logar — a chave NUNCA deve aparecer nos
// logs do servidor (Vercel guarda log por tempo indeterminado e é acessível por mais gente que só
// quem administra a chave).
function maskKey(url) {
  return url.replace(/([?&]key=)[^&]+/i, "$1***");
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método não permitido. Use POST." });
    return;
  }

  const apiKey = process.env.TOMTOM_API_KEY || EMBEDDED_TOMTOM_KEY;
  const { op, payload } = req.body || {};

  try {
    let url, fetchOpts, pointCount;

    if (op === "matrix") {
      url = `https://api.tomtom.com/routing/matrix/2?key=${apiKey}`;
      fetchOpts = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      };
      pointCount = (payload?.origins?.length || 0);
    } else if (op === "route") {
      // payload.waypoints: string "lat,lon:lat,lon:..."
      // Parâmetros de veículo comercial (peso/altura/largura/comprimento) fazem a rota evitar via
      // com restrição de caminhão (viaduto baixo, ponte com limite de peso etc.) em vez de tratar
      // a entrega como se fosse um carro — só entram na URL quando o app manda (todo veículo hoje
      // é caminhão, então praticamente sempre entram).
      const params = new URLSearchParams({
        key: apiKey, routeType: "fastest", traffic: "true",
        travelMode: payload.travelMode || "car",
        routeRepresentation: "polyline",
      });
      if (payload.vehicleCommercial) params.set("vehicleCommercial", "true");
      if (payload.vehicleWeight) params.set("vehicleWeight", String(payload.vehicleWeight));
      if (payload.vehicleLength) params.set("vehicleLength", String(payload.vehicleLength));
      if (payload.vehicleWidth) params.set("vehicleWidth", String(payload.vehicleWidth));
      if (payload.vehicleHeight) params.set("vehicleHeight", String(payload.vehicleHeight));
      url = `https://api.tomtom.com/routing/1/calculateRoute/${payload.waypoints}/json?${params.toString()}`;
      fetchOpts = { method: "GET" };
      pointCount = (payload?.waypoints || "").split(":").length;
    } else {
      res.status(400).json({ error: "Parâmetro 'op' inválido. Use 'matrix' ou 'route'." });
      return;
    }

    const t0 = Date.now();
    console.log(`[api/tomtom] -> op=${op} pontos=${pointCount} url=${maskKey(url)}`);

    const ttRes = await fetch(url, fetchOpts);
    const text = await ttRes.text();
    const elapsedMs = Date.now() - t0;

    // Log de resultado: nunca inclui a chave (já mascarada acima) nem o corpo bruto da resposta
    // de sucesso (pode ter centenas de pontos de geometria) — só um resumo útil pra debug.
    if (ttRes.status >= 200 && ttRes.status < 300) {
      let geomPoints = null;
      if (op === "route") {
        try {
          const parsed = JSON.parse(text);
          geomPoints = (parsed.routes || []).reduce((acc, r) =>
            acc + (r.legs || []).reduce((a, l) => a + (l.points || []).length, 0), 0);
        } catch { /* resposta não-JSON — sem contagem de geometria */ }
      }
      console.log(`[api/tomtom] <- op=${op} HTTP ${ttRes.status} em ${elapsedMs}ms${geomPoints !== null ? ` geometria=${geomPoints}pts` : ""}`);
    } else {
      console.error(`[api/tomtom] <- op=${op} FALHA HTTP ${ttRes.status} em ${elapsedMs}ms — resposta TomTom: ${text.slice(0, 500)}`);
    }

    res.status(ttRes.status);
    res.setHeader("Content-Type", "application/json");
    res.send(text);
  } catch (err) {
    console.error(`[api/tomtom] ERRO ao contatar TomTom (op=${op}): ${err.message}`);
    res.status(502).json({ error: "Falha ao contatar o TomTom: " + err.message });
  }
};
