import { useMemo, useState } from 'react'
import { GitCompare, Loader2, Plus, RefreshCw, X } from 'lucide-react'
import {
  ESTADO_COMPARACION,
  comparacionApi,
  compararResultados,
  filtrarComparacion,
  resumirComparacion,
  textoOferta,
  type FiltroComparacion,
  type ResultadoComparacion,
} from './services/compararResultados'

const FILTROS: { valor: FiltroComparacion; texto: string }[] = [
  { valor: 'todos', texto: 'Todos' }, { valor: 'coincide', texto: 'Coincide' }, { valor: 'diferente', texto: 'Diferente' },
  { valor: 'solo_manual', texto: 'Solo manual' }, { valor: 'solo_ia', texto: 'Solo IA' }, { valor: 'vacio', texto: 'Vacío' },
]

const mensajeError = (error: unknown, otro: string) => (error instanceof Error ? error.message : otro)

/**
 * «Comparar con IA» en la revisión de un documento: corre las reglas y Gemini sobre el mismo archivo y los muestra lado
 * a lado (adaptación de la ComparisonPage del proyecto anterior), ofrece agregar los campos que solo encontró la IA
 * (versión nueva de la estructura) y reprocesar el documento con otra versión.
 */
export function ComparacionIA({ messageId, partId, attachmentId, onReprocesado }: { messageId: string; partId: string; attachmentId: string | null; onReprocesado?: () => void }) {
  const [resultado, setResultado] = useState<ResultadoComparacion | null>(null)
  const [cargando, setCargando] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [aviso, setAviso] = useState<string | null>(null)
  const [filtro, setFiltro] = useState<FiltroComparacion>('todos')
  const [elegidas, setElegidas] = useState<Set<string>>(new Set())
  const [version, setVersion] = useState<number | null>(null)
  const [ocupado, setOcupado] = useState(false)

  const filas = useMemo(() => (resultado ? compararResultados(resultado.manual, resultado.ia, resultado.campos.map((campo) => campo.nombre)) : []), [resultado])
  const resumen = useMemo(() => resumirComparacion(filas), [filas])

  const comparar = async () => {
    setCargando(true)
    setError(null)
    setAviso(null)
    try {
      const respuesta = await comparacionApi.comparar(messageId, partId, attachmentId)
      setResultado(respuesta)
      setElegidas(new Set(respuesta.sugerencias.map((item) => item.nombre)))
      setVersion(respuesta.version_usada)
    } catch (motivo) { setError(mensajeError(motivo, 'No se pudo comparar con la IA.')) } finally { setCargando(false) }
  }

  const agregar = async () => {
    if (!resultado) return
    const campos = resultado.sugerencias.filter((item) => elegidas.has(item.nombre)).map((item) => ({ nombre: item.nombre, alcance: item.alcance }))
    setOcupado(true)
    setError(null)
    try {
      const respuesta = await comparacionApi.crearVersion(resultado.tipo.id, resultado.estructura?.id ?? null, campos)
      setAviso(`Se creó la versión ${respuesta.version} de la estructura con ${respuesta.agregados.join(', ')}. La versión anterior se conserva; los documentos nuevos usan la v${respuesta.version}.`)
      setResultado({ ...resultado, sugerencias: [], estructura: resultado.estructura ? { ...resultado.estructura, version_activa: respuesta.version, versiones: [...resultado.estructura.versiones.filter((v) => v !== respuesta.version), respuesta.version] } : { id: '', nombre: 'Predeterminada', version_activa: respuesta.version, versiones: [1, respuesta.version] } })
      setVersion(respuesta.version)
    } catch (motivo) { setError(mensajeError(motivo, 'No se pudieron agregar los campos.')) } finally { setOcupado(false) }
  }

  const reprocesar = async () => {
    if (version === null) return
    setOcupado(true)
    setError(null)
    try {
      const respuesta = await comparacionApi.reprocesarVersion(messageId, partId, version, attachmentId)
      setAviso(`Reprocesado con la versión ${respuesta.version}: ${respuesta.encontrados ?? 0} de ${respuesta.total_campos ?? 0} campos. Quedó como borrador para revisarlo.`)
      onReprocesado?.()
    } catch (motivo) { setError(mensajeError(motivo, 'No se pudo reprocesar con esa versión.')) } finally { setOcupado(false) }
  }

  const alternar = (nombre: string) => setElegidas((actual) => { const copia = new Set(actual); if (copia.has(nombre)) copia.delete(nombre); else copia.add(nombre); return copia })

  return <section className="border-t border-slate-200 px-4 py-3 sm:px-5" aria-label="Comparación con IA">
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" onClick={() => void comparar()} disabled={cargando} className="btn-soft">{cargando ? <Loader2 size={14} className="animate-spin" /> : <GitCompare size={14} />}Comparar con IA</button>
      <span className="text-[11px] text-slate-500">Corre las reglas y Gemini sobre este documento y los compara campo por campo.</span>
      {resultado && <button type="button" onClick={() => setResultado(null)} aria-label="Cerrar la comparación" className="ml-auto rounded p-1 text-slate-400 hover:bg-slate-100"><X size={14} /></button>}
    </div>
    {error && <div role="alert" className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}
    {aviso && <div role="status" className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">{aviso}</div>}
    {resultado && <div className="mt-3 space-y-3">
      <div className="text-[11px] text-slate-500">{resultado.tipo.nombre}{resultado.estructura ? ` · ${resultado.estructura.nombre}` : ''}{resultado.version_usada ? ` · versión ${resultado.version_usada}` : ''}{resultado.modelo ? ` · IA: ${resultado.modelo}` : ''}</div>
      <div role="tablist" aria-label="Filtrar la comparación" className="flex flex-wrap gap-1">{FILTROS.map((item) => {
        const cuenta = item.valor === 'todos' ? resumen.total : resumen[item.valor]
        return <button key={item.valor} type="button" role="tab" aria-selected={filtro === item.valor} onClick={() => setFiltro(item.valor)} className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${filtro === item.valor ? 'bg-ink text-white' : 'bg-slate-100 text-slate-600'}`}>{item.texto} ({cuenta})</button>
      })}</div>
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full border-collapse text-left text-xs">
          <thead><tr className="border-b border-slate-100 bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500"><th className="px-3 py-2">Campo</th><th className="px-3 py-2">Manual (reglas)</th><th className="px-3 py-2">IA</th><th className="px-3 py-2">Estado</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{filtrarComparacion(filas, filtro).map((fila) => <tr key={fila.clave}>
            <td className="px-3 py-2 font-semibold text-ink">{fila.campo}{!fila.configurado && <span className="ml-1 rounded bg-sky-50 px-1 text-[9px] font-bold text-sky-700">nuevo</span>}</td>
            <td className="px-3 py-2 text-slate-600">{fila.manual || <span className="text-slate-300">—</span>}</td>
            <td className="px-3 py-2 text-slate-600">{fila.ia || <span className="text-slate-300">—</span>}</td>
            <td className="px-3 py-2"><span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${ESTADO_COMPARACION[fila.estado].clase}`}>{ESTADO_COMPARACION[fila.estado].texto}</span></td>
          </tr>)}</tbody>
        </table>
      </div>
      {resultado.sugerencias.length > 0 && !resultado.tipo.contable && <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2.5 text-xs text-sky-900" role="group" aria-label="Campos que encontró la IA">
        <div className="font-bold">{textoOferta(resultado.campos_configurados, resultado.ia_encontrados)}</div>
        <ul className="mt-1.5 space-y-1">{resultado.sugerencias.map((item) => <li key={item.nombre}><label className="flex items-center gap-2"><input type="checkbox" checked={elegidas.has(item.nombre)} onChange={() => alternar(item.nombre)} aria-label={`Agregar ${item.nombre}`} /><strong>{item.nombre}</strong>{item.ejemplo && <span className="text-sky-700">(ej. {item.ejemplo})</span>}</label></li>)}</ul>
        <button type="button" onClick={() => void agregar()} disabled={ocupado || elegidas.size === 0} className="btn-primary mt-2"><Plus size={14} />Agregar y crear la versión nueva</button>
        <p className="mt-1 text-[10px] text-sky-800">Se crea una versión nueva de la estructura (v{(resultado.estructura?.versiones[resultado.estructura.versiones.length - 1] ?? 1) + 1}); la anterior no se borra.</p>
      </div>}
      {resultado.estructura && resultado.estructura.versiones.length > 1 && <div className="flex flex-wrap items-center gap-2 text-xs">
        <label className="font-semibold text-slate-600">Reprocesar este documento con la versión<select aria-label="Versión para reprocesar" value={version ?? ''} onChange={(event) => setVersion(Number(event.target.value))} className="input ml-2 inline-block w-auto py-1 text-xs">{resultado.estructura.versiones.map((numero) => <option key={numero} value={numero}>v{numero}{numero === resultado.estructura?.version_activa ? ' (activa)' : ''}</option>)}</select></label>
        <button type="button" onClick={() => void reprocesar()} disabled={ocupado || version === null} className="btn-soft"><RefreshCw size={14} />Reprocesar</button>
      </div>}
    </div>}
  </section>
}
