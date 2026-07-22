/**
 * Siembra el Plan Comercial Anual real (DOCS/CSA.pdf) en Supabase: 3 reglas de
 * producto + 15 hitos repartidos en 10 de los 12 meses (jul/ago sin hitos —
 * es el hueco antes del relanzamiento de septiembre). IDs estables ⇒
 * re-ejecutar este script actualiza en vez de duplicar.
 *
 * Uso: npx tsx --env-file=.env scripts/seed-plan.ts
 */
import { upsertHito, upsertProducto, listHitos, listProductos, type Hito, type ReglaProducto } from "../src/brain/plan";

const productos: Omit<ReglaProducto, "updatedAt" | "deleted">[] = [
  {
    producto: "Certificacion",
    precioBase: 2900,
    precioTransferencia: 2610,
    canales: ["Google Ads"],
    notas: "Solo se anuncia con Google Ads.",
  },
  {
    producto: "SBA",
    precioBase: 3900,
    precioTransferencia: 3510,
    canales: ["Meta", "Google Ads", "Email"],
    notas: null,
  },
  {
    producto: "Estancia",
    precioBase: 1000,
    precioTransferencia: null,
    canales: [],
    notas: "Solo (1 persona): 1000€. Con equipo: 2000€. A veces (NO HACERLO MUCHO) se rebaja el de equipo a 1000€ si el precio es barrera. Hay 4 tipos de estancias clínicas.",
  },
];

const hitos: Omit<Hito, "updatedAt" | "deleted">[] = [
  { id: "sep-vuelta-cole", mes: 9, rango: "1-15", titulo: "Oferta vuelta al cole", descripcion: "Estancia incluida + SBA = 3900€, o el 10% de descuento.", producto: "SBA", tipo: "oferta", responsable: null, orden: 1 },
  { id: "sep-microtornillos", mes: 9, rango: "12", titulo: "Microtornillos", descripcion: null, producto: "General", tipo: "nota", responsable: "Kike", orden: 2 },

  { id: "oct-estancia-equipo", mes: 10, rango: "10-30", titulo: "Estancia clínica al equipo a 1000€", descripcion: "Rebaja especial de la estancia en equipo.", producto: "Estancia", tipo: "oferta", responsable: null, orden: 1 },
  { id: "oct-webinar-gestion", mes: 10, rango: "24", titulo: "Webinar de gestión clínica", descripcion: "Cómo aumentar los casos de alineadores.", producto: "General", tipo: "webinar", responsable: "Javi", orden: 2 },

  { id: "nov-black-friday-marpe", mes: 11, rango: null, titulo: "Black Friday — Marpe estancia clínica con SBA", descripcion: "3900€.", producto: "SBA", tipo: "oferta", responsable: null, orden: 1 },
  { id: "nov-casos-marpe", mes: 11, rango: "5", titulo: "Presentación de casos clínicos de Marpe", descripcion: "Grupal exclusiva de Marpe, en la hora de las grupales.", producto: "General", tipo: "grupal", responsable: "Javi y Kike", orden: 2 },

  { id: "dic-rescates-prep", mes: 12, rango: null, titulo: "Preparar campaña de rescates", descripcion: "Arranca en enero.", producto: "General", tipo: "campana", responsable: null, orden: 1 },

  { id: "ene-pacientes-crecimiento", mes: 1, rango: "16", titulo: "Pacientes en crecimiento", descripcion: "Enfocar oferta a pacientes en crecimiento.", producto: "General", tipo: "oferta", responsable: null, orden: 1 },
  { id: "ene-rescates-arranque", mes: 1, rango: null, titulo: "Campaña de rescates — arranque", descripcion: "Empieza la campaña de rescates preparada en diciembre.", producto: "General", tipo: "campana", responsable: null, orden: 2 },

  { id: "feb-grupal-crecimiento", mes: 2, rango: "25", titulo: "Grupal pacientes en crecimiento", descripcion: null, producto: "General", tipo: "grupal", responsable: null, orden: 1 },

  { id: "mar-webinar-enrique-ipr", mes: 3, rango: "principios de mes", titulo: "Webinar con Enrique — taller de IPR", descripcion: "Enfocarlo a estancias clínicas y verlo en directo.", producto: "Estancia", tipo: "webinar", responsable: "Enrique", orden: 1 },

  { id: "abr-rescates-llamadas", mes: 4, rango: null, titulo: "Campaña de rescates — llamadas", descripcion: "Llamadas a los leads de los meses anteriores (campaña iniciada en enero).", producto: "General", tipo: "campana", responsable: null, orden: 1 },

  { id: "may-webinar-stripping", mes: 5, rango: null, titulo: "Webinar de Javi — stripping/IPR", descripcion: null, producto: "General", tipo: "webinar", responsable: "Javi", orden: 1 },
  { id: "may-mes-gratis", mes: 5, rango: null, titulo: "Promoción: mes adicional gratis", descripcion: "Confirmar día.", producto: "General", tipo: "oferta", responsable: null, orden: 2 },

  { id: "jun-cierre-sba", mes: 6, rango: "desde el 15", titulo: "Grupal en directo — cierre de inscripción SBA", descripcion: "Anunciar que el último día para inscribirse a SBA es el 15 de julio.", producto: "SBA", tipo: "grupal", responsable: null, orden: 1 },
];

async function main() {
  console.log(`Sembrando ${productos.length} reglas de producto...`);
  for (const p of productos) await upsertProducto(p);
  console.log(`Sembrando ${hitos.length} hitos...`);
  for (const h of hitos) await upsertHito(h);

  const finalHitos = await listHitos();
  const finalProductos = await listProductos();
  console.log(`✅ Verificado: ${finalProductos.length} productos, ${finalHitos.length} hitos en Supabase.`);
  process.exit(0);
}

main().catch((e) => {
  console.error("Error sembrando el plan:", e.message);
  process.exit(1);
});
