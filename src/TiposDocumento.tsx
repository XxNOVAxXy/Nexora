import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Check, FileStack, Inbox, Pencil, Plus, RefreshCw, Sparkles, Wand2, X } from 'lucide-react'
import type { AlcanceCampo } from './types'
import { agregarAPlantilla, cambiarTipoEnPlantilla, errorNombrePlantilla, quitarDePlantilla, renombrarEnPlantilla, sugerenciasNuevas, type CampoPlantilla, type SugerenciaPlantilla } from './services/plantillaCampos'
import {
  etiquetaAlcanceTipo,
  solicitudDe,
  textoDeteccion,
  tiposDocumentoApi,
  tiposVigentes,
  type DocumentoRecibido,
  type Estructura,
  type ResultadoConfigurar,
  type TipoDocumento,
} from './services/tiposDocumentoApi'

type Avisos = { onNotice: (texto: string) => void; onError: (texto: string) => void }
type Pestana = 'documentos' | 'tipos'

const mensaje = (error: unknown, defecto: string) => (error instanceof Error ? error.message : defecto)
const COLOR_SIN_TIPO = '#94a3b8'
const etiquetaEstado: Record<string, string> = { borrador: 'Borrador', revisado: 'Revisado', enviado: 'Enviado' }
const etiquetaEnvioAuto: Record<string, string> = { enviado: 'enviado automáticamente', requiere_revision: 'no se envió solo', error: 'error al enviar', incierto: 'envío incierto', pendiente: 'envío pendiente', en_curso: 'enviando…' }

/** Configuración → Tipos de documento: lo que llegó (con su tipo detectado) y los tipos con sus reglas y campos. */
export function TiposDocumentoSeccion({ onNotice, onError, editorEstadoDeCuenta }: Avisos & { editorEstadoDeCuenta?: ReactNode }) {
  const [pestana, setPestana] = useState<Pestana>('documentos')
  const [tipos, setTipos] = useState<TipoDocumento[] | null>(null)
  const [documentos, setDocumentos] = useState<DocumentoRecibido[] | null>(null)
  const [cargando, setCargando] = useState(false)
  const [configurando, setConfigurando] = useState<DocumentoRecibido | null>(null)
  const fijarTipos = (lista: TipoDocumento[]) => { setTipos(lista); tiposVigentes.fijar(lista) }
  const recargar = async () => {
    setCargando(true)
    try {
      const [lista, recibidos] = await Promise.all([tiposDocumentoApi.listar(), tiposDocumentoApi.documentos()])
      fijarTipos(lista.tipos)
      setDocumentos(recibidos.documentos)
    } catch (error) { onError(mensaje(error, 'No se pudieron cargar los tipos de documento.')) } finally { setCargando(false) }
  }
  useEffect(() => { void recargar() }, [])
  const pendientes = (documentos ?? []).filter((documento) => documento.tipo_documento.requiere_revision).length

  const alConfigurar = (resultado: ResultadoConfigurar) => {
    fijarTipos(resultado.tipos)
    setConfigurando(null)
    const base = `Tipo «${resultado.tipo.nombre}» (código ${resultado.tipo.codigo}) guardado.`
    if (resultado.envio === 'enviado') onNotice(`${base} El documento se extrajo con la nueva configuración y se envió a SaveData.`)
    else if (resultado.envio === 'requiere_revision') onNotice(`${base} El documento se extrajo, pero no se envió: ${resultado.motivos.join(' ')}`)
    else if (resultado.envio) onError(`${base} El documento se extrajo, pero el envío a SaveData falló: ${resultado.mensaje ?? 'sin detalle'}`)
    else onNotice(`${base} La próxima vez se reconocerá con las reglas elegidas.`)
    void recargar()
  }

  return <div className="space-y-5">
    <div role="tablist" aria-label="Tipos de documento" className="flex flex-wrap gap-2">
      <BotonPestana activa={pestana === 'documentos'} onClick={() => setPestana('documentos')} icono={<Inbox size={15} />}>Documentos que llegaron{pendientes > 0 && <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800">{pendientes}</span>}</BotonPestana>
      <BotonPestana activa={pestana === 'tipos'} onClick={() => setPestana('tipos')} icono={<FileStack size={15} />}>Tipos y reglas</BotonPestana>
      <button type="button" onClick={() => void recargar()} disabled={cargando} className="btn-soft ml-auto px-3 py-2 text-xs"><RefreshCw size={13} className={cargando ? 'animate-spin' : ''} />Actualizar</button>
    </div>
    {configurando && tipos && <PanelConfigurar documento={configurando} tipos={tipos} onCerrar={() => setConfigurando(null)} onListo={alConfigurar} onError={onError} />}
    {pestana === 'documentos'
      ? <DocumentosRecibidos documentos={documentos} onConfigurar={(documento) => setConfigurando(documento)} />
      : <TiposYReglas tipos={tipos} onTipos={fijarTipos} onNotice={onNotice} onError={onError} editorEstadoDeCuenta={editorEstadoDeCuenta} />}
  </div>
}

function BotonPestana({ activa, onClick, icono, children }: { activa: boolean; onClick: () => void; icono: ReactNode; children: ReactNode }) {
  return <button type="button" role="tab" aria-selected={activa} onClick={onClick} className={`flex items-center gap-2 rounded-xl border px-3.5 py-2 text-xs font-bold transition ${activa ? 'border-coral/30 bg-white text-ink shadow-sm' : 'border-transparent text-slate-500 hover:border-slate-200 hover:bg-white/70'}`}>{icono}{children}</button>
}

export function EtiquetaTipo({ nombre, codigo, color }: { nombre: string; codigo: string | null; color: string | null }) {
  const tono = color ?? COLOR_SIN_TIPO
  return <span className="inline-flex max-w-full items-center gap-1.5 truncate rounded-full border px-2 py-0.5 text-[10px] font-bold" style={{ borderColor: `${tono}55`, backgroundColor: `${tono}14`, color: tono }}><span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: tono }} />{nombre}{codigo && ` · ${codigo}`}</span>
}

