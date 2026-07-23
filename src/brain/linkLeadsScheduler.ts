/**
 * Corre el matching WhatsApp↔CRM (runLeadLinking, ver linkLeads.ts)
 * PERIÓDICAMENTE dentro del propio proceso, para no depender de que alguien
 * recuerde ejecutar scripts/link-leads.ts a mano — sin eso, un chat nuevo
 * (sobre todo los jids `@lid` sin teléfono) se queda sin ficha vinculada hasta
 * la próxima vez que alguien corra el script.
 *
 * Reusa la BD ya abierta del proceso (getDb()) — nunca abre una segunda
 * conexión. Mismas credenciales que el script manual (login contra el
 * dashboard vía DASH_EMAIL/DASH_PW); si no están configuradas, se desactiva
 * con un aviso — no rompe el arranque del sidecar (mismo patrón que
 * ensureClaudeAuth en src/brain/secrets.ts).
 */
import { getDb } from "../db/db";
import { runLeadLinking, type DatasetLead } from "./linkLeads";

const DASH_URL = process.env.DASH_URL ?? "http://localhost:3210";
const DASH_EMAIL = process.env.DASH_EMAIL;
const DASH_PW = process.env.DASH_PW;
const INTERVAL_MS = 20 * 60_000; // 20 min — suficiente para que un chat nuevo no tarde horas en tener ficha.

async function fetchLeads(): Promise<DatasetLead[] | null> {
  const login = await fetch(`${DASH_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: DASH_EMAIL, password: DASH_PW }),
  });
  if (!login.ok) {
    console.error(`[link-leads] login al dashboard falló: HTTP ${login.status}`);
    return null;
  }
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie.startsWith("csa_session=")) {
    console.error("[link-leads] login sin cookie de sesión.");
    return null;
  }
  const ds = (await (await fetch(`${DASH_URL}/api/dataset`, { headers: { cookie } })).json()) as {
    csaLeads?: DatasetLead[];
  };
  return ds.csaLeads ?? [];
}

async function tick(): Promise<void> {
  const leads = await fetchLeads();
  if (!leads) return;
  const r = runLeadLinking(getDb(), leads);
  console.log(
    `[link-leads] auto: ${r.linkCount} enlaces activos (${r.chatsLinkedByName} por nombre), ` +
      `${r.chatsAmbiguousByName} ambiguos sin linkar, ${r.removed} desactivados.`
  );
  if (r.ambiguous.length) {
    console.log(`[link-leads] ambiguos pendientes de resolver a mano: ${r.ambiguous.length}`);
  }
}

/** Arranca el matching periódico; no-op (con aviso) si faltan credenciales. */
export function startLeadLinkingScheduler(): void {
  if (!DASH_EMAIL || !DASH_PW) {
    console.log(
      "[link-leads] DASH_EMAIL/DASH_PW no configurados → matching automático desactivado " +
        "(usa `DASH_PW=… npx tsx scripts/link-leads.ts` a mano)."
    );
    return;
  }
  void tick().catch((e) => console.error("[link-leads] primera pasada falló:", (e as Error).message));
  setInterval(() => {
    void tick().catch((e) => console.error("[link-leads] tick falló:", (e as Error).message));
  }, INTERVAL_MS);
  console.log(`[link-leads] matching automático activo cada ${INTERVAL_MS / 60_000} min.`);
}
