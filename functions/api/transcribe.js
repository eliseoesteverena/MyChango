// functions/api/transcribe.js
// POST { audio: <base64>, mime_type: "audio/webm;codecs=opus", loc: { country } }
//  →  { text: "Azúcar 1 kilo 1250", _debug: { step, ms, ... } }
//
// Usa Gemini 3.5 Transcribe en modo SMART (limpia muletillas, resuelve
// autocorrecciones y normaliza números/monedas). El parseo del precio
// se hace en el cliente (regex); acá solo se transcribe.

const GEMINI_TRANSCRIBE_MODEL = "gemini-3.5-transcribe";
// Verificá el nombre vigente en https://ai.google.dev/gemini-api/docs/models

const MAX_AUDIO_B64_CHARS = 4_000_000; // ~3 MB; un dictado de 15 s pesa ~50 KB

// Formatos que acepta Gemini 3.5 Transcribe
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
    const languageCodes = LANGUAGE_BY_COUNTRY[country] ?? [];
    const vocab = BRAND_VOCAB[country] || [];

    const callGemini = (audioTranscriptionConfig) =>
      fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TRANSCRIBE_MODEL}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ inlineData: { mimeType, data: audio } }] }],
            generationConfig: { audioTranscriptionConfig },
          }),
        }
      );

    const t0 = Date.now();
    let usedVocab = vocab.length > 0;
    let res;
    try {
      const cfg = { mode: "SMART", languageCodes, ...(usedVocab ? { customVocabulary: vocab } : {}) };
      res = await callGemini(cfg);
      // Si el vocabulario no es compatible con el modo, reintenta sin él.
      if (res.status === 400 && usedVocab) {
        usedVocab = false;
        res = await callGemini({ mode: "SMART", languageCodes });
      }
    } catch (e) {
      return json(env, { error: "No se pudo conectar con Gemini API", step: "gemini_fetch", detail: e.message }, 502);
    }

    if (!res.ok) {
      let geminiError = "";
      try { geminiError = await res.text(); } catch {}
      return json(env, {
        error: `Gemini rechazó la solicitud (HTTP ${res.status})`,
        step: "gemini_response",
        gemini_status: res.status,
        gemini_body: geminiError.slice(0, 500),
      }, 502);
    }

    let data;
    try {
      data = await res.json();
    } catch (e) {
      return json(env, { error: "Respuesta de Gemini no es JSON válido", step: "gemini_json_parse", detail: e.message }, 502);
    }

    const parts = data?.candidates?.[0]?.content?.parts || [];
    const text = parts.map((p) => p.text || "").join(" ").replace(/\s+/g, " ").trim();

    return json(env, {
      text,
      _debug: { step: "ok", ms: Date.now() - t0, model: GEMINI_TRANSCRIBE_MODEL, mime: mimeType, vocab: usedVocab },
    });
  } catch (error) {
    console.error("Error inesperado en /api/transcribe:", error);
    return json(env, { error: "Error interno inesperado", step: "uncaught", detail: error.message }, 500);
  }
}
