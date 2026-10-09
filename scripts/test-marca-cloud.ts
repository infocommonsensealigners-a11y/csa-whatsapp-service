/**
 * POST /campanas/marca — los avisos del dashboard sobre sus envíos por la API
 * de Meta, contra la base REAL del servicio (en una carpeta temporal).
 *
 *   npx tsx scripts/test-marca-cloud.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marca-cloud-"));
process.env.WA_DATA_DIR = dir;
process.env.FRANSUA_INTERNAL_TOKEN = "t-prueba";

let fallos = 0;
let oks = 0;
function ok(cond: unknown, que: string): void {
  if (cond) oks++;
  else {
    fallos++;
    console.error("✗", que);
  }
}

async function main(): Promise<void> {
  const Fastify = (await import("fastify")).default;
  const { getDb, openDb } = await import("../src/db/db");
  openDb();
  const { registerCampanaRoutes } = await import("../src/http/routes/campanas");
  const { marcasDeChat, hayAnuncioCerca } = await import("../src/campanas/marcas");
  const { esDeLaAutomatizacion } = await import("../src/campanas/manual");

  const db = getDb();
  const ahora = Math.floor(Date.now() / 1000);
  const t0 = Date.now();
  db.prepare(`INSERT INTO chats (jid, phone, created_at, updated_at) VALUES (?,?,?,?)`).run("34693909824@s.whatsapp.net", "693909824", t0, t0);
  // Una persona que solo tiene chat @lid sin fundir.
  db.prepare(`INSERT INTO chats (jid, phone, created_at, updated_at, last_message_at) VALUES (?,?,?,?,?)`).run("999@lid", "611222333", t0, t0, t0);

  const app = Fastify();
  registerCampanaRoutes(app);
  const post = (body: unknown, token = "t-prueba") =>
    app.inject({ method: "POST", url: "/campanas/marca", headers: { "x-fransua-token": token }, payload: body as object });

  // Sin token → 401, y no escribe nada.
  ok((await post({ fase: "anuncio", telefono: "693909824" }, "malo")).statusCode === 401, "token malo → 401");
  ok(!hayAnuncioCerca("693909824", ahora, 90), "sin token no queda anuncio");

  // Anuncio → el eco de un mensaje sin marca, pegado al anuncio, es de la automatización.
  const r1 = await post({ fase: "anuncio", telefono: "693909824", campanaId: "c1", campana: "CRM GESTIÓN JAVI" });
  ok(r1.statusCode === 200 && r1.json().ok === true, "anuncio → 200");
  ok(esDeLaAutomatizacion("ID-ECO-1", "34693909824@s.whatsapp.net", ahora + 5), "eco tras anuncio = automático");
  ok(!esDeLaAutomatizacion("ID-ECO-2", "34693909824@s.whatsapp.net", ahora + 600), "10 min después = a mano");
  ok(!esDeLaAutomatizacion("ID-ECO-3", "34611222333@s.whatsapp.net", ahora + 5), "otro teléfono = a mano");
  // El teléfono puede venir en E.164.
  ok(hayAnuncioCerca("+34 693 909 824", ahora, 90), "teléfono con +34 casa");

  // Enviado → marca de agua con el id interno.
  const r2 = await post({ fase: "enviado", telefono: "693909824", campanaId: "c1", campana: "CRM GESTIÓN JAVI", waMsgId: "3EB0ABCDEF0123456789" });
  ok(r2.statusCode === 200 && r2.json().jid === "34693909824@s.whatsapp.net", "enviado → chat del teléfono");
  const m = marcasDeChat("34693909824@s.whatsapp.net");
  ok(m.automaticos.includes("3EB0ABCDEF0123456789"), "marca de agua guardada");
  ok(m.campana === "CRM GESTIÓN JAVI", "nombre de campaña en el chat");
  ok(esDeLaAutomatizacion("3EB0ABCDEF0123456789", "34693909824@s.whatsapp.net", ahora + 99999), "por id, pase el tiempo que pase");
  // Repetido (el dashboard reintenta) → no duplica.
  await post({ fase: "enviado", telefono: "693909824", campanaId: "c1", campana: "CRM GESTIÓN JAVI", waMsgId: "3EB0ABCDEF0123456789" });
  ok(marcasDeChat("34693909824@s.whatsapp.net").automaticos.length === 1, "sin duplicar la marca");

  // Nota → nota interna.
  const r3 = await post({ fase: "nota", telefono: "693909824", campanaId: "c1", campana: "x", nota: "Cualificado · clínica propia" });
  ok(r3.statusCode === 200, "nota → 200");
  ok(marcasDeChat("34693909824@s.whatsapp.net").notas.some((n) => n.nota === "Cualificado · clínica propia"), "nota guardada");

  // Persona con solo chat @lid → la marca va a ese chat, donde Fran la ve.
  const r4 = await post({ fase: "nota", telefono: "611222333", campanaId: "c1", nota: "hola" });
  ok(r4.json().jid === "999@lid", "sin chat de teléfono → el @lid con ese teléfono");
  // Persona sin chat → al canónico (lo creará el eco).
  const r5 = await post({ fase: "enviado", telefono: "622333444", campanaId: "c1", campana: "c", waMsgId: "X1" });
  ok(r5.json().jid === "34622333444@s.whatsapp.net", "sin chat → jid del teléfono");
  // Internacional.
  const r6 = await post({ fase: "anuncio", telefono: "+351912345678", campanaId: "c1" });
  ok(r6.json().ok === true && esDeLaAutomatizacion("Z", "351912345678@s.whatsapp.net", ahora + 3), "internacional");

  // Basura.
  ok((await post({ fase: "anuncio", telefono: "abc" })).statusCode === 400, "teléfono inválido → 400");
  ok((await post({ fase: "otra", telefono: "693909824" })).statusCode === 400, "fase desconocida → 400");
  ok((await post({ fase: "enviado", telefono: "693909824" })).statusCode === 400, "enviado sin id → 400");

  await app.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(fallos ? `✗ ${fallos} fallos, ${oks} OK` : `✓ ${oks} OK`);
  process.exit(fallos ? 1 : 0);
}
void main();
