/**
 * PDF mínimo (PDF 1.4, Helvetica estándar) para pruebas: el mismo enfoque que backend/tests/fixtures/
 * generar_pdf_prueba.py. Solo se usa en pruebas; la aplicación no lo importa.
 */
export type LineaPdf = [x: number, y: number, tamano: number, texto: string]

const escapar = (texto: string) => texto.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')

/** Cada página es una lista de textos con su posición (origen PDF: abajo a la izquierda), o null para una página sin texto. */
export function construirPdf(paginas: (LineaPdf[] | null)[]): Uint8Array {
  const objetos: string[] = ['<< /Type /Catalog /Pages 2 0 R >>', '']
  const hijos: number[] = []
  const fuente = 3
  objetos.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  for (const lineas of paginas) {
    // Una página "escaneada" solo trae un dibujo, sin texto.
    const contenido = lineas ? lineas.map(([x, y, t, texto]) => `BT /F1 ${t} Tf ${x} ${y} Td (${escapar(texto)}) Tj ET`).join('\n') : '0.8 g 50 400 500 300 re f'
    objetos.push(`<< /Length ${contenido.length} >>\nstream\n${contenido}\nendstream`)
    const contenidoId = objetos.length
    objetos.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 ${fuente} 0 R >> >> /Contents ${contenidoId} 0 R >>`)
    hijos.push(objetos.length)
  }
  objetos[1] = `<< /Type /Pages /Kids [${hijos.map((id) => `${id} 0 R`).join(' ')}] /Count ${hijos.length} >>`
  let salida = '%PDF-1.4\n'
  const posiciones: number[] = []
  objetos.forEach((cuerpo, indice) => {
    posiciones.push(salida.length)
    salida += `${indice + 1} 0 obj\n${cuerpo}\nendobj\n`
  })
  const inicioXref = salida.length
  salida += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`
  for (const posicion of posiciones) salida += `${String(posicion).padStart(10, '0')} 00000 n \n`
  salida += `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R >>\nstartxref\n${inicioXref}\n%%EOF\n`
  return Uint8Array.from(salida, (caracter) => caracter.charCodeAt(0) & 0xff)
}