// --- Documentos que llegaron -----------------------------------------------------------------------

function DocumentosRecibidos({ documentos, onConfigurar }: { documentos: DocumentoRecibido[] | null; onConfigurar: (documento: DocumentoRecibido) => void }) {
  if (documentos === null) return <div className="panel flex items-center gap-2 p-5 text-xs text-slate-400"><RefreshCw size={14} className="animate-spin" />Cargando documentos…</div>
  if (documentos.length === 0) return <div className="panel p-5 text-xs text-slate-500">Todavía no llegó ningún documento con extracción. Aparecerán aquí cuando el proceso automático (o tú) extraiga alguno.</div>
  const fecha = (valor: string | null | undefined) => (valor ? new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(valor)) : '—')
  return <section className="panel overflow-hidden" aria-labelledby="titulo-documentos-recibidos">
    <div className="border-b border-slate-200 px-5 py-4"><h4 id="titulo-documentos-recibidos" className="text-sm font-bold text-ink">Documentos que llegaron</h4><p className="mt-0.5 text-[11px] text-slate-500">Los más recientes primero, con el tipo detectado y cómo se detectó. Los que requieren configuración no se envían solos.</p></div>
    <ul className="divide-y divide-slate-100" aria-label="Documentos que llegaron">
      {documentos.map((documento) => {
        const tipo = documento.tipo_documento
        const requiere = tipo.requiere_revision
        return <li key={`${documento.messageId}:${documento.partId}`} data-requiere={requiere || undefined} className={`flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center ${requiere ? 'bg-amber-50/70' : ''}`}>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-bold text-ink" title={documento.filename}>{documento.filename || 'Documento sin nombre'}</div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
              <EtiquetaTipo nombre={tipo.nombre ?? 'Sin configurar'} codigo={tipo.codigo} color={tipo.color} />
              <span>{textoDeteccion(tipo)}</span>
              {tipo.aseguradora && <span>· {tipo.aseguradora}</span>}
              <span>· {fecha(documento.creado ?? documento.actualizado)}</span>
            </div>
            {requiere && <div className="mt-1 text-[11px] font-semibold text-amber-800">Sin configurar / Requiere revisión: {tipo.motivo}</div>}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600">{etiquetaEstado[documento.estado] ?? documento.estado}{documento.envio_automatico && etiquetaEnvioAuto[documento.envio_automatico] ? ` · ${etiquetaEnvioAuto[documento.envio_automatico]}` : ''}</span>
            {requiere && <button type="button" onClick={() => onConfigurar(documento)} className="btn-primary px-3 py-1.5 text-xs"><Wand2 size={13} />Configurar con este documento</button>}
          </div>
        </li>
      })}
    </ul>
  </section>
}

// --- Panel "Configurar con este documento" (3 pasos) ----------------------------------------------

