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
import { config } from "../config";
import { getDb, setMeta } from "../db/db";
import { runLeadLinking, type DatasetLead, type NoMatchChat } from "./linkLeads";

const DASH_URL = process.env.DASH_URL ?? "http://localhost:3210";
const DASH_EMAIL = process.env.DASH_EMAIL;
const DASH_PW = process.env.DASH_PW;
const INTERVAL_MS = 20 * 60_000; // 20 min — suficiente para que un chat nuevo no tarde horas en tener ficha.

// Fase 2 (auto-crear ficha): tope por pasada para no disparar decenas de
// llamadas al dashboard de golpe — el resto se recoge en la pasada siguiente.
const MAX_LEAD_CREATE_PER_TICK = 20;

/** Key de `meta` donde se persiste la última lista de ambiguos (leída por src/http/routes/linkLeads.ts). */
export const AMBIGUOUS_META_KEY = "link_leads_ambiguous";

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

/**
 * Fase 2 — para contactos genuinamente nuevos (sin teléfono NI nombre que case
 * con ningún lead, ver linkLeads.ts `noMatch`), pide al dashboard que cree una
 * ficha mínima. El endpoint es quien decide si escribe de verdad
 * (`AUTO_CREATE_LEADS_ENABLED`) o solo informa — aquí solo se acota CUÁNTAS
 * llamadas se hacen por pasada, no si escriben.
 *
 * Solo el subconjunto SIN teléfono (`phone === null`, la vía @lid/nombre): el
 * bucket "tiene teléfono pero no casa con ningún lead" es mucho más ruidoso
 * (puede ser cualquier número que le haya escrito a Fran, no necesariamente un
 * lead real) y queda fuera a propósito de esta primera versión.
 */
async function tryCreateNewLeads(noMatch: NoMatchChat[]): Promise<void> {
  const token = process.env.FRANSUA_INTERNAL_TOKEN;
  if (!token) return; // sin token no hay forma de llamar al dashboard con seguridad.
  const candidates = noMatch.filter((n) => n.phone === null && n.display_name?.trim());
  if (!candidates.length) return;

  const batch = candidates.slice(0, MAX_LEAD_CREATE_PER_TICK);
  let created = 0;
  let informed = 0;
  for (const c of batch) {
    try {
      const res = await fetch(`${config.dashboardUrl}/api/fransua/lead-create`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-fransua-token": token },
        body: JSON.stringify({ nombre: c.display_name, jid: c.jid }),
        signal: AbortSignal.timeout(8000),
      });
      const j = (await res.json().catch(() => null)) as { ok?: boolean; dryRun?: boolean; sourceRow?: number } | null;
      if (!res.ok || !j?.ok) continue;
      if (j.dryRun) {
        informed++;
        continue;
      }
      if (typeof j.sourceRow === "number") {
        const now = Math.floor(Date.now() / 1000);
        getDb()
          .prepare(
            `INSERT INTO chat_lead_links
               (chat_jid, source_row, phone_snapshot, lead_name_snapshot, method, status, created_at, updated_at)
             VALUES (@jid, @sourceRow, NULL, @name, 'auto', 'active', @now, @now)
             ON CONFLICT(chat_jid, source_row) DO UPDATE SET status='active', updated_at=excluded.updated_at`
          )
          .run({ jid: c.jid, sourceRow: j.sourceRow, name: c.display_name, now });
        created++;
      }
    } catch (e) {
      console.error(`[link-leads] lead-create falló para ${c.jid}:`, (e as Error).message);
    }
  }
  if (created > 0) console.log(`[link-leads] fichas nuevas creadas de verdad: ${created}.`);
  if (informed > 0) {
    console.log(
      `[link-leads] AUTO_CREATE_LEADS_ENABLED desactivado — ${informed} contactos nuevos detectados, ` +
        "solo informado (ninguna fila creada de verdad)."
    );
  }
  if (candidates.length > batch.length) {
    console.log(`[link-leads] +${candidates.length - batch.length} más quedan para la próxima pasada.`);
  }
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
  // Persistido para que GET /link-leads/ambiguous (rutas HTTP) lo sirva sin
  // tener que re-ejecutar el matching completo en cada petición.
  setMeta(AMBIGUOUS_META_KEY, JSON.stringify(r.ambiguous));

  await tryCreateNewLeads(r.noMatch).catch((e) =>
    console.error("[link-leads] tryCreateNewLeads falló:", (e as Error).message)
  );
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
