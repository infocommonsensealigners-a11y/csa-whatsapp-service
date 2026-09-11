/**
 * Ingesta de conversaciones → SQLite: el CABLEADO a los eventos de Baileys.
 * La lógica que escribe filas vive en `ingestCore.ts` (probable sin socket);
 * aquí solo se conectan los eventos y se hacen las cosas que necesitan red o
 * servicios: descargar media, avisar a las campañas, re-analizar con Fransua y
 * emitir los eventos SSE hacia el dashboard.
 *
 * Fuentes:
 *  - "messaging-history.set": volcado que el móvil comparte al emparejar.
 *  - "messages.upsert": en vivo (`notify`) y re-entregas/ecos (`append`).
 *  - "messages.update": contenido tardío y ediciones.
 *  - "contacts.*", "chats.*", "labels.*", "chats.phoneNumberShare": agenda,
 *    estado de lectura, etiquetas e identidad LID↔teléfono.
 *
 * Todo es idempotente (PK (chat_jid, id) + ON CONFLICT DO NOTHING), y cada
 * mensaje se guarda bajo el jid canónico de la persona (ver canonico.ts).
 */
import type { Chat, Contact, WAMessage } from "baileys";
import { getDb, setMeta } from "../db/db";
import { emitSse } from "../http/sse";
import { avisarEntrante } from "../campanas/entrantes";
import { encolarSalientePorSiEsManual } from "../campanas/manual";
import { aprenderMapeo, canonicoDe } from "./canonico";
import { esGrupo } from "./identidad";
import {
  aplicarContenidoTardio,
  aplicarLecturaDeChats,
  applyContactNames,
  ingestChatShells,
  ingestMessages,
  type IngestResult,
} from "./ingestCore";
import { onWaEvent, downloadMedia } from "./socket";
import { analyzeChat } from "../brain/analyzeChat";
import { saveMediaBuffer } from "./mediaStore";

/**
 * Descarga el binario de cada candidato y actualiza `media_path`/`media_mime`.
 * Secuencial a propósito (no Promise.all): una ráfaga de fotos no debe abrir N
 * descargas simultáneas contra el socket de Baileys. Cada fallo se aísla — una
 * foto que no baja no debe impedir que las demás sí lo hagan.
 */
async function downloadAndAttachMedia(candidates: IngestResult["mediaCandidates"]): Promise<Set<string>> {
  if (!candidates.length) return new Set();
  const db = getDb();
  const update = db.prepare(`UPDATE messages SET media_path = ?, media_mime = ? WHERE chat_jid = ? AND id = ?`);
  const listos = new Set<string>();
  for (const c of candidates) {
    try {
      const buf = await downloadMedia(c.msg);
      const file = saveMediaBuffer(c.jid, c.id, c.mimetype, buf, c.fileName);
      if (file) {
        update.run(file, c.mimetype, c.jid, c.id);
        listos.add(c.jid);
      }
    } catch (e) {
      console.error(`[media] descarga falló ${c.jid}/${c.id}:`, (e as Error).message);
    }
  }
  return listos;
}

/* ------------- Fransua EN DIRECTO: re-análisis al llegar mensaje ------------- */
// Cuando entra un mensaje NUEVO en vivo, re-analizamos ese chat tras un pequeño
// anti-rebote: deja que la ráfaga se asiente (WhatsApp llega a golpes) y evita
// saturar la IA. Un timer por jid; si llegan más mensajes, se reinicia y solo
// analiza cuando la charla pausa. Los grupos no se analizan: la inteligencia de
// Fransua es por lead.
const LIVE_ANALYZE_DEBOUNCE_MS = 20_000;
const liveAnalyzeTimers = new Map<string, NodeJS.Timeout>();

function scheduleLiveAnalyze(jid: string): void {
  if (esGrupo(jid)) return;
  const prev = liveAnalyzeTimers.get(jid);
  if (prev) clearTimeout(prev);
  liveAnalyzeTimers.set(
    jid,
    setTimeout(() => {
      liveAnalyzeTimers.delete(jid);
      analyzeChat(jid)
        .then((r) => {
          if (r.ok) console.log(`[intel] re-análisis en vivo OK: ${jid}`);
        })
        .catch((e) => console.error("[intel] re-análisis en vivo falló:", (e as Error).message));
    }, LIVE_ANALYZE_DEBOUNCE_MS)
  );
}

/**
 * IDS DE MENSAJE ENTRANTE ya avisados, con caducidad.
 *
 * Primera línea de defensa contra el doble aviso. La segunda está en el
 * dashboard, que guarda el último id procesado por persona — hace falta también
 * allí porque este mapa se pierde al reiniciar el servicio.
 */
