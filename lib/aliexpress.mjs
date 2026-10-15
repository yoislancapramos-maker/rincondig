// Lógica reutilizable de AliExpress Dropshipping: llamadas de negocio firmadas, renovación
// de tokens y lectura de respuestas de producto, envío y beneficios.
// No es una ruta HTTP ni se despliega: queda para el futuro Worker (cron de renovación,
// importación y sincronización). Las herramientas HTTP de prueba se eliminaron.
//
// Docs oficiales:
//   Firma:            https://openservice.aliexpress.com/doc/doc.htm#/?docId=1385
//   Refresh token:    https://openservice.aliexpress.com/doc/doc.htm#/?docId=1593
//   Vigencia tokens:  https://openservice.aliexpress.com/doc/doc.htm#/?docId=1590
//   ds.product.get / ds.freight.query / ds.member.benefit.get (grupo AE-Dropshipper):
//     https://openservice.aliexpress.com/doc/api.htm#/api?cid=21038&path=aliexpress.ds.product.get&methodType=GET/POST
//
// Comportamiento comprobado en producción (15/10/2026): /auth/token/refresh devuelve access y
// refresh token nuevos; el access token suma 30 días, pero el refresh token conserva su
// vencimiento original (60 días desde la autorización) ⇒ reautorización obligatoria cada ≤60 días.

import { sign } from "../functions/api/aliexpress/callback.js";

const BUSINESS_ENDPOINT = "https://api-sg.aliexpress.com/sync";
const REFRESH_API_PATH = "/auth/token/refresh";
const REFRESH_ENDPOINT = "https://api-sg.aliexpress.com/rest" + REFRESH_API_PATH;
const REQUEST_TIMEOUT_MS = 10000;
const KV_PREFIX = "aliexpress:";
const BACKUP_PREFIX = "backup:aliexpress:";

// Resuelve la clave de KV de la cuenta (solo lectura).
export async function resolveAccountKey(kv, account) {
  if (account !== null && account !== undefined) {
    if (!/^\d{1,20}$/.test(account)) return { error: "invalid_account" };
    return { key: KV_PREFIX + account };
  }
  const { keys } = await kv.list({ prefix: KV_PREFIX });
  if (keys.length !== 1) return { error: keys.length ? "multiple_accounts_specify_account" : "no_accounts" };
  return { key: keys[0].name };
}

export function accountSummary(stored) {
  return {
    user_id: stored.user_id ?? null,
    account_platform: stored.account_platform ?? null,
    access_token_expires_at: toIso(stored.expire_time),
    refresh_token_expires_at: toIso(stored.refresh_token_valid_time),
  };
}

export function toIso(ms) {
  return ms ? new Date(Number(ms)).toISOString() : null;
}

// URL de autorización oficial (docId=1364). Es la misma que inicia el flujo del callback actual.
export function buildAuthorizeUrl(appKey, redirectUri) {
  if (!appKey || !redirectUri) throw new Error("Faltan appKey o redirectUri para el link de autorización.");
  const params = new URLSearchParams({ response_type: "code", force_auth: "true", redirect_uri: redirectUri, client_id: appKey });
  return `https://api-sg.aliexpress.com/oauth/authorize?${params}`;
}

// Business Interface (como el SDK, protocolo TOP): sistema + sign en la query, negocio en el cuerpo.
export async function buildBusinessRequest(method, business, appKey, appSecret, accessToken, timestamp = Date.now()) {
  const system = { app_key: appKey, access_token: accessToken, method, sign_method: "sha256", timestamp: String(timestamp) };
  const sig = await sign("", { ...system, ...business }, appSecret);
  return {
    url: `${BUSINESS_ENDPOINT}?${new URLSearchParams({ ...system, sign: sig })}`,
    body: new URLSearchParams(business).toString(),
  };
}

export async function callBusinessApi(env, accessToken, method, business) {
  const req = await buildBusinessRequest(method, business, env.ALIEXPRESS_APP_KEY.trim(), env.ALIEXPRESS_APP_SECRET.trim(), accessToken);
  return postForm(req.url, req.body);
}