function PanelConfigurar({ documento, tipos, onCerrar, onListo, onError }: { documento: DocumentoRecibido; tipos: TipoDocumento[]; onCerrar: () => void; onListo: (resultado: ResultadoConfigurar) => void; onError: (texto: string) => void }) {
  const detectado = documento.tipo_documento
  const [modo, setModo] = useState<'existente' | 'nuevo'>(detectado.tipo_id ? 'existente' : 'nuevo')
  const [tipoId, setTipoId] = useState<string>(detectado.tipo_id ?? tipos.find((tipo) => !tipo.contable)?.id ?? tipos[0]?.id ?? '')
  const [nuevo, setNuevo] = useState({ nombre: '', codigo: '', seccion: '' })
  const remitente = detectado.remitente ?? null
  const [porRemitente, setPorRemitente] = useState(Boolean(remitente))
  const [aseguradora, setAseguradora] = useState(detectado.aseguradora ?? '')
  const [porAseguradora, setPorAseguradora] = useState(Boolean(detectado.aseguradora))
  const existente = tipos.find((tipo) => tipo.id === tipoId) ?? null
  const seccion = modo === 'nuevo' ? (nuevo.seccion.trim() || null) : existente?.seccion?.nombre ?? null
  const [campos, setCampos] = useState<CampoPlantilla[]>(existente?.campos ?? [])
  const [sugerencias, setSugerencias] = useState<SugerenciaPlantilla[] | null>(null)
  const [leyendo, setLeyendo] = useState(false)
  const [extraerYEnviar, setExtraerYEnviar] = useState(true)
  const [guardando, setGuardando] = useState(false)
  // Al cambiar de tipo se parte de sus campos.
  useEffect(() => { setCampos(modo === 'existente' ? existente?.campos ?? [] : []) }, [modo, tipoId])
  const codigoNuevo = nuevo.codigo.trim().toUpperCase()
  const errorNuevo = modo !== 'nuevo' ? null
    : !nuevo.nombre.trim() ? 'Escribe el nombre del tipo.'
      : !/^[A-Z0-9]{1,5}$/.test(codigoNuevo) ? 'El código admite de 1 a 5 letras o números (por ejemplo A, AC, G, D).'
        : tipos.some((tipo) => tipo.codigo === codigoNuevo) ? `El código ${codigoNuevo} ya lo usa otro tipo.` : null
  const puedeGuardar = !guardando && (modo === 'nuevo' ? !errorNuevo : Boolean(existente))

  const leer = async () => {
    if (!documento.attachmentId) return
    setLeyendo(true)
    try {
      // Parte de los campos del tipo (su plantilla): la IA solo sugiere los que no estén.
      const respuesta = await tiposDocumentoApi.sugerir(documento.messageId, documento.attachmentId, modo === 'nuevo' ? nuevo.nombre : existente?.nombre ?? '', seccion, campos.map((campo) => campo.nombre))
      setSugerencias(respuesta.sugerencias)
      if (!aseguradora && respuesta.aseguradora) { setAseguradora(respuesta.aseguradora); setPorAseguradora(true) }
    } catch (error) { onError(mensaje(error, 'La IA no pudo leer el documento.')) } finally { setLeyendo(false) }
  }
  const guardar = async () => {
    setGuardando(true)
    try {
      const resultado = await tiposDocumentoApi.configurarDocumento({
        messageId: documento.messageId,
        partId: documento.partId,
        attachmentId: documento.attachmentId ?? null,
        ...(modo === 'nuevo' ? { nuevo: { nombre: nuevo.nombre.trim(), codigo: codigoNuevo, seccion: seccion } } : { tipo_id: tipoId }),
        reglas: { remitente: porRemitente ? remitente : null, aseguradora: porAseguradora && aseguradora.trim() ? aseguradora.trim() : null },
        campos: seccion ? campos : campos.map((campo) => ({ ...campo, alcance: 'documento' as const })),
        extraer_y_enviar: extraerYEnviar,
      })
      onListo(resultado)
    } catch (error) { onError(mensaje(error, 'No se pudo guardar la configuración.')) } finally { setGuardando(false) }
  }

  return <section role="dialog" aria-labelledby="titulo-configurar-documento" className="panel border-violet-200 p-5 sm:p-6">
    <div className="mb-4 flex items-start justify-between gap-3">
      <div><div className="eyebrow mb-1">Configurar con este documento</div><h4 id="titulo-configurar-documento" className="font-display text-base font-bold text-ink">{documento.filename || 'Documento'}</h4><p className="mt-1 text-[11px] text-slate-500">{detectado.motivo ?? 'Confirma el tipo, cómo reconocerlo y los campos que se capturan.'}</p></div>
      <button type="button" onClick={onCerrar} aria-label="Cerrar configuración" className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-ink"><X size={16} /></button>
    </div>
    <div className="grid gap-4 xl:grid-cols-2">
      <Paso numero={1} titulo="Confirma el tipo">
        <div className="space-y-2 text-xs">
          <label className="flex items-center gap-2"><input type="radio" name="modo-tipo" checked={modo === 'existente'} onChange={() => setModo('existente')} disabled={tipos.length === 0} />Usar un tipo que ya existe</label>
          {modo === 'existente' && <div className="flex flex-wrap items-center gap-2 pl-6"><select aria-label="Tipo de documento" value={tipoId} onChange={(event) => setTipoId(event.target.value)} className="input max-w-[16rem] py-1.5 text-xs">{tipos.map((tipo) => <option key={tipo.id} value={tipo.id}>{tipo.nombre}</option>)}</select>{existente && <span className="text-[11px] text-slate-500">código <strong>{existente.codigo}</strong>{existente.seccion && ` · sección ${existente.seccion.nombre}`}</span>}</div>}
          <label className="flex items-center gap-2"><input type="radio" name="modo-tipo" checked={modo === 'nuevo'} onChange={() => setModo('nuevo')} />Crear un tipo nuevo</label>
          {modo === 'nuevo' && <div className="grid gap-2 pl-6 sm:grid-cols-3">
            <input aria-label="Nombre del tipo nuevo" placeholder="Autos flotilla" value={nuevo.nombre} maxLength={80} onChange={(event) => setNuevo((valor) => ({ ...valor, nombre: event.target.value }))} className="input py-1.5 text-xs" />
            <input aria-label="Código del tipo nuevo" placeholder="AC" value={nuevo.codigo} maxLength={5} onChange={(event) => setNuevo((valor) => ({ ...valor, codigo: event.target.value.toUpperCase() }))} className="input py-1.5 text-xs uppercase" />
            <input aria-label="Sección repetible del tipo nuevo" placeholder="Incisos (opcional)" value={nuevo.seccion} maxLength={60} onChange={(event) => setNuevo((valor) => ({ ...valor, seccion: event.target.value }))} className="input py-1.5 text-xs" />
            {errorNuevo && (nuevo.nombre || nuevo.codigo) && <p role="alert" className="text-[10px] text-red-600 sm:col-span-3">{errorNuevo}</p>}
          </div>}
        </div>
      </Paso>
      <Paso numero={2} titulo="Cómo reconocerlo la próxima vez">
        <div className="space-y-2 text-xs">
          <label className={`flex items-center gap-2 ${remitente ? '' : 'text-slate-400'}`}><input type="checkbox" checked={porRemitente} disabled={!remitente} onChange={(event) => setPorRemitente(event.target.checked)} />{remitente ? <>Todo lo que llegue de <strong>{remitente}</strong></> : 'No se conoce el remitente de este documento'}</label>
          <div className="flex flex-wrap items-center gap-2"><label className="flex items-center gap-2"><input type="checkbox" checked={porAseguradora} disabled={!aseguradora.trim()} onChange={(event) => setPorAseguradora(event.target.checked)} aria-label="Todo lo de la aseguradora" />Todo lo de la aseguradora</label><input aria-label="Nombre de la aseguradora" value={aseguradora} maxLength={120} placeholder="Nombre impreso en el documento" onChange={(event) => { setAseguradora(event.target.value); if (!event.target.value.trim()) setPorAseguradora(false) }} className="input max-w-[16rem] py-1.5 text-xs" /></div>
          <p className="text-[11px] text-slate-500">La regla queda en la estructura de esa aseguradora dentro del tipo.</p>
        </div>
      </Paso>
    </div>
    <div className="mt-4">
      <Paso numero={3} titulo="Elige los campos">
        <div className="flex flex-wrap items-center gap-2"><button type="button" onClick={() => void leer()} disabled={leyendo || !documento.attachmentId} className="btn-soft"><Sparkles size={14} className={leyendo ? 'animate-pulse' : ''} />{leyendo ? 'Leyendo el documento…' : 'Proponer campos con IA'}</button><span className="text-[11px] text-slate-500">{documento.attachmentId ? 'La IA lee este mismo documento y propone campos con un ejemplo de su valor.' : 'Este documento no guarda el adjunto: agrega los campos a mano.'}</span></div>
        {sugerencias && <Sugerencias sugerencias={sugerencias} campos={campos} seccion={seccion} onAgregar={setCampos} />}
        <div className="mt-3"><ListaCamposEditable campos={campos} onCampos={setCampos} seccion={seccion} etiqueta="Campos del tipo" permitirFijos={!(modo === 'existente' && existente?.contable)} /></div>
      </Paso>
    </div>
    <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4">
      <label className="flex items-center gap-2 text-xs font-semibold text-ink"><input type="checkbox" checked={extraerYEnviar} onChange={(event) => setExtraerYEnviar(event.target.checked)} />Al guardar, extraer y enviar este documento con la nueva configuración</label>
      <span className="flex-1" />
      <button type="button" onClick={onCerrar} className="btn-soft">Cancelar</button>
      <button type="button" onClick={() => void guardar()} disabled={!puedeGuardar} className="btn-primary"><Check size={14} />{guardando ? (extraerYEnviar ? 'Guardando y extrayendo…' : 'Guardando…') : 'Guardar configuración'}</button>
    </div>
  </section>
}

