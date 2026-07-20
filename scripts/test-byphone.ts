/** Verifica /intel/by-phone: resolución estable por teléfono. */
import Fastify from "fastify";
import { registerIntelRoutes } from "../src/http/routes/intel";

const app = Fastify();
registerIntelRoutes(app);

for (const phone of ["685551883", "687228105", "676865259"]) {
  const r = await app.inject({ method: "GET", url: `/intel/by-phone/${phone}` });
  const j = JSON.parse(r.body);
  const it = j.items?.[0];
  console.log(`by-phone/${phone} → ${r.statusCode} · found=${j.found} · ${it ? `${it.display_name} (🌡️${it.temperatura}, sr=${it.source_row})` : "—"}`);
}
await app.close();
process.exit(0);
