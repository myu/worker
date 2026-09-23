import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export interface WorkerEnvironment {
  jobId: string
  stepId: string
  attemptId: string
  supabaseUrl: string
  supabaseServiceRoleKey: string
  supabaseFetchHostIp: string
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

  return { ...required, supabaseFetchHostIp: source.SUPABASE_FETCH_HOST_IP || '' } as WorkerEnvironment
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

function createSupabaseClient(env: WorkerEnvironment) {
  const hostIps = env.supabaseFetchHostIp.split(',').map(value => value.trim()).filter(Boolean)
  const dispatchers: Array<Dispatcher | undefined> = hostIps.length
    ? [
        ...hostIps.map((hostIp) => new Agent({
          connect: {
            lookup(hostname, options, callback) {
              if (hostname.endsWith('.supabase.co')) {
                if (options && typeof options === 'object' && 'all' in options && options.all) {
                  callback(null, [{ address: hostIp, family: 4 }])
                  return
                }
                callback(null, hostIp, 4)
                return
              }
              callback(new Error(`Unexpected host ${hostname}`), '', 4)
            }
          }
        })),
        undefined
      ]
    : [undefined]
  const attempts = Array.from({ length: 8 }, () => dispatchers).flat()

  const customFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    let lastError: unknown
    for (let index = 0; index < attempts.length; index += 1) {
      const dispatcher = attempts[index]
      const requestInput = input instanceof Request ? input.clone() : input
      try {
        const response = await undiciFetch(requestInput as any, {
          ...init,
          ...(dispatcher ? { dispatcher } : {})
        } as any)
        if (response.status >= 500 && index < attempts.length - 1) {
          await response.body?.cancel().catch(() => {})
          continue
        }
        return response
      } catch (error) {
        lastError = error
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
    }
    throw lastError
  }

  return createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: customFetch as any }
  })
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
  if (stepError || !step) throw new Error(`Job step not found: ${stepError?.message || 'no row'}`)
  if (attemptError || !attempt) throw new Error(`Job attempt not found: ${attemptError?.message || 'no row'}`)
  if (step.status !== 'running' || attempt.status !== 'running') return null
  return step
}

async function checkpointCancellation(supabase: SupabaseClient, jobId: string) {
  const { data } = await supabase.from('video_jobs').select('status, cancel_requested_at').eq('id', jobId).single()
  if (data?.status === 'cancelled' || data?.cancel_requested_at) {
    throw Object.assign(new Error('Job cancelled'), { code: 'JOB_CANCELLED' })
  }
}

interface AiVideoProviderRow {
  id: string
  name: string
  api_type: string
  api_key: string
  base_url: string
  models: string[]
  video_cost_per_second: number | null
}

export function dashscopeUrl(baseUrl: string, path: string) {
  const base = baseUrl.trim().replace(/\/+$/, '')
  const cleanPath = path.replace(/^\/+/, '')
  return /\/api\/v1$/i.test(base) ? `${base}/${cleanPath}` : `${base}/api/v1/${cleanPath}`
}

async function getAiVideoProvider(supabase: SupabaseClient, providerId: string) {
  const { data, error } = await supabase
    .from('ai_providers')
    .select('id, name, api_type, api_key, base_url, models, video_cost_per_second')
    .eq('id', providerId)
    .single()
  if (error || !data || !data.api_key || !data.base_url || !data.models?.length) {
    throw Object.assign(new Error('AI video provider configuration is incomplete'), { code: 'PROVIDER_CONFIG_INVALID' })
  }
  return data as AiVideoProviderRow
}