function Paso({ numero, titulo, children }: { numero: number; titulo: string; children: ReactNode }) {
  return <div className="rounded-xl border border-slate-200 p-4"><div className="mb-3 flex items-center gap-2 text-xs font-bold text-ink"><span className="flex h-5 w-5 items-center justify-center rounded-full bg-coral text-[10px] text-white">{numero}</span>{titulo}</div>{children}</div>
}

function Sugerencias({ sugerencias, campos, seccion, onAgregar }: { sugerencias: SugerenciaPlantilla[]; campos: CampoPlantilla[]; seccion: string | null; onAgregar: (campos: CampoPlantilla[]) => void }) {
  const nuevas = sugerenciasNuevas(sugerencias, campos)
  const [marcadas, setMarcadas] = useState<Set<string>>(() => new Set(nuevas.map((item) => item.clave)))
  const [alcances, setAlcances] = useState<Record<string, AlcanceCampo>>({})
  const porFila = sugerencias.filter((item) => item.alcance === 'movimiento')
  const avisoSeccion = !seccion && porFila.length > 0
    ? <p role="note" className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-800">La IA ve una tabla que se repite ({porFila.map((item) => item.nombre).join(', ')}). Escribe una sección repetible para el tipo (por ejemplo «Asegurados», «Incisos» o «Coberturas») para capturar todas sus filas.</p>
    : null
  if (nuevas.length === 0) return <>{avisoSeccion}<p className="mt-3 text-[11px] text-slate-500">{sugerencias.length === 0 ? 'La IA no encontró campos en este documento.' : 'Todos los campos propuestos ya están en la lista.'}</p></>
  const alcanceDe = (sugerencia: SugerenciaPlantilla): AlcanceCampo => (seccion ? alcances[sugerencia.clave] ?? sugerencia.alcance : 'documento')
  const agregar = () => {
    let lista = campos
    for (const sugerencia of nuevas.filter((item) => marcadas.has(item.clave))) lista = agregarAPlantilla(lista, { nombre: sugerencia.nombre, origen: 'ia', alcance: alcanceDe(sugerencia), clave: sugerencia.clave })
    onAgregar(lista)
  }
  const alternar = (clave: string) => setMarcadas((previas) => { const siguiente = new Set(previas); if (siguiente.has(clave)) siguiente.delete(clave); else siguiente.add(clave); return siguiente })
  return <div className="mt-3">
    {avisoSeccion}
    <ul className="mt-2 space-y-1" aria-label="Campos propuestos por la IA">{nuevas.map((sugerencia) => <li key={sugerencia.clave} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-100 px-2.5 py-2 text-xs">
      <input type="checkbox" checked={marcadas.has(sugerencia.clave)} onChange={() => alternar(sugerencia.clave)} aria-label={`Usar ${sugerencia.nombre}`} className="h-3.5 w-3.5 rounded border-slate-300 text-coral focus:ring-coral" />
      <span className="min-w-0 flex-1"><span className="font-bold text-ink">{sugerencia.nombre}</span><span className="mt-0.5 block truncate text-[10px] text-slate-500" title={sugerencia.ejemplo}>Ej.: {sugerencia.ejemplo}</span></span>
      <select aria-label={`Dónde va ${sugerencia.nombre}`} value={alcanceDe(sugerencia)} disabled={!seccion} onChange={(event) => setAlcances((valor) => ({ ...valor, [sugerencia.clave]: event.target.value as AlcanceCampo }))} className="rounded-md border border-slate-200 bg-white px-1.5 py-1 text-[11px]"><option value="documento">Una vez</option>{seccion && <option value="movimiento">{etiquetaAlcanceTipo('movimiento', seccion)}</option>}</select>
    </li>)}</ul>
    <button type="button" onClick={agregar} disabled={marcadas.size === 0} className="btn-primary mt-2"><Plus size={14} />Agregar seleccionados</button>
  </div>
}

