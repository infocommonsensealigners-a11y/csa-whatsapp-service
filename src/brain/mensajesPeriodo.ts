/**
 * LEER WHATSAPP POR FECHAS — la pieza que le faltaba a Fransua para preguntas
 * como «¿qué direcciones hemos recogido por WhatsApp desde ayer?» o «¿quién
 * preguntó por el precio hoy?». Antes contestaba que no podía: solo tenía
 * resúmenes por lead (chat_intel) y búsqueda por tema, no los mensajes de un
 * periodo (10-09-2026).
 *
 * Lee la BD local de mensajes (la fuente autoritativa) y devuelve los mensajes
 * LITERALES del periodo, filtrables, agrupados por conversación. Quien extrae el
 * dato (la dirección, el email, la pregunta) es el propio Fransua a partir de
 * aquí; los filtros solo acotan para que quepa en su turno.
 *
 * Solo lectura. Sin dependencias de WhatsApp: recibe la BD por parámetro, así se
 * puede probar con una BD en memoria.
 */

/** Lo mínimo de better-sqlite3 que se usa (para poder probarlo con una BD en memoria). */
export interface DbLectura {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
}

/* ------------------------------ fechas (Madrid) ----------------------------- */

/** Minutos de desfase de Madrid respecto a UTC en ese instante (+120 en verano, +60 en invierno). */
function desfaseMadridMin(d: Date): number {
  const nombre =
    new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Madrid", timeZoneName: "shortOffset" })
      .formatToParts(d)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT+1";
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(nombre);
  if (!m) return 60;
  const min = Number(m[2]) * 60 + Number(m[3] ?? 0);
  return m[1] === "-" ? -min : min;
}

/** «2026-09-09» → las 00:00 de ese día EN MADRID. */
export function inicioDiaMadrid(ymd: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!m) return null;
  const medianocheUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // El desfase se mira a MEDIODÍA: la madrugada del cambio de hora no lo confunde.
  const off = desfaseMadridMin(new Date(medianocheUtc + 12 * 3_600_000));
  return new Date(medianocheUtc - off * 60_000);
}

/**
 * Rango [desde, hasta) a partir de lo que pasa Fransua. «AAAA-MM-DD» = día de
 * Madrid (en `hasta`, incluye ese día entero); si no, cualquier fecha ISO. Sin
 * `hasta`, hasta ahora.
 */
export function rangoMadrid(
  desde: string,
  hasta?: string | null,
  ahora: Date = new Date(),
): { desde: Date; hasta: Date } | { error: string } {
  const d = inicioDiaMadrid(desde) ?? new Date(desde);
  if (Number.isNaN(d.getTime())) return { error: `No entiendo la fecha de inicio «${desde}». Pásala como AAAA-MM-DD.` };
  let h: Date;
  if (!hasta) h = ahora;
  else {
    const dia = inicioDiaMadrid(hasta);
    h = dia ? new Date(inicioDiaMadrid(siguienteDia(hasta))!.getTime()) : new Date(hasta);
  }
  if (Number.isNaN(h.getTime())) return { error: `No entiendo la fecha de fin «${hasta}». Pásala como AAAA-MM-DD.` };
  if (d.getTime() >= h.getTime()) return { error: "La fecha de inicio tiene que ser anterior a la de fin." };
  return { desde: d, hasta: h };
}

function siguienteDia(ymd: string): string {
  const [y, m, d] = ymd.trim().split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return t.toISOString().slice(0, 10);
}

const FMT_MADRID = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Madrid",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/**
 * «10/09 12:03» en Madrid, a partir de epoch SEGUNDOS. Se arma a partir de las
 * piezas: `toLocaleString("es-ES")` da «9/9, 20:39» o «09/09 20:39» según el ICU
 * de cada máquina.
 */
export function fmtInstante(tsSec: number): string {
  const p = FMT_MADRID.formatToParts(new Date(tsSec * 1000));
  const v = (k: string) => p.find((x) => x.type === k)?.value ?? "??";
  return `${v("day")}/${v("month")} ${v("hour")}:${v("minute")}`;
}

/* ------------------------------- detectores -------------------------------- */

