/**
 * Servidor HTTP del sidecar (Fastify v5). SOLO escucha en 127.0.0.1: la única
 * forma de llegar aquí desde el navegador es el proxy del dashboard
 * (/api/whatsapp/* → este puerto), así que no hay auth propia.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { config } from "../config";
import { registerStatusRoutes } from "./routes/status";
import { registerChatRoutes } from "./routes/chats";
import { registerAvatarRoutes } from "./routes/avatars";
import { registerMediaRoutes } from "./routes/media";
import { registerProgramaRoutes } from "./routes/programa";
import { registerEventRoutes } from "./routes/events";
import { registerBackfillRoutes } from "./routes/backfill";
import { registerImportRoutes } from "./routes/import";
import { registerIntelRoutes } from "./routes/intel";
import { registerNoteRoutes } from "./routes/notes";
import { registerCalendarRoutes } from "./routes/calendar";
import { registerAdminRoutes } from "./routes/admin";
import { registerPlanRoutes } from "./routes/plan";
import { registerUsageRoutes } from "./routes/usage";
import { registerProposalRoutes } from "./routes/proposals";
import { registerCallRoutes } from "./routes/calls";
import { registerRenewalRoutes } from "./routes/renewals";
import { registerLinkLeadsRoutes } from "./routes/linkLeads";
import { registerMarketingRoutes } from "./routes/marketing";
import { registerSendRoutes } from "./routes/send";
import { registerLabelRoutes } from "./routes/labels";

export async function startHttpServer(): Promise<FastifyInstance> {
  // bodyLimit alto: una exportación de chat larga puede pesar varios MB.
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });

  registerStatusRoutes(app);
  registerChatRoutes(app);
  registerAvatarRoutes(app);
  registerMediaRoutes(app); // GET /media/:jid/:id — fotos/audios/documentos ya descargados, con Range
  registerProgramaRoutes(app); // GET /programa-enviado — a quién se le mandó el dossier del programa
  registerEventRoutes(app);
  registerBackfillRoutes(app);
  registerImportRoutes(app);
  registerIntelRoutes(app);
  registerNoteRoutes(app);
  registerCalendarRoutes(app);
  registerAdminRoutes(app); // /admin/ingest — migración puntual del histórico
  registerPlanRoutes(app);
  registerUsageRoutes(app);
  registerProposalRoutes(app);
  registerCallRoutes(app);
  registerRenewalRoutes(app); // /calls/analyze-renewal — contento del alumno + mejoras del curso
  registerLinkLeadsRoutes(app);
  registerMarketingRoutes(app); // /intel/marketing-ask — resucita la barra de Inversión
  registerSendRoutes(app); // /chats/:jid/send — respuesta MANUAL desde el teléfono flotante
  registerLabelRoutes(app); // /labels y /chats/:jid/labels — etiquetas BIDIRECCIONALES
  // F1 (media de mensajes) cerrada 2026-08-06: descarga en vivo + servido con
  // Range + envío de adjuntos/notas de voz. Pendiente F2: tags/artifacts/jobs.

  await app.listen({ host: config.host, port: config.port });
  return app;
}
