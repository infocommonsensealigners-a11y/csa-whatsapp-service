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
import { registerEventRoutes } from "./routes/events";
import { registerBackfillRoutes } from "./routes/backfill";
import { registerImportRoutes } from "./routes/import";
import { registerIntelRoutes } from "./routes/intel";
import { registerCalendarRoutes } from "./routes/calendar";

export async function startHttpServer(): Promise<FastifyInstance> {
  // bodyLimit alto: una exportación de chat larga puede pesar varios MB.
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });

  registerStatusRoutes(app);
  registerChatRoutes(app);
  registerAvatarRoutes(app);
  registerEventRoutes(app);
  registerBackfillRoutes(app);
  registerImportRoutes(app);
  registerIntelRoutes(app);
  registerCalendarRoutes(app);
  // Pendiente F1: media de mensajes + links/matcher. F2: tags/artifacts/jobs.

  await app.listen({ host: config.host, port: config.port });
  return app;
}
