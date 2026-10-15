// Pruebas de scripts/aliexpress-admin.mjs. Ejecutar con: node --test tests/aliexpress-admin-script.test.mjs
// Solo usa valores ficticios.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateAdminKey, assertSafeKey, buildTestUrl, explain } from "../scripts/aliexpress-admin.mjs";

test("genera claves hexadecimales de 64 caracteres, solo ASCII y distintas", () => {
  const a = generateAdminKey();
  const b = generateAdminKey();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
  assert.equal(assertSafeKey(a), a);
});

test("reproduce el caso real: clave con carácter de control (Ctrl+V en Read-Host = U+0016)", () => {
  const broken = "a".repeat(30) + "\u0016" + "b".repeat(33);
  // Cloudflare responde 400 sin cuerpo y sin ejecutar la función; el script lo detecta antes de enviar.
  assert.throws(() => assertSafeKey(broken), /caracteres no válidos/);
  // Node, igual que curl.exe, acepta y enviaría ese valor: la validación del script es la única barrera.
  assert.doesNotThrow(() => new Headers({ Authorization: `Bearer ${broken}` }));
});

test("rechaza otras claves inseguras", () => {
  for (const bad of ["", "corta", "x".repeat(40) + "\r", "x".repeat(40) + " y", "clavé".repeat(10), undefined]) {
    assert.throws(() => assertSafeKey(bad));
  }
});

test("la URL de prueba es ASCII y valida parámetros", () => {
  assert.equal(buildTestUrl(), "https://rincondig.pages.dev/api/aliexpress/test-product");
  assert.equal(
    buildTestUrl({ product_id: "1005004638293060", country: "UY", account: "6341065104" }),
    "https://rincondig.pages.dev/api/aliexpress/test-product?product_id=1005004638293060&country=UY&account=6341065104"
  );
  assert.throws(() => buildTestUrl({ account: "6341065104 " }));
  assert.throws(() => buildTestUrl({ country: "URY" }));
});

test("explica cada tipo de respuesta", () => {
  const h = (server) => new Headers(server ? { server } : {});
  assert.match(explain(400, h(null), ""), /antes de ejecutar la función/);
  assert.match(explain(404, h("cloudflare"), "Not Found"), /no coincide/);
  assert.match(explain(200, h("cloudflare"), JSON.stringify({ ok: true })), /devolvió el producto/);
  assert.match(
    explain(502, h("cloudflare"), JSON.stringify({ ok: false, error_code: "InsufficientPermission", error_message: "x" })),
    /InsufficientPermission: x/
  );
  assert.match(explain(400, h("cloudflare"), JSON.stringify({ ok: false, error: "invalid_parameters" })), /invalid_parameters/);
});

test("URLs de administración: rutas y parámetros permitidos, solo ASCII", async () => {
  const { buildAdminUrl } = await import("../scripts/aliexpress-admin.mjs");
  assert.equal(
    buildAdminUrl("quote", { product_id: "1005012996661961", country: "US", sku_id: "12000062", quantity: "2", currency: "USD" }),
    "https://rincondig.pages.dev/api/aliexpress/quote?product_id=1005012996661961&country=US&sku_id=12000062&quantity=2&currency=USD"
  );
  assert.equal(buildAdminUrl("refresh", { product_id: "1", country: "US" }), "https://rincondig.pages.dev/api/aliexpress/refresh?product_id=1&country=US");
  assert.throws(() => buildAdminUrl("callback", {}), /Ruta desconocida/);
  assert.throws(() => buildAdminUrl("quote", { token: "x" }), /Parámetro desconocido/);
  assert.throws(() => buildAdminUrl("quote", { currency: "U$D" }), /inválido/);
});
