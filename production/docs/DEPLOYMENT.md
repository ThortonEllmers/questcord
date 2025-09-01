# QuestCord Deployment Guide

This guide explains how to safely deploy your tested features from development to production.

## 🚀 Quick Deployment

### Method 1: Discord Command (Recommended)
1. Set your Discord User ID in `.env.development` (`BOT_OWNER_ID`)
2. Use `/deploy status` to check current state
3. Use `/deploy backup` to create a backup
4. Use `/deploy deploy` to deploy to production
5. Restart your production server

### Method 2: Batch File
1. Double-click `tools/deploy-to-production.bat`
2. Follow the prompts
3. Restart your production server

### Method 3: Command Line
```bash
npm run deploy
npm run start:prod
```

## 🔄 Complete Workflow

### 1. Development Phase
```bash
# Work on features in development
tools/start-dev.bat                    # Start dev server (localhost:3001)
# Test your changes thoroughly
# Make sure everything works
```

### 2. Pre-Deployment Checks
- ✅ All features tested in development
- ✅ No errors in development console
- ✅ Database migrations work correctly
- ✅ Configuration changes are intentional

### 3. Deployment
```bash
# Create backup (optional - auto-created during deploy)
npm run backup

# Deploy to production
tools/deploy-to-production.bat
# OR
npm run deploy
```

### 4. Post-Deployment
```bash
# Restart production server
tools/start-production.bat
# OR 
npm run start:prod

# Test production server
# Monitor for issues
```

## 📊 Discord Commands (Owner Only)

| Command | Description |
|---------|-------------|
| `/deploy status` | Check deployment status and backups |
| `/deploy backup` | Create manual backup |
| `/deploy deploy` | Deploy dev changes to production |
| `/deploy rollback [backup_id]` | Rollback to previous version |
| `/deploy restart` | Restart production server |

## 🛠️ What Gets Deployed

### ✅ Included
- Database schema changes
- New tables and columns
- Configuration updates (merged)
- Code changes (already in place)
- New features and bug fixes

### ❌ Excluded
- Production `.env` file (credentials preserved)
- User data (preserved during migration)
- Backups directory
- Development-only files
- Node modules

## 💾 Backup System

### Automatic Backups
- Created before every deployment
- Includes database, config, and manifest
- Last 5 backups kept automatically
- Stored in `./backups/` directory

### Manual Backups
```bash
npm run backup              # Command line
/deploy backup             # Discord command
```

### Backup Contents
- `data.sqlite` - Production database
- `config.json` - Production configuration
- `.env` - Environment variables
- `manifest.json` - Backup metadata

## 🔄 Rollback System

### When to Rollback
- Deployment caused errors
- Features not working as expected
- Database corruption
- Emergency situations

### How to Rollback

#### Discord Command
```
/deploy rollback backup_id:deploy_1234567890
```

#### Batch File
```bash
tools/rollback.bat
```

#### Command Line
```bash
npm run rollback
```

## 🚨 Emergency Procedures

### If Deployment Fails
1. **Don't Panic** - Your production data is backed up
2. Check error messages for specific issues
3. Fix the problem in development
4. Try deployment again, or rollback

### If Production is Broken
1. **Immediate Rollback**:
   ```bash
   tools/rollback.bat
   # Select most recent backup
   ```

2. **Restart Production**:
   ```bash
   tools/start-production.bat
   ```

3. **Investigate** what went wrong
4. **Fix** in development
5. **Test** thoroughly before next deployment

### If Database is Corrupted
1. Stop production server
2. Restore from backup:
   ```bash
   # Find latest backup in ./backups/
   copy "backups\deploy_XXXXXX\data.sqlite" "data.sqlite"
   ```
3. Restart production server

## 🔐 Security Notes

### Production Secrets
- Production `.env` is **NEVER** overwritten
- Live Discord bot tokens preserved
- Database credentials unchanged
- Session secrets maintained

### Access Control
- Deployment commands require bot owner permission
- Owner ID must be set in environment variables
- No unauthorized deployments possible

## 📋 Troubleshooting

### Common Issues

**"Deployment Failed: npm dependencies validation failed"**
```bash
npm install  # Install missing dependencies
```

**"Database backup failed"**
- Check disk space
- Ensure production database exists
- Verify file permissions

**"Port 3000 already in use"**
- Stop existing production server
- Check for other processes using port 3000

**"Discord command not working"**
- Verify `BOT_OWNER_ID` in `.env` files
- Make sure bot is online
- Check Discord permissions

### Log Files
- Deployment logs appear in console
- Error details included in output
- Check timestamps for issue tracking

## 🎯 Best Practices

### Before Deployment
1. **Test Everything** in development first
2. **Create Manual Backup** if making major changes
3. **Plan Downtime** if needed
4. **Have Rollback Plan** ready

### During Deployment
1. **Monitor Console Output** for errors
2. **Don't Interrupt** deployment process
3. **Wait for Completion** before testing

### After Deployment
1. **Test Core Functionality** immediately
2. **Monitor Error Logs** for 24-48 hours
3. **Keep Backup** for at least a week
4. **Document Changes** for team

### Regular Maintenance
1. **Clean Old Backups** monthly
2. **Update Dependencies** regularly
3. **Test Deployment Process** periodically
4. **Review Security Settings** quarterly

## 📞 Support

If you encounter issues:
1. Check this guide first
2. Review console error messages
3. Try rollback if needed
4. Document issue details for troubleshooting

Remember: **Always test in development first!** 🧪