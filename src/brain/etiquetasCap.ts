/**
 * TECHO de etiquetas por conversación (petición del usuario, 2026-07-27).
 *
 * EL PROBLEMA: `mergeEtiquetas` une de forma ADITIVA ("siempre se suma, nunca se
 * resta") y cada re-análisis añade las suyas, así que en los leads más
 * trabajados crecen sin límite — medido en producción: mediana 7, p90 11, pero
 * 17 leads por encima de 20 y dos en 154 y 146, casi todo variantes de lo mismo.
 * Eso no solo ensucia la ficha: `buscar_leads` (agentTools) usa las etiquetas
 * como TEXTO DE BÚSQUEDA, así que si medio CRM acaba con "llamada", buscar
 * "llamada" deja de discriminar. El techo protege la calidad de la búsqueda.
 *
 * ⚠️ GEMELO: la misma clasificación por familias vive en
 * `dashboard/lib/domain/etiquetasRanking.ts` (que decide qué 10 se DESTACAN en
 * la ficha). No hay forma de compartir código ejecutable entre los dos repos
 * — `shared/` queda fuera de ambos y rompió el build de Railway, ver
 * `dashboard/lib/whatsapp-contracts.ts` —, así que se duplica igual que
 * `normalizarTelefono`. SI CAMBIAS UNA, CAMBIA LA OTRA.
 *
 * ⚠️ ETIQUETAS ESTRUCTURALES: "cliente" / "ya inscrito" / "alumno" / "alumna" NO
 * son descriptivas, son BANDERAS de las que dependen seis sitios del código
 * (intel.ts esCliente, agendaPlaybook, agentTools ×2, notes, y la ficha del
 * dashboard). Si el techo las tirase, un cliente volvería a parecer un lead. Por
 * eso van FIJADAS y nunca se recortan. Igual las cuatro de estado postventa.
 */

/** Cuántas etiquetas se conservan como máximo por conversación. */
export const MAX_ETIQUETAS = 25;

/** Banderas que NUNCA se recortan: hay lógica que las compara literalmente. */
const ESTRUCTURALES = /^(cliente|ya inscrito|alumno|alumna|consulta|incidencia|renovaci[oó]n|al d[ií]a)$/i;

/** Familias temáticas — gemelas de las del dashboard. El primer patrón manda. */
const FAMILIAS: ReadonlyArray<{ clave: string; peso: number; re: RegExp }> = [
  { clave: "compra", peso: 100, re: /compra|vendid|venta cerrad|inscrit|inscrib|matricul|contratad/i },
  { clave: "pago", peso: 98, re: /\bpag(o|a|ar|ado|ando)\b|transferenc|cobr|domicil|recib(o|í)|comprobante/i },
  { clave: "facturacion", peso: 92, re: /factura|datos fiscales|nif|iva/i },
  { clave: "precio", peso: 90, re: /precio|importe|presupuest|coste|tarifa|cuánto|cuanto cuesta|descuento|oferta econ/i },
  { clave: "financiacion", peso: 86, re: /financ|aplaz|a plazos|cuotas|sequra|seQura/i },
  { clave: "cancelacion", peso: 84, re: /cancel|anul|baja|devoluc|reembols|se cae|desist/i },
  { clave: "incidencia", peso: 80, re: /incidencia|problema|queja|reclam|error|no funciona|aver|fall(o|a)\b|t[eé]cnic/i },
  { clave: "sin-respuesta", peso: 76, re: /no contesta|ghosting|sin respuesta|silencio|no responde|ilocaliz/i },
  { clave: "renovacion", peso: 72, re: /renovac|renov(ar|ada|able)/i },
  { clave: "cita", peso: 70, re: /llamada|videollamada|cita|reuni[oó]n|agend|\bdemo\b|\bcall\b|visita|zoom|meet/i },
  { clave: "propuesta", peso: 66, re: /propuesta|oferta enviada|contrato|dossier|presentaci[oó]n enviada/i },
  { clave: "cliente", peso: 62, re: /\bcliente\b|alumn|soporte|al d[ií]a|postventa|post-venta/i },
  { clave: "duda", peso: 58, re: /duda|objeci|pregunta|consulta|compatibil|flexib|viabilidad|adecuaci/i },
  { clave: "espera", peso: 50, re: /espera|pendiente|aguard|a confirmar|sin confirmar|por confirmar/i },
  { clave: "fechas", peso: 48, re: /fecha|horario|calendario|inicio|arranque|septiembre|octubre|noviembre|enero|convocatoria|edici[oó]n/i },
  { clave: "producto", peso: 44, re: /\bsba\b|certificac|estancia|biomec[aá]nic|invisalign|programa|masterclass|mentor|posgrado|curso|modalidad|inmersi/i },
  { clave: "perfil", peso: 38, re: /perfil|cl[ií]nica|dentista|ortodonc|equipo|grupo|estudiante|reciclaje|especialidad/i },
  { clave: "generico", peso: 6, re: /primer contacto|lead nuevo|nuevo lead|recien|recién|receptiv|^activ|interesad|en conversaci|responde|respondi|speed.?to.?lead|engagement|contactad|positiv|conversaci[oó]n activa|lead activo|calific|cualific|prioridad|priority|\bcaliente\b|\btempla|\bfr[ií]o\b/i },
];

