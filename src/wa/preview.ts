/**
 * Vista previa del último mensaje de un chat (la línea gris de la lista).
 * Una sola definición para la ingesta, el envío y la fusión: si cada camino
 * la calculara a su manera, la lista enseñaría previews distintos según por
 * dónde entró el mensaje.
 */
export type TipoMensaje = "text" | "image" | "audio" | "video" | "document" | "other";

export function previewDe(type: TipoMensaje | string, text: string | null | undefined): string {
  const t = (text ?? "").trim();
  if (t) return t.slice(0, 120);
  switch (type) {
    case "image":
      return "📷 Foto";
    case "audio":
      return "🎤 Audio";
    case "video":
      return "🎬 Vídeo";
    case "document":
      return "📄 Documento";
    default:
      return "…";
  }
}
