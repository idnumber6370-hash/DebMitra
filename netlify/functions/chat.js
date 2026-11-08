const BASE = "You are DebMitra, a friendly, warm and helpful AI assistant (mitra means friend). You were created by Deb, who built this app. If anyone asks who made you, say Deb made you. Do not mention Google, Gemini, Groq, Llama, NVIDIA or any other company or model name on your own. Only if a user directly and sincerely asks what AI technology powers you, answer honestly that you run on a third-party AI language model. Keep answers clear and reasonably concise. You can understand photos and PDFs that the user attaches. When you reply in Odia, write English or technical words (like IPL, mobile, app, match) in English letters, not in Odia script, so the voice can read them. Use simple formatting: short paragraphs, **bold** for key words, and - bullets for lists.";

const MODES = {
  friend: "Mode: friendly buddy. Be warm, casual and supportive.",
  tutor: "Mode: patient tutor (padhai ka teacher). Explain step by step in simple words with small examples, and end with one short question to check understanding.",
  coder: "Mode: coding helper. Give short, correct code inside code blocks, then a brief explanation. Ask for missing details only if really needed.",
  funny: "Mode: funny friend. Use light, playful humour and gentle jokes, but stay kind, never insulting, and still give correct answers.",
};
const LANGS = {
  auto: "Always reply in the same language and script the user writes in (Hindi, English, Hinglish or Odia).",
  hi: "Always reply in Hindi using Devanagari script.",
  en: "Always reply in simple English.",
  or: "Always reply in Odia (ଓଡ଼ିଆ) using Odia script. Keep sentences short and simple. Even if the user wrote in another language, reply in Odia.",
};

