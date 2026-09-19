// functions/api/transcribe.js
// POST { audio: <base64>, mime_type: "audio/wav", loc: { country } }
//  →  { text: "Azúcar 1 kilo 1250", _debug: { step, ms, model, fallback_used, primary, fallback } }
//
// 1) Gemini 3.5 Transcribe en modo SMART (limpia muletillas, normaliza números/monedas).
// 2) Si devuelve texto vacío o falla, reintenta con Flash-Lite (audio + prompt de transcripción).
//    Motivo: se reportó que gemini-3.5-transcribe puede responder HTTP 200 con salida vacía
//    (foro de Google AI, agosto 2026). Con Flash-Lite ese mismo audio se transcribe bien.
// El parseo del precio se hace en el cliente (regex); acá solo se transcribe.
//
// Variables de entorno:
//   GEMINI_API_KEY      (obligatoria)
//   TRANSCRIBE_PRIMARY  "flash-lite" para saltear Transcribe y ir directo a Flash-Lite
//                       (ahorra ~1,5 s por dictado si Transcribe sigue devolviendo vacío)
//   ALLOWED_ORIGIN      (opcional) ej. https://mychango.pages.dev

const PRIMARY_MODEL = "gemini-3.5-transcribe";
const FALLBACK_MODEL = "gemini-3.5-flash-lite";
// Verificá los nombres vigentes en https://ai.google.dev/gemini-api/docs/models

const MAX_AUDIO_B64_CHARS = 4_000_000; // ~3 MB; un dictado de 15 s en WAV 16 kHz mono pesa ~480 KB

// Formatos que aceptan los modelos de audio de Gemini
const SUPPORTED_MIME = new Set([
  "audio/wav", "audio/mp3", "audio/aiff", "audio/aac", "audio/ogg", "audio/flac",
  "audio/mpeg", "audio/m4a", "audio/l16", "audio/opus", "audio/alaw", "audio/mulaw", "audio/webm",
]);

// Idioma por país. [] = detección automática.
const LANGUAGE_BY_COUNTRY = {
  AR: ["es-419"], MX: ["es-419"], CO: ["es-419"], CL: ["es-419"], PE: ["es-419"],
  UY: ["es-419"], PY: ["es-419"], BO: ["es-419"], VE: ["es-419"], EC: ["es-419"],
  BR: ["pt-BR"], ES: [], US: [],
};
const LANGUAGE_NAME_BY_COUNTRY = { BR: "portugués (Brasil)", US: "inglés o español", ES: "español (España)" };

// Marcas frecuentes: sesgan el reconocimiento hacia nombres propios.
// (Google recomienda hasta ~100 términos y evitar palabras comunes.)
const BRAND_VOCAB = {
  AR: [
    "Arcor", "La Serenísima", "Ledesma", "Marolio", "Cocinero", "Natura", "Molinos", "Knorr",
    "Terrabusi", "Bagley", "Milka", "Coca-Cola", "Sprite", "Fanta", "Quilmes", "Brahma",
    "Matarazzo", "Lucchetti", "Cañuelas", "Taragüí", "Playadito", "Cachamai", "Amanda",
    "La Virginia", "Hellmann's", "Danone", "Ser", "SanCor", "Verónica", "Manaos", "Cunnington",
    "Paso de los Toros", "Villavicencio", "Levité", "Skip", "Ala", "Drive", "Ariel", "Vivere",
    "Sedal", "Pantene", "Dove", "Rexona", "Colgate", "Elvive", "Pampers", "Huggies", "Nesquik",
    "Oreo", "Pepitos", "Toddy", "Cabrales", "Mendicrim", "Georgalos", "Felfort",
  ],
};

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function json(env, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}

function normalizeMime(mime) {
  const base = String(mime || "").split(";")[0].trim().toLowerCase();
  if (base === "audio/mp4" || base === "audio/x-m4a") return "audio/m4a"; // Safari/iOS
  if (base === "audio/x-wav" || base === "audio/wave") return "audio/wav";
  return SUPPORTED_MIME.has(base) ? base : null;
}

// Llamada genérica a generateContent. Nunca lanza: devuelve { ok, data } o { ok:false, status, kind, detail }.
async function callGemini(model, apiKey, body) {
  let res;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, status: 0, kind: "network", detail: e.message };
  }
  if (!res.ok) {
    let detail = "";
    try { detail = await res.text(); } catch {}
    return { ok: false, status: res.status, kind: "http", detail: detail.slice(0, 500) };
  }
  try {
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, status: 200, kind: "json", detail: e.message };
  }
}

