@echo off
cd ..
echo Starting QuestCord Production Server...
echo.
echo ==================================
echo   QuestCord Production Mode
echo ==================================
echo.
echo Server will run on port 3000
echo Database: data.sqlite
echo Environment: production
echo.
echo Press Ctrl+C to stop the server
echo.

powershell -Command "$env:NODE_ENV='production'; npm run start:prod"