#!/usr/bin/env bash
set -euo pipefail
cd ~/questcord
git fetch --all --prune
git reset --hard origin/main
cd production

# Install dependencies
npm ci --only=production || npm install --only=production

# Deploy bot commands
echo "Deploying Discord bot commands..."
npm run deploy || node scripts/deploy-commands.js

# Restart services
pm2 restart questcord-bot    || pm2 start src/index.js      --name questcord-bot
pm2 restart questcord-worker || pm2 start worker/spawner.js --name questcord-worker
pm2 save

echo "Production deployment completed successfully!"