// El texto puede venir en parts[].text o (según la API) en parts[].audioTranscription.text
function readTranscript(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts
    .map((p) => p?.text || p?.audioTranscription?.text || p?.audio_transcription?.text || "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

// Resumen para diagnosticar respuestas vacías (¿entró el audio? ¿cortó el modelo?)
function summarize(data) {
  const c = data?.candidates?.[0];
  return {
    finish_reason: c?.finishReason ?? null,
    parts: (c?.content?.parts || []).length,
    prompt_tokens: data?.usageMetadata?.promptTokenCount ?? null,
    output_tokens: data?.usageMetadata?.candidatesTokenCount ?? 0,
    block_reason: data?.promptFeedback?.blockReason ?? null,
  };
}

function failure(r) {
  return { error: `HTTP ${r.status || "—"} (${r.kind})`, detail: r.detail };
}

async function transcribePrimary(apiKey, audio, mimeType, country) {
  const t0 = Date.now();
  const languageCodes = LANGUAGE_BY_COUNTRY[country] ?? [];
  const vocab = BRAND_VOCAB[country] || [];
  const call = (audioTranscriptionConfig) =>
    callGemini(PRIMARY_MODEL, apiKey, {
      contents: [{ role: "user", parts: [{ inlineData: { mimeType, data: audio } }] }],
      generationConfig: { audioTranscriptionConfig },
    });

  let usedVocab = vocab.length > 0;
  let r = await call({ mode: "SMART", languageCodes, ...(usedVocab ? { customVocabulary: vocab } : {}) });
  // Si el vocabulario no es compatible con el modo, reintenta sin él.
  if (!r.ok && r.status === 400 && usedVocab) {
    usedVocab = false;
    r = await call({ mode: "SMART", languageCodes });
  }
  const info = { model: PRIMARY_MODEL, ms: Date.now() - t0, vocab: usedVocab };
  if (!r.ok) return { text: "", info: { ...info, ...failure(r) }, failed: r };
  return { text: readTranscript(r.data), info: { ...info, ...summarize(r.data) } };
}

async function transcribeFallback(apiKey, audio, mimeType, country) {
  const t0 = Date.now();
  const language = LANGUAGE_NAME_BY_COUNTRY[country] || "español";
  const prompt =
    `Transcribí este audio literalmente, en ${language}. Es un dictado corto: el nombre de un producto ` +
    `de supermercado y su precio. Escribí los números con dígitos (por ejemplo 1250, no "mil doscientos ` +
    `cincuenta"). Respondé SOLO con el texto transcripto, sin comillas ni comentarios. ` +
    `Si no se escucha ninguna voz, respondé exactamente: [sin voz]`;
  const r = await callGemini(FALLBACK_MODEL, apiKey, {
    contents: [{ role: "user", parts: [{ inlineData: { mimeType, data: audio } }, { text: prompt }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 256 },
  });
  const info = { model: FALLBACK_MODEL, ms: Date.now() - t0 };
  if (!r.ok) return { text: "", info: { ...info, ...failure(r) }, failed: r };
  let text = readTranscript(r.data).replace(/^["“«]+|["”»]+$/g, "").trim();
  if (/^\[?\s*sin voz\s*\]?\.?$/i.test(text)) text = "";
  return { text, info: { ...info, ...summarize(r.data) } };
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(env) });
  }
  if (request.method !== "POST") {
    return json(env, { error: "Método no permitido" }, 405);
  }

  // Opcional: definí ALLOWED_ORIGIN (ej. https://mychango.pages.dev) para que
  // solo tu sitio pueda usar este endpoint desde un navegador.
  const origin = request.headers.get("Origin");
  if (env.ALLOWED_ORIGIN && origin && origin !== env.ALLOWED_ORIGIN) {
    return json(env, { error: "Origen no permitido", step: "origin_check" }, 403);
  }

  try {
    const GEMINI_API_KEY = env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      return json(env, { error: "API Key no configurada en el servidor", step: "env_check" }, 500);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json(env, { error: "Body inválido — no es JSON", step: "body_parse", detail: e.message }, 400);
    }

    const { audio, mime_type, loc } = body || {};
    if (!audio || typeof audio !== "string") {
      return json(env, { error: "Falta el campo 'audio' (base64)", step: "input_validation" }, 400);
    }
    if (audio.length > MAX_AUDIO_B64_CHARS) {
      return json(env, { error: "Audio demasiado grande", step: "input_validation", size_chars: audio.length }, 413);
    }
    const mimeType = normalizeMime(mime_type);
    if (!mimeType) {
      return json(env, { error: `Formato de audio no soportado: ${mime_type || "?"}`, step: "input_validation" }, 415);
    }
    const country = loc?.country || "AR";

    const t0 = Date.now();
    const debug = { step: "ok", mime: mimeType, fallback_used: false };
    let text = "";
    let modelUsed = null;
    let lastFailure = null;

    // 1) Gemini 3.5 Transcribe (salvo que TRANSCRIBE_PRIMARY=flash-lite)
    if (env.TRANSCRIBE_PRIMARY !== "flash-lite") {
      const p = await transcribePrimary(GEMINI_API_KEY, audio, mimeType, country);
      debug.primary = p.info;
      text = p.text;
      if (text) modelUsed = PRIMARY_MODEL;
      if (p.failed) lastFailure = p.failed;
    }

    // 2) Fallback: Flash-Lite (audio + prompt de transcripción)
    if (!text) {
      const f = await transcribeFallback(GEMINI_API_KEY, audio, mimeType, country);
      debug.fallback = f.info;
      debug.fallback_used = env.TRANSCRIBE_PRIMARY !== "flash-lite";
      if (f.failed) {
        lastFailure = f.failed;
      } else {
        lastFailure = null;
        text = f.text;
        modelUsed = FALLBACK_MODEL;
      }
    }

    debug.ms = Date.now() - t0;
    debug.model = modelUsed;

    if (lastFailure) {
      return json(env, {
        error: `Gemini rechazó la solicitud (${lastFailure.status ? "HTTP " + lastFailure.status : lastFailure.kind})`,
        step: "gemini_response",
        gemini_status: lastFailure.status,
        gemini_body: lastFailure.detail,
        _debug: debug,
      }, 502);
    }

    return json(env, { text, _debug: debug });
  } catch (error) {
    console.error("Error inesperado en /api/transcribe:", error);
    return json(env, { error: "Error interno inesperado", step: "uncaught", detail: error.message }, 500);
  }
}
