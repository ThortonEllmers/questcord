#!/usr/bin/env bash

# QuestCord Production Deployment Script
# This script safely deploys the QuestCord bot to production

set -euo pipefail

echo "🚀 Starting QuestCord Production Deployment"
echo "=============================================="

# Check if PM2 is installed
if ! command -v pm2 &> /dev/null; then
    echo "❌ PM2 is not installed. Installing..."
    npm install -g pm2
fi

# Create logs directory if it doesn't exist
mkdir -p logs

# Install dependencies
echo "📦 Installing production dependencies..."
npm ci --only=production || npm install --only=production

# Kill any processes using port 3001
echo "🔧 Clearing port 3001..."
npx kill-port 3001 2>/dev/null || echo "Port 3001 was not in use"

# Stop existing PM2 processes (if any)
echo "🛑 Stopping existing processes..."
pm2 stop ecosystem.config.js 2>/dev/null || echo "No existing processes to stop"

# Deploy slash commands
echo "⚡ Deploying slash commands..."
node scripts/deploy-commands.js || {
    echo "❌ Failed to deploy commands, continuing anyway..."
}

# Start with PM2 using ecosystem config
echo "🚀 Starting bot with PM2..."
pm2 start ecosystem.config.js

# Save PM2 configuration
echo "💾 Saving PM2 configuration..."
pm2 save

# Show status
echo "📊 Current PM2 status:"
pm2 status

echo ""
echo "✅ QuestCord bot deployed successfully!"
echo "📝 Logs can be viewed with: pm2 logs questcord-bot"
echo "🔄 Restart with: pm2 restart questcord-bot"  
echo "🛑 Stop with: pm2 stop questcord-bot"
echo "🌐 Web interface available on port 3001"