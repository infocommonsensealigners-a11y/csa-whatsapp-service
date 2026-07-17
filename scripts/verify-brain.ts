/** Comprueba que las tablas del cerebro existen y son accesibles. */
import { getSupabase } from "../src/brain/supabase";

const sb = getSupabase();
const tables = ["lead_mirror", "chat_intel", "conversation_memory", "reminders", "calendar_events", "fransua_log"];
let allOk = true;
for (const t of tables) {
  const { count, error } = await sb.from(t).select("*", { count: "exact", head: true });
  if (error) {
    allOk = false;
    console.log(`✗ ${t}: ${error.message}`);
  } else {
    console.log(`✓ ${t} (${count ?? 0} filas)`);
  }
}
console.log(allOk ? "\n✓ Cerebro listo." : "\n✗ Faltan tablas — revisa el SQL.");
process.exit(allOk ? 0 : 1);
