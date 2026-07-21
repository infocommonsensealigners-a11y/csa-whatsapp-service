/**
 * Rutas de NOTAS de Fransua — "Comentar con Fransua" desde el dashboard.
 *
 * Filosofía (decidida con el usuario 2026-07-20):
 *  - SUPABASE PRIMERO: las notas, la memoria y lo que Fransua deduce viven en
 *    Supabase (el cerebro que interconecta todo). El Sheet solo recibe
 *    anotaciones básicas cuando el humano lo confirma.
 *  - APLICAR LO SEGURO / PROPONER LO DELICADO: Fransua guarda la nota + su
 *    interpretación y auto-aplica lo derivado en Supabase (temperatura,
 *    intereses, memoria). Lo que cambia el estado del CRM, escribe en el Sheet
 *    o crea recordatorios se DEVUELVE como propuesta para que Fran confirme.
 *
 * Solo usa tablas que YA existen (fransua_log, conversation_memory, chat_intel,
 * reminders) → no requiere migración de esquema.
 *
 *  - POST /intel/note          → interpreta una nota, aplica lo seguro, propone lo delicado
 *  - POST /intel/note/confirm  → aplica una propuesta (de momento: recordatorio en Supabase)
 *
 * ⚠️ La interpretación usa el Agent SDK (agent.ts). En local va con la
 * suscripción de Claude Code; en Railway necesita ANTHROPIC_API_KEY. Si no hay
 * cerebro/IA disponible, la nota SE GUARDA igual (sin interpretación).
 */
import type { FastifyInstance } from "fastify";
import { brainConfigured, getSupabase } from "../../brain/supabase";
import { runJson, runText, suggestModel } from "../../ai/agent";

type NoteBody = {
  phone?: string;
  sourceRow?: number;
  jid?: string;
  name?: string;
  author?: string;
  text?: string;
};

type Interpretation = {
  entendido?: string;
  hechos?: string[];
  temperatura_sugerida?: "caliente" | "templado" | "frio" | null;
  intereses_nuevos?: string[];
  estado_sugerido?: string | null;
  recordatorio?: { titulo?: string; en_dias?: number } | null;
  nota_limpia?: string;
};

const canonPhone = (p?: string) => (p ? String(p).replace(/\D/g, "").slice(-9) : "");

/* -------------------------------------------------------------------------- */
/* Foto de la cartera para /intel/ask — cacheada 60s (latencia)               */
/* -------------------------------------------------------------------------- */

/** Modelo del chat de cartera: WA_AI_MODEL_ASK manda; si no, el de sugerencias. */
const askModel = process.env.WA_AI_MODEL_ASK ?? suggestModel;

type AskCartera = { lines: string; shownCount: number; totalWithSignal: number };
let askCarteraCache: { at: number; value: AskCartera } | null = null;
const ASK_CARTERA_TTL_MS = 60_000;

/**
 * La "foto" de la cartera que se incrusta en el prompt de /intel/ask. Se cachea
 * ASK_CARTERA_TTL_MS en memoria: en una conversación de varios turnos, solo el
 * primer turno paga la lectura de Supabase (~0,5-1s); los siguientes salen al
 * modelo directamente. El intel cambia despacio (lo refresca el análisis de
 * conversaciones), así que 60s de frescura no pierden nada relevante.
 */
