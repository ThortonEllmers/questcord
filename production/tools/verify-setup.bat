@echo off
cd ..
echo.
echo ==================================================
echo         QuestCord Setup Verification
echo ==================================================
echo.

echo Checking configuration files...
echo.

if exist ".env" (
    echo ✅ Production .env found
) else (
    echo ❌ Production .env missing
)

if exist ".env.development" (
    echo ✅ Development .env found
) else (
    echo ❌ Development .env missing
)

if exist "config.json" (
    echo ✅ Production config found
) else (
    echo ❌ Production config missing
)

if exist "config.development.json" (
    echo ✅ Development config found
) else (
    echo ❌ Development config missing
)

if exist "data.sqlite" (
    echo ✅ Production database found
) else (
    echo ⚠️  Production database missing (will be created)
)

if exist "data-dev.sqlite" (
    echo ✅ Development database found
) else (
    echo ⚠️  Development database missing (run setup-dev.bat)
)

if exist "src\commands\deploy.js" (
    echo ✅ Deploy command found
) else (
    echo ❌ Deploy command missing
)

echo.
echo ==================================================
echo.
echo Your Discord ID is configured as: 378501056008683530
echo.
echo Available commands after setup:
echo • start-dev.bat           - Start development server
echo • start-production.bat    - Start production server
echo • deploy-to-production.bat - Deploy dev to production
echo • rollback.bat           - Rollback if needed
echo.
echo Discord commands (owner only):
echo • /deploy status          - Check status
echo • /deploy deploy          - Deploy to production
echo • /deploy rollback        - Rollback to backup
echo.
echo Next steps:
echo 1. Configure your Discord bot tokens in .env files
echo 2. Run tools/setup-dev.bat for initial development setup
echo 3. Start testing with tools/start-dev.bat
echo 4. Deploy when ready with /deploy deploy
echo.
pause