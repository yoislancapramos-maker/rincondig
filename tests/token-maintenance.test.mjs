// Pruebas de lib/token-maintenance.mjs y del Worker programado.
// Ejecutar con: node --test tests/token-maintenance.test.mjs
// Solo valores ficticios: ningún secreto ni token real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DAY_MS, noticeStageFor, planAccount, runTokenMaintenance } from "../lib/token-maintenance.mjs";
import worker from "../workers/aliexpress-token-refresh/src/index.mjs";

const SECRET = "fake-secret-for-tests";
const OLD_AT = "FAKE_OLD_ACCESS_TOKEN_0123456789";
const OLD_RT = "FAKE_OLD_REFRESH_TOKEN_0123456789";
const NEW_AT = "FAKE_NEW_ACCESS_TOKEN_0123456789";
const NEW_RT = "FAKE_NEW_REFRESH_TOKEN_0123456789";
const SENSITIVE = [OLD_AT, OLD_RT, NEW_AT, NEW_RT, SECRET];

// Estado real de la cuenta el 15/10/2026 (fechas), con tokens ficticios.
const NOW = Date.parse("2026-10-15T12:00:00Z");
const ACCESS_EXP = Date.parse("2026-11-14T09:04:27Z");
const REFRESH_EXP = Date.parse("2026-12-13T20:24:29Z");
const account = (over = {}) => ({
  user_id: "6341065104", account: "cliente@example.com", access_token: OLD_AT, refresh_token: OLD_RT,
  expire_time: ACCESS_EXP, refresh_token_valid_time: REFRESH_EXP, obtained_at: 1792009470040, ...over,
});

function makeKv(records, { failPutPrefix } = {}) {
  const store = structuredClone(records);
  const ops = [];
  const kv = {
    store, ops,
    list: async ({ prefix, cursor }) => {
      const names = Object.keys(store).filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = names.slice(start, start + 2); // paginado pequeño para probar el cursor
      const done = start + 2 >= names.length;
      return { keys: page.map((name) => ({ name })), list_complete: done, cursor: done ? undefined : String(start + 2) };
    },
    get: async (k, type) => (k in store ? (type === "json" ? structuredClone(store[k]) : typeof store[k] === "string" ? store[k] : JSON.stringify(store[k])) : null),
    put: async (k, v, opts) => {
      if (failPutPrefix && k.startsWith(failPutPrefix)) throw new Error("kv down");
      ops.push(["put", k, opts || null]);
      store[k] = k.startsWith("lock:") ? v : JSON.parse(v);
    },
    delete: async (k) => { ops.push(["delete", k]); delete store[k]; },
  };
  return kv;
}

function env(kv, over = {}) {
  return { ALIEXPRESS_APP_KEY: "553836", ALIEXPRESS_APP_SECRET: SECRET, ALIEXPRESS_CALLBACK_URL: "https://rincondig.pages.dev/api/aliexpress/callback", ALIEXPRESS_TOKENS: kv, ...over };
}

function captureLog() {
  const lines = [];
  const fn = (...a) => lines.push(a.join(" "));
  return { lines, log: { log: fn, warn: fn, error: fn } };
}

function mockRefresh(response) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: new URL(String(url)), body: Object.fromEntries(new URLSearchParams(init.body)) });
    return new Response(JSON.stringify(typeof response === "function" ? response() : response));
  };
  return calls;
}

function assertNoSecrets(...texts) {
  for (const t of texts) for (const s of SENSITIVE) assert.ok(!t.includes(s), "se expuso un valor sensible");
}

test("etapas de aviso: 14, 7, 3 y 1 días antes del vencimiento del refresh token", () => {
  assert.equal(noticeStageFor(59), null);
  assert.equal(noticeStageFor(14), "14d");
  assert.equal(noticeStageFor(10.5), "14d");
  assert.equal(noticeStageFor(6.9), "7d");
  assert.equal(noticeStageFor(2), "3d");
  assert.equal(noticeStageFor(0.5), "1d");
  assert.equal(noticeStageFor(0), "expired");
  assert.equal(noticeStageFor(null), null);
});

test("estado real de hoy: no renueva (vence en 30 días) ni avisa (faltan 59 días)", async () => {
  const kv = makeKv({ "aliexpress:6341065104": account() });
  const calls = mockRefresh({});
  const { log, lines } = captureLog();
  const status = await runTokenMaintenance(env(kv), { now: NOW, log });

  assert.equal(calls.length, 0);
  assert.deepEqual(kv.ops, [["put", "status:token-refresh", null]]);
  assert.equal(status.accounts, 1);
  assert.equal(status.results[0].action, "none");
  assert.equal(status.results[0].days_to_reauthorize, 59);
  assert.equal(kv.store["aliexpress:6341065104"].access_token, OLD_AT);
  assertNoSecrets(JSON.stringify(status), lines.join("\n"));
});

