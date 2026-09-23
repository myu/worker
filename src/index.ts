import { spawnSync } from 'node:child_process'
import process from 'node:process'

export interface WorkerEnvironment {
  jobId: string
  supabaseUrl: string
  supabaseServiceRoleKey: string
  storageEndpoint: string
  storageRegion: string
  storageBucket: string
  storageAccessKeyId: string
  storageSecretAccessKey: string
}

export function readWorkerEnvironment(
  source: NodeJS.ProcessEnv = process.env
): WorkerEnvironment {
  const required = {
    jobId: source.JOB_ID,
    supabaseUrl: source.SUPABASE_URL,
    supabaseServiceRoleKey: source.SUPABASE_SERVICE_ROLE_KEY,
    storageEndpoint: source.STORAGE_ENDPOINT,
    storageRegion: source.STORAGE_REGION,
    storageBucket: source.STORAGE_BUCKET,
    storageAccessKeyId: source.STORAGE_ACCESS_KEY_ID,
    storageSecretAccessKey: source.STORAGE_SECRET_ACCESS_KEY
  }

  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key)

  if (missing.length) {
    throw new Error(`Missing worker environment: ${missing.join(', ')}`)
  }

  return required as WorkerEnvironment
}

export function checkFfmpeg(command = 'ffmpeg') {
  const result = spawnSync(command, ['-version'], {
    encoding: 'utf8',
    timeout: 10_000
  })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    throw new Error(result.stderr || `ffmpeg exited with ${result.status}`)
  }

  return result.stdout.split('\n')[0] || 'ffmpeg available'
}

function main() {
  const command = process.argv[2] || 'run'

  if (command === 'check') {
    console.log(`[INFO] ${checkFfmpeg(process.env.FFMPEG_PATH || 'ffmpeg')}`)
    console.log('[INFO] media-worker Phase 0 skeleton is ready')
    return
  }

  if (command === 'run') {
    const env = readWorkerEnvironment()
    console.log(`[INFO] accepted job ${env.jobId}`)
    console.log('[INFO] Phase 0 does not execute media jobs yet')
    return
  }

  throw new Error(`Unknown worker command: ${command}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main()
  } catch (error) {
    console.error(`[ERROR] ${(error as Error).message}`)
    process.exitCode = 1
  }
}
