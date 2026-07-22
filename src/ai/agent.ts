/**
 * Capa IA sobre el Claude Agent SDK, usando la SUSCRIPCIÓN de Claude Code
 * (sin ANTHROPIC_API_KEY). Solo texto: allowedTools vacío, un turno.
 * Validado en scripts/test-agent-sdk.ts.
 *
 * CONSUMO: cada llamada real registra sus tokens/coste-equivalente (kind
 * ai_usage) — es el ÚNICO punto que habla con Claude, así que esto captura
 * el consumo de Fransua al completo. Además, aprovechando la MISMA sesión ya
 * abierta (nunca gastando una consulta aparte), se pide de vez en cuando el
 * estado de la cuenta (ventanas 5h/7d de claude.ai) vía la API experimental
 * del SDK — acotado a como mucho 1 vez cada 15 min (ver brain/usage.ts).
 * Ninguno de los dos bloquea ni puede romper la respuesta real a Fran.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config";
import { ensureClaudeAuth } from "../brain/secrets";
import { logUsage, logAccountSnapshot } from "../brain/usage";

const ACCOUNT_SNAPSHOT_MIN_INTERVAL_MS = 15 * 60_000;
let lastAccountSnapshotAt = 0;

/** Ejecuta un prompt de un turno y devuelve el texto final del modelo. */
export async function runText(prompt: string, model?: string): Promise<string> {
  // Asegura la credencial de Claude (token de suscripción desde Supabase si no
  // está en el entorno) ANTES de lanzar el query: el subproceso del SDK hereda
  // process.env al arrancar. Sin credencial, el SDK fallará y el llamante lo
  // gestiona (la nota se guarda igual, aiAvailable:false).
  await ensureClaudeAuth();
  const q = query({
    prompt,
    options: {
      allowedTools: [],
      maxTurns: 1,
      settingSources: [],
      ...(model ? { model } : {}),
    },
  });

  // El snapshot de cuenta hay que PEDIRLO YA (concurrente con el consumo del
  // turno): el transporte del SDK se cierra en cuanto el for-await termina —
  // pedirlo después llega tarde ("ProcessTransport is not ready for writing").
  let accountSnapshotPromise: Promise<any> | null = null;
  if (Date.now() - lastAccountSnapshotAt > ACCOUNT_SNAPSHOT_MIN_INTERVAL_MS) {
    lastAccountSnapshotAt = Date.now();
    const anyQ = q as any;
    if (typeof anyQ.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET === "function") {
      accountSnapshotPromise = anyQ.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET().catch(() => null);
    }
  }

  let resultText = "";
  let assistantText = "";
  for await (const msg of q as AsyncIterable<any>) {
    if (msg.type === "assistant") {
      for (const block of msg.message?.content ?? []) {
        if (block.type === "text") assistantText += block.text;
      }
    } else if (msg.type === "result") {
      resultText = msg.result ?? "";
      const u = msg.usage;
      if (u) {
        void logUsage({
          at: new Date().toISOString(),
          model: model ?? null,
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          costUsd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : 0,
        });
      }
    }
  }

  if (accountSnapshotPromise) {
    void accountSnapshotPromise.then((u) => {
      if (!u) return;
      void logAccountSnapshot({
        capturedAt: new Date().toISOString(),
        subscriptionType: u.subscription_type ?? null,
        rateLimitsAvailable: !!u.rate_limits_available,
        fiveHour: u.rate_limits?.five_hour
          ? { utilization: u.rate_limits.five_hour.utilization ?? null, resetsAt: u.rate_limits.five_hour.resets_at ?? null }
          : null,
        sevenDay: u.rate_limits?.seven_day
          ? { utilization: u.rate_limits.seven_day.utilization ?? null, resetsAt: u.rate_limits.seven_day.resets_at ?? null }
          : null,
      });
    });
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
