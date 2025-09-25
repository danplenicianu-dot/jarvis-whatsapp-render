// server.js — Jarvis Bilingual + Real Weather (Open‑Meteo) for Render/Twilio
import express from "express";
import bodyParser from "body-parser";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const OPENAI_KEY = process.env.OPENAI_KEY;

// --- Language detection (ro/en) ---
function detectLang(text="") {
  const t = (text||"").toLowerCase();
  const hasRO = /(vreme|câte|grade|mâine|azi|prognoz|meci|liga|știri|stiri|că|î|ă|â|ț|ş|ţ)/.test(t);
  const hasEN = /(weather|forecast|tomorrow|today|what|when|where|how|price|match|league|news)/.test(t);
  if (/[ăâîșţțş]/.test(t) || (hasRO && !hasEN)) return "ro";
  if (hasEN && !hasRO) return "en";
  // default: English
  return "en";
}

// --- Tiny helpers ---
function xml(msg) { return `<Response><Message>${msg}</Message></Response>`; }
function esc(s=""){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

// --- Geocode via Nominatim (no key) ---
async function geocode(place) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(place)}`;
  const r = await fetch(url, { headers: { "User-Agent": "jarvis-weather/1.0" } });
  if (!r.ok) return null;
  const arr = await r.json();
  if (!Array.isArray(arr) || !arr.length) return null;
  const { lat, lon, display_name } = arr[0];
  return { lat: parseFloat(lat), lon: parseFloat(lon), name: display_name };
}

// --- Current weather via Open‑Meteo ---
async function currentWeather(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,apparent_temperature,wind_speed_10m&timezone=auto`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const data = await r.json();
  return {
    t: data?.current?.temperature_2m,
    feels: data?.current?.apparent_temperature,
    wind: data?.current?.wind_speed_10m,
    unit: data?.current_units?.temperature_2m || "°C"
  };
}

// --- Tomorrow forecast via Open‑Meteo ---
async function tomorrowForecast(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_min,temperature_2m_max,precipitation_probability_max,wind_speed_10m_max&forecast_days=2&timezone=auto`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const data = await r.json();
  const d = data?.daily || {};
  return {
    tmin: Array.isArray(d.temperature_2m_min) ? Math.round(d.temperature_2m_min[1]) : null,
    tmax: Array.isArray(d.temperature_2m_max) ? Math.round(d.temperature_2m_max[1]) : null,
    rain: Array.isArray(d.precipitation_probability_max) ? d.precipitation_probability_max[1] : null,
    wind: Array.isArray(d.wind_speed_10m_max) ? Math.round(d.wind_speed_10m_max[1]) : null
  };
}

// --- Decide if question is weather ---
function isWeatherQuestion(q) {
  const t = q.toLowerCase();
  return /(vreme|grade|temperatur|prognoz|mâine|maine|weather|forecast|degrees|temperature|tomorrow)/.test(t);
}

// --- OpenAI chat for non-weather cases (still bilingual) ---
async function chatAnswer(msg, lang) {
  const system = lang === "en"
    ? "You are Jarvis. Detect the user's language and reply ONLY in ENGLISH. Be concise and pragmatic."
    : "Ești Jarvis. Detectează limba utilizatorului și răspunde DOAR în ROMÂNĂ. Fii concis și pragmatic.";
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: msg }
      ]
    })
  });
  const data = await r.json();
  return data?.choices?.[0]?.message?.content || (lang === "en" ? "No answer for now." : "Momentan nu am un răspuns.");
}

// --- Webhook ---
app.post("/webhook", async (req, res) => {
  const msg = (req.body.Body || "").trim();
  const lang = detectLang(msg);

  // Weather path
  if (isWeatherQuestion(msg)) {
    try {
      // Try to find place after "in/la ..."
      const m = msg.match(/\b(?:in|la)\s+([^?!.]+)/i);
      const place = m?.[1]?.trim() || (lang === "en" ? "Bucharest, Romania" : "București, România");
      const loc = await geocode(place);
      if (!loc) {
        const txt = lang === "en"
          ? "Couldn't find that place. Try something like: weather in Bucharest."
          : "Nu am găsit locul. Încearcă de ex.: vreme în București.";
        res.set("Content-Type","text/xml"); return res.send(xml(esc(txt)));
      }

      const askTomorrow = /tomorrow|mâine|maine/i.test(msg);
      if (askTomorrow) {
        const f = await tomorrowForecast(loc.lat, loc.lon);
        if (!f) throw new Error("forecast fail");
        const line = lang === "en"
          ? `Tomorrow in ${loc.name}: ${f.tmin ?? "?"}–${f.tmax ?? "?"}°C, rain ${f.rain ?? "?"}%, wind ${f.wind ?? "?"} km/h.`
          : `Mâine în ${loc.name}: ${f.tmin ?? "?"}–${f.tmax ?? "?"}°C, ploi ${f.rain ?? "?"}%, vânt ${f.wind ?? "?"} km/h.`;
        res.set("Content-Type","text/xml"); return res.send(xml(esc(line)));
      } else {
        const c = await currentWeather(loc.lat, loc.lon);
        if (!c) throw new Error("current fail");
        const t = Math.round(c.t);
        const feels = c.feels != null ? Math.round(c.feels) : null;
        const wind = c.wind != null ? Math.round(c.wind) : null;
        const line = lang === "en"
          ? `${t}${c.unit} now in ${loc.name}${feels != null ? `, feels like ${feels}${c.unit}` : ""}${wind != null ? `, wind ${wind} km/h`:""}.`
          : `${t}${c.unit} acum în ${loc.name}${feels != null ? `, se simt ca ${feels}${c.unit}` : ""}${wind != null ? `, vânt ${wind} km/h`:""}.`;
        res.set("Content-Type","text/xml"); return res.send(xml(esc(line)));
      }
    } catch (e) {
      console.error(e);
      const fb = lang === "en"
        ? "Sorry, I couldn't fetch weather right now. Try again shortly."
        : "Îmi pare rău, nu am putut prelua meteo acum. Încearcă din nou în scurt timp.";
      res.set("Content-Type","text/xml"); return res.send(xml(esc(fb)));
    }
  }

  // Default: model answer
  try {
    const ans = await chatAnswer(msg, lang);
    res.set("Content-Type","text/xml"); return res.send(xml(esc(ans)));
  } catch (e) {
    console.error(e);
    const fb = lang === "en"
      ? "Temporary error. Please try again."
      : "Eroare temporară. Te rog reîncearcă.";
    res.set("Content-Type","text/xml"); return res.send(xml(esc(fb)));
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Jarvis bilingual + weather running on ${PORT}`));
