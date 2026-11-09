import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/** Sirve (en desarrollo) y copia (en el build) las fuentes estándar y los wasm de pdf.js bajo /pdfjs/. */
function recursosPdfjs(): Plugin {
  const carpetas = ['standard_fonts', 'wasm'].map((nombre) => ({ nombre, ruta: resolve('node_modules/pdfjs-dist', nombre) }))
  return {
    name: 'nexora-recursos-pdfjs',
    configureServer(server) {
      for (const { nombre, ruta } of carpetas) {
        server.middlewares.use(`/pdfjs/${nombre}/`, (req, res, next) => {
          const archivo = join(ruta, basename(decodeURIComponent((req.url ?? '').split('?')[0])))
          if (!existsSync(archivo)) return next()
          res.setHeader('Content-Type', archivo.endsWith('.wasm') ? 'application/wasm' : archivo.endsWith('.js') ? 'text/javascript' : 'application/octet-stream')
          createReadStream(archivo).pipe(res)
        })
      }
    },
    generateBundle() {
      for (const { nombre, ruta } of carpetas) {
        for (const archivo of readdirSync(ruta)) {
          if (archivo.startsWith('LICENSE')) continue
          this.emitFile({ type: 'asset', fileName: `pdfjs/${nombre}/${archivo}`, source: readFileSync(join(ruta, archivo)) })
        }
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), recursosPdfjs()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8000',
    },
  },
})
