/**
 * Rutas de INTELIGENCIA (cerebro de Fransua). Leen chat_intel de Supabase —
 * la salida del worker de asimilación — y la sirven al dashboard vía el proxy.
 *
 *  - GET /intel/summary?since=YYYY-MM-DD  → digest "Fransua sugiere hoy"
 *  - GET /intel/list?temp=&since=&limit=  → lista filtrable
 *  - GET /intel/by-lead/:sourceRow        → inteligencia de un lead del CRM
 *  - GET /intel/:jid                      → inteligencia de un chat concreto
 *
 * Ventanas (criterio del usuario): APRENDIZAJE desde 2024 (ya asimilado);
 * ESTRATEGIA/acciones desde abril 2025 (inicio de Fran) → default de `since`.
 */
import type { FastifyInstance } from "fastify";
import { brainConfigured, getSupabase } from "../../brain/supabase";
import { getDb } from "../../db/db";
import { runText, runJson, suggestModel } from "../../ai/agent";
import { analyzeChat } from "../../brain/analyzeChat";
import { getPlanContext } from "../../brain/plan";
import { ESTRATEGIA_CSA } from "../../brain/estrategia";

const STRATEGY_SINCE = "2025-04-01";
const COLS =
  "jid,phone,display_name,source_row,producto,first_ts,last_ts,msg_count,from_me_count,temperatura,temperatura_motivo,resumen,intereses,intervalos,etiquetas,model,updated_at";

function sinceToTs(since?: string): number {
  const d = since && /^\d{4}-\d{2}-\d{2}$/.test(since) ? since : STRATEGY_SINCE;
  return Math.floor(new Date(d + "T00:00:00Z").getTime() / 1000);
}
const daysSince = (ts: number | null) => (ts ? Math.floor(Date.now() / 1000 - ts) / 86400 : Infinity);

type IntelRow = {
  jid: string; phone: string | null; display_name: string | null; source_row: number | null;
  producto: string | null; first_ts: number | null; last_ts: number | null; msg_count: number;
  from_me_count: number; temperatura: string | null; temperatura_motivo: string | null;
  resumen: string | null; intereses: unknown; intervalos: any; etiquetas: unknown; updated_at: string;
};

/** True cuando las etiquetas marcan que YA es alumno/cliente de CSA. */
function esCliente(r: IntelRow): boolean {
  const ets = Array.isArray(r.etiquetas) ? (r.etiquetas as unknown[]) : [];
  return ets.some((e) => {
    const s = String(e).toLowerCase();
    return s === "cliente" || s === "ya inscrito" || s === "alumno" || s === "alumna";
  });
}

/** Añade campos derivados en vivo (silencio real desde last_ts, pendiente de respuesta, es_cliente). */
function enrich(r: IntelRow) {
  const silencioDias = Math.round(daysSince(r.last_ts));
  const ultimoEmisor = r.intervalos?.ultimo_emisor ?? null;
  return {
    ...r,
    silencio_dias: silencioDias,
    ultimo_emisor: ultimoEmisor,
    esperando_respuesta: ultimoEmisor === "lead",
    es_cliente: esCliente(r),
  };
}

