// Mantenimiento programado de tokens de AliExpress (lo ejecuta el Worker con cron).
//
// - Renueva el access token de las cuentas que vencen en menos de 7 días, mientras el
//   refresh token siga vigente. KV solo se actualiza si la renovación funciona y siempre
//   con respaldo previo (refreshAccount en lib/aliexpress.mjs).
// - Evita renovaciones simultáneas con un bloqueo por cuenta en KV que expira solo.
// - Prepara avisos de reautorización: el refresh token NO extiende su vencimiento al
//   renovar (comprobado el 15/10/2026), así que cada cliente debe reautorizar antes de que
//   venza. Los avisos quedan en KV (notice:aliexpress:<user_id>), sin enviarse todavía.
// - Nunca registra ni guarda en el estado tokens o secretos.

import { buildAuthorizeUrl, refreshAccount, toIso } from "./aliexpress.mjs";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULTS = {
  refreshWithinMs: 7 * DAY_MS,
  noticeDays: [14, 7, 3, 1],
  lockTtlSeconds: 600,
};

const ACCOUNT_KEY = /^aliexpress:\d{1,20}$/;
const STATUS_KEY = "status:token-refresh";

// Decide qué hacer con una cuenta, sin efectos.
export function planAccount(stored, now, opts = DEFAULTS) {
  const accessExpiresAt = Number(stored.expire_time) || 0;
  const refreshExpiresAt = Number(stored.refresh_token_valid_time) || 0;
  const refreshTokenValid = Boolean(stored.refresh_token) && refreshExpiresAt > now;
  const daysToReauth = refreshExpiresAt ? (refreshExpiresAt - now) / DAY_MS : null;
  return {
    refreshDue: refreshTokenValid && accessExpiresAt - now < opts.refreshWithinMs,
    refreshTokenValid,
    daysToReauth,
    noticeStage: noticeStageFor(daysToReauth, opts.noticeDays),
  };
}

// Etapa de aviso más urgente alcanzada: "14d", "7d", "3d", "1d", "expired" o null.
export function noticeStageFor(daysLeft, noticeDays = DEFAULTS.noticeDays) {
  if (daysLeft === null) return null;
  if (daysLeft <= 0) return "expired";
  const crossed = noticeDays.filter((d) => daysLeft <= d);
  return crossed.length ? `${Math.min(...crossed)}d` : null;
}

// Crea o actualiza el aviso solo cuando aparece una etapa nueva para el mismo vencimiento.
export async function updateNotice(kv, stored, stage, { now, reauthorizeUrl }) {
  const key = `notice:aliexpress:${stored.user_id}`;
  const existing = await kv.get(key, "json");
  const validity = Number(stored.refresh_token_valid_time) || null;
  const sameCycle = existing && existing.refresh_token_valid_time === validity;

  if (!stage) {
    // Reautorizó (vencimiento nuevo) o todavía falta: un aviso viejo queda como resuelto.
    if (existing && !sameCycle && existing.status !== "resolved") {
      await kv.put(key, JSON.stringify({ ...existing, status: "resolved", resolved_at: now }));
      return "resolved";
    }
    return null;
  }

  const history = sameCycle ? existing.stages_sent || [] : [];
  if (history.includes(stage)) return null;

  await kv.put(key, JSON.stringify({
    user_id: stored.user_id,
    account: stored.account ?? null,
    status: stage === "expired" ? "expired" : "pending_reauthorization",
    stage,
    stages_sent: [...history, stage],
    deadline: toIso(validity),
    refresh_token_valid_time: validity,
    reauthorize_url: reauthorizeUrl,
    created_at: sameCycle ? existing.created_at : now,
    updated_at: now,
    delivery: "pendiente: canal de envío (email/WhatsApp) no configurado",
  }));
  return stage;
}

