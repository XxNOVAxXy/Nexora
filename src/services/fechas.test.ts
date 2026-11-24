import { describe, expect, it } from 'vitest'
import { formatoMexico, ZONA_MEXICO } from './fechas'

describe('fechas en hora de México', () => {
  it('convierte la hora UTC del backend a la hora de México', () => {
    // 18:30 UTC = 12:30 en Ciudad de México (UTC-6, sin horario de verano desde 2022).
    const texto = formatoMexico({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date('2026-11-20T18:30:00+00:00'))
    expect(texto).toBe('12:30')
    expect(formatoMexico({}).resolvedOptions().timeZone).toBe(ZONA_MEXICO)
  })

  it('el cambio de día también se hace en hora de México', () => {
    // 03:00 UTC del 21 todavía es el día 20 en México.
    expect(formatoMexico({ day: 'numeric' }).format(new Date('2026-11-21T03:00:00Z'))).toBe('20')
  })
})
