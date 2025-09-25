// server.js — Jarvis Bilingual (strict RO/EN) with language-aware fallbacks
import express from "express";
import bodyParser from "body-parser";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const OPENAI_KEY = process.env.OPENAI_KEY;

// Lightweight language detector (ro/en) based on common words & diacritics
function detectLang(text = "") {
  const t = (text || "").toLowerCase();
  const ro = /(și|pentru|cu|ce|când|unde|cum|este|sunt|azi|mâine|maine|preț|pret|meci|liga|vreme|știri|stiri|în|î)/;
  const en = /(the|and|for|with|what|when|where|how|is|are|today|tomorrow|price|match|league|weather|news|in)/;
  if (/[ăâîșţțş]/.test(t)) return "ro";
  if (ro.test(t) && !en.test(t)) return "ro";
  if (en.test(t) && !ro.test(t)) return "en";
  // default to English if ambiguous
  return "en";
}

// Build a strict system prompt for target language
function systemPrompt(lang) {
  if (lang === "en") {
    return `You are Jarvis. STRICT RULE: Detect user language and reply ONLY in ENGLISH.
- Never mix languages, never use Romanian words.
- Be concise and pragmatic. Provide sources if you used the public web (as domains).`;
  }
  return `Ești Jarvis. REGULĂ STRICTĂ: Detectează limba utilizatorului și răspunde DOAR în ROMÂNĂ.
- Nu amesteca limbile, nu folosi cuvinte în engleză.
- Fii concis și pragmatic. Dacă folosești web-ul public, oferă la final domeniile sursă.`;
}

// Webhook pentru Twilio (WhatsApp)
app.post("/webhook", async (req, res) => {
  const msg = (req.body.Body || "").trim();
  const from = req.body.From || "";

  if (!msg) {
    res.set("Content-Type", "text/xml");
    return res.send(`<Response><Message>Scrie-mi întrebarea ta.</Message></Response>`);
  }

  const lang = detectLang(msg);

  try {
    const oaiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        messages: [
          { role: "system", content: systemPrompt(lang) },
          { role: "user", content: msg }
        ]
      })
    });

    const data = await oaiResp.json();
    const answer = data?.choices?.[0]?.message?.content || (lang === "en" ? "I don't have an answer right now." : "Momentan nu am un răspuns.");

    res.set("Content-Type", "text/xml");
    return res.send(`<Response><Message>${answer}</Message></Response>`);
  } catch (e) {
    console.error(e);
    const fb = lang === "en"
      ? "Sorry, I hit a temporary error. Please try again in a moment."
      : "Îmi pare rău, am întâmpinat o eroare temporară. Încearcă din nou peste puțin.";
    res.set("Content-Type", "text/xml");
    return res.send(`<Response><Message>${fb}</Message></Response>`);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Jarvis bilingual (strict) running on ${PORT}`));
