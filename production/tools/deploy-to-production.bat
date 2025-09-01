@echo off
cd ..
echo.
echo ==================================================
echo         QuestCord Production Deployment
echo ==================================================
echo.
echo This will deploy your development changes to production!
echo.
echo IMPORTANT WARNINGS:
echo - This will backup your current production data
echo - Your production server should be stopped first
echo - Make sure you've tested everything in development
echo.
set /p confirm=Are you sure you want to deploy? (y/N): 

if /i not "%confirm%"=="y" (
    echo.
    echo Deployment cancelled.
    pause
    exit /b 0
)

echo.
echo Starting deployment...
echo.

node scripts/deploy.js

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ==================================================
    echo         Deployment Completed Successfully!
    echo ==================================================
    echo.
    echo Your production server is ready to restart.
    echo Run: tools/start-production.bat
    echo.
) else (
    echo.
    echo ==================================================
    echo              Deployment Failed!
    echo ==================================================
    echo.
    echo Check the error messages above.
    echo Your production server was not modified.
    echo.
)

pause