export function registerIntelRoutes(app: FastifyInstance): void {
  app.get("/intel/summary", async (req, reply) => {
    if (!brainConfigured()) return reply.status(503).send({ ok: false, error: "brain-not-configured" });
    const since = (req.query as any)?.since as string | undefined;
    const sinceTs = sinceToTs(since);
    const sb = getSupabase();

    const { data, error } = await sb
      .from("chat_intel")
      .select(COLS)
      .gte("last_ts", sinceTs)
      .order("last_ts", { ascending: false })
      .limit(2000);
    if (error) return reply.status(502).send({ ok: false, error: error.message });

    const rows = (data as IntelRow[]).map(enrich);
    const byTemp = { caliente: 0, templado: 0, frio: 0, sin_dato: 0 };
    for (const r of rows) {
      if (r.temperatura === "caliente") byTemp.caliente++;
      else if (r.temperatura === "templado") byTemp.templado++;
      else if (r.temperatura === "frio") byTemp.frio++;
      else byTemp.sin_dato++;
    }

    // CATEGORÍA: los que YA son alumnos/clientes (etiqueta "cliente", puesta por
    // el análisis o por el sync de verdad-terreno del CRM) SALEN de los carriles
    // de VENTA y van a su carril propio — un alumno esperando respuesta importa,
    // pero es cuidado/postventa, no captación.
    const venta = rows.filter((r) => !r.es_cliente);
    const clientes = rows.filter((r) => r.es_cliente);

    // Acciones priorizadas para HOY:
    // 1) leads que escribieron ellos y siguen sin respuesta (esperando a Fran).
    const esperando = venta
      .filter((r) => r.esperando_respuesta && r.silencio_dias >= 0)
      .sort((a, b) => tempRank(b.temperatura) - tempRank(a.temperatura) || a.silencio_dias - b.silencio_dias)
      .slice(0, 25);
    // 2) calientes que se están enfriando (sin actividad ≥ 2 días).
    const calientesEnfriando = venta
      .filter((r) => r.temperatura === "caliente" && r.silencio_dias >= 2)
      .sort((a, b) => a.silencio_dias - b.silencio_dias)
      .slice(0, 25);
    // 3) templados a reactivar (7–45 días de silencio).
    const templadosReactivar = venta
      .filter((r) => r.temperatura === "templado" && r.silencio_dias >= 7 && r.silencio_dias <= 45)
      .sort((a, b) => a.silencio_dias - b.silencio_dias)
      .slice(0, 25);
    // 4) alumnos/clientes que escribieron y esperan respuesta (postventa).
    const alumnosEscriben = clientes
      .filter((r) => r.esperando_respuesta && r.silencio_dias >= 0)
      .sort((a, b) => a.silencio_dias - b.silencio_dias)
      .slice(0, 25);

    return {
      generatedAt: new Date().toISOString(),
      since: since ?? STRATEGY_SINCE,
      total: rows.length,
      byTemp,
      esperandoRespuesta: esperando,
      calientesEnfriando,
      templadosReactivar,
      alumnosEscriben,
      clientesDetectados: clientes.length,
    };
  });

  // SYNC DE VERDAD-TERRENO: el dashboard conoce quién ES cliente de verdad
  // (estado Compra en el CRM + matriculados en EDICIONES). Este endpoint recibe
  // esos teléfonos canónicos (9 díg) y etiqueta "cliente" en chat_intel — la
  // fuente exacta, sin IA, idempotente. Lo dispara el script
  // dashboard/scripts/sync-clientes-brain.ts (re-ejecutable cuando se quiera).
  app.post("/intel/clientes-sync", async (req, reply) => {
    if (!brainConfigured()) return reply.status(503).send({ ok: false, error: "brain-not-configured" });
    const body = (req.body ?? {}) as { phones?: unknown };
    const phones = Array.isArray(body.phones)
      ? Array.from(new Set(body.phones.map((p) => String(p).replace(/\D/g, "").slice(-9)).filter((p) => p.length === 9)))
      : [];
    if (phones.length === 0) return reply.status(400).send({ ok: false, error: "phones vacío" });

    const sb = getSupabase();
    let matched = 0;
    const jidsEtiquetados: string[] = [];
    // Lotes de 200 teléfonos por consulta (límite práctico del filtro .in()).
    for (let i = 0; i < phones.length; i += 200) {
      const batch = phones.slice(i, i + 200);
      const { data, error } = await sb.from("chat_intel").select("jid,etiquetas").in("phone", batch);
      if (error) return reply.status(502).send({ ok: false, error: error.message });
      for (const row of (data ?? []) as { jid: string; etiquetas: unknown }[]) {
        matched += 1;
        const ets = Array.isArray(row.etiquetas) ? row.etiquetas.map((e) => String(e)) : [];
        if (ets.some((e) => e.toLowerCase() === "cliente")) continue;
        const { error: upErr } = await sb
          .from("chat_intel")
          .update({ etiquetas: ["cliente", ...ets] })
          .eq("jid", row.jid);
        if (!upErr) jidsEtiquetados.push(row.jid);
      }
    }
    // jidsEtiquetados = recién marcados (su resumen puede ser "de venta" viejo):
    // son los candidatos a re-análisis (scripts/sync-clientes-brain --reanalyze).
    return {
      ok: true,
      phonesRecibidos: phones.length,
      chatsEncontrados: matched,
      etiquetados: jidsEtiquetados.length,
      jidsEtiquetados,
    };
  });

  app.get("/intel/list", async (req, reply) => {
    if (!brainConfigured()) return reply.status(503).send({ ok: false, error: "brain-not-configured" });
    const q = req.query as any;
    const sinceTs = sinceToTs(q?.since);
    const limit = Math.min(Number(q?.limit) || 200, 2000);
    const sb = getSupabase();
    let query = sb.from("chat_intel").select(COLS).gte("last_ts", sinceTs).order("last_ts", { ascending: false }).limit(limit);
    if (q?.temp) query = query.eq("temperatura", String(q.temp));
    const { data, error } = await query;
    if (error) return reply.status(502).send({ ok: false, error: error.message });
    return { items: (data as IntelRow[]).map(enrich) };
  });

  app.get("/intel/by-lead/:sourceRow", async (req, reply) => {
    if (!brainConfigured()) return reply.status(503).send({ ok: false, error: "brain-not-configured" });
    const sourceRow = Number((req.params as any).sourceRow);
    if (!Number.isFinite(sourceRow)) return reply.status(400).send({ ok: false, error: "sourceRow inválido" });
    const sb = getSupabase();
    const { data, error } = await sb.from("chat_intel").select(COLS).eq("source_row", sourceRow).order("last_ts", { ascending: false });
    if (error) return reply.status(502).send({ ok: false, error: error.message });
    const items = (data as IntelRow[]).map(enrich);
    return { sourceRow, found: items.length > 0, items };
  });

  // Resolución ESTABLE por teléfono. El source_row es la fila del Google Sheet y
  // se desplaza cuando se editan filas; el teléfono canónico (9 díg) NO. La ficha
  // y el panel deben resolver por aquí para no mostrar el lead equivocado.
  app.get("/intel/by-phone/:phone", async (req, reply) => {
    if (!brainConfigured()) return reply.status(503).send({ ok: false, error: "brain-not-configured" });
    const phone = String((req.params as any).phone).replace(/\D/g, "").slice(-9);
    if (phone.length < 9) return reply.status(400).send({ ok: false, error: "phone inválido" });
    const sb = getSupabase();
    const { data, error } = await sb.from("chat_intel").select(COLS).eq("phone", phone).order("last_ts", { ascending: false });
    if (error) return reply.status(502).send({ ok: false, error: error.message });
    const items = (data as IntelRow[]).map(enrich);
    return { phone, found: items.length > 0, items };
  });

  // El Playbook: síntesis IA de argumentos/objeciones/método (la genera
  // scripts/playbook-insights.ts y se guarda en fransua_log).
  app.get("/intel/playbook-insights", async (_req, reply) => {
    if (!brainConfigured()) return reply.status(503).send({ ok: false, error: "brain-not-configured" });
    const sb = getSupabase();
    const { data, error } = await sb
      .from("fransua_log")
      .select("payload,created_at")
      .eq("kind", "playbook_insights")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return reply.status(502).send({ ok: false, error: error.message });
    if (!data) return { found: false };
    return { found: true, storedAt: data.created_at, ...(data.payload as Record<string, unknown>) };
  });

  // Sugerencia de mensaje: Fransua redacta el SIGUIENTE mensaje que Fran debería
  // enviar, a partir de la conversación (sqlite) + el contexto (chat_intel). Usa
  // Claude vía la suscripción (ai/agent runText). On-demand (botón en la UI).
  app.get("/intel/suggest/:jid", async (req, reply) => {
    const jid = decodeURIComponent((req.params as any).jid);
    const db = getDb();
    const chat = db.prepare("SELECT jid, phone, display_name FROM chats WHERE jid = ?").get(jid) as
      | { jid: string; phone: string | null; display_name: string | null }
      | undefined;
    if (!chat) return reply.status(404).send({ ok: false, error: "chat no encontrado" });

    const rows = db
      .prepare(
        "SELECT from_me, text FROM messages WHERE chat_jid = ? AND text IS NOT NULL AND text <> '' ORDER BY ts DESC LIMIT 24"
      )
      .all(jid) as { from_me: number; text: string }[];
    if (rows.length === 0) return reply.status(422).send({ ok: false, error: "sin mensajes de texto en esta conversación" });
    const transcript = rows
      .reverse()
      .map((m) => `${m.from_me ? "Fran" : chat.display_name || "Lead"}: ${m.text}`)
      .join("\n");

    let resumen: string | null = null;
    let temperatura: string | null = null;
    if (brainConfigured()) {
      const sb = getSupabase();
      let q = await sb.from("chat_intel").select("resumen,temperatura").eq("jid", jid).maybeSingle();
      let row = q.data as { resumen: string | null; temperatura: string | null } | null;
      if (!row && chat.phone) {
        const r = await sb
          .from("chat_intel")
          .select("resumen,temperatura")
          .eq("phone", chat.phone)
          .order("last_ts", { ascending: false })
          .limit(1);
        row = (r.data?.[0] as any) ?? null;
      }
      resumen = row?.resumen ?? null;
      temperatura = row?.temperatura ?? null;
    }

    const planTexto = await getPlanContext().then((p) => p.texto).catch(() => null);

    const prompt = `Eres Fransua, el asistente del comercial de Common Sense Aligners (CSA). CSA vende FORMACIÓN a dentistas (programa SBA — Sistema de Biomecánica Avanzada); NO es una clínica y los leads son profesionales de la odontología.

${ESTRATEGIA_CSA}

${planTexto ? planTexto + "\n" : ""}
Conversación de WhatsApp entre Fran (el comercial) y ${chat.display_name || "el lead"} (de más antiguo a más reciente):
---
${transcript}
---
${resumen ? `Resumen previo del lead: ${resumen}\nTemperatura: ${temperatura ?? "?"}\n` : ""}
Redacta EL SIGUIENTE mensaje que Fran debería enviarle por WhatsApp para hacer avanzar la relación/venta de forma natural, APLICANDO la estrategia de arriba: si el lead lleva mucho en silencio reactívalo aportando valor + gancho de temporada (nunca un "¿sigues interesado?" a secas); si es un "más adelante", cierra con un próximo paso concreto y una FECHA; si acaba de entrar, sé rápido y directo. Si hay una oferta o hito vigente este mes que encaje, úsalo, pero SIN inventar precios ni condiciones que no estén arriba. Requisitos: español de España, tono cercano y profesional, sin sonar a plantilla, 1-3 frases, listo para copiar y pegar. Responde ÚNICAMENTE con el texto del mensaje (sin comillas, sin explicaciones, sin firma).`;

    try {
      const suggestion = (await runText(prompt, suggestModel)).replace(/^["']|["']$/g, "").trim();
      if (!suggestion) return reply.status(503).send({ ok: false, error: "IA no disponible ahora mismo." });
      return { ok: true, jid, suggestion };
    } catch (e) {
      return reply.status(503).send({ ok: false, error: "IA no disponible: " + (e as Error).message });
    }
  });

  // EXTRAER DATOS FISCALES del hilo de un contacto (para autorrellenar una
  // factura en el dashboard). Acepta ?tel=<teléfono> o ?jid=<jid>. Lee los
  // mensajes de sqlite y pide a Claude (suscripción) un JSON estricto. Solo
  // lectura; no toca Supabase ni escribe nada.
  app.get("/intel/extract-fiscal", async (req, reply) => {
    const db = getDb();
    const { tel, jid: jidQ } = req.query as { tel?: string; jid?: string };
    let jid = (jidQ || "").trim();
    let chat: { jid: string; phone: string | null; display_name: string | null } | undefined;
    if (jid) {
      chat = db.prepare("SELECT jid, phone, display_name FROM chats WHERE jid = ?").get(jid) as any;
    } else if (tel && String(tel).trim()) {
      const phone = String(tel).replace(/\D/g, "").slice(-9);
      chat = db
        .prepare("SELECT jid, phone, display_name FROM chats WHERE phone = ? ORDER BY last_message_at DESC LIMIT 1")
        .get(phone) as any;
      jid = chat?.jid || "";
    } else {
      return reply.status(400).send({ ok: false, error: "Falta ?tel= o ?jid=" });
    }
    if (!chat || !jid) return reply.status(404).send({ ok: false, error: "No hay chat de WhatsApp para ese contacto." });

    const rows = db
      .prepare("SELECT from_me, text FROM messages WHERE chat_jid = ? AND text IS NOT NULL AND text <> '' ORDER BY ts ASC")
      .all(jid) as { from_me: number; text: string }[];
    if (rows.length === 0) return reply.status(422).send({ ok: false, error: "El contacto no tiene mensajes de texto." });
    const transcript = rows
      .map((m) => `${m.from_me ? "Fran" : chat!.display_name || "Cliente"}: ${m.text}`)
      .join("\n")
      .slice(-12000);

    const prompt = `Extrae los DATOS FISCALES del CLIENTE (nunca los de Fran, el comercial) de esta conversación de WhatsApp de Common Sense Aligners (formación a dentistas), para emitir una factura.
Devuelve SOLO un objeto JSON con EXACTAMENTE estas claves (usa null si el dato NO aparece; NO inventes nada):
{"cif":null,"razonSocial":null,"nombre":null,"direccion":null,"cp":null,"ciudad":null,"provincia":null,"importe":null,"formaPago":null,"confianza":"alta"}
Reglas: "cif" = CIF/NIF español del cliente (formato válido); "razonSocial" = nombre fiscal o empresa (si es autónomo, su nombre y apellidos completos); "nombre" = persona de contacto; "direccion"/"cp"/"ciudad"/"provincia" = domicilio fiscal del cliente; "importe" en euros como número con punto decimal (o null); "formaPago" si se menciona (Transferencia/Fraccionado…); "confianza" = "alta"|"media"|"baja" según cuántos datos claros del cliente haya. Toma SIEMPRE los datos del CLIENTE.
CONVERSACIÓN (de más antigua a más reciente):
---
${transcript}
---`;

    try {
      const fiscal = await runJson<Record<string, unknown>>(prompt, suggestModel);
      if (!fiscal) return reply.status(503).send({ ok: false, error: "La IA no pudo extraer los datos ahora mismo." });
      return { ok: true, jid, displayName: chat.display_name, phone: chat.phone, fiscal };
    } catch (e) {
      return reply.status(503).send({ ok: false, error: "IA no disponible: " + (e as Error).message });
    }
  });

  // Análisis EN DIRECTO de un chat (Fransua): calcula la inteligencia al vuelo y
  // la persiste. Lo llama el teléfono al abrir una conversación sin intel (o
  // obsoleta) y el webhook cuando entra un mensaje nuevo.
  app.post("/intel/analyze/:jid", async (req, reply) => {
    const jid = decodeURIComponent((req.params as any).jid);
    const res = await analyzeChat(jid);
    if (!res.ok) return reply.status(res.status).send({ ok: false, error: res.reason });
    return enrich(res.record as unknown as IntelRow);
  });

  app.get("/intel/:jid", async (req, reply) => {
    if (!brainConfigured()) return reply.status(503).send({ ok: false, error: "brain-not-configured" });
    const jid = decodeURIComponent((req.params as any).jid);
    const sb = getSupabase();
    const { data, error } = await sb.from("chat_intel").select(COLS).eq("jid", jid).maybeSingle();
    if (error) return reply.status(502).send({ ok: false, error: error.message });
    if (!data) return reply.status(404).send({ ok: false, error: "sin inteligencia para este chat" });
    return enrich(data as IntelRow);
  });
}

function tempRank(t: string | null): number {
  return t === "caliente" ? 3 : t === "templado" ? 2 : t === "frio" ? 1 : 0;
}
