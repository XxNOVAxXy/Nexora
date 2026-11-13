// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CampoPlantilla, Plantilla } from './services/plantillaCampos'

let plantilla: Plantilla
const { guardarMock, sugerirMock, fijarMock } = vi.hoisted(() => ({ guardarMock: vi.fn(), sugerirMock: vi.fn(), fijarMock: vi.fn() }))
vi.mock('./services/plantillaCamposApi', () => ({
  plantillaCamposApi: { obtener: vi.fn(async () => plantilla), guardar: guardarMock, sugerir: sugerirMock },
  plantillaVigente: { actual: () => [], cargar: async () => [], fijar: fijarMock },
}))

const { TarjetaCamposConfigurados } = await import('./App')

const lista = () => screen.getByRole('list', { name: 'Campos que se capturan' })

beforeEach(() => {
  plantilla = { configurada: false, campos: [{ id: 'pl-sucursal', nombre: 'Sucursal', origen: 'manual', alcance: 'movimiento' }], actualizado: null }
  guardarMock.mockImplementation(async (campos: CampoPlantilla[]) => ({ configurada: true, campos, actualizado: '2026-11-13T10:00:00Z' }))
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Configuración: campos que se capturan', () => {
  it('precarga lo deducido, sugiere campos desde un ejemplo y guarda la lista final', async () => {
    sugerirMock.mockResolvedValue([
      { clave: 'rfc', nombre: 'RFC', ejemplo: 'XAXX010101000', alcance: 'documento', filas: 0 },
      { clave: 'folio', nombre: 'Folio', ejemplo: 'F-1', alcance: 'movimiento', filas: 2 },
      { clave: 'sucursal', nombre: 'Sucursal', ejemplo: 'Centro', alcance: 'movimiento', filas: 2 },
    ])
    const onNotice = vi.fn()
    render(<TarjetaCamposConfigurados onNotice={onNotice} onError={vi.fn()} />)
    expect(await screen.findByText(/Lista precargada con los campos de tus extracciones guardadas/)).toBeTruthy()
    // Campos fijos de solo lectura y el precargado.
    for (const fijo of ['Fecha', 'Concepto', 'Referencia', 'Cargo', 'Abono', 'Saldo']) expect(within(lista()).getByText(fijo)).toBeTruthy()
    expect(within(lista()).getByText('Sucursal')).toBeTruthy()

    // Paso 1: sugerencias desde un ejemplo; las que ya están en la lista no se ofrecen.
    const archivo = new File(['%PDF-1.7'], 'ejemplo.pdf', { type: 'application/pdf' })
    fireEvent.change(screen.getByLabelText('Estado de cuenta de ejemplo'), { target: { files: [archivo] } })
    fireEvent.click(screen.getByRole('button', { name: 'Sugerir campos con IA' }))
    expect(await screen.findByLabelText('Usar RFC')).toBeTruthy()
    expect(sugerirMock).toHaveBeenCalledWith(archivo)
    expect(screen.queryByLabelText('Usar Sucursal')).toBeNull()
    expect(screen.getByText('Ej.: XAXX010101000')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Usar RFC'))
    fireEvent.click(screen.getByRole('button', { name: 'Agregar seleccionados' }))
    expect(within(lista()).getByText('RFC')).toBeTruthy()
    expect(screen.queryByLabelText('Usar RFC')).toBeNull()

    // Paso 2: agregar a mano, cambiar de tipo, renombrar y quitar.
    fireEvent.change(screen.getByLabelText('Nombre del campo nuevo'), { target: { value: 'Número de cliente' } })
    fireEvent.click(screen.getByRole('button', { name: 'Agregar a mano' }))
    fireEvent.change(screen.getByLabelText('Tipo de Sucursal'), { target: { value: 'documento' } })
    fireEvent.click(screen.getByRole('button', { name: 'Renombrar Número de cliente' }))
    fireEvent.change(screen.getByLabelText('Nuevo nombre de Número de cliente'), { target: { value: 'Cliente' } })
    fireEvent.click(screen.getByRole('button', { name: 'Listo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Quitar RFC' }))
    // Un nombre fijo no se admite.
    fireEvent.change(screen.getByLabelText('Nombre del campo nuevo'), { target: { value: 'Concepto' } })
    expect(screen.getByRole('alert').textContent).toBe('Ese campo ya es una columna de la tabla.')

    fireEvent.click(screen.getByRole('button', { name: 'Guardar campos' }))
    await waitFor(() => expect(guardarMock).toHaveBeenCalledTimes(1))
    expect(guardarMock.mock.calls[0][0].map((campo: CampoPlantilla) => [campo.nombre, campo.origen, campo.alcance])).toEqual([
      ['Sucursal', 'manual', 'documento'],
      ['Cliente', 'manual', 'documento'],
    ])
    expect(fijarMock).toHaveBeenCalled()
    expect(onNotice).toHaveBeenCalled()
  })

  it('una configuración ya guardada no muestra el aviso de precarga y solo se guarda con cambios', async () => {
    plantilla = { ...plantilla, configurada: true }
    render(<TarjetaCamposConfigurados onNotice={vi.fn()} onError={vi.fn()} />)
    const guardar = await screen.findByRole('button', { name: 'Guardar campos' })
    await waitFor(() => expect((guardar as HTMLButtonElement).disabled).toBe(true))
    expect(screen.queryByText(/Lista precargada/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Quitar Sucursal' }))
    expect((guardar as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByText('Cambios sin guardar')).toBeTruthy()
  })
})
