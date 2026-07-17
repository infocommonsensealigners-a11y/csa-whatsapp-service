/** Verifica la clave/URL de Supabase con el cliente oficial. */
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL!;
const key = process.env.SUPABASE_SECRET_KEY!;
console.log("URL:", url, "| key prefijo:", key?.slice(0, 14), "| longitud:", key?.length);

const sb = createClient(url, key, { auth: { persistSession: false } });

const { error } = await sb.from("__fransua_probe__").select("*").limit(1);
if (!error) {
  console.log("✓ conectado (tabla existe, improbable)");
} else if (/does not exist|find the table|PGRST205|42P01/i.test(error.message + (error.code ?? ""))) {
  console.log("✓ CLAVE VÁLIDA — conecta bien; solo falta crear tablas. (error esperado:", error.code, ")");
} else if (/invalid|api key|jwt|401|unauthorized/i.test(error.message)) {
  console.log("✗ CLAVE RECHAZADA:", error.message);
} else {
  console.log("? otro error:", error.code, error.message);
}
process.exit(0);
