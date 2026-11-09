import { describe, expect, it } from 'vitest'
import { estadoPestana, leerArchivos, urlExtraccionLote } from './pestanasExtraccion'
import type { ArchivoSeleccionado } from './seleccionAdjuntos'

const seleccionado = (messageId: string, partId: string, filename = `${partId}.pdf`): ArchivoSeleccionado => ({ messageId, attachmentId: `att-${partId}`, partId, filename, mimeType: 'application/pdf' })
const parametros = (url: string) => new URL(url, 'http://localhost').searchParams

describe('archivos de la pantalla de Extracción', () => {
  it('el lote va y vuelve por la URL, en orden y con nombres con caracteres especiales', () => {
    const url = urlExtraccionLote([seleccionado('m1', '1', 'Edo Cta & más #1.pdf'), seleccionado('m2', '2')])
    expect(url.startsWith('/extraction?mode=gemini&doc=')).toBe(true)
    const { archivos, lote } = leerArchivos(parametros(url))
    expect(lote).toBe(true)
    expect(archivos).toEqual([
      { clave: 'm1:1', messageId: 'm1', attachmentId: 'att-1', partId: '1', filename: 'Edo Cta & más #1.pdf' },
      { clave: 'm2:2', messageId: 'm2', attachmentId: 'att-2', partId: '2', filename: '2.pdf' },
    ])
  })

  it('el enlace antiguo abre una sola pestaña sin extracción automática', () => {
    const { archivos, lote } = leerArchivos(parametros('/extraction?message=m1&attachment=a1&part=3&filename=estado.pdf'))
    expect(lote).toBe(false)
    expect(archivos).toEqual([{ clave: 'm1:3', messageId: 'm1', attachmentId: 'a1', partId: '3', filename: 'estado.pdf' }])
    expect(leerArchivos(parametros('/extraction?message=m1&attachment=a1')).archivos[0]).toMatchObject({ clave: 'm1:a1', partId: null })
    expect(leerArchivos(parametros('/extraction')).archivos).toEqual([])
  })

  it('ignora entradas dañadas o repetidas', () => {
    const params = new URLSearchParams()
    params.append('doc', 'no es json')
    params.append('doc', JSON.stringify(['m1', 'a1', '', 'sin-part.pdf']))
    params.append('doc', JSON.stringify(['m1', 'a1', '1', 'x.pdf']))
    params.append('doc', JSON.stringify(['m1', 'a1-otro', '1', 'x.pdf']))
    expect(leerArchivos(params).archivos.map((archivo) => archivo.clave)).toEqual(['m1:1'])
  })

  it('no admite más de 20 archivos', () => {
    const muchos = Array.from({ length: 25 }, (_, indice) => seleccionado('m', String(indice)))
    expect(leerArchivos(parametros(urlExtraccionLote(muchos))).archivos).toHaveLength(20)
  })

  it('estado de la pestaña: la cola manda mientras trabaja; después, lo guardado', () => {
    expect(estadoPestana('en_cola', undefined, null)).toBe('en_cola')
    expect(estadoPestana('extrayendo', null, null)).toBe('extrayendo')
    expect(estadoPestana('error', null, null)).toBe('error')
    expect(estadoPestana('extraido', null, null)).toBe('extraido')
    // Tras guardar, la pestaña informa el estado guardado.
    expect(estadoPestana('extraido', 'borrador', null)).toBe('borrador')
    // Saltado por estar guardado y la pestaña aún no se abrió.
    expect(estadoPestana('guardado', undefined, 'revisado')).toBe('revisado')
    expect(estadoPestana('borrador_local', null, null)).toBe('borrador_local')
    expect(estadoPestana(undefined, 'enviado', null)).toBe('enviado')
    expect(estadoPestana(undefined, null, null)).toBe('sin_extraer')
  })
})