async function postForm(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return JSON.parse(await res.text());
}

// Error del gateway (/sync o /rest) en un formato uniforme, o null si no hay error de gateway.
export function gatewayError(data) {
  const e = data?.error_response || (data?.type && data?.code && data?.code !== "0" ? data : null);
  if (!e) return null;
  return { error_code: String(e.code), error_message: e.msg || e.message || null, request_id: e.request_id || null };
}

// Renueva el token de una cuenta. Guarda el registro anterior como respaldo antes de
// reemplazarlo. Nunca devuelve tokens: solo fechas y si cambiaron.
export async function refreshAccount(env, key, { now = Date.now() } = {}) {
  const kv = env.ALIEXPRESS_TOKENS;
  const stored = await kv.get(key, "json");
  if (!stored?.refresh_token) return { ok: false, error: "account_not_found" };

  const params = {
    app_key: env.ALIEXPRESS_APP_KEY.trim(),
    refresh_token: stored.refresh_token,
    sign_method: "sha256",
    timestamp: String(now),
  };
  const sig = await sign(REFRESH_API_PATH, params, env.ALIEXPRESS_APP_SECRET.trim());
  const { refresh_token, ...system } = params;

  let data;
  try {
    data = await postForm(`${REFRESH_ENDPOINT}?${new URLSearchParams({ ...system, sign: sig })}`, new URLSearchParams({ refresh_token }).toString());
  } catch (err) {
    return { ok: false, error: "request_failed", detail: err.name };
  }
  if (typeof data.gopResponseBody === "string") data = JSON.parse(data.gopResponseBody);

  if (!data.access_token || !data.refresh_token || (data.code && data.code !== "0")) {
    return { ok: false, error: "refresh_rejected", error_code: String(data.code || "unknown"), error_message: data.message || null, request_id: data.request_id || null };
  }

  const before = accountSummary(stored);
  const updated = {
    ...stored,
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expire_time: data.expire_time ?? null,
    refresh_token_valid_time: data.refresh_token_valid_time ?? null,
    refreshed_at: now,
  };

  // El refresh_token anterior puede quedar invalidado: el respaldo y el nuevo registro
  // se escriben con reintentos para no perder la autorización por un fallo transitorio.
  await putWithRetry(kv, `${BACKUP_PREFIX}${key.slice(KV_PREFIX.length)}:${stored.obtained_at || now}`, JSON.stringify(stored));
  await putWithRetry(kv, key, JSON.stringify(updated));

  return {
    ok: true,
    // accessToken es solo para uso interno (verificación); nunca se incluye en respuestas.
    accessToken: data.access_token,
    summary: {
      request_id: data.request_id || null,
      access_token_changed: data.access_token !== stored.access_token,
      refresh_token_changed: data.refresh_token !== stored.refresh_token,
      before,
      after: accountSummary(updated),
      expires_in_seconds: data.expires_in != null ? Number(data.expires_in) : null,
      refresh_expires_in_seconds: data.refresh_expires_in != null ? Number(data.refresh_expires_in) : null,
      refresh_token_expiry_extended: Number(updated.refresh_token_valid_time) > Number(stored.refresh_token_valid_time),
    },
  };
}

async function putWithRetry(kv, key, value, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      return await kv.put(key, value);
    } catch (err) {
      if (i >= attempts) throw err;
    }
  }
}

