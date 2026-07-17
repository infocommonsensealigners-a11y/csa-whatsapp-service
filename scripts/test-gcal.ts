/** Prueba la sincronización con Google Calendar (crea calendario, comparte, crea+borra evento). */
import { openDb } from "../src/db/db";
import {
  googleConfigured,
  serviceAccountEmail,
  serviceAccountProject,
  ensureFransuaCalendar,
  shareCalendarWith,
  pushEvent,
  deleteGoogleEvent,
  calendarShareEmail,
} from "../src/brain/googleCalendar";

openDb(); // getMeta/setMeta necesitan la BD abierta (en el sidecar lo hace el bootstrap)
console.log("configurado:", googleConfigured());
console.log("service account:", serviceAccountEmail());
console.log("proyecto GCP:", serviceAccountProject());
console.log("compartir con:", calendarShareEmail);

try {
  const calId = await ensureFransuaCalendar();
  console.log("✓ calendario CSA · Fransua:", calId);
  await shareCalendarWith(calendarShareEmail);
  console.log("✓ compartido con", calendarShareEmail);
  const gid = await pushEvent({ titulo: "PRUEBA Fransua gcal — borrar", start_at: new Date(Date.now() + 7200_000).toISOString() });
  console.log("✓ evento creado en Google:", gid);
  await deleteGoogleEvent(gid);
  console.log("✓ evento borrado — SINCRONIZACIÓN OK");
} catch (e: any) {
  const msg = String(e?.message ?? e);
  console.error("✗ ERROR:", msg.slice(0, 300));
  if (/not been used|disabled|SERVICE_DISABLED|accessNotConfigured|has not been used/i.test(msg)) {
    console.error(`\n>>> Hay que HABILITAR la Google Calendar API en el proyecto "${serviceAccountProject()}".`);
    console.error(`    https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=${serviceAccountProject()}`);
  }
}
process.exit(0);
