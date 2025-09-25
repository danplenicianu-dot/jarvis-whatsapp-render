// server.js — Jarvis FULL (RO/EN + Weather + Wikipedia + Web Search) using native fetch
import express from "express";
import bodyParser from "body-parser";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const OPENAI_KEY = process.env.OPENAI_KEY;
const SERPAPI_KEY = process.env.SERPAPI_KEY || ""; // optional but recommended

// ---------- Utilities ----------
function detectLang(text="") {
  const t = (text||"").toLowerCase();
  const ro = /(vreme|câte|grade|mâine|azi|prognoz|meci|liga|știri|stiri|că|î|ă|â|ț|ş|ţ|popula|wiki|ce|când|unde|cum)/;
  const en = /(weather|forecast|tomorrow|today|what|when|where|how|price|match|league|news|population|wiki)/;
  if (/[ăâîșţțş]/.test(t) || (ro.test(t) && !en.test(t))) return "ro";
  if (en.test(t) && !ro.test(t)) return "en";
  return "en";
}

function esc(s=""){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function xml(msg){ return `<Response><Message>${msg}</Message></Response>`; }
function stripHtml(html) {
  return String(html||"")
    .replace(/<script[\s\S]*?<\/script>/gi," ")
    .replace(/<style[\s\S]*?<\/style>/gi," ")
    .replace(/<[^>]+>/g," ")
    .replace(/\s+/g," ").trim();
}

// ---------- Weather (Open‑Meteo) ----------
async function geocode(place) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(place)}`;
  const r = await fetch(url, { headers: { "User-Agent": "jarvis-full/1.0" } });
  if (!r.ok) return null;
  const arr = await r.json();
  if (!Array.isArray(arr) || !arr.length) return null;
  const { lat, lon, display_name } = arr[0];
  return { lat: parseFloat(lat), lon: parseFloat(lon), name: display_name };
}

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

function isWeatherQuestion(q) {
  const t = q.toLowerCase();
  return /(vreme|grade|temperatur|prognoz|mâine|maine|weather|forecast|degrees|temperature|tomorrow)/.test(t);
}

// ---------- Wikipedia ----------
async function wikiSummary(title, lang="ro") {
  async function call(base) {
    const url = `${base}/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    try {
      const r = await fetch(url, { headers: {"User-Agent":"jarvis-full/1.0"} });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }
  return await (call("https://ro.wikipedia.org") || call("https://en.wikipedia.org"));
}

// ---------- Web search (SerpAPI) + summarize via OpenAI ----------
async function serpSearch(q, lang="ro") {
  if (!SERPAPI_KEY) return [];
  const hl = lang === "en" ? "en" : "ro";
  const gl = "ro";
  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(q)}&hl=${hl}&gl=${gl}&num=5&api_key=${SERPAPI_KEY}`;
  const r = await fetch(url);
  if (!r.ok) return [];
  const data = await r.json();
  const out = [];
  const org = data.organic_results || [];
  for (const rr of org.slice(0,5)) if (rr.link && rr.title) out.push({ title: rr.title, link: rr.link });
  if (out.length < 2 && Array.isArray(data.news_results)) {
    for (const n of data.news_results.slice(0,3)) if (n.link && n.title) out.push({ title: n.title, link: n.link });
  }
  return out;
}

async function summarizePages(items, question, lang="ro") {
  const chunks = [];
  for (const it of items.slice(0,3)) {
    try {
      const r = await fetch(it.link, { headers: { "User-Agent": "jarvis-full/1.0" } });
      if (!r.ok) continue;
      const html = await r.text();
      const text = stripHtml(html).slice(0, 12000);
      const domain = new URL(it.link).hostname;
      chunks.push({ domain, text });
    } catch {}
  }
  if (!chunks.length) return null;

  const sourcesText = chunks.map((c,i)=>`[#${i+1} ${c.domain}] ${c.text}`).join("\n\n");
  const sys = lang === "en"
    ? "You are Jarvis. Summarize briefly and precisely in ENGLISH. At the end list the domains as Sources: 1) a.com, 2) b.com"
    : "Ești Jarvis. Rezumă scurt și precis în ROMÂNĂ. La final listează domeniile ca Surse: 1) a.com, 2) b.com";

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: `Întrebare/Question: ${question}` },
        { role: "user", content: sourcesText }
      ]
    })
  });
  const data = await resp.json();
  const answer = data?.choices?.[0]?.message?.content;
  const used = [...new Set(chunks.map(c=>c.domain))].slice(0,3);
  return answer || (lang === "en" ? `No synthesis. Sources: ${used.join(", ")}` : `Nu am putut sintetiza. Surse: ${used.join(", ")}`);
}

