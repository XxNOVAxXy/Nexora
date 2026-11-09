import { describe, expect, it } from 'vitest'
import type { GmailAttachment } from './gmailApi'
import { crearSeleccion, esSeleccionable } from './seleccionAdjuntos'

const adjunto = (id: string, filename: string, mimeType: string, partId = id): GmailAttachment => ({ id: `att-${id}`, filename, mimeType, size: 1000, partId })
const pdf = (id: string) => adjunto(id, `${id}.pdf`, 'application/pdf')

describe('selección múltiple de adjuntos', () => {
  it('marca adjuntos de varios correos y conserva la selección al cambiar de correo', () => {
    const seleccion = crearSeleccion()
    expect(seleccion.alternar('correo-1', pdf('1'))).toBe('marcado')
    expect(seleccion.alternar('correo-1', adjunto('2', 'foto.jpg', 'image/jpeg'))).toBe('marcado')
    // El usuario abre otro correo: la selección del primero sigue ahí.
    expect(seleccion.alternar('correo-2', pdf('3'))).toBe('marcado')
    expect(seleccion.total()).toBe(3)
    expect(seleccion.contarEnCorreo('correo-1')).toBe(2)
    expect(seleccion.contarEnCorreo('correo-2')).toBe(1)
    expect(seleccion.estaMarcado('correo-1', '1')).toBe(true)
    expect(seleccion.lista().map((archivo) => [archivo.messageId, archivo.partId])).toEqual([['correo-1', '1'], ['correo-1', '2'], ['correo-2', '3']])
  })

  it('el mismo partId en correos distintos son archivos distintos; marcar dos veces desmarca', () => {
    const seleccion = crearSeleccion()
    seleccion.alternar('correo-1', pdf('1'))
    seleccion.alternar('correo-2', pdf('1'))
    expect(seleccion.total()).toBe(2)
    expect(seleccion.alternar('correo-1', pdf('1'))).toBe('desmarcado')
    expect(seleccion.estaMarcado('correo-1', '1')).toBe(false)
    expect(seleccion.estaMarcado('correo-2', '1')).toBe(true)
  })

  it('solo se pueden marcar PDF e imágenes con partId', () => {
    const seleccion = crearSeleccion()
    expect(seleccion.alternar('correo-1', adjunto('1', 'datos.zip', 'application/zip'))).toBe('no_seleccionable')
    expect(seleccion.alternar('correo-1', adjunto('2', 'nota.txt', 'text/plain'))).toBe('no_seleccionable')
    expect(seleccion.alternar('correo-1', adjunto('3', 'estado.pdf', 'application/pdf', ''))).toBe('no_seleccionable')
    expect(esSeleccionable(adjunto('4', 'scan.PNG', 'application/octet-stream'))).toBe(true)
    expect(seleccion.total()).toBe(0)
  })

  it('respeta el límite del lote y permite desmarcar', () => {
    const seleccion = crearSeleccion(2)
    seleccion.alternar('c', pdf('1'))
    seleccion.alternar('c', pdf('2'))
    expect(seleccion.alternar('c', pdf('3'))).toBe('limite')
    expect(seleccion.total()).toBe(2)
    expect(seleccion.alternar('c', pdf('1'))).toBe('desmarcado')
    expect(seleccion.alternar('c', pdf('3'))).toBe('marcado')
  })

  it('limpiar vacía la selección y avisa a los suscriptores', () => {
    const seleccion = crearSeleccion()
    let avisos = 0
    const desuscribir = seleccion.suscribir(() => { avisos += 1 })
    seleccion.alternar('c', pdf('1'))
    const version = seleccion.version()
    seleccion.limpiar()
    expect(seleccion.total()).toBe(0)
    expect(seleccion.version()).toBeGreaterThan(version)
    expect(avisos).toBe(2)
    desuscribir()
  })
})
