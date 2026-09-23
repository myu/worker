import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export interface WorkerEnvironment {
  jobId: string
  stepId: string
  attemptId: string
  supabaseUrl: string
  supabaseServiceRoleKey: string
  storageEndpoint: string
  storageRegion: string
  storageBucket: string
  storageAccessKeyId: string
  storageSecretAccessKey: string
  storageRootPath: string
  workDir: string
}

export function readWorkerEnvironment(
  source: NodeJS.ProcessEnv = process.env
): WorkerEnvironment {
  const required = {
    jobId: source.JOB_ID,
    stepId: source.STEP_ID,
    attemptId: source.ATTEMPT_ID,
    supabaseUrl: source.SUPABASE_URL,
    supabaseServiceRoleKey: source.SUPABASE_SERVICE_ROLE_KEY,
    storageEndpoint: source.STORAGE_ENDPOINT,
    storageRegion: source.STORAGE_REGION,
    storageBucket: source.STORAGE_BUCKET,
    storageAccessKeyId: source.STORAGE_ACCESS_KEY_ID,
    storageSecretAccessKey: source.STORAGE_SECRET_ACCESS_KEY,
    storageRootPath: source.STORAGE_ROOT_PATH || '',
    workDir: source.WORK_DIR || '/workspace'
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

  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr || `ffmpeg exited with ${result.status}`)
  return result.stdout.split('\n')[0] || 'ffmpeg available'
}

