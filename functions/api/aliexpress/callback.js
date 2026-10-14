// Callback OAuth de AliExpress Open Platform (app Drop Shipping).
// Ruta: /api/aliexpress/callback
//
// Configuración requerida en Cloudflare Pages (Settings):
//   - Variable cifrada ALIEXPRESS_APP_KEY
//   - Variable cifrada ALIEXPRESS_APP_SECRET
//   - KV namespace vinculado como ALIEXPRESS_TOKENS
//
// Docs oficiales:
//   Autorización:  https://openservice.aliexpress.com/doc/doc.htm#/?docId=1364
//   Firma (System Interfaces): https://openservice.aliexpress.com/doc/doc.htm#/?docId=1385

const TOKEN_API_PATH = "/auth/token/create";
const TOKEN_ENDPOINT = "https://api-sg.aliexpress.com/rest" + TOKEN_API_PATH;
const REQUEST_TIMEOUT_MS = 10000;

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");

  if (url.searchParams.has("error")) {
    return page(400, "Autorización cancelada", "No se completó la autorización en AliExpress.");
  }

  // Solo caracteres ASCII visibles y longitud acotada: evita reenviar basura al gateway.
  if (!code || !/^[\x21-\x7E]{1,512}$/.test(code)) {
    return page(400, "Autorización incompleta", "No se recibió un código de autorización válido de AliExpress.");
  }

  if (!env.ALIEXPRESS_APP_KEY || !env.ALIEXPRESS_APP_SECRET || !env.ALIEXPRESS_TOKENS) {
    console.error("AliExpress callback: faltan ALIEXPRESS_APP_KEY, ALIEXPRESS_APP_SECRET o el KV ALIEXPRESS_TOKENS");
    return page(500, "Error de configuración", "La integración con AliExpress todavía no está configurada.");
  }

  let tokens;
  try {
    tokens = await createToken(code, env.ALIEXPRESS_APP_KEY, env.ALIEXPRESS_APP_SECRET);
  } catch (err) {
    console.error("AliExpress callback: error al obtener el token:", err.message);
    return page(502, "No se pudo completar la autorización", "AliExpress rechazó la solicitud. Intentá autorizar de nuevo.");
  }

  const accountId = tokens.user_id || tokens.havana_id;
  if (!accountId) {
    console.error("AliExpress callback: la respuesta no incluye user_id ni havana_id");
    return page(502, "No se pudo completar la autorización", "La respuesta de AliExpress no identificó la cuenta.");
  }

  try {
    await env.ALIEXPRESS_TOKENS.put(
      `aliexpress:${accountId}`,
      JSON.stringify({
        user_id: tokens.user_id ?? null,
        havana_id: tokens.havana_id ?? null,
        seller_id: tokens.seller_id ?? null,
        account: tokens.account ?? null,
        user_nick: tokens.user_nick ?? null,
        account_platform: tokens.account_platform ?? null,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expire_time: tokens.expire_time ?? null,
        refresh_token_valid_time: tokens.refresh_token_valid_time ?? null,
        obtained_at: Date.now(),
      })
    );
  } catch (err) {
    console.error("AliExpress callback: no se pudo guardar el token en KV:", err.message);
    return page(500, "No se pudo completar la autorización", "Ocurrió un error al guardar la vinculación. Intentá de nuevo.");
  }

  return page(200, "Cuenta conectada", "Tu cuenta de AliExpress quedó vinculada correctamente. Ya podés cerrar esta ventana.");
}

// Intercambia el código por access_token / refresh_token.
async function createToken(code, appKey, appSecret) {
  const params = {
    app_key: appKey,
    code,
    sign_method: "sha256",
    timestamp: String(Date.now()),
  };
  params.sign = await sign(TOKEN_API_PATH, params, appSecret);

  // POST con los parámetros en la query, como en el ejemplo HTTP oficial (docId=1385).
  const res = await fetch(`${TOKEN_ENDPOINT}?${new URLSearchParams(params)}`, {
    method: "POST",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`respuesta no JSON (HTTP ${res.status})`);
  }

  // Las respuestas del SDK pueden venir envueltas en gopResponseBody.
  if (typeof data.gopResponseBody === "string") {
    data = JSON.parse(data.gopResponseBody);
  }

  if (!res.ok || !data.access_token || (data.code && data.code !== "0")) {
    throw new Error(`${data.code || res.status} ${data.message || ""} request_id=${data.request_id || "-"}`.trim());
  }
  return data;
}

// Firma de System Interfaces: ruta de la API + parámetros ordenados (clave+valor),
// HMAC-SHA256 con el App Secret, hexadecimal en mayúsculas.
export async function sign(apiPath, params, appSecret) {
  const base = apiPath + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(appSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(base));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function page(status, title, message) {
  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex">
  <title>${title} — Rincón Digital</title>
  <style>
    body { font-family: Inter, system-ui, sans-serif; background: #0f0f14; color: #f2f2f2; display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 16px; box-sizing: border-box; }
    main { max-width: 420px; text-align: center; }
    a { color: #f5c518; }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p>${message}</p>
    <p><a href="/">Volver a Rincón Digital</a></p>
  </main>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}
