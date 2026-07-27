/**
 * APRENDER LA ESTRUCTURA DE FRAN  +  PROPONER EVENTOS EN SU ESTILO.
 *
 * Cuando nutrimos la agenda con el calendario real de Fran (importado del iPhone),
 * esta pieza cierra el bucle que pidió el usuario: "respetando cómo Fran organiza
 * su información, Fransua aprende para proponer nuevos eventos".
 *
 *  1) APRENDE (learnAgendaPlaybook): lee los eventos de Fran (calendar_events,
 *     origen 'humano'), arma un DIGEST compacto (vocabulario y muestras por tipo,
 *     cadencias entre eventos del mismo lead, día/hora habitual) y pide al LLM que
 *     sintetice el PLAYBOOK de Fran — cómo NOMBRA y ENCADENA su trabajo. Se guarda
 *     en fransua_log kind='agenda_playbook' (+ caché) para inyectarlo luego.
 *
 *  2) PROPONE (proposeAgendaEvents): combina ese playbook con el estado VIVO de la
 *     cartera (leads que esperan respuesta / calientes enfriándose / templados a
 *     reactivar, de chat_intel) y con lo YA agendado, y pide al LLM propuestas de
 *     eventos NUEVOS EN EL ESTILO DE FRAN (su vocabulario, su tipo, su cadencia).
 *     Esas propuestas sustituyen la fila "Fransua sugiere" del panel derecho.
 *
 * Nota: las funciones de enriquecido de leads son un CALCO compacto de las de
 * http/routes/intel.ts (mismas columnas y criterios); se copian aquí a propósito
 * para no acoplar este módulo a la ruta (fichero compartido por varias sesiones).
 */
import { getSupabase, brainConfigured } from "./supabase";
import { runJson, suggestModel } from "../ai/agent";

const learnModel = process.env.WA_AI_MODEL_ASK ?? suggestModel;

export interface AgendaProposal {
  titulo: string;
  tipo: string;
  start_at: string; // ISO
  all_day: boolean;
  duracion_min: number | null;
  lead: string | null;
  source_row: number | null;
  jid: string | null;
  motivo: string;
  kind: "responder" | "caliente" | "reactivar" | "cadencia" | "tarea";
  confianza: "alta" | "media" | "baja";
}

// ── util fechas (Madrid) ──────────────────────────────────────────────────────
function madridOffset(d: Date): string {
  const s = d.toLocaleString("en-US", { timeZone: "Europe/Madrid", timeZoneName: "longOffset" });
  const m = s.match(/GMT([+-]\d{2}:?\d{2})/);
  return m ? m[1].replace(/(\d{2})(\d{2})$/, "$1:$2") : "+02:00";
}

// ── APRENDER EL PLAYBOOK ────────────────────────────────────────────────────────
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

interface LearnRow { titulo: string; tipo: string | null; start_at: string; all_day: boolean; }

/** Digest compacto y barato de los eventos de Fran para alimentar al LLM. */
function buildDigest(rows: LearnRow[]) {
  const porTipo = new Map<string, { n: number; muestras: string[] }>();
  const dow = [0, 0, 0, 0, 0, 0, 0]; // domingo..sábado
  const horas = new Map<number, number>();
  for (const r of rows) {
    const tipo = (r.tipo || "otro").trim();
    const bucket = porTipo.get(tipo) ?? { n: 0, muestras: [] };
    bucket.n++;
    if (bucket.muestras.length < 8 && r.titulo && !bucket.muestras.includes(r.titulo)) bucket.muestras.push(r.titulo.slice(0, 80));
    porTipo.set(tipo, bucket);
    const d = new Date(r.start_at);
    if (!Number.isNaN(d.getTime())) {
      const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Madrid", weekday: "short", hour: "2-digit", hour12: false }).formatToParts(d);
      const wd = parts.find((p) => p.type === "weekday")?.value ?? "";
      const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      if (wd in map) dow[map[wd]]++;
      if (!r.all_day) {
        const h = Number(parts.find((p) => p.type === "hour")?.value ?? NaN);
        if (Number.isFinite(h)) horas.set(h, (horas.get(h) ?? 0) + 1);
      }
    }
  }
  const tipos = [...porTipo.entries()].map(([tipo, v]) => ({ tipo, n: v.n, muestras: v.muestras })).sort((a, b) => b.n - a.n);
  const horasTop = [...horas.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([h]) => `${String(h).padStart(2, "0")}:00`);
  const dias = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"].map((d, i) => `${d}:${dow[i]}`);
  return { total: rows.length, tipos, horasTop, dias };
}

