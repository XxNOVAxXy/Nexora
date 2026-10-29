import type { DocumentItem, Transaction } from '../types'

// This boundary mirrors the future FastAPI resources without making network calls yet.
export const mockApi = {
  documents: [
    { id: 'doc-001', name: 'Comprobante_transferencia_1842.pdf', type: 'PDF', date: 'Hoy, 09:42', size: '248 KB', source: 'Gmail · Finanzas', pages: 1, status: 'En revisión', color: 'coral' },
    { id: 'doc-002', name: 'Estado_cuenta_Banorte_Marzo.pdf', type: 'PDF', date: 'Ayer, 16:20', size: '1.8 MB', source: 'IMAP · Tesorería', pages: 8, status: 'Procesado', color: 'blue' },
    { id: 'doc-003', name: 'Pago_proveedores_abril.jpg', type: 'JPG', date: '22 abr, 11:08', size: '624 KB', source: 'Carga manual', pages: 1, status: 'Pendiente', color: 'amber' },
    { id: 'doc-004', name: 'Recibo_SPEI_99120.png', type: 'PNG', date: '21 abr, 08:35', size: '382 KB', source: 'Gmail · Finanzas', pages: 1, status: 'Procesado', color: 'violet' },
    { id: 'doc-005', name: 'Movimientos_cuenta_abril.pdf', type: 'PDF', date: '19 abr, 17:51', size: '934 KB', source: 'IMAP · Tesorería', pages: 5, status: 'Procesado', color: 'blue' },
    { id: 'doc-006', name: 'Orden_de_pago_webp.webp', type: 'WEBP', date: '17 abr, 14:12', size: '196 KB', source: 'Carga manual', pages: 1, status: 'Pendiente', color: 'emerald' },
  ] satisfies DocumentItem[],
  transactions: [
    { id: 'txn-1', date: '24/04/2024', bank: 'Banco del Centro', sender: 'ACME Servicios, S.A.', beneficiary: 'Nexora Operaciones', origin: '0123 4567 8901', destination: '0987 6543 2109', reference: 'SPEI-184293', concept: 'Pago factura AC-1842', operation: 'Transferencia SPEI', amount: '48,250.00', currency: 'MXN', status: 'Revisar' },
    { id: 'txn-2', date: '23/04/2024', bank: 'Banco del Centro', sender: 'Logística Norte', beneficiary: 'Nexora Operaciones', origin: '0123 4567 8901', destination: '0987 6543 2109', reference: 'SPEI-184101', concept: 'Servicios de abril', operation: 'Transferencia SPEI', amount: '16,800.00', currency: 'MXN', status: 'Borrador' },
  ] satisfies Transaction[],
}
