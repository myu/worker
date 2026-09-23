import { describe, expect, it } from 'vitest'
import { dashscopeUrl, normalizeProviderStatus } from '../src/index.js'

describe('DashScope worker helpers', () => {
  it('builds API URLs without duplicating /api/v1', () => {
    expect(dashscopeUrl('https://dashscope.aliyuncs.com', 'tasks/abc'))
      .toBe('https://dashscope.aliyuncs.com/api/v1/tasks/abc')
    expect(dashscopeUrl('https://dashscope.aliyuncs.com/api/v1', 'tasks/abc'))
      .toBe('https://dashscope.aliyuncs.com/api/v1/tasks/abc')
  })

  it('normalizes asynchronous task statuses', () => {
    expect(normalizeProviderStatus('PENDING')).toBe('queued')
    expect(normalizeProviderStatus('RUNNING')).toBe('running')
    expect(normalizeProviderStatus('SUCCEEDED')).toBe('succeeded')
    expect(normalizeProviderStatus('FAILED')).toBe('failed')
    expect(normalizeProviderStatus('CANCELED')).toBe('cancelled')
  })
})