let playbookCache: { texto: string; at: number; storedAt: string | null; total: number } | null = null;
const PLAYBOOK_TTL_MS = 5 * 60_000;

export interface LearnResult { ok: boolean; error?: string; playbook?: string; total?: number; tipos?: number; }

/** Aprende (o re-aprende) el playbook de Fran a partir de su agenda importada. */
export async function learnAgendaPlaybook(): Promise<LearnResult> {
  if (!brainConfigured()) return { ok: false, error: "brain-not-configured" };
  const sb = getSupabase();
  const { data, error } = await sb
    .from("calendar_events")
    .select("titulo,tipo,start_at,all_day")
    .eq("origen", "humano")
    .neq("status", "cancelled")
    .order("start_at", { ascending: false })
    .limit(1800);
  if (error) return { ok: false, error: error.message };
  const rows = (data ?? []) as LearnRow[];
  if (rows.length < 5) return { ok: false, error: "pocos-eventos", total: rows.length };

  const digest = buildDigest(rows);
  const bloques = digest.tipos
    .map((t) => `• ${t.tipo} (${t.n}): ${t.muestras.slice(0, 6).map((m) => `"${m}"`).join(", ")}`)
    .join("\n");

  const prompt = [
    "Eres el analista de Fransua, el cerebro comercial de Common Sense Aligners (CSA), que VENDE FORMACIÓN a",
    "dentistas (programa SBA). Vas a APRENDER cómo organiza su trabajo Fran (el comercial) mirando su AGENDA REAL",
    "(la que traía del iPhone). El objetivo es que luego Fransua proponga eventos NUEVOS respetando SU estilo.",
    "",
    `Fran tiene ${digest.total} eventos. Reparto por tipo, con títulos de muestra REALES:`,
    bloques,
    "",
    `Días de la semana con más eventos (recuento): ${digest.dias.join("  ")}`,
    `Horas de inicio más habituales: ${digest.horasTop.join(", ") || "s/d"}`,
    "",
    "Analiza y sintetiza el PLAYBOOK de Fran. Fíjate en:",
    "- VOCABULARIO: cómo titula (verbos y fórmulas que repite, p.ej. 'Cerrar SBA X', 'Estancia clínica X', 'Avisar a X', 'Seguimiento X'). Respeta su forma de nombrar.",
    "- CADENCIAS/SECUENCIAS: qué encadena y a qué ritmo (p.ej. tras una llamada de ventas → cierre a los N días; tras una compra → onboarding y luego seguimientos; recordatorios/avisos con semanas de antelación).",
    "- RITMO: días y horas donde suele poner cada cosa.",
    "- QUÉ TIPO usa para cada intención (reunión/llamada/onboarding/estancia/seguimiento/recordatorio/tarea…).",
    "",
    "Devuelve SOLO un objeto JSON:",
    '{"vocabulario":["fórmula de título tal cual la usa Fran", …],',
    ' "cadencias":["regla de secuencia/ritmo en 1 frase", …],',
    ' "ritmo":"1-2 frases sobre días/horas habituales",',
    ' "playbook":"resumen operativo en 4-8 frases que Fransua usará para proponer eventos como los haría Fran"}',
    "Sé concreto y fiel a los datos; NO inventes tipos ni fórmulas que no aparezcan. Español de España.",
  ].join("\n");

  const out = await runJson<{ vocabulario?: string[]; cadencias?: string[]; ritmo?: string; playbook?: string }>(prompt, learnModel);
  if (!out) return { ok: false, error: "IA no disponible" };

  const partes: string[] = [];
  if (out.playbook) partes.push(String(out.playbook).trim());
  if (Array.isArray(out.vocabulario) && out.vocabulario.length)
    partes.push("VOCABULARIO DE FRAN (usa SUS fórmulas al titular):\n" + out.vocabulario.slice(0, 12).map((v) => `- ${String(v).trim()}`).join("\n"));
  if (Array.isArray(out.cadencias) && out.cadencias.length)
    partes.push("CADENCIAS DE FRAN (respeta sus secuencias y tiempos):\n" + out.cadencias.slice(0, 12).map((v) => `- ${String(v).trim()}`).join("\n"));
  if (out.ritmo) partes.push("RITMO: " + String(out.ritmo).trim());
  const texto = partes.filter(Boolean).join("\n\n").slice(0, 3000);
  if (!texto) return { ok: false, error: "playbook vacío" };

  const storedAt = new Date().toISOString();
  try {
    await sb.from("fransua_log").insert({
      kind: "agenda_playbook",
      payload: { at: storedAt, playbook: texto, total: rows.length, tipos: digest.tipos.length, muestras: digest.tipos.slice(0, 12) },
    });
  } catch { /* best-effort: la caché ya sirve el playbook aunque no persista */ }
  playbookCache = { texto, at: Date.now(), storedAt, total: rows.length };
  return { ok: true, playbook: texto, total: rows.length, tipos: digest.tipos.length };
}

