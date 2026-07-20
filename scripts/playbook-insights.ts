/**
 * "El Playbook" — síntesis de aprendizajes por IA a partir de las conversaciones
 * ya analizadas (usa los resúmenes de chat_intel, no relee los mensajes crudos).
 *
 * Cruza chat_intel (Supabase) con el estado del CRM POR TELÉFONO (lead_directory,
 * estable) → separa GANADAS (Compra) de PERDIDAS (No cualifica) y pide a la IA:
 *  - el método que funciona,
 *  - argumentos que convierten,
 *  - objeciones y cómo se superan,
 *  - señales de compra y motivos de pérdida.
 * Guarda el resultado agregado en Supabase `fransua_log` (kind='playbook_insights')
 * → el dashboard lo lee vía /intel/playbook-insights.
 *
 * Uso: npx tsx --env-file=.env scripts/playbook-insights.ts
 */
import Database from "better-sqlite3";
import { config } from "../src/config";
import { getSupabase } from "../src/brain/supabase";
import { runJson, bulkModel } from "../src/ai/agent";

const canon = (t: unknown): string | null => {
  const d = String(t ?? "").replace(/\D/g, "");
  return d.length >= 9 ? d.slice(-9) : null;
};

type Row = { jid: string; phone: string | null; producto: string | null; resumen: string | null; etiquetas: unknown; intereses: unknown };

const db = new Database(config.dbPath, { readonly: true });
const sb = getSupabase();

// estado por teléfono (estable) desde lead_directory
const estadoByPhone = new Map<string, string>();
for (const r of db.prepare("SELECT phone, estado FROM lead_directory").all() as Array<{ phone: string; estado: string }>) {
  const p = canon(r.phone);
  if (p && r.estado) estadoByPhone.set(p, r.estado);
}
const bucketOf = (phone: string | null): "ganado" | "perdido" | "otro" => {
  const p = canon(phone);
  const e = p ? estadoByPhone.get(p)?.toLowerCase() : undefined;
  if (!e) return "otro";
  if (e.includes("compra")) return "ganado";
  if (e.includes("no cualifica")) return "perdido";
  return "otro";
};

const { data, error } = await sb.from("chat_intel").select("jid,phone,producto,resumen,etiquetas,intereses").limit(5000);
if (error) { console.error(error); process.exit(1); }
const rows = (data ?? []) as Row[];

const ganadas: string[] = [];
const perdidas: string[] = [];
for (const r of rows) {
  if (!r.resumen) continue;
  const b = bucketOf(r.phone);
  const line = `- (${r.producto ?? "—"}) ${r.resumen}`;
  if (b === "ganado") ganadas.push(line);
  else if (b === "perdido") perdidas.push(line);
}
console.log(`Ganadas: ${ganadas.length} · Perdidas: ${perdidas.length}`);

const cap = (arr: string[], n: number) => arr.slice(0, n).join("\n").slice(0, 16000);

const prompt = `Eres el analista de Fransua, el cerebro comercial de Common Sense Aligners (CSA), que vende FORMACIÓN en alineadores a dentistas (programa SBA, certificación, estancia clínica, mentoría). A partir de los RESÚMENES de conversaciones reales, extrae el PLAYBOOK: qué funciona para cerrar y cómo superar las pegas. Sé concreto y accionable para el comercial (Fran). No inventes; básate en los patrones que veas.

Devuelve SOLO un JSON con EXACTAMENTE estas claves:
{
  "metodo": "2 a 4 frases con el método que funciona en CSA para cerrar (lo esencial)",
  "argumentos": [{"titulo": "argumento/enfoque que convence", "detalle": "cómo usarlo, en una frase", "peso": "alto|medio"}],
  "objeciones": [{"objecion": "la pega del lead", "como_superarla": "cómo responderla", "frecuente_en": "ganados|perdidos|ambos"}],
  "senales_compra": ["señal de que un lead va a cerrar"],
  "motivos_perdida": ["por qué se pierden o descartan"]
}
Da 5-7 argumentos, 5-7 objeciones, 3-5 señales y 3-5 motivos, ordenados por relevancia.

=== CONVERSACIONES GANADAS (acabaron en Compra) ===
${cap(ganadas, 90)}

=== CONVERSACIONES PERDIDAS / DESCARTADAS ===
${cap(perdidas, 60)}`;

console.log("Sintetizando con IA…");
const synth = await runJson<Record<string, unknown>>(prompt, bulkModel);
if (!synth) { console.error("La IA no devolvió JSON válido."); process.exit(1); }

const payload = {
  generatedAt: new Date().toISOString(),
  model: bulkModel,
  nGanadas: ganadas.length,
  nPerdidas: perdidas.length,
  ...synth,
};

const { error: insErr } = await sb.from("fransua_log").insert({ kind: "playbook_insights", payload });
if (insErr) { console.error("No se pudo guardar:", insErr.message); process.exit(1); }

console.log("✓ Playbook insights guardado en fransua_log.");
console.log("método:", (synth as any).metodo);
console.log("argumentos:", ((synth as any).argumentos ?? []).length, "· objeciones:", ((synth as any).objeciones ?? []).length);
db.close();
process.exit(0);