/** Código postal español (01000–52999), como palabra suelta: no casa dentro de un teléfono. */
const RE_CP = /\b(?:0[1-9]|[1-4]\d|5[0-2])\d{3}\b/;
/** Una vía: calle, avenida, plaza… seguida de algo. */
const RE_VIA =
  /(?:^|[\s,(])(?:c\/|c\.|calle|avda\.?|avenida|av\.|plaza|pza\.?|paseo|p[º°]|camino|carretera|ctra\.?|urbanizaci[oó]n|urb\.|ronda|traves[ií]a|glorieta|pol[ií]gono|rambla|carrer|r[uú]a)\s*\S/i;
const RE_EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;

export type DatoBuscado = "direccion" | "email" | "codigo_postal";

/**
 * ¿Parece que el mensaje trae una DIRECCIÓN postal? Generoso a propósito: el
 * filtro solo acota lo que ve Fransua, y es él quien decide si lo es.
 */
export function pareceDireccion(texto: string): boolean {
  const t = texto.trim();
  if (t.length < 8 || t.length > 600) return false;
  const conVia = RE_VIA.test(t) && /\d/.test(t);
  const conCp = RE_CP.test(t) && /[a-záéíóúñ]{3,}/i.test(t) && t.length <= 250;
  return conVia || conCp;
}

export function contieneDato(texto: string, dato: DatoBuscado): boolean {
  if (dato === "direccion") return pareceDireccion(texto);
  if (dato === "email") return RE_EMAIL.test(texto);
  return RE_CP.test(texto);
}

const normalizar = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/* -------------------------------- consulta --------------------------------- */

export interface OpcionesMensajes {
  desde: Date;
  hasta: Date;
  /** Alternativas separadas por «|», sin distinguir mayúsculas ni acentos. */
  contiene?: string;
  dato?: DatoBuscado;
  /** Por defecto «ellos»: lo que escriben los doctores. */
  quien?: "ellos" | "nosotros" | "todos";
  /** Teléfono o nombre: limita a esa conversación. */
  lead?: string;
  /** Máximo de mensajes devueltos (por defecto 120). */
  max?: number;
}

interface FilaMsg {
  chat_jid: string;
  from_me: number;
  ts: number;
  text: string;
  display_name: string | null;
  phone: string | null;
}

/** Devuelve el TEXTO para Fransua (listo para su turno). */
export function mensajesDelPeriodo(db: DbLectura, o: OpcionesMensajes): string {
  const desdeSec = Math.floor(o.desde.getTime() / 1000);
  const hastaSec = Math.floor(o.hasta.getTime() / 1000);
  const quien = o.quien ?? "ellos";
  const max = Math.min(Math.max(o.max ?? 120, 1), 300);

  // Conversaciones 1-a-1: fuera grupos, estados y canales.
  const base =
    "FROM messages m JOIN chats c ON c.jid = m.chat_jid " +
    "WHERE m.ts >= ? AND m.ts < ? AND m.chat_jid NOT LIKE '%@g.us' AND m.chat_jid NOT LIKE '%@broadcast' AND m.chat_jid NOT LIKE '%@newsletter'";
  const params: unknown[] = [desdeSec, hastaSec];
  let filtro = base;
  if (quien === "ellos") filtro += " AND m.from_me = 0";
  if (quien === "nosotros") filtro += " AND m.from_me = 1";

  let etiquetaLead = "";
  if (o.lead && o.lead.trim()) {
    const digitos = o.lead.replace(/\D/g, "");
    if (digitos.length >= 9) {
      const tel = digitos.slice(-9);
      filtro += " AND (c.phone = ? OR m.chat_jid LIKE ?)";
      params.push(tel, `%${tel}@%`);
      etiquetaLead = ` con el ${tel}`;
    } else {
      filtro += " AND lower(COALESCE(c.display_name,'')) LIKE ?";
      params.push(`%${o.lead.trim().toLowerCase()}%`);
      etiquetaLead = ` con «${o.lead.trim()}»`;
    }
  }

  const totalPeriodo = (db.prepare(`SELECT COUNT(*) AS n ${base}`).get(desdeSec, hastaSec) as { n: number }).n;
  const filas = db
    .prepare(
      `SELECT m.chat_jid, m.from_me, m.ts, m.text, c.display_name, c.phone ${filtro} AND m.text IS NOT NULL AND trim(m.text) <> '' ORDER BY m.ts ASC`,
    )
    .all(...params) as FilaMsg[];

  const alternativas = (o.contiene ?? "")
    .split("|")
    .map((s) => normalizar(s).trim())
    .filter(Boolean);
  const casan = filas.filter((f) => {
    if (alternativas.length && !alternativas.some((a) => normalizar(f.text).includes(a))) return false;
    if (o.dato && !contieneDato(f.text, o.dato)) return false;
    return true;
  });

  const rango = `${fmtInstante(desdeSec)} → ${fmtInstante(hastaSec)}`;
  const deQuien = quien === "ellos" ? "de los doctores" : quien === "nosotros" ? "enviados por CSA" : "";
  const filtros = [
    o.contiene ? `que contienen «${o.contiene}»` : "",
    o.dato ? `que parecen traer ${o.dato === "direccion" ? "una dirección" : o.dato === "email" ? "un email" : "un código postal"}` : "",
  ]
    .filter(Boolean)
    .join(" y ");

  if (casan.length === 0) {
    return (
      `Ningún mensaje ${deQuien}${etiquetaLead}${filtros ? ` ${filtros}` : ""} entre ${rango} (hora de Madrid). ` +
      `En ese periodo hay ${totalPeriodo} mensaje(s) en total en las conversaciones 1-a-1.`
    );
  }

  // Agrupar por conversación, en el orden en que habló cada una.
  const grupos = new Map<string, { nombre: string; tel: string | null; msgs: FilaMsg[] }>();
  for (const f of casan.slice(0, max)) {
    const g = grupos.get(f.chat_jid) ?? {
      nombre: f.display_name?.trim() || f.phone || f.chat_jid.split("@")[0],
      tel: f.phone,
      msgs: [],
    };
    g.msgs.push(f);
    grupos.set(f.chat_jid, g);
  }
  const bloques = [...grupos.values()].map(
    (g) =>
      `■ ${g.nombre}${g.tel ? ` · tel ${g.tel}` : ""} (${g.msgs.length})\n` +
      g.msgs
        .map((m) => {
          const t = m.text.replace(/\s+/g, " ").trim();
          return `  [${fmtInstante(m.ts)}] ${m.from_me ? "CSA" : "Lead"}: ${t.length > 350 ? `${t.slice(0, 350)}…` : t}`;
        })
        .join("\n"),
  );
  const cabecera =
    `${casan.length} mensaje(s) ${deQuien}${etiquetaLead}${filtros ? ` ${filtros}` : ""} entre ${rango} (hora de Madrid), ` +
    `en ${new Set(casan.map((c) => c.chat_jid)).size} conversación(es):`;
  const pie =
    casan.length > max
      ? `\n(Se muestran los ${max} primeros de ${casan.length}: afina con «contiene», «dato» o «lead», o acorta el rango.)`
      : "";
  return `${cabecera}\n${bloques.join("\n")}${pie}`;
}

/** Epoch SEGUNDOS del último mensaje del histórico (para avisar si WhatsApp lleva rato sin entrar). */
export function ultimoMensajeTs(db: DbLectura): number | null {
  const r = db.prepare("SELECT MAX(ts) AS t FROM messages").get() as { t: number | null } | undefined;
  return r?.t ?? null;
}

/**
 * Aviso honesto si WhatsApp NO está conectado: lo posterior al último mensaje no
 * ha llegado al histórico, y «no hay nada desde ayer» sería mentira por omisión.
 */
export function avisoConexion(estado: string, ultimoTs: number | null): string | null {
  if (estado === "open") return null;
  const cuando = ultimoTs ? ` El último mensaje que entró al histórico es del ${fmtInstante(ultimoTs)}.` : "";
  const que =
    estado === "needs_qr"
      ? "WhatsApp está DESVINCULADO del dashboard (hay que volver a escanear el QR desde el móvil de Fran)."
      : "WhatsApp NO está conectado ahora mismo al dashboard.";
  return `⚠️ ${que}${cuando} Lo posterior NO está aquí: díselo a Fran antes que nada.`;
}