/** Playbook más reciente (cacheado ~5 min). "" si nunca se ha aprendido. */
export async function getAgendaPlaybook(): Promise<{ texto: string; at: string | null; total: number }> {
  if (playbookCache && Date.now() - playbookCache.at < PLAYBOOK_TTL_MS)
    return { texto: playbookCache.texto, at: playbookCache.storedAt, total: playbookCache.total };
  if (!brainConfigured()) return { texto: "", at: null, total: 0 };
  try {
    const sb = getSupabase();
    const { data } = await sb
      .from("fransua_log")
      .select("payload,created_at")
      .eq("kind", "agenda_playbook")
      .order("created_at", { ascending: false })
      .limit(1);
    const p = (data?.[0]?.payload ?? null) as { playbook?: string; at?: string; total?: number } | null;
    const texto = String(p?.playbook ?? "").trim();
    const at = p?.at ?? (data?.[0]?.created_at as string | undefined) ?? null;
    const total = Number(p?.total ?? 0);
    playbookCache = { texto, at: Date.now(), storedAt: at, total };
    return { texto, at, total };
  } catch {
    return { texto: "", at: null, total: 0 };
  }
}

// ── LEADS CANDIDATOS (calco compacto de intel.ts) ───────────────────────────────
const INTEL_COLS =
  "jid,phone,display_name,source_row,producto,first_ts,last_ts,msg_count,from_me_count,temperatura,resumen,intervalos,etiquetas";
const STRATEGY_SINCE = "2025-04-01";
const daysSince = (ts: number | null) => (ts ? Math.floor(Date.now() / 1000 - ts) / 86400 : Infinity);

interface Cand {
  jid: string; source_row: number | null; display_name: string | null; producto: string | null;
  temperatura: string | null; resumen: string | null; silencio_dias: number;
  kind: AgendaProposal["kind"];
}

function esCliente(etiquetas: unknown): boolean {
  const ets = Array.isArray(etiquetas) ? (etiquetas as unknown[]) : [];
  return ets.some((e) => {
    const s = String(e).toLowerCase();
    return s === "cliente" || s === "ya inscrito" || s === "alumno" || s === "alumna";
  });
}

