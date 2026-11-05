import { beforeEach, describe, expect, it, vi } from 'vitest'

const { statusMock, messagesMock } = vi.hoisted(() => ({ statusMock: vi.fn(), messagesMock: vi.fn() }))
vi.mock('./gmailApi', () => ({ gmailApi: { status: statusMock, messages: messagesMock } }))

import { inboxStore } from './inboxStore'

describe('inboxStore', () => {
  beforeEach(() => {
    inboxStore.clear()
    statusMock.mockReset()
    messagesMock.mockReset()
    messagesMock.mockResolvedValue([{ id: 'm1' }])
  })

  it('shares one in-flight request for concurrent loads of the same folder', async () => {
    const [a, b] = await Promise.all([inboxStore.loadMessages('inbox'), inboxStore.loadMessages('inbox')])
    expect(a).toBe(b)
    expect(messagesMock).toHaveBeenCalledTimes(1)
  })

  it('reuses a fresh listing and refetches when forced', async () => {
    await inboxStore.loadMessages('inbox')
    await inboxStore.loadMessages('inbox')
    expect(messagesMock).toHaveBeenCalledTimes(1)
    await inboxStore.loadMessages('inbox', { force: true })
    expect(messagesMock).toHaveBeenCalledTimes(2)
  })

  it('drops cached messages when the connected account changes', async () => {
    statusMock.mockResolvedValueOnce({ connected: true, provider: 'gmail', email: 'a@example.com' })
    await inboxStore.loadStatus()
    await inboxStore.loadMessages('inbox')
    expect(inboxStore.cachedMessages('inbox')).not.toBeNull()
    statusMock.mockResolvedValueOnce({ connected: true, provider: 'gmail', email: 'b@example.com' })
    await inboxStore.loadStatus()
    expect(inboxStore.cachedMessages('inbox')).toBeNull()
  })
})
