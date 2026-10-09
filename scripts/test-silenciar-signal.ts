/** La mordaza de libsignal: nada con claves llega a la consola; lo demás, sí.   npx tsx scripts/test-silenciar-signal.ts */
export {};
const salida: string[] = [];
const orig = process.stdout.write.bind(process.stdout);
const origErr = process.stderr.write.bind(process.stderr);
(process.stdout as unknown as { write: unknown }).write = (c: string) => { salida.push(String(c)); return true; };
(process.stderr as unknown as { write: unknown }).write = (c: string) => { salida.push(String(c)); return true; };
const { contadoresSignal } = await import("../src/wa/silenciarSignal");
console.info("Closing session:", { currentRatchet: { ephemeralKeyPair: { privKey: Buffer.from("SECRETO") } } });
console.error("Session error:Error: Bad MAC", "stack");
console.error("Failed to decrypt message with any known session...");
console.log("[ingest] normal");
console.warn({ objeto: true });
(process.stdout as unknown as { write: unknown }).write = orig;
(process.stderr as unknown as { write: unknown }).write = origErr;
const todo = salida.join("");
const c = contadoresSignal();
const ok = !todo.includes("SECRETO") && !todo.includes("privKey") && todo.includes("[ingest] normal") && todo.includes("objeto")
  && c.sesion_cerrada === 1 && c.error_sesion === 1 && c.descifrado_fallido === 1;
console.log(ok ? "✓ mordaza OK" : `✗ mordaza: ${JSON.stringify({ todo, c })}`);
process.exit(ok ? 0 : 1);