const avisados = new Map<string, number>();
const AVISADO_TTL_MS = 10 * 60_000;

function dedupeEntrantes<T extends { telefono: string; texto: string; waMsgId: string }>(es: T[]): T[] {
  const ahora = Date.now();
  // Limpieza perezosa: sin esto el mapa crece sin techo en un proceso que vive semanas.
  if (avisados.size > 5000) {
    for (const [k, t] of avisados) if (ahora - t > AVISADO_TTL_MS) avisados.delete(k);
  }
  const out: T[] = [];
  for (const e of es) {
    // La clave lleva el TELÉFONO además del id: el mismo id en dos chats gemelos
    // es el mismo mensaje de la misma persona, que es justo lo que hay que colapsar.
    const clave = `${e.telefono}|${e.waMsgId}`;
    const visto = avisados.get(clave);
    if (visto !== undefined && ahora - visto < AVISADO_TTL_MS) {
      console.log(`[campanas] aviso DUPLICADO ignorado: ${e.telefono} · msg ${e.waMsgId}`);
      continue;
    }
    avisados.set(clave, ahora);
    out.push(e);
  }
  return out;
}

/** Registra los listeners de ingesta en la fachada (sobreviven reconexiones). */
export function registerIngest(): void {
  onWaEvent("messaging-history.set", (payload) => {
    try {
      const { chats, contacts, messages, isLatest, progress, syncType } = payload as typeof payload & {
        isLatest?: boolean;
        progress?: number | null;
        syncType?: number;
      };
      // Primero los contactos (nombres y pares teléfono↔LID de la agenda) y los
      // chats (pnJid/lidJid): así los mensajes ya nacen bajo el jid canónico.
      applyContactNames(contacts ?? [], false);
      const shells = ingestChatShells((chats as Chat[]) ?? []);
      const result = ingestMessages(messages ?? [], { modo: "history" });
      const now = Math.floor(Date.now() / 1000);
      setMeta("last_history_sync", String(now));
      console.log(
        `[ingest] history.set syncType=${syncType ?? "?"} isLatest=${isLatest ?? "?"} ` +
          `progress=${progress ?? "?"} chats=${(chats ?? []).length} contacts=${(contacts ?? []).length} ` +
          `messages=${(messages ?? []).length} → chatsGuardados=${shells} conMsg=${result.touched.size}`
      );
      // Cualquier volcado (chats o mensajes) refresca la lista entera.
      emitSse({ type: "chats.synced" });
    } catch (err) {
      console.error("[ingest] error procesando history.set:", (err as Error).message);
    }
  });

  onWaEvent("messages.upsert", ({ messages, type }) => {
    if (type !== "notify" && type !== "append") return;
    try {
      /**
       * `append` NO es solo historial: WhatsApp re-entrega así lo que llegó
       * mientras el sidecar estaba caído (cada deploy son 30-90 s) y el eco de
       * nuestros propios envíos. El núcleo decide por antigüedad qué tratar como
       * en vivo (media, campañas, análisis) — ver VENTANA_VIVO_S.
       */
      const result = ingestMessages(messages, { modo: type });
      /**
       * Bajas y respuestas de campaña: fuera de la transacción y sin esperar.
       * Se deduplica por (teléfono, id): el mismo mensaje puede llegar por dos
       * caminos y avisar dos veces avanzaba el guion dos veces.
       */
      for (const e of dedupeEntrantes(result.entrantes)) {
        void avisarEntrante(e.telefono, e.texto, e.jid, e.waMsgId);
      }
      /**
       * TOMA MANUAL: un mensaje que sale sin marca de automático lo ha escrito
       * una persona, y entonces la automatización se retira de ese chat
       * (petición del usuario 2026-09-08). Se encola, no se decide aquí.
       */
      for (const s of result.salientes) encolarSalientePorSiEsManual(s);
      console.log(
        `[ingest] upsert type=${type} recibidos=${messages.length} guardados=${result.touched.size}` +
          (messages[0]?.key?.remoteJid ? ` primer=${messages[0].key.remoteJid}` : "")
      );
      for (const jid of result.touched) emitSse({ type: "message.new", jid });
      // Fransua EN DIRECTO: solo mensajes nuevos y recientes, no el backfill.
      for (const jid of result.vivos) scheduleLiveAnalyze(jid);
      // Descarga fuera de la ruta síncrona (I/O de red): cuando termine cada
      // fichero, un segundo `message.new` hace que la burbuja pase de "etiqueta
      // gris" a la foto/audio real sin que el usuario recargue nada.
      if (result.mediaCandidates.length) {
        void downloadAndAttachMedia(result.mediaCandidates).then((listos) => {
          for (const jid of listos) emitSse({ type: "message.new", jid });
        });
      }
    } catch (err) {
      console.error("[ingest] error procesando upsert:", (err as Error).message);
    }
  });

  // CONTENIDO QUE LLEGA TARDE: ediciones de mensaje y cuerpos que WhatsApp
  // entrega después del upsert original viajan por `messages.update` con
  // `update.message`. Se guardan en el chat canónico y se avisa a la UI.
  onWaEvent("messages.update", (updates) => {
    try {
      const touched = aplicarContenidoTardio(updates as Array<{ key: WAMessage["key"]; update: Partial<WAMessage> }>);
      for (const jid of touched) emitSse({ type: "message.new", jid });
    } catch (err) {
      console.error("[ingest] error procesando messages.update:", (err as Error).message);
    }
  });

  onWaEvent("contacts.upsert", (contacts) => applyContactNames(contacts, false));
  onWaEvent("contacts.update", (contacts) => applyContactNames(contacts as Array<Partial<Contact>>, true));

  // ESTADO DE LECTURA REAL (petición del usuario 2026-08-01). WhatsApp sincroniza
  // su `unreadCount` entre dispositivos: cuando Fran abre un chat en el móvil o
  // en WhatsApp Web, llega aquí un `chats.update` con unreadCount 0. Lo
  // traducimos a la marca de agua `wa_read_at` (ver src/wa/readState.ts).
  const aplicarLectura = (updates: Array<{ id?: string | null; unreadCount?: number | null }>) => {
    try {
      for (const jid of aplicarLecturaDeChats(updates)) emitSse({ type: "chat.updated", jid });
    } catch (err) {
      console.error("[ingest] estado de lectura:", (err as Error).message);
    }
  };
  onWaEvent("chats.update", (updates) => aplicarLectura(updates as Array<Partial<Chat>>));
  onWaEvent("chats.upsert", (chats) => aplicarLectura(chats as Array<Partial<Chat>>));

  // El contacto ha compartido su número: WhatsApp nos dice qué teléfono hay
  // detrás de un @lid. Si tenía chat propio, se funde en el del teléfono.
  onWaEvent("chats.phoneNumberShare", ({ lid, jid }) => {
    try {
      const r = aprenderMapeo(lid, jid, "phoneNumberShare");
      if (r.fusionado) emitSse({ type: "chats.synced" });
    } catch (err) {
      console.error("[ingest] phoneNumberShare:", (err as Error).message);
    }
  });

  // ETIQUETAS de WhatsApp Business — sentido WHATSAPP → AQUÍ (la escritura en
  // sentido contrario vive en src/wa/labels.ts, el único fichero autorizado).
  onWaEvent("labels.edit", (label) => {
    try {
      getDb()
        .prepare(
          `INSERT INTO wa_labels(id, name, color, deleted) VALUES (@id, @name, @color, @deleted)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color, deleted = excluded.deleted`
        )
        .run({
          id: label.id,
          name: label.name ?? "",
          color: typeof label.color === "number" ? label.color : 0,
          deleted: label.deleted ? 1 : 0,
        });
      emitSse({ type: "labels.updated" });
    } catch (err) {
      console.error("[ingest] labels.edit:", (err as Error).message);
    }
  });

  onWaEvent("labels.association", ({ association, type }) => {
    try {
      const assoc = association as { type?: string; chatId?: string; labelId?: string; messageId?: string };
      // Solo asociaciones de CHAT (no de mensaje): type "label_jid".
      if (assoc?.type !== "label_jid" || !assoc.chatId || !assoc.labelId) return;
      // La etiqueta puede llegar con el jid @lid de la persona: va al canónico.
      const chatId = canonicoDe(assoc.chatId) || assoc.chatId;
      const db = getDb();
      if (type === "add") {
        // Si la etiqueta aún no está en el catálogo (su `labels.edit` no llegó o
        // se perdió), se siembra un hueco para que el JOIN de /chats NO la
        // descarte: mejor una etiqueta con nombre pendiente que una invisible.
        db.prepare(`INSERT OR IGNORE INTO wa_labels(id, name, color, deleted) VALUES (?, '', 0, 0)`).run(assoc.labelId);
        db.prepare(`INSERT OR IGNORE INTO wa_chat_labels(chat_jid, label_id) VALUES (?, ?)`).run(chatId, assoc.labelId);
      } else {
        db.prepare(`DELETE FROM wa_chat_labels WHERE chat_jid = ? AND label_id = ?`).run(chatId, assoc.labelId);
      }
      emitSse({ type: "chat.updated", jid: chatId });
      emitSse({ type: "labels.updated" });
    } catch (err) {
      console.error("[ingest] labels.association:", (err as Error).message);
    }
  });
}
