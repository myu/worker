# Product Video Media Worker

Public Docker worker for ProductVideoAI media jobs.

## Local verification

```bash
npm ci
npm test
npm run build
docker build --platform linux/amd64 -t product-video-media-worker:local .
docker run --rm product-video-media-worker:local check
```

## Runtime contract

The worker is invoked with an explicit job identity and provider configuration:

```text
JOB_ID
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
STORAGE_ENDPOINT
STORAGE_REGION
STORAGE_BUCKET
STORAGE_ACCESS_KEY_ID
STORAGE_SECRET_ACCESS_KEY
STORAGE_ROOT_PATH
```

Secrets are injected by the executor at runtime and must never be committed or passed as command-line arguments.
