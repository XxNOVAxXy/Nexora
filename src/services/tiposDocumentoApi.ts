import { request, type EntradaListado } from './extraccionesApi'
import type { CampoPlantilla, SugerenciaPlantilla } from './plantillaCampos'

/** Id fijo del tipo "Estado de cuenta" (el único con columnas fijas y validación contable). */
export const TIPO_EC_ID = 'tipo-ec'

export type ReglasEstructura = { remitentes: string[]; aseguradoras: string[] }
export type ModoExtraccion = 'manual' | 'ia'

/** Formato de una aseguradora (o banco) dentro de un tipo. */
/** Versión de los campos de una estructura (v1, v2…): se crea al aceptar campos de la IA, sin borrar la anterior. */
export type VersionCampos = { numero: number; campos: CampoPlantilla[]; creado: string; origen: string; nota: string | null }
/** `version`: sube cuando cambian las reglas para reconocerla. `versiones`/`version_activa`: los campos que se extraen. */
export type Estructura = { id: string; nombre: string; version: number; reglas: ReglasEstructura; creado?: string; actualizado?: string; documentos?: number; versiones?: VersionCampos[]; version_activa?: number }

export type TipoDocumento = {
  id: string
  nombre: string
  /** Código para la base de datos: A, AC, G, D, EC… */
  codigo: string
  color: string
  /** Sección repetible (Movimientos, Incisos, Asegurados…), o null si el tipo no tiene. */
  seccion: { nombre: string } | null
  /** "documento" = Una vez; "movimiento" = un valor en cada fila de la sección. */
  campos: CampoPlantilla[]
  estructuras: Estructura[]
  /** manual: extracción por reglas, sin IA (predeterminado). ia: la extrae Gemini. */
  modo?: ModoExtraccion
  /** Solo Estado de cuenta: columnas fijas y validación contable. */
  contable: boolean
  configurado: boolean
  documentos?: number
  /** Tipos precargados: su plantilla predeterminada (null si el tipo lo creó el usuario). */
  plantilla?: { codigo: string; version: number | null } | null
  /** Descripción corta que recibe la IA al clasificar. */
  descripcion?: string | null
  /** Campos de la plantilla que el tipo ya no tiene ("Restaurar campos predeterminados" los agrega). */
  plantilla_faltantes?: string[]
  /** Datos que la IA encontró en documentos de una aseguradora y que no están en el tipo. */
  sugerencias_estructura?: SugerenciaEstructura[]
  /** Campos del tipo que salieron vacíos en los últimos documentos seguidos de una aseguradora. */
  campos_ausentes?: CampoAusente[]
  /** Últimos 30 días: recibidos, enviados (por origen), pendientes, no enviados y con error. */
  resumen_envios?: ResumenEnvios
}

export type ResumenEnvios = { dias: number; recibidos: number; enviados_automatico: number; enviados_configurar: number; enviados_manual: number; pendientes: number; no_enviados: number; con_error: number }

export type FiltroEnvio = 'todos' | 'enviados' | 'pendientes' | 'no_enviados' | 'con_error'

/** Estado de envío de un documento con su etiqueta ("Enviado automáticamente", "No se envió: …") y su motivo. */
export type EstadoEnvio = {
  estado: 'enviado' | 'pendiente' | 'en_curso' | 'no_enviado' | 'error' | 'incierto'
  filtro: Exclude<FiltroEnvio, 'todos'>
  etiqueta: string
  motivo: string | null
  fecha: string | null
  code: number | null
  respuesta: string | null
  origen: 'automatico' | 'configurar' | 'manual' | null
}

