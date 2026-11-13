import { describe, expect, it } from 'vitest'
import type { CampoExtra, Transaccion } from '../types'
import { camposParaSolicitar, llenarColumnaManual, mensajeLlenado } from './camposExtra'
import { agregarAPlantilla, aplicarPlantilla, cambiarTipoEnPlantilla, quitarDePlantilla, renombrarEnPlantilla, sugerenciasNuevas, type CampoPlantilla } from './plantillaCampos'

const rfc: CampoPlantilla = { id: 'pl-rfc', nombre: 'RFC', origen: 'ia', alcance: 'documento', clave: 'rfc' }
const folio: CampoPlantilla = { id: 'pl-folio', nombre: 'Folio', origen: 'manual', alcance: 'movimiento' }
const fila = (id: string, cambios: Partial<Transaccion> = {}): Transaccion => ({ id, fecha: '02/10/2026', concepto: id, referencia: '', cargo: '1.00', abono: '', saldo: '', origen: 'ia', dudosos: [], huella: `h-${id}`, ...cambios })

describe('aplicar la configuración a un documento', () => {
  it('un documento viejo conserva sus campos y recibe los nuevos vacíos', () => {
    const campos: CampoExtra[] = [{ id: 'x', nombre: 'Notas', origen: 'manual' }]
    expect(aplicarPlantilla(campos, [rfc, folio])).toEqual([
      { id: 'x', nombre: 'Notas', origen: 'manual' },
      { id: 'pl-rfc', nombre: 'RFC', origen: 'ia', plantilla_id: 'pl-rfc', clave: 'rfc', alcance: 'documento', valor: '' },
      { id: 'pl-folio', nombre: 'Folio', origen: 'manual', plantilla_id: 'pl-folio' },
    ])
    const aplicado = aplicarPlantilla(campos, [rfc])
    expect(aplicarPlantilla(aplicado, [rfc])).toBe(aplicado)
  })

  it('un campo vinculado toma el nombre nuevo; los campos solo del documento no cambian', () => {
    const campos: CampoExtra[] = [{ id: 'pl-folio', nombre: 'Folio', origen: 'manual', plantilla_id: 'pl-folio' }, { id: 'solo', nombre: 'Notas', origen: 'manual' }]
    expect(aplicarPlantilla(campos, [{ ...folio, nombre: 'Folio interno' }]).map((campo) => [campo.id, campo.nombre])).toEqual([['pl-folio', 'Folio interno'], ['solo', 'Notas']])
  })

  it('un campo sin vínculo con el mismo nombre queda vinculado', () => {
    expect(aplicarPlantilla([{ id: 'c1', nombre: 'folio', origen: 'manual' }], [folio])).toEqual([{ id: 'c1', nombre: 'Folio', origen: 'manual', plantilla_id: 'pl-folio' }])
  })

  it('los campos configurados se piden a Gemini aunque vengan de una sugerencia de la IA', () => {
    expect(camposParaSolicitar(aplicarPlantilla([{ id: 'v', nombre: 'VSM', origen: 'ia', clave: 'vsm' }], [rfc]))).toEqual(['RFC'])
  })
})

describe('editar la configuración', () => {
  it('agrega, renombra, cambia de tipo y quita sin repetir nombres', () => {
    let campos = agregarAPlantilla([], { nombre: 'RFC', origen: 'ia', alcance: 'documento' })
    expect(agregarAPlantilla(campos, { nombre: 'rfc', origen: 'manual', alcance: 'movimiento' })).toBe(campos)
    expect(agregarAPlantilla(campos, { nombre: 'Saldo', origen: 'manual', alcance: 'movimiento' })).toBe(campos)
    campos = agregarAPlantilla(campos, { nombre: 'Folio', origen: 'manual', alcance: 'movimiento' })
    const [primero, segundo] = campos
    campos = renombrarEnPlantilla(campos, segundo.id, 'Folio interno')
    campos = cambiarTipoEnPlantilla(campos, segundo.id, 'documento')
    campos = quitarDePlantilla(campos, primero.id)
    expect(campos).toEqual([{ id: segundo.id, nombre: 'Folio interno', origen: 'manual', alcance: 'documento' }])
    expect(sugerenciasNuevas([{ clave: 'fi', nombre: 'folio  INTERNO', ejemplo: 'x', alcance: 'movimiento', filas: 1 }, { clave: 'r', nombre: 'RFC', ejemplo: 'y', alcance: 'documento', filas: 0 }], campos).map((s) => s.clave)).toEqual(['r'])
  })
})

describe('el tipo configurado manda al llenar con la IA', () => {
  const transacciones = [fila('a'), fila('b')]
  const docConfigurado: CampoExtra = { id: 'pl-plaza', nombre: 'Plaza', origen: 'manual', alcance: 'documento', valor: '', plantilla_id: 'pl-plaza' }

  it('"Una vez" con valores por fila todos iguales se acepta como valor único', () => {
    const paso = llenarColumnaManual(transacciones, docConfigurado, true, { porHuella: [{ huella: 'h-a', valor: 'CDMX' }, { huella: 'h-b', valor: ' CDMX ' }] })
    expect(paso.campo).toMatchObject({ valor: 'CDMX', valor_ia: true })
    expect(paso.transacciones).toBe(transacciones)
  })

  it('"Una vez" con valores distintos no se llena y pide revisar el tipo', () => {
    const paso = llenarColumnaManual(transacciones, docConfigurado, true, { porHuella: [{ huella: 'h-a', valor: 'A' }, { huella: 'h-b', valor: 'B' }] })
    expect(paso.campo).toBe(docConfigurado)
    expect(paso.resultado.estado).toBe('tipo_distinto')
    expect(mensajeLlenado(paso.resultado)).toMatch(/valores distintos.*Revisa su tipo en Configuración/)
  })

  it('"En cada movimiento" con un valor único no se convierte ni se repite', () => {
    const porMovimiento: CampoExtra = { id: 'pl-folio', nombre: 'Folio', origen: 'manual', plantilla_id: 'pl-folio' }
    const paso = llenarColumnaManual(transacciones, porMovimiento, true, { unico: 'F-1' })
    expect(paso.campo).toBe(porMovimiento)
    expect(paso.transacciones).toBe(transacciones)
    expect(mensajeLlenado(paso.resultado)).toMatch(/como un dato único del documento \(F-1\).*Revisa su tipo en Configuración/)
  })

  it('un campo solo del documento sigue decidiendo el tipo como antes', () => {
    const soloDocumento: CampoExtra = { id: 'c', nombre: 'Folio', origen: 'manual' }
    expect(llenarColumnaManual(transacciones, soloDocumento, true, { unico: 'F-1' }).campo).toMatchObject({ alcance: 'documento', valor: 'F-1' })
  })
})
