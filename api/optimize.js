// Função serverless (Vercel) — proxy para o OpenRouteService Optimization API.
// A chave fica só aqui no servidor, nunca no navegador.
//
// EMBEDDED_ORS_KEY: cole aqui uma chave válida do OpenRouteService (openrouteservice.org/dev)
// se quiser deixar embutida direto no código, no mesmo padrão do api/tomtom.js. A variável de
// ambiente ORS_API_KEY, se existir na hospedagem, tem prioridade sobre o valor embutido.
const EMBEDDED_ORS_KEY = ""; // ainda vazio — a chave recebida era de outro serviço (ver README)

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método não permitido. Use POST." });
    return;
  }

  const apiKey = process.env.ORS_API_KEY || EMBEDDED_ORS_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: "Nenhuma chave do OpenRouteService configurada (nem embutida, nem em ORS_API_KEY).",
    });
    return;
  }

  try {
    const orsRes = await fetch("https://api.openrouteservice.org/optimization", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": apiKey,
      },
      body: JSON.stringify(req.body),
    });

    const text = await orsRes.text();
    res.status(orsRes.status);
    res.setHeader("Content-Type", "application/json");
    res.send(text);
  } catch (err) {
    res.status(502).json({ error: "Falha ao contatar o OpenRouteService: " + err.message });
  }
};
