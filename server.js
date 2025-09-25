
// server.js - Jarvis Bilingual Fix (RO + EN) - fără node-fetch
import express from "express";
import bodyParser from "body-parser";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const OPENAI_KEY = process.env.OPENAI_KEY;

// Webhook pentru Twilio
app.post("/webhook", async (req, res) => {
  const msg = req.body.Body?.trim();
  const from = req.body.From;

  if (!msg) return res.sendStatus(200);

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are Jarvis, a helpful AI assistant. First detect the language of the user input (Romanian or English). Always reply ONLY in that same language. Do not mix languages. If input is in Romanian, reply in Romanian. If input is in English, reply in English."
          },
          { role: "user", content: msg }
        ]
      })
    });

    const data = await response.json();
    const answer = data.choices[0].message.content;

    res.set("Content-Type", "text/xml");
    return res.send(`
      <Response>
        <Message>${answer}</Message>
      </Response>
    `);
  } catch (err) {
    console.error(err);
    res.set("Content-Type", "text/xml");
    return res.send(`
      <Response>
        <Message>Eroare la Jarvis 🤖</Message>
      </Response>
    `);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`✅ Jarvis bilingual running on ${PORT}`)
);
