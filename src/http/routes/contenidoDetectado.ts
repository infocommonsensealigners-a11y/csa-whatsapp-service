/**
 * GET /contenido-detectado?tokens=<t1>,<t2>,…
 *
 * ¿A QUIÉN LE PASAMOS CADA CONTENIDO GRATUITO? Busca en los mensajes que
 * ENVIAMOS los `tokens` que le pide el dashboard (el identificador único del
 * enlace de cada contenido de su catálogo) y devuelve, por token, los chats
 * donde aparece con la fecha del primer envío.
 *
 * POR QUÉ EL CATÁLOGO NO VIVE AQUÍ: lo edita el usuario desde el dashboard
 * (Catálogo → Contenido gratuito, con su URL). Duplicarlo en el sidecar
 * garantizaría que un día divergen. Así el sidecar solo sabe BUSCAR, y qué
 * buscar lo decide quien tiene el catálogo.
 *
 * ⚠️ SOLO SE BUSCA EL ENLACE, no el nombre del contenido. Medido sobre el
 * histórico: "estamos regalando una clase de sobremordida" (el mensaje de
 * captación) aparece en 35 chats y es un OFRECIMIENTO, no una entrega; contarlo
 * marcaría como "recibido" algo que el doctor quizá nunca abrió. El enlace, en
 * cambio, es la entrega en sí.
 */
import type { FastifyInstance } from "fastify";
import { getDb } from "../../db/db";

export interface ContenidoDetectadoItem {
  /** El token que se pidió (identificador del enlace). */
  token: string;
  chats: Array<{
    jid: string;
    phone: string | null;
    /** Epoch s del PRIMER envío de ese enlace a ese chat. */
    primeroTs: number;
    envios: number;
  }>;
}

/** Un token es un trozo de URL: se acota a lo que puede aparecer en un enlace. */
const TOKEN_OK = /^[A-Za-z0-9._~-]{6,80}$/;

export function registerContenidoDetectadoRoutes(app: FastifyInstance): void {
  app.get("/contenido-detectado", async (request, reply) => {
    const q = request.query as { tokens?: string } | undefined;
    const tokens = String(q?.tokens ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter((t) => TOKEN_OK.test(t))
      .slice(0, 60); // tope defensivo: el catálogo real tiene ~7 entradas
    if (!tokens.length) return reply.status(400).send({ ok: false, error: "Sin tokens válidos que buscar." });

    const db = getDb();
    // LIKE con el token entre comodines. Es un escaneo por token, pero solo sobre
    // mensajes propios con enlace (~2.000 filas de 61.686) y se cachea arriba.
    const stmt = db.prepare(
      `SELECT m.chat_jid AS jid, c.phone AS phone, MIN(m.ts) AS primeroTs, COUNT(*) AS envios
         FROM messages m LEFT JOIN chats c ON c.jid = m.chat_jid
        WHERE m.from_me = 1 AND m.text LIKE ? ESCAPE '\\'
        GROUP BY m.chat_jid`
    );
    const items: ContenidoDetectadoItem[] = tokens.map((token) => {
      // Escapa los comodines de LIKE para que un token con _ o % no amplíe la búsqueda.
      const patron = `%${token.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      const chats = stmt.all(patron) as ContenidoDetectadoItem["chats"];
      return { token, chats };
    });

    return {
      ok: true,
      items,
      totalChats: new Set(items.flatMap((i) => i.chats.map((c) => c.jid))).size,
    };
  });
}
