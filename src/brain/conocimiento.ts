/**
 * LO QUE FRANSUA SABE DE VENTAS — índice y buscador de `conocimiento/*.md`.
 *
 * Calco de `oz_cerebro.js` (dashboard OL): cada sección `##` de un Markdown es un
 * trozo autocontenido; se indexa por raíces de palabras y se busca puntuando las
 * palabras raras más que las comunes, el título el triple y las frases dichas tal
 * cual más todavía. Así el playbook (p. ej. ventas B2B y marca personal, 07-10-2026)
 * no va entero en el prompt: Fransua pide la sección que necesita con
 * `consultar_conocimiento`.
 *
 * Puro y sin disco: los ficheros los lee `conocimientoFuente.ts`.
 * Tests: `scripts/test-conocimiento.ts`.
 */

export interface DocConocimiento {
  fuente: string;
  texto: string;
}

export interface SeccionConocimiento {
  fuente: string;
  /** El `#` del documento (o el nombre del fichero si no tiene). */
  documento: string;
  /** Título del documento (`#`) y de la sección (`##`), unidos con « · ». */
  titulo: string;
  /** Solo el `##` (o el `#` si es el preámbulo): lo que se enseña como tema. */
  tema: string;
  texto: string;
  plano: string;
  raices: Map<string, number>;
  titRaices: Set<string>;
}

export interface ResultadoConocimiento {
  fuente: string;
  titulo: string;
  texto: string;
}

export function plano(s: string): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const VACIAS = new Set(
  (
    "a al algo ante como con contra cual cuando de del desde donde el ella ellos en entre era es esa ese eso esta este esto " +
    "fue ha hace hacer hay la las le lo los mas me mi mis muy no nos o para pero por que quien se si sin sobre son su sus te tiene " +
    "un una uno unos y ya yo cuales cuanto cuantos nuestro nuestra hago pasa puedo debo"
  ).split(" "),
);

/** Las palabras que cuentan: 3 letras o más y que no sean de relleno; los números, desde dos cifras. */
export function palabras(s: string): string[] {
  return plano(s)
    .split(/[^a-z0-9ñ]+/)
    .filter((w) => (w.length > 2 || /^\d{2}$/.test(w)) && !VACIAS.has(w));
}

/**
 * La raíz de una palabra, para que «vídeos» case con «vídeo» y «mando» con «manda».
 * Desde 5 letras (OZ cortaba desde 6, y «mando»/«manda» quedaban sin casar). Si
 * el corte deja menos de 4 letras («mando» → «m» por el «-ando» del gerundio),
 * solo se quita la vocal final.
 */
export function raiz(w: string): string {
  if (w.length <= 4) return w;
  const r = w.replace(/(aciones|acion|amente|mente|ando|iendo|adas|ados|idas|idos|ada|ado|ida|ido|ar|er|ir|es|as|os|s|a|o|e)$/, "");
  return r.length >= 4 ? r : w.replace(/[aeos]$/, "");
}

function seccion(fuente: string, documento: string, titulo: string, tema: string, texto: string): SeccionConocimiento | null {
  const t = texto.replace(/[ \t]+\n/g, "\n").trim();
  if (t.length < 40) return null;
  const raices = new Map<string, number>();
  for (const w of palabras(`${titulo} ${t}`)) {
    const r = raiz(w);
    raices.set(r, (raices.get(r) ?? 0) + 1);
  }
  return {
    fuente,
    documento: documento || fuente,
    titulo,
    tema,
    texto: t,
    plano: plano(t),
    raices,
    titRaices: new Set(palabras(titulo).map(raiz)),
  };
}

/**
 * Markdown → secciones. Un `#` da el título del documento (y su preámbulo es una
 * sección más: ahí van las reglas para leerlo); cada `##`/`###` abre una sección.
 */
export function indexar(docs: readonly DocConocimiento[]): SeccionConocimiento[] {
  const out: SeccionConocimiento[] = [];
  for (const d of docs) {
    let h1 = "";
    let tema = "";
    let buf: string[] = [];
    const cierra = () => {
      if (buf.length) {
        const titulo = tema && tema !== h1 ? (h1 ? `${h1} · ${tema}` : tema) : h1;
        const s = seccion(d.fuente, h1, titulo, tema || h1, buf.join("\n"));
        if (s) out.push(s);
      }
      buf = [];
    };
    for (const linea of String(d.texto ?? "").split(/\r?\n/)) {
      const h = /^(#{1,3})\s+(.+)$/.exec(linea);
      if (h) {
        cierra();
        if (h[1].length === 1) {
          h1 = h[2].trim();
          tema = h1;
        } else {
          tema = h[2].trim();
        }
        continue;
      }
      buf.push(linea);
    }
    cierra();
  }
  return out;
}

/**
 * Las `n` secciones que mejor contestan a `consulta`. Una palabra rara pesa más
 * que una común; en el título, el triple; que casen VARIAS palabras vale más que
 * una repetida; y una pareja de palabras dicha tal cual («no cualifica», «la
 * llamada»), más todavía.
 */
export function buscar(indice: readonly SeccionConocimiento[], consulta: string, n = 3): ResultadoConocimiento[] {
  const q = [...new Set(palabras(consulta).map(raiz))];
  if (!q.length || !indice.length) return [];
  const sueltas = plano(consulta).split(/[^a-z0-9ñ]+/).filter(Boolean);
  const parejas: string[] = [];
  for (let i = 0; i + 1 < sueltas.length; i++) {
    const dosDeRelleno = VACIAS.has(sueltas[i]) && VACIAS.has(sueltas[i + 1]) && sueltas[i] !== "no";
    if (!dosDeRelleno) parejas.push(`${sueltas[i]} ${sueltas[i + 1]}`);
  }
  const df = new Map(q.map((r) => [r, indice.reduce((s, t) => s + (t.raices.has(r) ? 1 : 0), 0)]));
  const puntuados = indice
    .map((t) => {
      let p = 0;
      let casan = 0;
      for (const r of q) {
        const veces = t.raices.get(r) ?? 0;
        if (!veces) continue;
        casan++;
        const peso = Math.log(1 + indice.length / (df.get(r) || 1));
        p += peso * (Math.min(veces, 4) + (t.titRaices.has(r) ? 3 : 0));
      }
      if (!casan) return { t, p: 0 };
      let frases = 0;
      const tt = plano(t.titulo);
      for (const par of parejas) {
        if (t.plano.includes(par)) frases++;
        if (tt.includes(par)) frases += 2;
      }
      return { t, p: p * (casan / q.length) * (1 + casan) * (1 + 0.6 * Math.min(frases, 5)) };
    })
    .filter((x) => x.p > 0)
    .sort((a, b) => b.p - a.p);
  const tope = Math.max(1, Math.min(6, n));
  return puntuados.slice(0, tope).map(({ t }) => ({ fuente: t.fuente, titulo: t.titulo, texto: t.texto }));
}

/** Los temas que cubre el índice, para la línea del prompt: «Documento: tema · tema · …». */
export function temas(indice: readonly SeccionConocimiento[]): string {
  const porFuente = new Map<string, { documento: string; temas: string[] }>();
  for (const s of indice) {
    const d = porFuente.get(s.fuente) ?? { documento: s.documento, temas: [] };
    if (s.tema && s.tema !== s.documento && !d.temas.includes(s.tema)) d.temas.push(s.tema);
    porFuente.set(s.fuente, d);
  }
  return [...porFuente.values()].map((d) => `${d.documento}: ${d.temas.join(" · ")}`).join(" | ");
}