async function getAskCartera(): Promise<AskCartera> {
  const nowMs = Date.now();
  if (askCarteraCache && nowMs - askCarteraCache.at < ASK_CARTERA_TTL_MS) return askCarteraCache.value;

  const sb = getSupabase();
  const { data, error } = await sb
    .from("chat_intel")
    .select("display_name,producto,temperatura,resumen,intereses,etiquetas,last_ts,intervalos")
    .order("last_ts", { ascending: false })
    .limit(2000);
  if (error) throw new Error(error.message);

  const now = Math.floor(nowMs / 1000);
  const rank = (t: string | null) => (t === "caliente" ? 3 : t === "templado" ? 2 : t === "frio" ? 1 : 0);
  const rows = (data ?? []) as any[];
  // Prioriza leads con SEÑAL (temperatura o resumen), por temperatura y recencia.
  const withSignal = rows
    .filter((r) => r.temperatura || r.resumen)
    .sort((a, b) => rank(b.temperatura) - rank(a.temperatura) || (b.last_ts ?? 0) - (a.last_ts ?? 0));
  const CAP = 450;
  const shown = withSignal.slice(0, CAP);
  const lines = shown
    .map((r) => {
      const sil = r.last_ts ? Math.round((now - r.last_ts) / 86400) : "?";
      const esperando = r.intervalos?.ultimo_emisor === "lead" ? " · ESPERANDO-RESP" : "";
      const intereses = Array.isArray(r.intereses)
        ? r.intereses.map((x: any) => x?.label ?? x).filter(Boolean).slice(0, 3).join("/")
        : "";
      const resumen = (r.resumen ?? "").replace(/\s+/g, " ").slice(0, 110);
      return `- ${r.display_name ?? "?"} · ${r.temperatura ?? "?"} · ${r.producto ?? "?"} · ${sil}d${esperando}${intereses ? ` · int:${intereses}` : ""}${resumen ? ` · ${resumen}` : ""}`;
    })
    .join("\n");

  const value: AskCartera = { lines, shownCount: shown.length, totalWithSignal: withSignal.length };
  askCarteraCache = { at: nowMs, value };
  return value;
}

/** Localiza la fila de chat_intel del lead (por teléfono → sourceRow → jid). */
async function resolveIntel(sb: ReturnType<typeof getSupabase>, body: NoteBody) {
  const cols =
    "jid,phone,display_name,source_row,producto,temperatura,temperatura_motivo,resumen,intereses";
  const phone = canonPhone(body.phone);
  if (phone.length >= 9) {
    const { data } = await sb.from("chat_intel").select(cols).eq("phone", phone).order("last_ts", { ascending: false }).limit(1);
    if (data && data.length) return data[0] as any;
  }
  if (Number.isFinite(body.sourceRow)) {
    const { data } = await sb.from("chat_intel").select(cols).eq("source_row", body.sourceRow).order("last_ts", { ascending: false }).limit(1);
    if (data && data.length) return data[0] as any;
  }
  if (body.jid) {
    const { data } = await sb.from("chat_intel").select(cols).eq("jid", body.jid).maybeSingle();
    if (data) return data as any;
  }
  return null;
}

