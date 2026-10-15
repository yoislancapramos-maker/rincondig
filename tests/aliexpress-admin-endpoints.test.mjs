// Pruebas de /api/aliexpress/quote, /benefits y /refresh.
// Ejecutar con: node --test tests/aliexpress-admin-endpoints.test.mjs
// Solo valores ficticios: ningún secreto ni token real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { onRequestGet as quote } from "../functions/api/aliexpress/quote.js";
import { onRequestGet as benefits } from "../functions/api/aliexpress/benefits.js";
import { onRequestPost as refresh } from "../functions/api/aliexpress/refresh.js";

const ADMIN_KEY = "fake-admin-key-for-tests";
const SECRET = "fake-secret-for-tests";
const OLD_AT = "FAKE_OLD_ACCESS_TOKEN_0123456789";
const OLD_RT = "FAKE_OLD_REFRESH_TOKEN_0123456789";
const NEW_AT = "FAKE_NEW_ACCESS_TOKEN_0123456789";
const NEW_RT = "FAKE_NEW_REFRESH_TOKEN_0123456789";
const SENSITIVE = [OLD_AT, OLD_RT, NEW_AT, NEW_RT, SECRET, ADMIN_KEY];

const PRODUCT = {
  aliexpress_ds_product_get_response: {
    rsp_code: 200, request_id: "req-product",
    result: {
      ae_item_base_info_dto: { product_id: 1005012996661961, subject: "Producto de prueba", product_status_type: "onSelling" },
      ae_store_info: { store_country_code: "CN" },
      ae_item_sku_info_dtos: [
        { sku_id: "111", offer_sale_price: "9.10", sku_price: "12.00", currency_code: "USD", sku_available_stock: 0, price_include_tax: true,
          ae_sku_property_dtos: [{ sku_property_name: "Color", sku_property_value: "Red" }] },
        { sku_id: "222", offer_sale_price: "8.50", sku_price: "11.00", currency_code: "USD", sku_available_stock: 40, price_include_tax: false, tax_amount: "0.80",
          estimated_import_charges: "1.20", ae_sku_property_dtos: { ae_sku_property_d_t_o: [{ sku_property_name: "Color", property_value_definition_name: "Azul" }] },
          wholesale_price_tiers: [{ min_quantity: "10", wholesale_price: "7.90" }] },
      ],
    },
  },
};
const FREIGHT = {
  aliexpress_ds_freight_query_response: {
    request_id: "req-freight",
    result: { code: 200, success: true, delivery_options: [
      { code: "CAINIAO_STANDARD", company: "AliExpress Standard Shipping", free_shipping: false, shipping_fee_cent: "230", shipping_fee_format: "US $2.30",
        shipping_fee_currency: "USD", min_delivery_days: 12, max_delivery_days: 20, tracking: true, ship_from_country: "CN" },
    ] },
  },
};

function referenceSign(params, secret, apiPath = "") {
  const base = apiPath + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return createHmac("sha256", secret).update(base, "utf8").digest("hex").toUpperCase();
}

function setup(responder, { putFails = false } = {}) {
  const store = {
    "aliexpress:6341065104": { user_id: "6341065104", account_platform: "buyerApp", access_token: OLD_AT, refresh_token: OLD_RT,
      expire_time: 1794601469000, refresh_token_valid_time: 1797193469000, obtained_at: 1792009470040 },
  };
  const writes = [];
  const kv = {
    list: async ({ prefix }) => ({ keys: Object.keys(store).filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }),
    get: async (k, type) => (store[k] ? (type === "json" ? structuredClone(store[k]) : JSON.stringify(store[k])) : null),
    put: async (k, v) => { if (putFails) throw new Error("kv down"); writes.push(k); store[k] = JSON.parse(v); },
    delete: async (k) => writes.push(`delete:${k}`),
  };
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    const call = { url: u, init, query: Object.fromEntries(u.searchParams), body: Object.fromEntries(new URLSearchParams(init.body || "")) };
    calls.push(call);
    return new Response(JSON.stringify(responder(call)), { status: 200 });
  };
  const env = { ALIEXPRESS_APP_KEY: "553836", ALIEXPRESS_APP_SECRET: SECRET, ALIEXPRESS_ADMIN_KEY: ADMIN_KEY, ALIEXPRESS_TOKENS: kv };
  const req = (path, auth = true) => new Request(`https://rincondig.pages.dev/api/aliexpress/${path}`, { method: path.startsWith("refresh") ? "POST" : "GET", headers: auth ? { Authorization: `Bearer ${ADMIN_KEY}` } : {} });
  return { store, writes, calls, env, req };
}

