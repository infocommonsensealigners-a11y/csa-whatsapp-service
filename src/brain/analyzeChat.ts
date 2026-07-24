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
import { fetchExistingChatIntel, mergeAiFields } from "./chatIntelMerge";
import { getEstrategiaCSA } from "./estrategia";
import { getLeadContext360 } from "./leadContext";

type Msg = { from_me: number; ts: number; type: string; text: string | null };
type Ai = {
  resumen?: string;
  temperatura?: string;
  temperatura_motivo?: string;
  intereses?: Array<{ label: string; evidence?: string }>;
  etiquetas?: string[];
  producto_mencionado?: string;
  /** "cliente" cuando la conversación evidencia que YA es alumno/cliente de CSA. */
  categoria?: string;
  /** false SOLO si el lead cerró la conversación (despedida/agradecimiento) y no
   *  espera respuesta — evita marcar "esperando respuesta" a quien ya se despidió. */
  requiere_respuesta?: boolean;
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

function buildPrompt(name: string, transcript: string, iv: ReturnType<typeof computeIntervals>, estrategia: string, ficha360: string | null): string {
  return `Eres el analista de Fransua, el cerebro comercial de Common Sense Aligners (CSA). CSA NO es una clínica de pacientes: vende FORMACIÓN a dentistas y clínicas — un programa/mentoría del método de alineadores (SBA), con bloques online y sesiones presenciales. El AGENTE es el equipo comercial de CSA (Fran); el LEAD es un DENTISTA o CLÍNICA que podría inscribirse en la formación. Analiza esta conversación de WhatsApp con el lead "${name}".

Contexto temporal: el lead lleva ${iv.silencio_dias} días sin actividad; el último mensaje lo envió el ${iv.ultimo_emisor}.
${ficha360 ? "\n" + ficha360 + "\n" : ""}
${estrategia}
Usa esa estrategia para situar al lead y para que el "próximo paso" del resumen sea el correcto (p.ej. si lleva bastantes días en silencio, el próximo paso es reactivar aportando valor, no insistir; si es un "más adelante", fijar fecha).

Devuelve SOLO un objeto JSON con EXACTAMENTE estas claves:
{
  "resumen": "2 a 4 frases: qué buscaba el dentista, en qué punto quedó la conversación y cuál es el próximo paso pendiente por parte del comercial",
  "temperatura": "caliente | templado | frio",
  "temperatura_motivo": "una frase breve que justifique la temperatura",
  "intereses": [{"label": "interés concreto (p.ej. financiación, fechas, contenido clínico, modalidad)", "evidence": "cita muy breve del chat"}],
  "etiquetas": ["etiqueta corta para el comercial"],
  "producto_mencionado": "programa | mentoría | certificación | masterclass | financiación | ninguno | otro",
  "categoria": "lead | cliente",
  "requiere_respuesta": true
}

REQUIERE_RESPUESTA (importante — evita falsos "esperando respuesta"): pon **false**
SOLO si el ÚLTIMO mensaje de la conversación es del LEAD y es un CIERRE conversacional
que no espera respuesta activa (se despide, da las gracias, dice "vale"/"perfecto"/
"genial gracias", confirma algo sin dejar pregunta abierta, emoji de aprobación). Eso
NO es ghosting nuestro ni una pregunta sin contestar — es una conversación que se cerró
bien. En cualquier otro caso (el lead preguntó o pidió algo, dejó un tema abierto, o el
último mensaje es del agente) pon **true**. Ante la duda, true.

CATEGORÍA (importantísimo — separa captación de postventa):
- "cliente": la conversación evidencia que YA es alumno/cliente de CSA — habla de "mi curso",
  su acceso a la plataforma, sus clases/módulos, su estancia, su renovación, soporte de casos
  como alumno, o dice explícitamente que se inscribió/es alumna. Si es cliente, el resumen debe
  decirlo en la PRIMERA frase y la temperatura pasa a medir su intención de RENOVAR o comprar
  algo más (no de inscribirse).
- "lead": todavía no es alumno (aunque esté a punto de comprar).

POSTVENTA (SOLO si categoria = "cliente"): incluye ADEMÁS en "etiquetas" EXACTAMENTE UNA de estas
cuatro, que resuma su estado postventa AHORA (clasifícalo tú según la conversación):
- "consulta": tiene una duda o pregunta y espera respuesta (soporte, logística, fechas de su curso).
- "incidencia": algo va mal o se queja (pago, acceso, problema, malestar) → atención prioritaria.
- "renovación": toca o conviene renovar / ampliar / vender el siguiente nivel.
- "al día": todo en orden, sin nada pendiente ahora mismo.

Criterios de temperatura (intención de INSCRIBIRSE en la formación; en clientes, de RENOVAR/ampliar):
- caliente: pidió plaza, pidió precio concreto del programa, preguntó fechas de inicio, o mostró intención clara de apuntarse.
- templado: interesado pero con dudas o sin cerrar; conversación abierta.
- frio: sin respuesta reciente, rechazo explícito, o consulta ya resuelta sin continuidad comercial.

Etiquetas útiles (ejemplos): "quiere inscribirse", "pide precio programa", "pide info programa", "duda financiación", "pregunta fechas", "no contesta", "cliente", "soporte alumno", "renovación", "pregunta general". Si categoria es "cliente", incluye SIEMPRE la etiqueta "cliente". No inventes datos ni precios. Sé conciso.

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

  const estrategia = await getEstrategiaCSA();
  const ficha360 = await getLeadContext360(meta.phone);
  let ai: Ai | null = null;
  for (let attempt = 0; attempt < 2 && !ai; attempt++) {
    try {
      ai = await runJson<Ai>(buildPrompt(name, transcript, iv, estrategia, ficha360), bulkModel);
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
  // La categoría vive en `etiquetas` (chat_intel no cambia de esquema): si la IA
  // dictaminó "cliente", la etiqueta "cliente" va SIEMPRE presente (y única).
  const etiquetas = Array.isArray(ai.etiquetas) ? [...ai.etiquetas] : [];
  if ((ai.categoria ?? "").toLowerCase() === "cliente" && !etiquetas.some((e) => String(e).toLowerCase() === "cliente")) {
    etiquetas.unshift("cliente");
  }

  // FUSIÓN ADITIVA: nunca se sobreescribe un resumen/temperatura/interés/
  // etiqueta ya guardado con un valor vacío de este análisis — solo se suma.
  const existing = await fetchExistingChatIntel(jid);
  const merged = mergeAiFields(existing, {
    producto: ai.producto_mencionado ?? null,
    temperatura: ai.temperatura ?? null,
    temperatura_motivo: ai.temperatura_motivo ?? null,
    resumen: ai.resumen ?? null,
    intereses: ai.intereses ?? null,
    etiquetas: etiquetas.length ? etiquetas : null,
  });

  // requiere_respuesta vive DENTRO de intervalos (no es columna propia de
  // chat_intel) y se sobreescribe siempre con el juicio más reciente de la IA
  // sobre el ÚLTIMO mensaje — igual que el resto de intervalos, sin pasar por
  // la fusión aditiva (sería el juicio equivocado si se "pegara" al anterior).
  const intervalosConJuicio = {
    ...iv,
    requiere_respuesta: typeof ai.requiere_respuesta === "boolean" ? ai.requiere_respuesta : true,
  };

  const record = {
    jid,
    phone: meta.phone ?? null,
    display_name: (leadName || meta.display_name) ?? null,
    source_row: sourceRow,
    first_ts,
    last_ts,
    msg_count: msgs.length,
    from_me_count,
    intervalos: intervalosConJuicio,
    model: bulkModel,
    generation: 1,
    updated_at: new Date().toISOString(),
    ...merged,
  };

  const sb = getSupabase();
  const { error } = await sb.from("chat_intel").upsert(record, { onConflict: "jid" });
  if (error) return { ok: false, reason: error.message, status: 502 };
  return { ok: true, record };
}
