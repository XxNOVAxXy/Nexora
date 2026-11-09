import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, FileText, Minus, MoveHorizontal, Plus, RefreshCw, ScanSearch, X } from 'lucide-react'
import { abrirPdf, dibujarPagina, type DocumentoVisor } from './services/cargadorPdf'
import { extraerPaginas, type PaginaTexto } from './services/textoPdf'
import type { FilaDocumento } from './services/deteccionDocumento'
import { ETIQUETA_CAMPO, ETIQUETA_ESTADO, textoConteo, type EstadoVerificacion, type MarcaVerificacion, type ResultadoVerificacion } from './services/verificacion'

export type Resaltado = { transaccionId: string | null; filaDocumento: number | null; origen: 'tabla' | 'documento' }

const COLOR: Record<EstadoVerificacion, string> = {
  coincide: 'border-emerald-500 bg-emerald-400/15 hover:bg-emerald-400/30',
  difiere: 'border-amber-500 bg-amber-400/20 hover:bg-amber-400/35',
  falta: 'border-red-500 bg-red-500/15 hover:bg-red-500/30',
  no_se_captura: 'border-slate-400 bg-slate-400/15 hover:bg-slate-400/30',
}
const ZOOM_MIN = 0.4
const ZOOM_MAX = 3

const descripcionMarca = (marca: MarcaVerificacion) => `${marca.etiqueta}: documento «${marca.textoDocumento}», capturado «${marca.valorCapturado || 'vacío'}». ${ETIQUETA_ESTADO[marca.estado]}`
const resaltada = (marca: MarcaVerificacion, resaltado: Resaltado | null) => Boolean(resaltado) && ((resaltado!.transaccionId !== null && marca.transaccionId === resaltado!.transaccionId) || (resaltado!.filaDocumento !== null && marca.filaDocumento === resaltado!.filaDocumento))

type PropsVisor = {
  datos: Uint8Array
  filename: string
  urlExterna: string | null
  pagina: number
  onPagina: (pagina: number) => void
  /** Texto de las páginas una vez leído (null si pdf.js no pudo abrir el archivo). */
  onTexto: (paginas: PaginaTexto[] | null, error?: string) => void
  marcas: MarcaVerificacion[]
  verificacionDisponible: boolean
  verificacionVisible: boolean
  onAlternarVerificacion: () => void
  resaltado: Resaltado | null
  onClicMarca: (marca: MarcaVerificacion) => void
  panel: React.ReactNode
}

