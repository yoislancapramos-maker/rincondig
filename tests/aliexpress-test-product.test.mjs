// Pruebas del endpoint de solo lectura /api/aliexpress/test-product.
// Ejecutar con: node --test tests/aliexpress-test-product.test.mjs
// Solo usa valores ficticios: ningún secreto ni token real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { onRequestGet, buildProductRequest } from "../functions/api/aliexpress/test-product.js";

const ADMIN_KEY = "fake-admin-key-for-tests";
const FAKE_SECRET = "fake-secret-for-tests";
const FAKE_AT = "FAKE_ACCESS_TOKEN_0123456789";
const FAKE_RT = "FAKE_REFRESH_TOKEN_0123456789";
const ACCOUNT = "6341065104";

// Firma de referencia para Business Interfaces calculada con node:crypto (sin ruta antepuesta).
function referenceSign(params, secret) {
  const base = Object.keys(params).sort().map((k) => k + params[k]).join("");
  return createHmac("sha256", secret).update(base, "utf8").digest("hex").toUpperCase();
}

const PRODUCT_OK = {
  aliexpress_ds_product_get_response: {
    rsp_code: 200,
    rsp_msg: "call success",
    request_id: "req-ok",
    result: {
      ae_item_base_info_dto: { product_id: 1005004638293060, subject: "Producto de prueba", product_status_type: "onSelling", currency_code: "USD" },
      ae_store_info: { store_name: "Tienda de prueba", store_id: 1 },
      ae_item_sku_info_dtos: [
        { sku_id: "1", offer_sale_price: "7.50", sku_price: "9.00", currency_code: "USD" },
        { sku_id: "2", offer_sale_price: "5.25", sku_price: "6.00", currency_code: "USD" },
      ],
      logistics_info_dto: { ship_to_country: "UY", delivery_time: 15 },
    },
  },
};

function setup({ response = PRODUCT_OK, accounts = [ACCOUNT], env: envOverrides = {} } = {}) {
  const writes = [];
  const calls = [];
  const records = Object.fromEntries(
    accounts.map((id) => [
      `aliexpress:${id}`,
      { user_id: id, account_platform: "buyerApp", access_token: FAKE_AT, refresh_token: FAKE_RT, expire_time: 1794601469000 },
    ])
  );
  const kv = {
    list: async ({ prefix }) => ({ keys: Object.keys(records).filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }),
    get: async (k, type) => (records[k] ? (type === "json" ? records[k] : JSON.stringify(records[k])) : null),
    put: async (...a) => writes.push(["put", ...a]),
    delete: async (...a) => writes.push(["delete", ...a]),
  };
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (response instanceof Error) throw response;
    return new Response(typeof response === "string" ? response : JSON.stringify(response), { status: 200 });
  };
  const env = {
    ALIEXPRESS_APP_KEY: "553836",
    ALIEXPRESS_APP_SECRET: FAKE_SECRET,
    ALIEXPRESS_ADMIN_KEY: ADMIN_KEY,
    ALIEXPRESS_TOKENS: kv,
    ...envOverrides,
  };
  const call = (query = "", auth = `Bearer ${ADMIN_KEY}`) =>
    onRequestGet({
      request: new Request("https://rincondig.pages.dev/api/aliexpress/test-product" + query, { headers: auth ? { Authorization: auth } : {} }),
      env,
    });
  return { call, calls, writes };
}

// Captura console.error/console.warn/console.log para verificar que no se filtran secretos.
async function captureLogs(fn) {
  const logs = [];
  const orig = { error: console.error, warn: console.warn, log: console.log };
  console.error = console.warn = console.log = (...a) => logs.push(a.join(" "));
  try {
    return { result: await fn(), logs };
  } finally {
    Object.assign(console, orig);
  }
}

function assertNoSecrets(text) {
  for (const s of [FAKE_AT, FAKE_RT, FAKE_SECRET, ADMIN_KEY]) {
    assert.ok(!text.includes(s), "se filtró un valor sensible");
  }
}

test("sin ALIEXPRESS_ADMIN_KEY configurada responde 404 y no llama a AliExpress", async () => {
  const { call, calls } = setup({ env: { ALIEXPRESS_ADMIN_KEY: undefined } });
  const res = await call();
  assert.equal(res.status, 404);
  assert.equal(calls.length, 0);
});

test("sin cabecera, con clave incorrecta o con la clave en la URL responde 404", async () => {
  const { call, calls } = setup();
  assert.equal((await call("", null)).status, 404);
  assert.equal((await call("", "Bearer otra-clave")).status, 404);
  assert.equal((await call("", ADMIN_KEY)).status, 404);
  assert.equal((await call(`?key=${ADMIN_KEY}`, null)).status, 404);
  assert.equal(calls.length, 0);
});

