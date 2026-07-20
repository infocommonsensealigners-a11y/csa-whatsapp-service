/** Borra los artefactos de la nota de PRUEBA (Marina Ariza, fila 1387). */
import { getSupabase } from "../src/brain/supabase";

const JID = "34653288963@s.whatsapp.net";
const ROW = 1387;
const sb = getSupabase();

// 1) intereses: quitar los que vengan de "nota de Fran".
const { data } = await sb.from("chat_intel").select("intereses").eq("jid", JID).maybeSingle();
if (data && Array.isArray((data as any).intereses)) {
  const cleaned = (data as any).intereses.filter((x: any) => !String(x?.evidence ?? "").toLowerCase().includes("nota de fran"));
  await sb.from("chat_intel").update({ intereses: cleaned }).eq("jid", JID);
  console.log("intereses limpiados →", cleaned.length);
}

// 2) reminders de prueba.
const r = await sb.from("reminders").delete().eq("source_row", ROW).eq("titulo", "Llamar a Marina para cerrar certificación avanzada");
console.log("reminders borrados:", r.error ? r.error.message : "ok");

// 3) conversation_memory de prueba.
const m = await sb.from("conversation_memory").delete().eq("source_row", ROW).like("content", "[nota de Fran]%");
console.log("memory borrada:", m.error ? m.error.message : "ok");

// 4) fransua_log human_note + event de prueba.
const l = await sb.from("fransua_log").delete().in("kind", ["human_note", "event"]).eq("source_row", ROW);
console.log("fransua_log borrado:", l.error ? l.error.message : "ok");

process.exit(0);