/** Los leads que HOY piden acción, con su fila/jid para poder agendar sobre ellos. */
async function candidateLeads(sb: ReturnType<typeof getSupabase>, max = 16): Promise<Cand[]> {
  const sinceTs = Math.floor(new Date(STRATEGY_SINCE + "T00:00:00Z").getTime() / 1000);
  const { data } = await sb
    .from("chat_intel")
    .select(INTEL_COLS)
    .gte("last_ts", sinceTs)
    .order("last_ts", { ascending: false })
    .limit(2000);
  const rows = (data ?? []) as any[];
  const enriched = rows.map((r) => {
    const silencio = Math.round(daysSince(r.last_ts));
    const ultimo = r.intervalos?.ultimo_emisor ?? null;
    const cerrada = r.intervalos?.conversacion_cerrada === true;
    return {
      jid: r.jid, source_row: r.source_row ?? null, display_name: r.display_name ?? null, producto: r.producto ?? null,
      temperatura: r.temperatura ?? null, resumen: r.resumen ?? null, silencio_dias: silencio,
      esperando: ultimo === "lead" && !cerrada, es_cliente: esCliente(r.etiquetas),
    };
  });
  const venta = enriched.filter((r) => !r.es_cliente);
  const tempRank = (t: string | null) => (t === "caliente" ? 3 : t === "templado" ? 2 : t === "frio" ? 1 : 0);
  const responder = venta.filter((r) => r.esperando && r.silencio_dias >= 0)
    .sort((a, b) => tempRank(b.temperatura) - tempRank(a.temperatura) || a.silencio_dias - b.silencio_dias)
    .slice(0, 8).map((r) => ({ ...r, kind: "responder" as const }));
  const caliente = venta.filter((r) => r.temperatura === "caliente" && r.silencio_dias >= 2)
    .sort((a, b) => a.silencio_dias - b.silencio_dias).slice(0, 6).map((r) => ({ ...r, kind: "caliente" as const }));
  const reactivar = venta.filter((r) => r.temperatura === "templado" && r.silencio_dias >= 7 && r.silencio_dias <= 45)
    .sort((a, b) => a.silencio_dias - b.silencio_dias).slice(0, 6).map((r) => ({ ...r, kind: "reactivar" as const }));
  const seen = new Set<string>();
  const merged: Cand[] = [];
  for (const r of [...responder, ...caliente, ...reactivar]) {
    if (seen.has(r.jid)) continue;
    seen.add(r.jid);
    merged.push({ jid: r.jid, source_row: r.source_row, display_name: r.display_name, producto: r.producto, temperatura: r.temperatura, resumen: r.resumen, silencio_dias: r.silencio_dias, kind: r.kind });
    if (merged.length >= max) break;
  }
  return merged;
}

// ── PROPONER EVENTOS EN EL ESTILO DE FRAN ───────────────────────────────────────
export interface ProposeResult { proposals: AgendaProposal[]; playbookAt: string | null; learned: boolean; candidatos: number; }

