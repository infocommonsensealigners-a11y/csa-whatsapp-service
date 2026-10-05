/**
 * LOS VÍNCULOS MANUALES chat ↔ lead SE REENCUENTRAN SOLOS cuando la hoja se mueve.
 *
 * ⚠️ POR QUÉ EXISTE (05-10-2026). `chat_lead_links` ata un chat a un NÚMERO DE
 * FILA del CRM. Los vínculos `auto` se rehacen enteros en cada pasada de
 * `runLeadLinking`; los `manual` NO se tocan nunca (son decisiones de una
 * persona). Así que cuando se borran filas de la hoja —la fusión de duplicados
 * borró 212 ese día— todo lo de debajo sube y un vínculo manual pasa a señalar a
 * la persona de la fila de al lado, en silencio: la ficha de un desconocido
 * enseña la conversación, y `analyzeChat` rotula el chat con su nombre.
 *
 * Lo que sí viaja con el vínculo es la INSTANTÁNEA del lead con el que se casó
 * (`phone_snapshot`, `lead_name_snapshot`: se guardan al vincular). Con ella se
 * puede comprobar si la fila sigue siendo esa persona y, si no, buscar dónde
 * está hoy. Eso es lo que hace esto, en cada pasada y sin que nadie lo pida.
 *
 * LA REGLA (la misma de `linkLeads.ts`): un enlace equivocado es PEOR que
 * ninguno. Un vínculo solo se MUEVE cuando la instantánea ya no casa con su fila
 * Y casa con UNA sola fila de hoy. Si hay duda —dos candidatos, o ninguna
 * instantánea— no se toca y se cuenta para revisarlo a mano.
 *
 * No envía nada ni toca WhatsApp: solo SQLite local.
 */
import type Database from "better-sqlite3";
import { normName, phoneKey, type DatasetLead } from "./linkLeads";

export type VeredictoVinculo =
  | "bien" // la fila sigue siendo la persona de la instantánea
  | "mover" // la persona está hoy en otra fila, y solo en una
  | "revisar" // no se puede decidir: se deja como está
  | "sin-instantanea"; // vínculo antiguo, sin nombre ni teléfono guardados: no hay con qué comprobarlo

export interface JuicioVinculo {
  jid: string;
  /** La fila que tiene el vínculo. */
  de: number;
  /** La fila a la que va (solo en `mover`). */
  a: number | null;
  veredicto: VeredictoVinculo;
  porque: string;
  /** El nombre guardado con el vínculo (para enseñarlo en la revisión). */
  nombre: string | null;
}

export interface ResultadoVinculos {
  total: number;
  bien: number;
  movidos: number;
  revisar: number;
  sinInstantanea: number;
  /** Vínculos a los que se ha completado la instantánea (les faltaba el nombre o el teléfono). */
  completados: number;
  /** `true` = no se ha escrito nada (se pidió solo medir, o la foto del CRM venía rota). */
  dryRun: boolean;
  juicios: JuicioVinculo[];
  /** Los que se han movido de verdad: la copia en `chat_intel.source_row` hay que moverla también. */
  movedPairs: { jid: string; de: number; a: number }[];
}

export interface OpcionesVinculos {
  /** `false` = solo medir. */
  aplicar: boolean;
  /**
   * REPARACIÓN PUNTUAL de los vínculos SIN instantánea: «fila de antes → fila de
   * hoy», reconstruido fuera (el dashboard lo saca de las fotos de la fusión,
   * `scripts/repara-filas-tras-fusion.ts --mapa-json`). Solo se aplica a los
   * vínculos que no se han tocado desde `antesDe` (epoch s): los posteriores ya
   * nacieron con la fila nueva.
   */
  mapa?: ReadonlyMap<number, number>;
  antesDe?: number;
}

/** Por debajo de esto la foto del CRM viene rota (misma barrera que el directorio de `runLeadLinking`). */
const MIN_LEADS = 100;

interface FilaVinculo {
  id: number;
  chat_jid: string;
  source_row: number;
  phone_snapshot: string | null;
  lead_name_snapshot: string | null;
  updated_at: number;
}

/**
 * Comprueba TODOS los vínculos manuales activos contra los leads de hoy y, con
 * `aplicar`, mueve los que se han quedado en la fila de otra persona.
 * PURA respecto a la red: recibe la BD ya abierta y los leads ya traídos.
 */
