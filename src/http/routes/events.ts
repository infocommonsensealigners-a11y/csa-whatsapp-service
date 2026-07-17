/**
 * GET /events — stream SSE de WaSseEvent (ver shared/whatsapp-contracts.ts).
 * El dashboard lo consume vía el proxy con EventSource.
 */
import type { FastifyInstance } from "fastify";
import { addSseClient, removeSseClient } from "../sse";

export function registerEventRoutes(app: FastifyInstance): void {
  app.get("/events", (request, reply) => {
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    reply.raw.write("retry: 3000\n\n");
    addSseClient(reply.raw);
    request.raw.on("close", () => removeSseClient(reply.raw));
  });
}
