// Utilidades compartidas por los endpoints de administración de AliExpress.
// No exporta handlers onRequest*, así que Cloudflare Pages no crea una ruta para este archivo.
//
// Docs oficiales:
//   Firma:            https://openservice.aliexpress.com/doc/doc.htm#/?docId=1385
//   Refresh token:    https://openservice.aliexpress.com/doc/doc.htm#/?docId=1593
//   Vigencia tokens:  https://openservice.aliexpress.com/doc/doc.htm#/?docId=1590

import { sign } from "./callback.js";

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
