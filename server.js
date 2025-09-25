import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// Detectează limba (RO / EN)
function detectLang(text) {
  if (/[ăâîșț]/i.test(text) || /ce|câte|meciuri|vremea|populația/i.test(text)) return "ro";
  if (/[a-z]/i.test(text) && /what|who|when|weather|population|matches/i.test(text)) return "en";
  return "ro";
}

// Helper - formatează răspunsul
function formatResponse(lang, msg) {
  return lang === "en" ? `Jarvis — ${msg}` : `Domnule Dan — ${msg}`;
}

// Endpoint WhatsApp Webhook
app.post("/webhook", async (req, res) => {
  try {
    const incoming = req.body.Body?.trim() || "";
    const lang = detectLang(incoming);
    let reply = "";

    // Weather
    if (/vreme|grade|temperatura/i.test(incoming) || /weather/i.test(incoming)) {
      const city = incoming.match(/București|Bucharest/i) ? "Bucharest" : "Domnești,RO";
      const url = `https://api.open-meteo.com/v1/forecast?latitude=44.43&longitude=26.1&hourly=temperature_2m&current_weather=true`;
      const r = await fetch(url);
      const data = await r.json();
      if (data?.current_weather) {
        const t = data.current_weather.temperature;
        reply =
          lang === "en"
            ? `The current temperature in ${city} is ${t}°C.`
            : `În prezent, temperatura în ${city} este ${t}°C.`;
      } else {
        reply =
          lang === "en"
            ? "I could not fetch the weather right now."
            : "Nu am putut obține datele meteo acum.";
      }
    }

    // Wiki
    else if (/wiki|populatie|population/i.test(incoming)) {
      const query = incoming.replace(/wiki|populatie|population/gi, "").trim() || "România";
      const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`;
      const r = await fetch(url);
      const data = await r.json();
      reply = data.extract
        ? data.extract
        : lang === "en"
        ? "No information found on Wikipedia."
        : "Nu am găsit informații pe Wikipedia.";
    }

    // Web general
    else {
      const serpApiKey = process.env.SERPAPI_KEY;
      if (serpApiKey) {
        const q = encodeURIComponent(incoming);
        const url = `https://serpapi.com/search.json?q=${q}&hl=${lang}&api_key=${serpApiKey}`;
        const r = await fetch(url);
        const data = await r.json();
        reply =
          data?.organic_results?.[0]?.snippet ||
          (lang === "en"
            ? "I couldn't find relevant info."
            : "Nu am găsit informații relevante.");
      } else {
        reply =
          lang === "en"
            ? "No web search key configured."
            : "Cheia de căutare web nu este configurată.";
      }
    }

    res.json({ reply: formatResponse(lang, reply) });
  } catch (e) {
    console.error(e);
    res.json({ reply: "❌ Eroare pe server." });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Jarvis FULL running on ${PORT}`);
});
