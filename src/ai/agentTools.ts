/**
 * IDEA 2b — Fransua AGÉNTICO: en vez de recibir todo el contexto pre-inyectado,
 * DECIDE sobre la marcha qué consultar mediante HERRAMIENTAS y responde en bucle
 * multi-turno. Las tools de LECTURA reutilizan los endpoints ya montados
 * (contexto-360 del lead, retrato del negocio, búsqueda de leads).
 *
 * FRANSUA EJECUTOR: además de leer, ahora PUEDE CREAR cosas para Fran —
 * eventos de agenda, recordatorios y avisos/notificaciones. Todo aterriza en
 * `calendar_events` (la agenda que se ve en el dashboard Y se espeja a Google
 * Calendar → notificación en el iPhone de Fran). Cada creación se AUDITA con el
 * actor real (idea 4). Si a Fransua le falta un dato obligatorio (título, fecha…)
 * NO inventa: el prompt le obliga a preguntar antes de llamar a la herramienta.
 *
 * maxTurns acotado para topar coste/latencia. Registra consumo igual que runText.
 */
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { ensureClaudeAuth } from "../brain/secrets";
import { logUsage } from "../brain/usage";
import { suggestModel } from "./agent";
import { getLeadContext360 } from "../brain/leadContext";
import { getBusinessSnapshot } from "../brain/businessSnapshot";
import { getSupabase, brainConfigured } from "../brain/supabase";
import { createAgendaEvent } from "../brain/agenda";
import { logActionAudit } from "../brain/audit";
import { storeLeccion } from "../brain/lecciones";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const txt = (text: string) => ({ content: [{ type: "text" as const, text }] });
const canonPhone = (p?: string) => (p ? String(p).replace(/\D/g, "").slice(-9) : "");

