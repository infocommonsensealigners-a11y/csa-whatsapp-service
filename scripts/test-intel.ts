/** Prueba las rutas de intel sin levantar Baileys ni abrir puerto (Fastify inject). */
import Fastify from "fastify";
import { registerIntelRoutes } from "../src/http/routes/intel";

const app = Fastify();
registerIntelRoutes(app);

const sum = await app.inject({ method: "GET", url: "/intel/summary" });
const body = JSON.parse(sum.body);
console.log("GET /intel/summary →", sum.statusCode);
console.log("  total:", body.total, "· byTemp:", JSON.stringify(body.byTemp));
console.log("  esperandoRespuesta:", body.esperandoRespuesta?.length, "· calientesEnfriando:", body.calientesEnfriando?.length);
for (const r of (body.esperandoRespuesta ?? []).slice(0, 3)) {
  console.log(`    · ${r.display_name ?? r.jid} — 🌡️${r.temperatura} · silencio ${r.silencio_dias}d`);
}

const list = await app.inject({ method: "GET", url: "/intel/list?temp=caliente" });
console.log("GET /intel/list?temp=caliente →", list.statusCode, "· items:", JSON.parse(list.body).items?.length);

await app.close();
process.exit(0);
