/**
 * Worker de asimilación (aprendizaje 2024+).
 *
 * Recorre las conversaciones locales (wa.sqlite3), y por cada chat:
 *   - calcula estadísticas e intervalos de forma DETERMINISTA (en código),
 *   - pide a haiku (suscripción) un JSON con resumen + temperatura + intereses + etiquetas,
 *   - vuelca la inteligencia derivada a Supabase (chat_intel).
 *
 * Los mensajes crudos NUNCA salen de la máquina; solo el resultado.
 * Es reanudable: salta chats ya asimilados cuyo último mensaje no ha cambiado.
 *
 * Uso:
 *   npx tsx --env-file=.env scripts/assimilate.ts [--limit N] [--force]
 *          [--since YYYY-MM-DD] [--min N] [--delay MS] [--model haiku]
 */
import Database from "better-sqlite3";
import { config } from "../src/config";
import { getSupabase } from "../src/brain/supabase";
import { runJson, bulkModel } from "../src/ai/agent";

// ---------- flags ----------
const argv = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
const LIMIT = flag("limit") ? Number(flag("limit")) : Infinity;
const FORCE = argv.includes("--force");
const SINCE = flag("since") ?? config.learnSince;
const MIN_MSGS = flag("min") ? Number(flag("min")) : 4;
const DELAY_MS = flag("delay") ? Number(flag("delay")) : 900;
const MODEL = flag("model") ?? bulkModel;

const sinceTs = Math.floor(new Date(SINCE + "T00:00:00Z").getTime() / 1000);
const nowSec = Math.floor(Date.now() / 1000);

// ---------- tipos ----------
type Row = { chat_jid: string; msg_count: number; from_me_count: number; first_ts: number; last_ts: number };
type Msg = { from_me: number; ts: number; type: string; text: string | null };
type Ai = {
  resumen?: string;
  temperatura?: string;
  temperatura_motivo?: string;
  intereses?: Array<{ label: string; evidence?: string }>;
  etiquetas?: string[];
  producto_mencionado?: string;
};

// ---------- helpers ----------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const MEDIA_LABEL: Record<string, string> = {
  image: "[imagen]", video: "[vídeo]", audio: "[audio]", document: "[documento]", other: "[adjunto]",
};

function computeIntervals(msgs: Msg[]) {
  const agentReplies: number[] = []; // cuánto tarda el AGENTE en responder al lead
  const leadReplies: number[] = []; // cuánto tarda el LEAD en responder al agente
  for (let i = 1; i < msgs.length; i++) {
    const prev = msgs[i - 1], cur = msgs[i];
    if (prev.from_me === cur.from_me) continue;
    const dt = cur.ts - prev.ts;
    if (dt <= 0 || dt > 60 * 60 * 24 * 14) continue; // ignora saltos > 14 días
    if (cur.from_me === 1) agentReplies.push(dt);
    else leadReplies.push(dt);
  }
  const last = msgs[msgs.length - 1];
  const spanDays = Math.max(1, Math.round((last.ts - msgs[0].ts) / 86400));
  return {
    span_dias: spanDays,
    silencio_dias: Math.round((nowSec - last.ts) / 86400),
    ultimo_emisor: last.from_me === 1 ? "agente" : "lead",
    respuesta_agente_mediana_s: median(agentReplies),
    respuesta_agente_media_s: agentReplies.length ? Math.round(agentReplies.reduce((a, b) => a + b, 0) / agentReplies.length) : null,
    respuesta_agente_n: agentReplies.length,
    respuesta_lead_mediana_s: median(leadReplies),
    respuesta_lead_n: leadReplies.length,
  };
}

