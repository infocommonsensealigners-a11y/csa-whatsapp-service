/**
 * Consumo de IA de Fransua — tokens/coste-equivalente por llamada (SOLO
 * Fransua: todo pasa por ai/agent.ts, el único punto que habla con Claude) +
 * un snapshot aparte del ESTADO DE LA CUENTA (ventanas de 5h/7 días de
 * claude.ai, vía la API experimental del Agent SDK). OJO: ese snapshot es
 * de TODA la cuenta — si el mismo login de Claude se usa fuera de Fransua,
 * no se puede aislar solo a Fransua (por eso van en dos tablas separadas).
 *
 * Reutiliza fransua_log (kind='ai_usage' | 'ai_account_usage'), sin
 * migración de esquema — mismo patrón que el resto del cerebro.
 */
import { getSupabase } from "./supabase";

export interface UsageEvent {
  at: string; // ISO
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

/** Nunca debe romper la respuesta de Fransua: fire-and-forget, con su propio try/catch. */
export async function logUsage(e: UsageEvent): Promise<void> {
  try {
    const sb = getSupabase();
    await sb.from("fransua_log").insert({ kind: "ai_usage", payload: e });
  } catch {
    /* el registro de consumo nunca debe tumbar una respuesta real */
  }
}

export interface RateWindow {
  utilization: number | null; // 0-100
  resetsAt: string | null;
}

export interface AccountSnapshot {
  capturedAt: string;
  subscriptionType: string | null;
  rateLimitsAvailable: boolean;
  fiveHour: RateWindow | null;
  sevenDay: RateWindow | null;
}

export async function logAccountSnapshot(s: AccountSnapshot): Promise<void> {
  try {
    const sb = getSupabase();
    await sb.from("fransua_log").insert({ kind: "ai_account_usage", payload: s });
  } catch {
    /* experimental — nunca debe tumbar nada */
  }
}

export async function latestAccountSnapshot(): Promise<AccountSnapshot | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("fransua_log")
    .select("payload,created_at")
    .eq("kind", "ai_account_usage")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? (data.payload as AccountSnapshot) : null;
}

/** Fecha YYYY-MM-DD en hora de España — el "día" del usuario, no la del
 * servidor (Railway corre en UTC). */
export function madridDateKey(d: Date | string = new Date()): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(date);
}

export interface DailyUsage {
  date: string; // YYYY-MM-DD (Europe/Madrid)
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUsd: number;
  calls: number;
}

/** Agrega los eventos de consumo de los últimos `days` días, por día (Madrid). */
export async function dailyUsage(days = 30): Promise<DailyUsage[]> {
  const sb = getSupabase();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data, error } = await sb
    .from("fransua_log")
    .select("payload,created_at")
    .eq("kind", "ai_usage")
    .gte("created_at", since)
    .order("created_at", { ascending: true })
    .limit(20000);
  if (error) throw new Error(error.message);

  const byDate = new Map<string, DailyUsage>();
  for (const row of (data ?? []) as Array<{ payload: UsageEvent; created_at: string }>) {
    const key = madridDateKey(row.created_at);
    const p = row.payload;
    const cur =
      byDate.get(key) ??
      ({ date: key, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0, costUsd: 0, calls: 0 } as DailyUsage);
    cur.inputTokens += p.inputTokens ?? 0;
    cur.outputTokens += p.outputTokens ?? 0;
    cur.cacheCreationTokens += p.cacheCreationTokens ?? 0;
    cur.cacheReadTokens += p.cacheReadTokens ?? 0;
    cur.totalTokens += (p.inputTokens ?? 0) + (p.outputTokens ?? 0) + (p.cacheCreationTokens ?? 0) + (p.cacheReadTokens ?? 0);
    cur.costUsd += p.costUsd ?? 0;
    cur.calls += 1;
    byDate.set(key, cur);
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}
