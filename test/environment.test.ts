import { describe, expect, it } from 'vitest'
import { readWorkerEnvironment } from '../src/index.js'

const completeEnvironment = {
  JOB_ID: 'job-1',
  STEP_ID: 'step-1',
  ATTEMPT_ID: 'attempt-1',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  STORAGE_ENDPOINT: 'https://storage.example.com',
  STORAGE_REGION: 'ap-singapore',
  STORAGE_BUCKET: 'bucket',
  STORAGE_ACCESS_KEY_ID: 'access',
  STORAGE_SECRET_ACCESS_KEY: 'secret'
}

describe('readWorkerEnvironment', () => {
  it('reports missing values', () => {
    expect(() => readWorkerEnvironment({})).toThrow(/Missing worker environment/)
  })

  it('returns a complete environment', () => {
    expect(readWorkerEnvironment(completeEnvironment).jobId).toBe('job-1')
    expect(readWorkerEnvironment(completeEnvironment).stepId).toBe('step-1')
  })
})