function buildTranscript(msgs: Msg[]): string {
  // Acota tokens: si es muy largo, primeros 15 + últimos 55 con marca de corte.
  let sel = msgs;
  if (msgs.length > 80) {
    sel = [...msgs.slice(0, 15), { from_me: -1, ts: 0, type: "cut", text: `[...${msgs.length - 70} mensajes omitidos...]` } as any, ...msgs.slice(-55)];
  }
  const lines: string[] = [];
  let lastDay = "";
  for (const m of sel) {
    if ((m as any).type === "cut") { lines.push((m.text as string)); continue; }
    const day = new Date(m.ts * 1000).toISOString().slice(0, 10);
    if (day !== lastDay) { lines.push(`— ${day} —`); lastDay = day; }
    const who = m.from_me === 1 ? "AGENTE" : "LEAD";
    let body = (m.text ?? "").replace(/\s+/g, " ").trim();
    if (!body) body = MEDIA_LABEL[m.type] ?? "";
    if (!body) continue;
    if (body.length > 300) body = body.slice(0, 300) + "…";
    lines.push(`${who}: ${body}`);
  }
  let out = lines.join("\n");
  if (out.length > 11000) out = out.slice(-11000);
  return out;
}

function prompt(name: string, transcript: string, iv: ReturnType<typeof computeIntervals>): string {
  return `Eres el analista de Fransua, el cerebro comercial de Common Sense Aligners (CSA). CSA NO es una clínica de pacientes: vende FORMACIÓN a dentistas y clínicas — un programa/mentoría del método de alineadores (SBA), con bloques online y sesiones presenciales. El AGENTE es el equipo comercial de CSA (Fran); el LEAD es un DENTISTA o CLÍNICA que podría inscribirse en la formación. Analiza esta conversación de WhatsApp con el lead "${name}".

Contexto temporal: el lead lleva ${iv.silencio_dias} días sin actividad; el último mensaje lo envió el ${iv.ultimo_emisor}.

Devuelve SOLO un objeto JSON con EXACTAMENTE estas claves:
{
  "resumen": "2 a 4 frases: qué buscaba el dentista, en qué punto quedó la conversación y cuál es el próximo paso pendiente por parte del comercial",
  "temperatura": "caliente | templado | frio",
  "temperatura_motivo": "una frase breve que justifique la temperatura",
  "intereses": [{"label": "interés concreto (p.ej. financiación, fechas, contenido clínico, modalidad)", "evidence": "cita muy breve del chat"}],
  "etiquetas": ["etiqueta corta para el comercial"],
  "producto_mencionado": "programa | mentoría | certificación | masterclass | financiación | ninguno | otro"
}

Criterios de temperatura (intención de INSCRIBIRSE en la formación):
- caliente: pidió plaza, pidió precio concreto del programa, preguntó fechas de inicio, o mostró intención clara de apuntarse.
- templado: interesado pero con dudas o sin cerrar; conversación abierta.
- frio: sin respuesta reciente, rechazo explícito, o consulta ya resuelta sin continuidad comercial.

Etiquetas útiles (ejemplos): "quiere inscribirse", "pide precio programa", "pide info programa", "duda financiación", "pregunta fechas", "no contesta", "ya inscrito", "pregunta general". No inventes datos ni precios. Sé conciso.

CONVERSACIÓN:
${transcript}`;
}

// ---------- main ----------
const db = new Database(config.dbPath, { readonly: true });
const sb = getSupabase();

// chats candidatos
const rows = db
  .prepare(
    `SELECT chat_jid,
            COUNT(*) AS msg_count,
            SUM(from_me) AS from_me_count,
            MIN(ts) AS first_ts,
            MAX(ts) AS last_ts
     FROM messages
     GROUP BY chat_jid
     HAVING last_ts >= ? AND msg_count >= ?
     ORDER BY last_ts DESC`,
  )
  .all(sinceTs, MIN_MSGS) as Row[];

// ya asimilados (para reanudar)
const done = new Map<string, number>();
if (!FORCE) {
  const { data } = await sb.from("chat_intel").select("jid,last_ts");
  for (const r of data ?? []) done.set(r.jid as string, (r.last_ts as number) ?? 0);
}

