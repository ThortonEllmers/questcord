// src/web/server.js (updated mount logic to accept both function and router exports)
const express = require('express');
const session = require('express-session');
const path = require('path');
const _logger = require('../utils/logger');
const mountRoutes = require('./routes');
const { db } = require('../utils/store_sqlite');
const { checkAndFixWaterServers } = require('../utils/geo');
const { securityHeaders } = require('./security');
const ONE_DAY = 24 * 60 * 60 * 1000;

const logger = (_logger && typeof _logger.info === 'function')
  ? _logger
  : (_logger && _logger.default && typeof _logger.default.info === 'function')
    ? _logger.default
    : { info: console.log, warn: console.warn, error: console.error, debug: console.debug };

function createWebServer() {
  const app = express();

  app.set('trust proxy', 1);
  
  // Apply security headers to all routes
  app.use(securityHeaders);
  
  // Handle OPTIONS requests for CORS
  app.use((req, res, next) => {
    if (req.method === 'OPTIONS') {
      res.status(200).end();
      return;
    }
    next();
  });
  
  app.use(express.json({ limit: '1mb' })); // Limit payload size
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  
  // Check for servers in water on web server startup (if bot isn't running)
  setTimeout(async () => {
    try {
      logger.info('[Web] Starting water check...');
      await checkAndFixWaterServers(db);
    } catch (error) {
      logger.error('[Web] Water check failed: %s', error.message);
    }
  }, 5000); // Delay to ensure everything is initialized

  const cookieDomain = process.env.COOKIE_DOMAIN || undefined;
  const secureEnv = process.env.COOKIE_SECURE;
  const cookieSecure = (typeof secureEnv === 'string')
    ? (secureEnv.toLowerCase() === 'true')
    : false; // Default to insecure for development

  // Session middleware for API routes
  app.use(session({
    name: 'questcord_session',
    secret: process.env.SESSION_SECRET || 'fallback-secret-for-dev',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: cookieSecure,
      httpOnly: true,
      maxAge: ONE_DAY,
      domain: cookieDomain,
      sameSite: 'lax'
    }
  }));

  // Static files from web/public directory
  app.use(express.static(path.join(process.cwd(), 'web', 'public')));

  // Aliases to start OAuth
  app.get('/auth/login', (_req, res) => res.redirect('/auth/discord'));
  app.get('/login', (_req, res) => res.redirect('/auth/discord'));

  // ---- Robust route mounting ----
  try {
    if (typeof mountRoutes === 'function') {
      mountRoutes(app);
    } else if (mountRoutes && mountRoutes.default && typeof mountRoutes.default === 'function') {
      mountRoutes.default(app);
    } else if (mountRoutes && typeof mountRoutes.handle === 'function') {
      app.use(mountRoutes);
    } else {
      logger.warn('[routes] Unsupported export shape; no routes mounted');
    }
  } catch (e) {
    logger.error('[routes] mount failed %s', e && e.stack || e);
  }

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // Get port from config first, then env, then default
  const config = require('../utils/config');
  const port = config.web?.port || process.env.PORT || (process.env.NODE_ENV === 'development' ? 3001 : 3000);
  const server = app.listen(port, () => {
    const env = process.env.NODE_ENV || 'production';
    logger.info('Web server listening on port %s (environment: %s)', port, env);
    if (env === 'development') {
      logger.info('Development server running at http://localhost:%s', port);
    }
  });

  return { app, server };
}

module.exports = { createWebServer };
module.exports.default = { createWebServer };
