/**
 * Contratos compartidos entre `whatsapp-service/` (sidecar Baileys) y `dashboard/`
 * (Next.js). SOLO TIPOS — cero runtime: cualquier import debe ser `import type`,
 * de modo que se borre en compilación y no arrastre código entre proyectos.
 *
 * COPIA CANÓNICA DE ESTE REPO (auditoría 2026-07-28): antes se importaba de
 * `../shared/` (carpeta padre SIN git) → no entraba en la imagen Docker ni en
 * un clon limpio; typecheck imposible fuera de esta máquina. El dashboard tiene
 * su propia copia en `dashboard/lib/whatsapp-contracts.ts`. Si cambias un tipo
 * aquí, cámbialo también allí (y en `../shared/` si aún existe).
 */

export type WaConnectionState = "open" | "connecting" | "close" | "needs_qr";

export interface WaStatus {
  state: WaConnectionState;
  /** PNG dataURL del QR de emparejamiento cuando state === "needs_qr". */
  qrDataUrl: string | null;
  me: { jid: string; name: string } | null;
  counts: { chats: number; messages: number; linked: number; unknown: number };
  lastHistorySyncAt: number | null;
  /** Estado de la cola IA (Fase 2). */
  aiQueue: { pending: number; paused: boolean };
}

export interface ChatLeadLink {
  sourceRow: number;
  method: "auto" | "manual";
  leadName: string | null;
  phoneSnapshot: string | null;
  /** false ⇒ el sourceRow ya no casa con phone_snapshot (self-healing pendiente). */
  healthy: boolean;
}

export interface TagRef {
  id: number;
  name: string;
  color: string | null;
  confidence?: number;
}

/** Etiqueta de WhatsApp Business (la que el usuario pone en la app). `color` es
 *  el índice 0-19 de la paleta de WhatsApp; el dashboard lo mapea a un color. */
export interface WaLabel {
  /** id de la etiqueta en WhatsApp — necesario para ponerla/quitarla. */
  id?: string;
  name: string;
  color: number;
}

/** Estado de entrega de un mensaje propio (los ticks de WhatsApp). */
export type WaEstadoMensaje = "error" | "pending" | "sent" | "delivered" | "read" | "played";

/** Una reacción a un mensaje. `fromMe` = la pusimos nosotros. */
export interface WaReaccion {
  emoji: string;
  fromMe: boolean;
  /** jid canónico de quien reaccionó (null si fuimos nosotros). */
  sender: string | null;
  senderName?: string | null;
  ts: number | null;
}

/** El mensaje CITADO por una respuesta (para pintarlo encima y saltar a él). */
export interface WaCita {
  id: string;
  fromMe: boolean;
  participantName: string | null;
  text: string | null;
  type: WaMessage["type"];
}

/** Presencia de un contacto en el chat abierto. */
export type WaPresencia = "available" | "unavailable" | "composing" | "recording" | "paused";

export interface ChatSummary {
  jid: string;
  /** Teléfono canónico ES (9 dígitos) o null si internacional/no parseable. */
  phone: string | null;
  displayName: string;
  /** Es un GRUPO (`@g.us`). Desde 2026-09-11 los grupos entran como en WhatsApp Web. */
  isGroup?: boolean;
  /** Estado que sincroniza el móvil: archivado, fijado (epoch s del fijado) y silenciado hasta (epoch s). */
  archived?: boolean;
  pinned?: number | null;
  mutedUntil?: number | null;
  /** El último mensaje lo escribimos nosotros, y en qué estado está (para el tick de la lista). */
  lastMessageFromMe?: boolean | null;
  lastMessageStatus?: WaEstadoMensaje | null;
  /** Nº de participantes (solo grupos). */
  participants?: number;
  /**
   * EL OTRO NOMBRE con el que esta persona está guardada, si difiere del que se
   * enseña.
   *
   * ⚠️ Pedido por el usuario (08-09-2026): «si hay dos nombres registrados a ese
   * número mucho cuidado… que se muestre ese otro nombre por el que se guarda,
   * para a la hora de buscarlo encontrarlo por cualquiera de ellos». En el
   * teléfono flotante hay UNA conversación por número, así que si WhatsApp lo
   * tiene guardado como «Javier Lead SBA» y el CRM como «Javier García
   * Cardeñosa», enseñar solo uno de los dos hace imposible reconocerlo por el
   * otro. La búsqueda ya casaba los dos; lo que faltaba era VERLO.
   */
  nombreAlterno?: string | null;
  lastMessageAt: number | null;
  lastMessagePreview: string | null;
  /** Mensajes entrantes posteriores a last_opened_at (contador LOCAL, no read-receipts). */
  unread: number;
  /**
   * El ÚLTIMO mensaje del chat lo escribieron ELLOS → está pendiente de
   * contestar. Hecho crudo, sin ventana temporal: hasta cuándo se considera
   * accionable lo decide quien lo pinta (el chip del teléfono usa 30 días).
   */
  pendingReply?: boolean;
  ignored: boolean;
  links: ChatLeadLink[];
  approvedTags: TagRef[];
  proposedTags: TagRef[];
  hasAbstract: boolean;
  /** Etiquetas de WhatsApp Business del chat (bidireccional desde 2026-07-30). */
  waLabels?: WaLabel[];
}

