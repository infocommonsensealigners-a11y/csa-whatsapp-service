/**
 * Rutas de estado y sesión (Fase 0):
 *  - GET  /health         → liveness básico.
 *  - GET  /status         → WaStatus completo (incluye QR dataURL si toca).
 *  - POST /session/reset  → borra data/auth y fuerza re-emparejamiento (QR nuevo).
 */
import type { FastifyInstance } from "fastify";
import { aiQueuePending, getMeta, statusCounts } from "../../db/db";
import { getMe, getQrDataUrl, getWaState, resetSession } from "../../wa/socket";
import type { WaStatus } from "../../../../shared/whatsapp-contracts";

export function registerStatusRoutes(app: FastifyInstance): void {
  app.get("/health", async () => ({
    ok: true,
    db: true, // openDb() ya corrió en el bootstrap; si fallara, el proceso no llega aquí
    wa: getWaState(),
  }));

  app.get("/status", async (): Promise<WaStatus> => {
    const lastSync = getMeta("last_history_sync");
    return {
      state: getWaState(),
      qrDataUrl: getQrDataUrl(),
      me: getMe(),
      counts: statusCounts(),
      lastHistorySyncAt: lastSync ? Number(lastSync) : null,
      aiQueue: { pending: aiQueuePending(), paused: false },
    };
  });

  // Página mínima para emparejar sin UI del dashboard (Fase 0): muestra el QR
  // y se auto-refresca. En Fase 1 el QR se integra en la pestaña WhatsApp.
  app.get("/qr", async (_request, reply) => {
    const state = getWaState();
    const qr = getQrDataUrl();
    const body =
      state === "open"
        ? `<h2>✅ Sesión vinculada</h2><p>${getMe()?.name ?? ""} — ${getMe()?.jid ?? ""}</p>`
        : qr
          ? `<h2>Escanea con WhatsApp Business</h2>
             <p>Móvil → Ajustes → Dispositivos vinculados → Vincular un dispositivo</p>
             <img src="${qr}" alt="QR de emparejamiento" width="320" height="320" />`
          : `<h2>Esperando QR… (estado: ${state})</h2>`;
    reply.type("text/html").send(
      `<!doctype html><html lang="es"><head><meta charset="utf-8">
       <meta http-equiv="refresh" content="5">
       <title>WhatsApp CSA — Emparejamiento</title>
       <style>body{font-family:system-ui;background:#0b0713;color:#f5f2fb;
         display:grid;place-items:center;min-height:100vh;text-align:center}
         img{border-radius:12px;background:#fff;padding:12px}</style>
       </head><body><div>${body}</div></body></html>`
    );
  });

  app.post("/session/reset", async (request, reply) => {
    const body = request.body as { confirm?: unknown } | null;
    if (body?.confirm !== true) {
      return reply
        .status(400)
        .send({ ok: false, error: 'Requiere body { "confirm": true } — borra la sesión vinculada.' });
    }
    await resetSession();
    return { ok: true };
  });
}
