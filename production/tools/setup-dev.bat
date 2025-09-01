@echo off
cd ..
echo Setting up QuestCord Development Environment...
echo.
echo ==================================
echo   Development Setup
echo ==================================
echo.

echo 1. Creating development database...
echo Running: NODE_ENV=development node scripts/init-db.js
powershell -Command "$env:NODE_ENV='development'; node scripts/init-db.js"

echo.
echo 2. Development environment setup complete!
echo.
echo IMPORTANT NEXT STEPS:
echo ==================================
echo 1. Edit .env.development file with your Discord bot credentials
echo 2. Create a separate Discord bot application for development
echo 3. Create a test Discord server for development
echo 4. Run 'tools/start-dev.bat' to start the development server
echo.
echo Development server will run on: http://localhost:3001
echo Production server will run on: http://localhost:3000
echo.
pause