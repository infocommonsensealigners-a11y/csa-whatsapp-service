/**
 * Lee `whatsapp-service/conocimiento/*.md` UNA vez y guarda el índice en memoria.
 * Los ficheros solo cambian con un despliegue, así que no hace falta releerlos.
 * Sin carpeta o con un error de lectura, el índice queda vacío y Fransua sigue
 * funcionando: la herramienta dice que no tiene ese conocimiento.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buscar, indexar, temas, type ResultadoConocimiento, type SeccionConocimiento } from "./conocimiento";

const CARPETA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../conocimiento");

let indice: SeccionConocimiento[] | null = null;

function cargar(): SeccionConocimiento[] {
  if (indice) return indice;
  try {
    const docs = fs
      .readdirSync(CARPETA)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => ({ fuente: f, texto: fs.readFileSync(path.join(CARPETA, f), "utf-8") }));
    indice = indexar(docs);
  } catch {
    indice = [];
  }
  return indice;
}

export function buscarConocimiento(consulta: string, n = 3): ResultadoConocimiento[] {
  return buscar(cargar(), consulta, n);
}

export function temasConocimiento(): string {
  return temas(cargar());
}
