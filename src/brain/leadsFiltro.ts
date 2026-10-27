/**
 * LEADS DEL CRM FILTRADOS POR ORIGEN / ESTADO / PRODUCTO / FECHA (27-10-2026).
 *
 * Mismo patrón que `origenCampana.ts`: el dato vive en el dashboard, que filtra
 * con el MISMO motor que la tabla del CRM (orígenes múltiples, reentradas,
 * fecha + origen en la misma entrada). Aquí no se filtra nada: se pide con el
 * token interno y se sirve. Antes Fransua solo sabía filtrar por estado porque
 * el directorio del sidecar no tiene ni origen ni fecha.
 */

import { config } from "../config";

export interface LeadsFiltroParams {
  origen?: string;
  excluir_origen?: string;
  estado?: string;
  excluir_estado?: string;
  producto?: string;
  desde?: string;
  hasta?: string;
  texto?: string;
}

export interface LeadsFiltroRespuesta {
  ok: boolean;
  error?: string;
  total?: number;
  totalCrm?: number;
  aplicado?: { origenes: string[]; estados: string[]; productos: string[]; fecha: { from?: string; to?: string } | null; texto: string };
  sinCoincidencia?: string[];
  porOrigen?: Record<string, number>;
  porEstado?: Record<string, number>;
  muestra?: Array<{ fila: number; nombre: string; telefono: string; estado: string; producto: string; origen: string; fecha: string | null; reentrada: boolean }>;
  csvUrl?: string;
}

export async function getLeadsFiltrados(p: LeadsFiltroParams): Promise<LeadsFiltroRespuesta | null> {
  const token = process.env.FRANSUA_INTERNAL_TOKEN;
  if (!token) return null;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (typeof v === "string" && v.trim()) qs.set(k, v.trim());
  try {
    const res = await fetch(`${config.dashboardUrl}/api/fransua/leads-filtro?${qs.toString()}`, {
      headers: { "x-fransua-token": token },
      signal: AbortSignal.timeout(25_000),
    });
    const j = (await res.json()) as LeadsFiltroRespuesta;
    return j && typeof j.ok === "boolean" ? j : null;
  } catch {
    return null;
  }
}
