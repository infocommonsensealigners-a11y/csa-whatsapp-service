/**
 * IDEA 2b — Fransua AGÉNTICO: en vez de recibir todo el contexto pre-inyectado,
 * DECIDE sobre la marcha qué consultar mediante HERRAMIENTAS (read-only) y responde
 * en bucle multi-turno. Las tools reutilizan los endpoints ya montados (contexto-360
 * del lead, retrato del negocio), así que "sabe todo" pudiéndolo pedir cuando lo
 * necesita, sin inflar cada prompt.
 *
 * Solo LECTURA (no ejecuta acciones: eso es la idea 4, con aprobación). maxTurns
 * acotado para topar coste/latencia. Registra consumo igual que runText.
 */
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { ensureClaudeAuth } from "../brain/secrets";
import { logUsage } from "../brain/usage";
import { suggestModel } from "./agent";
import { getLeadContext360 } from "../brain/leadContext";
import { getBusinessSnapshot } from "../brain/businessSnapshot";
import { getSupabase, brainConfigured } from "../brain/supabase";

const fichaLead = tool(
  "ficha_lead",
  "Ficha 360 de UN lead por su teléfono: estado en el CRM, producto, fechas, propuesta/venta y si es alumno. Úsala cuando la pregunta trate de una persona concreta.",
  { telefono: z.string().describe("teléfono del lead (9 dígitos, o con prefijo)") },
  async (args: { telefono: string }) => {
    const texto = await getLeadContext360(args.telefono);
    return { content: [{ type: "text" as const, text: texto ?? "No hay ficha en el CRM para ese teléfono." }] };
  }
);

const fotoNegocio = tool(
  "foto_negocio",
  "Retrato del negocio HOY: embudo, cola activa por nivel, base a reactivar, renovaciones, ingresos del mes y alumnos. Úsala para preguntas sobre el estado global de la cartera.",
  {},
  async () => {
    const texto = await getBusinessSnapshot();
    return { content: [{ type: "text" as const, text: texto ?? "No disponible ahora mismo." }] };
  }
);

const buscarLeads = tool(
  "buscar_leads",
  "Busca leads en la inteligencia de conversaciones por un TEXTO (tema, interés, producto, campaña…). Devuelve, por cada coincidencia, su NOMBRE, su sourceRow (nº de fila en el CRM) y su teléfono. Úsalo para armar un conjunto de leads — p.ej. para luego abrir una vista filtrada en el CRM: necesitas sus sourceRow.",
  { texto: z.string().describe("qué buscar, p.ej. 'Black Friday', 'financiación', 'certificación'") },
  async (args: { texto: string }) => {
    if (!brainConfigured()) return { content: [{ type: "text" as const, text: "Inteligencia no disponible." }] };
    const q = (args.texto ?? "").toLowerCase().trim();
    const sb = getSupabase();
    const { data, error } = await sb
      .from("chat_intel")
      .select("source_row,phone,display_name,resumen,etiquetas,producto,temperatura")
      .order("last_ts", { ascending: false })
      .limit(2000);
    if (error) return { content: [{ type: "text" as const, text: "Error consultando la inteligencia." }] };
    const rows = (data ?? []).filter((r: any) => {
      const ets = Array.isArray(r.etiquetas) ? r.etiquetas.join(" ") : "";
      return `${r.display_name ?? ""} ${r.resumen ?? ""} ${r.producto ?? ""} ${ets}`.toLowerCase().includes(q);
    });
    const lineas = rows.slice(0, 60).map((r: any) => {
      const cliente = Array.isArray(r.etiquetas) && r.etiquetas.some((e: any) => String(e).toLowerCase() === "cliente") ? " · CLIENTE" : "";
      const fila = r.source_row != null ? ` (fila ${r.source_row})` : " (sin fila CRM)";
      return `- ${r.display_name ?? "?"}${fila} · ${r.temperatura ?? "?"}${r.producto ? ` · ${r.producto}` : ""}${cliente}`;
    });
    const txt = rows.length
      ? `${rows.length} leads coinciden con "${args.texto}" (máx 60 listados; usa el nº de fila como sourceRow):\n${lineas.join("\n")}`
      : `Ningún lead coincide con "${args.texto}".`;
    return { content: [{ type: "text" as const, text: txt }] };
  }
);

const fransuaMcpServer = createSdkMcpServer({ name: "fransua", version: "1.0.0", tools: [fichaLead, fotoNegocio, buscarLeads] });

export interface AgentRun {
  text: string;
  toolsUsed: string[];
}

/** Ejecuta a Fransua en modo AGENTE (con herramientas, multi-turno acotado). */
export async function runAgent(prompt: string, model?: string): Promise<AgentRun> {
  await ensureClaudeAuth();
  const q = query({
    prompt,
    options: {
      mcpServers: { fransua: fransuaMcpServer },
      allowedTools: ["mcp__fransua__ficha_lead", "mcp__fransua__foto_negocio", "mcp__fransua__buscar_leads"],
      maxTurns: 6,
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
