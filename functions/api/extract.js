// functions/api/extract.js

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function onRequest(context) {

  // Preflight CORS
  if (context.request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Solo POST
  if (context.request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Método no permitido" }), {
      status: 405,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS }
    });
  }

  try {
    // Secret desde Cloudflare
    const GROQ_API_KEY = context.env.GROQ_API_KEY;
    if (!GROQ_API_KEY) {
      return new Response(JSON.stringify({
        error: "API Key no configurada en el servidor",
        step: "env_check"
      }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS }
      });
    }

    // Parsear body
    let body;
    try {
      body = await context.request.json();
    } catch (e) {
      return new Response(JSON.stringify({
        error: "Body inválido — no es JSON",
        step: "body_parse",
        detail: e.message
      }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS }
      });
    }

    const { base64, loc } = body;

    if (!base64) {
      return new Response(JSON.stringify({
        error: "Falta el campo 'base64' en el body",
        step: "input_validation"
      }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS }
      });
    }

    // Validar tamaño (~20MB base64 ≈ 15MB binario)
    if (base64.length > 27_000_000) {
      return new Response(JSON.stringify({
        error: "Imagen demasiado grande (máx ~20MB)",
        step: "input_validation",
        size_chars: base64.length
      }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS }
      });
    }

    // Prompt con localización
    const prompt = `Analizá esta imagen de una etiqueta de precio de supermercado.
La moneda esperada es ${loc?.currency || 'ARS'} (${loc?.symbol || '$'}).
Extraé SOLO la información visible. Si no podés identificar un campo con claridad, devolvé null.
Respondé ÚNICAMENTE con un objeto JSON sin backticks ni texto adicional:
{"name":"nombre del producto o null","unit_price":número o null,"currency":"símbolo o null"}`;

    // Llamada a Groq
    let groqResponse;
    try {
      groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model: 'meta-llama/llama-4-scout-17b-16e-instruct',
          temperature: 0.2,
          max_completion_tokens: 4096,
          top_p: 1,
          stream: false,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } }
            ]
          }]
        })
      });
    } catch (e) {
      return new Response(JSON.stringify({
        error: "No se pudo conectar con Groq API",
        step: "groq_fetch",
        detail: e.message
      }), {
        status: 502,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS }
      });
    }

    // Groq devolvió error HTTP
    if (!groqResponse.ok) {
      let groqError = '';
      try { groqError = await groqResponse.text(); } catch {}
      return new Response(JSON.stringify({
        error: `Groq rechazó la solicitud (HTTP ${groqResponse.status})`,
        step: "groq_response",
        groq_status: groqResponse.status,
        groq_body: groqError.slice(0, 500)  // truncar para no inflar el log
      }), {
        status: 502,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS }
      });
    }

    // Parsear respuesta de Groq
    let data;
    try {
      data = await groqResponse.json();
    } catch (e) {
      return new Response(JSON.stringify({
        error: "Respuesta de Groq no es JSON válido",
        step: "groq_json_parse",
        detail: e.message
      }), {
        status: 502,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS }
      });
    }

    const raw = data?.choices?.[0]?.message?.content || '';

    if (!raw) {
      return new Response(JSON.stringify({
        error: "Groq devolvió respuesta vacía",
        step: "groq_content_empty",
        full_response: JSON.stringify(data).slice(0, 500)
      }), {
        status: 502,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS }
      });
    }

    // Extraer JSON del texto (maneja texto antes/después del JSON)
    let parsed;
    try {
      const cleaned = raw.replace(/```json|```/g, '').trim();
      // Buscar primer { y último } para extraer solo el objeto JSON
      const start = cleaned.indexOf('{');
      const end   = cleaned.lastIndexOf('}');
      if (start === -1 || end === -1) throw new Error("No se encontró objeto JSON en la respuesta");
      parsed = JSON.parse(cleaned.slice(start, end + 1));
    } catch (e) {
      return new Response(JSON.stringify({
        error: "No se pudo parsear el JSON devuelto por el modelo",
        step: "model_json_parse",
        detail: e.message,
        raw_content: raw.slice(0, 300)
      }), {
        status: 422,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS }
      });
    }

    // Éxito
    return new Response(JSON.stringify({
      ...parsed,
      _debug: { step: "ok", raw_length: raw.length }
    }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS }
    });

  } catch (error) {
    console.error("Error inesperado en la Function:", error);
    return new Response(JSON.stringify({
      error: "Error interno inesperado",
      step: "uncaught",
      detail: error.message
    }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS }
    });
  }
}