/** "Últimos 30 días: 12 recibidos · 10 enviados automáticamente · 1 pendiente · 1 requiere revisión". */
export function textoResumenEnvios(resumen: ResumenEnvios): string {
  const n = (valor: number, uno: string, varios: string) => `${valor} ${valor === 1 ? uno : varios}`
  const partes = [n(resumen.recibidos, 'recibido', 'recibidos'), n(resumen.enviados_automatico, 'enviado automáticamente', 'enviados automáticamente')]
  if (resumen.enviados_configurar) partes.push(n(resumen.enviados_configurar, 'enviado al configurar', 'enviados al configurar'))
  if (resumen.enviados_manual) partes.push(n(resumen.enviados_manual, 'enviado a mano', 'enviados a mano'))
  partes.push(n(resumen.pendientes, 'pendiente', 'pendientes'), n(resumen.no_enviados, 'requiere revisión', 'requieren revisión'))
  if (resumen.con_error) partes.push(n(resumen.con_error, 'con error', 'con error'))
  return `Últimos ${resumen.dias} días: ${partes.join(' · ')}`
}

/** Mensaje al guardar "Configurar con este documento", con el resultado real del envío. */
export function mensajeConfigurar(resultado: ResultadoConfigurar): { texto: string; error: boolean } {
  const base = `Tipo «${resultado.tipo.nombre}» (código ${resultado.tipo.codigo}) guardado`
  if (resultado.envio === 'enviado') return { texto: `Tipo guardado y documento enviado a SaveData${resultado.code !== null && resultado.code !== undefined ? ` (code ${resultado.code})` : ''}.`, error: false }
  if (resultado.envio === 'requiere_revision') return { texto: `Tipo guardado; no se envió: ${resultado.motivos.join(' ')}`, error: false }
  if (resultado.envio === 'pendiente') return { texto: `Tipo guardado; no se pudo enviar: ${(resultado.mensaje ?? 'sin detalle').replace(/\.$/, '')}. Se reintentará en la próxima revisión.`, error: true }
  if (resultado.envio === 'incierto') return { texto: `Tipo guardado; el envío quedó incierto: ${resultado.mensaje ?? 'sin detalle'} Verifica en SaveData si llegó; no se reintentará solo.`, error: true }
  if (resultado.envio) return { texto: `Tipo guardado; no se pudo enviar: ${resultado.mensaje ?? 'sin detalle'}`, error: true }
  return { texto: `${base}. La próxima vez se reconocerá con las reglas elegidas.`, error: false }
}

export type SugerenciaEstructura = { aseguradora: string; clave: string; nombre: string; alcance: CampoPlantilla['alcance']; veces: number; documentos: number; ejemplo: string }
export type CampoAusente = { aseguradora: string; nombre: string; racha: number }

export type MetodoDeteccion = 'remitente' | 'aseguradora' | 'asunto' | 'ia' | 'manual' | 'texto'

/** Tipo detectado (o elegido) para un documento. */
export type TipoDocumentoDetectado = {
  tipo_id: string | null
  codigo: string | null
  nombre: string | null
  color: string | null
  contable: boolean
  estructura_id?: string | null
  estructura?: string | null
  estructura_version?: number | null
  metodo: MetodoDeteccion | null
  confianza: number | null
  aseguradora?: string | null
  regla?: string | null
  remitente?: string | null
  requiere_revision: boolean
  motivo: string | null
  detectado_en?: string | null
}

export type DocumentoRecibido = EntradaListado & {
  creado?: string | null
  attachmentId?: string | null
  envio_automatico?: string | null
  tipo_documento: TipoDocumentoDetectado
  /** Estado de envío calculado por el backend (no viene en respuestas anteriores a esta versión). */
  estado_envio?: EstadoEnvio
}

export type ListaTipos = { tipos: TipoDocumento[]; umbral_confianza: number }

export type SolicitudTipo = { nombre: string; codigo: string; color: string; seccion: { nombre: string } | null; campos: CampoPlantilla[]; modo?: ModoExtraccion }

export type SolicitudConfigurarDocumento = {
  messageId: string
  partId: string
  attachmentId?: string | null
  tipo_id?: string | null
  nuevo?: { nombre: string; codigo: string; color?: string; seccion?: string | null } | null
  reglas: { remitente?: string | null; aseguradora?: string | null }
  nombre_estructura?: string | null
  campos: CampoPlantilla[]
  extraer_y_enviar: boolean
}

