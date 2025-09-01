const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const logger = require('../../utils/logger');
const { rateLimit } = require('../security');

const router = express.Router();

// Session middleware - exactly like the working version
router.use(session({
  name: 'auth_session',
  secret: process.env.SESSION_SECRET || 'fallback_secret_change_this',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === 'true',
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Discord OAuth config
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || process.env.CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.OAUTH_REDIRECT_URI;

// In-memory state storage (simple approach)
const pendingStates = new Map();

// Start OAuth flow
router.get('/auth/discord', (req, res) => {
  const state = crypto.randomBytes(32).toString('hex');
  
  // Store state with expiration
  pendingStates.set(state, Date.now());
  setTimeout(() => pendingStates.delete(state), 10 * 60 * 1000); // 10 min expiry

  const authUrl = 'https://discord.com/api/oauth2/authorize?' + new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'identify',
    state: state
  });

  console.log('Starting OAuth with state:', state);
  res.redirect(authUrl);
});

// OAuth callback
router.get('/auth/discord/callback', async (req, res) => {
  const { code, state } = req.query;

  console.log('OAuth callback - code:', !!code, 'state:', state);

  // Validate state
  if (!state || !pendingStates.has(state)) {
    console.log('Invalid state:', state);
    return res.status(400).send('Invalid state');
  }
  
  pendingStates.delete(state);

  if (!code) {
    console.log('No authorization code');
    return res.status(400).send('No authorization code');
  }

  try {
    // Exchange code for token
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: REDIRECT_URI
      })
    });

    if (!tokenResponse.ok) {
      console.log('Token exchange failed:', tokenResponse.status);
      return res.status(500).send('Token exchange failed');
    }

    const tokens = await tokenResponse.json();
    console.log('Got tokens, fetching user...');

    // Get user info
    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });

    if (!userResponse.ok) {
      console.log('User fetch failed:', userResponse.status);
      return res.status(500).send('User fetch failed');
    }

    const user = await userResponse.json();
    console.log('User logged in:', user.username, user.id);

    // Store in session
    req.session.user = {
      id: user.id,
      username: user.username,
      avatar: user.avatar,
      global_name: user.global_name
    };

    // Redirect to home
    res.redirect('/');
    
  } catch (error) {
    console.error('OAuth error:', error);
    res.status(500).send('Authentication failed');
  }
});

// Check auth status - return format that frontend expects
router.get('/api/whoami', rateLimit(60, 60000), async (req, res) => {
  try {
    // console.log('Whoami called - session user:', req.session?.user?.username || 'none'); // Disabled to reduce spam
    
    if (!req.session?.user) {
      return res.json({ user: null });
    }

    const u = req.session.user;

    // Import required functions
    const { db } = require('../../utils/store_sqlite');
    const { fetchRoleLevel, getMemberRoleIds, ensurePlayerRow } = require('../util');

    // Ensure player exists with proper spawn location
    ensurePlayerRow(u);

    // Role + regen + member roles
    const roleLevel = await fetchRoleLevel(u.id);
    const memberRoles = await getMemberRoleIds(u.id);
    try {
      const { applyRegenForUser } = require('../../utils/regen');
      await applyRegenForUser(u.id);
    } catch {}

    // Player + inventory
    const player = db.prepare(`
      SELECT userId, name, drakari, locationGuildId,
             travelArrivalAt, travelFromGuildId, travelStartAt,
             vehicle, health, stamina, staminaUpdatedAt, gems
      FROM players WHERE userId=?
    `).get(u.id) || null;
    const inv = db.prepare('SELECT itemId, qty FROM inventory WHERE userId=? ORDER BY itemId').all(u.id);

    // Travel status
    let travel = null;
    if (player && player.travelArrivalAt && player.travelArrivalAt > Date.now()) {
      const from = db.prepare('SELECT guildId, name, lat, lon FROM servers WHERE guildId=?').get(player.travelFromGuildId);
      const to   = db.prepare('SELECT guildId, name, lat, lon FROM servers WHERE guildId=?').get(player.locationGuildId);
      if (from && to) {
        const total = Math.max(1, player.travelArrivalAt - player.travelStartAt);
        const progress = Math.min(1, Math.max(0, (Date.now() - player.travelStartAt) / total));
        const lat = from.lat + (to.lat - from.lat) * progress;
        const lon = from.lon + (to.lon - from.lon) * progress;
        travel = {
          from: { guildId: from.guildId, name: from.name, lat: from.lat, lon: from.lon },
          to: { guildId: to.guildId, name: to.name, lat: to.lat, lon: to.lon },
          position: { lat, lon },
          arrivalAt: player.travelArrivalAt,
          progress
        };
      }
    }

    // Get current location server name and coordinates
    let currentLocationServer = null;
    if (player && player.locationGuildId) {
      currentLocationServer = db.prepare('SELECT guildId, name, lat, lon FROM servers WHERE guildId=?').get(player.locationGuildId);
    }

    res.json({ 
      user: u,
      roleLevel,
      memberRoles,
      player,
      inventory: inv,
      travel,
      currentLocationServer
    });

  } catch (e) {
    console.error('Whoami error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// Login aliases
router.get('/auth/login', (req, res) => res.redirect('/auth/discord'));
router.get('/login', (req, res) => res.redirect('/auth/discord'));

// Logout (POST for API, GET for direct links)
router.post('/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

router.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// Debug endpoint removed for security

module.exports = router;