function buildPrompt(name: string, intel: any, text: string): string {
  const intereses = Array.isArray(intel?.intereses)
    ? intel.intereses.map((x: any) => x?.label ?? x).filter(Boolean).join(", ")
    : "";
  return [
    "Eres Fransua, el cerebro comercial de Common Sense Aligners (CSA), que VENDE FORMACIÓN",
    "a dentistas (programa SBA, certificación, mentoría, estancia clínica) — NO trata pacientes.",
    "El comercial Fran te deja una nota sobre un lead. Interprétala y decide qué hacer.",
    "",
    `LEAD: ${name || "(sin nombre)"}` +
      (intel?.producto ? ` · producto: ${intel.producto}` : "") +
      (intel?.temperatura ? ` · temperatura actual: ${intel.temperatura}` : "") +
      (intereses ? ` · intereses actuales: ${intereses}` : ""),
    intel?.resumen ? `RESUMEN ACTUAL: ${intel.resumen}` : "",
    "",
    `NOTA DE FRAN: "${text}"`,
    "",
    "Devuelve SOLO un objeto JSON con esta forma exacta:",
    "{",
    '  "entendido": "una frase: qué has entendido de la nota",',
    '  "hechos": ["hechos concretos extraídos de la nota"],',
    '  "temperatura_sugerida": "caliente" | "templado" | "frio" | null,',
    '  "intereses_nuevos": ["productos/temas nuevos que menciona la nota"],',
    '  "estado_sugerido": "nuevo estado del lead si la nota lo implica (Compra, Alumno, Ex-alumno, No cualifica, ...) o null",',
    '  "recordatorio": {"titulo": "...", "en_dias": N} | null,',
    '  "nota_limpia": "la nota reformulada clara y breve para el registro"',
    "}",
    "Reglas: no inventes datos. Deja en null / [] lo que la nota no implique claramente.",
    "temperatura_sugerida solo si la nota cambia claramente el interés del lead.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function registerNoteRoutes(app: FastifyInstance): void {
  app.post("/intel/note", async (req, reply) => {
    if (!brainConfigured()) return reply.status(503).send({ ok: false, error: "brain-not-configured" });
    const body = (req.body ?? {}) as NoteBody;
    const text = String(body.text ?? "").trim();
    if (!text) return reply.status(400).send({ ok: false, error: "text vacío" });

    const sb = getSupabase();
    const intel = await resolveIntel(sb, body);
    const name = body.name || intel?.display_name || "(sin nombre)";
    const sourceRow: number | null = intel?.source_row ?? (Number.isFinite(body.sourceRow) ? Number(body.sourceRow) : null);
    const jid: string | null = intel?.jid ?? body.jid ?? null;
    const phone = canonPhone(body.phone) || intel?.phone || null;

    // 1) Interpretar con Fransua (si la IA está disponible). Nunca bloquea el guardado.
    let interp: Interpretation | null = null;
    let aiError: string | null = null;
    try {
      interp = await runJson<Interpretation>(buildPrompt(name, intel, text), suggestModel);
    } catch (e) {
      aiError = (e as Error).message;
    }

    const applied: string[] = [];
    const proposed: Array<Record<string, unknown>> = [];

    // 2) APLICAR LO SEGURO (solo Supabase).
    if (intel?.jid) {
      const patch: Record<string, unknown> = {};
      if (interp?.temperatura_sugerida && interp.temperatura_sugerida !== intel.temperatura) {
        patch.temperatura = interp.temperatura_sugerida;
        patch.temperatura_motivo = `Nota de ${body.author || "Fran"}: ${(interp.nota_limpia || text).slice(0, 140)}`;
        applied.push(`Temperatura → ${interp.temperatura_sugerida}`);
      }
      const nuevos = (interp?.intereses_nuevos ?? []).map((s) => String(s).trim()).filter(Boolean);
      if (nuevos.length) {
        const prev: any[] = Array.isArray(intel.intereses) ? intel.intereses : [];
        const have = new Set(prev.map((x) => String(x?.label ?? x).toLowerCase()));
        const add = nuevos.filter((n) => !have.has(n.toLowerCase())).map((label) => ({ label, evidence: `nota de ${body.author || "Fran"}` }));
        if (add.length) {
          patch.intereses = [...prev, ...add];
          applied.push(`Intereses +${add.length}: ${add.map((a) => a.label).join(", ")}`);
        }
      }
      if (Object.keys(patch).length) {
        patch.updated_at = new Date().toISOString();
        await sb.from("chat_intel").update(patch).eq("jid", intel.jid);
      }
    }

    // Memoria del lead (recuerdo textual; el embedding se rellenará en una pasada posterior).
    await sb.from("conversation_memory").insert({
      jid,
      source_row: sourceRow,
      content: `[nota de ${body.author || "Fran"}] ${interp?.nota_limpia || text}`,
      model: interp ? suggestModel : null,
    });
    applied.push("Nota guardada en la memoria de Fransua");

    // Registro de la nota + interpretación completa (parte diario de decisiones).
    await sb.from("fransua_log").insert({
      kind: "human_note",
      source_row: sourceRow,
      payload: {
        at: new Date().toISOString(),
        author: body.author || "Fran",
        jid,
        phone,
        name,
        text,
        interpretation: interp,
        aiError,
      },
    });

    // 3) PROPONER LO DELICADO (no se aplica sin confirmación).
    if (interp?.estado_sugerido && sourceRow) {
      proposed.push({
        type: "estado",
        label: `Cambiar estado a «${interp.estado_sugerido}»`,
        estado: interp.estado_sugerido,
        sourceRow,
      });
    }
    if (interp?.recordatorio?.titulo) {
      const enDias = Number(interp.recordatorio.en_dias) || 0;
      proposed.push({
        type: "reminder",
        label: `Recordatorio: ${interp.recordatorio.titulo}${enDias ? ` (en ${enDias} día${enDias === 1 ? "" : "s"})` : ""}`,
        titulo: interp.recordatorio.titulo,
        en_dias: enDias,
        sourceRow,
        jid,
      });
    }

    return {
      ok: true,
      understood: interp?.entendido ?? (aiError ? "Nota guardada (la interpretación de Fransua no está disponible ahora)." : "Nota guardada."),
      hechos: interp?.hechos ?? [],
      applied,
      proposed,
      aiAvailable: !!interp,
      leadRef: { jid, source_row: sourceRow, phone, name },
    };
  });

  // MEMORIA por lead: timeline de notas humanas + lo que Fransua entendió/aplicó.
  // Resuelve por teléfono canónico (estable) o por source_row. Alimenta la
  // sección "Memoria de Fransua" en la ficha del lead.
  app.get("/intel/memory", async (req, reply) => {
    if (!brainConfigured()) return reply.status(503).send({ ok: false, error: "brain-not-configured" });
    const q = req.query as any;
    const phone = canonPhone(q?.phone);
    const sourceRow = Number(q?.sourceRow);
    if (!phone && !Number.isFinite(sourceRow)) {
      return reply.status(400).send({ ok: false, error: "phone o sourceRow requerido" });
    }
    const sb = getSupabase();
    const { data, error } = await sb
      .from("fransua_log")
      .select("kind,payload,source_row,created_at")
      .in("kind", ["human_note", "event"])
      .order("created_at", { ascending: false })
      .limit(400);
    if (error) return reply.status(502).send({ ok: false, error: error.message });
    const timeline = (data ?? [])
      .filter((r: any) => {
        const p = r.payload || {};
        if (phone && canonPhone(p.phone) === phone) return true;
        if (Number.isFinite(sourceRow) && (r.source_row === sourceRow || p.source_row === sourceRow)) return true;
        return false;
      })
      .map((r: any) => {
        const p = r.payload || {};
        if (r.kind === "event") {
          return {
            at: p.at ?? r.created_at,
            author: p.author ?? "Sistema",
            text: p.text ?? "",
            tipo: "evento" as const,
            understood: null,
            hechos: [],
            applied: [],
            proposed: [],
          };
        }
        return {
          at: p.at ?? r.created_at,
          author: p.author ?? "Fran",
          text: p.text ?? "",
          tipo: "nota" as const,
          understood: p.interpretation?.entendido ?? null,
          hechos: p.interpretation?.hechos ?? [],
          applied: p.applied ?? [],
          proposed: (p.proposed ?? []).map((x: any) => x?.label ?? x?.type).filter(Boolean),
        };
      });
    return { found: timeline.length > 0, timeline };
  });

  // EVENTO del lead (p.ej. cambio de estado desde el dashboard) → memoria de
  // Fransua. Así el cambio queda registrado y visible en el timeline del lead
  // ("cerrar el círculo"). El dashboard lo llama tras un set-estado con éxito.
  app.post("/intel/event", async (req, reply) => {
    if (!brainConfigured()) return reply.status(503).send({ ok: false, error: "brain-not-configured" });
    const body = (req.body ?? {}) as NoteBody & { evento?: string };
    const text = String(body.text ?? "").trim();
    if (!text) return reply.status(400).send({ ok: false, error: "text vacío" });
    const sb = getSupabase();
    const sourceRow = Number.isFinite(body.sourceRow) ? Number(body.sourceRow) : null;
    const { error } = await sb.from("fransua_log").insert({
      kind: "event",
      source_row: sourceRow,
      payload: {
        at: new Date().toISOString(),
        author: body.author || "Sistema",
        evento: body.evento || "estado",
        text,
        phone: canonPhone(body.phone) || null,
        jid: body.jid ?? null,
        name: body.name ?? null,
      },
    });
    if (error) return reply.status(502).send({ ok: false, error: error.message });
    return { ok: true };
  });

  // CHAT con Fransua sobre la cartera: Fran pregunta ("¿a quién llamo hoy?",
  // "¿qué objeciones aparecen?", "resúmeme a X") y Fransua responde cruzando la
  // inteligencia de las conversaciones (chat_intel). Un turno; el historial se
  // reenvía en cada llamada para dar continuidad.
  //
  // LATENCIA: (a) la foto de la cartera se CACHEA 60s en memoria — en una
  // conversación de varios turnos solo el primero paga la lectura de Supabase;
  // (b) el modelo es configurable por env WA_AI_MODEL_ASK (p.ej. "haiku" si se
  // prefiere velocidad a matiz) sin tocar código; (c) la respuesta se fuerza
  // CORTA por contrato de formato (menos tokens = menos espera).
  app.post("/intel/ask", async (req, reply) => {
    if (!brainConfigured()) return reply.status(503).send({ ok: false, error: "brain-not-configured" });
    const body = (req.body ?? {}) as { question?: string; history?: Array<{ role: string; content: string }> };
    const question = String(body.question ?? "").trim();
    if (!question) return reply.status(400).send({ ok: false, error: "question vacía" });

    let cartera: AskCartera;
    try {
      cartera = await getAskCartera();
    } catch (e) {
      return reply.status(502).send({ ok: false, error: (e as Error).message });
    }

    const hist = (body.history ?? [])
      .slice(-6)
      .map((m) => `${m.role === "assistant" ? "Fransua" : "Fran"}: ${String(m.content).slice(0, 800)}`)
      .join("\n");

    const prompt = [
      "Eres Fransua, el cerebro comercial de Common Sense Aligners (CSA), que VENDE FORMACIÓN a",
      "dentistas (programa SBA, certificación, mentoría, estancia clínica) — NO trata pacientes.",
      "Fran, el comercial, te pregunta sobre su cartera. Responde en ESPAÑOL basándote SOLO en los",
      "datos de abajo. Si un dato no está, dilo con franqueza.",
      "",
      "FORMATO DE RESPUESTA (obligatorio — Fran lee esto en una ventana pequeña mientras trabaja):",
      "- Arranca DIRECTO con una línea de titular con la respuesta (sin saludos ni preámbulos).",
      "- Si la respuesta son leads/acciones: lista numerada, máx 5 salvo que pidan más, cada item:",
      "  `1. **Nombre** — motivo breve (temperatura, Xd de silencio, si te espera) → llama/escríbele y qué decirle en una frase.`",
      "  (el tramo de la acción SIEMPRE introducido con la flecha `→`).",
      "- Si aporta, cierra con UNA línea `➜ Siguiente paso: …` (lo primero que Fran debería hacer al cerrar esta ventana).",
      "- Máximo ~130 palabras en total. Nada de párrafos largos. Amplía solo si Fran lo pide.",
      "",
      `=== CARTERA (hoy · ${cartera.shownCount}${cartera.totalWithSignal > cartera.shownCount ? ` de ${cartera.totalWithSignal}` : ""} leads con conversación analizada) ===`,
      "Formato: nombre · temperatura · producto · días de silencio · [ESPERANDO-RESP] · intereses · resumen",
      cartera.lines,
      cartera.totalWithSignal > cartera.shownCount
        ? `(…y ${cartera.totalWithSignal - cartera.shownCount} leads más con menos señal, no listados)`
        : "",
      "",
      hist ? "=== CONVERSACIÓN PREVIA ===\n" + hist : "",
      "",
      `Fran: ${question}`,
      "Fransua:",
    ]
      .filter(Boolean)
      .join("\n");

    try {
      const answer = await runText(prompt, askModel);
      return { ok: true, answer: answer || "(sin respuesta)", leadsConsiderados: cartera.shownCount };
    } catch (e) {
      return reply.status(502).send({ ok: false, error: "IA no disponible", message: (e as Error).message });
    }
  });

  // Confirmar una propuesta. De momento crea el RECORDATORIO en Supabase (el
  // cambio de estado lo aplica el dashboard vía /api/crm/set-estado, que es
  // quien tiene las credenciales del Sheet).
  app.post("/intel/note/confirm", async (req, reply) => {
    if (!brainConfigured()) return reply.status(503).send({ ok: false, error: "brain-not-configured" });
    const body = (req.body ?? {}) as { type?: string; titulo?: string; en_dias?: number; sourceRow?: number; jid?: string };
    if (body.type !== "reminder") return reply.status(400).send({ ok: false, error: "tipo no soportado aquí" });
    if (!body.titulo) return reply.status(400).send({ ok: false, error: "titulo requerido" });
    const enDias = Number(body.en_dias) || 0;
    const due = new Date(Date.now() + enDias * 86400_000).toISOString();
    const sb = getSupabase();
    const { error } = await sb.from("reminders").insert({
      source_row: Number.isFinite(body.sourceRow) ? body.sourceRow : null,
      jid: body.jid ?? null,
      titulo: body.titulo,
      due_at: due,
      origen: "fransua",
    });
    if (error) return reply.status(502).send({ ok: false, error: error.message });
    return { ok: true, created: { titulo: body.titulo, due_at: due } };
  });
}
