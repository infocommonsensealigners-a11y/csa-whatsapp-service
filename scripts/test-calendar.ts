/** Prueba end-to-end de las rutas de agenda (Fastify inject, sin puerto). */
import Fastify from "fastify";
import { registerCalendarRoutes } from "../src/http/routes/calendar";

const app = Fastify();
registerCalendarRoutes(app);

const start = new Date(Date.now() + 3600_000).toISOString();
// 1) crear
const created = await app.inject({
  method: "POST",
  url: "/calendar/events",
  payload: { titulo: "PRUEBA Fransua — borrar", tipo: "seguimiento", start_at: start, origen: "fransua", source_row: 999999 },
});
console.log("POST /calendar/events →", created.statusCode);
const ev = JSON.parse(created.body).event;
console.log("  creado id:", ev?.id, "· tipo:", ev?.tipo, "· origen:", ev?.origen);

// 2) leer rango
const list = await app.inject({ method: "GET", url: `/calendar/events?from=${new Date(Date.now() - 86400000).toISOString()}&to=${new Date(Date.now() + 7 * 86400000).toISOString()}` });
console.log("GET /calendar/events →", list.statusCode, "· items:", JSON.parse(list.body).items?.length);

// 3) agenda (widget)
const agenda = await app.inject({ method: "GET", url: "/calendar/agenda" });
const a = JSON.parse(agenda.body);
console.log("GET /calendar/agenda →", agenda.statusCode, "· hoy:", a.counts?.today, "· semana:", a.counts?.week);

// 4) editar
const patched = await app.inject({ method: "PATCH", url: `/calendar/events/${ev.id}`, payload: { titulo: "PRUEBA editada", tipo: "cita" } });
console.log("PATCH →", patched.statusCode, "· nuevo título:", JSON.parse(patched.body).event?.titulo, "· tipo:", JSON.parse(patched.body).event?.tipo);

// 5) borrar (hard, para no dejar basura)
const del = await app.inject({ method: "DELETE", url: `/calendar/events/${ev.id}?hard=1` });
console.log("DELETE →", del.statusCode, JSON.parse(del.body).ok ? "· limpiado ✓" : "");

await app.close();
process.exit(0);
