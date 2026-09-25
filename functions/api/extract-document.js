// functions/api/extract-document.js
// POST { file: <base64>, mime_type: "image/jpeg" | "application/pdf", kind: "expense" | "income",
//        loc: { country, currency, symbol } }
//  →  { name, unit_price, quantity: 1, doc_type, amount_basis, currency_hint, note, _debug }
//
// Un comprobante (foto o PDF) siempre da UN monto → se usa solo desde Gastos e Ingresos
// (una compra con carrito tiene varios productos, así que no aplica ahí).
//
// El documento puede ser, entre otros:
//   Gastos:   ticket de un comercio, factura de compra, factura de un servicio (luz, gas, alquiler…)
//   Ingresos: recibo de sueldo (usa el NETO, no el bruto), factura de un servicio prestado o venta,
//             comprobante de una transferencia recibida
// gemini-3.5-flash-lite recibe la imagen/PDF inline (igual que ya se usa como respaldo de audio en
// /api/transcribe) y devuelve un JSON con el tipo de documento y el monto elegido.
// La imagen/PDF no se guarda en ningún lado: solo se usa para esta llamada.

const MODEL = "gemini-3.5-flash-lite";
// Verificá el nombre vigente y el soporte de cada mimeType en https://ai.google.dev/gemini-api/docs/models

const MAX_FILE_B64_CHARS = 12_000_000;   // ~9 MB de archivo; una foto ya redimensionada pesa mucho menos
const ALLOWED_MIME = new Set([
  "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf",
]);
// HEIC/HEIF: Gemini los acepta, pero conviene confirmarlo — si falla, convertir a JPEG antes de enviar.

const DECIMAL_HINT = {
  AR: "coma", MX: "punto", CO: "coma", CL: "coma", PE: "punto", UY: "coma",
  PY: "coma", BO: "coma", VE: "coma", EC: "punto", US: "punto", ES: "coma", BR: "coma",
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
  return ALLOWED_MIME.has(base) ? base : null;
}