export function reapuntarVinculosManuales(db: Database.Database, leads: readonly DatasetLead[], opts: OpcionesVinculos): ResultadoVinculos {
  const now = Math.floor(Date.now() / 1000);
  const vinculos = db
    .prepare(
      `SELECT id, chat_jid, source_row, phone_snapshot, lead_name_snapshot, updated_at
         FROM chat_lead_links WHERE method='manual' AND status='active' ORDER BY id`,
    )
    .all() as FilaVinculo[];

  const out: ResultadoVinculos = {
    total: vinculos.length,
    bien: 0,
    movidos: 0,
    revisar: 0,
    sinInstantanea: 0,
    completados: 0,
    dryRun: !opts.aplicar,
    juicios: [],
    movedPairs: [],
  };
  if (vinculos.length === 0) return out;
  if (leads.length < MIN_LEADS) {
    // Con media hoja no se decide dónde está nadie: «no lo encuentro» movería vínculos buenos.
    out.dryRun = true;
    out.revisar = vinculos.length;
    out.juicios = vinculos.map((v) => ({ jid: v.chat_jid, de: v.source_row, a: null, veredicto: "revisar", porque: "la foto del CRM viene incompleta", nombre: v.lead_name_snapshot }));
    return out;
  }

  /* Índices de los leads de HOY. Un lead fusionado trae varios teléfonos (`telefonosAlt`). */
  const porFila = new Map<number, { nombre: string; claves: Set<string>; principal: string | null }>();
  const porTelefono = new Map<string, number[]>();
  const porNombre = new Map<string, number[]>();
  for (const l of leads) {
    const claves = new Set<string>();
    for (const raw of [l.telefono, ...(l.telefonosAlt ?? []).map((t) => t?.telefono)]) {
      const k = phoneKey(raw);
      if (k) claves.add(k);
    }
    const nombre = (l.nombre ?? "").trim();
    porFila.set(l.sourceRow, { nombre, claves, principal: claves.values().next().value ?? null });
    for (const k of claves) (porTelefono.get(k) ?? porTelefono.set(k, []).get(k)!).push(l.sourceRow);
    const n = normName(nombre);
    if (n) (porNombre.get(n) ?? porNombre.set(n, []).get(n)!).push(l.sourceRow);
  }

  const juzgar = (v: FilaVinculo): JuicioVinculo => {
    const base = { jid: v.chat_jid, de: v.source_row, nombre: v.lead_name_snapshot };
    const tel = phoneKey(v.phone_snapshot);
    const nombre = normName(v.lead_name_snapshot);
    const ahi = porFila.get(v.source_row);

    if (!tel && !nombre) {
      // Vínculo de antes de que se guardara la instantánea: solo el mapa de fuera puede decir algo.
      const destino = opts.mapa && (opts.antesDe == null || v.updated_at < opts.antesDe) ? opts.mapa.get(v.source_row) : undefined;
      if (destino != null && destino !== v.source_row && porFila.has(destino)) {
        return { ...base, a: destino, veredicto: "mover", porque: "sin instantánea: por el mapa de filas de la fusión" };
      }
      return { ...base, a: null, veredicto: "sin-instantanea", porque: "vínculo sin nombre ni teléfono guardados: no se puede comprobar" };
    }

    const casaTel = !!tel && !!ahi && ahi.claves.has(tel);
    const casaNombre = !!nombre && !!ahi && normName(ahi.nombre) === nombre;
    if (casaTel) return { ...base, a: null, veredicto: "bien", porque: "la fila tiene el teléfono guardado" };

    if (tel) {
      const filas = porTelefono.get(tel) ?? [];
      if (filas.length === 1) return { ...base, a: filas[0], veredicto: "mover", porque: "el teléfono guardado está hoy en otra fila" };
      if (filas.length > 1) {
        // Teléfono repetido en la hoja: desempata el nombre guardado, si señala a una sola.
        const conNombre = nombre ? filas.filter((f) => normName(porFila.get(f)?.nombre) === nombre) : [];
        if (conNombre.length === 1) return { ...base, a: conNombre[0], veredicto: "mover", porque: "el teléfono está en varias filas; el nombre guardado señala una" };
        return { ...base, a: null, veredicto: "revisar", porque: `el teléfono guardado está hoy en ${filas.length} filas` };
      }
      // El teléfono ya no está en la hoja (se corrigió a mano): queda el nombre.
    }

    if (casaNombre) return { ...base, a: null, veredicto: "bien", porque: tel ? "el teléfono ya no está en la hoja, pero la fila conserva el nombre" : "la fila conserva el nombre guardado" };
    // Solo un nombre COMPLETO identifica a alguien; un nombre de pila, no (caso «Ramon», ver linkLeads.ts).
    if (nombre.includes(" ")) {
      const filas = porNombre.get(nombre) ?? [];
      if (filas.length === 1) return { ...base, a: filas[0], veredicto: "mover", porque: "el nombre completo guardado está hoy en otra fila" };
      if (filas.length > 1) return { ...base, a: null, veredicto: "revisar", porque: `el nombre guardado está hoy en ${filas.length} filas` };
    }
    return { ...base, a: null, veredicto: "revisar", porque: "ni el teléfono ni el nombre guardados aparecen hoy en el CRM" };
  };

  const mover = db.prepare("UPDATE chat_lead_links SET source_row=@a, phone_snapshot=@phone, lead_name_snapshot=@name, updated_at=@now WHERE id=@id");
  const yaHay = db.prepare("SELECT id FROM chat_lead_links WHERE chat_jid=? AND source_row=?");
  const subir = db.prepare(
    "UPDATE chat_lead_links SET method='manual', status='active', phone_snapshot=@phone, lead_name_snapshot=@name, updated_at=@now WHERE id=@id",
  );
  // El viejo se retira como `auto`: si de verdad casara otra vez con esa fila, el emparejador puede reactivarlo.
  const retirar = db.prepare("UPDATE chat_lead_links SET method='auto', status='removed', updated_at=@now WHERE id=@id");
  const completar = db.prepare(
    "UPDATE chat_lead_links SET phone_snapshot=COALESCE(phone_snapshot,@phone), lead_name_snapshot=COALESCE(lead_name_snapshot,@name) WHERE id=@id",
  );

  const tx = db.transaction(() => {
    for (const v of vinculos) {
      const j = juzgar(v);
      out.juicios.push(j);
      if (j.veredicto === "bien") {
        out.bien++;
        // Se completa lo que le falte a la instantánea AHORA que se sabe que la fila es la buena:
        // la próxima vez que la hoja se mueva habrá dos datos para reencontrarla, no uno.
        const ahi = porFila.get(v.source_row);
        const falta = (!v.phone_snapshot && ahi?.principal) || (!v.lead_name_snapshot && ahi?.nombre);
        if (opts.aplicar && falta) {
          completar.run({ id: v.id, phone: ahi?.principal ?? null, name: ahi?.nombre || null });
          out.completados++;
        }
        continue;
      }
      if (j.veredicto === "revisar") out.revisar++;
      else if (j.veredicto === "sin-instantanea") out.sinInstantanea++;
      if (j.veredicto !== "mover" || j.a == null) continue;
      out.movidos++;
      if (!opts.aplicar) continue;
      const destino = porFila.get(j.a);
      const datos = { phone: v.phone_snapshot ?? destino?.principal ?? null, name: v.lead_name_snapshot ?? (destino?.nombre || null), now };
      // (chat, fila) es único: si el emparejador ya había creado el par de destino, se asciende ese y se retira el viejo.
      const existente = yaHay.get(v.chat_jid, j.a) as { id: number } | undefined;
      if (existente) {
        subir.run({ ...datos, id: existente.id });
        retirar.run({ id: v.id, now });
      } else {
        mover.run({ ...datos, id: v.id, a: j.a });
      }
      out.movedPairs.push({ jid: v.chat_jid, de: v.source_row, a: j.a });
    }
  });
  tx();
  return out;
}

