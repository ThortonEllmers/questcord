@echo off
cd ..
echo.
echo ==================================================
echo         QuestCord Rollback Tool
echo ==================================================
echo.
echo This tool allows you to rollback to a previous backup
echo in case something went wrong with your deployment.
echo.
echo IMPORTANT:
echo - Stop your production server first
echo - This will replace your current production data
echo - Make sure you really need to rollback
echo.
pause

node scripts/rollback.js

pause