// ---------- Default chat (no web) ----------
async function chatAnswer(msg, lang) {
  const sys = lang === "en"
    ? "You are Jarvis. Reply ONLY in ENGLISH. Be concise and pragmatic."
    : "Ești Jarvis. Răspunde DOAR în ROMÂNĂ. Fii concis și pragmatic.";
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: msg }
      ]
    })
  });
  const data = await r.json();
  return data?.choices?.[0]?.message?.content || (lang === "en" ? "No answer for now." : "Momentan nu am un răspuns.");
}

// ---------- Router ----------
app.post("/webhook", async (req, res) => {
  const msg = (req.body.Body || "").trim();
  const lang = detectLang(msg);
  try {
    // Weather path
    if (isWeatherQuestion(msg)) {
      const m = msg.match(/\b(?:in|la)\s+([^?!.]+)/i);
      const place = m?.[1]?.trim() || (lang === "en" ? "Bucharest, Romania" : "București, România");
      const loc = await geocode(place);
      if (!loc) {
        const text = lang === "en" ? "Couldn't find that place. Try: weather in Bucharest." : "Nu am găsit locul. Încearcă: vreme în București.";
        res.set("Content-Type","text/xml"); return res.send(xml(esc(text)));
      }
      if (/tomorrow|mâine|maine/i.test(msg)) {
        const f = await tomorrowForecast(loc.lat, loc.lon);
        if (!f) throw new Error("forecast");
        const line = lang === "en"
          ? `Tomorrow in ${loc.name}: ${f.tmin ?? "?"}–${f.tmax ?? "?"}°C, rain ${f.rain ?? "?"}%, wind ${f.wind ?? "?"} km/h.`
          : `Mâine în ${loc.name}: ${f.tmin ?? "?"}–${f.tmax ?? "?"}°C, ploi ${f.rain ?? "?"}%, vânt ${f.wind ?? "?"} km/h.`;
        res.set("Content-Type","text/xml"); return res.send(xml(esc(line)));
      } else {
        const c = await currentWeather(loc.lat, loc.lon);
        if (!c) throw new Error("current");
        const t = Math.round(c.t);
        const feels = c.feels != null ? Math.round(c.feels) : null;
        const wind = c.wind != null ? Math.round(c.wind) : null;
        const line = lang === "en"
          ? `${t}${c.unit} now in ${loc.name}${feels != null ? `, feels like ${feels}${c.unit}` : ""}${wind != null ? `, wind ${wind} km/h`:""}.`
          : `${t}${c.unit} acum în ${loc.name}${feels != null ? `, se simt ca ${feels}${c.unit}` : ""}${wind != null ? `, vânt ${wind} km/h`:""}.`;
        res.set("Content-Type","text/xml"); return res.send(xml(esc(line)));
      }
    }

    // Wiki quick path
    if (/^(wiki\s+|popula(ție|tie)|population)/i.test(msg)) {
      const subject = msg.replace(/^wiki\s+/i,'').trim() || (lang==='en'?'Bucharest':'București');
      const info = await wikiSummary(subject, lang);
      const extract = info?.extract ? (info.extract.length>350 ? info.extract.slice(0,340)+'…' : info.extract) : null;
      const out = extract || (lang==='en' ? "No quick info found on Wikipedia." : "Nu am găsit rapid informația pe Wikipedia.");
      res.set("Content-Type","text/xml"); return res.send(xml(esc(out)));
    }

    // Web search path (live queries)
    if (/(meci|liga|scor|program|orar|știri|stiri|today|tomorrow|news|score|matches|fixtures|schedule|price|when)/i.test(msg)) {
      const results = await serpSearch(msg, lang);
      if (results.length) {
        const synth = await summarizePages(results, msg, lang);
        res.set("Content-Type","text/xml"); return res.send(xml(esc(synth)));
      }
      // If SerpAPI missing, fall back to model answer
    }

    // Default chat
    const ans = await chatAnswer(msg, lang);
    res.set("Content-Type","text/xml"); return res.send(xml(esc(ans)));
  } catch (e) {
    console.error(e);
    const fb = lang === "en" ? "Temporary error. Please try again." : "Eroare temporară. Reîncearcă, te rog.";
    res.set("Content-Type","text/xml"); return res.send(xml(esc(fb)));
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Jarvis FULL running on ${PORT}`));
