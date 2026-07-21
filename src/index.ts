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
import { ensureClaudeAuth } from "./brain/secrets";

async function main(): Promise<void> {
  ensureDataDirs();
  openDb();
  registerIngest();

  // Credencial de Claude para Fransua: si no hay token/API key en el entorno,
  // intenta cargar el token de SUSCRIPCIÓN desde Supabase (gratis, sin coste de
  // API). Así el sidecar de Railway interpreta sin tocar sus variables a mano.
  try {
    const aiReady = await ensureClaudeAuth();
    console.log(
      aiReady
        ? "[ai] Credencial de Claude lista → Fransua interpreta notas."
        : "[ai] Sin credencial de Claude → Fransua guarda notas pero NO interpreta (pon el token de suscripción: scripts/set-oauth-token.ts)."
    );
  } catch (e) {
    console.error("[ai] Error comprobando credencial de Claude:", (e as Error).message);
  }

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
  // Tolerante a mayúsculas/espacios para que un valor tipo "Off " no lo active.
  const wantConnect = (process.env.WA_CONNECT ?? "").trim().toLowerCase() !== "off";
  if (wantConnect) {
    // BLINDAJE: si Baileys peta al arrancar (red, auth corrupta…) NO debe abortar
    // el bootstrap — el servidor HTTP tiene que arrancar igual para seguir sirviendo
    // intel/agenda/histórico. El fallo se registra y la reconexión con backoff (en
    // socket.ts) lo reintenta sola. Nunca tumba el proceso.
    startWhatsapp().catch((err) => {
      console.error("[wa] startWhatsapp falló al arrancar (se reintentará solo):", (err as Error).message);
    });
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

// Resiliencia en producción: un error async suelto (Baileys, tarea de fondo…) NO
// debe tumbar el proceso — el servidor HTTP sigue sirviendo intel/agenda/calendar.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

main().catch((err) => {
  console.error("[fatal] El sidecar no pudo arrancar:", err);
  process.exit(1);
});
