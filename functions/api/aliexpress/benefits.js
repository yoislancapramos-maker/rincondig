// Beneficios DS de la cuenta (solo lectura), p. ej. si puede usar "auto-pay".
// Ruta: GET /api/aliexpress/benefits?account=
// Protegido con "Authorization: Bearer <ALIEXPRESS_ADMIN_KEY>". No escribe en KV.
//
// Doc oficial: https://openservice.aliexpress.com/doc/doc.htm#/?docId=1716
// Pago automático (whitelist, PayPal, USD): https://openservice.aliexpress.com/doc/doc.htm#/?docId=1640

import { isAuthorized, json } from "./test-product.js";
import { accountSummary, callBusinessApi, gatewayError, resolveAccountKey } from "./admin-lib.js";

export async function onRequestGet({ request, env }) {
  if (!(await isAuthorized(request, env.ALIEXPRESS_ADMIN_KEY))) {
    return new Response("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  if (!env.ALIEXPRESS_APP_KEY || !env.ALIEXPRESS_APP_SECRET || !env.ALIEXPRESS_TOKENS) {
    return json(500, { ok: false, error: "missing_configuration" });
  }

  const { key, error } = await resolveAccountKey(env.ALIEXPRESS_TOKENS, new URL(request.url).searchParams.get("account"));
  if (error) return json(400, { ok: false, error });
  const stored = await env.ALIEXPRESS_TOKENS.get(key, "json");
  if (!stored?.access_token) return json(404, { ok: false, error: "account_not_found" });

  let data;
  try {
    data = await callBusinessApi(env, stored.access_token, "aliexpress.ds.member.benefit.get", {});
  } catch (err) {
    console.error("AliExpress benefits: fallo de red o respuesta no JSON:", err.name);
    return json(502, { ok: false, error: "request_failed" });
  }

  const parsed = parseBenefits(data);
  if (!parsed.ok) console.error(`AliExpress benefits: ${parsed.error_code} request_id=${parsed.request_id || "-"}`);
  return json(parsed.ok ? 200 : 502, { ...parsed, account: accountSummary(stored) });
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
