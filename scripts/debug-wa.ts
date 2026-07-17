/**
 * Herramienta de DIAGNÓSTICO de conexión Baileys: abre un socket con auth
 * LIMPIA en una carpeta aparte (data/debug-auth-*) y vuelca los
 * connection.update completos para ver el motivo real de un cierre.
 * No toca data/auth ni la BD. Variantes: min | ignorejid | history |
 * historydesktop | full — sirvió para aislar que syncFullHistory rompe el
 * registro con 428 "Precondition Required" (2026-07-16).
 * Uso: npx tsx scripts/debug-wa.ts [variante]
 */
import makeWASocket, {
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  Browsers,
} from "baileys";
import pino from "pino";
import { inspect } from "node:util";

const log = pino({ level: "debug", base: undefined });

async function main() {
  let version: [number, number, number] | undefined;
  try {
    const fetched = await fetchLatestBaileysVersion();
    version = fetched.version;
    console.log("[debug] fetchLatestBaileysVersion:", JSON.stringify(fetched));
  } catch (err) {
    console.log("[debug] fetchLatestBaileysVersion FALLÓ:", (err as Error).message);
  }

  const variant = process.argv[2] ?? "min";
  const { state } = await useMultiFileAuthState(`data/debug-auth-${variant}`);
  const sock = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, log) },
    logger: log,
    markOnlineOnConnect: false,
    browser:
      variant === "historydesktop"
        ? Browsers.windows("Desktop")
        : Browsers.windows("Dashboard CSA"),
    ...(variant === "ignorejid" || variant === "full" || variant === "historydesktop"
      ? { shouldIgnoreJid: (jid: string) => !jid.endsWith("@s.whatsapp.net") }
      : {}),
    ...(variant === "history" || variant === "full" || variant === "historydesktop"
      ? { syncFullHistory: true }
      : {}),
  });
  console.log("[debug] variante:", variant);

  sock.ev.on("connection.update", (update) => {
    const { qr, ...rest } = update;
    console.log("[debug] connection.update:", inspect(rest, { depth: 10 }));
    if (qr) console.log("[debug] QR RECIBIDO (len", qr.length, ")");
  });

  setTimeout(() => {
    console.log("[debug] fin de la ventana de observación (45 s)");
    process.exit(0);
  }, 45_000);
}

main();