/** Lista de campos de un tipo: renombrar, cambiar si van "Una vez" o en la sección, quitar y agregar a mano. */
function ListaCamposEditable({ campos, onCampos, seccion, etiqueta, permitirFijos = true }: { campos: CampoPlantilla[]; onCampos: (campos: CampoPlantilla[]) => void; seccion: string | null; etiqueta: string; permitirFijos?: boolean }) {
  const [nombre, setNombre] = useState('')
  const [alcance, setAlcance] = useState<AlcanceCampo>('documento')
  const [renombrando, setRenombrando] = useState<{ id: string; nombre: string } | null>(null)
  const errorNombre = nombre.trim() ? errorNombrePlantilla(nombre, campos, undefined, permitirFijos) : null
  const agregarManual = () => {
    if (!nombre.trim() || errorNombre) return
    onCampos(agregarAPlantilla(campos, { nombre, origen: 'manual', alcance: seccion ? alcance : 'documento' }, permitirFijos))
    setNombre('')
  }
  const confirmarRenombre = () => {
    if (!renombrando || errorNombrePlantilla(renombrando.nombre, campos, renombrando.id, permitirFijos)) return
    onCampos(renombrarEnPlantilla(campos, renombrando.id, renombrando.nombre, permitirFijos))
    setRenombrando(null)
  }
  return <div>
    <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">{etiqueta}</div>
    {campos.length === 0 && <p className="mt-2 text-[11px] text-slate-500">Todavía no hay campos.</p>}
    <ul className="mt-2 space-y-1 text-xs" aria-label={etiqueta}>
      {campos.map((campo) => <li key={campo.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-100 px-2.5 py-1.5">
        {renombrando?.id === campo.id
          ? <span className="flex flex-1 items-center gap-1"><input autoFocus aria-label={`Nuevo nombre de ${campo.nombre}`} value={renombrando.nombre} maxLength={60} onChange={(event) => setRenombrando({ id: campo.id, nombre: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter') confirmarRenombre(); if (event.key === 'Escape') setRenombrando(null) }} className="input py-1 text-xs" /><button type="button" onClick={confirmarRenombre} disabled={Boolean(errorNombrePlantilla(renombrando.nombre, campos, campo.id, permitirFijos))} className="btn-soft px-2 py-1 text-[11px]">Listo</button></span>
          : <span className="min-w-0 flex-1 truncate font-semibold text-ink">{campo.nombre}</span>}
        <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold ${campo.origen === 'ia' ? 'bg-violet-50 text-violet-700' : 'bg-slate-100 text-slate-600'}`}>{campo.origen === 'ia' ? 'IA' : 'Manual'}</span>
        <select aria-label={`Dónde va ${campo.nombre}`} value={seccion ? campo.alcance : 'documento'} disabled={!seccion} onChange={(event) => onCampos(cambiarTipoEnPlantilla(campos, campo.id, event.target.value as AlcanceCampo))} className="rounded-md border border-slate-200 bg-white px-1.5 py-1 text-[11px]"><option value="documento">Una vez</option>{seccion && <option value="movimiento">{etiquetaAlcanceTipo('movimiento', seccion)}</option>}</select>
        <button type="button" onClick={() => setRenombrando({ id: campo.id, nombre: campo.nombre })} aria-label={`Renombrar ${campo.nombre}`} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-ink"><Pencil size={12} /></button>
        <button type="button" onClick={() => onCampos(quitarDePlantilla(campos, campo.id))} aria-label={`Quitar ${campo.nombre}`} className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"><X size={12} /></button>
      </li>)}
    </ul>
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <input value={nombre} maxLength={60} onChange={(event) => setNombre(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') agregarManual() }} placeholder="Nombre del campo" aria-label="Nombre del campo nuevo" className="input max-w-[14rem] py-1.5 text-xs" />
      {seccion && <select aria-label="Dónde va el campo nuevo" value={alcance} onChange={(event) => setAlcance(event.target.value as AlcanceCampo)} className="rounded-md border border-slate-200 bg-white px-1.5 py-1.5 text-[11px]"><option value="documento">Una vez</option><option value="movimiento">{etiquetaAlcanceTipo('movimiento', seccion)}</option></select>}
      <button type="button" onClick={agregarManual} disabled={!nombre.trim() || Boolean(errorNombre)} className="btn-soft"><Plus size={14} />Agregar a mano</button>
    </div>
    {errorNombre && <p role="alert" className="mt-1 text-[10px] text-red-600">{errorNombre}</p>}
  </div>
}

// --- Tipos y reglas --------------------------------------------------------------------------------

function TiposYReglas({ tipos, onTipos, onNotice, onError, editorEstadoDeCuenta }: Avisos & { tipos: TipoDocumento[] | null; onTipos: (tipos: TipoDocumento[]) => void; editorEstadoDeCuenta?: ReactNode }) {
  const [elegido, setElegido] = useState<string | 'nuevo' | null>(null)
  if (tipos === null) return <div className="panel flex items-center gap-2 p-5 text-xs text-slate-400"><RefreshCw size={14} className="animate-spin" />Cargando tipos…</div>
  const actual = elegido === 'nuevo' ? null : tipos.find((tipo) => tipo.id === elegido) ?? tipos[0] ?? null
  return <div className="space-y-4">
    <div className="flex flex-wrap gap-2" role="group" aria-label="Tipos de documento configurados">
      {tipos.map((tipo) => {
        const activo = elegido !== 'nuevo' && actual?.id === tipo.id
        return <button key={tipo.id} type="button" aria-pressed={activo} onClick={() => setElegido(tipo.id)} className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-bold transition ${activo ? 'bg-white shadow-sm' : 'border-slate-200 bg-white/60 text-slate-600 hover:bg-white'}`} style={activo ? { borderColor: tipo.color, color: tipo.color } : undefined}>
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: tipo.color }} />{tipo.nombre}<span className="rounded bg-slate-100 px-1 text-[10px] text-slate-500">{tipo.codigo}</span>
        </button>
      })}
      <button type="button" aria-pressed={elegido === 'nuevo'} onClick={() => setElegido('nuevo')} className="btn-soft px-3 py-2 text-xs"><Plus size={13} />Nuevo tipo</button>
    </div>
    {elegido === 'nuevo'
      ? <FormularioTipo key="nuevo" tipos={tipos} onGuardado={(lista, tipo) => { onTipos(lista); setElegido(tipo.id); onNotice(`Tipo «${tipo.nombre}» creado.`) }} onError={onError} />
      : actual && <DetalleTipo key={actual.id} tipo={actual} tipos={tipos} onTipos={onTipos} onNotice={onNotice} onError={onError} editorEstadoDeCuenta={editorEstadoDeCuenta} />}
  </div>
}

