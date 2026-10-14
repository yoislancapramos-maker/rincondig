// Pruebas del callback OAuth de AliExpress. Ejecutar con: node --test tests/aliexpress-callback.test.mjs
// Solo usa valores ficticios: ningún secreto ni token real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { onRequestGet, buildTokenRequest, sign } from "../functions/api/aliexpress/callback.js";

const API = "/auth/token/create";
const FAKE_SECRET = "fake-secret-for-tests";

// Firma de referencia calculada de forma independiente con node:crypto.
function referenceSign(params, secret) {
  const base = API + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return createHmac("sha256", secret).update(base, "utf8").digest("hex").toUpperCase();
}

test("firma coincide con el ejemplo oficial (docId=1385, System Interfaces)", async () => {
  const params = { app_key: "12345678", code: "3_500102_JxZ05Ux3cnnSSUm6dCxYg6Q26", sign_method: "sha256", timestamp: "1517820392000" };
  assert.equal(await sign(API, params, "helloworld"), "35607762342831B6A417A0DED84B79C05FEFBF116969C48AD6DC00279A9F4D81");
});

test("reproduce la solicitud /rest/auth/token/create del AppKey 553836 con el formato del SDK oficial", async () => {
  const code = "3_553836_FakeAuthCode0123456789";
  const timestamp = 1792008450424;
  const req = await buildTokenRequest(code, "553836", FAKE_SECRET, timestamp);

  const url = new URL(req.url);
  assert.equal(url.origin + url.pathname, "https://api-sg.aliexpress.com/rest/auth/token/create");
  assert.deepEqual([...url.searchParams.keys()].sort(), ["app_key", "sign", "sign_method", "timestamp"]);
  assert.equal(url.searchParams.get("app_key"), "553836");
  assert.equal(url.searchParams.get("sign_method"), "sha256");
  assert.equal(url.searchParams.get("timestamp"), String(timestamp));
  assert.match(url.searchParams.get("timestamp"), /^\d{13}$/);
  assert.equal(req.body, `code=${code}`);

  const expected = referenceSign({ app_key: "553836", code, sign_method: "sha256", timestamp: String(timestamp) }, FAKE_SECRET);
  assert.equal(url.searchParams.get("sign"), expected);
  assert.match(expected, /^[0-9A-F]{64}$/);
});

test("la firma se calcula sobre valores sin codificar aunque el transporte los codifique", async () => {
  const code = "3_553836_a+b/c=d";
  const req = await buildTokenRequest(code, "553836", FAKE_SECRET, 1792008450424);
  assert.equal(new URLSearchParams(req.body).get("code"), code);
  const expected = referenceSign({ app_key: "553836", code, sign_method: "sha256", timestamp: "1792008450424" }, FAKE_SECRET);
  assert.equal(new URL(req.url).searchParams.get("sign"), expected);
});

function setup(response, envOverrides = {}) {
  const store = {};
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(response), { status: 200 });
  };
  const env = {
    ALIEXPRESS_APP_KEY: "553836",
    ALIEXPRESS_APP_SECRET: FAKE_SECRET,
    ALIEXPRESS_TOKENS: { put: async (k, v) => { store[k] = v; } },
    ...envOverrides,
  };
  const call = (query) => onRequestGet({ request: new Request("https://rincondig.pages.dev/api/aliexpress/callback" + query), env });
  return { store, calls, call };
}

test("el callback envía POST form-urlencoded con code en el cuerpo y guarda tokens sin exponerlos", async () => {
  const { store, calls, call } = setup({ code: "0", access_token: "FAKE_AT", refresh_token: "FAKE_RT", user_id: "42" });
  const res = await call("?code=3_553836_FakeAuthCode");
  const html = await res.text();

  assert.equal(res.status, 200);
  assert.ok(store["aliexpress:42"]);
  assert.ok(!html.includes("FAKE_AT") && !html.includes("FAKE_RT"));

  const { url, init } = calls[0];
  assert.equal(init.method, "POST");
  assert.equal(init.headers["Content-Type"], "application/x-www-form-urlencoded;charset=UTF-8");
  assert.equal(init.body, "code=3_553836_FakeAuthCode");
  const q = new URL(url).searchParams;
  assert.equal(q.has("code"), false);
  const expected = referenceSign({ app_key: "553836", code: "3_553836_FakeAuthCode", sign_method: "sha256", timestamp: q.get("timestamp") }, FAKE_SECRET);
  assert.equal(q.get("sign"), expected);
});

test("espacios o saltos de línea en las variables de Cloudflare no alteran la firma", async () => {
  const { calls, call } = setup(
    { code: "0", access_token: "A", refresh_token: "R", user_id: "1" },
    { ALIEXPRESS_APP_KEY: " 553836\n", ALIEXPRESS_APP_SECRET: FAKE_SECRET + "\r\n" }
  );
  const warn = console.warn;
  console.warn = () => {};
  await call("?code=3_553836_FakeAuthCode");
  console.warn = warn;

  const q = new URL(calls[0].url).searchParams;
  assert.equal(q.get("app_key"), "553836");
  const expected = referenceSign({ app_key: "553836", code: "3_553836_FakeAuthCode", sign_method: "sha256", timestamp: q.get("timestamp") }, FAKE_SECRET);
  assert.equal(q.get("sign"), expected);
});

test("IncompleteSignature de AliExpress se informa como 502 sin exponer datos", async () => {
  const { store, call } = setup({ type: "ISV", code: "IncompleteSignature", message: "The request signature does not conform to platform standards", request_id: "0bafcbae17920084504245742" });
  const err = console.error;
  const logs = [];
  console.error = (...a) => logs.push(a.join(" "));
  const res = await call("?code=3_553836_FakeAuthCode");
  console.error = err;

  assert.equal(res.status, 502);
  assert.deepEqual(store, {});
  assert.match(logs[0], /IncompleteSignature/);
  assert.ok(!logs[0].includes(FAKE_SECRET));
});
