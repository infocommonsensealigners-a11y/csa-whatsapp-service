/**
 * Núcleo del matching WhatsApp ↔ CRM (teléfono, y por NOMBRE cuando no hay
 * teléfono — jids `@lid` de Meta Coexistence, ver src/wa/jidPhone.ts). Extraído
 * de scripts/link-leads.ts para poder correrlo también en un scheduler
 * periódico dentro del propio proceso (ver linkLeadsScheduler.ts) sin abrir una
 * segunda conexión a la BD — recibe la conexión ya abierta del proceso.
 *
 * Dos vías de matching, mismo criterio que el script manual:
 *   1. Teléfono canónico ES (9 díg.) — un teléfono duplicado en el Sheet SÍ
 *      linka a todos los leads que lo comparten (señal fuerte).
 *   2. Por nombre (nombre completo exacto normalizado; si el nombre de
 *      WhatsApp es una sola palabra, también por nombre de pila) — un nombre
 *      con MÁS de una coincidencia NO se linka a ciegas, se reporta como
 *      ambiguo para resolver a mano.
 *
 * Idempotente: re-ejecutar actualiza; los enlaces 'manual' NO se tocan; los
 * 'auto' que ya no casen se marcan 'removed'.
 */
import type Database from "better-sqlite3";

export interface DatasetLead {
  sourceRow: number;
  telefono?: string;
  nombre?: string;
  estado?: { canonical?: string };
}

export interface AmbiguousMatch {
  jid: string;
  display_name: string | null;
  candidatos: string[];
}

export interface NoMatchChat {
  jid: string;
  display_name: string | null;
  phone: string | null;
}

export interface LinkLeadsResult {
  dirCount: number;
  linkCount: number;
  removed: number;
  chatsTotal: number;
  chatsLinked: number;
  chatsMulti: number;
  chatsNoLead: number;
  chatsLinkedByName: number;
  chatsNoLeadByName: number;
  chatsAmbiguousByName: number;
  ambiguous: AmbiguousMatch[];
  /** Chats sin NINGÚN lead candidato (ni por teléfono ni por nombre) — genuinamente
   *  nuevos. Fuente para la Fase 2 (auto-crear ficha mínima), ver linkLeadsScheduler.ts. */
  noMatch: NoMatchChat[];
}

/** Móvil ES canónico (9 díg.) o null. Tolera +34 / 0034 / espacios. */
function canon(raw: unknown): string | null {
  const d = String(raw ?? "").replace(/\D/g, "");
  let x = d;
  if (x.length === 11 && x.startsWith("34")) x = x.slice(2);
  else if (x.length === 13 && x.startsWith("0034")) x = x.slice(4);
  return /^[6789]\d{8}$/.test(x) ? x : null;
}

