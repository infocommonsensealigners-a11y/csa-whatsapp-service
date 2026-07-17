/** Borra chats importados de prueba (jid import:*). Uso: npx tsx scripts/clean-imports.ts */
import { openDb } from "../src/db/db";
const db = openDb();
const m = db.prepare("DELETE FROM messages WHERE chat_jid LIKE 'import:%'").run();
const c = db.prepare("DELETE FROM chats WHERE jid LIKE 'import:%'").run();
console.log(`borrados chats=${c.changes} msgs=${m.changes}`);
process.exit(0);
