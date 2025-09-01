const crypto = require('crypto');
const buckets = new Map();
const config = require('../utils/config');

// Security headers middleware
function securityHeaders(req, res, next) {
  // Generate a nonce for CSP
  res.locals.nonce = crypto.randomBytes(16).toString('base64');
  
  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  
  // CORS headers for API functionality
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-csrf');
  
  // Only set HSTS in production
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }
  
  // Content Security Policy - relaxed for development
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://unpkg.com", // Allow inline scripts for maps
    "style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https://*.tile.openstreetmap.org https://cdn.discordapp.com",
    "connect-src 'self' https://nominatim.openstreetmap.org",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'"
  ].join('; ');
  
  res.setHeader('Content-Security-Policy', csp);
  
  next();
}

function rateLimit(maxDefault = 30, perMsDefault = 60000) {
  return (req, res, next) => {
    const apiCfg = config.security?.apiRate || { max: maxDefault, perMs: perMsDefault };
    const max = apiCfg.max ?? maxDefault;
    const perMs = apiCfg.perMs ?? perMsDefault;
    const k = req.ip + '|' + req.path;
    const now = Date.now();
    const b = buckets.get(k) || { count: 0, reset: now + perMs };
    if (now > b.reset) { b.count = 0; b.reset = now + perMs; }
    b.count++;
    buckets.set(k, b);
    if (b.count > max) return res.status(429).json({ error: 'rate_limited' });
    next();
  };
}

function ensureCsrf(req, res, next) {
  const tok = req.headers['x-csrf'];
  if (!req.session || !req.session.csrf || tok !== req.session.csrf) return res.status(403).json({ error: 'csrf' });
  next();
}
function setCsrf(req, res) {
  if (!req.session.csrf) {
    // Use cryptographically secure random tokens
    req.session.csrf = crypto.randomBytes(32).toString('hex');
  }
  res.json({ csrf: req.session.csrf });
}

// Input validation helpers
function validateUserId(userId) {
  return userId && typeof userId === 'string' && /^\d{17,19}$/.test(userId);
}

function validateGuildId(guildId) {
  return guildId && typeof guildId === 'string' && /^\d{17,19}$/.test(guildId);
}

function validateCoordinates(lat, lon) {
  return typeof lat === 'number' && typeof lon === 'number' && 
         lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 &&
         isFinite(lat) && isFinite(lon);
}

function sanitizeString(str, maxLength = 255) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, maxLength).replace(/[<>"/]/g, '');
}

module.exports = { 
  securityHeaders, rateLimit, ensureCsrf, setCsrf,
  validateUserId, validateGuildId, validateCoordinates, sanitizeString 
};