export interface WaMessage {
  id: string;
  chatJid: string;
  fromMe: boolean;
  /** Epoch seconds. */
  ts: number;
  type: "text" | "image" | "audio" | "video" | "document" | "other";
  text: string | null;
  /** Ruta ya proxificada ('/api/whatsapp/media/<jid>/<id>') o null. */
  mediaUrl: string | null;
  /**
   * Lo envio la AUTOMATIZACION de una campana, no una persona. La UI le pone la
   * marca de agua: en `messages` un envio automatico y uno escrito por Fran a
   * mano son los dos `from_me = 1` y nada mas los distingue.
   */
  automatico?: boolean;
  /** El binario no está guardado pero conserva las claves: se puede pedir bajo demanda. */
  recuperable?: boolean;
  /* ---- paridad con WhatsApp Web (2026-09-11) ---- */
  /** Ticks reales (solo mensajes propios). */
  status?: WaEstadoMensaje | null;
  /** «Se eliminó este mensaje» (borrado para todos). El texto no se enseña. */
  revoked?: boolean;
  /** «Editado». */
  edited?: boolean;
  /** Quién lo escribió dentro de un grupo (jid canónico) y su nombre. */
  participant?: string | null;
  participantName?: string | null;
  reactions?: WaReaccion[];
  quoted?: WaCita | null;
  /** Línea de SISTEMA ya redactada («Ana se unió», «Llamada perdida», «Esperando el mensaje…»). */
  system?: string | null;
}

/* ----------------------------- Artefactos IA ----------------------------- */

export interface AiAbstract {
  oneLiner: string;
  bullets: string[];
  stage: string | null;
}

export interface AiInterests {
  interests: { label: string; evidence: string }[];
}

export interface AiSuggestion {
  reply: string;
  rationale: string;
}

export interface AiStyleProfile {
  tone: string;
  length: string;
  quirks: string[];
  closings: string[];
  emojiUsage: string;
}

export type AiArtifactKind = "abstract" | "interests" | "reply_suggestion" | "style_profile";

export interface AiArtifact<T = unknown> {
  id: number;
  /** null para artefactos globales (style_profile). */
  chatJid: string | null;
  kind: AiArtifactKind;
  content: T;
  model: string;
  generation: number;
  createdAt: number;
}

export interface AiJobStatus {
  id: number;
  status: "pending" | "running" | "done" | "error";
  kind: string;
  lastError: string | null;
}

/* --------------------------------- SSE ----------------------------------- */

export type WaSseEvent =
  | { type: "ping" } // latido visible cada 25s — el cliente reconecta si deja de llegar
  | { type: "connection"; state: WaConnectionState }
  | { type: "message.new"; jid: string }
  /** Un mensaje YA guardado cambió (ticks, reacción, borrado, edición): refresca la conversación, no la lista. */
  | { type: "message.updated"; jid: string }
  /** Presencia del contacto (o de un participante del grupo) del chat suscrito. */
  | { type: "presence"; jid: string; participant: string | null; state: WaPresencia; lastSeen: number | null }
  | { type: "chat.updated"; jid: string }
  | { type: "labels.updated" } // catálogo/asociaciones de etiquetas de WhatsApp Business
  | { type: "chats.synced" } // volcado masivo (history sync): refrescar lista entera
  | { type: "backfill.progress" } // avance del backfill de historial
  | { type: "artifact.new"; jid: string; kind: AiArtifactKind }
  | { type: "links.recomputed" };

/** Progreso del backfill de historial bajo demanda (fetchMessageHistory). */
export interface BackfillProgress {
  running: boolean;
  chatsTotal: number;
  chatsDone: number;
  /** ts (epoch s) del mensaje más antiguo alcanzado en toda la BD, o null. */
  oldestReachedTs: number | null;
  /** ts objetivo hasta el que intentamos retroceder (epoch s). */
  targetTs: number;
  messagesTotal: number;
  lastError: string | null;
}
