/**
 * Rutas del PLAN COMERCIAL ANUAL (hitos + reglas de producto). CRUD completo
 * — el dashboard los edita desde Planificación; Fransua los lee (vía
 * getPlanContext) para saber en qué mes del ciclo comercial está.
 */
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { brainConfigured } from "../../brain/supabase";
import { listHitos, upsertHito, deleteHito, listProductos, upsertProducto, getPlanContext, type Hito, type ReglaProducto } from "../../brain/plan";

export function registerPlanRoutes(app: FastifyInstance): void {
  app.get("/plan/hitos", async (_req, reply) => {
    if (!brainConfigured()) return reply.status(503).send({ ok: false, error: "brain-not-configured" });
    try {
      return { ok: true, hitos: await listHitos() };
    } catch (e) {
      return reply.status(502).send({ ok: false, error: (e as Error).message });
    }
  });

  app.post("/plan/hitos", async (req, reply) => {
    if (!brainConfigured()) return reply.status(503).send({ ok: false, error: "brain-not-configured" });
    const body = (req.body ?? {}) as Partial<Hito>;
    if (!body.titulo || !body.mes) return reply.status(400).send({ ok: false, error: "titulo y mes son requeridos" });
    const hito: Omit<Hito, "updatedAt" | "deleted"> = {
      id: randomUUID(),
      mes: Number(body.mes),
      rango: body.rango ?? null,
      titulo: String(body.titulo),
      descripcion: body.descripcion ?? null,
      producto: (body.producto as Hito["producto"]) ?? "General",
      tipo: (body.tipo as Hito["tipo"]) ?? "nota",
      responsable: body.responsable ?? null,
      orden: Number(body.orden) || 0,
    };
    try {
      return { ok: true, hito: await upsertHito(hito) };
    } catch (e) {
      return reply.status(502).send({ ok: false, error: (e as Error).message });
    }
  });

  app.patch("/plan/hitos/:id", async (req, reply) => {
    if (!brainConfigured()) return reply.status(503).send({ ok: false, error: "brain-not-configured" });
    const id = (req.params as { id: string }).id;
    const patch = (req.body ?? {}) as Partial<Hito>;
    try {
      const actual = (await listHitos()).find((h) => h.id === id);
      if (!actual) return reply.status(404).send({ ok: false, error: "hito no encontrado" });
      const merged: Omit<Hito, "updatedAt" | "deleted"> = {
        id,
        mes: patch.mes !== undefined ? Number(patch.mes) : actual.mes,
        rango: patch.rango !== undefined ? patch.rango : actual.rango,
        titulo: patch.titulo !== undefined ? String(patch.titulo) : actual.titulo,
        descripcion: patch.descripcion !== undefined ? patch.descripcion : actual.descripcion,
        producto: patch.producto !== undefined ? (patch.producto as Hito["producto"]) : actual.producto,
        tipo: patch.tipo !== undefined ? (patch.tipo as Hito["tipo"]) : actual.tipo,
        responsable: patch.responsable !== undefined ? patch.responsable : actual.responsable,
        orden: patch.orden !== undefined ? Number(patch.orden) : actual.orden,
      };
      return { ok: true, hito: await upsertHito(merged) };
    } catch (e) {
      return reply.status(502).send({ ok: false, error: (e as Error).message });
    }
  });

  app.delete("/plan/hitos/:id", async (req, reply) => {
    if (!brainConfigured()) return reply.status(503).send({ ok: false, error: "brain-not-configured" });
    const id = (req.params as { id: string }).id;
    try {
      await deleteHito(id);
      return { ok: true };
    } catch (e) {
      return reply.status(502).send({ ok: false, error: (e as Error).message });
    }
  });

  app.get("/plan/productos", async (_req, reply) => {
    if (!brainConfigured()) return reply.status(503).send({ ok: false, error: "brain-not-configured" });
    try {
      return { ok: true, productos: await listProductos() };
    } catch (e) {
      return reply.status(502).send({ ok: false, error: (e as Error).message });
    }
  });

  app.patch("/plan/productos/:producto", async (req, reply) => {
    if (!brainConfigured()) return reply.status(503).send({ ok: false, error: "brain-not-configured" });
    const producto = (req.params as { producto: string }).producto as ReglaProducto["producto"];
    const patch = (req.body ?? {}) as Partial<ReglaProducto>;
    try {
      const actual = (await listProductos()).find((p) => p.producto === producto);
      const merged: Omit<ReglaProducto, "updatedAt" | "deleted"> = {
        producto,
        precioBase: patch.precioBase !== undefined ? Number(patch.precioBase) : actual?.precioBase ?? 0,
        precioTransferencia: patch.precioTransferencia !== undefined ? patch.precioTransferencia : actual?.precioTransferencia ?? null,
        canales: patch.canales !== undefined ? patch.canales : actual?.canales ?? [],
        notas: patch.notas !== undefined ? patch.notas : actual?.notas ?? null,
      };
      return { ok: true, producto: await upsertProducto(merged) };
    } catch (e) {
      return reply.status(502).send({ ok: false, error: (e as Error).message });
    }
  });

  app.get("/plan/current", async (_req, reply) => {
    if (!brainConfigured()) return reply.status(503).send({ ok: false, error: "brain-not-configured" });
    try {
      const ctx = await getPlanContext();
      return { ok: true, ...ctx };
    } catch (e) {
      return reply.status(502).send({ ok: false, error: (e as Error).message });
    }
  });
}