/** Visor de PDF propio (pdf.js): cada página en un canvas y, encima, la capa con los recuadros de la verificación. */
export function VisorPdf({ datos, filename, urlExterna, pagina, onPagina, onTexto, marcas, verificacionDisponible, verificacionVisible, onAlternarVerificacion, resaltado, onClicMarca, panel }: PropsVisor) {
  const [pdf, setPdf] = useState<DocumentoVisor | null>(null)
  const [paginas, setPaginas] = useState<PaginaTexto[]>([])
  const [error, setError] = useState<string | null>(null)
  const [zoom, setZoom] = useState<'ancho' | number>('ancho')
  const [anchoContenedor, setAnchoContenedor] = useState(0)
  const [hover, setHover] = useState<MarcaVerificacion | null>(null)
  const contenedor = useRef<HTMLDivElement>(null)
  const refsPaginas = useRef(new Map<number, HTMLDivElement>())
  const onTextoRef = useRef(onTexto)
  onTextoRef.current = onTexto

  useEffect(() => {
    let activo = true
    let abierto: DocumentoVisor | null = null
    setPdf(null)
    setPaginas([])
    setError(null)
    // pdf.js se queda con el buffer que recibe: se le pasa una copia.
    void abrirPdf(new Uint8Array(datos)).then(async (documento) => {
      abierto = documento
      if (!activo) { void documento.destroy(); return }
      const texto = await extraerPaginas(documento)
      if (!activo) return
      setPdf(documento)
      setPaginas(texto)
      onTextoRef.current(texto)
    }).catch((causa: unknown) => {
      if (!activo) return
      const mensaje = causa instanceof Error ? causa.message : 'No se pudo abrir el PDF.'
      setError(mensaje)
      onTextoRef.current(null, mensaje)
    })
    return () => { activo = false; void abierto?.destroy() }
  }, [datos])

  useEffect(() => {
    const elemento = contenedor.current
    if (!elemento || typeof ResizeObserver === 'undefined') return
    const observador = new ResizeObserver(() => { if (elemento.clientWidth > 0) setAnchoContenedor(elemento.clientWidth) })
    observador.observe(elemento)
    return () => observador.disconnect()
  }, [])

  const anchoMaximo = paginas.reduce((maximo, actual) => Math.max(maximo, actual.ancho), 0) || 612
  const escalaAncho = anchoContenedor > 0 ? Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, (anchoContenedor - 32) / anchoMaximo)) : 1
  const escala = zoom === 'ancho' ? escalaAncho : zoom
  const cambiarZoom = (factor: number) => setZoom(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(escala * factor * 100) / 100)))

  const irA = (numero: number) => {
    const destino = Math.max(1, Math.min(paginas.length || 1, numero))
    refsPaginas.current.get(destino)?.scrollIntoView?.({ block: 'start' })
    onPagina(destino)
  }
  const alDesplazar = () => {
    const elemento = contenedor.current
    if (!elemento) return
    let actual = 1
    for (const [numero, nodo] of refsPaginas.current) if (nodo.offsetTop <= elemento.scrollTop + elemento.clientHeight / 3) actual = Math.max(actual, numero)
    if (actual !== pagina) onPagina(actual)
  }

  // Desde la tabla: lleva el documento al primer recuadro de la fila resaltada.
  const claveResaltado = resaltado && resaltado.origen === 'tabla' ? `${resaltado.transaccionId}|${resaltado.filaDocumento}` : null
  useEffect(() => {
    if (!claveResaltado || !contenedor.current) return
    const primera = marcas.find((marca) => resaltada(marca, resaltado))
    if (!primera) return
    contenedor.current.querySelector(`[data-marca="${primera.id}"]`)?.scrollIntoView?.({ block: 'center', inline: 'nearest' })
  }, [claveResaltado])

  const marcasPorPagina = useMemo(() => {
    const mapa = new Map<number, MarcaVerificacion[]>()
    for (const marca of marcas) mapa.set(marca.recuadro.pagina, [...(mapa.get(marca.recuadro.pagina) ?? []), marca])
    return mapa
  }, [marcas])

  return <div className="panel flex h-full flex-col overflow-hidden">
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2 text-xs font-semibold text-ink"><FileText size={16} className="shrink-0 text-coral" /><span className="truncate">{filename}</span></div>
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
        <button type="button" onClick={() => irA(pagina - 1)} disabled={pagina <= 1} className="rounded-md p-1 hover:bg-slate-100 disabled:opacity-40" aria-label="Página anterior"><ChevronLeft size={15} /></button>
        <span className="tabular-nums">Página {pagina} de {paginas.length || '…'}</span>
        <button type="button" onClick={() => irA(pagina + 1)} disabled={pagina >= paginas.length} className="rounded-md p-1 hover:bg-slate-100 disabled:opacity-40" aria-label="Página siguiente"><ChevronRight size={15} /></button>
        <span className="mx-1 h-4 w-px bg-slate-200" />
        <button type="button" onClick={() => cambiarZoom(1 / 1.2)} className="rounded-md p-1 hover:bg-slate-100" aria-label="Reducir"><Minus size={14} /></button>
        <span className="w-10 text-center tabular-nums">{Math.round(escala * 100)}%</span>
        <button type="button" onClick={() => cambiarZoom(1.2)} className="rounded-md p-1 hover:bg-slate-100" aria-label="Ampliar"><Plus size={14} /></button>
        <button type="button" onClick={() => setZoom('ancho')} aria-pressed={zoom === 'ancho'} className={`flex items-center gap-1 rounded-md px-1.5 py-1 font-semibold ${zoom === 'ancho' ? 'bg-slate-100 text-ink' : 'hover:bg-slate-100'}`}><MoveHorizontal size={13} />Ajustar al ancho</button>
        {verificacionDisponible && <button type="button" role="switch" aria-checked={verificacionVisible} onClick={onAlternarVerificacion} className="flex items-center gap-1.5 rounded-md px-1.5 py-1 font-semibold text-ink hover:bg-slate-100"><span className={`relative h-4 w-7 rounded-full transition ${verificacionVisible ? 'bg-emerald-500' : 'bg-slate-300'}`}><span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition ${verificacionVisible ? 'left-3.5' : 'left-0.5'}`} /></span><ScanSearch size={13} />Verificación visual</button>}
        <a href={urlExterna ?? undefined} target="_blank" rel="noreferrer" className={`shrink-0 rounded-full bg-blue-50 px-2.5 py-1 text-[10px] font-bold text-blue-700 hover:bg-blue-100 ${urlExterna ? '' : 'pointer-events-none opacity-50'}`}>Abrir en otra pestaña</a>
      </div>
    </div>
    {panel}
    <div ref={contenedor} onScroll={alDesplazar} className="relative min-h-0 flex-1 overflow-auto bg-slate-100/80 p-4">
      {!pdf && !error && <div className="flex h-full items-center justify-center gap-2 text-sm text-slate-400"><RefreshCw size={16} className="animate-spin" />Preparando el documento…</div>}
      {error && <div className="text-center text-sm text-red-600">{error}</div>}
      {pdf && paginas.map((datosPagina) => <div key={datosPagina.numero} ref={(nodo) => { if (nodo) refsPaginas.current.set(datosPagina.numero, nodo); else refsPaginas.current.delete(datosPagina.numero) }} data-pagina={datosPagina.numero} className="relative mx-auto mb-4 bg-white shadow-md" style={{ width: datosPagina.ancho * escala, height: datosPagina.alto * escala }}>
        <CanvasPagina pdf={pdf} numero={datosPagina.numero} escala={escala} ancho={datosPagina.ancho} alto={datosPagina.alto} />
        <div className="absolute inset-0" aria-label={`Verificación de la página ${datosPagina.numero}`}>
          {(marcasPorPagina.get(datosPagina.numero) ?? []).map((marca) => {
            const r = marca.recuadro
            const activa = resaltada(marca, resaltado)
            return <button key={marca.id} type="button" data-marca={marca.id} aria-label={descripcionMarca(marca)} onClick={() => onClicMarca(marca)} onMouseEnter={() => setHover(marca)} onMouseLeave={() => setHover((actual) => (actual?.id === marca.id ? null : actual))} onFocus={() => setHover(marca)} onBlur={() => setHover(null)}
              className={`absolute rounded-[2px] border transition ${COLOR[marca.estado]} ${activa ? 'z-10 ring-2 ring-blue-500 ring-offset-1' : ''}`}
              style={{ left: (r.x - 1.5) * escala, top: (r.y - 1) * escala, width: (r.ancho + 3) * escala, height: (r.alto + 2) * escala }} />
          })}
          {hover && hover.recuadro.pagina === datosPagina.numero && <div role="tooltip" className="pointer-events-none absolute z-30 w-60 rounded-lg border border-slate-200 bg-white p-2.5 text-[11px] leading-5 text-slate-600 shadow-xl" style={{ left: Math.min(hover.recuadro.x * escala, datosPagina.ancho * escala - 248), top: (hover.recuadro.y + hover.recuadro.alto + 3) * escala }}>
            <div className="font-bold text-ink">{hover.etiqueta}{hover.grupo === 'movimientos' ? ' · movimiento' : ' · resumen'}</div>
            <div>Documento: <span className="font-semibold text-ink">{hover.textoDocumento}</span></div>
            <div>Capturado: <span className="font-semibold text-ink">{hover.valorCapturado || '(vacío)'}</span></div>
            <div className="mt-0.5 font-semibold">{ETIQUETA_ESTADO[hover.estado]}</div>
          </div>}
        </div>
      </div>)}
    </div>
  </div>
}

function CanvasPagina({ pdf, numero, escala, ancho, alto }: { pdf: DocumentoVisor; numero: number; escala: number; ancho: number; alto: number }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    let cancelar: (() => void) | null = null
    let activo = true
    void pdf.getPage(numero).then((pagina) => {
      if (!activo || !canvas.current) return
      const tarea = dibujarPagina(pagina, canvas.current, escala)
      cancelar = tarea.cancelar
      void tarea.promesa.catch(() => undefined)
    })
    return () => { activo = false; cancelar?.() }
  }, [pdf, numero, escala])
  return <canvas ref={canvas} className="absolute inset-0" style={{ width: ancho * escala, height: alto * escala }} />
}

// --- Panel de la verificación: avisos, conteo de cobertura, captura y movimiento por agregar ------------------------

export type EstadoTextoDocumento = 'cargando' | 'listo' | 'sin_texto' | 'imagen' | 'error' | 'otro'

type PropsPanel = {
  estado: EstadoTextoDocumento
  visible: boolean
  resultado: ResultadoVerificacion | null
  destino: string | null
  onCancelarDestino: () => void
  mensaje: { tipo: 'info' | 'error'; texto: string } | null
  onCerrarMensaje: () => void
  filaPorAgregar: FilaDocumento | null
  onAgregar: () => void
  onCancelarAgregar: () => void
}

export const AVISO_SIN_VERIFICACION = 'La verificación visual aún no está disponible para imágenes o documentos escaneados.'

export function PanelVerificacion({ estado, visible, resultado, destino, onCancelarDestino, mensaje, onCerrarMensaje, filaPorAgregar, onAgregar, onCancelarAgregar }: PropsPanel) {
  if (estado === 'sin_texto' || estado === 'imagen') return <div role="note" className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-[11px] text-amber-800">{AVISO_SIN_VERIFICACION}</div>
  if (estado !== 'listo' || !resultado || !visible) return null
  const leyenda: [EstadoVerificacion, string][] = [['coincide', 'Verde = coincide con el documento'], ['difiere', 'Ámbar = capturado con otro valor'], ['falta', 'Rojo = falta capturar'], ['no_se_captura', 'Gris = no se captura']]
  const sinRespaldo = resultado.sinRespaldo.length
  return <div className="shrink-0 space-y-1.5 border-b border-slate-200 bg-slate-50/70 px-4 py-2.5 text-[11px] text-slate-600" aria-label="Verificación visual">
    <div className="flex flex-wrap gap-x-3 gap-y-1">{leyenda.map(([clave, texto]) => <span key={clave} className="inline-flex items-center gap-1"><span className={`h-2.5 w-2.5 rounded-[2px] border ${COLOR[clave]}`} />{texto}</span>)}</div>
    <div data-testid="cobertura-resumen"><span className="font-bold text-ink">Resumen:</span> {resultado.resumen ? textoConteo(resultado.resumen) : 'No se reconoció ninguna etiqueta del resumen en este documento; sus campos no se marcan como faltantes.'}</div>
    <div data-testid="cobertura-movimientos"><span className="font-bold text-ink">Movimientos:</span> {resultado.movimientos ? <>{textoConteo(resultado.movimientos)}{resultado.filasDeSaldo > 0 && ` · ${resultado.filasDeSaldo} fila${resultado.filasDeSaldo === 1 ? '' : 's'} de saldo (no se captura${resultado.filasDeSaldo === 1 ? '' : 'n'})`}</> : 'No se pudo reconocer la tabla de movimientos de este documento.'}</div>
    {sinRespaldo > 0 && <div className="font-semibold text-rose-700">{sinRespaldo} movimiento{sinRespaldo === 1 ? '' : 's'} capturado{sinRespaldo === 1 ? '' : 's'} no aparece{sinRespaldo === 1 ? '' : 'n'} en el documento</div>}
    <div className="text-slate-400">La verificación se basa en el texto del PDF y puede no reconocer el formato de algunos bancos.</div>
    {destino && <div role="status" className="flex items-center justify-between gap-2 rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-blue-800"><span>Haz clic en el documento para copiar a: <strong>{destino}</strong></span><button type="button" onClick={onCancelarDestino} className="rounded p-0.5 hover:bg-blue-100" aria-label="Cancelar copia"><X size={13} /></button></div>}
    {mensaje && <div role={mensaje.tipo === 'error' ? 'alert' : 'status'} className={`flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 ${mensaje.tipo === 'error' ? 'border-red-200 bg-red-50 text-red-700' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}><span>{mensaje.texto}</span><button type="button" onClick={onCerrarMensaje} className="rounded p-0.5" aria-label="Cerrar mensaje"><X size={13} /></button></div>}
    {filaPorAgregar && <div role="dialog" aria-label="Movimiento sin capturar" className="rounded-md border border-red-200 bg-white px-2.5 py-2">
      <div className="font-bold text-ink">Movimiento del documento sin capturar</div>
      <div className="mt-0.5">{(['fecha', 'concepto', 'referencia', 'cargo', 'abono', 'saldo'] as const).filter((campo) => filaPorAgregar.celdas[campo]).map((campo) => `${ETIQUETA_CAMPO[campo]}: ${filaPorAgregar.celdas[campo]!.texto}`).join(' · ')}</div>
      <div className="mt-1.5 flex gap-2"><button type="button" onClick={onAgregar} className="btn-primary px-2.5 py-1 text-[11px]"><Plus size={12} />Agregar este movimiento</button><button type="button" onClick={onCancelarAgregar} className="btn-soft px-2.5 py-1 text-[11px]">Cancelar</button></div>
    </div>}
  </div>
}
