import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import twilio from 'twilio';
import fs from 'fs';
import path from 'path';

const { twiml } = twilio;
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const PORT = process.env.PORT || 10000; // Render assigns its own PORT
const SERPAPI_KEY = process.env.SERPAPI_KEY || '';

function ensurePrefix(text) {
  let t = String(text || '').trim();
  t = t.replace(/^Domnule\s+Dan\s*[—-]\s*/i, '');
  return `Domnule Dan — ${t}`.trim();
}

const SYSTEM_PROMPT = `Ești „Jarvis — Asistentul Casa Pleni”, un asistent expert, concis și pragmatic în ROMÂNĂ.
- Adresează-te mereu cu „Domnule Dan — ” la începutul răspunsului.
- Claritate > lungime. Listează pași scurți când e util.
- Dacă poți obține date live prin instrumentele disponibile (web, vreme, Wikipedia), fă-o și răspunde direct.
- Când folosești web: caută, citește 1–3 surse relevante, sintetizează concis și oferă la final domeniile surselor.
- Nu inventa cifre exacte fără sursă.`;

const CONV_DIR = path.resolve('./conversations');
if (!fs.existsSync(CONV_DIR)) fs.mkdirSync(CONV_DIR);
const safeName = (s) => String(s||'').replace(/[^a-zA-Z0-9+\-]/g,'_');
const histFile = (from) => path.join(CONV_DIR, safeName(from)+'.json');
const loadHist = (from) => { try { const f=histFile(from); return fs.existsSync(f)? JSON.parse(fs.readFileSync(f,'utf8')):[] } catch { return [] } };
const saveHist = (from, arr) => { try { fs.writeFileSync(histFile(from), JSON.stringify(arr.slice(-20)),'utf8') } catch {} };

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function webSearchSerpapi(q) {
  if (!SERPAPI_KEY) throw new Error('Lipsește SERPAPI_KEY în .env');
  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(q)}&hl=ro&gl=ro&num=5&api_key=${SERPAPI_KEY}`;
  const { data } = await axios.get(url, { timeout: 20000 });
  const out = [];
  const org = data.organic_results || [];
  for (const r of org.slice(0,5)) if (r.link && r.title) out.push({ title:r.title, link:r.link });
  if (out.length < 2 && Array.isArray(data.news_results)) {
    for (const n of data.news_results.slice(0,3)) if (n.link && n.title) out.push({ title:n.title, link:n.link });
  }
  return out;
}

async function fetchAndSummarize(urls, userQ, oaiKey) {
  const chunks = [];
  for (const u of urls) {
    try {
      const { data } = await axios.get(u.link, { timeout: 20000, headers: { 'User-Agent': 'jarvis-web/1.0' } });
      const text = stripHtml(data).slice(0, 12000);
      chunks.push({ url:u.link, domain:(new URL(u.link)).hostname, text });
    } catch {}
  }
  if (!chunks.length) return null;
  const sourcesText = chunks.map((c,i)=>`[#${i+1} ${c.domain}] ${c.text}`).join('\n\n');
  const prompt = `Întrebare: ${userQ}\nAm extras conținut de pe web (max 12k caractere pe sursă). Fă un răspuns concis, cu pași dacă e cazul, și listează la final sursele folosite sub forma: [1) domeniu1, 2) domeniu2].`;

  const resp = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
      { role: 'user', content: sourcesText }
    ],
    max_tokens: 700,
    temperature: 0.2
  }, { headers: { Authorization: `Bearer ${process.env.OPENAI_KEY}` } });
  const answer = resp?.data?.choices?.[0]?.message?.content || 'Nu am reușit să sintetizez.';
  const used = chunks.map(c=>c.domain).filter((d,i,a)=>a.indexOf(d)===i).slice(0,3);
  return { answer, sources: used };
}

