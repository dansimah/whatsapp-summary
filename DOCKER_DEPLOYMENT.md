# Docker Deployment Guide

## Overview

This guide explains how to deploy the WhatsApp Summary Bot using Docker with proper data persistence.

## Data Persistence Strategy

### ✅ **Data Will Be Preserved** - Here's Why:

The Docker configuration uses **volume mounts** to store data outside the container:

```yaml
volumes:
  - ./data:/app/data          # Database files
  - ./logs:/app/logs          # Application logs  
  - ./sessions:/app/sessions  # WhatsApp authentication sessions
  - ./config.json:/app/config.json:ro  # Configuration (read-only)
```

### What Gets Preserved:
- **Database**: All WhatsApp messages and summaries
- **Sessions**: WhatsApp authentication (no need to scan QR code again)
- **Logs**: Application logs for debugging
- **Configuration**: Bot settings (read-only mount)

### What Gets Lost on Rebuild:
- **Application code**: Will be updated with new version
- **Dependencies**: Will be reinstalled
- **Container state**: Will be reset

## Quick Start

### 1. Prepare Environment
```bash
# Copy environment template
cp env.example .env

# Edit environment variables
nano .env
```

### 2. Build and Run
```bash
# Build the image
docker-compose build

# Start the service
docker-compose up -d

# View logs
docker-compose logs -f
```

### 3. Stop and Restart
```bash
# Stop the service
docker-compose down

# Start again
docker-compose up -d
```

## Development Workflow

### Making Code Changes:
1. **Edit code** in your local directory
2. **Rebuild image**: `docker-compose build`
3. **Restart service**: `docker-compose up -d`
4. **Data preserved**: All messages, sessions, and logs remain

### Making Configuration Changes:
1. **Edit config.json** in your local directory
2. **Restart service**: `docker-compose restart`
3. **No rebuild needed**: Configuration is mounted as read-only

## Data Backup

### Manual Backup:
```bash
# Backup all persistent data
tar -czf backup-$(date +%Y%m%d).tar.gz data/ logs/ sessions/ config.json

# Restore from backup
tar -xzf backup-20250625.tar.gz
```

### Automated Backup (Optional):
Add to your crontab:
```bash
# Daily backup at 2 AM
0 2 * * * cd /path/to/whatsapp-summary && tar -czf backups/backup-$(date +\%Y\%m\%d).tar.gz data/ logs/ sessions/ config.json
```

## Troubleshooting

### Check Container Status:
```bash
# View running containers
docker-compose ps

# Check container health
docker-compose ps --format "table {{.Name}}\t{{.Status}}\t{{.Health}}"
```

### View Logs:
```bash
# All logs
docker-compose logs

# Follow logs in real-time
docker-compose logs -f

# Last 100 lines
docker-compose logs --tail=100
```

### Access Container Shell:
```bash
# Enter running container
docker-compose exec whatsapp-summary-bot sh

# Check data directories
ls -la /app/data
ls -la /app/sessions
```

### Reset Everything (DANGER - Data Loss):
```bash
# Stop and remove everything
docker-compose down -v

# Remove all data
rm -rf data/ logs/ sessions/

# Start fresh
docker-compose up -d
```

## Production Considerations

### Security:
- Use strong passwords in `.env`
- Keep `.env` file secure and never commit to git
- Consider using Docker secrets for sensitive data

### Monitoring:
- Set up log aggregation (ELK stack, etc.)
- Monitor container health and resource usage
- Set up alerts for container failures

### Scaling:
- Current setup is single-instance
- For high availability, consider multiple instances with shared database

## File Structure After Deployment

```
whatsapp-summary/
├── data/                    # Persistent database files
│   ├── messages.db
│   └── messages.db-shm
├── logs/                    # Application logs
│   ├── app.log
│   └── error.log
├── sessions/                # WhatsApp sessions
│   └── session-whatsapp-telegram-bot/
├── config.json              # Configuration (mounted read-only)
├── .env                     # Environment variables
├── docker-compose.yml       # Docker configuration
└── Dockerfile              # Container definition
```

## Environment Variables

Required environment variables in `.env`:
```bash
# Telegram Bot
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_ALLOWED_USERNAME=dansi
TELEGRAM_STATUS_GROUP_ID=your_status_group_id

# Gemini AI
GEMINI_API_KEY=your_gemini_api_key

# WhatsApp
TELEGRAM_LOG_ALL_INTERACTIONS=true
```

## Resource Requirements

### Minimum:
- **CPU**: 0.25 cores
- **Memory**: 512MB
- **Storage**: 1GB (plus data volume)

### Recommended:
- **CPU**: 0.5 cores
- **Memory**: 1GB
- **Storage**: 5GB (plus data volume)

## Updates and Maintenance

### Regular Updates:
```bash
# Pull latest code
git pull

# Rebuild with new code
docker-compose build

# Restart service
docker-compose up -d
```

### Database Maintenance:
```bash
# Access container
docker-compose exec whatsapp-summary-bot sh

# Check database size
ls -lh /app/data/messages.db

# Optional: Compact database
sqlite3 /app/data/messages.db "VACUUM;"
```

## Support

For issues:
1. Check logs: `docker-compose logs -f`
2. Verify data persistence: `ls -la data/ sessions/`
3. Check container health: `docker-compose ps`
4. Review this guide for common solutions 