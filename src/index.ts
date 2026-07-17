/**
 * Bootstrap del sidecar WhatsApp: carpetas → SQLite → conexión Baileys → HTTP.
 * Arranque: `npm run dev` (tsx watch) o `npm start`. Puerto: ver .env (WA_PORT).
 */
import { config, ensureDataDirs } from "./config";
import { openDb } from "./db/db";
import { startHttpServer } from "./http/server";
import { emitSse } from "./http/sse";
import { registerIngest } from "./wa/ingest";
import { startWhatsapp, stopWhatsapp, onStateChange } from "./wa/socket";

async function main(): Promise<void> {
  ensureDataDirs();
  openDb();
  registerIngest();

  onStateChange((state) => {
    emitSse({ type: "connection", state });
    if (state === "needs_qr") {
      console.log(
        `[wa] Emparejamiento pendiente: abre http://${config.host}:${config.port}/status ` +
          "y escanea el qrDataUrl con WhatsApp Business (Dispositivos vinculados)."
      );
    }
  });

  // WA_CONNECT=off → modo solo-lectura: sirve intel/agenda/histórico desde
  // Supabase/SQLite SIN abrir Baileys (deploy sin tocar el emparejamiento en uso).
  if (process.env.WA_CONNECT !== "off") {
    await startWhatsapp();
  } else {
    console.log("[wa] WA_CONNECT=off → Baileys NO se conecta (modo solo lectura).");
  }
  await startHttpServer();

  console.log(`[http] Sidecar WhatsApp escuchando en http://${config.host}:${config.port}`);
  console.log("[info] Servicio de SOLO LECTURA: este proceso no puede publicar en WhatsApp.");
}

function shutdown(): void {
  console.log("[info] Cerrando sidecar WhatsApp…");
  stopWhatsapp();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  console.error("[fatal] El sidecar no pudo arrancar:", err);
  process.exit(1);
});
