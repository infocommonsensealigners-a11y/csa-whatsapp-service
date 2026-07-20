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
import { runJson, suggestModel } from "../../ai/agent";

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
