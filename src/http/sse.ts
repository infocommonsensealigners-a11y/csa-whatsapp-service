/**
 * Bus de eventos Server-Sent Events: la ingesta y la fachada WhatsApp publican
 * aquí, y GET /events reparte a todos los clientes conectados (el dashboard
 * los recibe vía el proxy /api/whatsapp/events). Heartbeat cada 25 s para que
 * proxies/navegadores no cierren la conexión por inactividad.
 */
import type { ServerResponse } from "node:http";
import type { WaSseEvent } from "../shared/whatsapp-contracts";

const clients = new Set<ServerResponse>();
let heartbeat: NodeJS.Timeout | null = null;

export function addSseClient(res: ServerResponse): void {
  clients.add(res);
  if (!heartbeat) {
    heartbeat = setInterval(() => {
      // Latido como EVENTO DE DATOS, no como comentario (auditoría realtime
      // 2026-07-29): los comentarios ": hb" son invisibles para EventSource
      // (no disparan onmessage) → el cliente no podía distinguir "canal vivo
      // sin novedades" de "conexión medio muerta". Con un ping visible, el
      // watchdog del dashboard reconecta si deja de recibirlo. write() con
      // try/catch: un cliente zombi no debe tumbar el latido de los demás.
      const frame = `data: {"type":"ping"}\n\n`;
      for (const c of clients) {
        try {
          c.write(frame);
        } catch {
          clients.delete(c);
        }
      }
    }, 25_000);
    heartbeat.unref();
  }
}

export function removeSseClient(res: ServerResponse): void {
  clients.delete(res);
}

export function emitSse(event: WaSseEvent): void {
  if (clients.size === 0) return;
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const c of clients) {
    try {
      c.write(frame);
    } catch {
      clients.delete(c);
    }
  }
}
