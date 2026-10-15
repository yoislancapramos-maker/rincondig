// Pruebas de functions/_middleware.js y _routes.json. Ejecutar con: node --test tests/middleware.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { onRequest, isPrivatePath } from "../functions/_middleware.js";

const call = async (path) => {
  let nextCalled = false;
  const res = await onRequest({ request: new Request("https://rincondig.pages.dev" + path), next: async () => { nextCalled = true; return new Response("ok"); } });
  return { status: res.status, nextCalled };
};

test("bloquea carpetas internas con 404 sin llegar al contenido", async () => {
  for (const p of ["/tests/pricing.test.mjs", "/lib/pricing.mjs", "/lib/aliexpress.mjs", "/scripts/x.mjs", "/functions/api/aliexpress/callback.js", "/tests", "/LIB/pricing.mjs", "/%74ests/x", "//tests/x", "/lib%2Fpricing.mjs", "/tests/%E0%A4%A"]) {
    const r = await call(p);
    assert.equal(r.status, 404, p);
    assert.equal(r.nextCalled, false, p);
  }
});

test("deja pasar el callback de AliExpress y rutas públicas", async () => {
  for (const p of ["/api/aliexpress/callback?code=x", "/", "/index.html", "/style.css", "/src/assets/logo.png", "/testsuite", "/library"]) {
    const r = await call(p);
    assert.equal(r.nextCalled, true, p);
  }
  assert.equal(isPrivatePath("/api/aliexpress/callback"), false);
});

test("_routes.json: el middleware solo corre en /api y carpetas privadas (la landing sigue estática)", () => {
  const routes = JSON.parse(readFileSync(new URL("../_routes.json", import.meta.url), "utf8"));
  assert.equal(routes.version, 1);
  assert.ok(routes.include.includes("/api/*"));
  for (const p of ["/tests/*", "/lib/*", "/scripts/*", "/functions/*"]) assert.ok(routes.include.includes(p), p);
  assert.ok(!routes.include.includes("/*"));
});

test("las rutas de prueba de AliExpress ya no existen en functions/", () => {
  for (const f of ["test-product", "quote", "benefits", "refresh", "admin-lib"]) {
    assert.throws(() => readFileSync(new URL(`../functions/api/aliexpress/${f}.js`, import.meta.url)), f);
  }
});
