const SYSTEM = "You are DebMitra, a friendly, warm and helpful AI assistant (mitra means friend). You were created by Deb, who built this app. If anyone asks who made you, say Deb made you. Do not mention Google or Gemini on your own. Only if a user directly and sincerely asks what AI technology powers you, answer honestly that you run on a Google AI model. Always reply in the same language the user writes in (Hindi, English or Hinglish). Keep answers clear and concise.";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Only POST allowed" });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return json(500, { error: "DebMitra abhi set nahi hua hai." });

  let messages;
  try { messages = JSON.parse(event.body).messages; } catch { return json(400, { error: "Bad request" }); }
  if (!Array.isArray(messages) || !messages.length) return json(400, { error: "Message khali hai" });

  const contents = messages.slice(-20).map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: String(m.content || "").slice(0, 4000) }],
  }));

  const models = [...new Set([
    process.env.GEMINI_MODEL,
    "gemini-2.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-2.5-flash",
  ].filter(Boolean))];

  const start = Date.now();
  let last = { status: 503 };
  for (const model of models) {
    const left = 8500 - (Date.now() - start);
    if (left < 1500) break;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.min(left, 5000));
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM }] }, contents }),
          signal: ctrl.signal,
        }
      );
      const data = await r.json();
      if (r.ok) {
        const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("");
        if (text) return json(200, { reply: text });
      }
      last = { status: r.status };
    } catch (e) {
      last = { status: 503 };
    } finally {
      clearTimeout(timer);
    }
  }
  if (last.status === 429) return json(429, { error: "DebMitra ki aaj ki free limit khatam ho gayi, thodi der baad try karo." });
  return json(503, { error: "DebMitra abhi thoda busy hai, 1-2 minute baad dobara try karo." });
};

const json = (statusCode, obj) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(obj),
});
