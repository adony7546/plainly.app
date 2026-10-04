// Vercel serverless function. Keeps your AI key private on the server.
// Uses OpenRouter, which has free models (IDs ending in ":free").
// Required environment variables (set in Vercel > Settings > Environment Variables):
//   OPENROUTER_API_KEY - your key from https://openrouter.ai/keys
//   ACCESS_CODE        - a password you choose, so only people you trust can use the tool
// Optional:
//   OPENROUTER_MODEL   - defaults to "openrouter/free" (OpenRouter picks a currently free model).
//                        To pin one, copy a model ID ending in ":free" from https://openrouter.ai/models

const SYSTEM_PROMPT = `You are an analytics explainer for small online store owners who are not data analysts. You receive a store's numbers (already calculated) and write a plain-English weekly report, then answer follow-up questions.

RULES
- Use only the numbers provided. Never invent numbers, causes, campaigns, or events.
- If something you need is missing, say what is missing instead of guessing.
- Write like you are talking to a busy shop owner. No jargon.
- Never state causes as facts. Use words like "may", "could", and "worth checking". Make clear these are leads to investigate, not confirmed causes.
- Each metric comes with a note on whether the change is statistically meaningful or could be normal ups and downs. Respect it: if a change is flagged as possibly just noise, say so and do not treat it as a problem.
- If the store has low volume, say the data is thin and conclusions are weak.
- Point to the device where the change is biggest, based only on the data.
- For follow-up questions, answer only from the data you were given. If the question needs information you cannot see (ad spend, site changes, competitor activity), say so plainly and suggest what the owner could check.
- Do not give legal, tax, or financial advice.

REPORT FORMAT (for the first answer)
**Headline:** one sentence with the most important change and a priority (High, Medium, or Low).
**What happened:** 2-3 sentences with the key numbers.
**Where it happened:** which device drove the change (if device data exists).
**What to investigate:** 2-3 specific things, written as possibilities.
**What to do first:** up to 3 actions in priority order.
**Confidence:** one sentence on how reliable this is.
Keep the report under 250 words.`;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  const accessCode = process.env.ACCESS_CODE;
  if (!apiKey || !accessCode) {
    return res.status(500).json({ error: 'Server is not set up yet: add OPENROUTER_API_KEY and ACCESS_CODE in Vercel settings.' });
  }

  if ((req.headers['x-access-code'] || '') !== accessCode) {
    return res.status(401).json({ error: 'Wrong access code.' });
  }

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body;
  const messages = body && body.messages;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 14) {
    return res.status(400).json({ error: 'Invalid request.' });
  }

  const chat = [{ role: 'system', content: SYSTEM_PROMPT }];
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.text !== 'string' || m.text.length > 6000) {
      return res.status(400).json({ error: 'Invalid message.' });
    }
    chat.push({ role: m.role, content: m.text });
  }

  const model = process.env.OPENROUTER_MODEL || 'openrouter/free';

  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'X-Title': 'Plainly'
      },
      body: JSON.stringify({
        model,
        messages: chat,
        temperature: 0.4,
        max_tokens: 1500
      })
    });

    if (r.status === 429) {
      return res.status(429).json({ error: 'The free AI limit was reached. Wait a minute and try again.' });
    }
    if (r.status === 401) {
      return res.status(502).json({ error: 'OpenRouter rejected the API key. Check OPENROUTER_API_KEY in Vercel.' });
    }
    if (!r.ok) {
      const t = await r.text();
      console.error('OpenRouter error', r.status, t);
      return res.status(502).json({ error: 'The AI service returned an error (' + r.status + '). The free model may be busy or removed; try again, or set a different OPENROUTER_MODEL.' });
    }

    const data = await r.json();
    const reply = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!reply || !String(reply).trim()) {
      return res.status(502).json({ error: 'The AI gave an empty answer. Please try again.' });
    }
    return res.status(200).json({ reply: String(reply).trim() });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong reaching the AI. Please try again.' });
  }
};

function safeParse(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}
