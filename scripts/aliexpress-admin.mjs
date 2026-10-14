// Herramienta local para la prueba de solo lectura /api/aliexpress/test-product.
// Evita copiar la clave de administración a mano entre la terminal y Cloudflare:
// la clave se genera acá, se guarda fuera del repositorio y se envía a Cloudflare
// por stdin de wrangler. Nunca se imprime.
//
// Uso:
//   node scripts/aliexpress-admin.mjs rotate
//       Genera una clave nueva (64 hex), la carga como secreto ALIEXPRESS_ADMIN_KEY
//       del proyecto Pages "rincondig" y la guarda en ~/.rincondig/aliexpress-admin-key.
//       Cloudflare la aplica en el siguiente deploy.
//   node scripts/aliexpress-admin.mjs test [product_id] [country] [account]
//       Llama al endpoint con la clave guardada y muestra estado HTTP y cuerpo JSON.

import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const KEY_FILE = process.env.RD_ADMIN_KEY_FILE || join(homedir(), ".rincondig", "aliexpress-admin-key");
const PROJECT_NAME = "rincondig";
const SECRET_NAME = "ALIEXPRESS_ADMIN_KEY";
const ENDPOINT = "https://rincondig.pages.dev/api/aliexpress/test-product";
const WRANGLER = "wrangler@4.40.0";

export function generateAdminKey() {
  return randomBytes(32).toString("hex");
}

// Solo ASCII visible: un carácter de control en la cabecera hace que Cloudflare
// responda 400 con cuerpo vacío sin ejecutar la función.
export function assertSafeKey(key) {
  if (typeof key !== "string" || !/^[\x21-\x7E]{32,256}$/.test(key)) {
    throw new Error("La clave de administración tiene caracteres no válidos o una longitud incorrecta. Ejecutá: node scripts/aliexpress-admin.mjs rotate");
  }
  return key;
}

export function buildTestUrl({ product_id, country, account } = {}) {
  const url = new URL(ENDPOINT);
  for (const [name, value, pattern] of [
    ["product_id", product_id, /^\d{1,20}$/],
    ["country", country, /^[A-Za-z]{2}$/],
    ["account", account, /^\d{1,20}$/],
  ]) {
    if (value === undefined) continue;
    if (!pattern.test(value)) throw new Error(`Parámetro inválido: ${name}`);
    url.searchParams.set(name, value);
  }
  return url.href;
}

// Traduce la respuesta a un diagnóstico legible.
export function explain(status, headers, body) {
  const fromFunction = (headers.get("server") || "").toLowerCase() === "cloudflare";
  if (status === 400 && !body && !fromFunction) {
    return "Cloudflare rechazó la solicitud antes de ejecutar la función (cabecera o URL con caracteres no válidos).";
  }
  if (status === 404 && body.trim() === "Not Found") {
    return "La clave no coincide con ALIEXPRESS_ADMIN_KEY en Cloudflare, o el secreto nuevo todavía no está desplegado.";
  }
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return `Respuesta no JSON (HTTP ${status}).`;
  }
  if (data.ok) return "AliExpress devolvió el producto: token, firma y permisos Drop Shipping funcionan.";
  return `Error ${data.error_code || data.error}${data.error_message ? `: ${data.error_message}` : ""}`;
}

function readKey() {
  let key;
  try {
    key = readFileSync(KEY_FILE, "utf8").trim();
  } catch {
    throw new Error(`No existe ${KEY_FILE}. Ejecutá primero: node scripts/aliexpress-admin.mjs rotate`);
  }
  return assertSafeKey(key);
}

function rotate() {
  const key = generateAdminKey();
  // shell: true para resolver npx.cmd en Windows; los argumentos son fijos y la clave va por stdin.
  const result = spawnSync("npx", ["-y", WRANGLER, "pages", "secret", "put", SECRET_NAME, "--project-name", PROJECT_NAME], {
    input: key,
    stdio: ["pipe", "inherit", "inherit"],
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error("wrangler no pudo cargar el secreto (¿sesión iniciada? ejecutá: npx wrangler login). La clave anterior no se modificó.");
  }
  mkdirSync(dirname(KEY_FILE), { recursive: true });
  writeFileSync(KEY_FILE, key, { encoding: "utf8", mode: 0o600 });
  console.log(`Clave nueva cargada en Cloudflare (${SECRET_NAME}) y guardada en ${KEY_FILE}.`);
  console.log("Se aplica en el próximo deploy de producción.");
}

async function test([productId, country, account]) {
  const key = readKey();
  const url = buildTestUrl({ product_id: productId, country, account });
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  const body = await res.text();
  console.log(`HTTP ${res.status} ${res.statusText}`);
  console.log(`cf-ray: ${res.headers.get("cf-ray") || "-"}`);
  console.log(`Diagnóstico: ${explain(res.status, res.headers, body)}`);
  if (body) console.log(body);
  process.exitCode = res.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "rotate") rotate();
    else if (command === "test") await test(args);
    else {
      console.log("Uso: node scripts/aliexpress-admin.mjs rotate | test [product_id] [country] [account]");
      process.exitCode = 2;
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
