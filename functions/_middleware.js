// Bloquea la publicación de carpetas internas del repositorio.
// El sitio se publica desde la raíz del repo, así que sin esto /tests, /lib, /scripts y
// /functions se servirían como archivos estáticos. _routes.json limita este middleware
// a /api/* y a esas carpetas: la landing sigue siendo estática y no invoca funciones.

const PRIVATE_PREFIXES = ["/tests/", "/lib/", "/scripts/", "/functions/"];

export function isPrivatePath(pathname) {
  let path;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return true;
  }
  path = path.replace(/\\/g, "/").replace(/\/{2,}/g, "/").toLowerCase();
  return PRIVATE_PREFIXES.some((p) => path === p.slice(0, -1) || path.startsWith(p));
}

export async function onRequest({ request, next }) {
  if (isPrivatePath(new URL(request.url).pathname)) {
    return new Response("Not Found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=UTF-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
    });
  }
  return next();
}
