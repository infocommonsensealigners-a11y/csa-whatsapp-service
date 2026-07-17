/** Muestra las últimas fichas de inteligencia guardadas en Supabase. */
import { getSupabase } from "../src/brain/supabase";

const n = process.argv[2] ? Number(process.argv[2]) : 3;
const sb = getSupabase();
const { data, error } = await sb
  .from("chat_intel")
  .select("*")
  .order("updated_at", { ascending: false })
  .limit(n);
if (error) { console.error(error); process.exit(1); }
for (const r of data ?? []) {
  console.log("\n════════════════════════════════════════");
  console.log(`${r.display_name ?? r.jid}  ·  lead #${r.source_row ?? "—"}  ·  🌡️ ${r.temperatura}`);
  console.log(`motivo: ${r.temperatura_motivo}`);
  console.log(`resumen: ${r.resumen}`);
  console.log(`producto: ${r.producto}`);
  console.log(`intereses:`, JSON.stringify(r.intereses));
  console.log(`etiquetas:`, JSON.stringify(r.etiquetas));
  console.log(`intervalos:`, JSON.stringify(r.intervalos));
}
process.exit(0);