export function parseProduct(data) {
  const gw = gatewayError(data);
  if (gw) return { ok: false, ...gw };
  const wrapper = data?.aliexpress_ds_product_get_response;
  const result = wrapper?.result;
  if (!result || (wrapper.rsp_code !== undefined && String(wrapper.rsp_code) !== "200")) {
    return { ok: false, error_code: String(wrapper?.rsp_code || "unknown_response"), error_message: wrapper?.rsp_msg || null, request_id: wrapper?.request_id || null };
  }
  const raw = result.ae_item_sku_info_dtos;
  const list = Array.isArray(raw) ? raw : raw?.ae_item_sku_info_d_t_o || [];
  const skus = list.map((s) => {
    const propsRaw = s.ae_sku_property_dtos;
    const props = Array.isArray(propsRaw) ? propsRaw : propsRaw?.ae_sku_property_d_t_o || [];
    const tiersRaw = s.wholesale_price_tiers;
    const tiers = Array.isArray(tiersRaw) ? tiersRaw : tiersRaw?.wholesale_price_tier || [];
    return {
      sku_id: s.sku_id != null ? String(s.sku_id) : null,
      attributes: props.map((p) => `${p.sku_property_name}: ${p.property_value_definition_name || p.sku_property_value}`).join(" / ") || null,
      offer_sale_price: num(s.offer_sale_price),
      sku_price: num(s.sku_price),
      currency: s.currency_code || null,
      stock: s.sku_available_stock != null ? Number(s.sku_available_stock) : null,
      price_include_tax: s.price_include_tax ?? null,
      tax_amount: num(s.tax_amount),
      tax_currency: s.tax_currency_code || null,
      estimated_import_charges: num(s.estimated_import_charges),
      wholesale_tiers: tiers.map((t) => ({ min_quantity: num(t.min_quantity), wholesale_price: num(t.wholesale_price) })),
    };
  });
  const base = result.ae_item_base_info_dto || {};
  return {
    ok: true,
    request_id: wrapper.request_id || data.request_id || null,
    info: {
      product_id: base.product_id ?? null,
      title: base.subject ?? null,
      status: base.product_status_type ?? null,
      store_country: result.ae_store_info?.store_country_code ?? null,
    },
    skus,
  };
}

export function parseFreight(data) {
  const gw = gatewayError(data);
  if (gw) return { ok: false, ...gw };
  const wrapper = data?.aliexpress_ds_freight_query_response;
  const result = wrapper?.result;
  if (!result || result.success === false || (result.code !== undefined && Number(result.code) !== 200)) {
    return { ok: false, error_code: String(result?.code ?? "unknown_response"), error_message: result?.msg || null, request_id: wrapper?.request_id || null };
  }
  const raw = result.delivery_options;
  const list = Array.isArray(raw) ? raw : raw?.delivery_option_d_t_o || [];
  return {
    ok: true,
    request_id: wrapper.request_id || data.request_id || null,
    options: list.map((o) => ({
      code: o.code ?? null,
      company: o.company ?? null,
      free_shipping: o.free_shipping ?? null,
      // La doc dice "amount in cent"; se incluyen el valor crudo y el formateado para verificarlo con datos reales.
      shipping_fee: o.shipping_fee_cent != null ? Number(o.shipping_fee_cent) / 100 : null,
      shipping_fee_cent_raw: o.shipping_fee_cent ?? null,
      shipping_fee_format: o.shipping_fee_format ?? null,
      shipping_fee_currency: o.shipping_fee_currency ?? null,
      min_delivery_days: o.min_delivery_days ?? null,
      max_delivery_days: o.max_delivery_days ?? null,
      tracking: o.tracking ?? null,
      ship_from_country: o.ship_from_country ?? null,
      ddp_include_vat_tax: o.ddpIncludeVATTax ?? null,
    })),
  };
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function parseBenefits(data) {
  const gw = gatewayError(data);
  if (gw) return { ok: false, ...gw };
  const wrapperKey = Object.keys(data || {}).find((k) => k.startsWith("aliexpress_ds_member_benefit_get"));
  const wrapper = wrapperKey ? data[wrapperKey] : null;
  if (!wrapper) return { ok: false, error_code: "unknown_response", error_message: null, request_id: data?.request_id || null };
  const raw = wrapper.result;
  const list = Array.isArray(raw) ? raw : raw?.result || raw?.member_benefit_d_t_o || [];
  const benefits = list.map((b) => ({ code: b.code ?? null, title: b.title ?? null, can_apply: b.canApply ?? null, has_benefit: b.canBenefit ?? null }));
  return {
    ok: true,
    request_id: wrapper.request_id || data.request_id || null,
    rsp_code: wrapper.rsp_code ?? wrapper.code ?? null,
    benefits,
    auto_pay: benefits.find((b) => b.code === "auto-pay") || null,
  };
}