function buildPrompt(kind, loc) {
  const country = loc?.country || "AR";
  const currency = loc?.currency || "ARS";
  const symbol = loc?.symbol || "$";
  const decimal = DECIMAL_HINT[country] || "coma";

  const intro =
    `Analizá este comprobante para una app de finanzas personales (puede ser una foto o un PDF: ` +
    `ticket, factura, recibo de sueldo, comprobante de pago, etc.). Puede estar borroso, inclinado o ` +
    `parcialmente cortado: hacé la mejor lectura posible.`;

  const specific = kind === "income"
    ? `Este comprobante corresponde a dinero que la persona RECIBIÓ o va a recibir. Puede ser un recibo ` +
      `de sueldo/haberes, una factura que la persona emitió por un servicio prestado o una venta, o un ` +
      `comprobante de una transferencia o depósito recibido.
- doc_type: "recibo_sueldo", "factura_servicio" (factura o venta emitida por la persona), "transferencia" ` +
      `(comprobante de un pago o transferencia recibida), u "otro".
- name: quién paga (el empleador, o a quién se le facturó o vendió), o un concepto breve. null si no se lee.
- Si es recibo_sueldo: usá el NETO — "Neto a cobrar", "Neto a pagar", "Líquido a percibir" o similar —, ` +
      `NUNCA el bruto ni el total de remuneraciones antes de descuentos. Si el recibo no muestra un neto ` +
      `explícito, usá el bruto y explicalo en "note".
- Si es factura_servicio o transferencia: usá el importe total del comprobante. Si hay retenciones o ` +
      `percepciones que reducen lo efectivamente cobrado, dejá el total facturado en unit_price pero avisalo ` +
      `en "note".
- amount_basis: "neto" si usaste un neto, "bruto" si usaste un bruto a falta de neto, "total" en los demás casos.`
    : `Este comprobante corresponde a algo que la persona PAGÓ. Puede ser un ticket de un comercio ` +
      `(supermercado, farmacia, kiosco...), una factura de compra de productos, o una factura de un ` +
      `servicio o gasto recurrente (luz, gas, internet, alquiler, honorarios, suscripción, etc.).
- doc_type: "ticket" (ticket de un comercio), "factura_compra" (factura por productos comprados), ` +
      `"factura_servicio" (factura de un servicio o gasto recurrente), u "otro".
- name: el comercio o emisor, con el concepto si ayuda a identificarlo (ej: "Coto", "EDESUR - Luz", ` +
      `"Farmacity"). null si no se lee.
- unit_price: el TOTAL A PAGAR final — el importe de cierre del comprobante (buscá "TOTAL", "TOTAL A ` +
      `PAGAR", "IMPORTE TOTAL") — no el subtotal ni un impuesto por separado.
- amount_basis: "total" casi siempre en este caso.`;

  return `${intro}\n\n${specific}

Otras reglas:
- unit_price: como número, con punto decimal, sin separador de miles ni símbolo de moneda (este comprobante probablemente usa ${decimal} como separador decimal — convertilo). null si no hay un monto legible con confianza razonable.
- currency_hint: si ves un símbolo o código de moneda distinto al esperado (ej. "US$", "USD", "R$"), indicalo acá; si no hay nada inusual, null.
- note: un aviso breve (una frase) si hay algo para revisar — ambigüedad, mala calidad de imagen, más de un comprobante en la misma imagen, un neto no encontrado, etc. null si no hay nada que avisar.
- Si el documento no es reconocible como ningún comprobante válido, dejá unit_price en null en vez de adivinar.
- No inventes datos que no estén en el comprobante.

País: ${country}. Moneda esperada: ${currency} (${symbol}).

Respondé ÚNICAMENTE un objeto JSON, sin backticks ni texto adicional:
{"doc_type": string, "name": string o null, "unit_price": número o null, "amount_basis": "total" o "neto" o "bruto", "currency_hint": string o null, "note": string o null}`;
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

    const { file, mime_type, kind, loc } = body || {};
    if (kind !== "expense" && kind !== "income") {
      return json(env, { error: "'kind' debe ser 'expense' o 'income'", step: "input_validation" }, 400);
    }
    if (!file || typeof file !== "string") {
      return json(env, { error: "Falta el campo 'file' (base64)", step: "input_validation" }, 400);
    }
    if (file.length > MAX_FILE_B64_CHARS) {
      return json(env, { error: "El comprobante pesa demasiado", step: "input_validation", size_chars: file.length }, 413);
    }
    const mimeType = normalizeMime(mime_type);
    if (!mimeType) {
      return json(env, { error: `Formato de archivo no soportado: ${mime_type || "?"}`, step: "input_validation" }, 415);
    }

    const t0 = Date.now();
    let geminiResponse;
    try {
      geminiResponse = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
          body: JSON.stringify({
            contents: [{
              role: "user",
              parts: [{ inlineData: { mimeType, data: file } }, { text: buildPrompt(kind, loc) }],
            }],
            generationConfig: { temperature: 0, maxOutputTokens: 500, responseMimeType: "application/json" },
          }),
        }
      );
    } catch (e) {
      return json(env, { error: "No se pudo conectar con Gemini API", step: "gemini_fetch", detail: e.message }, 502);
    }

    if (!geminiResponse.ok) {
      let geminiError = "";
      try { geminiError = await geminiResponse.text(); } catch {}
      return json(env, {
        error: `Gemini rechazó la solicitud (HTTP ${geminiResponse.status})`,
        step: "gemini_response",
        gemini_status: geminiResponse.status,
        gemini_body: geminiError.slice(0, 500),
      }, 502);
    }

    let data;
    try {
      data = await geminiResponse.json();
    } catch (e) {
      return json(env, { error: "Respuesta de Gemini no es JSON válido", step: "gemini_json_parse", detail: e.message }, 502);
    }

    const parts = data?.candidates?.[0]?.content?.parts || [];
    const raw = parts.map((p) => p.text || "").join("");
    if (!raw) {
      return json(env, {
        error: "Gemini devolvió respuesta vacía",
        step: "gemini_content_empty",
        full_response: JSON.stringify(data).slice(0, 500),
      }, 502);
    }

    let parsed;
    try {
      const cleaned = raw.replace(/```json|```/g, "").trim();
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      if (start === -1 || end === -1) throw new Error("No se encontró objeto JSON en la respuesta");
      parsed = JSON.parse(cleaned.slice(start, end + 1));
    } catch (e) {
      return json(env, {
        error: "No se pudo parsear el JSON devuelto por el modelo",
        step: "model_json_parse",
        detail: e.message,
        raw_content: raw.slice(0, 300),
      }, 422);
    }

    // Normalizar tipos (el modelo a veces devuelve strings)
    const price = Number(parsed.unit_price);
    const AMOUNT_BASIS = new Set(["total", "neto", "bruto"]);

    return json(env, {
      name: typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : null,
      unit_price: Number.isFinite(price) && price > 0 ? price : null,
      quantity: 1,
      doc_type: typeof parsed.doc_type === "string" && parsed.doc_type.trim() ? parsed.doc_type.trim() : "otro",
      amount_basis: AMOUNT_BASIS.has(parsed.amount_basis) ? parsed.amount_basis : "total",
      currency_hint: typeof parsed.currency_hint === "string" && parsed.currency_hint.trim() ? parsed.currency_hint.trim() : null,
      note: typeof parsed.note === "string" && parsed.note.trim() ? parsed.note.trim() : null,
      _debug: { step: "ok", ms: Date.now() - t0, mime: mimeType, raw_length: raw.length },
    });
  } catch (error) {
    console.error("Error inesperado en /api/extract-document:", error);
    return json(env, { error: "Error interno inesperado", step: "uncaught", detail: error.message }, 500);
  }
}
