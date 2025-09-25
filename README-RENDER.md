# Jarvis WhatsApp — Render (cloud) — Auto Web + Weather + Wikipedia

## Deploy (scurt)
1) Fă un repo nou pe GitHub și încarcă fișierele din acest folder (`server.js`, `package.json`).
2) Render.com → New → Web Service → Connect repo.
3) Settings în Render:
   - Environment: Node
   - Build Command: *(gol)* (Render va rula `npm install` automat)
   - Start Command: `npm start`
   - Plan: Free
4) Environment variables în Render:
   - `OPENAI_KEY` = `sk-...`
   - `OPENAI_MODEL` = `gpt-4o-mini`
   - `SERPAPI_KEY` = `...` (serpapi.com)
5) După deploy, ia URL-ul public `https://<app>.onrender.com` și pune în Twilio Sandbox → "When a message comes in": `https://<app>.onrender.com/webhook`.

Test: în WhatsApp către +1 415 523 8886 scrie: `ce meciuri sunt mâine în liga 1`.
