# Docker Deployment Guide

## Local Development with Docker

### Prerequisites
- Docker installed
- Docker Compose installed

### Quick Start

1. **Build and Run with Docker Compose:**
```bash
# Set your Anthropic API key
export ANTHROPIC_API_KEY=your_key_here

# Build and start
docker-compose up -d

# View logs
docker-compose logs -f backend

# Stop
docker-compose down
```

2. **Manual Docker Build:**
```bash
# Build image
docker build -t resume-generator-backend .

# Run container
docker run -d \
  -p 3000:3000 \
  -e ANTHROPIC_API_KEY=your_key_here \
  -e PORT=3000 \
  --name resume-backend \
  resume-generator-backend

# View logs
docker logs -f resume-backend

# Stop
docker stop resume-backend
docker rm resume-backend
```

## Railway Deployment

### Step 1: Login to Railway
```bash
railway login --browserless
```
Visit the provided URL and enter the pairing code.

### Step 2: Initialize Project
```bash
# Link to existing project or create new
railway init

# Or link to existing
railway link
```

### Step 3: Set Environment Variables
```bash
railway variables set ANTHROPIC_API_KEY=your_key_here
railway variables set PORT=3000
railway variables set LATEX_COMPILER=remote
railway variables set ANTHROPIC_TIMEOUT_MS=120000
```

### Step 4: Deploy
```bash
railway up
```

### Step 5: Get Deployment URL
```bash
railway status
railway domain
```

### Step 6: Update Extension
Update your Chrome extension options with the Railway URL:
```
https://your-app.up.railway.app
```

## Environment Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `ANTHROPIC_API_KEY` | Your Anthropic API key | - | ✅ Yes |
| `PORT` | Server port | 3000 | No |
| `LATEX_COMPILER` | `local` or `remote` | remote | No |
| `LATEX_ENGINE` | LaTeX engine (if local) | pdflatex | No |
| `ANTHROPIC_TIMEOUT_MS` | API timeout | 120000 | No |

## Health Check

The backend exposes a health endpoint:
```bash
curl https://your-app.up.railway.app/health
```

Response:
```json
{
  "status": "ok",
  "timestamp": "2026-02-05T..."
}
```

## Troubleshooting

### Docker Build Issues
```bash
# Clean build
docker build --no-cache -t resume-generator-backend .

# Check logs
docker logs resume-backend

# Enter container
docker exec -it resume-backend sh
```

### Railway Deployment Issues
```bash
# Check logs
railway logs

# Redeploy
railway up --detach

# Check service status
railway status
```

## Production Considerations

1. **API Key Security**: Never commit `.env` files. Use Railway's secrets/variables.
2. **LaTeX Compiler**: Use `LATEX_COMPILER=remote` unless you need local compilation.
3. **Scaling**: Railway auto-scales. Monitor usage in Railway dashboard.
4. **Monitoring**: Check logs regularly: `railway logs -f`
5. **Updates**: Deploy with `railway up` after code changes.

## Cost Optimization

- Railway free tier: 500 hours/month
- Anthropic API: ~$0.003/resume (Claude 4.5 Sonnet)
- Estimated cost: ~$10/month for moderate use

## Backup and Recovery

```bash
# Backup output directory
docker cp resume-backend:/app/output ./backup/

# Restore
docker cp ./backup/output resume-backend:/app/
```