/** Nombre normalizado para comparar: sin acentos/mayúsculas/emoji/puntuación, espacios colapsados. */
function normName(raw: unknown): string {
  return String(raw ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // acentos (tras NFD, marcas combinantes)
    .replace(/[^\p{L}\s'-]/gu, "") // emoji, puntuación, dígitos
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

interface NameCandidate {
  sourceRow: number;
  name: string;
}

/**
 * Ejecuta el matching completo sobre `db` (conexión ya abierta) con los leads
 * ya obtenidos del dashboard. Pura respecto a I/O de red — quien llama se
 * encarga de conseguir `leads` (login + GET /api/dataset, o cache).
 */
export function runLeadLinking(db: Database.Database, leads: DatasetLead[]): LinkLeadsResult {
  const now = Math.floor(Date.now() / 1000);

  // Índice teléfono → leads (un teléfono puede repetirse en varias filas).
  const byPhone = new Map<string, { sourceRow: number; name: string; estado: string | null }[]>();
  const dirRows: { sourceRow: number; phone: string; name: string; estado: string | null }[] = [];
  for (const l of leads) {
    const phone = canon(l.telefono);
    if (!phone) continue;
    const name = (l.nombre ?? "").trim();
    const estado = l.estado?.canonical ?? null;
    dirRows.push({ sourceRow: l.sourceRow, phone, name, estado });
    const arr = byPhone.get(phone) ?? [];
    arr.push({ sourceRow: l.sourceRow, name, estado });
    byPhone.set(phone, arr);
  }

  // Índices por NOMBRE (para chats sin teléfono) — sobre TODOS los leads con
  // nombre, tengan o no teléfono válido.
  const byFullName = new Map<string, NameCandidate[]>();
  const byFirstToken = new Map<string, NameCandidate[]>();
  for (const l of leads) {
    const nombre = (l.nombre ?? "").trim();
    if (!nombre) continue;
    const full = normName(nombre);
    if (!full) continue;
    const rec: NameCandidate = { sourceRow: l.sourceRow, name: nombre };
    (byFullName.get(full) ?? byFullName.set(full, []).get(full)!).push(rec);
    const first = full.split(" ")[0];
    if (first) (byFirstToken.get(first) ?? byFirstToken.set(first, []).get(first)!).push(rec);
  }

  function matchByName(displayName: string | null): NameCandidate[] {
    const norm = normName(displayName);
    if (!norm) return [];
    const exact = byFullName.get(norm);
    if (exact && exact.length) return exact;
    if (!norm.includes(" ")) {
      const byFirst = byFirstToken.get(norm);
      if (byFirst && byFirst.length) return byFirst;
    }
    return [];
  }

  const upDir = db.prepare(
    `INSERT INTO lead_directory (source_row, phone, name, estado, synced_at)
     VALUES (@sourceRow, @phone, @name, @estado, @now)
     ON CONFLICT(source_row) DO UPDATE SET
       phone=excluded.phone, name=excluded.name, estado=excluded.estado, synced_at=excluded.synced_at`
  );
  const upLink = db.prepare(
    `INSERT INTO chat_lead_links
       (chat_jid, source_row, phone_snapshot, lead_name_snapshot, method, status, created_at, updated_at)
     VALUES (@jid, @sourceRow, @phone, @name, 'auto', 'active', @now, @now)
     ON CONFLICT(chat_jid, source_row) DO UPDATE SET
       phone_snapshot=excluded.phone_snapshot,
       lead_name_snapshot=excluded.lead_name_snapshot,
       status='active', updated_at=excluded.updated_at
     WHERE chat_lead_links.method='auto'`
  );
  const staleLinks = db.prepare(
    `SELECT chat_jid, source_row FROM chat_lead_links WHERE method='auto' AND status='active'`
  );
  const markRemoved = db.prepare(
    `UPDATE chat_lead_links SET status='removed', updated_at=@now WHERE chat_jid=@jid AND source_row=@sourceRow`
  );

  const chats = db.prepare("SELECT jid, phone, display_name FROM chats").all() as {
    jid: string;
    phone: string | null;
    display_name: string | null;
  }[];

  let dirCount = 0,
    linkCount = 0,
    chatsLinked = 0,
    chatsMulti = 0,
    chatsNoLead = 0,
    chatsLinkedByName = 0,
    chatsNoLeadByName = 0,
    chatsAmbiguousByName = 0;
  const ambiguous: AmbiguousMatch[] = [];
  const noMatch: NoMatchChat[] = [];
  const wanted = new Set<string>();

  const tx = db.transaction(() => {
    for (const d of dirRows) {
      upDir.run({ ...d, now });
      dirCount++;
    }
    for (const c of chats) {
      if (c.phone) {
        const matches = byPhone.get(c.phone) ?? [];
        if (matches.length === 0) {
          chatsNoLead++;
          noMatch.push({ jid: c.jid, display_name: c.display_name, phone: c.phone });
          continue;
        }
        if (matches.length > 1) chatsMulti++;
        chatsLinked++;
        for (const m of matches) {
          upLink.run({ jid: c.jid, sourceRow: m.sourceRow, phone: c.phone, name: m.name, now });
          wanted.add(`${c.jid}|${m.sourceRow}`);
          linkCount++;
        }
        continue;
      }
      const matches = matchByName(c.display_name);
      if (matches.length === 0) {
        chatsNoLeadByName++;
        noMatch.push({ jid: c.jid, display_name: c.display_name, phone: null });
        continue;
      }
      if (matches.length > 1) {
        chatsAmbiguousByName++;
        ambiguous.push({
          jid: c.jid,
          display_name: c.display_name,
          candidatos: matches.map((m) => `${m.name} (fila ${m.sourceRow})`),
        });
        continue;
      }
      chatsLinkedByName++;
      const m = matches[0];
      upLink.run({ jid: c.jid, sourceRow: m.sourceRow, phone: null, name: m.name, now });
      wanted.add(`${c.jid}|${m.sourceRow}`);
      linkCount++;
    }
    let removed = 0;
    for (const l of staleLinks.all() as { chat_jid: string; source_row: number }[]) {
      if (!wanted.has(`${l.chat_jid}|${l.source_row}`)) {
        markRemoved.run({ jid: l.chat_jid, sourceRow: l.source_row, now });
        removed++;
      }
    }
    return removed;
  });
  const removed = tx();

  return {
    dirCount,
    linkCount,
    removed,
    chatsTotal: chats.length,
    chatsLinked,
    chatsMulti,
    chatsNoLead,
    chatsLinkedByName,
    chatsNoLeadByName,
    chatsAmbiguousByName,
    ambiguous,
    noMatch,
  };
}