async function listAccountKeys(kv) {
  const keys = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: "aliexpress:", cursor });
    keys.push(...page.keys.map((k) => k.name).filter((n) => ACCOUNT_KEY.test(n)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return keys;
}

async function withLock(kv, key, ttlSeconds, fn) {
  const lockKey = `lock:${key}`;
  if (await kv.get(lockKey)) return { locked: true };
  await kv.put(lockKey, String(Date.now()), { expirationTtl: Math.max(60, ttlSeconds) });
  try {
    return { locked: false, value: await fn() };
  } finally {
    await kv.delete(lockKey);
  }
}

export async function runTokenMaintenance(env, { now = Date.now(), opts = DEFAULTS, log = console } = {}) {
  const kv = env.ALIEXPRESS_TOKENS;
  const configured = Boolean(env.ALIEXPRESS_APP_KEY && env.ALIEXPRESS_APP_SECRET);
  const reauthorizeUrl = env.ALIEXPRESS_APP_KEY && env.ALIEXPRESS_CALLBACK_URL
    ? buildAuthorizeUrl(env.ALIEXPRESS_APP_KEY.trim(), env.ALIEXPRESS_CALLBACK_URL)
    : null;

  const status = { ran_at: toIso(now), configured, accounts: 0, refreshed: 0, failed: 0, skipped_locked: 0, notices: 0, results: [] };
  if (!configured) log.error("AliExpress token-refresh: falta ALIEXPRESS_APP_KEY o ALIEXPRESS_APP_SECRET; no se renovará ningún token");

  for (const key of await listAccountKeys(kv)) {
    const stored = await kv.get(key, "json");
    if (!stored) continue;
    status.accounts++;
    let current = stored;
    const plan = planAccount(stored, now, opts);
    const result = { user_id: stored.user_id ?? null, action: "none" };

    if (plan.refreshDue && configured) {
      let locked;
      try {
        locked = await withLock(kv, key, opts.lockTtlSeconds, () => refreshAccount(env, key, { now }));
      } catch (err) {
        // Falla de KV o respuesta ilegible: se registra y se sigue con las demás cuentas.
        locked = { locked: false, value: { ok: false, error: "unexpected_error", error_code: err.name } };
      }
      if (locked.locked) {
        result.action = "skipped_locked";
        status.skipped_locked++;
      } else if (locked.value.ok) {
        result.action = "refreshed";
        status.refreshed++;
        current = { ...stored, expire_time: Date.parse(locked.value.summary.after.access_token_expires_at) || stored.expire_time };
        result.request_id = locked.value.summary.request_id;
        result.refresh_token_expiry_extended = locked.value.summary.refresh_token_expiry_extended;
      } else {
        result.action = "refresh_failed";
        status.failed++;
        result.error = locked.value.error;
        result.error_code = locked.value.error_code ?? null;
        result.request_id = locked.value.request_id ?? null;
        log.error(`AliExpress token-refresh: ${result.user_id} ${result.error} ${result.error_code || ""} request_id=${result.request_id || "-"}`);
      }
    } else if (plan.refreshDue) {
      result.action = "refresh_skipped_missing_config";
    } else if (!plan.refreshTokenValid) {
      result.action = "reauthorization_required";
    }

    const notice = await updateNotice(kv, stored, plan.noticeStage, { now, reauthorizeUrl });
    if (notice && notice !== "resolved") status.notices++;
    if (notice) log.warn(`AliExpress token-refresh: aviso ${notice} para ${result.user_id}; reautorizar antes de ${toIso(stored.refresh_token_valid_time)}`);

    Object.assign(result, {
      access_token_expires_at: toIso(current.expire_time),
      refresh_token_expires_at: toIso(stored.refresh_token_valid_time),
      days_to_reauthorize: plan.daysToReauth === null ? null : Math.floor(plan.daysToReauth),
      notice_stage: plan.noticeStage,
    });
    status.results.push(result);
  }

  await kv.put(STATUS_KEY, JSON.stringify(status));
  log.log(`AliExpress token-refresh: cuentas=${status.accounts} renovadas=${status.refreshed} fallidas=${status.failed} bloqueadas=${status.skipped_locked} avisos=${status.notices}`);
  return status;
}
