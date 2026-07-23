/**
 * ESTRATEGIA COMERCIAL de CSA — el MODELO de pipeline con el que razona Fransua.
 *
 * Es la MISMA lógica que el motor del dashboard (lib/domain/*: estado.ts,
 * alertStrategy.ts, funnel.ts, alerts.ts), escrita como bloque de contexto para
 * inyectarla en los prompts de Fransua (redactar el próximo mensaje y leer/
 * clasificar una conversación) — así sus recomendaciones y sus mensajes SIGUEN
 * la estrategia en vez de improvisar.
 *
 * ⚠️ Fuente de verdad del MODELO. Si en el dashboard cambian los estados, el
 * umbral de dormido (hoy 30 días), la cadencia de reactivación (7/15/30/60) o
 * el speed-to-lead (hoy 1 h), actualizar también este texto para que Fransua no
 * se quede desalineado del motor.
 */
export const ESTRATEGIA_CSA = `ESTRATEGIA COMERCIAL DE CSA — cómo se mueve un lead y cómo actuar (síguela):
- Embudo: Sin contactar → Contactado → En conversación → Propuesta enviada → (Compra | No cualifica | No interesa). Además hay dos estados de "más adelante": "Futuro con propuesta" (quiere para más adelante PERO ya tiene precio sobre la mesa → recordatorio en la fecha prometida) y "Futuro sin propuesta" (más adelante y aún sin precio → nutrir con valor).
- SPEED-TO-LEAD es la palanca nº1 en formación de alto ticket: a un lead recién entrado hay que contactarlo en MINUTOS, no en horas ni días. Un lead nuevo aún sin contactar es lo más urgente del día, por encima de casi todo.
- PIPELINE ACTIVO vs BASE A REACTIVAR: el trabajo 1-a-1 del día es SOLO el pipeline activo (conversación viva, decisión a la vista, menos de ~30 días de silencio). A partir de ~30 días de silencio el lead pasa a la BASE a reactivar: no se persigue a diario, se trabaja por tandas.
- REACTIVAR a un dormido: reintentos espaciados a 7, 15, 30 y 60 días (máximo 3-4). Agotados, solo campaña estacional (Black Friday, vuelta al cole). El ángulo que funciona: aportar VALOR nuevo (contenido gratis, una masterclass/clase) + una oferta con gancho de temporada. NUNCA un "¿sigues interesado?" a secas.
- El "más adelante" (Futuro) es de lo que MÁS se pierde: no lo aparques sin más. Cierra siempre con un próximo paso concreto + FECHA; ancla urgencia (plazas, fecha de la próxima edición, oferta que caduca) y baja el riesgo (financiación, homologación/ROI).`;
