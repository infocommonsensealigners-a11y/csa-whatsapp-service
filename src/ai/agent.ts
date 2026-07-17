/**
 * Capa IA sobre el Claude Agent SDK, usando la SUSCRIPCIÓN de Claude Code
 * (sin ANTHROPIC_API_KEY). Solo texto: allowedTools vacío, un turno.
 * Validado en scripts/test-agent-sdk.ts.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config";

/** Ejecuta un prompt de un turno y devuelve el texto final del modelo. */
export async function runText(prompt: string, model?: string): Promise<string> {
  const q = query({
    prompt,
    options: {
      allowedTools: [],
      maxTurns: 1,
      settingSources: [],
      ...(model ? { model } : {}),
    },
  });

  let resultText = "";
  let assistantText = "";
  for await (const msg of q as AsyncIterable<any>) {
    if (msg.type === "assistant") {
      for (const block of msg.message?.content ?? []) {
        if (block.type === "text") assistantText += block.text;
      }
    } else if (msg.type === "result") {
      resultText = msg.result ?? "";
    }
  }
  return (resultText || assistantText).trim();
}

/** Extrae el primer objeto JSON de un texto (tolera ```json y prosa alrededor). */
function extractJson(text: string): any | null {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Como runText pero fuerza JSON: si el primer intento no parsea, reintenta una
 * vez recordando "solo JSON". Devuelve null si aun así falla.
 */
export async function runJson<T = any>(prompt: string, model?: string): Promise<T | null> {
  const first = await runText(prompt, model);
  const parsed = extractJson(first);
  if (parsed) return parsed as T;

  const retry = await runText(
    prompt + "\n\nIMPORTANTE: responde ÚNICAMENTE con el objeto JSON válido, sin ```, sin texto antes ni después.",
    model,
  );
  return extractJson(retry) as T | null;
}

export const bulkModel = config.aiModelBulk;
export const suggestModel = config.aiModelSuggest;
