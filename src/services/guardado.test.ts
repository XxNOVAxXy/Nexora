import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Transaccion } from '../types'
import { validarContabilidad } from './contabilidad'
import { extraccionesApi, type SolicitudGuardado } from './extraccionesApi'
import { borradoresLocales, claveBorrador, contarProblemas, documentoDesdeExtraccion, documentoVacio, ejecutarGuardado, firmaContenido, hayCambios, type DocumentoEditable } from './guardado'

const solicitud: SolicitudGuardado = { version_base: null, estado: 'borrador', confirmar_problemas: false, transacciones: [], formato_numerico: null, modelo: null, prompt_version: null, filename: 'estado.pdf', attachmentId: 'a' }
const guardarConFetch = () => ejecutarGuardado(() => extraccionesApi.guardar('m1', '1.2', solicitud))
const respuesta = (status: number, cuerpo: unknown) => new Response(JSON.stringify(cuerpo), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => vi.unstubAllGlobals())

describe('el guardado solo informa éxito si el backend responde OK', () => {
  it('error de red: no hay éxito y se informa el error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const resultado = await guardarConFetch()
    expect(resultado).toMatchObject({ ok: false, tipo: 'error', mensaje: 'No se pudo contactar el backend FastAPI.' })
  })

  it('error 500: muestra el mensaje real del backend', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respuesta(500, { detail: 'No se pudo guardar la extraccion en disco: disco lleno' })))
    const resultado = await guardarConFetch()
    expect(resultado).toEqual({ ok: false, tipo: 'error', mensaje: 'No se pudo guardar la extraccion en disco: disco lleno' })
  })

  it('409 por versión vieja: conflicto, no éxito', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respuesta(409, { detail: { code: 'conflicto_version', message: 'Otra pestaña guardó una versión más nueva.', version_actual: 3 } })))
    const resultado = await guardarConFetch()
    expect(resultado).toMatchObject({ ok: false, tipo: 'conflicto', mensaje: 'Otra pestaña guardó una versión más nueva.' })
  })

  it('422 de revisión con problemas: devuelve los problemas para pedir confirmación', async () => {
    const problemas = { cuadra: false, diferencias: 1, dudosos: 0, invalidos: 0, en_revision: 0, validacion_incompleta: false, total: 1 }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respuesta(422, { detail: { code: 'revision_con_problemas', message: 'Confirma', problemas } })))
    expect(await guardarConFetch()).toMatchObject({ ok: false, tipo: 'revision_con_problemas', problemas })
  })

  it('una respuesta 200 sin versión no se toma como guardado', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respuesta(200, {})))
    expect((await guardarConFetch()).ok).toBe(false)
  })

  it('éxito solo con la extracción confirmada por el backend', async () => {
    const fetch = vi.fn().mockResolvedValue(respuesta(200, { version: 2, estado: 'borrador' }))
    vi.stubGlobal('fetch', fetch)
    const resultado = await guardarConFetch()
    expect(resultado.ok).toBe(true)
    expect(fetch).toHaveBeenCalledWith('/api/extracciones/m1/1.2', expect.objectContaining({ method: 'PUT' }))
    expect(JSON.parse(fetch.mock.calls[0][1].body as string)).toMatchObject({ version_base: null, estado: 'borrador' })
  })

  it('obtener devuelve null solo para 404 y propaga otros errores', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respuesta(404, { detail: 'no existe' })))
    await expect(extraccionesApi.obtener('m1', '1')).resolves.toBeNull()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respuesta(429, { detail: 'Gmail está limitando' })))
    await expect(extraccionesApi.obtener('m1', '1')).rejects.toThrow('Gmail está limitando')
  })
})

const fila = (cambios: Partial<Transaccion> = {}): Transaccion => ({ id: 'ia-1', fecha: '02/10', concepto: 'PAGO', referencia: '', cargo: '100.00', abono: '', saldo: '', origen: 'ia', dudosos: [], ...cambios })

describe('cambios sin guardar', () => {
  const documento = (transacciones: Transaccion[]): DocumentoEditable => ({ ...documentoVacio(), transacciones })

  it('la firma no depende del orden de las claves ni de campos undefined', () => {
    const a = documento([{ ...fila(), revision: undefined }])
    const b = documento([JSON.parse('{"dudosos":[],"origen":"ia","saldo":"","abono":"","cargo":"100.00","referencia":"","concepto":"PAGO","fecha":"02/10","id":"ia-1"}') as Transaccion])
    expect(firmaContenido(a)).toBe(firmaContenido(b))
  })

  it('detecta cambios respecto a lo guardado y considera cambio cualquier contenido nunca guardado', () => {
    const guardado = documento([fila()])
    expect(hayCambios(guardado, firmaContenido(guardado))).toBe(false)
    expect(hayCambios(documento([fila({ cargo: '150.00' })]), firmaContenido(guardado))).toBe(true)
    expect(hayCambios(documentoVacio(), null)).toBe(false)
    expect(hayCambios(documento([fila()]), null)).toBe(true)
  })
})