const chatMeta = db.prepare(`SELECT phone, display_name FROM chats WHERE jid = ?`);
const linkStmt = db.prepare(
  `SELECT source_row FROM chat_lead_links WHERE chat_jid = ? AND status = 'active' ORDER BY method = 'manual' DESC, id ASC LIMIT 1`,
);
const msgStmt = db.prepare(
  `SELECT from_me, ts, type, text FROM messages WHERE chat_jid = ? ORDER BY ts ASC`,
);
const leadStmt = db.prepare(`SELECT name, estado FROM lead_directory WHERE source_row = ?`);

const pending = rows.filter((r) => FORCE || (done.get(r.chat_jid) ?? -1) < r.last_ts);
const total = Math.min(pending.length, LIMIT);
console.log(
  `Candidatos desde ${SINCE}: ${rows.length} · ya asimilados: ${rows.length - pending.length} · a procesar: ${total}` +
    (LIMIT !== Infinity ? ` (límite ${LIMIT})` : "") + ` · modelo: ${MODEL}\n`,
);

let ok = 0, fail = 0;
const failed: string[] = [];
const t0 = Date.now();

for (let i = 0; i < total; i++) {
  const r = pending[i];
  const meta = chatMeta.get(r.chat_jid) as { phone: string | null; display_name: string | null } | undefined;
  const link = linkStmt.get(r.chat_jid) as { source_row: number } | undefined;
  const lead = link ? (leadStmt.get(link.source_row) as { name: string; estado: string } | undefined) : undefined;
  const name = lead?.name || meta?.display_name || meta?.phone || r.chat_jid;

  const msgs = msgStmt.all(r.chat_jid) as Msg[];
  const iv = computeIntervals(msgs);
  const transcript = buildTranscript(msgs);

  let ai: Ai | null = null;
  for (let attempt = 0; attempt < 3 && !ai; attempt++) {
    try {
      ai = await runJson<Ai>(prompt(name, transcript, iv), MODEL);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (/rate|limit|429|overload|529/i.test(msg)) {
        console.log(`   ⏳ rate-limit, espero 60s… (${msg.slice(0, 60)})`);
        await sleep(60_000);
      } else {
        console.log(`   ⚠️ error IA: ${msg.slice(0, 80)}`);
        break;
      }
    }
  }

  const record = {
    jid: r.chat_jid,
    phone: meta?.phone ?? null,
    display_name: (lead?.name || meta?.display_name) ?? null,
    source_row: link?.source_row ?? null,
    producto: ai?.producto_mencionado ?? null,
    first_ts: r.first_ts,
    last_ts: r.last_ts,
    msg_count: r.msg_count,
    from_me_count: r.from_me_count ?? 0,
    temperatura: ai?.temperatura ?? null,
    temperatura_motivo: ai?.temperatura_motivo ?? null,
    resumen: ai?.resumen ?? null,
    intereses: ai?.intereses ?? null,
    intervalos: iv,
    etiquetas: ai?.etiquetas ?? null,
    model: MODEL,
    generation: 1,
    updated_at: new Date().toISOString(),
  };

  const { error } = await sb.from("chat_intel").upsert(record, { onConflict: "jid" });
  const tag = ai?.temperatura ? `🌡️ ${ai.temperatura}` : "sin IA";
  if (error) {
    fail++; failed.push(r.chat_jid);
    console.log(`✗ [${i + 1}/${total}] ${name} — Supabase: ${error.message}`);
  } else if (!ai) {
    fail++; failed.push(r.chat_jid);
    console.log(`△ [${i + 1}/${total}] ${name} — stats guardadas, IA falló`);
  } else {
    ok++;
    console.log(`✓ [${i + 1}/${total}] ${name} — ${tag} · ${r.msg_count} msgs`);
  }

  if (i < total - 1) await sleep(DELAY_MS);
}

const mins = ((Date.now() - t0) / 60000).toFixed(1);
console.log(`\nHecho: ${ok} ok, ${fail} con incidencia, en ${mins} min.`);
if (failed.length) console.log(`Reintentar con --force los ${failed.length} fallidos.`);
db.close();
process.exit(0);
