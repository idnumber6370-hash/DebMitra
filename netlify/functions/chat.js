const SYSTEM = "You are DebMitra, a friendly, warm and helpful AI assistant (mitra means friend). You were created by Deb, who built this app. If anyone asks who made you, say Deb made you. Do not mention Google, Gemini, Groq, Llama or any other company or model name on your own. Only if a user directly and sincerely asks what AI technology powers you, answer honestly that you run on a third-party AI language model. Always reply in the same language the user writes in (Hindi, English or Hinglish). Keep answers clear and concise. You can understand photos and PDFs that the user attaches.";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Only POST allowed" });

  const groqKey = process.env.GROQ_API_KEY;
  const orKey = process.env.OPENROUTER_API_KEY;
  const gemKey = process.env.GEMINI_API_KEY;
  if (!groqKey && !orKey && !gemKey && !process.env.CUSTOM_API_KEY) return json(500, { error: "DebMitra abhi set nahi hua hai." });

  let body;
  try { body = JSON.parse(event.body); } catch { return json(400, { error: "Bad request" }); }
  const { messages, image, doc } = body || {};
  if (!Array.isArray(messages) || !messages.length) return json(400, { error: "Message khali hai" });

  const history = messages.slice(-20).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: String(m.content || "").slice(0, 4000),
  }));

  let system = SYSTEM;
  if (doc && doc.text) {
    system += `\n\nThe user attached a document named "${String(doc.name || "document").slice(0, 100)}". Use it to answer. Document text:\n"""\n${String(doc.text).slice(0, 9000)}\n"""`;
  }

  const hasImage = typeof image === "string" && image.startsWith("data:image/") && image.length < 3500000;
  const start = Date.now();
  const left = () => 8500 - (Date.now() - start);
  let last = { status: 503 };

  async function call(url, headers, payload) {
    const l = left();
    if (l < 1500) return { skip: true };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.min(l, 6000));
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(payload), signal: ctrl.signal });
      const data = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, data };
    } catch (e) {
      return { ok: false, status: 503 };
    } finally {
      clearTimeout(timer);
    }
  }

  const openai = async (url, key, model, msgs, extra = {}) => {
    const res = await call(url, { Authorization: "Bearer " + key, ...extra }, { model, messages: msgs, temperature: 0.7, max_tokens: 1024 });
    if (res.ok) {
      const t = res.data?.choices?.[0]?.message?.content;
      if (t) return t;
    }
    if (!res.skip) last = { status: res.status };
    return null;
  };

  // ----- Photo ke saath -----
  if (hasImage) {
    const prev = history.slice(0, -1);
    const lastMsg = history[history.length - 1];
    if (groqKey) {
      const vModel = process.env.GROQ_VISION_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";
      const msgs = [
        { role: "system", content: system },
        ...prev,
        { role: "user", content: [{ type: "text", text: lastMsg.content }, { type: "image_url", image_url: { url: image } }] },
      ];
      const t = await openai("https://api.groq.com/openai/v1/chat/completions", groqKey, vModel, msgs);
      if (t) return json(200, { reply: t });
    }
    if (gemKey) {
      const m = image.match(/^data:(image\/[a-zA-Z+.-]+);base64,(.*)$/);
      if (m) {
        const contents = prev.map((x) => ({ role: x.role === "assistant" ? "model" : "user", parts: [{ text: x.content }] }));
        contents.push({ role: "user", parts: [{ text: lastMsg.content }, { inline_data: { mime_type: m[1], data: m[2] } }] });
        for (const model of [...new Set([process.env.GEMINI_MODEL, "gemini-2.5-flash-lite", "gemini-3.1-flash-lite"].filter(Boolean))]) {
          const res = await call(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { "x-goog-api-key": gemKey }, { systemInstruction: { parts: [{ text: system }] }, contents });
          if (res.ok) {
            const t = res.data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("");
            if (t) return json(200, { reply: t });
          }
          if (!res.skip) last = { status: res.status };
        }
      }
    }
    return json(503, { error: "DebMitra abhi photo nahi samajh paa raha, thodi der baad try karo." });
  }

  // ----- Sirf text -----
  // Custom (dost wali) API: sirf text ke liye, kabhi photo/PDF nahi bhejta
  const customOk = process.env.CUSTOM_API_URL && process.env.CUSTOM_API_KEY && process.env.CUSTOM_API_MODEL && !doc;
  const tryCustom = async () => {
    if (!customOk) return null;
    const t = await openai(process.env.CUSTOM_API_URL, process.env.CUSTOM_API_KEY, process.env.CUSTOM_API_MODEL, [{ role: "system", content: system }, ...history]);
    if (t) console.log("custom provider used");
    return t;
  };
  if (process.env.CUSTOM_FIRST === "1") {
    const t = await tryCustom();
    if (t) return json(200, { reply: t });
  }
  if (groqKey) {
    for (const model of ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"]) {
      const t = await openai("https://api.groq.com/openai/v1/chat/completions", groqKey, model, [{ role: "system", content: system }, ...history]);
      if (t) return json(200, { reply: t });
    }
  }
  if (orKey) {
    const model = process.env.OPENROUTER_MODEL || "meta-llama/llama-3.3-70b-instruct:free";
    const t = await openai("https://openrouter.ai/api/v1/chat/completions", orKey, model, [{ role: "system", content: system }, ...history], { "X-Title": "DebMitra" });
    if (t) return json(200, { reply: t });
  }
  if (gemKey) {
    const contents = history.map((x) => ({ role: x.role === "assistant" ? "model" : "user", parts: [{ text: x.content }] }));
    for (const model of [...new Set([process.env.GEMINI_MODEL, "gemini-2.5-flash-lite", "gemini-3.1-flash-lite"].filter(Boolean))]) {
      const res = await call(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { "x-goog-api-key": gemKey }, { systemInstruction: { parts: [{ text: system }] }, contents });
      if (res.ok) {
        const t = res.data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("");
        if (t) return json(200, { reply: t });
      }
      if (!res.skip) last = { status: res.status };
    }
  }

  if (process.env.CUSTOM_FIRST !== "1") {
    const t = await tryCustom();
    if (t) return json(200, { reply: t });
  }

  if (last.status === 429) return json(429, { error: "DebMitra ki aaj ki free limit khatam ho gayi, thodi der baad try karo." });
  return json(503, { error: "DebMitra abhi thoda busy hai, 1-2 minute baad dobara try karo." });
};

const json = (statusCode, obj) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(obj),
});
