// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { compararResultados, filtrarComparacion, resumirComparacion, textoOferta } from './services/compararResultados'

const { compararMock, crearVersionMock, reprocesarMock } = vi.hoisted(() => ({ compararMock: vi.fn(), crearVersionMock: vi.fn(), reprocesarMock: vi.fn() }))
vi.mock('./services/compararResultados', async (original) => ({
  ...(await original<typeof import('./services/compararResultados')>()),
  comparacionApi: { comparar: compararMock, crearVersion: crearVersionMock, reprocesarVersion: reprocesarMock },
}))

const { ComparacionIA } = await import('./ComparacionIA')

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('comparación manual vs IA (compareSnapshots / summarizeComparison)', () => {
  it('cinco estados, sin distinguir acentos, mayúsculas ni espacios', () => {
    const filas = compararResultados(
      { Póliza: 'AUT-1', Placas: 'XYZ-123-A', Contratante: 'Cliente  Ficticio', Serie: 'S1', Motor: '' },
      { Póliza: 'AUT-1', Placas: 'XYZ-123-B', Contratante: 'cliente ficticio', Color: 'ROJO', Motor: '' },
      ['Póliza', 'Placas', 'Contratante', 'Serie', 'Motor'],
    )
    expect(Object.fromEntries(filas.map((fila) => [fila.campo, fila.estado]))).toEqual({ Póliza: 'coincide', Placas: 'diferente', Contratante: 'coincide', Serie: 'solo_manual', Motor: 'vacio', Color: 'solo_ia' })
    expect(filas.find((fila) => fila.campo === 'Color')?.configurado).toBe(false)
    expect(resumirComparacion(filas)).toEqual({ coincide: 2, diferente: 1, solo_manual: 1, solo_ia: 1, vacio: 1, total: 6 })
    expect(filtrarComparacion(filas, 'diferente').map((fila) => fila.campo)).toEqual(['Placas'])
    expect(textoOferta(5, 10)).toBe('Tienes 5 campos, la IA encontró 10. ¿Agregar?')
  })
})

const resultado = {
  tipo: { id: 'tipo-a', nombre: 'Autos individuales', codigo: 'A', contable: false },
  estructura: { id: 'est-1', nombre: 'Predeterminada', version_activa: 1, versiones: [1] },
  version_usada: 1,
  campos: [{ nombre: 'Placas', alcance: 'documento' }, { nombre: 'Número de póliza', alcance: 'documento' }],
  manual: { Placas: 'XYZ-123-A', 'Número de póliza': 'AUT-1' },
  ia: { Placas: 'XYZ-123-B', 'Número de póliza': 'AUT-1', Color: 'ROJO' },
  sugerencias: [{ nombre: 'Color', alcance: 'documento', ejemplo: 'ROJO' }],
  campos_configurados: 2,
  ia_encontrados: 3,
  modelo: 'gemini-ficticio',
}

describe('Comparar con IA', () => {
  it('muestra lado a lado, filtra y crea la versión nueva al aceptar', async () => {
    compararMock.mockResolvedValue(resultado)
    crearVersionMock.mockResolvedValue({ version: 2, agregados: ['Color'] })
    reprocesarMock.mockResolvedValue({ version: 2, encontrados: 3, total_campos: 3 })
    const onReprocesado = vi.fn()
    render(<ComparacionIA messageId="m1" partId="1" attachmentId="att" onReprocesado={onReprocesado} />)
    fireEvent.click(screen.getByRole('button', { name: /Comparar con IA/ }))
    const tabla = await screen.findByRole('table')
    expect(within(tabla).getByText('XYZ-123-B')).toBeTruthy()
    expect(within(tabla).getByText('Diferente')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: /Diferente \(1\)/ }))
    expect(within(screen.getByRole('table')).queryByText('AUT-1')).toBeNull()
    expect(screen.getByText('Tienes 2 campos, la IA encontró 3. ¿Agregar?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Agregar y crear la versión nueva/ }))
    await waitFor(() => expect(crearVersionMock).toHaveBeenCalledWith('tipo-a', 'est-1', [{ nombre: 'Color', alcance: 'documento' }]))
    expect((await screen.findByRole('status')).textContent).toContain('versión 2')
    // Ya hay v1 y v2: se puede reprocesar con cualquiera.
    fireEvent.change(screen.getByLabelText('Versión para reprocesar'), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: /^Reprocesar$/ }))
    await waitFor(() => expect(reprocesarMock).toHaveBeenCalledWith('m1', '1', 1, 'att'))
    expect(onReprocesado).toHaveBeenCalled()
  })

  it('si la IA no está disponible lo dice', async () => {
    compararMock.mockRejectedValue(new Error('Gemini no esta configurado: la comparacion necesita la IA.'))
    render(<ComparacionIA messageId="m1" partId="1" attachmentId={null} />)
    fireEvent.click(screen.getByRole('button', { name: /Comparar con IA/ }))
    expect((await screen.findByRole('alert')).textContent).toContain('Gemini no esta configurado')
  })
})
