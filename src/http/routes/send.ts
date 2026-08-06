/**
 * POST /chats/:jid/send { text } — responder A MANO desde el teléfono flotante
 * del dashboard (decisión del usuario 2026-07-29). Solo se llega aquí por el
 * proxy del dashboard, que exige sesión; el actor real viaja en `x-csa-user`
 * y queda auditado en wa_send_audit (ver src/wa/send.ts, el único módulo con
 * permiso de publicación según check:nosend).
 */
import type { FastifyInstance } from "fastify";
import { sendText, sendMedia, type SendMediaInput } from "../../wa/send";

function statusFor(code: string): number {
  return code === "offline" ? 503 : code === "rate" ? 429 : code === "too-big" ? 413 : code === "fail" ? 502 : 400;
}

export function registerSendRoutes(app: FastifyInstance): void {
  app.post("/chats/:jid/send", async (request, reply) => {
    const jid = decodeURIComponent(String((request.params as { jid?: string }).jid ?? ""));
    const body = (request.body ?? {}) as { text?: unknown };
    const actor = String(request.headers["x-csa-user"] ?? "").trim() || null;
    const r = await sendText(jid, String(body.text ?? ""), actor);
    if (!r.ok) return reply.status(statusFor(r.code)).send(r);
    return r;
  });

  /**
   * POST /chats/:jid/send-media { b64, mimetype, kind, fileName?, caption?, ptt? }
   *
   * Adjuntos y notas de voz en JSON+base64, NO multipart — `@fastify/multipart`
   * no está instalado, y el proxy del dashboard ya transporta JSON binario-safe
   * hoy (mismo patrón que la migración de avatares en admin.ts). El coste es
   * ~33% más de tráfico por el base64; con el tope de 10 MB/fichero de
   * mediaStore.ts, el body cabe de sobra en los 32 MB de bodyLimit de Fastify.
   */
  app.post("/chats/:jid/send-media", async (request, reply) => {
    const jid = decodeURIComponent(String((request.params as { jid?: string }).jid ?? ""));
    const body = (request.body ?? {}) as {
      b64?: unknown; mimetype?: unknown; kind?: unknown; fileName?: unknown; caption?: unknown; ptt?: unknown;
    };
    const actor = String(request.headers["x-csa-user"] ?? "").trim() || null;
    const kind = String(body.kind ?? "");
    if (kind !== "image" && kind !== "audio" && kind !== "document") {
      return reply.status(400).send({ ok: false, error: "kind debe ser image, audio o document.", code: "invalid" });
    }
    const b64 = String(body.b64 ?? "");
    if (!b64) return reply.status(400).send({ ok: false, error: "Falta el archivo.", code: "invalid" });
    let buffer: Buffer;
    try {
      buffer = Buffer.from(b64, "base64");
    } catch {
      return reply.status(400).send({ ok: false, error: "Archivo corrupto.", code: "invalid" });
    }
    const input: SendMediaInput = {
      kind,
      buffer,
      mimetype: String(body.mimetype ?? "application/octet-stream"),
      fileName: typeof body.fileName === "string" ? body.fileName : null,
      caption: typeof body.caption === "string" ? body.caption : null,
      ptt: body.ptt === true,
    };
    const r = await sendMedia(jid, input, actor);
    if (!r.ok) return reply.status(statusFor(r.code)).send(r);
    return r;
  });
}
