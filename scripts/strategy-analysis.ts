/**
 * ESQUELETO del análisis de estrategia comercial (data-driven).
 *
 * Cruza la inteligencia de las conversaciones (chat_intel en Supabase) con el
 * RESULTADO en el CRM (estado del lead en lead_directory local) para aprender
 * QUÉ hace que un lead acabe en "Compra" vs se descarte/enfríe. De aquí saldrá
 * la política de recordatorios y el rediseño de Seguimiento — NO se inventan
 * reglas, se derivan de estos números.
 *
 * Ventana de estrategia: abril 2025+ (inicio de Fran). Reanudable: se puede
 * re-ejecutar cuando el run de asimilación termine para tener el cuadro completo.
 *
 * Uso: npx tsx --env-file=.env scripts/strategy-analysis.ts
 */
import Database from "better-sqlite3";
import { config } from "../src/config";
import { getSupabase } from "../src/brain/supabase";

const STRATEGY_SINCE = "2025-04-01";
const sinceTs = Math.floor(new Date(STRATEGY_SINCE + "T00:00:00Z").getTime() / 1000);
const nowSec = Math.floor(Date.now() / 1000);

type Row = {
  jid: string; source_row: number | null; producto: string | null; temperatura: string | null;
  etiquetas: string[] | null; intereses: Array<{ label?: string }> | null; intervalos: any;
  msg_count: number; from_me_count: number; last_ts: number;
};

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
const human = (s: number | null) => (s == null ? "—" : s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}min` : s < 172800 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`);
const top = (m: Map<string, number>, n: number) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} (${v})`);
const pct = (n: number, total: number) => (total ? Math.round((100 * n) / total) : 0);

/** estado del CRM → bucket de resultado. */
function outcome(estado: string | null): "ganado" | "descartado" | "en_curso" | "sin_lead" {
  if (!estado) return "sin_lead";
  const e = estado.toLowerCase();
  if (e.includes("compra") || e.includes("matricul") || e.includes("inscrit") || e.includes("alumno")) return "ganado";
  if (e.includes("no cualifica") || e.includes("descart") || e.includes("perdid")) return "descartado";
  return "en_curso";
}

// ── datos ────────────────────────────────────────────────────────────────────
const sb = getSupabase();
const { data, error } = await sb
  .from("chat_intel")
  .select("jid,source_row,producto,temperatura,etiquetas,intereses,intervalos,msg_count,from_me_count,last_ts")
  .gte("last_ts", sinceTs)
  .limit(5000);
if (error) { console.error(error); process.exit(1); }
const rows = (data ?? []) as Row[];

const db = new Database(config.dbPath, { readonly: true });
const estadoStmt = db.prepare("SELECT estado FROM lead_directory WHERE source_row = ?");
const estadoOf = (sr: number | null): string | null => (sr == null ? null : ((estadoStmt.get(sr) as { estado: string } | undefined)?.estado ?? null));

// distribución cruda de estados (para entender el mapeo)
const estadoDist = new Map<string, number>();
for (const r of rows) { const e = estadoOf(r.source_row) ?? "(sin lead vinculado)"; estadoDist.set(e, (estadoDist.get(e) ?? 0) + 1); }

// ── buckets por resultado ──────────────────────────────────────────────────
const buckets = new Map<string, Row[]>();
for (const r of rows) { const b = outcome(estadoOf(r.source_row)); (buckets.get(b) ?? buckets.set(b, []).get(b)!).push(r); }

function summarize(name: string, rs: Row[]) {
  const n = rs.length;
  const temp: Record<string, number> = { caliente: 0, templado: 0, frio: 0, sin: 0 };
  const agent: number[] = [], lead: number[] = [], sil: number[] = [], msgs: number[] = [], fromMe: number[] = [];
  const etq = new Map<string, number>(), intr = new Map<string, number>(), prod = new Map<string, number>();
  for (const r of rs) {
    temp[r.temperatura ?? "sin"] = (temp[r.temperatura ?? "sin"] ?? 0) + 1;
    if (r.intervalos?.respuesta_agente_mediana_s != null) agent.push(r.intervalos.respuesta_agente_mediana_s);
    if (r.intervalos?.respuesta_lead_mediana_s != null) lead.push(r.intervalos.respuesta_lead_mediana_s);
    sil.push(Math.round((nowSec - r.last_ts) / 86400));
    msgs.push(r.msg_count);
    if (r.msg_count) fromMe.push(Math.round((100 * (r.from_me_count ?? 0)) / r.msg_count));
    for (const t of r.etiquetas ?? []) etq.set(t, (etq.get(t) ?? 0) + 1);
    for (const it of r.intereses ?? []) { const l = it?.label; if (l) intr.set(l, (intr.get(l) ?? 0) + 1); }
    if (r.producto) prod.set(r.producto, (prod.get(r.producto) ?? 0) + 1);
  }
  return { name, n, temp, medAgent: median(agent), medLead: median(lead), medSil: median(sil), avgMsgs: avg(msgs), avgFromMe: avg(fromMe), etq, intr, prod };
}

// ── informe ─────────────────────────────────────────────────────────────────
console.log(`\n════════════════════════════════════════════════════════════`);
console.log(`ANÁLISIS DE ESTRATEGIA — ventana ${STRATEGY_SINCE}+  ·  ${rows.length} conversaciones asimiladas`);
console.log(`(PRELIMINAR: el run de asimilación puede estar en curso; re-ejecutar al terminar)`);
console.log(`════════════════════════════════════════════════════════════`);

console.log(`\n▸ Resultado en el CRM (bucket):`);
for (const [b, rs] of [...buckets.entries()].sort((a, b2) => b2[1].length - a[1].length)) {
  console.log(`   ${b.padEnd(12)} ${rs.length} (${pct(rs.length, rows.length)}%)`);
}
console.log(`\n▸ Top estados crudos vinculados:`);
for (const e of top(estadoDist, 10)) console.log(`   ${e}`);

const order = ["ganado", "en_curso", "descartado", "sin_lead"];
for (const b of order) {
  const rs = buckets.get(b);
  if (!rs || !rs.length) continue;
  const s = summarize(b, rs);
  console.log(`\n──────────── ${b.toUpperCase()} · ${s.n} conversaciones ────────────`);
  console.log(`  Temperatura:  🔥${s.temp.caliente} (${pct(s.temp.caliente, s.n)}%)  ☀️${s.temp.templado} (${pct(s.temp.templado, s.n)}%)  ❄️${s.temp.frio} (${pct(s.temp.frio, s.n)}%)`);
  console.log(`  Respuesta Fran (mediana):  ${human(s.medAgent)}    ·  Respuesta lead:  ${human(s.medLead)}`);
  console.log(`  Mensajes/chat (media):     ${s.avgMsgs}            ·  % enviados por Fran:  ${s.avgFromMe}%`);
  console.log(`  Silencio actual (mediana): ${s.medSil}d`);
  console.log(`  Etiquetas top:   ${top(s.etq, 6).join(" · ") || "—"}`);
  console.log(`  Intereses top:   ${top(s.intr, 5).join(" · ") || "—"}`);
  console.log(`  Productos:       ${top(s.prod, 5).join(" · ") || "—"}`);
}

// ── comparativa ganado vs descartado (la señal accionable) ──────────────────
const g = buckets.get("ganado"), d = buckets.get("descartado");
if (g?.length && d?.length) {
  const sg = summarize("g", g), sd = summarize("d", d);
  console.log(`\n════════════ SEÑAL: GANADO vs DESCARTADO ════════════`);
  console.log(`  Respuesta de Fran:   ganado ${human(sg.medAgent)}  vs  descartado ${human(sd.medAgent)}`);
  console.log(`  Mensajes por chat:   ganado ${sg.avgMsgs}  vs  descartado ${sd.avgMsgs}`);
  console.log(`  % caliente:          ganado ${pct(sg.temp.caliente, sg.n)}%  vs  descartado ${pct(sd.temp.caliente, sd.n)}%`);
  console.log(`  Etiquetas ganadoras: ${top(sg.etq, 6).join(" · ")}`);
} else {
  console.log(`\n(aún no hay suficientes 'ganado' y 'descartado' vinculados para comparar — re-ejecutar al avanzar el run)`);
}

db.close();
console.log(`\n(fin — esqueleto v1; al terminar el run tendremos el cuadro completo para definir recordatorios)`);
process.exit(0);