async function run(handler, request, env) {
  const logs = [];
  const orig = { error: console.error, warn: console.warn, log: console.log };
  console.error = console.warn = console.log = (...a) => logs.push(a.join(" "));
  try {
    const res = await handler({ request, env });
    const text = await res.text();
    for (const s of SENSITIVE) {
      assert.ok(!text.includes(s), "la respuesta expone un valor sensible");
      assert.ok(!logs.join("\n").includes(s), "los logs exponen un valor sensible");
    }
    return { res, body: text ? JSON.parse(text.startsWith("{") ? text : "{}") : {} };
  } finally {
    Object.assign(console, orig);
  }
}

const byMethod = (call) => (call.query.method === "aliexpress.ds.product.get" ? PRODUCT : call.query.method === "aliexpress.ds.freight.query" ? FREIGHT : {});

test("los tres endpoints responden 404 sin la clave de administración y no llaman a AliExpress", async () => {
  const { env, req, calls } = setup(byMethod);
  assert.equal((await quote({ request: req("quote?product_id=1&country=US", false), env })).status, 404);
  assert.equal((await benefits({ request: req("benefits", false), env })).status, 404);
  assert.equal((await refresh({ request: req("refresh?product_id=1&country=US", false), env })).status, 404);
  assert.equal(calls.length, 0);
});

test("quote: costo por variante + envío, firmados correctamente, sin escribir en KV", async () => {
  const { env, req, calls, writes } = setup(byMethod);
  const { res, body } = await run(quote, req("quote?product_id=1005012996661961&country=US&quantity=2"), env);
  assert.equal(res.status, 200);
  assert.deepEqual(writes, []);

  assert.equal(calls.length, 2);
  for (const c of calls) {
    const { sign, ...system } = c.query;
    assert.equal(c.url.origin + c.url.pathname, "https://api-sg.aliexpress.com/sync");
    assert.equal(sign, referenceSign({ ...system, ...c.body }, SECRET));
  }
  const delivery = JSON.parse(calls[1].body.queryDeliveryReq);
  assert.deepEqual(delivery, { productId: "1005012996661961", selectedSkuId: "222", quantity: 2, shipToCountry: "US", currency: "USD", language: "en_US", locale: "en_US" });

  // Elige la primera variante con stock y expone los datos para el precio.
  assert.equal(body.selected_sku.sku_id, "222");
  assert.equal(body.selected_sku.attributes, "Color: Azul");
  assert.equal(body.selected_sku.offer_sale_price, 8.5);
  assert.equal(body.selected_sku.estimated_import_charges, 1.2);
  assert.equal(body.selected_sku.price_include_tax, false);
  assert.deepEqual(body.selected_sku.wholesale_tiers, [{ min_quantity: 10, wholesale_price: 7.9 }]);
  assert.equal(body.skus.length, 2);
  assert.equal(body.freight.options[0].shipping_fee, 2.3);
  assert.equal(body.freight.options[0].code, "CAINIAO_STANDARD");
});

test("quote: errores de producto y de envío se informan con etapa y código", async () => {
  let s = setup(() => ({ aliexpress_ds_product_get_response: { rsp_code: 604, rsp_msg: "All SKU Unsaleable", request_id: "r1" } }));
  let out = await run(quote, s.req("quote?product_id=1&country=UY"), s.env);
  assert.equal(out.res.status, 502);
  assert.equal(out.body.stage, "product");
  assert.equal(out.body.error_code, "604");

  s = setup((c) => (c.query.method === "aliexpress.ds.product.get" ? PRODUCT : { aliexpress_ds_freight_query_response: { request_id: "r2", result: { code: 505, success: false, msg: "DELIVERY_NOT_AVAILABLE_TO_YOUR_ADDRESS" } } }));
  out = await run(quote, s.req("quote?product_id=1&country=UY"), s.env);
  assert.equal(out.res.status, 502);
  assert.equal(out.body.stage, "freight");
  assert.equal(out.body.freight.error_message, "DELIVERY_NOT_AVAILABLE_TO_YOUR_ADDRESS");

  s = setup(() => ({ error_response: { type: "ISV", code: "IllegalAccessToken", msg: "expired", request_id: "r3" } }));
  out = await run(quote, s.req("quote?product_id=1&country=US"), s.env);
  assert.equal(out.body.error_code, "IllegalAccessToken");

  assert.equal((await quote({ request: s.req("quote?product_id=1"), env: s.env })).status, 400);
});

