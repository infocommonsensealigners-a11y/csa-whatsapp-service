/**
 * POST /campanas/marca — el dashboard cuenta algo de un mensaje de campaña que
 * ha mandado él mismo por la API de Meta (Cloud). Lo llama `avisarSidecar` en
 * `dashboard/lib/campanas/cloudServidor.ts`, con dos segundos de tope y sin
 * esperar nada: si esto falla, el envío no cambia.
 *
 * Hasta el 09-10-2026 la ruta no existía y el dashboard recibía un 404 mudo.
 * Consecuencias: en el teléfono flotante los mensajes de la campaña por Meta no
 * llevaban la marca de «automático», las notas de cierre no aparecían, y el eco
 * de cada envío se tomaba aquí por un mensaje escrito a mano (ver
 * `registrarAnuncio` en `campanas/marcas.ts`).
 *
 *  - `anuncio`: ANTES de llamar a Meta. Deja el rastro para que su eco no pase
 *    por una toma manual.
 *  - `enviado`: después, con el id del mensaje (el interno, ya sacado del
 *    `wamid.…`, que es el que trae el eco). Marca de agua.
 *  - `nota`: nota interna en el chat (cómo acabó la conversación). No se envía.
 *
 * Sirve para cualquier campaña por la Cloud API, no solo la del taller.
 */
import type { FastifyInstance } from "fastify";
import { getDb } from "../../db/db";
import { registrarAnuncio, registrarAutomatico, registrarNota, claveAnuncio } from "../../campanas/marcas";
import { canonicoDe } from "../../wa/canonico";
import { jidPnDe } from "../../wa/identidad";
import { emitSse } from "../sse";

interface CuerpoMarca {
  fase?: unknown;
  telefono?: unknown;
  campanaId?: unknown;
  campana?: unknown;
  waMsgId?: unknown;
  nota?: unknown;
}

const texto = (x: unknown, max: number): string => (typeof x === "string" ? x.trim().slice(0, max) : "");

/**
 * Chat donde se ve a esta persona. El canónico es el del teléfono; si aún no
 * existe pero hay un chat con ese teléfono (un `@lid` sin fundir), ése, para que
 * la marca salga donde Fran está mirando.
 */
function jidDeTelefono(telefono: string): string | null {
  const pn = jidPnDe(telefono);
  if (!pn) return null;
  const canon = canonicoDe(pn) || pn;
  try {
    const db = getDb();
    if (db.prepare(`SELECT 1 AS x FROM chats WHERE jid = ?`).get(canon)) return canon;
    const tel = claveAnuncio(telefono);
    const otro = tel
      ? (db
          .prepare(
            `SELECT jid FROM chats WHERE phone = ? AND alias_of IS NULL
              ORDER BY COALESCE(last_message_at, 0) DESC LIMIT 1`
          )
          .get(tel) as { jid: string } | undefined)
      : undefined;
    if (otro?.jid) return otro.jid;
  } catch {
    /* la base puede no estar lista: se usa el canónico */
  }
  return canon;
}

export function registerCampanaRoutes(app: FastifyInstance): void {
  app.post("/campanas/marca", async (req, reply) => {
    /**
     * El sidecar no tiene auth propia (red privada), pero esta ruta escribe en
     * los chats: si el token interno está configurado, se exige.
     */
    const esperado = (process.env.FRANSUA_INTERNAL_TOKEN ?? "").trim();
    const llega = String((req.headers["x-fransua-token"] as string | undefined) ?? "").trim();
    if (esperado && llega !== esperado) return reply.status(401).send({ ok: false, error: "token inválido" });

    const b = (req.body ?? {}) as CuerpoMarca;
    const fase = texto(b.fase, 20);
    const telefono = texto(b.telefono, 40);
    const campanaId = texto(b.campanaId, 120) || null;
    const campana = texto(b.campana, 200);
    if (!telefono || !claveAnuncio(telefono)) return reply.status(400).send({ ok: false, error: "teléfono inválido" });

    if (fase === "anuncio") {
      return { ok: registrarAnuncio(telefono, campanaId) };
    }

    const jid = jidDeTelefono(telefono);
    if (!jid) return reply.status(400).send({ ok: false, error: "teléfono inválido" });

    if (fase === "enviado") {
      const waMsgId = texto(b.waMsgId, 200);
      if (!waMsgId) return reply.status(400).send({ ok: false, error: "falta waMsgId" });
      // Se refresca el anuncio: el eco puede llegar después de este aviso.
      registrarAnuncio(telefono, campanaId);
      registrarAutomatico(jid, waMsgId, campana, campanaId ?? "");
      emitSse({ type: "message.new", jid });
      return { ok: true, jid };
    }

    if (fase === "nota") {
      const nota = texto(b.nota, 400);
      if (!nota) return reply.status(400).send({ ok: false, error: "falta la nota" });
      registrarNota(jid, nota, campanaId);
      emitSse({ type: "message.new", jid });
      return { ok: true, jid };
    }

    return reply.status(400).send({ ok: false, error: "fase desconocida" });
  });
}