test("consulta 1005004638293060 a UY con aliexpress.ds.product.get firmada correctamente", async () => {
  const { call, calls } = setup();
  const res = await call();
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);

  const { url, init } = calls[0];
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, "https://api-sg.aliexpress.com/sync");
  assert.equal(init.method, "POST");
  assert.equal(init.headers["Content-Type"], "application/x-www-form-urlencoded;charset=UTF-8");
  assert.deepEqual([...u.searchParams.keys()].sort(), ["access_token", "app_key", "method", "sign", "sign_method", "timestamp"]);
  assert.equal(u.searchParams.get("method"), "aliexpress.ds.product.get");
  assert.match(u.searchParams.get("timestamp"), /^\d{13}$/);

  const body = Object.fromEntries(new URLSearchParams(init.body));
  assert.deepEqual(body, { product_id: "1005004638293060", ship_to_country: "UY", target_currency: "USD", target_language: "es" });

  const { sign: sg, ...system } = Object.fromEntries(u.searchParams);
  assert.equal(sg, referenceSign({ ...system, ...body }, FAKE_SECRET));
});

test("la firma de buildProductRequest coincide con la referencia independiente", async () => {
  const business = { product_id: "1005004638293060", ship_to_country: "UY", target_currency: "USD", target_language: "es" };
  const req = await buildProductRequest(business, "553836", FAKE_SECRET, FAKE_AT, 1792008450424);
  const expected = referenceSign(
    { app_key: "553836", access_token: FAKE_AT, method: "aliexpress.ds.product.get", sign_method: "sha256", timestamp: "1792008450424", ...business },
    FAKE_SECRET
  );
  assert.equal(new URL(req.url).searchParams.get("sign"), expected);
});

test("éxito: devuelve solo un resumen del producto, sin tokens ni secretos", async () => {
  const { call } = setup();
  const { result: res, logs } = await captureLogs(() => call());
  const text = await res.text();
  const body = JSON.parse(text);

  assert.equal(body.ok, true);
  assert.equal(body.request_id, "req-ok");
  assert.deepEqual(body.product, {
    product_id: 1005004638293060,
    title: "Producto de prueba",
    status: "onSelling",
    store_name: "Tienda de prueba",
    sku_count: 2,
    min_price: 5.25,
    currency: "USD",
    ship_to_country: "UY",
    delivery_time_days: 15,
  });
  assert.equal(body.account.user_id, ACCOUNT);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assertNoSecrets(text);
  assertNoSecrets(logs.join("\n"));
});

test("nunca escribe ni borra en KV (éxito y error)", async () => {
  for (const response of [PRODUCT_OK, { code: "InsufficientPermission", message: "x", request_id: "r" }, new Error("network")]) {
    const { call, writes } = setup({ response });
    await captureLogs(() => call());
    assert.deepEqual(writes, []);
  }
});

test("errores de AliExpress se informan sin exponer secretos", async () => {
  const cases = [
    [{ type: "ISV", code: "InsufficientPermission", message: "Insufficient permission", request_id: "r1" }, "InsufficientPermission"],
    // Formato real observado en el gateway /sync.
    [{ error_response: { type: "ISV", code: "IllegalAccessToken", msg: "The specified access token is invalid or expired", request_id: "r2" } }, "IllegalAccessToken"],
    [{ aliexpress_ds_product_get_response: { rsp_code: 402, rsp_msg: "ITEM_ID_NOT_FOUND", request_id: "r3" } }, "402"],
  ];
  for (const [response, code] of cases) {
    const { call } = setup({ response });
    const { result: res, logs } = await captureLogs(() => call());
    const text = await res.text();
    const body = JSON.parse(text);
    assert.equal(res.status, 502);
    assert.equal(body.error_code, code);
    assert.ok(body.error_message);
    assert.ok(body.request_id);
    assertNoSecrets(text);
    assertNoSecrets(logs.join("\n"));
  }
});

test("fallo de red o respuesta no JSON → 502 sin exponer secretos", async () => {
  for (const response of [new Error(`boom ${FAKE_AT}`), "<html>gateway</html>"]) {
    const { call } = setup({ response });
    const { result: res, logs } = await captureLogs(() => call());
    const text = await res.text();
    assert.equal(res.status, 502);
    assertNoSecrets(text);
    assertNoSecrets(logs.join("\n"));
  }
});

test("parámetros inválidos → 400 sin llamar a AliExpress", async () => {
  const { call, calls } = setup();
  assert.equal((await call("?product_id=abc")).status, 400);
  assert.equal((await call("?country=URU")).status, 400);
  assert.equal((await call("?account=x")).status, 400);
  assert.equal(calls.length, 0);
});

test("con varias cuentas en KV exige ?account= y la usa", async () => {
  const { call, calls } = setup({ accounts: [ACCOUNT, "999"] });
  const res = await call();
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(await res.text()).error, "multiple_accounts_specify_account");
  assert.equal((await call(`?account=${ACCOUNT}`)).status, 200);
  assert.equal(calls.length, 1);
  assert.equal((await call("?account=123")).status, 404);
});
