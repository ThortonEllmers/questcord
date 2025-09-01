// src/web/oauthRoutes.js
// Drop-in Discord OAuth routes (login, callback, debug).
// Mount AFTER session but BEFORE express.static() / catch-alls.
// In server.js add:
//   app.set('trust proxy', 1);               // behind Cloudflare/tunnel
//   require('./oauthRoutes')(app, { fetchRoleLevel });
//
// Env vars:
//   DISCORD_CLIENT_ID
//   DISCORD_CLIENT_SECRET
//   DISCORD_REDIRECT_URI   (e.g. https://questcord.fun/auth/discord/callback)
//   COOKIE_DOMAIN          (used in your session config)

const { URL, URLSearchParams } = require('url');

module.exports = function oauthRoutes(app, deps = {}) {
  const fetchRoleLevel = deps.fetchRoleLevel || (async () => 'User');

  const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || process.env.CLIENT_ID;
  const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || process.env.CLIENT_SECRET;
  const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || process.env.OAUTH_REDIRECT_URI;

  function buildAuthorizeUrl() {
    const u = new URL('https://discord.com/oauth2/authorize');
    u.search = new URLSearchParams({
      client_id: DISCORD_CLIENT_ID || '',
      redirect_uri: DISCORD_REDIRECT_URI || '',
      response_type: 'code',
      scope: 'identify guilds'
    }).toString();
    return u.toString();
  }

  app.get('/auth/login', (req, res) => {
    if (!DISCORD_CLIENT_ID || !DISCORD_REDIRECT_URI) {
      console.error('[oauth] Misconfigured env. Need DISCORD_CLIENT_ID and DISCORD_REDIRECT_URI');
      return res.status(500).send('Auth error: misconfigured env');
    }
    res.redirect(buildAuthorizeUrl());
  });

  async function handleCallback(req, res) {
    const code = req.query.code;
    if (!code) return res.status(400).send('Missing code');
    try {
      const tokenParams = new URLSearchParams({
        client_id: DISCORD_CLIENT_ID || '',
        client_secret: DISCORD_CLIENT_SECRET || '',
        grant_type: 'authorization_code',
        code,
        redirect_uri: DISCORD_REDIRECT_URI || ''
      });

      const tRes = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenParams
      });
      const tok = await tRes.json().catch(() => ({}));
      if (!tRes.ok || !tok.access_token) {
        console.error('[oauth] Token exchange failed', { status: tRes.status, tok });
        return res.status(500).send('Auth error');
      }

      const uRes = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${tok.access_token}` }
      });
      const user = await uRes.json().catch(() => ({}));
      if (!uRes.ok || !user.id) {
        console.error('[oauth] User fetch failed', { status: uRes.status, user });
        return res.status(500).send('Auth error');
      }

      req.session.user = { id: user.id, username: user.username, avatar: user.avatar };
      try { req.session.roleLevel = await fetchRoleLevel(user.id); } catch {}

      res.redirect('/');
    } catch (e) {
      console.error('[oauth] Exception', e);
      res.status(500).send('Auth error');
    }
  }

  app.get('/auth/callback', handleCallback);
  app.get('/auth/discord/callback', handleCallback);

  app.get('/auth/debug', (req, res) => {
    res.json({
      redirect_uri_env: DISCORD_REDIRECT_URI || null,
      authorize_url: buildAuthorizeUrl()
    });
  });
};
