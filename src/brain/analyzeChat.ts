/**
 * Análisis de UNA conversación bajo demanda (Fransua en directo).
 *
 * Misma lógica que el worker por lotes `scripts/assimilate.ts`, pero para un solo
 * chat y llamable desde una ruta HTTP: calcula intervalos en código, pide a la IA
 * (suscripción) el JSON de resumen/temperatura/intereses y lo vuelca a Supabase
 * (chat_intel, upsert por jid). Se usa al abrir una conversación en el teléfono
 * (si no hay intel o está obsoleta) y desde el webhook cuando entra un mensaje.
 *
 * Los mensajes crudos NUNCA salen de la máquina; solo el resultado derivado.
 */
import { getDb } from "../db/db";
import { getSupabase, brainConfigured } from "./supabase";
import { runJson, bulkModel } from "../ai/agent";

type Msg = { from_me: number; ts: number; type: string; text: string | null };
type Ai = {
  resumen?: string;
  temperatura?: string;
  temperatura_motivo?: string;
  intereses?: Array<{ label: string; evidence?: string }>;
  etiquetas?: string[];
  producto_mencionado?: string;
};

const MEDIA_LABEL: Record<string, string> = {
  image: "[imagen]", video: "[vídeo]", audio: "[audio]", document: "[documento]", other: "[adjunto]",
};
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

function computeIntervals(msgs: Msg[]) {
  const nowSec = Math.floor(Date.now() / 1000);
  const agentReplies: number[] = [];
  const leadReplies: number[] = [];
  for (let i = 1; i < msgs.length; i++) {
    const prev = msgs[i - 1], cur = msgs[i];
    if (prev.from_me === cur.from_me) continue;
    const dt = cur.ts - prev.ts;
    if (dt <= 0 || dt > 60 * 60 * 24 * 14) continue;
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
  let sel = msgs;
  if (msgs.length > 80) {
    sel = [...msgs.slice(0, 15), { from_me: -1, ts: 0, type: "cut", text: `[...${msgs.length - 70} mensajes omitidos...]` } as Msg, ...msgs.slice(-55)];
  }
  const lines: string[] = [];
  let lastDay = "";
  for (const m of sel) {
    if ((m as Msg).type === "cut") { lines.push(m.text as string); continue; }
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

function buildPrompt(name: string, transcript: string, iv: ReturnType<typeof computeIntervals>): string {
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

export type AnalyzeResult =
  | { ok: true; record: Record<string, unknown> }
  | { ok: false; reason: string; status: number };

/** Analiza un chat y persiste la inteligencia en Supabase. */
export async function analyzeChat(jid: string): Promise<AnalyzeResult> {
  if (!brainConfigured()) return { ok: false, reason: "brain-not-configured", status: 503 };
  const db = getDb();
  const meta = db.prepare("SELECT phone, display_name FROM chats WHERE jid = ?").get(jid) as
    | { phone: string | null; display_name: string | null }
    | undefined;
  if (!meta) return { ok: false, reason: "chat no encontrado", status: 404 };

  const msgs = db
    .prepare("SELECT from_me, ts, type, text FROM messages WHERE chat_jid = ? ORDER BY ts ASC")
    .all(jid) as Msg[];
  if (msgs.length < 3) return { ok: false, reason: "conversación demasiado corta para analizar", status: 422 };

  // Resolución de nombre: link activo → lead del CRM → display_name → teléfono.
  let leadName: string | null = null;
  let sourceRow: number | null = null;
  try {
    const link = db
      .prepare("SELECT source_row FROM chat_lead_links WHERE chat_jid = ? AND status = 'active' ORDER BY method = 'manual' DESC, id ASC LIMIT 1")
      .get(jid) as { source_row: number } | undefined;
    if (link) {
      sourceRow = link.source_row;
      const lead = db.prepare("SELECT name FROM lead_directory WHERE source_row = ?").get(link.source_row) as
        | { name: string }
        | undefined;
      leadName = lead?.name ?? null;
    }
  } catch {
    /* tablas de enlace opcionales en esta BD; se ignora */
  }
  const name = leadName || meta.display_name || meta.phone || jid;

  const iv = computeIntervals(msgs);
  const transcript = buildTranscript(msgs);

  let ai: Ai | null = null;
  for (let attempt = 0; attempt < 2 && !ai; attempt++) {
    try {
      ai = await runJson<Ai>(buildPrompt(name, transcript, iv), bulkModel);
    } catch (e) {
      const m = String((e as Error)?.message ?? e);
      if (/rate|limit|429|overload|529/i.test(m)) await new Promise((r) => setTimeout(r, 4000));
      else break;
    }
  }
  if (!ai) return { ok: false, reason: "IA no disponible ahora mismo", status: 503 };

  const first_ts = msgs[0].ts;
  const last_ts = msgs[msgs.length - 1].ts;
  const from_me_count = msgs.reduce((n, m) => n + (m.from_me ? 1 : 0), 0);
  const record = {
    jid,
    phone: meta.phone ?? null,
    display_name: (leadName || meta.display_name) ?? null,
    source_row: sourceRow,
    producto: ai.producto_mencionado ?? null,
    first_ts,
    last_ts,
    msg_count: msgs.length,
    from_me_count,
    temperatura: ai.temperatura ?? null,
    temperatura_motivo: ai.temperatura_motivo ?? null,
    resumen: ai.resumen ?? null,
    intereses: ai.intereses ?? null,
    intervalos: iv,
    etiquetas: ai.etiquetas ?? null,
    model: bulkModel,
    generation: 1,
    updated_at: new Date().toISOString(),
  };

  const sb = getSupabase();
  const { error } = await sb.from("chat_intel").upsert(record, { onConflict: "jid" });
  if (error) return { ok: false, reason: error.message, status: 502 };
  return { ok: true, record };
}
