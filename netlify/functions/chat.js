const SYSTEM = "You are DebMitra, a friendly, warm and helpful AI assistant (mitra means friend). Always reply in the same language the user writes in (Hindi, English or Hinglish). Keep answers clear and concise.";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Only POST allowed" });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return json(500, { error: "GEMINI_API_KEY set nahi hai." });

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
    "gemini-3.8-flash",
  ].filter(Boolean))];

  let last = { status: 503, error: "busy" };
  for (const model of models) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM }] }, contents }),
        }
      );
      const data = await r.json();
      if (r.ok) {
        const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("");
        if (text) return json(200, { reply: text });
      }
      last = { status: r.status, error: data.error?.message || "Gemini error" };
    } catch (e) {
      last = { status: 500, error: "Server error" };
    }
  }
  const limit = last.status === 429;
  return json(limit ? 429 : 503, { error: limit ? "Aaj ki free limit khatam ho gayi, thodi der baad try karo." : "Gemini abhi bahut busy hai, 1-2 minute baad dobara try karo." });
};

const json = (statusCode, obj) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(obj),
});
