/**
 * pdf.js en el navegador. Se descarga solo al abrir un PDF en Extracción (import dinámico) y usa su worker.
 * Las fuentes estándar y los decodificadores wasm los sirve el plugin de vite.config.ts bajo /pdfjs/.
 */
import urlWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { DocumentoPdf, PaginaPdf } from './textoPdf'

export type PaginaVisor = PaginaPdf & {
  render(parametros: { canvas: HTMLCanvasElement; viewport: ReturnType<PaginaPdf['getViewport']> }): { promise: Promise<void>; cancel(): void }
}
export type DocumentoVisor = Omit<DocumentoPdf, 'getPage'> & { getPage(numero: number): Promise<PaginaVisor>; destroy(): Promise<void> }

type Pdfjs = typeof import('pdfjs-dist')
let modulo: Promise<Pdfjs> | null = null
const pdfjs = () => (modulo ??= import('pdfjs-dist').then((cargado) => {
  cargado.GlobalWorkerOptions.workerSrc = urlWorker
  return cargado
}))

export async function abrirPdf(datos: Uint8Array): Promise<DocumentoVisor> {
  const { getDocument } = await pdfjs()
  const base = `${import.meta.env.BASE_URL}pdfjs/`
  const tarea = getDocument({ data: datos, standardFontDataUrl: `${base}standard_fonts/`, wasmUrl: `${base}wasm/` })
  const documento = await tarea.promise
  // En pdf.js 6 se libera la tarea de carga (worker y memoria), no el documento.
  return { numPages: documento.numPages, getPage: (numero) => documento.getPage(numero) as unknown as Promise<PaginaVisor>, destroy: () => tarea.destroy() }
}

/** Dibuja la página en el canvas a la escala dada (nítido en pantallas de alta densidad). */
export function dibujarPagina(pagina: PaginaVisor, canvas: HTMLCanvasElement, escala: number): { promesa: Promise<void>; cancelar: () => void } {
  const densidad = window.devicePixelRatio || 1
  const vista = pagina.getViewport({ scale: escala * densidad })
  canvas.width = Math.floor(vista.width)
  canvas.height = Math.floor(vista.height)
  const tarea = pagina.render({ canvas, viewport: vista })
  return {
    promesa: tarea.promise.catch((error: unknown) => {
      if ((error as { name?: string } | null)?.name === 'RenderingCancelledException') return
      throw error
    }),
    cancelar: () => tarea.cancel(),
  }
}
