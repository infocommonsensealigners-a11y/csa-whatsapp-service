/**
 * Prueba de humo del Claude Agent SDK con la SUSCRIPCIÓN de Claude Code
 * (sin API key). Si esto responde, la capa IA de Fransua es viable.
 * Uso: npx tsx scripts/test-agent-sdk.ts [modelo]
 */
import { query } from "@anthropic-ai/claude-agent-sdk";

const model = process.argv[2]; // p.ej. "haiku" | "sonnet"; sin arg = por defecto

async function main() {
  console.log(`[test] modelo=${model ?? "(por defecto)"}  API key en entorno=${process.env.ANTHROPIC_API_KEY ? "SÍ" : "no"}`);
  const q = query({
    prompt:
      "Eres un clasificador. Responde EXCLUSIVAMENTE con la palabra OPERATIVO, sin puntuación ni nada más.",
    options: {
      allowedTools: [],
      maxTurns: 1,
      settingSources: [],
      ...(model ? { model } : {}),
    },
  });

  let assistantText = "";
  let resultText: string | null = null;
  for await (const msg of q) {
    if (msg.type === "assistant") {
      for (const block of msg.message.content) {
        if (block.type === "text") assistantText += block.text;
      }
    } else if (msg.type === "result") {
      resultText = (msg as { result?: string }).result ?? null;
      console.log(`[test] result subtype=${(msg as { subtype?: string }).subtype}`);
    }
  }
  console.log(`[test] assistant='${assistantText.trim()}'`);
  console.log(`[test] result='${(resultText ?? "").trim()}'`);
  console.log(assistantText.includes("OPERATIVO") || (resultText ?? "").includes("OPERATIVO")
    ? "✓ AGENT SDK OPERATIVO con la suscripción"
    : "⚠ respondió, pero sin la palabra esperada (revisar)");
}

main().catch((e) => {
  console.error("[test] ERROR:", (e as Error).message);
  process.exit(1);
});