/** Fecha legible en zona Europe/Madrid para las confirmaciones. */
function fmtMadrid(d: Date): string {
  try {
    return d.toLocaleString("es-ES", {
      timeZone: "Europe/Madrid",
      weekday: "short",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return d.toISOString();
  }
}

type LeadRef = { source_row: number | null; jid: string | null; phone: string | null; display_name: string | null };

/** Resuelve la referencia del lead (fila/jid/nombre) por sourceRow o teléfono. */
async function resolveLeadRef(
  sb: ReturnType<typeof getSupabase>,
  opts: { sourceRow?: number | null; telefono?: string | null }
): Promise<LeadRef> {
  const cols = "jid,phone,display_name,source_row";
  const sr = Number.isFinite(Number(opts.sourceRow)) ? Number(opts.sourceRow) : null;
  const phone = canonPhone(opts.telefono ?? undefined);
  const norm = (r: any): LeadRef => ({
    source_row: r.source_row ?? sr,
    jid: r.jid ?? null,
    phone: r.phone ?? (phone || null),
    display_name: r.display_name ?? null,
  });
  if (sr != null) {
    const { data } = await sb.from("chat_intel").select(cols).eq("source_row", sr).order("last_ts", { ascending: false }).limit(1);
    if (data && data.length) return norm(data[0]);
  }
  if (phone.length >= 9) {
    const { data } = await sb.from("chat_intel").select(cols).eq("phone", phone).order("last_ts", { ascending: false }).limit(1);
    if (data && data.length) return norm(data[0]);
  }
  return { source_row: sr, jid: null, phone: phone || null, display_name: null };
}

/* -------------------------------------------------------------------------- */
/* Herramientas de LECTURA (estáticas)                                        */
/* -------------------------------------------------------------------------- */

const fichaLead = tool(
  "ficha_lead",
  "Ficha 360 de UN lead por su teléfono: estado en el CRM, producto, fechas, propuesta/venta y si es alumno. Úsala cuando la pregunta trate de una persona concreta.",
  { telefono: z.string().describe("teléfono del lead (9 dígitos, o con prefijo)") },
  async (args: { telefono: string }) => {
    const texto = await getLeadContext360(args.telefono);
    return txt(texto ?? "No hay ficha en el CRM para ese teléfono.");
  }
);

const fotoNegocio = tool(
  "foto_negocio",
  "Retrato del negocio HOY: embudo, cola activa por nivel, base a reactivar, renovaciones, ingresos del mes y alumnos. Úsala para preguntas sobre el estado global de la cartera.",
  {},
  async () => {
    const texto = await getBusinessSnapshot();
    return txt(texto ?? "No disponible ahora mismo.");
  }
);

const buscarLeads = tool(
  "buscar_leads",
  "Busca leads en la inteligencia de conversaciones por un TEXTO (tema, interés, producto, campaña…). Devuelve, por cada coincidencia, su NOMBRE, su sourceRow (nº de fila en el CRM) y su teléfono. Úsalo para armar un conjunto de leads — p.ej. para luego abrir una vista filtrada en el CRM: necesitas sus sourceRow.",
  { texto: z.string().describe("qué buscar, p.ej. 'Black Friday', 'financiación', 'certificación'") },
  async (args: { texto: string }) => {
    if (!brainConfigured()) return txt("Inteligencia no disponible.");
    const q = (args.texto ?? "").toLowerCase().trim();
    const sb = getSupabase();
    const { data, error } = await sb
      .from("chat_intel")
      .select("source_row,phone,display_name,resumen,etiquetas,producto,temperatura")
      .order("last_ts", { ascending: false })
      .limit(2000);
    if (error) return txt("Error consultando la inteligencia.");
    const rows = (data ?? []).filter((r: any) => {
      const ets = Array.isArray(r.etiquetas) ? r.etiquetas.join(" ") : "";
      return `${r.display_name ?? ""} ${r.resumen ?? ""} ${r.producto ?? ""} ${ets}`.toLowerCase().includes(q);
    });
    const lineas = rows.slice(0, 60).map((r: any) => {
      const cliente = Array.isArray(r.etiquetas) && r.etiquetas.some((e: any) => String(e).toLowerCase() === "cliente") ? " · CLIENTE" : "";
      const fila = r.source_row != null ? ` (fila ${r.source_row})` : " (sin fila CRM)";
      return `- ${r.display_name ?? "?"}${fila} · ${r.temperatura ?? "?"}${r.producto ? ` · ${r.producto}` : ""}${cliente}`;
    });
    const out = rows.length
      ? `${rows.length} leads coinciden con "${args.texto}" (máx 60 listados; usa el nº de fila como sourceRow):\n${lineas.join("\n")}`
      : `Ningún lead coincide con "${args.texto}".`;
    return txt(out);
  }
);

/* -------------------------------------------------------------------------- */
/* Herramientas de ESCRITURA (por petición: cierran sobre el ACTOR real)      */
/* -------------------------------------------------------------------------- */

/**
 * Construye las tools de escritura ligadas al `actor` (email de sesión) para
 * poder AUDITAR quién crea cada cosa. Se reconstruyen en cada llamada a runAgent.
 */
function buildWriteTools(actor: string) {
  const audit = (action_type: string, params: Record<string, unknown>, result: string, ref: LeadRef) =>
    void logActionAudit({
      actor,
      action_type,
      params,
      result,
      sourceRow: ref.source_row,
      jid: ref.jid,
      phone: ref.phone,
      name: ref.display_name,
    });

  const crearEvento = tool(
    "crear_evento_agenda",
    "Crea un EVENTO en la agenda de Fran (cita, llamada, formación, reunión…) con fecha y hora concretas. Aparece en la agenda del dashboard y en el Google Calendar 'CSA · Fransua' (le llega la notificación al iPhone). REQUIERE título y fecha/hora de inicio: si Fran no los ha dado, NO llames a esta herramienta — pregúntale primero.",
    {
      titulo: z.string().describe("título del evento, p.ej. 'Llamada con Gemma López'"),
      cuando: z.string().describe("fecha y hora de INICIO en ISO 8601 con zona horaria, p.ej. '2026-07-25T10:00:00+02:00'. Resuélvela tú a partir del 'HOY' que te doy en el prompt (zona Europe/Madrid)."),
      duracion_min: z.number().optional().describe("duración en minutos (por defecto 30)"),
      tipo: z.enum(["cita", "llamada", "formacion", "otro"]).optional().describe("tipo de evento (por defecto 'cita')"),
      lead_fila: z.number().optional().describe("nº de fila del lead en el CRM (sourceRow) si el evento es sobre un lead concreto; usa el que te dé buscar_leads"),
      telefono: z.string().optional().describe("teléfono del lead (alternativa a lead_fila)"),
      descripcion: z.string().optional().describe("notas/detalle del evento"),
    },
    async (args: { titulo: string; cuando: string; duracion_min?: number; tipo?: "cita" | "llamada" | "formacion" | "otro"; lead_fila?: number; telefono?: string; descripcion?: string }) => {
      const sb = getSupabase();
      const ref = await resolveLeadRef(sb, { sourceRow: args.lead_fila, telefono: args.telefono });
      const start = new Date(args.cuando);
      if (Number.isNaN(start.getTime())) return txt("No entendí la fecha/hora. Pídele a Fran el día y la hora exactos (o dámelo como '2026-07-25 10:00').");
      const dur = Number.isFinite(args.duracion_min) && Number(args.duracion_min) > 0 ? Number(args.duracion_min) : 30;
      const r = await createAgendaEvent({
        titulo: args.titulo,
        start_at: start.toISOString(),
        end_at: new Date(start.getTime() + dur * 60_000).toISOString(),
        tipo: args.tipo ?? "cita",
        descripcion: args.descripcion ?? null,
        source_row: ref.source_row,
        jid: ref.jid,
        origen: "fransua",
      });
      if (!r.ok) {
        audit("crear_evento", { titulo: args.titulo, cuando: start.toISOString() }, "error: " + r.error, ref);
        return txt("No se pudo crear el evento: " + r.error);
      }
      audit("crear_evento", { titulo: args.titulo, cuando: start.toISOString(), tipo: args.tipo ?? "cita", duracion_min: dur }, "ok", ref);
      return txt(
        `HECHO. Evento creado: «${args.titulo}» — ${fmtMadrid(start)}${ref.display_name ? ` · lead: ${ref.display_name}` : ""}` +
          `${r.syncedToGoogle ? " · sincronizado con Google Calendar (te llegará al iPhone)" : ""}.`
      );
    }
  );

  const crearRecordatorio = tool(
    "crear_recordatorio",
    "Crea un RECORDATORIO de seguimiento (p.ej. 'volver a llamar a X'). Se agenda como seguimiento — visible en la agenda del dashboard y en Google/iPhone. REQUIERE título y cuándo: si Fran no los ha dado, pregúntale antes.",
    {
      titulo: z.string().describe("qué hay que recordar, p.ej. 'Llamar a Gemma para cerrar la matrícula'"),
      cuando: z.string().describe("fecha (y hora si la hay) en ISO 8601, resuelta a partir del HOY del prompt. Si Fran solo dijo un día sin hora, usa las 09:00."),
      lead_fila: z.number().optional().describe("nº de fila del lead (sourceRow), si aplica"),
      telefono: z.string().optional().describe("teléfono del lead (alternativa)"),
      detalle: z.string().optional().describe("detalle adicional"),
    },
    async (args: { titulo: string; cuando: string; lead_fila?: number; telefono?: string; detalle?: string }) => {
      const sb = getSupabase();
      const ref = await resolveLeadRef(sb, { sourceRow: args.lead_fila, telefono: args.telefono });
      const due = new Date(args.cuando);
      if (Number.isNaN(due.getTime())) return txt("No entendí la fecha. Pídele a Fran para cuándo es el recordatorio.");
      // 1) Recordatorio (tabla reminders — paridad con el flujo de notas).
      await sb.from("reminders").insert({
        source_row: ref.source_row,
        jid: ref.jid,
        titulo: args.titulo,
        detalle: args.detalle ?? null,
        due_at: due.toISOString(),
        origen: "fransua",
      });
      // 2) Agendar de verdad (visible + Google/iPhone).
      const r = await createAgendaEvent({
        titulo: `Seguimiento: ${args.titulo}`,
        start_at: due.toISOString(),
        all_day: false,
        tipo: "seguimiento",
        descripcion: args.detalle ?? null,
        source_row: ref.source_row,
        jid: ref.jid,
        origen: "fransua",
      });
      audit("crear_recordatorio", { titulo: args.titulo, cuando: due.toISOString() }, r.ok ? "ok" : "error: " + r.error, ref);
      return txt(
        `HECHO. Recordatorio: «${args.titulo}» — ${fmtMadrid(due)}${ref.display_name ? ` · lead: ${ref.display_name}` : ""}` +
          `${r.ok && r.syncedToGoogle ? " · en tu Google Calendar" : ""}.`
      );
    }
  );

  const crearAviso = tool(
    "crear_aviso",
    "Crea un AVISO / NOTIFICACIÓN para Fran (algo que no debe olvidar, una alerta puntual). Aparece en la agenda del dashboard y en su Google Calendar/iPhone. Si Fran no dice cuándo, se pone para HOY. Basta con un título.",
    {
      titulo: z.string().describe("el aviso, p.ej. 'Revisar la propuesta de la Dra. Ruiz'"),
      cuando: z.string().optional().describe("fecha/hora ISO opcional (a partir del HOY del prompt); si no la das, es un aviso para HOY"),
      detalle: z.string().optional().describe("detalle del aviso"),
      lead_fila: z.number().optional().describe("nº de fila del lead (sourceRow), si aplica"),
      telefono: z.string().optional().describe("teléfono del lead (alternativa)"),
    },
    async (args: { titulo: string; cuando?: string; detalle?: string; lead_fila?: number; telefono?: string }) => {
      const sb = getSupabase();
      const ref = await resolveLeadRef(sb, { sourceRow: args.lead_fila, telefono: args.telefono });
      let start = new Date();
      let allDay = true;
      if (args.cuando) {
        const d = new Date(args.cuando);
        if (!Number.isNaN(d.getTime())) {
          start = d;
          allDay = false;
        }
      }
      const r = await createAgendaEvent({
        titulo: args.titulo,
        start_at: start.toISOString(),
        all_day: allDay,
        tipo: "otro",
        descripcion: args.detalle ?? null,
        source_row: ref.source_row,
        jid: ref.jid,
        origen: "fransua",
      });
      if (!r.ok) {
        audit("crear_aviso", { titulo: args.titulo }, "error: " + r.error, ref);
        return txt("No se pudo crear el aviso: " + r.error);
      }
      audit("crear_aviso", { titulo: args.titulo, cuando: start.toISOString(), all_day: allDay }, "ok", ref);
      return txt(
        `HECHO. Aviso creado: «${args.titulo}»${allDay ? " (para hoy)" : ` — ${fmtMadrid(start)}`}` +
          `${ref.display_name ? ` · lead: ${ref.display_name}` : ""}${r.syncedToGoogle ? " · en tu Google Calendar" : ""}.`
      );
    }
  );

  const aprender = tool(
    "aprender",
    "Guarda una LECCIÓN duradera para no repetir un fallo o servir mejor a Fran. Úsala cuando: Fran te CORRIGE o te dice que te equivocaste; Fran te ENSEÑA un dato/regla del negocio o una preferencia suya; o reconoces un fallo propio. NO la uses para charla normal ni datos efímeros de un lead. Escribe la lección como una REGLA para el futuro (p.ej. 'Verifica con las herramientas antes de afirmar que un lead está en una lista').",
    {
      leccion: z.string().describe("la lección, concisa y en imperativo (regla para el futuro)"),
      contexto: z.string().optional().describe("de qué venía (opcional, 1 frase)"),
    },
    async (args: { leccion: string; contexto?: string }) => {
      const r = await storeLeccion({ leccion: args.leccion, contexto: args.contexto ?? null, actor, origen: "tool" });
      if (!r.ok) return txt("No pude guardar la lección: " + (r.error ?? "error"));
      void logActionAudit({ actor, action_type: "aprender", params: { leccion: args.leccion }, result: "ok" });
      return txt(`Aprendido. Lo tendré en cuenta a partir de ahora: «${args.leccion}».`);
    }
  );

  return [crearEvento, crearRecordatorio, crearAviso, aprender];
}

const READ_TOOL_NAMES = ["mcp__fransua__ficha_lead", "mcp__fransua__foto_negocio", "mcp__fransua__buscar_leads"];
const WRITE_TOOL_NAMES = [
  "mcp__fransua__crear_evento_agenda",
  "mcp__fransua__crear_recordatorio",
  "mcp__fransua__crear_aviso",
  "mcp__fransua__aprender",
];

export interface AgentRun {
  text: string;
  toolsUsed: string[];
}

/**
 * Ejecuta a Fransua en modo AGENTE (con herramientas, multi-turno acotado).
 * `actor` = email de sesión (x-csa-user) para auditar las acciones de escritura.
 */
export async function runAgent(prompt: string, model?: string, actor?: string): Promise<AgentRun> {
  await ensureClaudeAuth();
  const who = (actor && String(actor).trim()) || "Fran";
  const writeTools = buildWriteTools(who);
  const fransuaMcpServer = createSdkMcpServer({
    name: "fransua",
    version: "1.0.0",
    tools: [fichaLead, fotoNegocio, buscarLeads, ...writeTools],
  });

  const q = query({
    prompt,
    options: {
      mcpServers: { fransua: fransuaMcpServer },
      allowedTools: [...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES],
      maxTurns: 8,
      settingSources: [],
      ...(model ? { model } : {}),
    },
  });

  let resultText = "";
  let assistantText = "";
  const toolsUsed: string[] = [];
  for await (const msg of q as AsyncIterable<any>) {
    if (msg.type === "assistant") {
      for (const block of msg.message?.content ?? []) {
        if (block.type === "text") assistantText += block.text;
        else if (block.type === "tool_use") toolsUsed.push(String(block.name).replace(/^mcp__fransua__/, ""));
      }
    } else if (msg.type === "result") {
      resultText = msg.result ?? "";
      const u = msg.usage;
      if (u) {
        void logUsage({
          at: new Date().toISOString(),
          model: model ?? null,
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          costUsd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : 0,
        });
      }
    }
  }
  return { text: (resultText || assistantText).trim(), toolsUsed };
}

export const agentModel = suggestModel;
