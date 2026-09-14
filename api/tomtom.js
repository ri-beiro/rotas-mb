// Função serverless (Vercel) — proxy para as APIs do TomTom (Matrix Routing v2 e Calculate Route).
// A chave fica aqui no servidor. Tem um valor padrão embutido (a pedido do usuário, pra já
// testar sem precisar configurar nada) — mas se a variável de ambiente TOMTOM_API_KEY existir
// no ambiente de hospedagem, ela tem prioridade. Troque/rotacione a chave quando quiser.

const EMBEDDED_TOMTOM_KEY = "ujtv2lt427F9TDOrKUQ2cEARa2AQ1y8m";
// Segunda chave fornecida — não usada por padrão, fica aqui como reserva caso a primeira
// estoure a cota ou seja revogada: u41UNSl5b7DnEzkd0mjvQ0SozWqJw3DC

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método não permitido. Use POST." });
    return;
  }

  const apiKey = process.env.TOMTOM_API_KEY || EMBEDDED_TOMTOM_KEY;
  const { op, payload } = req.body || {};

  try {
    let url, fetchOpts;

    if (op === "matrix") {
      url = `https://api.tomtom.com/routing/matrix/2?key=${apiKey}`;
      fetchOpts = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      };
    } else if (op === "route") {
      // payload.waypoints: string "lat,lon:lat,lon:..."
      // Parâmetros de veículo comercial (peso/altura/largura/comprimento) fazem a rota evitar via
      // com restrição de caminhão (viaduto baixo, ponte com limite de peso etc.) em vez de tratar
      // a entrega como se fosse um carro — só entram na URL quando o app manda (todo veículo hoje
      // é caminhão, então praticamente sempre entram).
      const params = new URLSearchParams({
        key: apiKey, routeType: "fastest", traffic: "true",
        travelMode: payload.travelMode || "car",
      });
      if (payload.vehicleCommercial) params.set("vehicleCommercial", "true");
      if (payload.vehicleWeight) params.set("vehicleWeight", String(payload.vehicleWeight));
      if (payload.vehicleLength) params.set("vehicleLength", String(payload.vehicleLength));
      if (payload.vehicleWidth) params.set("vehicleWidth", String(payload.vehicleWidth));
      if (payload.vehicleHeight) params.set("vehicleHeight", String(payload.vehicleHeight));
      url = `https://api.tomtom.com/routing/1/calculateRoute/${payload.waypoints}/json?${params.toString()}`;
      fetchOpts = { method: "GET" };
    } else {
      res.status(400).json({ error: "Parâmetro 'op' inválido. Use 'matrix' ou 'route'." });
      return;
    }

    const ttRes = await fetch(url, fetchOpts);
    const text = await ttRes.text();
    res.status(ttRes.status);
    res.setHeader("Content-Type", "application/json");
    res.send(text);
  } catch (err) {
    res.status(502).json({ error: "Falha ao contatar o TomTom: " + err.message });
  }
};
