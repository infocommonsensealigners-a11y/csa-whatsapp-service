/**
 * POST /chats/:jid/send { text, citar? } — responder A MANO desde el teléfono
 * flotante del dashboard (decisión del usuario 2026-07-29). Solo se llega aquí
 * por el proxy del dashboard, que exige sesión; el actor real viaja en
 * `x-csa-user` y queda auditado en wa_send_audit (ver src/wa/send.ts, el único
 * módulo con permiso de publicación según check:nosend).
 *
 * Desde aquí SÍ se puede escribir a un grupo (como en WhatsApp Web); las
 * automatizaciones no, porque no pasan por esta ruta.
 */
import type { FastifyInstance } from "fastify";
import { sendReaction, sendText, sendMedia, type SendMediaInput } from "../../wa/send";
import { marcarLeidoEnWhatsapp } from "../../wa/leido";
import { jidDeRuta } from "./chats";
import { emitSse } from "../sse";

/**
 * IDEMPOTENCIA del envío a mano (auditoría 09-10-2026). Si el mensaje sale pero
 * la respuesta se pierde (wifi de Fran, despliegue, proxy), Fran ve un error y
 * pulsa otra vez: salía DOS veces. El teléfono flotante manda un `idCliente`
 * por mensaje y lo repite si reintenta el mismo; aquí, el mismo `idCliente`
 * devuelve el resultado del primero (o espera a que termine) sin volver a
 * enviar. 15 minutos de memoria; tras un reinicio no hay memoria, pero el
 * reinicio tampoco deja envíos a medias en vuelo.
 */
const RECUERDO_MS = 15 * 60_000;
const yaEnviados = new Map<string, { at: number; r: Promise<unknown> }>();
function unaVez<T>(idCliente: unknown, fn: () => Promise<T>): Promise<T> {
  const id = typeof idCliente === "string" ? idCliente.trim().slice(0, 80) : "";
  if (!id) return fn();
  const ahora = Date.now();
  const previo = yaEnviados.get(id);
  if (previo && ahora - previo.at < RECUERDO_MS) return previo.r as Promise<T>;
  const r = fn();
  yaEnviados.set(id, { at: ahora, r });
  // Solo se recuerda lo que SALIÓ (y lo que está saliendo): un fallo no se
  // recuerda, para que el reintento lo intente de verdad.
  void r.then((x) => {
    if ((x as { ok?: boolean })?.ok === false) yaEnviados.delete(id);
  }).catch(() => yaEnviados.delete(id));
  if (yaEnviados.size > 2000) for (const [k, v] of yaEnviados) if (ahora - v.at > RECUERDO_MS) yaEnviados.delete(k);
  return r;
}

function statusFor(code: string): number {
  return code === "offline" ? 503 : code === "rate" ? 429 : code === "too-big" ? 413 : code === "fail" ? 502 : 400;
}

export function registerSendRoutes(app: FastifyInstance): void {
  app.post("/chats/:jid/send", async (request, reply) => {
    const jid = decodeURIComponent(String((request.params as { jid?: string }).jid ?? ""));
    const body = (request.body ?? {}) as { text?: unknown; citar?: unknown; idCliente?: unknown };
    const actor = String(request.headers["x-csa-user"] ?? "").trim() || null;
    const citar = typeof body.citar === "string" && body.citar.trim() ? body.citar.trim() : null;
    const r = await unaVez(body.idCliente, () => sendText(jid, String(body.text ?? ""), actor, { permitirGrupo: true, citar }));
    if (!r.ok) return reply.status(statusFor(r.code)).send(r);
    return r;
  });

  /**
   * POST /chats/:jid/leido — la persona tiene este chat abierto y delante: se
   * marca leído también en WhatsApp (adiós a la bandeja doble). Ver `wa/leido.ts`.
   */
  app.post("/chats/:jid/leido", async (request, reply) => {
    const jid = jidDeRuta((request.params as { jid?: string }).jid);
    const r = await marcarLeidoEnWhatsapp(jid);
    if (!r.ok) return reply.status(r.code === "offline" ? 503 : 502).send(r);
    if (r.marcados > 0) emitSse({ type: "chat.updated", jid });
    return r;
  });

  /** POST /chats/:jid/react { msgId, emoji } — emoji vacío = quitar la reacción. */
  app.post("/chats/:jid/react", async (request, reply) => {
    const jid = decodeURIComponent(String((request.params as { jid?: string }).jid ?? ""));
    const body = (request.body ?? {}) as { msgId?: unknown; emoji?: unknown };
    const actor = String(request.headers["x-csa-user"] ?? "").trim() || null;
    const msgId = String(body.msgId ?? "").trim();
    if (!msgId) return reply.status(400).send({ ok: false, error: "Falta msgId.", code: "invalid" });
    const r = await sendReaction(jid, msgId, typeof body.emoji === "string" ? body.emoji : null, actor);
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
      b64?: unknown; mimetype?: unknown; kind?: unknown; fileName?: unknown; caption?: unknown; ptt?: unknown; idCliente?: unknown;
    };
    const actor = String(request.headers["x-csa-user"] ?? "").trim() || null;
    const kind = String(body.kind ?? "");
    if (kind !== "image" && kind !== "audio" && kind !== "document" && kind !== "video") {
      return reply.status(400).send({ ok: false, error: "kind debe ser image, audio, video o document.", code: "invalid" });
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
    const r = await unaVez(body.idCliente, () => sendMedia(jid, input, actor));
    if (!r.ok) return reply.status(statusFor(r.code)).send(r);
    return r;
  });
}
