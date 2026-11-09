/**
 * Texto de un PDF con sus coordenadas, en puntos de página y con el origen arriba a la izquierda (como se dibuja en
 * pantalla). No depende del navegador: recibe un documento con la forma mínima de pdf.js, así que las pruebas pueden
 * leer el PDF con la versión de Node y la aplicación con la del navegador.
 */

export type FragmentoTexto = { texto: string; x: number; y: number; ancho: number; alto: number }
export type PaginaTexto = { numero: number; ancho: number; alto: number; fragmentos: FragmentoTexto[] }

type Matriz = number[]
type ItemTexto = { str?: unknown; transform?: unknown; width?: unknown; height?: unknown }
export type PaginaPdf = {
  getViewport(opciones: { scale: number }): { width: number; height: number; transform: Matriz }
  getTextContent(): Promise<{ items: unknown[] }>
}
export type DocumentoPdf = { numPages: number; getPage(numero: number): Promise<PaginaPdf> }

/** Producto de dos matrices afines de pdf.js ([a, b, c, d, e, f]). */
function multiplicar(m1: Matriz, m2: Matriz): Matriz {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ]
}

/** Convierte los elementos de getTextContent() en fragmentos con recuadro (solo texto horizontal y no vacío). */
export function fragmentosDeContenido(items: unknown[], transformVista: Matriz): FragmentoTexto[] {
  const fragmentos: FragmentoTexto[] = []
  for (const crudo of items) {
    const item = crudo as ItemTexto
    if (typeof item.str !== 'string' || !item.str.trim() || !Array.isArray(item.transform)) continue
    const tx = multiplicar(transformVista, item.transform as Matriz)
    const alto = Math.hypot(tx[2], tx[3])
    const ancho = typeof item.width === 'number' ? item.width * Math.hypot(transformVista[0], transformVista[1]) : 0
    if (!(alto > 0) || !(ancho > 0)) continue
    // tx[5] es la línea base: el recuadro cubre desde la altura de las mayúsculas hasta los descendentes.
    fragmentos.push({ texto: item.str.replace(/\s+/g, ' ').trim(), x: tx[4], y: tx[5] - alto * 0.9, ancho, alto: alto * 1.15 })
  }
  return fragmentos
}

export async function extraerPaginas(pdf: DocumentoPdf): Promise<PaginaTexto[]> {
  const paginas: PaginaTexto[] = []
  for (let numero = 1; numero <= pdf.numPages; numero += 1) {
    const pagina = await pdf.getPage(numero)
    const vista = pagina.getViewport({ scale: 1 })
    const contenido = await pagina.getTextContent()
    paginas.push({ numero, ancho: vista.width, alto: vista.height, fragmentos: fragmentosDeContenido(contenido.items, vista.transform) })
  }
  return paginas
}

/** Un PDF escaneado no trae capa de texto (o casi nada): la verificación visual no aplica. */
export function tieneCapaDeTexto(paginas: PaginaTexto[]): boolean {
  if (paginas.length === 0) return false
  const caracteres = paginas.reduce((total, pagina) => total + pagina.fragmentos.reduce((suma, fragmento) => suma + fragmento.texto.replace(/\s/g, '').length, 0), 0)
  return caracteres >= 20 * paginas.length
}
