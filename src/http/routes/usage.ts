/**
 * Consumo de IA de Fransua — para el panel de administrador del dashboard.
 *  - GET /usage/fransua?days=30 → histórico diario + el día de hoy aparte
 *    (SOLO Fransua: todo pasa por ai/agent.ts).
 *  - GET /usage/account → último snapshot del ESTADO DE LA CUENTA de Claude
 *    (ventanas 5h/7d, API experimental) — esto es TODA la cuenta, no solo
 *    Fransua; el dashboard debe dejarlo claro en la UI.
 */
import type { FastifyInstance } from "fastify";
import { brainConfigured } from "../../brain/supabase";
import { dailyUsage, latestAccountSnapshot, madridDateKey } from "../../brain/usage";

export function registerUsageRoutes(app: FastifyInstance): void {
  app.get("/usage/fransua", async (req, reply) => {
    if (!brainConfigured()) return reply.status(503).send({ ok: false, error: "brain-not-configured" });
    const days = Math.min(Math.max(Number((req.query as any)?.days) || 30, 1), 90);
    try {
      const daily = await dailyUsage(days);
      const todayKey = madridDateKey();
      const today = daily.find((d) => d.date === todayKey) ?? null;
      return { ok: true, today, daily };
    } catch (e) {
      return reply.status(502).send({ ok: false, error: (e as Error).message });
    }
  });

  app.get("/usage/account", async (_req, reply) => {
    if (!brainConfigured()) return reply.status(503).send({ ok: false, error: "brain-not-configured" });
    try {
      const snapshot = await latestAccountSnapshot();
      return { ok: true, snapshot };
    } catch (e) {
      return reply.status(502).send({ ok: false, error: (e as Error).message });
    }
  });
}
