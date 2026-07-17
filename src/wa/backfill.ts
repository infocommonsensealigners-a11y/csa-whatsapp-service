/**
 * Worker de BACKFILL de historial. WhatsApp no vuelca todo el archivo a un
 * dispositivo vinculado, pero sí permite pedir tramos anteriores bajo demanda
 * (fetchMessageHistory). Este worker recorre cada chat que ya tiene algún
 * mensaje (ancla) y va retrocediendo página a página hasta:
 *   - alcanzar la fecha objetivo (config.backfillSince), o
 *   - que WhatsApp deje de devolver mensajes más antiguos (agotado).
 *
 * Es un proceso LENTO y GENTIL a propósito (una petición cada vez, con pausas)
 * para no forzar el ritmo ni arriesgar la sesión. La respuesta a cada petición
 * llega asíncrona como messaging-history.set y la ingiere ingest.ts; aquí solo
 * lanzamos la petición y sondeamos la BD para ver si bajó el mensaje más antiguo.
 */
import { getDb, setMeta } from "../db/db";
import { emitSse } from "../http/sse";
import { config } from "../config";
import { getWaState, requestOlderHistory } from "./socket";
import type { BackfillProgress } from "../../../shared/whatsapp-contracts";

const PAGE_SIZE = 50;
const MAX_PAGES_PER_CHAT = 40; // tope de seguridad (~2000 msgs/chat)
const GAP_MS = 4_000; // pausa entre peticiones (gentil / anti-rate-limit)
const WAIT_MS = 22_000; // espera máx. a que llegue la respuesta async
const POLL_MS = 1_000;

let running = false;
let stopFlag = false;
let lastError: string | null = null;
let chatsTotal = 0;
let chatsDone = 0;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function targetTs(): number {
  return Math.floor(new Date(`${config.backfillSince}T00:00:00Z`).getTime() / 1000);
}

function oldestReached(): number | null {
  const row = getDb().prepare("SELECT MIN(ts) AS t FROM messages").get() as { t: number | null };
  return row.t ?? null;
}

function messagesTotal(): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;
}

export function getBackfillProgress(): BackfillProgress {
  return {
    running,
    chatsTotal,
    chatsDone,
    oldestReachedTs: oldestReached(),
    targetTs: targetTs(),
    messagesTotal: messagesTotal(),
    lastError,
  };
}

export function stopBackfill(): void {
  stopFlag = true;
}

export function startBackfill(): { started: boolean; reason?: string } {
  if (running) return { started: false, reason: "Ya está en marcha." };
  if (getWaState() !== "open") return { started: false, reason: "WhatsApp no está conectado." };
  running = true;
  stopFlag = false;
  lastError = null;
  chatsDone = 0;
  void runLoop();
  return { started: true };
}

async function runLoop(): Promise<void> {
  const db = getDb();
  try {
    const chats = db
      .prepare(
        `SELECT jid FROM chats
         WHERE ignored = 0 AND (backfill_status IS NULL OR backfill_status = 'partial')
         ORDER BY last_message_at DESC`
      )
      .all() as { jid: string }[];
    chatsTotal = chats.length;
    emitSse({ type: "backfill.progress" });

    for (const { jid } of chats) {
      if (stopFlag) break;
      await backfillChat(jid);
      chatsDone++;
      emitSse({ type: "backfill.progress" });
    }
  } catch (err) {
    lastError = (err as Error).message;
    console.error("[backfill] error:", lastError);
  } finally {
    running = false;
    setMeta("backfill_last_run", String(Math.floor(Date.now() / 1000)));
    emitSse({ type: "backfill.progress" });
    console.log(`[backfill] terminado. chats=${chatsDone}/${chatsTotal} oldest=${oldestReached()}`);
  }
}

function markStatus(jid: string, status: "done" | "exhausted" | "partial"): void {
  getDb().prepare("UPDATE chats SET backfill_status = ?, updated_at = ? WHERE jid = ?").run(
    status,
    Math.floor(Date.now() / 1000),
    jid
  );
}

async function backfillChat(jid: string): Promise<void> {
  const db = getDb();
  const oldestStmt = db.prepare(
    "SELECT id, from_me, ts FROM messages WHERE chat_jid = ? ORDER BY ts ASC LIMIT 1"
  );
  const target = targetTs();
  let staleRounds = 0;

  for (let page = 0; page < MAX_PAGES_PER_CHAT; page++) {
    if (stopFlag) return;
    const oldest = oldestStmt.get(jid) as { id: string; from_me: number; ts: number } | undefined;
    if (!oldest) return; // sin ancla, no se puede pedir historial
    if (oldest.ts <= target) {
      markStatus(jid, "done");
      return;
    }

    const ok = await requestOlderHistory(
      { remoteJid: jid, id: oldest.id, fromMe: oldest.from_me === 1 },
      oldest.ts,
      PAGE_SIZE
    );
    if (!ok) {
      markStatus(jid, "partial");
      return;
    }

    const moved = await waitForOlder(jid, oldest.ts);
    if (moved) {
      staleRounds = 0;
      emitSse({ type: "backfill.progress" });
    } else {
      // Dos rondas sin novedades → WhatsApp no da más historial de este chat.
      staleRounds++;
      if (staleRounds >= 2) {
        markStatus(jid, "exhausted");
        return;
      }
    }
    await delay(GAP_MS);
  }
  markStatus(jid, "partial"); // llegó al tope de páginas; se puede retomar
}

/** Sondea hasta que el mensaje más antiguo del chat baje de `baselineTs` o expire. */
async function waitForOlder(jid: string, baselineTs: number): Promise<boolean> {
  const db = getDb();
  const stmt = db.prepare("SELECT MIN(ts) AS t FROM messages WHERE chat_jid = ?");
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (stopFlag) return false;
    await delay(POLL_MS);
    const row = stmt.get(jid) as { t: number | null };
    if (row.t != null && row.t < baselineTs) return true;
  }
  return false;
}