/** Normaliza para agrupar variantes sin familia propia (quita horas/días/números). */
function claveTexto(etiqueta: string): string {
  return etiqueta
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\b\d{1,2}[:.]\d{2}\b/g, " ")
    .replace(/\b\d+\s*h(oras?)?\b/g, " ")
    .replace(/\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/g, " ")
    .replace(/\b(hoy|ayer|manana|proxim\w*|siguiente|esta semana|este mes)\b/g, " ")
    .replace(/\b\d+\b/g, " ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function familiaDe(etiqueta: string): { clave: string; peso: number } {
  for (const f of FAMILIAS) if (f.re.test(etiqueta)) return { clave: f.clave, peso: f.peso };
  return { clave: `otra:${claveTexto(etiqueta)}`, peso: 30 };
}

/**
 * Recorta una lista de etiquetas a `limite`, conservando las estructurales, una
 * por familia temática (la más reciente de cada una) y, si sobran huecos, las
 * mejores restantes.
 *
 * El resultado mantiene el ORDEN ORIGINAL (antigua → reciente), porque la
 * posición es el único indicio de recencia que tiene el dashboard para decidir
 * qué destacar. Reordenar aquí corrompería ese criterio.
 *
 * Puro y determinista. Si ya cabe, devuelve la lista tal cual.
 */
export function capEtiquetas(etiquetas: string[], limite = MAX_ETIQUETAS): string[] {
  if (etiquetas.length <= limite) return etiquetas;

  const n = etiquetas.length;
  const puntuar = (pos: number, peso: number) => peso + (pos / (n - 1)) * 20;

  // 1) Estructurales: entran siempre.
  const conservar = new Set<number>();
  for (let i = 0; i < n; i++) if (ESTRUCTURALES.test(etiquetas[i].trim())) conservar.add(i);

  // 2) Una por familia: la MÁS RECIENTE de cada una (refleja el estado de hoy).
  const porFamilia = new Map<string, { pos: number; peso: number }>();
  for (let i = 0; i < n; i++) {
    if (conservar.has(i)) continue;
    const { clave, peso } = familiaDe(etiquetas[i]);
    porFamilia.set(clave, { pos: i, peso });
  }
  const candidatas = [...porFamilia.values()].sort(
    (a, b) => puntuar(b.pos, b.peso) - puntuar(a.pos, a.peso) || b.pos - a.pos
  );
  for (const c of candidatas) {
    if (conservar.size >= limite) break;
    conservar.add(c.pos);
  }

  // 3) Huecos libres: las mejores que queden (evita devolver menos de la cuenta).
  if (conservar.size < limite) {
    const resto = etiquetas
      .map((e, pos) => ({ pos, score: puntuar(pos, familiaDe(e).peso) }))
      .filter((c) => !conservar.has(c.pos))
      .sort((a, b) => b.score - a.score || b.pos - a.pos);
    for (const c of resto) {
      if (conservar.size >= limite) break;
      conservar.add(c.pos);
    }
  }

  // Orden original preservado.
  return etiquetas.filter((_, i) => conservar.has(i));
}
