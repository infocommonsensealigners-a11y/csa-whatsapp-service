/**
 * Siembra/limpia chats de DEMO en la BD local, SOLO para verificar visualmente
 * la UI del teléfono flotante sin depender de un emparejamiento real.
 *   npx tsx scripts/seed-demo.ts insert
 *   npx tsx scripts/seed-demo.ts clean
 * Los JIDs de demo llevan el prefijo 3460099 para poder borrarlos con precisión.
 */
import { openDb } from "../src/db/db";

const DEMO_JIDS = [
  "34600990001@s.whatsapp.net",
  "34600990002@s.whatsapp.net",
  "34600990003@s.whatsapp.net",
  "34600990004@s.whatsapp.net",
];

const db = openDb();
const mode = process.argv[2] ?? "insert";
const now = Math.floor(Date.now() / 1000);

function clean() {
  const del = db.prepare("DELETE FROM messages WHERE chat_jid = ?");
  const delc = db.prepare("DELETE FROM chats WHERE jid = ?");
  for (const jid of DEMO_JIDS) {
    del.run(jid);
    delc.run(jid);
  }
  console.log("demo limpiado");
}

if (mode === "clean") {
  clean();
  process.exit(0);
}

clean(); // idempotente
const upChat = db.prepare(
  `INSERT INTO chats(jid, phone, display_name, last_message_at, last_message_preview, last_opened_at, ignored, created_at, updated_at)
   VALUES (@jid,@phone,@name,@ts,@preview,@opened,0,@now,@now)`
);
const upMsg = db.prepare(
  `INSERT INTO messages(chat_jid, id, from_me, ts, type, text, media_path, media_mime, raw_json)
   VALUES (@jid,@id,@from,@ts,@type,@text,NULL,NULL,NULL)`
);

let mid = 1;
function msg(jid: string, from: 0 | 1, ago: number, type: string, text: string | null) {
  upMsg.run({ jid, id: `demo${mid++}`, from, ts: now - ago, type, text });
}

// Chat 1 — conversación rica (para la captura de la conversación)
upChat.run({
  jid: DEMO_JIDS[0],
  phone: "600990001",
  name: "Laura Gómez",
  ts: now - 300,
  preview: "Perfecto, ¿me pasáis la info por aquí?",
  opened: now - 100000, // deja 2 no leídos
  now,
});
msg(DEMO_JIDS[0], 0, 7200, "text", "Hola! Vi vuestro anuncio de alineadores invisibles 😊");
msg(DEMO_JIDS[0], 1, 7100, "text", "¡Hola Laura! Gracias por escribirnos 🙌 ¿Buscas información para ti?");
msg(DEMO_JIDS[0], 0, 7000, "text", "Sí, para mí. Tengo los dientes de abajo un poco montados");
msg(DEMO_JIDS[0], 1, 6900, "text", "Perfecto. Con una primera valoración vemos tu caso y te decimos duración y precio exacto. Es gratuita.");
msg(DEMO_JIDS[0], 0, 3600, "text", "¿Y cuánto suele costar más o menos el tratamiento completo?");
msg(DEMO_JIDS[0], 1, 3500, "text", "Depende de la complejidad, pero la mayoría de casos van de 1.800€ a 2.500€, con financiación sin intereses 💜");
msg(DEMO_JIDS[0], 0, 400, "text", "Genial, me interesa mucho");
msg(DEMO_JIDS[0], 0, 300, "text", "Perfecto, ¿me pasáis la info por aquí?");

// Chat 2 — con imagen y no leídos
upChat.run({
  jid: DEMO_JIDS[1],
  phone: "600990002",
  name: "Carlos Ruiz",
  ts: now - 5400,
  preview: "📷 Foto",
  opened: now,
  now,
});
msg(DEMO_JIDS[1], 0, 5600, "text", "Buenas, os mando una foto de cómo tengo la sonrisa ahora");
msg(DEMO_JIDS[1], 0, 5400, "image", null);

// Chat 3 — un intercambio corto ya leído
upChat.run({
  jid: DEMO_JIDS[2],
  phone: "600990003",
  name: "María Fernández",
  ts: now - 86400,
  preview: "Muchas gracias, lo miro y os digo",
  opened: now,
  now,
});
msg(DEMO_JIDS[2], 1, 90000, "text", "Hola María, te dejo el enlace para reservar tu cita cuando quieras 😊");
msg(DEMO_JIDS[2], 0, 86400, "text", "Muchas gracias, lo miro y os digo");

// Chat 4 — número internacional (sin +34), para ver el caso "no español"
upChat.run({
  jid: DEMO_JIDS[3],
  phone: null,
  name: "Sofia (Andorra)",
  ts: now - 172800,
  preview: "Ok!",
  opened: now,
  now,
});
msg(DEMO_JIDS[3], 0, 172800, "text", "Ok!");

console.log("demo sembrado:", DEMO_JIDS.length, "chats");
process.exit(0);