function DetalleTipo({ tipo, tipos, onTipos, onNotice, onError, editorEstadoDeCuenta }: Avisos & { tipo: TipoDocumento; tipos: TipoDocumento[]; onTipos: (tipos: TipoDocumento[]) => void; editorEstadoDeCuenta?: ReactNode }) {
  return <div className="space-y-4">
    <div role="status" data-testid="tipo-configurando" className="rounded-xl border-l-4 px-4 py-3 text-sm font-bold" style={{ borderColor: tipo.color, backgroundColor: `${tipo.color}14`, color: tipo.color }}>
      Estás configurando el tipo {tipo.nombre} · código {tipo.codigo}
      <div className="mt-0.5 text-[11px] font-medium text-slate-500">{tipo.seccion ? `Sección repetible: ${tipo.seccion.nombre}` : 'Sin sección repetible'} · {tipo.documentos ?? 0} documento{tipo.documentos === 1 ? '' : 's'}{tipo.contable ? ' · con validación contable' : ''}</div>
      {tipo.plantilla && <div className="mt-1.5"><span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700">Plantilla predeterminada</span></div>}
    </div>
    {tipo.plantilla && <RestaurarPlantilla tipo={tipo} onTipos={onTipos} onNotice={onNotice} onError={onError} />}
    {!tipo.contable && <FormularioTipo tipo={tipo} tipos={tipos} onGuardado={(lista) => { onTipos(lista); onNotice(`Tipo «${tipo.nombre}» guardado.`) }} onError={onError} />}
    <Estructuras tipo={tipo} onTipos={onTipos} onNotice={onNotice} onError={onError} />
    {tipo.contable ? editorEstadoDeCuenta ?? null : <EditorCamposTipo tipo={tipo} onTipos={onTipos} onNotice={onNotice} onError={onError} />}
  </div>
}

/** "Restaurar campos predeterminados": agrega los campos de la plantilla que falten, después de confirmar. */
function RestaurarPlantilla({ tipo, onTipos, onNotice, onError }: Avisos & { tipo: TipoDocumento; onTipos: (tipos: TipoDocumento[]) => void }) {
  const [confirmando, setConfirmando] = useState(false)
  const [restaurando, setRestaurando] = useState(false)
  const faltan = tipo.plantilla_faltantes ?? []
  const restaurar = async () => {
    setRestaurando(true)
    try {
      const respuesta = await tiposDocumentoApi.restaurarPlantilla(tipo.id)
      onTipos(respuesta.tipos)
      setConfirmando(false)
      const n = respuesta.agregados.length
      onNotice(n ? `${n === 1 ? 'Se agregó 1 campo predeterminado' : `Se agregaron ${n} campos predeterminados`} a «${tipo.nombre}»: ${respuesta.agregados.join(', ')}.` : `«${tipo.nombre}» ya tiene todos los campos predeterminados.`)
    } catch (error) { onError(mensaje(error, 'No se pudieron restaurar los campos predeterminados.')) } finally { setRestaurando(false) }
  }
  return <section className="panel p-4 text-xs" aria-label="Plantilla predeterminada">
    <div className="flex flex-wrap items-center gap-2">
      <span className="flex-1 text-[11px] text-slate-500">{faltan.length ? `Faltan ${faltan.length} campo${faltan.length === 1 ? '' : 's'} de la plantilla predeterminada.` : 'El tipo tiene todos los campos de la plantilla predeterminada.'}</span>
      <button type="button" onClick={() => setConfirmando(true)} disabled={faltan.length === 0 || confirmando} className="btn-soft px-3 py-1.5 text-xs"><RefreshCw size={13} />Restaurar campos predeterminados</button>
    </div>
    {confirmando && <div role="alertdialog" aria-label="Confirmar restaurar campos" className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
      <p>Se agregarán estos campos a «{tipo.nombre}»: <strong>{faltan.join(', ')}</strong>. No se borra ni se renombra ningún campo.</p>
      <div className="mt-2 flex gap-2"><button type="button" onClick={() => void restaurar()} disabled={restaurando} className="btn-primary px-3 py-1 text-[11px]"><Check size={12} />Sí, agregar</button><button type="button" onClick={() => setConfirmando(false)} className="btn-soft px-3 py-1 text-[11px]">Cancelar</button></div>
    </div>}
  </section>
}

function FormularioTipo({ tipo, tipos, onGuardado, onError }: { tipo?: TipoDocumento; tipos: TipoDocumento[]; onGuardado: (tipos: TipoDocumento[], tipo: TipoDocumento) => void; onError: (texto: string) => void }) {
  const [nombre, setNombre] = useState(tipo?.nombre ?? '')
  const [codigo, setCodigo] = useState(tipo?.codigo ?? '')
  const [color, setColor] = useState(tipo?.color ?? '#7c3aed')
  const [seccion, setSeccion] = useState(tipo?.seccion?.nombre ?? '')
  const [guardando, setGuardando] = useState(false)
  const codigoLimpio = codigo.trim().toUpperCase()
  const error = !nombre.trim() ? 'Escribe el nombre del tipo.'
    : !/^[A-Z0-9]{1,5}$/.test(codigoLimpio) ? 'El código admite de 1 a 5 letras o números.'
      : tipos.some((otro) => otro.id !== tipo?.id && otro.codigo === codigoLimpio) ? `El código ${codigoLimpio} ya lo usa otro tipo.` : null
  const cambio = !tipo || nombre !== tipo.nombre || codigoLimpio !== tipo.codigo || color !== tipo.color || seccion.trim() !== (tipo.seccion?.nombre ?? '')
  const guardar = async () => {
    setGuardando(true)
    try {
      const solicitud = { nombre: nombre.trim(), codigo: codigoLimpio, color, seccion: seccion.trim() ? { nombre: seccion.trim() } : null, campos: (tipo?.campos ?? []).map((campo) => (seccion.trim() ? campo : { ...campo, alcance: 'documento' as const })) }
      const respuesta = tipo ? await tiposDocumentoApi.editar(tipo.id, solicitud) : await tiposDocumentoApi.crear(solicitud)
      onGuardado(respuesta.tipos, respuesta.tipo)
    } catch (requestError) { onError(mensaje(requestError, 'No se pudo guardar el tipo.')) } finally { setGuardando(false) }
  }
  return <section className="panel p-5" aria-label={tipo ? 'Datos del tipo' : 'Nuevo tipo de documento'}>
    <div className="mb-3 text-xs font-bold text-ink">{tipo ? 'Datos del tipo' : 'Nuevo tipo de documento'}</div>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-[11px] font-bold text-slate-500">Nombre<input aria-label="Nombre del tipo" value={nombre} maxLength={80} onChange={(event) => setNombre(event.target.value)} placeholder="Gastos médicos mayores" className="input mt-1 py-1.5 text-xs" /></label>
      <label className="text-[11px] font-bold text-slate-500">Código para la base de datos<input aria-label="Código del tipo" value={codigo} maxLength={5} onChange={(event) => setCodigo(event.target.value.toUpperCase())} placeholder="G" className="input mt-1 py-1.5 text-xs uppercase" /></label>
      <label className="text-[11px] font-bold text-slate-500">Sección repetible (opcional)<input aria-label="Sección repetible" value={seccion} maxLength={60} onChange={(event) => setSeccion(event.target.value)} placeholder="Incisos, Asegurados, Coberturas…" className="input mt-1 py-1.5 text-xs" /></label>
      <label className="text-[11px] font-bold text-slate-500">Color<span className="mt-1 flex items-center gap-2"><input type="color" aria-label="Color del tipo" value={color} onChange={(event) => setColor(event.target.value)} className="h-8 w-12 cursor-pointer rounded border border-slate-200" /><EtiquetaTipo nombre={nombre || 'Vista previa'} codigo={codigoLimpio || null} color={color} /></span></label>
    </div>
    {error && (nombre || codigo) && <p role="alert" className="mt-2 text-[10px] text-red-600">{error}</p>}
    <div className="mt-3"><button type="button" onClick={() => void guardar()} disabled={guardando || Boolean(error) || !cambio} className="btn-primary"><Check size={14} />{tipo ? 'Guardar tipo' : 'Crear tipo'}</button></div>
  </section>
}

function Estructuras({ tipo, onTipos, onNotice, onError }: Avisos & { tipo: TipoDocumento; onTipos: (tipos: TipoDocumento[]) => void }) {
  const [nueva, setNueva] = useState('')
  const crear = async () => {
    if (!nueva.trim()) return
    try {
      const respuesta = await tiposDocumentoApi.crearEstructura(tipo.id, { nombre: nueva.trim(), reglas: { remitentes: [], aseguradoras: [] } })
      onTipos(respuesta.tipos)
      setNueva('')
      onNotice(`Estructura «${nueva.trim()}» agregada.`)
    } catch (error) { onError(mensaje(error, 'No se pudo agregar la estructura.')) }
  }
  return <section className="panel overflow-hidden" aria-labelledby={`estructuras-${tipo.id}`}>
    <div className="border-b border-slate-200 px-5 py-4"><h4 id={`estructuras-${tipo.id}`} className="text-sm font-bold text-ink">Estructuras (aseguradoras)</h4><p className="mt-0.5 text-[11px] text-slate-500">Cada aseguradora tiene su formato. Todas entregan los mismos campos y el código {tipo.codigo}.</p></div>
    <ul className="divide-y divide-slate-100" aria-label={`Estructuras de ${tipo.nombre}`}>
      {tipo.estructuras.map((estructura) => <FilaEstructura key={estructura.id} tipo={tipo} estructura={estructura} onTipos={onTipos} onError={onError} />)}
      {tipo.estructuras.length === 0 && <li className="px-5 py-3 text-[11px] text-slate-500">Sin estructuras todavía.</li>}
    </ul>
    <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-5 py-3"><input aria-label="Nombre de la estructura nueva" value={nueva} maxLength={120} onChange={(event) => setNueva(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void crear() }} placeholder="Aseguradora (p. ej. GNP)" className="input max-w-[16rem] py-1.5 text-xs" /><button type="button" onClick={() => void crear()} disabled={!nueva.trim()} className="btn-soft"><Plus size={14} />Agregar estructura</button></div>
  </section>
}

function FilaEstructura({ tipo, estructura, onTipos, onError }: { tipo: TipoDocumento; estructura: Estructura; onTipos: (tipos: TipoDocumento[]) => void; onError: (texto: string) => void }) {
  const [remitente, setRemitente] = useState('')
  const [aseguradora, setAseguradora] = useState('')
  const guardar = async (reglas: Estructura['reglas']) => {
    try {
      const respuesta = await tiposDocumentoApi.editarEstructura(tipo.id, estructura.id, { nombre: estructura.nombre, reglas })
      onTipos(respuesta.tipos)
      return true
    } catch (error) { onError(mensaje(error, 'No se pudo guardar la regla.')); return false }
  }
  const agregar = async (clave: 'remitentes' | 'aseguradoras', valor: string, limpiar: () => void) => {
    if (!valor.trim()) return
    if (await guardar({ ...estructura.reglas, [clave]: [...estructura.reglas[clave], valor.trim()] })) limpiar()
  }
  const quitar = (clave: 'remitentes' | 'aseguradoras', valor: string) => void guardar({ ...estructura.reglas, [clave]: estructura.reglas[clave].filter((item) => item !== valor) })
  const chips = (clave: 'remitentes' | 'aseguradoras', titulo: string) => <div className="flex flex-wrap items-center gap-1"><span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{titulo}</span>{estructura.reglas[clave].length === 0 && <span className="text-[11px] text-slate-400">ninguno</span>}{estructura.reglas[clave].map((valor) => <span key={valor} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-700">{valor}<button type="button" onClick={() => quitar(clave, valor)} aria-label={`Quitar regla ${valor}`} className="text-slate-400 hover:text-red-600"><X size={11} /></button></span>)}</div>
  return <li className="px-5 py-3 text-xs">
    <div className="flex flex-wrap items-center gap-2"><span className="font-bold text-ink">{estructura.nombre}</span><span className="rounded-full bg-blue-50 px-1.5 py-0.5 text-[10px] font-bold text-blue-700">v{estructura.version}</span><span className="text-[11px] text-slate-500">{estructura.documentos ?? 0} documento{estructura.documentos === 1 ? '' : 's'}</span></div>
    <div className="mt-2 space-y-1.5">{chips('remitentes', 'Remitentes')}{chips('aseguradoras', 'Aseguradoras')}</div>
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <input aria-label={`Remitente nuevo para ${estructura.nombre}`} value={remitente} onChange={(event) => setRemitente(event.target.value)} placeholder="correo@aseguradora.com o @dominio.com" className="input max-w-[15rem] py-1 text-[11px]" />
      <button type="button" onClick={() => void agregar('remitentes', remitente, () => setRemitente(''))} disabled={!remitente.trim()} className="btn-soft px-2 py-1 text-[11px]"><Plus size={12} />Remitente</button>
      <input aria-label={`Aseguradora nueva para ${estructura.nombre}`} value={aseguradora} onChange={(event) => setAseguradora(event.target.value)} placeholder="Nombre impreso en el documento" className="input max-w-[15rem] py-1 text-[11px]" />
      <button type="button" onClick={() => void agregar('aseguradoras', aseguradora, () => setAseguradora(''))} disabled={!aseguradora.trim()} className="btn-soft px-2 py-1 text-[11px]"><Plus size={12} />Aseguradora</button>
    </div>
  </li>
}

function EditorCamposTipo({ tipo, onTipos, onNotice, onError }: Avisos & { tipo: TipoDocumento; onTipos: (tipos: TipoDocumento[]) => void }) {
  const [campos, setCampos] = useState<CampoPlantilla[]>(tipo.campos)
  const [guardando, setGuardando] = useState(false)
  const sinGuardar = useMemo(() => JSON.stringify(campos) !== JSON.stringify(tipo.campos), [campos, tipo.campos])
  // "Restaurar campos predeterminados" cambió los campos guardados: se parte de ellos (solo si cambió su contenido).
  const guardados = JSON.stringify(tipo.campos)
  useEffect(() => { setCampos(tipo.campos) }, [guardados])
  const guardar = async () => {
    setGuardando(true)
    try {
      const respuesta = await tiposDocumentoApi.editar(tipo.id, solicitudDe(tipo, campos))
      onTipos(respuesta.tipos)
      onNotice(`Campos de «${tipo.nombre}» guardados. Se usarán al extraer este tipo.`)
    } catch (error) { onError(mensaje(error, 'No se pudieron guardar los campos.')) } finally { setGuardando(false) }
  }
  return <section className="panel p-5" aria-label={`Campos de ${tipo.nombre}`}>
    <div className="mb-3"><div className="text-sm font-bold text-ink">Campos de salida</div><p className="mt-0.5 text-[11px] text-slate-500">Los mismos para todas las aseguradoras del tipo. «Una vez» va en «Datos»; {tipo.seccion ? `los de la sección van en «${tipo.seccion.nombre}».` : 'este tipo no tiene sección repetible.'}</p></div>
    <ListaCamposEditable campos={campos} onCampos={setCampos} seccion={tipo.seccion?.nombre ?? null} etiqueta={`Campos de ${tipo.nombre}`} />
    <div className="mt-3 flex items-center gap-3"><button type="button" onClick={() => void guardar()} disabled={guardando || !sinGuardar} className="btn-primary"><Check size={14} />Guardar campos</button>{sinGuardar && <span className="text-[11px] font-semibold text-amber-700">Cambios sin guardar</span>}</div>
  </section>
}
