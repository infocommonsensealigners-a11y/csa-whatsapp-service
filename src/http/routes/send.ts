/**
 * POST /chats/:jid/send { text } — responder A MANO desde el teléfono flotante
 * del dashboard (decisión del usuario 2026-07-29). Solo se llega aquí por el
 * proxy del dashboard, que exige sesión; el actor real viaja en `x-csa-user`
 * y queda auditado en wa_send_audit (ver src/wa/send.ts, el único módulo con
 * permiso de publicación según check:nosend).
 */
import type { FastifyInstance } from "fastify";
import { sendText } from "../../wa/send";

export function registerSendRoutes(app: FastifyInstance): void {
  app.post("/chats/:jid/send", async (request, reply) => {
    const jid = decodeURIComponent(String((request.params as { jid?: string }).jid ?? ""));
    const body = (request.body ?? {}) as { text?: unknown };
    const actor = String(request.headers["x-csa-user"] ?? "").trim() || null;
    const r = await sendText(jid, String(body.text ?? ""), actor);
    if (!r.ok) {
      const status = r.code === "offline" ? 503 : r.code === "rate" ? 429 : r.code === "fail" ? 502 : 400;
      return reply.status(status).send(r);
    }
    return r;
  });
}
