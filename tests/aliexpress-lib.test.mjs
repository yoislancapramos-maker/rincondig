// Pruebas de lib/aliexpress.mjs. Ejecutar con: node --test tests/aliexpress-lib.test.mjs
// Solo valores ficticios: ningún secreto ni token real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  buildBusinessRequest, refreshAccount, resolveAccountKey, parseProduct, parseFreight, parseBenefits, gatewayError,
} from "../lib/aliexpress.mjs";

const SECRET = "fake-secret-for-tests";
const OLD_AT = "FAKE_OLD_ACCESS_TOKEN_0123456789";
const OLD_RT = "FAKE_OLD_REFRESH_TOKEN_0123456789";
const NEW_AT = "FAKE_NEW_ACCESS_TOKEN_0123456789";
const NEW_RT = "FAKE_NEW_REFRESH_TOKEN_0123456789";

function referenceSign(params, secret, apiPath = "") {
  const base = apiPath + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return createHmac("sha256", secret).update(base, "utf8").digest("hex").toUpperCase();
}

function kvWith(records, { putFails = false } = {}) {
  const store = structuredClone(records);
  const writes = [];
  return {
    store, writes,
    kv: {
      list: async ({ prefix }) => ({ keys: Object.keys(store).filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }),
      get: async (k, type) => (store[k] ? (type === "json" ? structuredClone(store[k]) : JSON.stringify(store[k])) : null),
      put: async (k, v) => { if (putFails) throw new Error("kv down"); writes.push(k); store[k] = JSON.parse(v); },
      delete: async (k) => writes.push(`delete:${k}`),
    },
  };
}

const ACCOUNT = { "aliexpress:6341065104": { user_id: "6341065104", access_token: OLD_AT, refresh_token: OLD_RT, expire_time: 1794601469000, refresh_token_valid_time: 1797193469000, obtained_at: 1792009470040 } };

test("Business Interface: sistema + sign en la query, negocio en el cuerpo, firma sin ruta", async () => {
  const req = await buildBusinessRequest("aliexpress.ds.product.get", { product_id: "1", ship_to_country: "UY" }, "553836", SECRET, OLD_AT, 1792008450424);
  const u = new URL(req.url);
  assert.equal(u.origin + u.pathname, "https://api-sg.aliexpress.com/sync");
  const { sign, ...system } = Object.fromEntries(u.searchParams);
  assert.deepEqual(Object.keys(system).sort(), ["access_token", "app_key", "method", "sign_method", "timestamp"]);
  assert.equal(req.body, "product_id=1&ship_to_country=UY");
  assert.equal(sign, referenceSign({ ...system, product_id: "1", ship_to_country: "UY" }, SECRET));
});

test("resolveAccountKey: ignora respaldos y exige cuenta si hay varias", async () => {
  const { kv } = kvWith({ ...ACCOUNT, "backup:aliexpress:6341065104:1": {} });
  assert.deepEqual(await resolveAccountKey(kv, null), { key: "aliexpress:6341065104" });
  assert.deepEqual(await resolveAccountKey(kv, "x"), { error: "invalid_account" });
  const { kv: two } = kvWith({ ...ACCOUNT, "aliexpress:2": {} });
  assert.deepEqual(await resolveAccountKey(two, null), { error: "multiple_accounts_specify_account" });
});

test("refreshAccount: firma /auth/token/refresh, respalda y reemplaza; el resumen no tiene tokens", async () => {
  const { kv, store, writes } = kvWith(ACCOUNT);
  let call;
  globalThis.fetch = async (url, init) => {
    call = { url: new URL(String(url)), body: Object.fromEntries(new URLSearchParams(init.body)) };
    return new Response(JSON.stringify({ code: "0", access_token: NEW_AT, refresh_token: NEW_RT, expire_time: 1794646800000, refresh_token_valid_time: 1797193469000, expires_in: 2592000 }));
  };
  const r = await refreshAccount({ ALIEXPRESS_APP_KEY: "553836", ALIEXPRESS_APP_SECRET: SECRET, ALIEXPRESS_TOKENS: kv }, "aliexpress:6341065104", { now: 1792055067000 });

  assert.equal(call.url.origin + call.url.pathname, "https://api-sg.aliexpress.com/rest/auth/token/refresh");
  const { sign, ...system } = Object.fromEntries(call.url.searchParams);
  assert.equal(sign, referenceSign({ ...system, refresh_token: OLD_RT }, SECRET, "/auth/token/refresh"));
  assert.deepEqual(writes, ["backup:aliexpress:6341065104:1792009470040", "aliexpress:6341065104"]);
  assert.equal(store["aliexpress:6341065104"].refresh_token, NEW_RT);
  assert.equal(store["backup:aliexpress:6341065104:1792009470040"].refresh_token, OLD_RT);

  assert.equal(r.ok, true);
  assert.equal(r.accessToken, NEW_AT);
  const summary = JSON.stringify(r.summary);
  for (const s of [OLD_AT, OLD_RT, NEW_AT, NEW_RT, SECRET]) assert.ok(!summary.includes(s));
  // Comportamiento comprobado en producción: el refresh token no extiende su vencimiento.
  assert.equal(r.summary.refresh_token_expiry_extended, false);
});