function run(command: string, args: string[], timeoutMs = 10 * 60 * 1000) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status}: ${(result.stderr || '').trim()}`)
  }
  return result.stdout
}


function resolveStorageKey(env: WorkerEnvironment, key: string) {
  const root = env.storageRootPath.replace(/^\/+|\/+$/g, '')
  const normalized = key.replace(/^\/+/, '')
  if (!root || normalized === root || normalized.startsWith(`${root}/`)) return normalized
  return `${root}/${normalized}`
}

function createStorageClient(env: WorkerEnvironment) {
  const forcePathStyle = !env.storageEndpoint.includes('myqcloud.com') && !env.storageEndpoint.includes('aliyuncs.com')
  return new S3Client({
    endpoint: env.storageEndpoint,
    region: env.storageRegion,
    credentials: {
      accessKeyId: env.storageAccessKeyId,
      secretAccessKey: env.storageSecretAccessKey
    },
    forcePathStyle
  })
}

async function downloadObject(env: WorkerEnvironment, key: string, target: string) {
  const client = createStorageClient(env)
  const result = await client.send(new GetObjectCommand({ Bucket: env.storageBucket, Key: resolveStorageKey(env, key) }))
  if (!result.Body) throw new Error(`Storage object has no body: ${key}`)
  const bytes = await result.Body.transformToByteArray()
  fs.writeFileSync(target, bytes)
  return { sizeBytes: bytes.byteLength, contentType: result.ContentType || 'application/octet-stream' }
}

async function uploadObject(env: WorkerEnvironment, key: string, source: string, contentType: string) {
  const client = createStorageClient(env)
  const body = fs.readFileSync(source)
  await client.send(new PutObjectCommand({
    Bucket: env.storageBucket,
    Key: resolveStorageKey(env, key),
    Body: body,
    ContentType: contentType
  }))
  return { key, sizeBytes: body.byteLength, contentType }
}

function isImage(payload: Record<string, any>, detectedContentType: string) {
  const contentType = String(payload.content_type || detectedContentType || '')
  return contentType.startsWith('image/') || /\.(jpe?g|png|webp|gif|avif|heic|heif)$/i.test(String(payload.input_key || ''))
}

function probeMedia(inputPath: string) {
  const output = run('ffprobe', [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    inputPath
  ], 60_000)
  return JSON.parse(output) as Record<string, unknown>
}

function transcodeVideo(inputPath: string, outputPath: string, payload: Record<string, any>, inputIsImage: boolean) {
  if (inputIsImage) {
    const duration = Math.max(1, Number(payload.duration_seconds || 3))
    run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-loop', '1',
      '-i', inputPath,
      '-t', String(duration),
      '-vf', 'scale=1080:-2:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black',
      '-r', '30',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-an',
      outputPath
    ])
    return
  }

  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-i', inputPath,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    outputPath
  ])
}

function generateThumbnail(inputPath: string, outputPath: string, inputIsImage: boolean) {
  if (inputIsImage) {
    run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-i', inputPath,
      '-vf', 'scale=640:-2:force_original_aspect_ratio=decrease',
      '-frames:v', '1',
      outputPath
    ])
    return
  }

  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-ss', '1',
    '-i', inputPath,
    '-frames:v', '1',
    '-vf', 'scale=640:-2:force_original_aspect_ratio=decrease',
    outputPath
  ])
}

async function verifyAttempt(supabase: SupabaseClient, env: WorkerEnvironment) {
  const [{ data: step, error: stepError }, { data: attempt, error: attemptError }] = await Promise.all([
    supabase.from('job_steps').select('*').eq('id', env.stepId).eq('video_job_id', env.jobId).single(),
    supabase.from('job_attempts').select('*').eq('id', env.attemptId).eq('job_step_id', env.stepId).single()
  ])
  if (stepError || !step) throw new Error('Job step not found')
  if (attemptError || !attempt) throw new Error('Job attempt not found')
  if (step.status !== 'running' || attempt.status !== 'running') return null
  return step
}

async function checkpointCancellation(supabase: SupabaseClient, jobId: string) {
  const { data } = await supabase.from('video_jobs').select('status, cancel_requested_at').eq('id', jobId).single()
  if (data?.status === 'cancelled' || data?.cancel_requested_at) {
    throw Object.assign(new Error('Job cancelled'), { code: 'JOB_CANCELLED' })
  }
}

async function execute(env: WorkerEnvironment) {
  const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  })
  const step = await verifyAttempt(supabase, env)
  if (!step) return

  const workingDir = path.join(env.workDir, env.jobId, env.stepId)
  fs.mkdirSync(workingDir, { recursive: true })

  try {
    await checkpointCancellation(supabase, env.jobId)
    const payload = (step.payload || {}) as Record<string, any>
    const inputKey = String(payload.input_key || '')
    if (!inputKey) throw new Error('Job step payload is missing input_key')
    const inputExtension = path.extname(inputKey).slice(0, 12) || '.bin'
    const inputPath = path.join(workingDir, `input${inputExtension}`)
    const downloaded = await downloadObject(env, inputKey, inputPath)
    const inputIsImage = isImage(payload, downloaded.contentType)

    let output: Record<string, unknown>
    if (step.step_type === 'probe_media') {
      output = {
        input: { key: inputKey, size_bytes: downloaded.sizeBytes, content_type: downloaded.contentType },
        probe: probeMedia(inputPath)
      }
    } else if (step.step_type === 'transcode_video') {
      const outputKey = String(payload.output_key || '')
      if (!outputKey) throw new Error('Job step payload is missing output_key')
      const outputPath = path.join(workingDir, 'video.mp4')
      await checkpointCancellation(supabase, env.jobId)
      transcodeVideo(inputPath, outputPath, payload, inputIsImage)
      const uploaded = await uploadObject(env, outputKey, outputPath, 'video/mp4')
      output = { input_key: inputKey, output_key: outputKey, content_type: 'video/mp4', size_bytes: uploaded.sizeBytes }
    } else if (step.step_type === 'generate_thumbnail') {
      const outputKey = String(payload.output_key || '')
      if (!outputKey) throw new Error('Job step payload is missing output_key')
      const outputPath = path.join(workingDir, 'thumbnail.jpg')
      await checkpointCancellation(supabase, env.jobId)
      generateThumbnail(inputPath, outputPath, inputIsImage)
      const uploaded = await uploadObject(env, outputKey, outputPath, 'image/jpeg')
      output = { input_key: inputKey, output_key: outputKey, content_type: 'image/jpeg', size_bytes: uploaded.sizeBytes }
    } else {
      throw new Error(`Unsupported media step type: ${step.step_type}`)
    }

    const { error } = await supabase.rpc('complete_job_step', {
      p_step_id: env.stepId,
      p_attempt_id: env.attemptId,
      p_output: output
    })
    if (error) throw new Error(`Unable to complete job step: ${error.message}`)
  } catch (error: any) {
    const errorCode = error?.code === 'JOB_CANCELLED' ? 'JOB_CANCELLED' : 'MEDIA_STEP_FAILED'
    await supabase.rpc('fail_job_step', {
      p_step_id: env.stepId,
      p_attempt_id: env.attemptId,
      p_error_code: errorCode,
      p_error_message: error?.message || 'Media worker failed'
    })
    throw error
  } finally {
    fs.rmSync(workingDir, { recursive: true, force: true })
  }
}

function main() {
  const command = process.argv[2] || 'run'
  if (command === 'check') {
    console.log(`[INFO] ${checkFfmpeg(process.env.FFMPEG_PATH || 'ffmpeg')}`)
    console.log('[INFO] media-worker Phase 5 is ready')
    return
  }
  if (command === 'run') {
    const env = readWorkerEnvironment()
    console.log(`[INFO] accepted job ${env.jobId} step ${env.stepId} attempt ${env.attemptId}`)
    execute(env).catch((error) => {
      console.error(`[ERROR] ${error.message}`)
      process.exitCode = 1
    })
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