test("vence en menos de 7 días: bloquea, renueva con respaldo, libera el bloqueo y registra sin tokens", async () => {
  const kv = makeKv({ "aliexpress:6341065104": account({ expire_time: NOW + 3 * DAY_MS }) });
  const calls = mockRefresh({ code: "0", request_id: "rr", access_token: NEW_AT, refresh_token: NEW_RT, expire_time: NOW + 30 * DAY_MS, refresh_token_valid_time: REFRESH_EXP });
  const { log, lines } = captureLog();
  const status = await runTokenMaintenance(env(kv), { now: NOW, log });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/rest/auth/token/refresh");
  assert.equal(calls[0].body.refresh_token, OLD_RT);

  const keys = kv.ops.map((o) => `${o[0]}:${o[1]}`);
  assert.deepEqual(keys, [
    "put:lock:aliexpress:6341065104",
    "put:backup:aliexpress:6341065104:1792009470040",
    "put:aliexpress:6341065104",
    "delete:lock:aliexpress:6341065104",
    "put:status:token-refresh",
  ]);
  assert.deepEqual(kv.ops[0][2], { expirationTtl: 600 });
  assert.equal(kv.store["aliexpress:6341065104"].access_token, NEW_AT);
  assert.equal(kv.store["backup:aliexpress:6341065104:1792009470040"].access_token, OLD_AT);
  assert.equal(status.refreshed, 1);
  assert.equal(status.results[0].action, "refreshed");
  assert.equal(status.results[0].refresh_token_expiry_extended, false);
  assert.equal(status.results[0].access_token_expires_at, new Date(NOW + 30 * DAY_MS).toISOString());
  assertNoSecrets(JSON.stringify(status), lines.join("\n"));
});

test("renovación rechazada: no toca tokens, registra el error y sigue", async () => {
  const kv = makeKv({ "aliexpress:6341065104": account({ expire_time: NOW + DAY_MS }) });
  mockRefresh({ type: "ISV", code: "InvalidRefreshToken", message: "invalid", request_id: "rx" });
  const { log, lines } = captureLog();
  const status = await runTokenMaintenance(env(kv), { now: NOW, log });

  assert.equal(kv.store["aliexpress:6341065104"].refresh_token, OLD_RT);
  assert.ok(!kv.ops.some(([op, k]) => op === "put" && k.startsWith("backup:")));
  assert.equal(status.failed, 1);
  assert.equal(status.results[0].error_code, "InvalidRefreshToken");
  assert.equal(kv.store["lock:aliexpress:6341065104"], undefined);
  assert.match(lines.join("\n"), /InvalidRefreshToken request_id=rx/);
  assertNoSecrets(JSON.stringify(status), lines.join("\n"));
});

test("bloqueo activo: no renueva (evita renovaciones simultáneas)", async () => {
  const kv = makeKv({ "aliexpress:6341065104": account({ expire_time: NOW + DAY_MS }), "lock:aliexpress:6341065104": "123" });
  const calls = mockRefresh({});
  const status = await runTokenMaintenance(env(kv), { now: NOW, log: captureLog().log });
  assert.equal(calls.length, 0);
  assert.equal(status.skipped_locked, 1);
  assert.equal(kv.store["lock:aliexpress:6341065104"], "123");
});

test("fallo de KV al guardar: la ejecución continúa y deja el estado", async () => {
  const kv = makeKv({ "aliexpress:6341065104": account({ expire_time: NOW + DAY_MS }) }, { failPutPrefix: "backup:" });
  mockRefresh({ code: "0", access_token: NEW_AT, refresh_token: NEW_RT });
  const { log, lines } = captureLog();
  const status = await runTokenMaintenance(env(kv), { now: NOW, log });
  assert.equal(status.failed, 1);
  assert.equal(status.results[0].error, "unexpected_error");
  assert.equal(kv.store["aliexpress:6341065104"].access_token, OLD_AT);
  assert.ok(kv.store["status:token-refresh"]);
  assert.equal(kv.store["lock:aliexpress:6341065104"], undefined);
  assertNoSecrets(JSON.stringify(status), lines.join("\n"));
});

