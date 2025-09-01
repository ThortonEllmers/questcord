# QuestCord Development Environment

This guide explains how to set up and use the development environment for QuestCord.

## Overview

- **Production**: Runs on your live server (default port 3000)
- **Development**: Runs on localhost:3001 with separate database and Discord bot

## Quick Setup

### 1. Initial Setup
```bash
# Run the setup script
tools/setup-dev.bat

# OR manually:
set NODE_ENV=development
npm run init:dev
```

### 2. Configure Development Bot
1. Create a **NEW** Discord application at https://discord.com/developers/applications
2. Copy the Bot Token, Client ID, and Client Secret
3. Edit `.env.development` file and replace the placeholder values:
   ```
   DISCORD_TOKEN=YOUR_DEV_BOT_TOKEN_HERE
   CLIENT_ID=YOUR_DEV_CLIENT_ID_HERE
   CLIENT_SECRET=YOUR_DEV_CLIENT_SECRET_HERE
   ```

### 3. Create Test Server
1. Create a test Discord server for development
2. Invite your development bot to the test server
3. Update the guild IDs in `.env.development`

### 4. Start Development Server
```bash
# Easy way:
tools/start-dev.bat

# OR manually:
npm run start:dev
```

## Available Scripts

### Development
- `npm run start:dev` - Start development server (port 3001)
- `npm run init:dev` - Initialize development database
- `npm run deploy:dev` - Deploy commands to development bot
- `npm run worker:dev` - Start development worker

### Production
- `npm run start:prod` - Start production server (port 3000)
- `npm run start` - Default start (production mode)

## Key Differences

| Feature | Development | Production |
|---------|-------------|-----------|
| Port | 3001 | 3000 |
| Database | `data-dev.sqlite` | `data.sqlite` |
| Discord Bot | Separate dev bot | Live bot |
| Security Headers | Relaxed | Full |
| Debug Mode | Enabled | Disabled |
| Fast Regen | Enabled | Disabled |
| Cooldowns | Skipped | Full |

## File Structure

```
.env                    # Production environment
.env.development       # Development environment
config.json           # Production config
config.development.json # Development config
data.sqlite           # Production database
data-dev.sqlite       # Development database
```

## Development Features

The development environment includes several conveniences:

- **Fast Regeneration**: Health/stamina regenerate quickly
- **Unlimited Tokens**: No token limits for testing
- **Skip Cooldowns**: No waiting between commands
- **Debug Mode**: Extra logging and error details
- **Relaxed Security**: Easier testing without strict CSP

## Best Practices

1. **Always test new features in development first**
2. **Use a separate Discord bot for development**
3. **Use a test Discord server, not your live server**
4. **Commit your changes before moving to production**
5. **Never mix development and production databases**

## Switching Environments

### To Development:
```bash
tools/start-dev.bat
# Server runs on http://localhost:3001
```

### To Production:
```bash
tools/start-production.bat
# Server runs on http://localhost:3000
```

## Troubleshooting

### Common Issues:

1. **Port 3001 already in use**
   - Change PORT in `.env.development`

2. **Database errors**
   - Run `npm run init:dev` to recreate dev database

3. **Discord bot not responding**
   - Check bot token in `.env.development`
   - Ensure bot is in your test server

4. **OAuth redirect errors**
   - Check OAUTH_REDIRECT_URI matches your Discord app settings
   - Should be: `http://localhost:3001/auth/discord/callback`

## Security Note

The development environment has relaxed security settings for easier testing. **Never use development settings in production!**