/* -------------------------------------------------------------------------- */
/* La copia en chat_intel                                                     */
/* -------------------------------------------------------------------------- */

export interface CambioIntel {
  jid: string;
  /** Lo que tiene hoy `chat_intel.source_row`. */
  de: number | null;
  /** Lo que debería tener según `chat_lead_links`. */
  a: number | null;
}

/**
 * QUÉ HABRÍA QUE CAMBIAR en `chat_intel.source_row` para que diga lo mismo que
 * `chat_lead_links`, que es quien manda (la columna de Supabase es una COPIA que
 * solo `analyzeChat` reescribe, y solo cuando ese chat se vuelve a analizar).
 *
 * Medido el 05-10-2026: de 1.145 filas de `chat_intel` con fila, 1.104 señalaban
 * una fila que no era la del lead — la mayoría desde julio, de borrados
 * anteriores. La ficha casa primero por teléfono y por eso no se veía, pero el
 * respaldo por fila (`/intel/by-lead/:fila`, Fransua) leía a otra persona.
 *
 * El vínculo que cuenta es el mismo que elige `analyzeChat`: el manual si lo
 * hay y, si no, el más antiguo. Un chat `@lid` ya fundido en el de su teléfono
 * (`alias_of`) hereda el vínculo de ese. Solo se tocan chats que EXISTEN en la
 * base local: de un jid que aquí no se conoce (importaciones antiguas) no se
 * sabe nada, y no se le quita la fila.
 *
 * PURA: no lee ni escribe en Supabase.
 */
export function planIntelDesdeVinculos(db: Database.Database, intel: readonly { jid: string; source_row: number | null }[]): CambioIntel[] {
  const chats = new Map<string, string | null>();
  for (const c of db.prepare("SELECT jid, alias_of FROM chats").all() as { jid: string; alias_of: string | null }[]) chats.set(c.jid, c.alias_of);
  const vinculo = new Map<string, number>();
  const filas = db
    .prepare("SELECT chat_jid, source_row FROM chat_lead_links WHERE status='active' ORDER BY chat_jid, method='manual' DESC, id ASC")
    .all() as { chat_jid: string; source_row: number }[];
  for (const f of filas) if (!vinculo.has(f.chat_jid)) vinculo.set(f.chat_jid, f.source_row);

  const cambios: CambioIntel[] = [];
  for (const r of intel) {
    if (!chats.has(r.jid)) continue;
    const alias = chats.get(r.jid) ?? null;
    const debe = vinculo.get(r.jid) ?? (alias ? vinculo.get(alias) : undefined) ?? null;
    const tiene = r.source_row ?? null;
    if (debe !== tiene) cambios.push({ jid: r.jid, de: tiene, a: debe });
  }
  return cambios;
}
