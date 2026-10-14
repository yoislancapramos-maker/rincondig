// Prueba de solo lectura del access_token guardado en ALIEXPRESS_TOKENS.
// Ruta: GET /api/aliexpress/test-product
//
// Consulta un producto con aliexpress.ds.product.get (API oficial Drop Shipping,
// sin costo, no crea pedidos ni modifica datos). No escribe en KV ni renueva tokens.
//
// Protección: requiere la cabecera "Authorization: Bearer <ALIEXPRESS_ADMIN_KEY>".
// Sin ese secreto en Cloudflare, o con una clave incorrecta, responde 404.
//
// Docs oficiales:
//   API:   https://openservice.aliexpress.com/doc/api.htm#/api?cid=21038&path=aliexpress.ds.product.get&methodType=GET/POST
//   Firma (Business Interfaces): https://openservice.aliexpress.com/doc/doc.htm#/?docId=1385

import { sign } from "./callback.js";

const API_METHOD = "aliexpress.ds.product.get";
const BUSINESS_ENDPOINT = "https://api-sg.aliexpress.com/sync";
const REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_PRODUCT_ID = "1005004638293060";
const DEFAULT_COUNTRY = "UY";

export async function onRequestGet({ request, env }) {
  if (!(await isAuthorized(request, env.ALIEXPRESS_ADMIN_KEY))) {
    return new Response("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }

  if (!env.ALIEXPRESS_APP_KEY || !env.ALIEXPRESS_APP_SECRET || !env.ALIEXPRESS_TOKENS) {
    return json(500, { ok: false, error: "missing_configuration" });
  }

  const url = new URL(request.url);
  const productId = url.searchParams.get("product_id") || DEFAULT_PRODUCT_ID;
  const country = (url.searchParams.get("country") || DEFAULT_COUNTRY).toUpperCase();
  const account = url.searchParams.get("account");

  if (!/^\d{1,20}$/.test(productId) || !/^[A-Z]{2}$/.test(country) || (account !== null && !/^\d{1,20}$/.test(account))) {
    return json(400, { ok: false, error: "invalid_parameters" });
  }

  // Solo lectura de KV: list/get, nunca put/delete.
  let key;
  if (account) {
    key = `aliexpress:${account}`;
  } else {
    const { keys } = await env.ALIEXPRESS_TOKENS.list({ prefix: "aliexpress:" });
    if (keys.length !== 1) {
      return json(400, { ok: false, error: keys.length ? "multiple_accounts_specify_account" : "no_accounts", accounts: keys.length });
    }
    key = keys[0].name;
  }

  const stored = await env.ALIEXPRESS_TOKENS.get(key, "json");
  if (!stored || !stored.access_token) {
    return json(404, { ok: false, error: "account_not_found" });
  }

  const accountInfo = {
    user_id: stored.user_id ?? null,
    account_platform: stored.account_platform ?? null,
    access_token_expires_at: stored.expire_time ? new Date(Number(stored.expire_time)).toISOString() : null,
  };

  let data;
  try {
    const req = await buildProductRequest(
      { product_id: productId, ship_to_country: country, target_currency: "USD", target_language: "es" },
      env.ALIEXPRESS_APP_KEY.trim(),
      env.ALIEXPRESS_APP_SECRET.trim(),
      stored.access_token
    );
    const res = await fetch(req.url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: req.body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    data = JSON.parse(await res.text());
  } catch (err) {
    console.error("AliExpress test-product: fallo de red o respuesta no JSON:", err.name);
    return json(502, { ok: false, error: "request_failed", account: accountInfo });
  }

  const summary = summarize(data);
  if (!summary.ok) {
    console.error(`AliExpress test-product: ${summary.error_code} request_id=${summary.request_id || "-"}`);
  }
  return json(summary.ok ? 200 : 502, { ...summary, account: accountInfo, query: { product_id: productId, ship_to_country: country } });
}

// Business Interface: "method" participa como parámetro al ordenar y no se antepone ruta.
// Parámetros de sistema y sign en la query; parámetros de negocio en el cuerpo (como el SDK).
export async function buildProductRequest(business, appKey, appSecret, accessToken, timestamp = Date.now()) {
  const system = {
    app_key: appKey,
    access_token: accessToken,
    method: API_METHOD,
    sign_method: "sha256",
    timestamp: String(timestamp),
  };
  const sig = await sign("", { ...system, ...business }, appSecret);
  return {
    url: `${BUSINESS_ENDPOINT}?${new URLSearchParams({ ...system, sign: sig })}`,
    body: new URLSearchParams(business).toString(),
  };
}

// Reduce la respuesta de AliExpress a datos no sensibles del producto.
export function summarize(data) {
  const wrapper = data?.aliexpress_ds_product_get_response;
  // Los errores del gateway /sync llegan como { error_response: { code, msg, request_id } }.
  const requestId = wrapper?.request_id || data?.request_id || data?.error_response?.request_id || null;
  const result = wrapper?.result;

  if (!result || (wrapper.rsp_code !== undefined && String(wrapper.rsp_code) !== "200")) {
    return {
      ok: false,
      error_code: String(data?.code || wrapper?.rsp_code || data?.error_response?.code || "unknown_response"),
      error_message: data?.message || wrapper?.rsp_msg || data?.error_response?.msg || null,
      request_id: requestId,
    };
  }

  const rawSkus = result.ae_item_sku_info_dtos;
  const skus = Array.isArray(rawSkus) ? rawSkus : rawSkus?.ae_item_sku_info_d_t_o || [];
  const prices = skus.map((s) => parseFloat(s.offer_sale_price || s.sku_price)).filter((n) => Number.isFinite(n));
  const base = result.ae_item_base_info_dto || {};

  return {
    ok: true,
    request_id: requestId,
    product: {
      product_id: base.product_id ?? null,
      title: base.subject ?? null,
      status: base.product_status_type ?? null,
      store_name: result.ae_store_info?.store_name ?? null,
      sku_count: skus.length,
      min_price: prices.length ? Math.min(...prices) : null,
      currency: skus[0]?.currency_code || base.currency_code || null,
      ship_to_country: result.logistics_info_dto?.ship_to_country ?? null,
      delivery_time_days: result.logistics_info_dto?.delivery_time ?? null,
    },
  };
}

// Compara la clave en tiempo constante (sobre los hashes SHA-256).
async function isAuthorized(request, adminKey) {
  if (!adminKey) return false;
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Bearer ")) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(header.slice(7))),
    crypto.subtle.digest("SHA-256", enc.encode(adminKey.trim())),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function json(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
