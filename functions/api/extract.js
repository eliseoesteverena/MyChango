
// functions/api/extract.js

export async function onRequest(context) {
  // 1. Manejar solicitudes de tipo POST únicamente
  if (context.request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Método no permitido" }), {
      status: 405,
      headers: { "Content-Type": "application/json" }
    });
  }

  try {
    // 2. Obtener el Secret guardado en Cloudflare de forma segura
    const GROQ_API_KEY = context.env.GROQ_API_KEY;
    if (!GROQ_API_KEY) {
      return new Response(JSON.stringify({ error: "API Key no configurada en el servidor" }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    // 3. Leer los datos enviados desde el frontend (base64 y loc)
    const { base64, loc } = await context.request.json();

    if (!base64) {
      return new Response(JSON.stringify({ error: "Falta la imagen en base64" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    // 4. Preparar el prompt con la localización recibida
    const prompt = `Analizá esta imagen de una etiqueta de precio de supermercado.
La moneda esperada es ${loc?.currency || 'ARS'} (${loc?.symbol || '$'}).
Extraé SOLO la información visible. Si no podés identificar un campo con claridad, devolvé null.
Respondé ÚNICAMENTE con un objeto JSON sin backticks ni texto adicional:
{"name":"nombre del producto o null","unit_price":número o null,"currency":"símbolo o null"}`;

    // 5. Hacer la petición a Groq desde el backend usando la API Key segura
    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
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

    if (!groqResponse.ok) {
      const errorText = await groqResponse.text();
      throw new Error(`Groq API error ${groqResponse.status}: ${errorText}`);
    }

    const data = await groqResponse.json();
    const raw = data?.choices?.[0]?.message?.content || '';
    
    // Parseamos el JSON devuelto por Llama para asegurarnos de que sea válido antes de responder
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());

    // 6. Devolver únicamente la información procesada al frontend
    return new Response(JSON.stringify(parsed), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  } catch (error) {
    console.error("Error en la Function:", error);
    return new Response(JSON.stringify({ error: "Error al procesar la etiqueta" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