async function geocode(q) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
    const { data } = await axios.get(url, { headers: { 'User-Agent': 'jarvis-weblive/1.0' } });
    if (Array.isArray(data) && data.length) {
      const { lat, lon, display_name } = data[0];
      return { lat:+lat, lon:+lon, name:display_name };
    }
  } catch {}
  return null;
}
async function currentWeatherFor(placeQuery) {
  const fallback = { lat:44.414, lon:25.936, name:'Domnești, Ilfov' };
  const loc = await geocode(placeQuery).catch(()=>null) || fallback;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m&forecast_days=1&timezone=auto`;
  const { data } = await axios.get(url);
  const c = data?.current || {};
  return { place: loc.name||placeQuery, t:c.temperature_2m, feels:c.apparent_temperature, wind:c.wind_speed_10m, unit:data?.current_units?.temperature_2m||'°C' };
}
async function tomorrowForecast(placeQuery) {
  const fallback = { lat:44.414, lon:25.936, name:'Domnești, Ilfov' };
  const loc = await geocode(placeQuery).catch(()=>null) || fallback;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max&forecast_days=2&timezone=auto`;
  const { data } = await axios.get(url);
  const d = data?.daily || {};
  return {
    place: loc.name||placeQuery,
    tmin: Array.isArray(d.temperature_2m_min) ? Math.round(d.temperature_2m_min[1]) : null,
    tmax: Array.isArray(d.temperature_2m_max) ? Math.round(d.temperature_2m_max[1]) : null,
    rain: Array.isArray(d.precipitation_probability_max) ? d.precipitation_probability_max[1] : null,
    wind: Array.isArray(d.wind_speed_10m_max) ? Math.round(d.wind_speed_10m_max[1]) : null
  };
}
async function wikiSummary(title) {
  const tryOne = async (base)=>{
    const url = `${base}/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    try { const { data } = await axios.get(url, { headers:{'User-Agent':'jarvis-weblive/1.0'} }); return data; } catch { return null; }
  };
  return await (tryOne('https://ro.wikipedia.org') || tryOne('https://en.wikipedia.org'));
}

const autoWebRegex = new RegExp([
  'azi','m[aâ]ine','ieri','acum','live','ultimele','recent',
  'program','orar','or[aă]','bilete','rezultate?','scor','meciuri?','etap[aă]','liga','superliga','cup[aă]',
  'pre[tț]','c[âa]t( costa| e )',
  'stiri','știri','nout[aă]ti','breaking','anun[țt]',
  'c[aă]nd','unde','care','ce (film|album|model|telefon)',
].join('|'), 'i');

app.get('/', (_req,res)=>res.send('Jarvis WhatsApp webhook is running.'));

app.post('/webhook', async (req, res) => {
  const from = req.body.From || 'unknown';
  const text = String(req.body.Body || '').trim();
  const resp = new twiml.MessagingResponse();
  const send = (m)=>{ resp.message(m); return res.type('text/xml').send(resp.toString()); };

  if (!text) return send("Domnule Dan — scrie-mi întrebarea ta. Spune 'help' pentru opțiuni.");
  const lower = text.toLowerCase();

  if (lower === 'help') return send("Domnule Dan — poți întreba direct; folosesc web automat când e nevoie. Comenzi: ping, vreme <loc>, wiki <subiect>, summarize.");
  if (lower === 'ping') return send("Domnule Dan — pong 🟢");

  const isWeather = /(vreme|c[aă]te grade|temperatur|cum e afara|prognoz|m[aâ]ine vreme)/i.test(lower);
  if (isWeather) {
    let place = 'Domnești, Ilfov';
    const m = text.match(/\b(?:in|la)\s+([^?.,!]+)/i);
    if (m && m[1]) place = m[1].trim();
    try {
      if (/m[aâ]ine|maine/i.test(lower)) {
        const f = await tomorrowForecast(place);
        let parts = [];
        if (f.tmin!=null && f.tmax!=null) parts.push(`${f.tmin}–${f.tmax}°C`);
        if (f.rain!=null) parts.push(`ploi ${f.rain}%`);
        if (f.wind!=null) parts.push(`vânt ${f.wind} km/h`);
        return send(ensurePrefix(`mâine în ${f.place}: ${parts.join(', ') || 'date indisponibile'}.`));
      } else {
        const w = await currentWeatherFor(place);
        const t = Math.round(w.t);
        const feels = (w.feels!=null)? Math.round(w.feels): null;
        const wind = (w.wind!=null)? Math.round(w.wind): null;
        const line = `${t}${w.unit} acum în ${w.place}${feels!=null?`, se simt ca ${feels}${w.unit}`:''}${wind!=null?`, vânt ${wind} km/h`:''}.`;
        return send(ensurePrefix(line));
      }
    } catch {
      return send(ensurePrefix("nu am reușit să iau datele meteo acum."));
    }
  }

  if (lower.startsWith('wiki ') || /populat/i.test(lower)) {
    const subject = lower.startsWith('wiki ') ? text.slice(5) : text.replace(/ce|c[aă]te|care|este|popul(a|ă)tie|are|din/gi,'').trim() || 'Domnești, Ilfov';
    try {
      const data = await wikiSummary(subject);
      if (data?.extract) {
        const extract = data.extract.length>350 ? data.extract.slice(0,340)+'…' : data.extract;
        return send(ensurePrefix(extract));
      }
    } catch {}
    return send(ensurePrefix("nu am găsit rapid informația pe Wikipedia."));
  }

  if (autoWebRegex.test(lower)) {
    if (!SERPAPI_KEY) return send(ensurePrefix("pentru căutări web am nevoie de SERPAPI_KEY în .env (serpapi.com)."));
    try {
      const results = await webSearchSerpapi(text);
      if (!results.length) return send(ensurePrefix("nu am găsit rezultate utile în căutare."));
      const top = results.slice(0,3);
      const sum = await fetchAndSummarize(top, text, process.env.OPENAI_KEY);
      if (!sum) return send(ensurePrefix("nu am putut prelua conținutul paginilor."));
      const src = Array.from(new Set(sum.sources)).slice(0,3).map((d,i)=>`${i+1}) ${d}`).join(', ');
      return send(ensurePrefix(`${sum.answer}\nSurse: ${src}`));
    } catch {
      return send(ensurePrefix("căutarea web a eșuat. Încearcă să reformulezi."));
    }
  }

  const hist = loadHist(from);
  hist.push({ role:'user', content:text });
  const messages = [{ role:'system', content:SYSTEM_PROMPT }, ...hist.slice(-10)];
  try {
    const oai = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages, max_tokens:700, temperature:0.2
    }, { headers:{ Authorization: `Bearer ${process.env.OPENAI_KEY}` } });
    const assistantText = oai?.data?.choices?.[0]?.message?.content || "momentan nu am un răspuns.";
    hist.push({ role:'assistant', content: assistantText });
    saveHist(from, hist);
    return send(ensurePrefix(assistantText));
  } catch {
    return send(ensurePrefix("am întâmpinat o eroare. Reîncearcă te rog."));
  }
});

app.listen(PORT, ()=>console.log(`Jarvis server listening on port ${PORT}`));
