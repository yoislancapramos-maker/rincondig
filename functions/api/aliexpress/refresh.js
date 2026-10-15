// Renovación real del token de una cuenta + verificación con una consulta de producto.
// Ruta: POST /api/aliexpress/refresh?account=&product_id=&country=
//
// Llama a /auth/token/refresh, guarda el registro anterior como respaldo en
// "backup:aliexpress:<user_id>:<obtained_at>" y reemplaza el registro de la cuenta.
// Nunca devuelve tokens: solo fechas, si cambiaron y el resultado de la verificación.
// Protegido con "Authorization: Bearer <ALIEXPRESS_ADMIN_KEY>". Solo POST.
//
// Doc oficial: https://openservice.aliexpress.com/doc/doc.htm#/?docId=1593

import { isAuthorized, json, summarize, buildProductRequest } from "./test-product.js";
import { refreshAccount, resolveAccountKey } from "./admin-lib.js";

export async function onRequestPost({ request, env }) {
  if (!(await isAuthorized(request, env.ALIEXPRESS_ADMIN_KEY))) {
    return new Response("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  if (!env.ALIEXPRESS_APP_KEY || !env.ALIEXPRESS_APP_SECRET || !env.ALIEXPRESS_TOKENS) {
    return json(500, { ok: false, error: "missing_configuration" });
  }

  const q = new URL(request.url).searchParams;
  const productId = q.get("product_id") || "";
  const country = (q.get("country") || "").toUpperCase();
  if (!/^\d{1,20}$/.test(productId) || !/^[A-Z]{2}$/.test(country)) {
    return json(400, { ok: false, error: "invalid_parameters", required: "product_id y country para verificar el token nuevo" });
  }

  const { key, error } = await resolveAccountKey(env.ALIEXPRESS_TOKENS, q.get("account"));
  if (error) return json(400, { ok: false, error });

  let result;
  try {
    result = await refreshAccount(env, key);
  } catch (err) {
    // Solo llega acá si falló la escritura en KV después de un refresh exitoso.
    console.error("AliExpress refresh: fallo al guardar en KV:", err.name);
    return json(500, { ok: false, error: "kv_write_failed", action: "Reautorizar la cuenta si la consulta de producto deja de funcionar." });
  }
  if (!result.ok) {
    console.error(`AliExpress refresh: ${result.error} ${result.error_code || ""} request_id=${result.request_id || "-"}`);
    return json(502, result);
  }

  // Verificación inmediata con el token nuevo (sin releer KV).
  let verification;
  try {
    const req = await buildProductRequest(
      { product_id: productId, ship_to_country: country, target_currency: "USD", target_language: "en" },
      env.ALIEXPRESS_APP_KEY.trim(), env.ALIEXPRESS_APP_SECRET.trim(), result.accessToken
    );
    const res = await fetch(req.url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: req.body,
      signal: AbortSignal.timeout(10000),
    });
    verification = summarize(JSON.parse(await res.text()));
  } catch (err) {
    verification = { ok: false, error_code: "request_failed", error_message: err.name };
  }

  return json(200, { ok: true, refresh: result.summary, verification });
}
