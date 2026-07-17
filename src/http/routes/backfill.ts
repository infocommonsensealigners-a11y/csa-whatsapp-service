/**
 * Rutas de control del backfill de historial:
 *  - GET  /backfill/status → BackfillProgress
 *  - POST /backfill/start  → inicia el worker (204/200)
 *  - POST /backfill/stop   → lo detiene
 */
import type { FastifyInstance } from "fastify";
import { getBackfillProgress, startBackfill, stopBackfill } from "../../wa/backfill";

export function registerBackfillRoutes(app: FastifyInstance): void {
  app.get("/backfill/status", async () => getBackfillProgress());

  app.post("/backfill/start", async (_req, reply) => {
    const r = startBackfill();
    if (!r.started) return reply.status(409).send({ ok: false, error: r.reason });
    return { ok: true };
  });

  app.post("/backfill/stop", async () => {
    stopBackfill();
    return { ok: true };
  });
}