export type ResultadoConfigurar = ListaTipos & {
  tipo: TipoDocumento
  estructura: Estructura | null
  envio: 'enviado' | 'requiere_revision' | 'error' | 'incierto' | 'pendiente' | null
  motivos: string[]
  mensaje: string | null
  /** code de la respuesta de SaveData (200 si se envió). */
  code?: number | null
  /** No se pudo conectar: el proceso automático lo reintenta en las siguientes revisiones. */
  reintentara?: boolean
}

const json = (cuerpo: unknown) => JSON.stringify(cuerpo)

export const tiposDocumentoApi = {
  listar: () => request<ListaTipos>('/tipos'),
  crear: (tipo: SolicitudTipo) => request<ListaTipos & { tipo: TipoDocumento }>('/tipos', { method: 'POST', body: json(tipo) }),
  activarVersion: (tipoId: string, estructuraId: string, version: number) =>
    request<ListaTipos>(`/tipos/${encodeURIComponent(tipoId)}/estructuras/${encodeURIComponent(estructuraId)}/version-activa`, { method: 'PUT', body: json({ version }) }),
  editar: (id: string, tipo: SolicitudTipo) => request<ListaTipos & { tipo: TipoDocumento }>(`/tipos/${encodeURIComponent(id)}`, { method: 'PUT', body: json(tipo) }),
  crearEstructura: (tipoId: string, estructura: { nombre: string; reglas: ReglasEstructura }) => request<ListaTipos>(`/tipos/${encodeURIComponent(tipoId)}/estructuras`, { method: 'POST', body: json(estructura) }),
  editarEstructura: (tipoId: string, id: string, estructura: { nombre: string; reglas: ReglasEstructura }) => request<ListaTipos>(`/tipos/${encodeURIComponent(tipoId)}/estructuras/${encodeURIComponent(id)}`, { method: 'PUT', body: json(estructura) }),
  documentos: (limite = 50) => request<{ documentos: DocumentoRecibido[]; umbral_confianza: number }>(`/tipos/documentos?limit=${limite}`),
  /** La IA lee el documento (de Gmail) y propone campos con un ejemplo de su valor. */
  sugerir: (messageId: string, attachmentId: string, nombreTipo: string, seccion: string | null, campos: string[] = []) =>
    request<{ sugerencias: SugerenciaPlantilla[]; aseguradora: string | null }>('/tipos/sugerir', { method: 'POST', body: json({ messageId, attachmentId, nombre_tipo: nombreTipo || 'Documento', seccion, campos: campos.slice(0, 30) }) }),
  /** Aviso de estructura: "agregar" pone el dato en el tipo; "ignorar" no lo vuelve a sugerir para esa aseguradora. */
  resolverSugerencia: (tipoId: string, accion: 'agregar' | 'ignorar', aseguradora: string, clave: string) =>
    request<ListaTipos & { tipo: TipoDocumento }>(`/tipos/${encodeURIComponent(tipoId)}/sugerencias/${accion}`, { method: 'POST', body: json({ aseguradora, clave }) }),
  /** Agrega los campos de la plantilla predeterminada que le falten al tipo (sin borrar ni renombrar). */
  restaurarPlantilla: (tipoId: string) => request<ListaTipos & { tipo: TipoDocumento; agregados: string[] }>(`/tipos/${encodeURIComponent(tipoId)}/restaurar-plantilla`, { method: 'POST' }),
  configurarDocumento: (solicitud: SolicitudConfigurarDocumento) => request<ResultadoConfigurar>('/tipos/configurar-documento', { method: 'POST', body: json(solicitud) }),
}

