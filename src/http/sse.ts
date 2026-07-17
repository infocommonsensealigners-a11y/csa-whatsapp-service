/**
 * Bus de eventos Server-Sent Events: la ingesta y la fachada WhatsApp publican
 * aquí, y GET /events reparte a todos los clientes conectados (el dashboard
 * los recibe vía el proxy /api/whatsapp/events). Heartbeat cada 25 s para que
 * proxies/navegadores no cierren la conexión por inactividad.
 */
import type { ServerResponse } from "node:http";
import type { WaSseEvent } from "../../../shared/whatsapp-contracts";

const clients = new Set<ServerResponse>();
let heartbeat: NodeJS.Timeout | null = null;

export function addSseClient(res: ServerResponse): void {
  clients.add(res);
  if (!heartbeat) {
    heartbeat = setInterval(() => {
      for (const c of clients) c.write(": hb\n\n");
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
