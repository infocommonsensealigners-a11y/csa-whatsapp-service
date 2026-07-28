/**
 * MARKETING-ASK — la barra de Fransua del módulo Inversión (dashboard) llama a
 * `/intel/marketing-ask` desde hace tiempo (`dashboard/app/api/marketing/ask/route.ts`),
 * pero el endpoint NUNCA existió aquí: la integración de marketing llevaba
 * MUERTA desde que se construyó la UI (`FransuaMarketingBar.tsx`, tampoco
 * montada — ver auditoría 2026-07-28, DOCS/DIAGNOSTICO-INTEGRAL-2026-07-28.md,
 * eje 1.2). Este fichero cierra el círculo: Fransua interpreta el resumen
 * AGREGADO de inversión (gasto, CPL, ROAS, canales — nunca datos de un lead
 * concreto, eso lo filtra el propio dashboard antes de mandarlo) con el mismo
 * contexto de negocio que usa en /intel/ask.
 */
import type { FastifyInstance } from "fastify";
import { runText } from "../../ai/agent";
import { getBusinessSnapshot } from "../../brain/businessSnapshot";
import { getPlanContext } from "../../brain/plan";

const askModel = process.env.WA_AI_MODEL_ASK ?? process.env.WA_AI_MODEL_SUGGEST ?? "sonnet";

function formatResumen(resumen: unknown): string {
  try {
    return JSON.stringify(resumen ?? {}, null, 2).slice(0, 6000);
  } catch {
    return "(resumen no serializable)";
  }
}

export function registerMarketingRoutes(app: FastifyInstance): void {
  app.post("/intel/marketing-ask", async (req, reply) => {
    const body = (req.body ?? {}) as { pregunta?: string; resumen?: unknown };
    const pregunta = String(body.pregunta ?? "").trim();
    if (!pregunta) return reply.status(400).send({ ok: false, error: "pregunta vacía" });

    const [negocio, plan] = await Promise.all([
      getBusinessSnapshot().catch(() => null),
      getPlanContext().then((p) => p.texto).catch(() => null),
    ]);

    const prompt = [
      "Eres Fransua, el cerebro comercial de Common Sense Aligners (CSA), que VENDE FORMACIÓN a",
      "dentistas (programa SBA, certificación, mentoría, estancia clínica) — NO trata pacientes.",
      "Ahora te preguntan desde el módulo de INVERSIÓN/MARKETING (gasto en Ads, CPL, ROAS, canales,",
      "presupuestos). Responde en ESPAÑOL, con acciones concretas sobre dónde invertir o recortar,",
      "basándote SOLO en el resumen agregado de abajo — NUNCA nombres de leads concretos, no los tienes.",
      "",
      "FORMATO: arranca directo con la respuesta (sin saludos). Máximo ~120 palabras. Si el resumen no",
      "trae dato suficiente para algo, dilo con franqueza en vez de inventar cifras.",
      "",
      plan || "",
      negocio ? negocio + "\n" : "",
      "=== RESUMEN AGREGADO DE INVERSIÓN (del panel activo) ===",
      formatResumen(body.resumen),
      "",
      `Fran: ${pregunta}`,
      "Fransua:",
    ]
      .filter(Boolean)
      .join("\n");

    try {
      const respuesta = await runText(prompt, askModel);
      return { ok: true, aiAvailable: true, respuesta: respuesta || "(sin respuesta)" };
    } catch (e) {
      return reply.status(502).send({ ok: false, aiAvailable: false, error: (e as Error).message });
    }
  });
}
