/**
 * Plan comercial anual de CSA (Certificación de Invisalign / SBA / Estancia
 * clínica) — hitos de marketing por mes + reglas de precio/canal por
 * producto. Es una PLANTILLA RECURRENTE (sin año — "cada septiembre pasa X"),
 * no un calendario de fechas fijas de un año concreto: así Fransua siempre
 * sabe "en qué mes del ciclo estamos" y qué toca, año tras año.
 *
 * Reutiliza `fransua_log` (kind='plan_hito' | 'plan_producto', "la fila más
 * reciente por id gana"; borrar = insertar una fila `{id, deleted:true}`) —
 * SIN migración de esquema, mismo patrón ya usado para `playbook_insights` y
 * los secretos de Fransua.
 */
import { getSupabase } from "./supabase";

export type Producto = "SBA" | "Certificacion" | "Estancia" | "General";
export type TipoHito = "oferta" | "webinar" | "grupal" | "campana" | "nota";

export interface Hito {
  id: string;
  mes: number; // 1-12
  rango?: string | null; // texto libre: "1-15", "10-30", "24"...
  titulo: string;
  descripcion?: string | null;
  producto: Producto;
  tipo: TipoHito;
  responsable?: string | null;
  orden: number;
  deleted?: boolean;
  updatedAt?: string;
}

export interface ReglaProducto {
  producto: "SBA" | "Certificacion" | "Estancia";
  precioBase: number;
  precioTransferencia: number | null;
  canales: string[];
  notas: string | null;
  deleted?: boolean;
  updatedAt?: string;
}

const MESES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];
export function nombreMes(n: number): string {
  return MESES[((n - 1) % 12 + 12) % 12];
}

/** "La fila más reciente por id gana": lee todas las filas de un kind
 * (ordenadas desc por fecha) y se queda con la primera que ve por cada id —
 * que, al venir en orden descendente, es la más reciente. Descarta tombstones. */
async function latestByPayloadId<T extends { id?: string; deleted?: boolean }>(kind: string, limit = 2000): Promise<T[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("fransua_log")
    .select("payload,created_at")
    .eq("kind", kind)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  const byId = new Map<string, T>();
  for (const row of (data ?? []) as Array<{ payload: T }>) {
    const p = row.payload;
    const key = p.id ?? JSON.stringify(p);
    if (!byId.has(key)) byId.set(key, p);
  }
  return [...byId.values()].filter((p) => !p.deleted);
}

export async function listHitos(): Promise<Hito[]> {
  const items = await latestByPayloadId<Hito>("plan_hito");
  return items.sort((a, b) => a.mes - b.mes || a.orden - b.orden);
}

export async function upsertHito(hito: Omit<Hito, "updatedAt" | "deleted">): Promise<Hito> {
  const sb = getSupabase();
  const full: Hito = { ...hito, updatedAt: new Date().toISOString() };
  const { error } = await sb.from("fransua_log").insert({ kind: "plan_hito", payload: full });
  if (error) throw new Error(error.message);
  return full;
}

export async function deleteHito(id: string): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.from("fransua_log").insert({ kind: "plan_hito", payload: { id, deleted: true, updatedAt: new Date().toISOString() } });
  if (error) throw new Error(error.message);
}

export async function listProductos(): Promise<ReglaProducto[]> {
  return latestByPayloadId<ReglaProducto & { id?: string }>("plan_producto").then((rows) =>
    rows.map(({ id: _id, ...r }) => r as ReglaProducto)
  );
}

export async function upsertProducto(regla: Omit<ReglaProducto, "updatedAt" | "deleted">): Promise<ReglaProducto> {
  const sb = getSupabase();
  const full: ReglaProducto = { ...regla, updatedAt: new Date().toISOString() };
  // `id` = producto para que "última fila por id gana" funcione (upsert real).
  const { error } = await sb.from("fransua_log").insert({ kind: "plan_producto", payload: { id: regla.producto, ...full } });
  if (error) throw new Error(error.message);
  return full;
}

/** Contexto temporal: mes actual, hitos activos, próximo hito, reglas de
 * producto — y un bloque de texto listo para incrustar en los prompts de
 * Fransua (chat, notas, briefing). */
export interface PlanContext {
  mesActualNum: number;
  mesActualNombre: string;
  hitosDelMes: Hito[];
  proximoHito: (Hito & { mesesHasta: number }) | null;
  reglas: ReglaProducto[];
  texto: string;
}

export async function getPlanContext(now: Date = new Date()): Promise<PlanContext> {
  const [hitos, reglas] = await Promise.all([listHitos(), listProductos()]);
  const mesActualNum = now.getMonth() + 1;
  const hitosDelMes = hitos.filter((h) => h.mes === mesActualNum);

  let proximoHito: (Hito & { mesesHasta: number }) | null = null;
  for (let delta = 1; delta <= 12; delta++) {
    const mes = ((mesActualNum - 1 + delta) % 12) + 1;
    const candidatos = hitos.filter((h) => h.mes === mes);
    if (candidatos.length) {
      proximoHito = { ...candidatos[0], mesesHasta: delta };
      break;
    }
  }

  const lineasHitos = hitosDelMes.length
    ? hitosDelMes.map((h) => `- ${h.titulo}${h.rango ? ` (${h.rango})` : ""}${h.descripcion ? `: ${h.descripcion}` : ""}`).join("\n")
    : "(sin hitos programados este mes)";
  const lineasReglas = reglas
    .map((r) => {
      const precio = r.precioTransferencia ? `${r.precioBase}€ (${r.precioTransferencia}€ con transferencia)` : `${r.precioBase}€`;
      return `- ${r.producto}: ${precio} · canales: ${r.canales.join(", ") || "—"}${r.notas ? ` · ${r.notas}` : ""}`;
    })
    .join("\n");

  const texto = [
    `=== PLAN COMERCIAL ANUAL DE CSA (mes actual: ${nombreMes(mesActualNum)}) ===`,
    "Hitos de este mes:",
    lineasHitos,
    proximoHito
      ? `Próximo hito: "${proximoHito.titulo}" en ${nombreMes(proximoHito.mes)} (${proximoHito.mesesHasta === 1 ? "el mes que viene" : `dentro de ${proximoHito.mesesHasta} meses`}).`
      : "",
    lineasReglas ? "Reglas de precio/canal por producto:" : "",
    lineasReglas,
  ]
    .filter(Boolean)
    .join("\n");

  return { mesActualNum, mesActualNombre: nombreMes(mesActualNum), hitosDelMes, proximoHito, reglas, texto };
}