test("benefits: informa si la cuenta tiene o puede pedir auto-pay", async () => {
  const { env, req, writes } = setup(() => ({
    aliexpress_ds_member_benefit_get: { result: [{ canApply: "true", code: "auto-pay", title: "auto-pay", canBenefit: "false" }], code: "0", request_id: "rb" },
  }));
  const { res, body } = await run(benefits, req("benefits"), env);
  assert.equal(res.status, 200);
  assert.deepEqual(body.auto_pay, { code: "auto-pay", title: "auto-pay", can_apply: "true", has_benefit: "false" });
  assert.deepEqual(writes, []);
});

test("refresh: llama a /rest/auth/token/refresh firmado, respalda, reemplaza y verifica con el token nuevo", async () => {
  const { env, req, calls, store, writes } = setup((c) => {
    if (c.url.pathname === "/rest/auth/token/refresh") {
      return { code: "0", request_id: "rr", access_token: NEW_AT, refresh_token: NEW_RT, expire_time: 1797200000000, refresh_token_valid_time: 1797193469000, expires_in: 2592000, refresh_expires_in: 2591000 };
    }
    return PRODUCT;
  });
  const { res, body } = await run(refresh, req("refresh?product_id=1005012996661961&country=US"), env);
  assert.equal(res.status, 200);

  const r = calls[0];
  assert.equal(r.url.origin + r.url.pathname, "https://api-sg.aliexpress.com/rest/auth/token/refresh");
  assert.equal(r.body.refresh_token, OLD_RT);
  assert.equal(r.query.refresh_token, undefined);
  const { sign, ...system } = r.query;
  assert.equal(sign, referenceSign({ ...system, refresh_token: OLD_RT }, SECRET, "/auth/token/refresh"));

  // Respaldo primero, luego el registro nuevo; nada se borra.
  assert.deepEqual(writes, ["backup:aliexpress:6341065104:1792009470040", "aliexpress:6341065104"]);
  assert.equal(store["backup:aliexpress:6341065104:1792009470040"].refresh_token, OLD_RT);
  assert.equal(store["aliexpress:6341065104"].access_token, NEW_AT);
  assert.equal(store["aliexpress:6341065104"].refresh_token, NEW_RT);

  assert.equal(body.refresh.access_token_changed, true);
  assert.equal(body.refresh.refresh_token_changed, true);
  assert.equal(body.refresh.refresh_token_expiry_extended, false);
  assert.equal(body.refresh.after.refresh_token_expires_at, new Date(1797193469000).toISOString());

  // La verificación usa el token nuevo.
  assert.equal(calls[1].query.access_token, NEW_AT);
  assert.equal(body.verification.ok, true);
});

test("refresh rechazado por AliExpress: no escribe nada en KV", async () => {
  const { env, req, writes, store } = setup(() => ({ type: "ISV", code: "InvalidRefreshToken", message: "invalid", request_id: "rx" }));
  const { res, body } = await run(refresh, req("refresh?product_id=1&country=US"), env);
  assert.equal(res.status, 502);
  assert.equal(body.error, "refresh_rejected");
  assert.deepEqual(writes, []);
  assert.equal(store["aliexpress:6341065104"].refresh_token, OLD_RT);
});

test("refresh: si KV falla tras el refresh responde 500 explicando la acción", async () => {
  const { env, req } = setup((c) => (c.url.pathname.endsWith("/refresh") ? { code: "0", access_token: NEW_AT, refresh_token: NEW_RT } : PRODUCT), { putFails: true });
  const { res, body } = await run(refresh, req("refresh?product_id=1&country=US"), env);
  assert.equal(res.status, 500);
  assert.equal(body.error, "kv_write_failed");
});

test("refresh exige product_id y country para verificar", async () => {
  const { env, req, calls } = setup(byMethod);
  assert.equal((await refresh({ request: req("refresh"), env })).status, 400);
  assert.equal(calls.length, 0);
});
