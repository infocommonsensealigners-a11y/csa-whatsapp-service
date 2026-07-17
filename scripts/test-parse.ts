/** Test rápido del parser de exportaciones (Android + iOS). */
import { parseWhatsappExport } from "../src/import/parseExport";

const android = `5/1/2025, 17:23 - Los mensajes están cifrados de extremo a extremo.
5/1/2025, 17:23 - Laura Gómez: Hola, vi vuestro anuncio de alineadores
5/1/2025, 17:25 - Common Sense Aligners: ¡Hola Laura! Gracias por escribir 🙌
Te cuento: la primera valoración es gratuita
6/1/2025, 9:01 - Laura Gómez: <Multimedia omitido>
6/1/2025, 9:02 - Laura Gómez: ¿Cuánto cuesta?`;

const ios = `[5/1/25, 17:23:45] Laura Gómez: Hola desde iPhone
[5/1/25, 17:24:10] Common Sense Aligners: ¡Hola! IMG-20250105.jpg (archivo adjunto)
[6/1/25, 9:01:00] Laura Gómez: mensaje de voz omitido`;

for (const [label, content, me] of [
  ["ANDROID", android, "Common Sense Aligners"],
  ["iOS", ios, "Common Sense Aligners"],
] as const) {
  const r = parseWhatsappExport(content, me);
  console.log(`\n=== ${label} === msgs=${r.messages.length} system=${r.skippedSystem} senders=${r.senders.join(", ")}`);
  for (const m of r.messages) {
    const when = new Date(m.ts * 1000).toISOString().slice(0, 16).replace("T", " ");
    console.log(`  ${when} ${m.fromMe ? "→YO" : "←" + m.sender} [${m.type}] ${JSON.stringify(m.text)}`);
  }
}