test("avisos: uno por etapa, sin duplicados, y se resuelven al reautorizar", async () => {
  const kv = makeKv({ "aliexpress:6341065104": account() });
  mockRefresh({});
  const run = (now) => runTokenMaintenance(env(kv), { now, log: captureLog().log });

  let s = await run(REFRESH_EXP - 13 * DAY_MS);
  let n = kv.store["notice:aliexpress:6341065104"];
  assert.equal(s.notices, 1);
  assert.equal(n.stage, "14d");
  assert.equal(n.status, "pending_reauthorization");
  assert.equal(n.deadline, "2026-12-13T20:24:29.000Z");
  assert.equal(n.reauthorize_url, "https://api-sg.aliexpress.com/oauth/authorize?response_type=code&force_auth=true&redirect_uri=https%3A%2F%2Frincondig.pages.dev%2Fapi%2Faliexpress%2Fcallback&client_id=553836");
  assertNoSecrets(JSON.stringify(n));

  s = await run(REFRESH_EXP - 12 * DAY_MS);
  assert.equal(s.notices, 0);

  await run(REFRESH_EXP - 6 * DAY_MS);
  assert.deepEqual(kv.store["notice:aliexpress:6341065104"].stages_sent, ["14d", "7d"]);

  // El cliente reautoriza: el callback guarda un vencimiento nuevo.
  kv.store["aliexpress:6341065104"] = account({ refresh_token_valid_time: REFRESH_EXP + 60 * DAY_MS, expire_time: REFRESH_EXP + 30 * DAY_MS });
  await run(REFRESH_EXP - 5 * DAY_MS);
  n = kv.store["notice:aliexpress:6341065104"];
  assert.equal(n.status, "resolved");
});

test("refresh token vencido: no intenta renovar y marca reautorización obligatoria", async () => {
  const kv = makeKv({ "aliexpress:6341065104": account({ expire_time: NOW - DAY_MS, refresh_token_valid_time: NOW - 1000 }) });
  const calls = mockRefresh({});
  const status = await runTokenMaintenance(env(kv), { now: NOW, log: captureLog().log });
  assert.equal(calls.length, 0);
  assert.equal(status.results[0].action, "reauthorization_required");
  assert.equal(kv.store["notice:aliexpress:6341065104"].status, "expired");
});

test("sin ALIEXPRESS_APP_SECRET: no llama a AliExpress pero prepara avisos", async () => {
  const kv = makeKv({ "aliexpress:6341065104": account({ expire_time: NOW + DAY_MS, refresh_token_valid_time: NOW + 2 * DAY_MS }) });
  const calls = mockRefresh({});
  const { log, lines } = captureLog();
  const status = await runTokenMaintenance(env(kv, { ALIEXPRESS_APP_SECRET: undefined }), { now: NOW, log });
  assert.equal(calls.length, 0);
  assert.equal(status.configured, false);
  assert.equal(status.results[0].action, "refresh_skipped_missing_config");
  assert.equal(kv.store["notice:aliexpress:6341065104"].stage, "3d");
  assert.match(lines.join("\n"), /falta ALIEXPRESS_APP_KEY o ALIEXPRESS_APP_SECRET/);
});

test("solo procesa cuentas aliexpress:<id> (ignora respaldos, avisos, bloqueos y estado) con paginado", async () => {
  const kv = makeKv({
    "aliexpress:1": account({ user_id: "1" }), "aliexpress:2": account({ user_id: "2" }), "aliexpress:3": account({ user_id: "3" }),
    "backup:aliexpress:1:1": account(), "notice:aliexpress:9": {}, "status:token-refresh": {},
  });
  mockRefresh({});
  const status = await runTokenMaintenance(env(kv), { now: NOW, log: captureLog().log });
  assert.equal(status.accounts, 3);
  assert.deepEqual(status.results.map((r) => r.user_id), ["1", "2", "3"]);
});

test("Worker: solo handler scheduled (sin URL) y usa la hora del cron", async () => {
  assert.equal(typeof worker.scheduled, "function");
  assert.equal(worker.fetch, undefined);
  const kv = makeKv({ "aliexpress:6341065104": account() });
  mockRefresh({});
  const orig = console.log;
  console.log = () => {};
  try {
    await worker.scheduled({ scheduledTime: NOW, cron: "0 */6 * * *" }, env(kv), {});
  } finally {
    console.log = orig;
  }
  assert.equal(kv.store["status:token-refresh"].ran_at, new Date(NOW).toISOString());
});

test("wrangler.jsonc: cron cada 6 h, KV correcto, sin URL pública y sin secretos", () => {
  const raw = readFileSync(new URL("../workers/aliexpress-token-refresh/wrangler.jsonc", import.meta.url), "utf8");
  const cfg = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""));
  assert.deepEqual(cfg.triggers.crons, ["0 */6 * * *"]);
  assert.deepEqual(cfg.kv_namespaces, [{ binding: "ALIEXPRESS_TOKENS", id: "2a909fd1e8be4f68a708ce18a5b4a6e1" }]);
  assert.equal(cfg.workers_dev, false);
  assert.equal(cfg.preview_urls, false);
  assert.equal(cfg.vars.ALIEXPRESS_APP_SECRET, undefined);
  assert.ok(!/APP_SECRET"\s*:/.test(raw));
});
