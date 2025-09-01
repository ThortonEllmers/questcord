@echo off
cd ..
echo Starting QuestCord Development Server...
echo.
echo ==================================
echo   QuestCord Development Mode
echo ==================================
echo.
echo Server will run on: http://localhost:3001
echo Database: data-dev.sqlite
echo Environment: development
echo.
echo Press Ctrl+C to stop the server
echo.

powershell -Command "$env:NODE_ENV='development'; $env:PORT='3001'; npm run start:dev"