describe('contarProblemas', () => {
  it('cuenta diferencias, dudosos (sin duplicarlos como inválidos), filas en revisión y validación incompleta', () => {
    const transacciones = [fila({ id: 't1', cargo: '1,234', dudosos: ['cargo'] }), fila({ id: 't2', revision: 'no_aparece_en_extraccion' })]
    const problemas = contarProblemas(validarContabilidad({ saldo_inicial: '1000.00', saldo_final: '900.00' }, transacciones), null, transacciones)
    expect(problemas).toMatchObject({ dudosos: 1, invalidos: 0, en_revision: 1, validacion_incompleta: true, total: 3 })
  })

  it('sin problemas cuando todo cuadra', () => {
    const transacciones = [fila({ cargo: '100.00' })]
    expect(contarProblemas(validarContabilidad({ saldo_inicial: '1000.00', saldo_final: '900.00' }, transacciones), null, transacciones).total).toBe(0)
  })
})

describe('borrador local', () => {
  const almacen = () => {
    const datos = new Map<string, string>()
    return { getItem: (clave: string) => datos.get(clave) ?? null, setItem: (clave: string, valor: string) => { datos.set(clave, valor) }, removeItem: (clave: string) => { datos.delete(clave) }, datos }
  }

  it('se guarda por cuenta y documento, se lee y se borra', () => {
    const memoria = almacen()
    const borradores = borradoresLocales(memoria)
    const claveA = claveBorrador('cuentaA', 'm1', '1')
    const claveB = claveBorrador('cuentaB', 'm1', '1')
    borradores.guardar(claveA, { version_base: 2, guardadoEn: '2026-11-05T10:00:00Z', documento: { ...documentoVacio(), transacciones: [fila()] } })
    expect(borradores.leer(claveA)?.documento.transacciones).toHaveLength(1)
    expect(borradores.leer(claveB)).toBeNull()
    borradores.borrar(claveA)
    expect(borradores.leer(claveA)).toBeNull()
  })

  it('ignora contenido dañado y funciona sin almacenamiento', () => {
    const memoria = almacen()
    memoria.setItem('x', '{no es json')
    expect(borradoresLocales(memoria).leer('x')).toBeNull()
    expect(borradoresLocales(null).leer('x')).toBeNull()
  })
})


describe('resultado de Gemini → documento', () => {
  const resultado = {
    filename: 'estado.pdf', model: 'gemini-prueba', prompt_version: 'v9', formato_numerico: null,
    resumen: { banco: 'Banco', titular: '', cuenta: '', periodo: '', moneda: 'MXN', saldo_inicial: '', total_cargos: '', total_abonos: '', saldo_final: '', dudosos: [] },
    transacciones: [{ id: 'ia-1', fecha: '01/10', concepto: 'PAGO', referencia: '', cargo: '5.00', abono: '', saldo: '', origen: 'ia' as const, dudosos: [], huella: 'h1' }],
    validacion: {} as never, warnings: [],
  }

  it('crea un borrador con los datos de la extracción', () => {
    const { documento, combinacion } = documentoDesdeExtraccion(resultado, [], 'lote-1')
    expect(documento.estado).toBe('borrador')
    expect(documento.modelo).toBe('gemini-prueba')
    expect(documento.prompt_version).toBe('v9')
    expect(documento.resumen?.banco).toBe('Banco')
    expect(documento.transacciones.map((fila) => fila.concepto)).toEqual(['PAGO'])
    expect(combinacion.conservadas).toBe(0)
  })

  it('conserva las filas manuales vigentes', () => {
    const manual: Transaccion = { id: 'm-1', fecha: '02/10', concepto: 'A MANO', referencia: '', cargo: '', abono: '1.00', saldo: '', origen: 'manual', dudosos: [] }
    const { documento, combinacion } = documentoDesdeExtraccion(resultado, [manual], 'lote-2')
    expect(documento.transacciones.map((fila) => fila.concepto).sort()).toEqual(['A MANO', 'PAGO'])
    expect(combinacion.conservadas).toBe(1)
  })
})