/** Solicitud de edición de un tipo a partir de su estado actual (con otros campos). */
export const solicitudDe = (tipo: TipoDocumento, campos: CampoPlantilla[] = tipo.campos): SolicitudTipo => ({ nombre: tipo.nombre, codigo: tipo.codigo, color: tipo.color, seccion: tipo.seccion, campos, ...(tipo.modo ? { modo: tipo.modo } : {}) })

/**
 * Tipos vigentes en memoria (como `plantillaVigente`): la pantalla de Extracción los usa para saber los campos y la
 * sección de un documento. `cargar()` comparte la petición en vuelo; si falla, se queda con lo último cargado.
 */
let vigentes: TipoDocumento[] = []
let enVuelo: Promise<TipoDocumento[]> | null = null
const oyentes = new Set<() => void>()
const avisar = () => { for (const oyente of oyentes) oyente() }
export const tiposVigentes = {
  actual: () => vigentes,
  cargar: (): Promise<TipoDocumento[]> => {
    enVuelo ??= Promise.resolve().then(() => tiposDocumentoApi.listar()).then((lista) => { vigentes = Array.isArray(lista?.tipos) ? lista.tipos : vigentes; avisar(); return vigentes }).catch(() => vigentes).finally(() => { enVuelo = null })
    return enVuelo
  },
  fijar: (tipos: TipoDocumento[]) => { vigentes = tipos; avisar() },
  obtener: (id: string | null | undefined) => vigentes.find((tipo) => tipo.id === id) ?? null,
  suscribir: (oyente: () => void) => { oyentes.add(oyente); return () => { oyentes.delete(oyente) } },
}

/** ¿El documento es un estado de cuenta (columnas fijas y validación contable)? Sin tipo: sí, como siempre. */
export const esContable = (tipo: TipoDocumentoDetectado | null | undefined) => !tipo || tipo.tipo_id === TIPO_EC_ID

/** Cómo se detectó el tipo, para mostrarlo. */
export function textoDeteccion(tipo: TipoDocumentoDetectado | null | undefined): string {
  if (!tipo || !tipo.metodo) return 'Estado de cuenta (antes de los tipos)'
  const confianza = tipo.confianza === null || tipo.confianza === undefined ? '' : ` · confianza ${Math.round(tipo.confianza * 100)}%`
  switch (tipo.metodo) {
    case 'remitente': return `Regla de remitente${tipo.regla ? ` (${tipo.regla})` : ''}`
    case 'aseguradora': return `Regla de aseguradora${tipo.regla ? ` (${tipo.regla})` : ''}`
    case 'asunto': return 'Asunto de estado de cuenta'
    case 'ia': return `IA${confianza}`
    case 'manual': return 'Elegido a mano'
    case 'texto': return 'Por el texto del documento (sin IA)'
  }
}

/** Texto del alcance de un campo según la sección del tipo ("Una vez" o "En cada inciso"). */
export const etiquetaAlcanceTipo = (alcance: CampoPlantilla['alcance'], seccion: string | null | undefined) =>
  alcance === 'documento' ? 'Una vez' : `En ${seccion ? seccion.toLowerCase() : 'cada fila'}`

/** El usuario eligió el tipo en Extracción: queda como "Elegido a mano" (requiere revisión solo si el tipo no tiene campos). */
export function deteccionManual(tipo: TipoDocumento, anterior?: TipoDocumentoDetectado | null): TipoDocumentoDetectado {
  const sinCampos = !tipo.configurado
  return {
    tipo_id: tipo.id,
    codigo: tipo.codigo,
    nombre: tipo.nombre,
    color: tipo.color,
    contable: tipo.contable,
    estructura_id: null,
    estructura: null,
    estructura_version: null,
    metodo: 'manual',
    confianza: null,
    aseguradora: anterior?.aseguradora ?? null,
    regla: null,
    remitente: anterior?.remitente ?? null,
    requiere_revision: sinCampos,
    motivo: sinCampos ? `El tipo «${tipo.nombre}» todavía no tiene campos configurados.` : null,
    detectado_en: new Date().toISOString(),
  }
}