async function dashscopeRequest<T>(provider: AiVideoProviderRow, path: string, init: RequestInit = {}) {
  const response = await fetch(dashscopeUrl(provider.base_url, path), {
    ...init,
    headers: {
      Authorization: `Bearer ${provider.api_key}`,
      'Content-Type': 'application/json',
      ...(init.headers || {})
    },
    signal: init.signal || AbortSignal.timeout(60_000)
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || payload?.code) {
    throw Object.assign(new Error(payload?.message || `DashScope request failed: ${response.status}`), {
      status: response.status,
      data: payload,
      providerCode: payload?.code
    })
  }
  return payload as T
}

export function normalizeProviderStatus(status: unknown) {
  const value = String(status || '').toUpperCase()
  if (['PENDING', 'QUEUED', 'SUBMITTED'].includes(value)) return 'queued'
  if (['RUNNING', 'PROCESSING'].includes(value)) return 'running'
  if (['SUCCEEDED', 'SUCCESS', 'COMPLETED'].includes(value)) return 'succeeded'
  if (['FAILED', 'ERROR'].includes(value)) return 'failed'
  if (['CANCELED', 'CANCELLED'].includes(value)) return 'cancelled'
  return 'unknown'
}

function normalizeProviderError(error: any) {
  const code = String(error?.providerCode || error?.data?.code || error?.code || '').toLowerCase()
  const message = error?.data?.message || error?.message || 'AI video provider failed'
  const status = Number(error?.status || 0)
  if (status === 401 || code.includes('invalidapikey') || code.includes('authentication')) return { code: 'AUTH_FAILED', message, retryable: false }
  if (status === 429 || code.includes('throttling') || code.includes('rate')) return { code: 'RATE_LIMITED', message, retryable: true }
  if (code.includes('quota') || code.includes('balance') || code.includes('arrearage')) return { code: 'QUOTA_EXCEEDED', message, retryable: false }
  if (code.includes('datainspection') || code.includes('content')) return { code: 'CONTENT_REJECTED', message, retryable: false }
  if (status >= 500 || code.includes('internal')) return { code: 'PROVIDER_UNAVAILABLE', message, retryable: true }
  return { code: 'GENERATION_FAILED', message, retryable: false }
}

async function getProviderVideoJob(supabase: SupabaseClient, jobId: string) {
  const { data, error } = await supabase
    .from('provider_video_jobs')
    .select('*')
    .eq('video_job_id', jobId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`Unable to load provider video job: ${error.message}`)
  return data
}

async function getProviderVideoJobByStep(supabase: SupabaseClient, stepId: string) {
  const { data, error } = await supabase
    .from('provider_video_jobs')
    .select('*')
    .eq('job_step_id', stepId)
    .maybeSingle()
  if (error) throw new Error(`Unable to load provider video step: ${error.message}`)
  return data
}

async function updateProviderVideoJob(supabase: SupabaseClient, id: string, values: Record<string, unknown>) {
  const { error } = await supabase.from('provider_video_jobs').update(values).eq('id', id)
  if (error) throw new Error(`Unable to update provider video job: ${error.message}`)
}

async function downloadProviderUrl(requestUrl: string, target: string, maxBytes = 500 * 1024 * 1024) {
  const response = await fetch(requestUrl, { signal: AbortSignal.timeout(15 * 60 * 1000) })
  if (!response.ok) throw new Error(`Unable to download provider output: ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.byteLength > maxBytes) throw new Error(`Provider output exceeds ${maxBytes} bytes`)
  fs.writeFileSync(target, bytes)
  return { sizeBytes: bytes.byteLength, contentType: response.headers.get('content-type') || 'video/mp4' }
}

function normalizeVideoDimensions(aspectRatio: string) {
  if (aspectRatio === '16:9') return { width: 1920, height: 1080, filter: 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black' }
  if (aspectRatio === '1:1') return { width: 1080, height: 1080, filter: 'scale=1080:1080:force_original_aspect_ratio=decrease,pad=1080:1080:(ow-iw)/2:(oh-ih)/2:color=black' }
  return { width: 1080, height: 1920, filter: 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black' }
}

async function executeAiVideoStep(
  supabase: SupabaseClient,
  env: WorkerEnvironment,
  step: any,
  workingDir: string,
  payload: Record<string, any>
) {
  if (step.step_type === 'prepare_video_prompt') {
    return {
      prompt: String(payload.prompt || ''),
      negative_prompt: String(payload.negative_prompt || ''),
      scene_id: payload.scene_id,
      approved_manifest_hash: payload.approved_manifest_hash
    }
  }

  if (step.step_type === 'submit_video_generation') {
    const existing = await getProviderVideoJobByStep(supabase, env.stepId)
    if (existing?.provider_job_id) {
      return {
        provider_job_id: existing.provider_job_id,
        status: existing.status,
        provider_key: existing.provider_key,
        model: existing.model,
        estimated_cost: existing.estimated_cost,
        deduplicated: true
      }
    }

    const provider = await getAiVideoProvider(supabase, String(payload.provider_id || ''))
    const requestPayload = {
      model: provider.models[0],
      input: {
        prompt: payload.prompt,
        img_url: payload.reference_image_url,
        negative_prompt: payload.negative_prompt
      },
      parameters: {
        resolution: '1080P',
        duration: Number(payload.duration_seconds || 5),
        prompt_extend: true,
        watermark: false
      }
    }
    const response = await dashscopeRequest<{ output?: Record<string, any> }>(
      provider,
      'services/aigc/video-generation/video-synthesis',
      {
        method: 'POST',
        headers: { 'X-DashScope-Async': 'enable' },
        body: JSON.stringify(requestPayload)
      }
    )
    const providerJobId = String(response.output?.task_id || '')
    if (!providerJobId) throw new Error('DashScope did not return task_id')
    const status = normalizeProviderStatus(response.output?.task_status)
    const estimatedCost = Number(payload.estimated_cost || 0)
    const { error } = await supabase.from('provider_video_jobs').upsert({
      workspace_id: step.workspace_id,
      video_job_id: env.jobId,
      job_step_id: env.stepId,
      provider_id: provider.id,
      provider_key: 'dashscope_video',
      model: provider.models[0],
      provider_job_id: providerJobId,
      status,
      request_idempotency_key: step.idempotency_key,
      request_payload: requestPayload,
      response_payload: response,
      estimated_cost: estimatedCost,
      submitted_at: new Date().toISOString()
    }, { onConflict: 'job_step_id' })
    if (error) throw new Error(`Unable to save provider video job: ${error.message}`)

    return {
      provider_job_id: providerJobId,
      status,
      provider_key: 'dashscope_video',
      model: provider.models[0],
      estimated_cost: estimatedCost
    }
  }

  if (step.step_type === 'poll_video_generation') {
    const providerJob = await getProviderVideoJob(supabase, env.jobId)
    if (!providerJob?.provider_job_id) throw new Error('Provider video job has not been submitted')
    const provider = await getAiVideoProvider(supabase, providerJob.provider_id)
    const timeoutMs = Math.max(60, Number(payload.timeout_seconds || 900)) * 1000
    const intervalMs = Math.max(2, Number(payload.poll_interval_seconds || 10)) * 1000
    const deadline = Date.now() + timeoutMs
    let lastStatus = providerJob.status

    while (Date.now() < deadline) {
      await checkpointCancellation(supabase, env.jobId)
      const response = await dashscopeRequest<{ output?: Record<string, any>; usage?: Record<string, unknown> }>(
        provider,
        `tasks/${encodeURIComponent(providerJob.provider_job_id)}`,
        { method: 'GET' }
      )
      const status = normalizeProviderStatus(response.output?.task_status)
      lastStatus = status
      await updateProviderVideoJob(supabase, providerJob.id, {
        status,
        response_payload: response,
        usage: response.usage || {},
        provider_output_url: response.output?.video_url || null,
        provider_reported_duration: response.output?.duration == null ? null : Number(response.output.duration),
        completed_at: ['succeeded', 'failed', 'cancelled'].includes(status) ? new Date().toISOString() : null
      })
      if (status === 'succeeded') {
        return {
          provider_job_id: providerJob.provider_job_id,
          status,
          output_url: response.output?.video_url || null,
          duration_seconds: response.output?.duration == null ? null : Number(response.output.duration),
          usage: response.usage || {}
        }
      }
      if (status === 'failed') {
        const normalized = normalizeProviderError({ data: response.output })
        throw Object.assign(new Error(normalized.message), { code: normalized.code, retryable: normalized.retryable })
      }
      if (status === 'cancelled') throw Object.assign(new Error('Provider video generation was cancelled'), { code: 'JOB_CANCELLED' })
      await new Promise(resolve => setTimeout(resolve, intervalMs))
    }

    throw Object.assign(new Error(`Provider video generation timed out in state ${lastStatus}`), { code: 'TIMEOUT' })
  }

  if (step.step_type === 'download_video_result') {
    const providerJob = await getProviderVideoJob(supabase, env.jobId)
    if (!providerJob?.provider_output_url) throw new Error('Provider video output URL is unavailable')
    const outputKey = String(payload.output_key || '')
    if (!outputKey) throw new Error('Job step payload is missing output_key')
    const outputPath = path.join(workingDir, 'provider.mp4')
    const downloaded = await downloadProviderUrl(providerJob.provider_output_url, outputPath)
    const uploaded = await uploadObject(env, outputKey, outputPath, 'video/mp4')
    await updateProviderVideoJob(supabase, providerJob.id, {
      response_payload: {
        ...(providerJob.response_payload || {}),
        downloaded_key: outputKey,
        downloaded_size_bytes: uploaded.sizeBytes
      }
    })
    return { provider_job_id: providerJob.provider_job_id, output_key: outputKey, size_bytes: downloaded.sizeBytes, content_type: 'video/mp4' }
  }

  if (step.step_type === 'normalize_video_asset') {
    const inputKey = String(payload.input_key || '')
    const outputKey = String(payload.output_key || '')
    if (!inputKey || !outputKey) throw new Error('Normalize step requires input_key and output_key')
    const inputPath = path.join(workingDir, 'provider.mp4')
    const outputPath = path.join(workingDir, 'final.mp4')
    await downloadObject(env, inputKey, inputPath)
    const dimensions = normalizeVideoDimensions(String(payload.aspect_ratio || '9:16'))
    run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-i', inputPath,
      '-vf', dimensions.filter,
      '-r', '30',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '22',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      outputPath
    ])
    const uploaded = await uploadObject(env, outputKey, outputPath, 'video/mp4')
    const { data: videoJob, error: videoJobError } = await supabase
      .from('video_jobs')
      .select('project_id')
      .eq('id', env.jobId)
      .single()
    if (videoJobError || !videoJob?.project_id) throw new Error('Unable to resolve generated video project')
    const { data: asset, error: assetError } = await supabase.from('product_assets').upsert({
      workspace_id: step.workspace_id,
      project_id: videoJob.project_id,
      storage_provider_id: payload.storage_provider_id || null,
      storage_key: outputKey,
      asset_type: 'other',
      status: 'ready',
      mime_type: 'video/mp4',
      width: dimensions.width,
      height: dimensions.height,
      size_bytes: uploaded.sizeBytes,
      ai_selected: false,
      user_selected: false,
      metadata: {
        source: 'ai_video',
        provider_video_job_id: (await getProviderVideoJob(supabase, env.jobId))?.id || null,
        scene_id: payload.scene_id,
        prompt: payload.prompt
      }
    }, { onConflict: 'storage_key' }).select('id, storage_key').single()
    if (assetError || !asset) throw new Error(`Unable to register generated video asset: ${assetError?.message || 'unknown error'}`)
    const providerJob = await getProviderVideoJob(supabase, env.jobId)
    if (providerJob) await updateProviderVideoJob(supabase, providerJob.id, { output_asset_id: asset.id })
    return { output_key: outputKey, asset_id: asset.id, size_bytes: uploaded.sizeBytes, width: dimensions.width, height: dimensions.height }
  }

  throw new Error(`Unsupported AI video step type: ${step.step_type}`)
}

async function execute(env: WorkerEnvironment) {
  const supabase = createSupabaseClient(env)
  const step = await verifyAttempt(supabase, env)
  if (!step) return

  const workingDir = path.join(env.workDir, env.jobId, env.stepId)
  fs.mkdirSync(workingDir, { recursive: true })
  const heartbeat = setInterval(() => {
    const now = new Date().toISOString()
    void Promise.all([
      supabase.from('job_steps').update({ heartbeat_at: now }).eq('id', env.stepId),
      supabase.from('job_attempts').update({ heartbeat_at: now }).eq('id', env.attemptId)
    ])
  }, 30_000)
  heartbeat.unref()

  try {
    await checkpointCancellation(supabase, env.jobId)
    const payload = (step.payload || {}) as Record<string, any>
    let output: Record<string, unknown>

    if (String(step.step_type).startsWith('prepare_video_') || [
      'submit_video_generation',
      'poll_video_generation',
      'download_video_result',
      'normalize_video_asset'
    ].includes(step.step_type)) {
      output = await executeAiVideoStep(supabase, env, step, workingDir, payload)
    } else {
      const inputKey = String(payload.input_key || '')
      if (!inputKey) throw new Error('Job step payload is missing input_key')
      const inputExtension = path.extname(inputKey).slice(0, 12) || '.bin'
      const inputPath = path.join(workingDir, `input${inputExtension}`)
      const downloaded = await downloadObject(env, inputKey, inputPath)
      const inputIsImage = isImage(payload, downloaded.contentType)

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
    }

    const { error } = await supabase.rpc('complete_job_step', {
      p_step_id: env.stepId,
      p_attempt_id: env.attemptId,
      p_output: output
    })
    if (error) throw new Error(`Unable to complete job step: ${error.message}`)
  } catch (error: any) {
    const errorCode = error?.code === 'JOB_CANCELLED'
      ? 'JOB_CANCELLED'
      : error?.code && /^[A-Z_]+$/.test(String(error.code))
        ? String(error.code)
        : 'MEDIA_STEP_FAILED'
    await supabase.rpc('fail_job_step', {
      p_step_id: env.stepId,
      p_attempt_id: env.attemptId,
      p_error_code: errorCode,
      p_error_message: error?.message || 'Media worker failed'
    })
    throw error
  } finally {
    clearInterval(heartbeat)
    fs.rmSync(workingDir, { recursive: true, force: true })
  }
}

function main() {
  const command = process.argv[2] || 'run'
  if (command === 'check') {
    console.log(`[INFO] ${checkFfmpeg(process.env.FFMPEG_PATH || 'ffmpeg')}`)
    console.log('[INFO] media-worker Phase 6 is ready')
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