test("refreshAccount rechazado: no escribe en KV", async () => {
  const { kv, writes } = kvWith(ACCOUNT);
  globalThis.fetch = async () => new Response(JSON.stringify({ type: "ISV", code: "InvalidRefreshToken", message: "invalid", request_id: "r" }));
  const r = await refreshAccount({ ALIEXPRESS_APP_KEY: "553836", ALIEXPRESS_APP_SECRET: SECRET, ALIEXPRESS_TOKENS: kv }, "aliexpress:6341065104");
  assert.equal(r.ok, false);
  assert.equal(r.error_code, "InvalidRefreshToken");
  assert.deepEqual(writes, []);
});

test("refreshAccount: si KV falla tras el refresh lanza error (para reintentar o reautorizar)", async () => {
  const { kv } = kvWith(ACCOUNT, { putFails: true });
  globalThis.fetch = async () => new Response(JSON.stringify({ code: "0", access_token: NEW_AT, refresh_token: NEW_RT }));
  await assert.rejects(refreshAccount({ ALIEXPRESS_APP_KEY: "553836", ALIEXPRESS_APP_SECRET: SECRET, ALIEXPRESS_TOKENS: kv }, "aliexpress:6341065104"));
});

test("parseProduct / parseFreight con la forma real observada en producción", () => {
  const p = parseProduct({
    aliexpress_ds_product_get_response: { rsp_code: 200, request_id: "r", result: {
      ae_item_base_info_dto: { product_id: 1005012996661961, subject: "X", product_status_type: "onSelling" },
      ae_item_sku_info_dtos: [{ sku_id: "12000060024298860", offer_sale_price: "14.40", sku_price: "14.40", currency_code: "USD", sku_available_stock: 236, price_include_tax: false,
        ae_sku_property_dtos: [{ sku_property_name: "Bundle", property_value_definition_name: "Black" }] }],
    } },
  });
  assert.equal(p.ok, true);
  assert.deepEqual(p.skus[0], {
    sku_id: "12000060024298860", attributes: "Bundle: Black", offer_sale_price: 14.4, sku_price: 14.4, currency: "USD", stock: 236,
    price_include_tax: false, tax_amount: null, tax_currency: null, estimated_import_charges: null, wholesale_tiers: [],
  });

  const f = parseFreight({ aliexpress_ds_freight_query_response: { request_id: "r", result: { code: 200, success: true, delivery_options: [
    { code: "CAINIAO_FULFILLMENT_STD", company: "AliExpress Selection Standard", free_shipping: true, min_delivery_days: 39, max_delivery_days: 79, tracking: true, ship_from_country: "CN" },
  ] } } });
  assert.equal(f.ok, true);
  assert.equal(f.options[0].free_shipping, true);
  assert.equal(f.options[0].shipping_fee, null);
  assert.equal(f.options[0].max_delivery_days, 79);

  assert.equal(parseProduct({ aliexpress_ds_product_get_response: { rsp_code: 604, rsp_msg: "All SKU Unsaleable" } }).error_code, "604");
  assert.equal(parseFreight({ aliexpress_ds_freight_query_response: { result: { code: 505, success: false, msg: "DELIVERY_NOT_AVAILABLE_TO_YOUR_ADDRESS" } } }).ok, false);
});

test("parseBenefits y gatewayError", () => {
  assert.deepEqual(parseBenefits({ aliexpress_ds_member_benefit_get: { result: [], request_id: "r" } }).benefits, []);
  const b = parseBenefits({ aliexpress_ds_member_benefit_get: { result: [{ code: "auto-pay", title: "auto-pay", canApply: "true", canBenefit: "false" }] } });
  assert.equal(b.auto_pay.can_apply, "true");
  assert.deepEqual(gatewayError({ error_response: { code: "IllegalAccessToken", msg: "expired", request_id: "r" } }), { error_code: "IllegalAccessToken", error_message: "expired", request_id: "r" });
  assert.equal(gatewayError({ code: "0" }), null);
});