export async function proposeAgendaEvents(limit = 10): Promise<ProposeResult> {
  if (!brainConfigured()) return { proposals: [], playbookAt: null, learned: false, candidatos: 0 };
  const sb = getSupabase();
  const [{ texto: playbook, at: playbookAt }, cands] = await Promise.all([getAgendaPlaybook(), candidateLeads(sb)]);
  if (!cands.length) return { proposals: [], playbookAt, learned: !!playbook, candidatos: 0 };

  // Eventos ya agendados (próximos 30 días) para NO duplicar propuestas.
  const now = new Date();
  const in30 = new Date(now.getTime() + 30 * 86400_000).toISOString();
  const { data: yaData } = await sb
    .from("calendar_events")
    .select("titulo,start_at,source_row")
    .neq("status", "cancelled")
    .gte("start_at", now.toISOString())
    .lte("start_at", in30)
    .limit(500);
  const yaAgendado = (yaData ?? []) as any[];
  const filasAgendadas = new Set(yaAgendado.filter((e) => e.source_row != null).map((e) => Number(e.source_row)));
  const candidatosLibres = cands.filter((c) => c.source_row == null || !filasAgendadas.has(Number(c.source_row)));
  if (!candidatosLibres.length) return { proposals: [], playbookAt, learned: !!playbook, candidatos: cands.length };

  const off = madridOffset(now);
  const hoyISO = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const hoyLegible = now.toLocaleString("es-ES", { timeZone: "Europe/Madrid", weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });

  const kindTxt: Record<Cand["kind"], string> = {
    responder: "te escribió y espera respuesta", caliente: "caliente enfriándose", reactivar: "templado a reactivar",
    cadencia: "", tarea: "",
  };
  const lista = candidatosLibres
    .map((c, i) => `#${i} · ${c.display_name ?? c.jid}${c.producto ? ` [${c.producto}]` : ""} — ${kindTxt[c.kind]}, ${c.silencio_dias === 0 ? "hoy" : `${c.silencio_dias}d sin hablar`}${c.temperatura ? `, ${c.temperatura}` : ""}${c.resumen ? `. ${String(c.resumen).slice(0, 140)}` : ""}`)
    .join("\n");
  const yaTxt = yaAgendado.slice(0, 40).map((e) => `- ${e.titulo} (${String(e.start_at).slice(0, 10)})`).join("\n");

  const prompt = [
    "Eres Fransua, el cerebro comercial de CSA (vende FORMACIÓN a dentistas, programa SBA). Vas a PROPONER a Fran",
    "los próximos eventos de agenda que él mismo pondría, RESPETANDO SU ESTILO (aprendido de su propia agenda).",
    "",
    `HOY es ${hoyLegible} (Madrid). Fecha ISO de hoy: ${hoyISO}. Usa la zona ${off} en las fechas ISO que devuelvas.`,
    "",
    playbook
      ? "=== CÓMO TRABAJA FRAN (su playbook, respétalo: su vocabulario al titular, sus tipos, sus cadencias) ===\n" + playbook
      : "(Aún no hay playbook aprendido: propón con criterio comercial estándar, títulos claros y accionables.)",
    "",
    "=== LEADS QUE HOY PIDEN ACCIÓN (usa el #índice para referirte a cada uno) ===",
    lista,
    "",
    yaTxt ? "=== YA AGENDADO (NO lo repitas) ===\n" + yaTxt : "",
    "",
    "Propón entre 5 y 10 eventos CONCRETOS. Para cada uno:",
    "- ref: el #índice del lead (número) si el evento es sobre un lead de la lista; null si es una tarea/cadencia general.",
    "- titulo: EN EL ESTILO DE FRAN (usa sus fórmulas: p.ej. 'Cerrar SBA — <nombre>', 'Llamada de ventas <nombre>', 'Seguimiento <nombre>', 'Avisar a <nombre>'). Nombre del lead incluido.",
    "- tipo: una de las keys de tipo (llamada, reunion, cita, onboarding, formacion, seguimiento, recordatorio, estancia, tarea). Elige la que Fran usaría.",
    "- cuando: fecha y hora ISO con zona (respeta días/horas habituales de Fran; nada en el pasado; reparte a lo largo de los próximos ~10 días laborables).",
    "- all_day: true solo para recordatorios/avisos sin hora.",
    "- duracion_min: minutos (30 llamada, 60 reunión…) o null si all_day.",
    "- motivo: 1 frase de por qué ahora (para que Fran lo entienda de un vistazo).",
    "- kind: 'responder' | 'caliente' | 'reactivar' | 'cadencia' | 'tarea'.",
    "- confianza: 'alta' | 'media' | 'baja'.",
    "",
    'Devuelve SOLO JSON: {"proposals":[{"ref":0,"titulo":"…","tipo":"llamada","cuando":"' + hoyISO + 'T10:00:00' + off + '","all_day":false,"duracion_min":30,"motivo":"…","kind":"responder","confianza":"alta"}, …]}',
    "No inventes leads que no estén en la lista. No repitas lo ya agendado. Español de España.",
  ].filter(Boolean).join("\n");

  const out = await runJson<{ proposals?: any[] }>(prompt, learnModel);
  const raw = Array.isArray(out?.proposals) ? out!.proposals! : [];
  const proposals: AgendaProposal[] = [];
  for (const p of raw) {
    const titulo = String(p?.titulo ?? "").trim().slice(0, 200);
    const cuando = String(p?.cuando ?? "").trim();
    const dt = new Date(cuando);
    if (!titulo || Number.isNaN(dt.getTime())) continue;
    // No propongas nada en el pasado (más de 1 día atrás por bordes de zona).
    if (dt.getTime() < now.getTime() - 86400_000) continue;
    const refN = Number(p?.ref);
    const cand = Number.isInteger(refN) && refN >= 0 && refN < candidatosLibres.length ? candidatosLibres[refN] : null;
    const allDay = !!p?.all_day;
    const durRaw = Number(p?.duracion_min);
    proposals.push({
      titulo,
      tipo: String(p?.tipo ?? "cita").trim().slice(0, 60) || "cita",
      start_at: dt.toISOString(),
      all_day: allDay,
      duracion_min: allDay || !Number.isFinite(durRaw) ? null : Math.min(Math.max(durRaw, 15), 480),
      lead: cand?.display_name ?? null,
      source_row: cand?.source_row ?? null, // fila REAL del candidato (nunca la del LLM)
      jid: cand?.jid ?? null,
      motivo: String(p?.motivo ?? "").trim().slice(0, 300),
      kind: (["responder", "caliente", "reactivar", "cadencia", "tarea"].includes(p?.kind) ? p.kind : cand?.kind ?? "cadencia") as AgendaProposal["kind"],
      confianza: (["alta", "media", "baja"].includes(p?.confianza) ? p.confianza : "media") as AgendaProposal["confianza"],
    });
    if (proposals.length >= limit) break;
  }
  return { proposals, playbookAt, learned: !!playbook, candidatos: candidatosLibres.length };
}
