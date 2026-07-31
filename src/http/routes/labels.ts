/**
 * Rutas de ETIQUETAS de WhatsApp Business (bidireccional, 2026-07-30).
 *
 *  - GET  /labels                 → catálogo de etiquetas conocidas
 *  - POST /labels/resync          → re-pide el estado a WhatsApp (rellena el catálogo)
 *  - GET  /chats/:jid/labels      → las de un chat
 *  - POST /chats/:jid/labels      → poner/quitar { labelId, on } EN WHATSAPP
 *
 * Solo se llega aquí por el proxy del dashboard, que exige sesión. El actor real
 * viaja en `x-csa-user` (lo pone ese proxy) y queda en la auditoría.
 */
import type { FastifyInstance } from "fastify";
import { listLabelCatalog, labelsOfChat, resyncLabels, setChatLabel } from "../../wa/labels";

export function registerLabelRoutes(app: FastifyInstance): void {
  app.get("/labels", async () => ({ ok: true, labels: listLabelCatalog() }));

  // Fuerza a WhatsApp a reenviar el estado → rellena el catálogo con las
  // etiquetas creadas en el móvil después del emparejamiento.
  app.post("/labels/resync", async (_req, reply) => {
    const r = await resyncLabels();
    if (!r.ok) return reply.status(503).send(r);
    return r;
  });

  app.get("/chats/:jid/labels", async (req) => {
    const { jid } = req.params as { jid: string };
    return { ok: true, labels: labelsOfChat(jid) };
  });

  app.post("/chats/:jid/labels", async (req, reply) => {
    const { jid } = req.params as { jid: string };
    const b = (req.body ?? {}) as { labelId?: unknown; on?: unknown };
    const labelId = String(b.labelId ?? "").trim();
    if (!labelId) return reply.status(400).send({ ok: false, error: "Falta labelId.", code: "invalid" });
    const on = b.on !== false; // por defecto, poner
    const actor = String((req.headers["x-csa-user"] as string | undefined) ?? "").trim() || null;

    const r = await setChatLabel(jid, labelId, on, actor);
    if (!r.ok) {
      const status = r.code === "offline" ? 503 : r.code === "fail" ? 502 : 400;
      return reply.status(status).send(r);
    }
    return r;
  });
}
