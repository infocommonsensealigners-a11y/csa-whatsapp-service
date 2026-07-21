# 🚦 Sidecar WhatsApp — reglas de deploy (crítico, hay VARIAS sesiones a la vez)

Este servicio corre en Railway con **VOLUMEN** (`/data`, ahí vive `wa.sqlite3` con
60k+ mensajes) → **CADA deploy corta el servicio ~30-90s SIN remedio** (Railway no
puede solapar contenedores con volumen). Mientras está caído, el dashboard pierde
Fransua/intel/chats/agenda. Fran lo usa a diario.

## PACTO DE DEPLOYS (obligatorio)
1. **Push = deploy = corte.** Commitea en local libremente; **pushea SOLO al cerrar
   una feature verificada** (máx ~1 push/hora). Nada de push-por-commit ni "probar en prod".
2. Mejor **fuera del horario de Fran (L-V ~9-18h)** salvo urgencia.
3. **Turno de deploy**: antes de push/variables/redeploy mira
   `../dashboard/.deploy-lock.json` y `railway status`. Deploy en curso o lock
   tomado < 20 min → ESPERA. Toma el lock para desplegar y libéralo al verificar.
4. **PRODUCCIÓN = proyecto Railway `content-adventure`** (su `csa-whatsapp-service`
   es el que usa el dominio real del dashboard). `enchanting-recreation` es un
   DUPLICADO con los mismos nombres conectado al mismo repo: variables puestas ahí
   se pierden, y un push despliega en LOS DOS.
5. Protocolo completo: **`../dashboard/DEPLOY-COORDINATION.md`**.

## Datos que no se tocan a la ligera
- El volumen `/data` PERSISTE entre deploys (verificado); las "pérdidas" históricas
  fueron crashes por repo mal conectado, no borrados.
- `WA_CONNECT=off` en prod (Baileys apagado): el directo llegará por Coexistence
  (Cloud API). No lo enciendas en la nube sin decisión explícita del usuario.
