/**
 * Parser de exportaciones de chat de WhatsApp (opción "Exportar chat" del móvil).
 * Es la vía FIABLE para recuperar historial antiguo (2025…): el teléfono exporta
 * el texto ya descifrado, así que no hay pérdida por cifrado como en el vínculo.
 *
 * Soporta los dos formatos habituales en español:
 *   Android:  5/1/2025, 17:23 - Laura Gómez: Hola
 *   iOS:      [5/1/25, 17:23:45] Laura Gómez: Hola
 * Los mensajes multilínea continúan en líneas sin timestamp. Las líneas de
 * sistema (sin remitente) se descartan. Detecta adjuntos por sus marcadores.
 */

export interface ParsedMessage {
  ts: number; // epoch seconds
  sender: string;
  fromMe: boolean;
  type: "text" | "image" | "audio" | "video" | "document" | "other";
  text: string | null;
}

export interface ParseResult {
  messages: ParsedMessage[];
  senders: string[]; // remitentes distintos hallados (para elegir "yo"/lead)
  skippedSystem: number;
}

// iOS: [d/m/yy, h:mm:ss] Nombre: texto   (fecha entre corchetes)
const IOS_RE =
  /^\[(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?|am|pm)?\]\s*(?:([^:]{1,60}):\s)?(.*)$/i;
// Android: d/m/yyyy, h:mm - Nombre: texto
const ANDROID_RE =
  /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?|am|pm)?\s+-\s+(?:([^:]{1,60}):\s)?(.*)$/i;

const MEDIA_MARKERS: Array<{ re: RegExp; type: ParsedMessage["type"] }> = [
  { re: /imagen omitida|image omitted|img-.*\.(jpg|jpeg|png|webp)|\.(jpg|jpeg|png|webp)\s*\(archivo adjunto\)|foto omitida/i, type: "image" },
  { re: /video omitido|vídeo omitido|video omitted|vid-.*\.(mp4|3gp|mov)|\.(mp4|mov)\s*\(archivo adjunto\)/i, type: "video" },
  { re: /audio omitido|audio omitted|ptt-.*\.(opus|ogg|mp3|m4a)|\.(opus|ogg|m4a)\s*\(archivo adjunto\)|mensaje de voz/i, type: "audio" },
  { re: /documento omitido|document omitted|\.(pdf|docx?|xlsx?|pptx?)\s*\(archivo adjunto\)/i, type: "document" },
  { re: /multimedia omitido|media omitted|sticker omitido|gif omitido|<archivo adjunto|<attached/i, type: "other" },
];

function cleanLine(raw: string): string {
  // Quita BOM y marcas de dirección LTR/RTL que iOS/Android insertan.
  return raw.replace(/^﻿/, "").replace(/[‎‏‪-‮⁦-⁩]/g, "");
}

function toEpoch(
  d: string,
  mo: string,
  y: string,
  h: string,
  mi: string,
  s: string | undefined,
  ampm: string | undefined
): number {
  let year = Number(y);
  if (year < 100) year += 2000;
  let hour = Number(h);
  if (ampm) {
    const pm = /p/i.test(ampm);
    if (pm && hour < 12) hour += 12;
    if (!pm && hour === 12) hour = 0;
  }
  // Fecha en formato día/mes (locale español). Hora local del sistema.
  const dt = new Date(year, Number(mo) - 1, Number(d), hour, Number(mi), s ? Number(s) : 0);
  return Math.floor(dt.getTime() / 1000);
}

function classify(text: string): { type: ParsedMessage["type"]; text: string | null } {
  for (const { re, type } of MEDIA_MARKERS) {
    if (re.test(text)) return { type, text: text.trim() || null };
  }
  return { type: "text", text };
}

/**
 * @param content  contenido crudo del .txt exportado
 * @param myName   nombre EXACTO con el que aparecen tus mensajes (la cuenta de
 *                 la clínica). Si no se da, fromMe queda en false y se resuelve
 *                 después eligiendo el remitente.
 */
export function parseWhatsappExport(content: string, myName?: string): ParseResult {
  const lines = content.split(/\r?\n/);
  const messages: ParsedMessage[] = [];
  const senders = new Set<string>();
  let skippedSystem = 0;
  let current: ParsedMessage | null = null;

  for (const raw of lines) {
    const line = cleanLine(raw);
    if (!line.trim() && !current) continue;

    const m = IOS_RE.exec(line) ?? ANDROID_RE.exec(line);
    if (m) {
      const [, d, mo, y, h, mi, s, ampm, sender, body] = m;
      if (!sender) {
        // Línea de sistema (cifrado, "creaste el grupo", etc.): se ignora.
        skippedSystem++;
        current = null;
        continue;
      }
      const ts = toEpoch(d, mo, y, h, mi, s, ampm);
      const { type, text } = classify(body ?? "");
      const name = sender.trim();
      senders.add(name);
      current = {
        ts,
        sender: name,
        fromMe: myName ? name === myName : false,
        type,
        text,
      };
      messages.push(current);
    } else if (current) {
      // Continuación multilínea del mensaje anterior.
      current.text = (current.text ? current.text + "\n" : "") + line;
    }
  }

  return { messages, senders: [...senders], skippedSystem };
}
