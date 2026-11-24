// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReglasCampo } from './TiposDocumento'
import { textoCamposPorTipo } from './services/estadoAutomatico'
import { solicitudDe, textoDeteccion, type TipoDocumento } from './services/tiposDocumentoApi'
import type { CampoPlantilla } from './services/plantillaCampos'

afterEach(() => cleanup())

const campo: CampoPlantilla = { id: 'pl-placas', nombre: 'Placas', origen: 'manual', alcance: 'documento' }

describe('reglas de extracción sin IA', () => {
  it('edita sinónimos, regex y obligatorio de un campo', () => {
    const onCambio = vi.fn()
    render(<ReglasCampo campo={campo} onCambio={onCambio} />)
    fireEvent.change(screen.getByLabelText('Sinónimos de Placas'), { target: { value: 'Matrícula, Placa ,' } })
    expect(onCambio).toHaveBeenLastCalledWith({ sinonimos: ['Matrícula', 'Placa'] })
    fireEvent.change(screen.getByLabelText('Regex de Placas'), { target: { value: 'PLACAS[:\\s]+(\\S+)' } })
    expect(onCambio).toHaveBeenLastCalledWith({ regex: 'PLACAS[:\\s]+(\\S+)' })
    fireEvent.click(screen.getByLabelText('Placas es obligatorio'))
    expect(onCambio).toHaveBeenLastCalledWith({ obligatorio: true })
  })

  it('avisa si la regex no es válida', () => {
    render(<ReglasCampo campo={{ ...campo, regex: '(sin cerrar' }} onCambio={() => undefined} />)
    expect(screen.getByRole('alert').textContent).toContain('no es válida')
  })

  it('el modo del tipo viaja al guardar', () => {
    const tipo = { id: 't', nombre: 'Autos', codigo: 'A', color: '#000000', seccion: null, campos: [], estructuras: [], contable: false, modo: 'ia' } as unknown as TipoDocumento
    expect(solicitudDe(tipo).modo).toBe('ia')
    expect(textoDeteccion({ metodo: 'texto' } as never)).toBe('Por el texto del documento (sin IA)')
  })

  it('Automatización muestra los campos de cada tipo con su modo', () => {
    expect(textoCamposPorTipo([
      { nombre: 'Autos individuales', modo: 'manual', campos: ['Número de póliza', 'Placas'] },
      { nombre: 'Fianzas', modo: 'ia', campos: [] },
    ])).toEqual(['Autos individuales (manual, sin IA): Número de póliza, Placas', 'Fianzas (IA): sin campos configurados'])
  })
})
