#!/bin/bash

  echo "🚀 QuestCord Fixed Deployment Script"
  echo "===================================="

  # Go to the actual production directory where files exist
  cd /root/questcord/production

  echo "📂 Working directory: $(pwd)"
  echo "📋 Files in current directory:"
  ls -la scripts/ 2>/dev/null || echo "No scripts directory"

  # Clear ports
  echo "🔧 Clearing ports..."
  fuser -k 3000/tcp 2>/dev/null || echo "Port 3000 clear"
  fuser -k 3001/tcp 2>/dev/null || echo "Port 3001 clear"

  # Stop existing processes
  echo "🛑 Stopping existing processes..."
  pm2 stop questcord-bot 2>/dev/null || echo "No bot to stop"
  pm2 delete questcord-bot 2>/dev/null || echo "No process to delete"

  # Install dependencies
  echo "📦 Installing dependencies..."
  npm install

  # Deploy commands from correct location
  echo "⚡ Deploying slash commands..."
  if [[ -f "scripts/deploy-commands.js" ]]; then
      echo "✅ Found deploy-commands.js in production/scripts/"
      node scripts/deploy-commands.js || echo "❌ Command deployment failed"
  else
      echo "❌ No scripts/deploy-commands.js found"
      echo "📁 Available files:"
      find . -name "deploy-commands.js" -type f 2>/dev/null || echo "No deploy-commands.js anywhere"
  fi

  # Start bot directly (don't rely on ecosystem.config.js)
  echo "🚀 Starting bot..."
  pm2 start src/index.js --name questcord-bot \
    --watch false \
    --max-memory-restart 1G \
    --restart-delay 5000 \
    --max-restarts 10 \
    --log-date-format "YYYY-MM-DD HH:mm:ss Z"

  # Save PM2 config
  pm2 save

  # Show results
  echo ""
  echo "📊 PM2 Status:"
  pm2 status

  echo ""
  echo "📝 Recent logs:"
  pm2 logs questcord-bot --lines 10

  echo ""
  echo "✅ Deployment complete!"
  echo "🌐 Check web: http://134.199.164.5:3000 or :3001"