// ---- Rate limit: ek user (IP) ke liye 1 minute mein max 10 message ----
const LIMIT = 10, WINDOW = 60000;
const hits = new Map();
function limited(ip, rid) {
  if (!ip) return false;
  const now = Date.now();
  const a = (hits.get(ip) || []).filter((h) => now - h.t < WINDOW);
  if (rid && a.some((h) => h.rid === rid)) { hits.set(ip, a); return false; } // retry same message: dobara nahi ginte
  if (a.length >= LIMIT) { hits.set(ip, a); return true; }
  a.push({ t: now, rid });
  hits.set(ip, a);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1].t > WINDOW) hits.delete(k);
  return false;
}
const clientIp = (h = {}) =>
  h["x-nf-client-connection-ip"] || h["client-ip"] || (h["x-forwarded-for"] || "").split(",")[0].trim() || "";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Only POST allowed" });

  const groqKey = process.env.GROQ_API_KEY;
  const nvKey = process.env.NVIDIA_API_KEY;
  const orKey = process.env.OPENROUTER_API_KEY;
  const gemKey = process.env.GEMINI_API_KEY;
  if (!groqKey && !nvKey && !orKey && !gemKey && !process.env.CUSTOM_API_KEY) return json(500, { error: "DebMitra abhi set nahi hua hai." });

  let body;
  try { body = JSON.parse(event.body); } catch { return json(400, { error: "Bad request" }); }
  const { messages, image, doc, lang, mode, rid } = body || {};
  if (!Array.isArray(messages) || !messages.length) return json(400, { error: "Message khali hai" });

  if (limited(clientIp(event.headers), typeof rid === "string" ? rid.slice(0, 60) : "")) {
    return json(429, { error: "Bahut tez! 1 minute mein sirf 10 message bhej sakte ho. Thoda ruko aur phir bhejo. 🙂" });
  }

  const history = messages.slice(-20).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: String(m.content || "").slice(0, 4000),
  }));

  let system = BASE + "\n" + (MODES[mode] || MODES.friend) + "\n" + (LANGS[lang] || LANGS.auto);
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
    const timer = setTimeout(() => ctrl.abort(), Math.min(l, hasImage ? 8000 : 6000));
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
    const payload = { model, messages: msgs, temperature: 0.7, max_tokens: 1024 };
    const groq = url.includes("api.groq.com");
    if (groq && /gpt-oss/.test(model)) { payload.max_tokens = 2048; payload.reasoning_effort = "low"; }
    if (groq && /qwen/.test(model)) payload.reasoning_effort = "none";
    const headers = { Authorization: "Bearer " + key, ...extra };
    let res = await call(url, headers, payload);
    if (!res.ok && !res.skip && res.status === 400 && payload.reasoning_effort && /qwen/.test(model)) {
      delete payload.reasoning_effort; // is model ko ye setting pasand nahi, bina iske dobara
      res = await call(url, headers, payload);
    }
    if (res.ok) {
      let t = res.data?.choices?.[0]?.message?.content;
      if (t) t = t.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      if (t) return t;
    }
    if (!res.skip) {
      last = { status: res.status };
      console.log("fail:", model, res.status, String(res.data?.error?.message || "").slice(0, 140));
    }
    return null;
  };
  const gemModels = () => [...new Set([process.env.GEMINI_MODEL, "gemini-2.5-flash-lite", "gemini-3.1-flash-lite"].filter(Boolean))];

  // ----- Photo ke saath: Groq aur Gemini ek saath, jo pehle jawab de -----
  if (hasImage) {
    const prev = history.slice(0, -1);
    const lastMsg = history[history.length - 1];
    const jobs = [];
    if (groqKey) {
      const msgs = [
        { role: "system", content: system },
        ...prev,
        { role: "user", content: [{ type: "text", text: lastMsg.content }, { type: "image_url", image_url: { url: image } }] },
      ];
      jobs.push((async () => {
        for (const vModel of [...new Set([process.env.GROQ_VISION_MODEL, "qwen/qwen3.6-27b", "qwen/qwen3.8-27b"].filter(Boolean))]) {
          const t = await openai("https://api.groq.com/openai/v1/chat/completions", groqKey, vModel, msgs);
          if (t) return t;
        }
        return null;
      })());
    }
    const m = image.match(/^data:(image\/[a-zA-Z+.-]+);base64,(.*)$/);
    if (gemKey && m) {
      jobs.push((async () => {
        const contents = prev.map((x) => ({ role: x.role === "assistant" ? "model" : "user", parts: [{ text: x.content }] }));
        contents.push({ role: "user", parts: [{ text: lastMsg.content }, { inline_data: { mime_type: m[1], data: m[2] } }] });
        for (const model of gemModels()) {
          const res = await call(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { "x-goog-api-key": gemKey }, { systemInstruction: { parts: [{ text: system }] }, contents });
          if (res.ok) {
            const t = res.data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("");
            if (t) return t;
          }
          if (!res.skip) { last = { status: res.status }; console.log("fail:", model, res.status, String(res.data?.error?.message || "").slice(0, 140)); }
        }
        return null;
      })());
    }
    const t = await firstTruthy(jobs);
    if (t) return json(200, { reply: t });
    return json(503, { error: "DebMitra abhi photo nahi samajh paa raha, thodi der baad try karo." });
  }

  // ----- Sirf text -----
  const sysMsg = { role: "system", content: system };
  if (groqKey) {
    for (const model of [...new Set([process.env.GROQ_MODEL, "openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.6-27b"].filter(Boolean))]) {
      const t = await openai("https://api.groq.com/openai/v1/chat/completions", groqKey, model, [sysMsg, ...history]);
      if (t) return json(200, { reply: t });
    }
  }
  if (nvKey) {
    for (const model of [...new Set([process.env.NVIDIA_MODEL, "meta/llama-3.3-70b-instruct", "openai/gpt-oss-120b"].filter(Boolean))]) {
      const t = await openai("https://integrate.api.nvidia.com/v1/chat/completions", nvKey, model, [sysMsg, ...history]);
      if (t) return json(200, { reply: t });
    }
  }
  if (orKey) {
    const model = process.env.OPENROUTER_MODEL || "meta-llama/llama-3.3-70b-instruct:free";
    const t = await openai("https://openrouter.ai/api/v1/chat/completions", orKey, model, [sysMsg, ...history], { "X-Title": "DebMitra" });
    if (t) return json(200, { reply: t });
  }
  if (gemKey) {
    const contents = history.map((x) => ({ role: x.role === "assistant" ? "model" : "user", parts: [{ text: x.content }] }));
    for (const model of gemModels()) {
      const res = await call(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { "x-goog-api-key": gemKey }, { systemInstruction: { parts: [{ text: system }] }, contents });
      if (res.ok) {
        const t = res.data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("");
        if (t) return json(200, { reply: t });
      }
      if (!res.skip) last = { status: res.status };
    }
  }
  if (process.env.CUSTOM_API_URL && process.env.CUSTOM_API_KEY && process.env.CUSTOM_API_MODEL) {
    const t = await openai(process.env.CUSTOM_API_URL, process.env.CUSTOM_API_KEY, process.env.CUSTOM_API_MODEL, [sysMsg, ...history]);
    if (t) return json(200, { reply: t });
  }

  if (last.status === 429) return json(429, { error: "DebMitra ki aaj ki free limit khatam ho gayi, thodi der baad try karo." });
  return json(503, { error: "DebMitra abhi thoda busy hai, 1-2 minute baad dobara try karo." });
};

const firstTruthy = (ps) => new Promise((res) => {
  let n = ps.length;
  if (!n) return res(null);
  ps.forEach((p) => p.then((v) => { if (v) res(v); else if (--n === 0) res(null); }).catch(() => { if (--n === 0) res(null); }));
});

const json = (statusCode, obj) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(obj),
});
