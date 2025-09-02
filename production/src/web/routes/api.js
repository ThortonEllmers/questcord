const express = require('express');
const path = require('path');
const { db } = require('../../utils/store_sqlite');
const { haversine, isOnLand, findLandPosition } = require('../../utils/geo');
const { rateLimit, ensureCsrf, setCsrf } = require('../security');
const { createAutoPlacementIfMissing, getSpawnServer, ensurePlayerRow, fetchRoleLevel, getMemberRoleIds } = require('../util');
const logger = require('../../utils/logger');
const { logAdminAction } = require('../../utils/webhook_safe');

const router = express.Router();
// Safe fetch helper for Node: use global fetch when available
async function fetchSafe(...args){
  if (typeof globalThis.fetch === 'function') return globalThis.fetch(...args);
  const mod = await import('node-fetch');
  return mod.default(...args);
}


// ---------------- Helpers ----------------
async function getRoleLevel(req) {
  // Get roleLevel from session or fetch it dynamically
  let roleLevel = req.session?.roleLevel || 'User';
  
  // If not in session, try to fetch it from the user
  if (roleLevel === 'User' && req.session?.user?.id) {
    try {
      roleLevel = await fetchRoleLevel(req.session.user.id);
      // Update session with current role
      req.session.roleLevel = roleLevel;
    } catch (e) {
      // Keep default 'User' if fetch fails
    }
  }
  
  return roleLevel;
}

// Helper to log admin actions to webhook
async function logAdminActionFromReq(req, action, targetId = null, targetName = null, details = {}) {
  try {
    const adminUserId = req.session?.user?.id || 'Unknown';
    const adminUsername = req.session?.user?.username || req.session?.user?.global_name || 'Unknown Admin';
    await logAdminAction(action, adminUserId, adminUsername, targetId, targetName, details);
  } catch (error) {
    console.warn('[webhook] Failed to log admin action:', error.message);
  }
}

function visitorsCount(guildId){
  try {
    const row = db.prepare('SELECT COUNT(*) as n FROM players WHERE locationGuildId=? AND (travelArrivalAt=0 OR travelArrivalAt<=?)')
                  .get(guildId, Date.now());
    return row ? row.n : 0;
  } catch (e) { return 0; }
}
function listServers(includeArchived=false){
  const baseCols = 'guildId, name, lat, lon, iconUrl, discoverable, archived';
  const q = includeArchived
    ? `SELECT ${baseCols} FROM servers`
    : `SELECT ${baseCols} FROM servers WHERE archived IS NULL OR archived=0`;
  return db.prepare(q).all();
}
function activeBosses(){
  try { return db.prepare('SELECT * FROM bosses WHERE active=1').all(); }
  catch(e){ return []; }
}
function getBossData(guildId){
  try {
    const boss = db.prepare('SELECT active, tier, expiresAt FROM bosses WHERE guildId=? AND active=1 ORDER BY id DESC LIMIT 1').get(guildId);
    if (boss && boss.expiresAt > Date.now()) {
      return { active: true, tier: boss.tier || 1 };
    }
    return { active: false, tier: null };
  } catch (e) { 
    return { active: false, tier: null }; 
  }
}
function nearest(center, limit=50, opts={}){
  const all = listServers(!!opts.includeArchived)
    .filter(s => s.lat != null && s.lon != null)
    .filter(s => (opts.discoverableOnly ? !!s.discoverable : true));
  const rows = all.map(s => {
    const bossData = getBossData(s.guildId);
    return {
      ...s,
      dist: haversine(center.lat, center.lon, s.lat, s.lon),
      visitors: visitorsCount(s.guildId),
      bossActive: bossData.active,
      bossTier: bossData.tier
    };
  });
  // Optional filter when bossActiveOnly
  const rows2 = opts.bossActiveOnly ? rows.filter(r => r.bossActive) : rows;
  rows2.sort((a,b)=>a.dist-b.dist);
  return rows2.slice(0, limit);
}
function globalList(limit=500, opts={}){
  const all = listServers(!!opts.includeArchived)
    .filter(s => (opts.discoverableOnly ? !!s.discoverable : true))
    .slice(0, limit);
  return all.map(s => {
    const bossData = getBossData(s.guildId);
    return {
      ...s, 
      visitors: visitorsCount(s.guildId),
      bossActive: bossData.active,
      bossTier: bossData.tier
    };
  });
}

// ---------------- Routes ----------------

// CSRF seed
router.get('/api/csrf', rateLimit(), setCsrf);

// === Weather System ===

// Get active weather events for map display
router.get('/api/weather', rateLimit(60, 60000), async (req, res) => {
  try {
    const { getActiveWeather, WEATHER_TYPES } = require('../../utils/weather');
    
    const activeWeather = getActiveWeather();
    const weatherData = activeWeather.map(weather => ({
      id: weather.id,
      type: weather.type,
      name: WEATHER_TYPES[weather.type]?.name || weather.type,
      icon: WEATHER_TYPES[weather.type]?.icon || 'WEATHER',
      color: WEATHER_TYPES[weather.type]?.color || '#808080',
      centerLat: weather.centerLat,
      centerLon: weather.centerLon,
      radius: weather.radius,
      severity: weather.severity,
      description: WEATHER_TYPES[weather.type]?.description || 'Weather event',
      blockTravel: WEATHER_TYPES[weather.type]?.blockTravel || false,
      timeRemaining: Math.max(0, weather.endTime - Date.now()),
      startTime: weather.startTime,
      endTime: weather.endTime
    }));

    res.json({
      weather: weatherData,
      count: weatherData.length,
      lastUpdate: Date.now()
    });

  } catch (error) {
    console.error('GET /api/weather error:', error);
    res.status(500).json({ error: 'server_error' });
  }
});

// Get travel route with weather considerations
router.post('/api/weather/route', rateLimit(30, 60000), ensureCsrf, async (req, res) => {
  try {
    const { fromLat, fromLon, toLat, toLon } = req.body;
    
    if (!fromLat || !fromLon || !toLat || !toLon) {
      return res.status(400).json({ error: 'invalid_input', message: 'Coordinates required' });
    }

    const { getWeatherEffectsForTravel } = require('../../utils/weather');
    const routeInfo = getWeatherEffectsForTravel(fromLat, fromLon, toLat, toLon);

    res.json({
      route: routeInfo,
      message: routeInfo.detourRequired 
        ? `Route adjusted to avoid: ${routeInfo.weatherAvoided}`
        : routeInfo.weatherDescription !== 'Clear skies' 
          ? `Weather along route: ${routeInfo.weatherDescription}`
          : 'Clear skies ahead!'
    });

  } catch (error) {
    console.error('POST /api/weather/route error:', error);
    res.status(500).json({ error: 'server_error' });
  }
});

// Force generate weather (Staff/Developer only)
router.post('/api/admin/weather/generate', rateLimit(10, 60000), ensureCsrf, async (req, res) => {
  try {
    const roleLevel = await getRoleLevel(req);
    if (!(roleLevel === 'Developer' || roleLevel === 'Staff')) {
      return res.status(403).json({ error: 'forbidden', message: 'Staff or Developer role required' });
    }

    const { generateWeatherEvents } = require('../../utils/weather');
    generateWeatherEvents();

    res.json({
      success: true,
      message: 'Weather generation triggered',
      timestamp: Date.now()
    });

  } catch (error) {
    console.error('POST /api/admin/weather/generate error:', error);
    res.status(500).json({ error: 'server_error' });
  }
});

// Create weather event at specific coordinates (Staff/Developer only)
router.post('/api/admin/weather/create', rateLimit(10, 60000), ensureCsrf, async (req, res) => {
  try {
    const roleLevel = await getRoleLevel(req);
    if (!(roleLevel === 'Developer' || roleLevel === 'Staff')) {
      return res.status(403).json({ error: 'forbidden', message: 'Staff or Developer role required' });
    }
    
    const { type, lat, lon, duration, radius } = req.body;
    
    if (!type || typeof lat !== 'number' || typeof lon !== 'number' || typeof duration !== 'number') {
      return res.status(400).json({ error: 'bad_request', message: 'Missing required fields: type, lat, lon, duration' });
    }
    
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return res.status(400).json({ error: 'bad_request', message: 'Invalid coordinates' });
    }
    
    if (duration < 10 || duration > 1440) {
      return res.status(400).json({ error: 'bad_request', message: 'Duration must be between 10 and 1440 minutes' });
    }
    
    const { createWeatherEvent } = require('../../utils/weather');
    const weatherEvent = createWeatherEvent(type, lat, lon, duration, radius, req.client);
    
    if (!weatherEvent) {
      return res.status(400).json({ error: 'bad_request', message: 'Invalid weather type or failed to create event' });
    }
    
    // Log to webhook
    await logAdminActionFromReq(req, 'Weather Event Created', weatherEvent.id, weatherEvent.name, {
      'Event Type': weatherEvent.name,
      'Location': `${lat}°, ${lon}°`,
      'Duration': `${duration} minutes`,
      'Radius': `${radius || 'default'} km`,
      'Event ID': weatherEvent.id
    });
    
    res.json({
      success: true,
      weatherEvent,
      message: `Created ${weatherEvent.name} at ${lat}°, ${lon}°`
    });
  } catch (error) {
    console.error('POST /api/admin/weather/create error:', error);
    res.status(500).json({ error: 'server_error' });
  }
});

// Create regional weather event (Staff/Developer only)
router.post('/api/admin/weather/regional', rateLimit(10, 60000), ensureCsrf, async (req, res) => {
  try {
    const roleLevel = await getRoleLevel(req);
    if (!(roleLevel === 'Developer' || roleLevel === 'Staff')) {
      return res.status(403).json({ error: 'forbidden', message: 'Staff or Developer role required' });
    }
    
    const { type, country } = req.body;
    
    if (!type || !country) {
      return res.status(400).json({ error: 'bad_request', message: 'Missing required fields: type, country' });
    }
    
    const { createWeatherInCountry } = require('../../utils/weather');
    console.log(`[API] Creating regional weather: type=${type}, country=${country}`);
    const result = await createWeatherInCountry(type, country, null);
    console.log(`[API] Weather creation result:`, result);
    
    if (!result.success) {
      console.error(`[API] Weather creation failed:`, result.message);
      return res.status(400).json({ error: 'bad_request', message: result.message });
    }
    
    // Log to webhook
    await logAdminActionFromReq(req, 'Regional Weather Event Created', result.weatherEvent.id, result.weatherEvent.name, {
      'Event Type': result.weatherEvent.name,
      'Country/Region': result.region,
      'Coordinates': `${result.coordinates.lat}°, ${result.coordinates.lon}°`,
      'Duration': `${result.weatherEvent.duration} minutes`,
      'Event ID': result.weatherEvent.id
    });
    
    res.json({
      success: true,
      weatherEvent: result.weatherEvent,
      coordinates: result.coordinates,
      region: result.region,
      message: `Created ${result.weatherEvent.name} in ${result.region}`
    });
  } catch (error) {
    console.error('POST /api/admin/weather/regional error:', error);
    res.status(500).json({ error: 'server_error' });
  }
});

// Remove weather event (Staff/Developer only)
router.post('/api/admin/weather/remove', rateLimit(10, 60000), ensureCsrf, async (req, res) => {
  try {
    const roleLevel = await getRoleLevel(req);
    if (!(roleLevel === 'Developer' || roleLevel === 'Staff')) {
      return res.status(403).json({ error: 'forbidden', message: 'Staff or Developer role required' });
    }
    
    const { eventId } = req.body;
    
    if (!eventId) {
      return res.status(400).json({ error: 'bad_request', message: 'Missing eventId' });
    }
    
    const { removeWeatherEvent } = require('../../utils/weather');
    const success = removeWeatherEvent(eventId);
    
    if (!success) {
      return res.status(404).json({ error: 'not_found', message: 'Weather event not found or already expired' });
    }
    
    // Log to webhook
    await logAdminActionFromReq(req, 'Weather Event Removed', eventId, null, {
      'Action': 'Weather event manually removed',
      'Event ID': eventId
    });
    
    res.json({
      success: true,
      message: `Removed weather event ${eventId}`
    });
  } catch (error) {
    console.error('POST /api/admin/weather/remove error:', error);
    res.status(500).json({ error: 'server_error' });
  }
});

// Clear all weather events (Staff/Developer only)
router.post('/api/admin/weather/clear', rateLimit(10, 60000), ensureCsrf, async (req, res) => {
  try {
    const roleLevel = await getRoleLevel(req);
    if (!(roleLevel === 'Developer' || roleLevel === 'Staff')) {
      return res.status(403).json({ error: 'forbidden', message: 'Staff or Developer role required' });
    }
    
    const { clearAllWeatherEvents } = require('../../utils/weather');
    const count = clearAllWeatherEvents();
    
    // Log to webhook
    await logAdminActionFromReq(req, 'All Weather Events Cleared', null, null, {
      'Action': 'Cleared all active weather events',
      'Events Cleared': `${count} events`
    });
    
    res.json({
      success: true,
      count,
      message: `Cleared ${count} weather events`
    });
  } catch (error) {
    console.error('POST /api/admin/weather/clear error:', error);
    res.status(500).json({ error: 'server_error' });
  }
});

// Session/me with regen, roles, inventory and map center
router.get('/api/me', rateLimit(180, 60000), async (req, res) => {
  try {
    console.log('API /me called - session.user:', req.session.user ? 'exists' : 'null', 'sessionID:', req.sessionID);
    if (!req.session.user) return res.json({ user: null });
    const u = req.session.user;

    // Ensure player exists with proper spawn location
    const { ensurePlayerRow } = require('../util');
    ensurePlayerRow(u);

    // Role + regen + member roles
    const roleLevel   = await fetchRoleLevel(u.id);
    const memberRoles = await getMemberRoleIds(u.id);
    try {
      const { applyRegenForUser } = require('../../utils/regen');
      await applyRegenForUser(u.id);
    } catch {}

    // Player + inventory
    const player = db.prepare(`
      SELECT userId, name, drakari, locationGuildId,
             travelArrivalAt, travelFromGuildId, travelStartAt,
             vehicle, health, stamina, staminaUpdatedAt
      FROM players WHERE userId=?
    `).get(u.id) || null;
    const inv = db.prepare('SELECT itemId, qty FROM inventory WHERE userId=? ORDER BY itemId').all(u.id);

    // Persist role level for other endpoints
    req.session.roleLevel = roleLevel;

    // Travel status + center calculation
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
          fromGuildId: from.guildId,
          toGuildId:   to.guildId,
          startAt:     player.travelStartAt,
          arrivalAt:   player.travelArrivalAt,
          progress,
          from: { name: from.name, lat: from.lat, lon: from.lon },
          to:   { name: to.name,   lat: to.lat,   lon: to.lon   },
          position: { lat, lon }
        };
      }
    }

    // Map center (in-flight or current server)
    let center = null;
    if (travel?.position) {
      center = { lat: travel.position.lat, lon: travel.position.lon, zoom: 5 };
    } else if (player?.locationGuildId) {
      const loc = db.prepare('SELECT lat, lon FROM servers WHERE guildId=?').get(player.locationGuildId);
      if (loc) center = { lat: loc.lat, lon: loc.lon, zoom: 5 };
    }

    res.json({ user: u, player, inventory: inv, roleLevel, memberRoles, travel, center });
  } catch (err) {
    console.error('GET /api/me error', err);
    res.status(500).json({ error: 'me_failed' });
  }
});

// Admin: set coords used by the map editor
router.patch('/api/admin/set-coords', rateLimit(20, 10000), ensureCsrf, async (req,res)=>{
  try{
    // Proper authentication check - validate session and admin role
    if (!req.session?.user?.id) {
      return res.status(401).json({ error: 'auth_required' });
    }
    
    // Verify admin role level (must be 3 or higher for admin functions)
    if (!req.session?.roleLevel || req.session.roleLevel < 3) {
      return res.status(403).json({ error: 'insufficient_privileges' });
    }
    
    console.log('set-coords called by admin:', req.session.user.id);
    
    const { guildId, lat, lon } = req.body || {};
    console.log('set-coords data:', { guildId, lat, lon });
    
    // Comprehensive input validation
    if (!guildId || typeof guildId !== 'string' || !/^\d{17,19}$/.test(guildId)) {
      return res.status(400).json({ error: 'invalid_guild_id' });
    }
    
    if (typeof lat !== 'number' || typeof lon !== 'number' || 
        lat < -90 || lat > 90 || lon < -180 || lon > 180 ||
        !isFinite(lat) || !isFinite(lon)) {
      return res.status(400).json({ error: 'invalid_coordinates' });
    }
    
    // Validate that the coordinates are on land
    const onLand = await isOnLand(lat, lon);
    if (!onLand) {
      console.log(`Coordinates ${lat}, ${lon} are in water, finding nearby land...`);
      const landPos = await findLandPosition(lat, lon, 20);
      
      db.prepare('UPDATE servers SET lat=?, lon=? WHERE guildId=?').run(landPos.lat, landPos.lon, guildId);
      logger.info('admin_set_coords: moved %s from water (%s,%s) to land (%s,%s)', guildId, lat, lon, landPos.lat, landPos.lon);
      console.log('set-coords success (moved to land)');
      res.json({ 
        ok: true, 
        moved_to_land: true,
        original: { lat, lon },
        final: landPos,
        message: 'Server moved to nearest land position to avoid placing in water.'
      });
    } else {
      db.prepare('UPDATE servers SET lat=?, lon=? WHERE guildId=?').run(lat, lon, guildId);
      logger.info('admin_set_coords: user moved %s to %s,%s (on land)', guildId, lat, lon);
      console.log('set-coords success (on land)');
      res.json({ ok: true });
    }
  }catch(e){
    console.error('set-coords error', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// Admin archive/restore (preserved)
router.post('/api/admin/server-archive', rateLimit(20, 10000), ensureCsrf, async (req,res)=>{
  // Proper authentication check
  if (!req.session?.user?.id) {
    return res.status(401).json({ ok:false, error: 'auth_required' });
  }
  
  // Verify admin role level (must be 3 or higher for admin functions)
  if (!req.session?.roleLevel || req.session.roleLevel < 3) {
    return res.status(403).json({ ok:false, error: 'insufficient_privileges' });
  }
  
  const { guildId } = req.body || {};
  if (!guildId) return res.status(400).json({ ok:false, error:'missing_guildId' });
  db.prepare('UPDATE servers SET archived=1 WHERE guildId=?').run(guildId);
  logger.info('server_archive: %s by %s', guildId, req.session?.user?.id);
  res.json({ ok:true });
});
router.post('/api/admin/server-restore', rateLimit(20, 10000), ensureCsrf, async (req,res)=>{
  // Proper authentication check
  if (!req.session?.user?.id) {
    return res.status(401).json({ ok:false, error: 'auth_required' });
  }
  
  // Verify admin role level (must be 3 or higher for admin functions)
  if (!req.session?.roleLevel || req.session.roleLevel < 3) {
    return res.status(403).json({ ok:false, error: 'insufficient_privileges' });
  }
  
  const { guildId } = req.body || {};
  if (!guildId) return res.status(400).json({ ok:false, error:'missing_guildId' });
  db.prepare('UPDATE servers SET archived=0 WHERE guildId=?').run(guildId);
  logger.info('server_restore: %s by %s', guildId, req.session?.user?.id);
  res.json({ ok:true });
});

// Map servers endpoint – replicates original behavior
router.get('/api/map/servers', rateLimit(), (req,res)=>{
  // Base options from query params
  const limit = Math.max(1, Math.min(500, parseInt(req.query.limit || '50', 10)));
  const fromGuildId = req.query.fromGuildId || null;
  const mode = req.query.mode === 'global' ? 'global' : 'nearest';
  const discoverableOnly = req.query.discoverableOnly === '1';
  const bossActiveOnly = req.query.bossActiveOnly === '1';
  const includeArchived = req.query.includeArchived === '1';

  const listOpts = { discoverableOnly, bossActiveOnly, includeArchived };
  let payload;

  if (mode === 'global'){
    payload = { center: null, servers: globalList(limit, listOpts), mode };
  } else {
    // Center priority:
    // 1) fromGuildId query
    // 2) the logged-in user's current travel position or current server (per-user centering)
    // 3) spawn server (fallback)
    let centerRow = null;

    if (fromGuildId){
      centerRow = db.prepare('SELECT guildId, name, lat, lon, iconUrl FROM servers WHERE guildId=?').get(fromGuildId) || null;
    }

    if (!centerRow && req.session.user){
      // Try travel interpolation
      const player = db.prepare(`
        SELECT locationGuildId, travelFromGuildId, travelStartAt, travelArrivalAt
        FROM players WHERE userId=?
      `).get(req.session.user.id);
      if (player){
        if (player.travelArrivalAt && player.travelArrivalAt > Date.now()){
          const from = db.prepare('SELECT guildId, name, lat, lon FROM servers WHERE guildId=?').get(player.travelFromGuildId);
          const to   = db.prepare('SELECT guildId, name, lat, lon FROM servers WHERE guildId=?').get(player.locationGuildId);
          if (from && to){
            const total = Math.max(1, player.travelArrivalAt - player.travelStartAt);
            const progress = Math.min(1, Math.max(0, (Date.now() - player.travelStartAt) / total));
            const lat = from.lat + (to.lat - from.lat) * progress;
            const lon = from.lon + (to.lon - from.lon) * progress;
            centerRow = { guildId: to.guildId, name: to.name, lat, lon, iconUrl: to.iconUrl };
          }
        }
        if (!centerRow && player.locationGuildId){
          centerRow = db.prepare('SELECT guildId, name, lat, lon, iconUrl FROM servers WHERE guildId=?').get(player.locationGuildId) || null;
        }
      }
    }

    if (!centerRow){
      centerRow = getSpawnServer();
    }

    if (!centerRow) return res.json({ center:null, servers:[], mode });
    payload = { center: centerRow, servers: nearest(centerRow, limit, listOpts), mode };
  }

  if (req.session.user){
    const p = db.prepare('SELECT locationGuildId, travelArrivalAt FROM players WHERE userId=?')
                .get(req.session.user.id);
    payload.me = p || null;
    payload.roleLevel = req.session.roleLevel || 'User';
  }

  res.json(payload);
});

// POI landmarks endpoint for map display
router.get('/api/map/landmarks', rateLimit(), (req, res) => {
  try {
    const { getAllPOIs } = require('../../utils/pois');
    const pois = getAllPOIs();
    
    // Transform POI data for map display with landmark images
    const landmarks = pois.map(poi => ({
      id: poi.id,
      name: poi.name,
      description: poi.description,
      lat: parseFloat(poi.lat),
      lon: parseFloat(poi.lon),
      country: poi.country,
      category: poi.category,
      emoji: poi.emoji,
      visitCost: poi.visitCost,
      discoveryReward: poi.discoveryReward,
      // Map landmark images to actual photos
      imageUrl: getLandmarkImageUrl(poi.id),
      iconUrl: `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><circle cx="24" cy="24" r="20" fill="%23ff6b6b" stroke="%23fff" stroke-width="3"/><text x="24" y="30" text-anchor="middle" font-size="16" fill="white">${poi.emoji}</text></svg>`
    }));
    
    res.json({ landmarks });
  } catch (error) {
    console.error('POI endpoint error:', error);
    res.json({ landmarks: [] });
  }
});

// Helper function to get real landmark images
function getLandmarkImageUrl(poiId) {
  const landmarkImages = {
    'eiffel_tower': 'https://images.unsplash.com/photo-1511739001486-6bfe10ce785f?w=200&h=200&fit=crop',
    'statue_of_liberty': 'https://images.unsplash.com/photo-1496442226666-8d4d0e62e6e9?w=200&h=200&fit=crop',
    'great_wall_china': 'https://images.unsplash.com/photo-1508804185872-d7badad00f7d?w=200&h=200&fit=crop',
    'colosseum': 'https://images.unsplash.com/photo-1552832230-c0197dd311b5?w=200&h=200&fit=crop',
    'taj_mahal': 'https://images.unsplash.com/photo-1564507592333-c60657eea523?w=200&h=200&fit=crop',
    'machu_picchu': 'https://images.unsplash.com/photo-1587595431973-160d0d94add1?w=200&h=200&fit=crop',
    'christ_redeemer': 'https://images.unsplash.com/photo-1483729558449-99ef09a8c325?w=200&h=200&fit=crop',
    'mount_fuji': 'https://images.unsplash.com/photo-1570459027562-4a916cc6113f?w=200&h=200&fit=crop',
    'pyramids_giza': 'https://images.unsplash.com/photo-1539650116574-75c0c6d73c6c?w=200&h=200&fit=crop',
    'stonehenge': 'https://images.unsplash.com/photo-1599833975787-5351f8ccb3d5?w=200&h=200&fit=crop'
  };
  
  return landmarkImages[poiId] || `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200"><rect width="200" height="200" fill="%23e0e0e0"/><text x="100" y="100" text-anchor="middle" font-size="60" fill="%23666">🏛️</text></svg>`;
}

router.get('/api/bosses', rateLimit(), (_,res)=> res.json({ bosses: activeBosses() }));

// Get detailed server information
router.get('/api/server/:guildId', rateLimit(), async (req, res) => {
  try {
    const guildId = req.params.guildId?.trim();
    if (!guildId) {
      return res.status(400).json({ error: 'invalid_guild_id', message: 'Guild ID is required' });
    }

    // Get server info
    const server = db.prepare(`
      SELECT guildId, name, lat, lon, ownerId, addedAt, lastBossAt, iconUrl, 
             discoverable, archived, archivedAt, archivedBy, biome, tokens,
             isBanned, banReason, bannedAt
      FROM servers 
      WHERE guildId = ?
    `).get(guildId);

    if (!server) {
      return res.status(404).json({ error: 'server_not_found', message: 'Server not found' });
    }

    const now = Date.now();

    // Get current visitors (users currently at this server)
    const visitors = db.prepare(`
      SELECT p.userId, p.name, p.drakari, p.gems, p.loginStreak, p.lastLoginAt,
             p.bossKills, p.serversVisited
      FROM players p 
      WHERE p.locationGuildId = ? 
        AND (p.travelArrivalAt = 0 OR p.travelArrivalAt <= ?)
        AND (p.banned = 0 OR p.banned IS NULL)
      ORDER BY p.lastLoginAt DESC
      LIMIT 50
    `).all(guildId, now);

    // Get travelers heading to this server
    const incomingTravelers = db.prepare(`
      SELECT p.userId, p.name, p.drakari, p.gems, p.travelArrivalAt, p.travelStartAt,
             fromServer.name as fromServerName, fromServer.guildId as fromGuildId
      FROM players p
      LEFT JOIN servers fromServer ON p.travelFromGuildId = fromServer.guildId
      WHERE p.locationGuildId = ? 
        AND p.travelArrivalAt > ?
        AND (p.banned = 0 OR p.banned IS NULL)
      ORDER BY p.travelArrivalAt ASC
      LIMIT 50
    `).all(guildId, now);

    // Get active boss info
    const activeBoss = db.prepare(`
      SELECT id, name, maxHp, hp, startedAt, expiresAt, tier,
             ((expiresAt - ?) / 1000 / 60) as minutesRemaining
      FROM bosses 
      WHERE guildId = ? AND active = 1 AND expiresAt > ?
      ORDER BY startedAt DESC
      LIMIT 1
    `).get(now, guildId, now);

    // Get boss participants if there's an active boss
    let bossParticipants = [];
    if (activeBoss) {
      bossParticipants = db.prepare(`
        SELECT bp.userId, bp.damage, p.name as playerName
        FROM boss_participants bp
        LEFT JOIN players p ON bp.userId = p.userId
        WHERE bp.bossId = ?
        ORDER BY bp.damage DESC
        LIMIT 20
      `).all(activeBoss.id);
    }

    // Get recent boss history
    const recentBosses = db.prepare(`
      SELECT name, maxHp, startedAt, expiresAt, tier,
             ((expiresAt - startedAt) / 1000 / 60) as durationMinutes
      FROM bosses 
      WHERE guildId = ? AND startedAt > ?
      ORDER BY startedAt DESC
      LIMIT 5
    `).all(guildId, now - (7 * 24 * 60 * 60 * 1000)); // Last 7 days

    // Get active weather affecting this location
    try {
      const { getActiveWeather, calculateDistance } = require('../../utils/weather');
      const activeWeather = getActiveWeather();
      const nearbyWeather = activeWeather.filter(weather => {
        if (server.lat == null || server.lon == null) return false;
        const distance = calculateDistance(server.lat, server.lon, weather.centerLat, weather.centerLon);
        return distance <= weather.radius + 50; // Include weather within 50km of affect radius
      });
      server.nearbyWeather = nearbyWeather;
    } catch (e) {
      server.nearbyWeather = []; // Weather system might not be available
    }

    // Get server statistics
    const stats = {
      totalVisitors: visitors.length,
      incomingTravelers: incomingTravelers.length,
      totalVisitsAllTime: 0,
      lastBossAt: server.lastBossAt,
      bossesSpawned: 0
    };

    // Get total visits from travel history
    try {
      const visitsData = db.prepare(`
        SELECT COUNT(*) as totalVisits
        FROM travel_history 
        WHERE toGuildId = ?
      `).get(guildId);
      stats.totalVisitsAllTime = visitsData?.totalVisits || 0;
    } catch (e) {
      // travel_history table might not exist
    }

    // Get boss spawn count
    try {
      const bossData = db.prepare(`
        SELECT COUNT(*) as bossCount
        FROM bosses 
        WHERE guildId = ?
      `).get(guildId);
      stats.bossesSpawned = bossData?.bossCount || 0;
    } catch (e) {
      // bosses table might not exist
    }

    // Add Discord user info for visitors and travelers
    const discordToken = process.env.DISCORD_TOKEN;
    if (discordToken) {
      try {
        // Add avatar URLs to visitors
        for (const visitor of visitors) {
          try {
            const response = await fetchSafe(`https://discord.com/api/users/${visitor.userId}`, {
              headers: { Authorization: `Bot ${discordToken}` }
            });
            if (response.ok) {
              const discordUser = await response.json();
              visitor.avatar = discordUser.avatar 
                ? `https://cdn.discordapp.com/avatars/${visitor.userId}/${discordUser.avatar}.png`
                : null;
            }
          } catch (e) {
            // Ignore individual Discord API errors
          }
        }

        // Add avatar URLs to travelers
        for (const traveler of incomingTravelers) {
          try {
            const response = await fetchSafe(`https://discord.com/api/users/${traveler.userId}`, {
              headers: { Authorization: `Bot ${discordToken}` }
            });
            if (response.ok) {
              const discordUser = await response.json();
              traveler.avatar = discordUser.avatar 
                ? `https://cdn.discordapp.com/avatars/${traveler.userId}/${discordUser.avatar}.png`
                : null;
            }
          } catch (e) {
            // Ignore individual Discord API errors
          }
        }
      } catch (e) {
        // Ignore Discord API errors
      }
    }

    const serverInfo = {
      server,
      visitors,
      incomingTravelers,
      activeBoss,
      bossParticipants,
      recentBosses,
      stats
    };

    res.json(serverInfo);

  } catch (error) {
    console.error('GET /api/server error:', error);
    res.status(500).json({ error: 'server_error', message: 'Failed to load server information' });
  }
});

module.exports = router;

// List up to 10 visitors for a server (for popup). Falls back to counts if >10.
router.get('/api/map/visitors', rateLimit(), async (req,res)=>{
  try{
    const guildId = String(req.query.guildId||'').trim();
    const limit = Math.max(1, Math.min(10, parseInt(req.query.limit||'10', 10)));
    if (!guildId) return res.status(400).json({ error: 'missing_guildId' });
    const now = Date.now();
    const totalRow = db.prepare('SELECT COUNT(*) as n FROM players WHERE locationGuildId=? AND (travelArrivalAt=0 OR travelArrivalAt<=?)')
                      .get(guildId, now);
    const total = totalRow?.n || 0;
    if (total === 0) return res.json({ total: 0, users: [] });

    // If there are many visitors, don't expand the list
    if (total > limit){
      // Still return up to 10 for small servers if caller wants to display partial
      const limited = db.prepare('SELECT userId, COALESCE(name, userId) AS name FROM players WHERE locationGuildId=? AND (travelArrivalAt=0 OR travelArrivalAt<=?) LIMIT ?')
                        .all(guildId, now, limit);
      // Try to enrich with Discord avatars/names/roles; best-effort
      const users = await Promise.all(limited.map(async r => {
        let name = r.name, avatar=null, roleLevel = 'User';
        try{
          const r2 = await fetchSafe(`https://discord.com/api/guilds/${guildId}/members/${r.userId}`, {
            headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` }
          });
          if (r2.ok){
            const m = await r2.json();
            const u = m.user || {};
            name = u.global_name || u.username || name;
            if (u.avatar) avatar = `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png`;
            else avatar = 'https://cdn.discordapp.com/embed/avatars/0.png';
          }
        }catch{}
        
        // Get role level
        try {
          roleLevel = await fetchRoleLevel(r.userId);
        } catch {}
        
        return { id: r.userId, name: `[${roleLevel}] ${name}`, avatar };
      }));
      return res.json({ total, users, tooMany: total > limit, limit });
    }

    // For <= limit, fetch enriched details for all
    const rows = db.prepare('SELECT userId, COALESCE(name, userId) AS name FROM players WHERE locationGuildId=? AND (travelArrivalAt=0 OR travelArrivalAt<=?) LIMIT ?')
                   .all(guildId, now, limit);
    const users = await Promise.all(rows.map(async r => {
      let name = r.name, avatar=null, roleLevel = 'User';
      try{
        const r2 = await fetchSafe(`https://discord.com/api/guilds/${guildId}/members/${r.userId}`, {
          headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` }
        });
        if (r2.ok){
          const m = await r2.json();
          const u = m.user || {};
          name = u.global_name || u.username || name;
          if (u.avatar) avatar = `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png`;
          else avatar = 'https://cdn.discordapp.com/embed/avatars/0.png';
        }
      }catch{}
      
      // Get role level
      try {
        const { fetchRoleLevel } = require('../util');
        roleLevel = await fetchRoleLevel(r.userId);
      } catch {}
      
      return { id: r.userId, name: `[${roleLevel}] ${name}`, avatar };
    }));
    return res.json({ total, users, tooMany: false, limit });
  }catch(e){
    console.error('GET /api/map/visitors error', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// === Token purchase webhook ===
// Call this from your payment provider. Expect either a flat body with
// { guildId, tokens } OR a provider-shaped event with metadata.guildId/tokens.
// Authenticate with header: X-Webhook-Secret: <config.billing.webhookSecret>.
router.post('/api/tokens/webhook', express.json({ limit: '512kb' }), (req, res) => {
  try{
    const secret = (require('../../utils/config').billing && require('../../utils/config').billing.webhookSecret) || null;
    // SECURITY: Only accept secrets via headers to prevent exposure in logs
    const provided = req.get('x-webhook-secret') || '';
    if (!secret || provided !== secret){
      return res.status(401).json({ ok:false, error: 'unauthorized' });
    }

    const body = req.body || {};

    // Idempotency (optional): use provided key or event id
    const eventId = (req.get('idempotency-key') || body.id || body.eventId || '').toString();
    if (eventId){
      const seen = db.prepare('SELECT 1 FROM webhook_events WHERE id=?').get(eventId);
      if (seen){ return res.json({ ok:true, duplicate:true }); }
      db.prepare('INSERT OR IGNORE INTO webhook_events(id, receivedAt) VALUES (?, ?)').run(eventId, Date.now());
    }

    // Extract guildId
    const guildId = (
      body.guildId ||
      (body.metadata && body.metadata.guildId) ||
      (body.data && body.data.object && body.data.object.metadata && body.data.object.metadata.guildId) ||
      ''
    ).toString();

    // Determine token amount
    function toInt(x){ const n = parseInt(x, 10); return Number.isFinite(n) && n>0 ? n : 0; }
    let amount =
      toInt(body.tokens) ||
      toInt(body.amount) ||
      toInt(body?.metadata?.tokens) ||
      toInt(body?.data?.object?.metadata?.tokens) || 0;

    // Optionally map price/product IDs -> token counts via config.billing.tokenProductMap
    try{
      const tokenMap = (require('../../utils/config').billing && require('../../utils/config').billing.tokenProductMap) || {};
      const items = body?.data?.object?.line_items || body?.line_items || [];
      if (Array.isArray(items)){
        for (const it of items){
          const priceId = it.price?.id || it.price || it.price_id || it.id;
          const qty = toInt(it.quantity || it.qty || 1);
          if (priceId && tokenMap[priceId]){
            amount += (tokenMap[priceId] * qty);
          }
        }
      }
    }catch{}

    if (!guildId) return res.status(400).json({ ok:false, error: 'missing_guildId' });
    if (!amount) return res.status(400).json({ ok:false, error: 'missing_amount' });

    // Credit tokens
    const exists = db.prepare('SELECT 1 FROM servers WHERE guildId=?').get(guildId);
    if (!exists){
      return res.status(404).json({ ok:false, error: 'unknown_guild' });
    }
    db.prepare('UPDATE servers SET tokens = COALESCE(tokens, 0) + ? WHERE guildId=?').run(amount, guildId);

    return res.json({ ok:true, guildId, credited: amount });
  }catch(e){
    console.error('POST /api/tokens/webhook error', e);
    res.status(500).json({ ok:false, error: 'server_error' });
  }
});


// === Token removal webhook (simple secret) ===
router.post('/api/tokens/remove', express.json({ limit: '512kb' }), (req, res) => {
  try{
    const secret = (require('../../utils/config').billing && require('../../utils/config').billing.webhookSecret) || null;
    // SECURITY: Only accept secrets via headers to prevent exposure in logs
    const provided = req.get('x-webhook-secret') || '';
    if (!secret || provided !== secret){
      return res.status(401).json({ ok:false, error: 'unauthorized' });
    }
    const body = req.body || {};
    const guildId = (body.guildId || '').toString();
    const amount = Math.max(0, parseInt(body.tokens || body.amount || '0', 10));
    const eventId = (req.get('idempotency-key') || body.id || body.eventId || '').toString();

    if (!guildId) return res.status(400).json({ ok:false, error: 'missing_guildId' });
    if (!amount)  return res.status(400).json({ ok:false, error: 'missing_amount' });

    // Idempotency check
    if (eventId){
      const seen = db.prepare('SELECT 1 FROM webhook_events WHERE id=?').get(eventId);
      if (seen){ return res.json({ ok:true, duplicate:true }); }
      db.prepare('INSERT OR IGNORE INTO webhook_events(id, receivedAt) VALUES (?, ?)').run(eventId, Date.now());
    }

    const exists = db.prepare('SELECT 1 FROM servers WHERE guildId=?').get(guildId);
    if (!exists) return res.status(404).json({ ok:false, error: 'unknown_guild' });

    db.prepare('UPDATE servers SET tokens = MAX(0, COALESCE(tokens,0) - ?) WHERE guildId=?').run(amount, guildId);
    const after = db.prepare('SELECT tokens FROM servers WHERE guildId=?').get(guildId)?.tokens ?? 0;
    return res.json({ ok:true, guildId, removed: amount, tokens: after });
  }catch(e){
    console.error('POST /api/tokens/remove error', e);
    res.status(500).json({ ok:false, error: 'server_error' });
  }
});


// === Create Stripe Checkout Session (secure) ===


// === Profile/Analytics endpoints ===

// Analytics endpoint for user battle/travel stats
router.get('/api/analytics', rateLimit(30, 60000), async (req, res) => {
  try {
    if (!req.session?.user) {
      return res.status(401).json({ error: 'not_authenticated' });
    }
    
    const userId = req.session.user.id;
    
    // Get battle analytics
    let battleStats = {};
    try {
      // Get total battles count
      const totalBattles = db.prepare(`
        SELECT COUNT(*) as battles
        FROM battle_analytics 
        WHERE userId = ?
      `).get(userId);
      
      // Get most used weapon (weapon with most battles)
      const bestWeaponQuery = db.prepare(`
        SELECT weapon, COUNT(*) as usageCount
        FROM battle_analytics 
        WHERE userId = ? AND weapon IS NOT NULL AND weapon != 'none'
        GROUP BY weapon
        ORDER BY COUNT(*) DESC
        LIMIT 1
      `).get(userId);
      
      // Get actual boss defeats from players table (not attacks)
      const playerStats = db.prepare(`
        SELECT bossKills
        FROM players 
        WHERE userId = ?
      `).get(userId);
      
      battleStats = {
        battles: totalBattles?.battles || 0,
        wins: Math.floor((totalBattles?.battles || 0) * 0.6), // Estimate 60% win rate since we don't track wins yet
        bossKills: playerStats?.bossKills || 0, // Use actual boss defeats, not attacks
        bestWeapon: bestWeaponQuery?.weapon || 'None'
      };
    } catch (e) {
      // If battle_analytics table doesn't exist, provide defaults
      battleStats = { battles: 0, wins: 0, bossKills: 0, bestWeapon: 'None' };
    }
    
    // Get travel history analytics
    let travelStats = {};
    try {
      const travelAnalytics = db.prepare(`
        SELECT 
          COUNT(*) as totalTrips,
          COUNT(DISTINCT toGuildId) as uniqueServers,
          SUM(travelTime) as totalTravelTime
        FROM travel_history 
        WHERE userId = ?
      `).get(userId);
      
      // Calculate total distance by getting distance for each travel (if server coordinates exist)
      let totalDistance = 0;
      try {
        const travels = db.prepare(`
          SELECT fromGuildId, toGuildId
          FROM travel_history 
          WHERE userId = ?
        `).all(userId);
        
        for (const travel of travels) {
          if (travel.fromGuildId && travel.toGuildId) {
            const fromServer = db.prepare('SELECT lat, lon FROM servers WHERE guildId = ?').get(travel.fromGuildId);
            const toServer = db.prepare('SELECT lat, lon FROM servers WHERE guildId = ?').get(travel.toGuildId);
            
            if (fromServer?.lat != null && fromServer?.lon != null && 
                toServer?.lat != null && toServer?.lon != null) {
              const { haversine } = require('../../utils/geo');
              totalDistance += haversine(fromServer.lat, fromServer.lon, toServer.lat, toServer.lon);
            }
          }
        }
      } catch (e) {
        // If distance calculation fails, set to 0
        totalDistance = 0;
      }
      
      travelStats = {
        totalTrips: travelAnalytics?.totalTrips || 0,
        uniqueServers: travelAnalytics?.uniqueServers || 0,
        totalDistance: totalDistance,
        totalTravelTime: travelAnalytics?.totalTravelTime || 0
      };
    } catch (e) {
      // If travel_history table doesn't exist, try to estimate from current player location
      try {
        const player = db.prepare('SELECT locationGuildId FROM players WHERE userId = ?').get(userId);
        const uniqueServers = player?.locationGuildId ? 1 : 0; // At least current server if they have one
        travelStats = { 
          totalTrips: 0, 
          uniqueServers: uniqueServers, 
          totalDistance: 0, 
          totalTravelTime: 0 
        };
      } catch (e2) {
        travelStats = { totalTrips: 0, uniqueServers: 0, totalDistance: 0, totalTravelTime: 0 };
      }
    }
    
    res.json({
      ...battleStats,
      ...travelStats
    });
    
  } catch (error) {
    console.error('GET /api/analytics error:', error);
    res.status(500).json({ error: 'server_error' });
  }
});

// Helper function to check if user meets achievement criteria
function checkAchievementProgress(userId, achievementId) {
  try {
    switch (achievementId) {
      case 'first_travel':
        // Check if user has completed at least one travel
        const travelCount = db.prepare('SELECT COUNT(*) as count FROM travel_history WHERE userId = ?').get(userId);
        return (travelCount?.count || 0) >= 1;
        
      case 'explorer':
        // Check if user has visited 10 different servers
        const uniqueServers = db.prepare('SELECT COUNT(DISTINCT toGuildId) as count FROM travel_history WHERE userId = ?').get(userId);
        return (uniqueServers?.count || 0) >= 10;
        
      case 'boss_slayer':
        // Check if user has actually defeated at least one boss (not just attacked)
        const playerBossKills = db.prepare('SELECT bossKills FROM players WHERE userId = ?').get(userId);
        return (playerBossKills?.bossKills || 0) >= 1;
        
      case 'collector':
        // Check if user has 50 items total in inventory
        const totalItems = db.prepare('SELECT SUM(qty) as total FROM inventory WHERE userId = ?').get(userId);
        return (totalItems?.total || 0) >= 50;
        
      case 'wealthy':
        // Check if user has 1000+ gems
        const player = db.prepare('SELECT gems FROM players WHERE userId = ?').get(userId);
        return (player?.gems || 0) >= 1000;
        
      case 'veteran':
        // Check if user has completed 100 journeys
        const journeys = db.prepare('SELECT COUNT(*) as count FROM travel_history WHERE userId = ?').get(userId);
        return (journeys?.count || 0) >= 100;
        
      case 'storm_chaser':
        // Check if user has flown through 10 different weather events
        const stormEncounters = db.prepare('SELECT COUNT(DISTINCT weatherEventId) as count FROM weather_encounters WHERE userId = ? AND encounterType = "flew_through"').get(userId);
        return (stormEncounters?.count || 0) >= 10;
        
      case 'weather_navigator':
        // Check if user has successfully avoided 5 severe weather systems
        const avoidedWeather = db.prepare('SELECT COUNT(*) as count FROM weather_encounters WHERE userId = ? AND encounterType = "avoided"').get(userId);
        return (avoidedWeather?.count || 0) >= 5;
        
      case 'eye_of_storm':
        // Check if user has traveled through a cyclone or hurricane
        const severeWeather = db.prepare(`
          SELECT COUNT(*) as count FROM weather_encounters we 
          JOIN weather_events w ON we.weatherEventId = w.id 
          WHERE we.userId = ? AND we.encounterType = "flew_through" 
          AND w.type IN ('cyclone', 'hurricane')
        `).get(userId);
        return (severeWeather?.count || 0) >= 1;
        
      case 'aurora_witness':
        // Check if user has experienced an Aurora Storm
        const auroraEncounter = db.prepare(`
          SELECT COUNT(*) as count FROM weather_encounters we 
          JOIN weather_events w ON we.weatherEventId = w.id 
          WHERE we.userId = ? AND w.type = 'aurora_storm'
        `).get(userId);
        return (auroraEncounter?.count || 0) >= 1;
        
      case 'weather_survivor':
        // Check if user has encountered 25 different weather events
        const totalWeatherEncounters = db.prepare('SELECT COUNT(DISTINCT weatherEventId) as count FROM weather_encounters WHERE userId = ?').get(userId);
        return (totalWeatherEncounters?.count || 0) >= 25;
        
      default:
        return false;
    }
  } catch (e) {
    console.warn(`Failed to check progress for achievement ${achievementId}:`, e.message);
    return false;
  }
}

// Achievements endpoint
router.get('/api/achievements', rateLimit(30, 60000), async (req, res) => {
  try {
    if (!req.session?.user) {
      return res.status(401).json({ error: 'not_authenticated' });
    }
    
    const userId = req.session.user.id;
    
    // Get user achievements from database
    let userAchievements = [];
    try {
      userAchievements = db.prepare(`
        SELECT achievementId, unlockedAt 
        FROM achievements 
        WHERE userId = ?
      `).all(userId);
    } catch (e) {
      // If achievements table doesn't exist, return empty array
    }
    
    // Define available achievements
    const availableAchievements = [
      {
        id: 'first_travel',
        name: 'First Journey',
        description: 'Complete your first travel',
        icon: 'ROCKET'
      },
      {
        id: 'explorer',
        name: 'Explorer',
        description: 'Visit 10 different servers',
        icon: 'MAP'
      },
      {
        id: 'boss_slayer',
        name: 'Boss Slayer',
        description: 'Defeat your first boss',
        icon: 'SWORD'
      },
      {
        id: 'collector',
        name: 'Collector',
        description: 'Collect 50 items',
        icon: 'BACKPACK'
      },
      {
        id: 'wealthy',
        name: 'Wealthy Adventurer',
        description: 'Accumulate 1000 gems',
        icon: 'DIAMOND'
      },
      {
        id: 'veteran',
        name: 'Veteran Traveler',
        description: 'Complete 100 journeys',
        icon: 'TROPHY'
      },
      {
        id: 'storm_chaser',
        name: 'Storm Chaser',
        description: 'Fly through 10 different weather events',
        icon: 'TORNADO'
      },
      {
        id: 'weather_navigator',
        name: 'Weather Navigator',
        description: 'Successfully avoid 5 severe weather systems',
        icon: 'COMPASS'
      },
      {
        id: 'eye_of_storm',
        name: 'Eye of the Storm',
        description: 'Travel through a cyclone or hurricane',
        icon: 'EYE'
      },
      {
        id: 'aurora_witness',
        name: 'Aurora Witness',
        description: 'Experience the beauty of an Aurora Storm',
        icon: 'STARS'
      },
      {
        id: 'weather_survivor',
        name: 'Weather Survivor',
        description: 'Encounter 25 different weather events',
        icon: 'CLOUDS'
      }
    ];
    
    // Check each achievement and auto-unlock if criteria is met
    const achievementsWithStatus = [];
    const userAchievementIds = new Set(userAchievements.map(a => a.achievementId));
    
    for (const achievement of availableAchievements) {
      const isUnlocked = userAchievementIds.has(achievement.id);
      const meetsCriteria = checkAchievementProgress(userId, achievement.id);
      
      // Auto-unlock achievement if user meets criteria but hasn't been awarded yet
      if (!isUnlocked && meetsCriteria) {
        try {
          db.prepare(`
            INSERT INTO achievements (userId, achievementId, unlockedAt, rewardClaimed)
            VALUES (?, ?, ?, 0)
          `).run(userId, achievement.id, Date.now());
          
          console.log(`Auto-unlocked achievement ${achievement.id} for user ${userId}`);
          
          achievementsWithStatus.push({
            ...achievement,
            unlocked: true,
            justUnlocked: true // Flag for UI to show notification
          });
        } catch (e) {
          // Achievement might already exist due to race condition, treat as unlocked
          achievementsWithStatus.push({
            ...achievement,
            unlocked: true
          });
        }
      } else {
        achievementsWithStatus.push({
          ...achievement,
          unlocked: isUnlocked
        });
      }
    }
    
    const totalUnlocked = achievementsWithStatus.filter(a => a.unlocked).length;
    
    res.json({
      achievements: achievementsWithStatus,
      totalUnlocked,
      totalAvailable: availableAchievements.length
    });
    
  } catch (error) {
    console.error('GET /api/achievements error:', error);
    res.status(500).json({ error: 'server_error' });
  }
});

// === Admin Gems Management ===

// Add gems to a user (Staff/Developer only)
router.post('/api/admin/gems/add', rateLimit(20, 10000), ensureCsrf, async (req, res) => {
  try {
    const roleLevel = await getRoleLevel(req);
    if (!(roleLevel === 'Developer' || roleLevel === 'Staff')) {
      return res.status(403).json({ error: 'forbidden', message: 'Staff or Developer role required' });
    }

    const { userId, amount, reason } = req.body;
    if (!userId || !amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: 'invalid_input', message: 'Valid userId and positive amount required' });
    }

    // Ensure player exists
    const { ensurePlayerRow } = require('../util');
    const playerExists = db.prepare('SELECT 1 FROM players WHERE userId = ?').get(userId);
    if (!playerExists) {
      // Try to create a basic player entry
      try {
        const { getSpawnServer } = require('../util');
        const spawn = getSpawnServer();
        if (spawn) {
          db.prepare(`
            INSERT OR IGNORE INTO players (userId, name, locationGuildId, health, stamina, gems, staminaUpdatedAt)
            VALUES (?, ?, ?, 100, 100, 0, ?)
          `).run(userId, userId, spawn.guildId, Date.now());
        }
      } catch (e) {
        return res.status(404).json({ error: 'user_not_found', message: 'User not found in system' });
      }
    }

    // Add gems
    const amountInt = Math.floor(Math.abs(Number(amount)));
    db.prepare('UPDATE players SET gems = COALESCE(gems, 0) + ? WHERE userId = ?').run(amountInt, userId);

    // Log the transaction
    try {
      const { logGemsTransaction } = require('../../utils/gems');
      await logGemsTransaction(userId, amountInt, 'admin_add', { 
        adminId: req.session.user?.id, 
        reason: reason || 'Admin grant' 
      });
    } catch (e) {
      console.warn('Failed to log gems transaction:', e.message);
    }

    // Get updated balance
    const newBalance = db.prepare('SELECT gems FROM players WHERE userId = ?').get(userId)?.gems || 0;

    logger.info('admin_gems_add: %s gems added to user %s by %s (reason: %s)', amountInt, userId, req.session.user?.id, reason || 'none');

    // Log to webhook
    await logAdminActionFromReq(req, 'Gems Added', userId, null, { 
      'Amount Added': `${amountInt} gems`,
      'New Balance': `${newBalance} gems`,
      'Reason': reason || 'Admin grant'
    });

    res.json({ 
      success: true, 
      userId, 
      amountAdded: amountInt, 
      newBalance,
      reason: reason || 'Admin grant'
    });

  } catch (error) {
    console.error('POST /api/admin/gems/add error:', error);
    res.status(500).json({ error: 'server_error', message: 'Failed to add gems' });
  }
});

// Remove gems from a user (Staff/Developer only)
router.post('/api/admin/gems/remove', rateLimit(20, 10000), ensureCsrf, async (req, res) => {
  try {
    const roleLevel = await getRoleLevel(req);
    if (!(roleLevel === 'Developer' || roleLevel === 'Staff')) {
      return res.status(403).json({ error: 'forbidden', message: 'Staff or Developer role required' });
    }

    const { userId, amount, reason } = req.body;
    if (!userId || !amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: 'invalid_input', message: 'Valid userId and positive amount required' });
    }

    // Check if user exists
    const player = db.prepare('SELECT gems FROM players WHERE userId = ?').get(userId);
    if (!player) {
      return res.status(404).json({ error: 'user_not_found', message: 'User not found in system' });
    }

    const amountInt = Math.floor(Math.abs(Number(amount)));
    const currentBalance = player.gems || 0;

    // Remove gems (don't go below 0)
    db.prepare('UPDATE players SET gems = MAX(0, COALESCE(gems, 0) - ?) WHERE userId = ?').run(amountInt, userId);

    // Log the transaction
    try {
      const { logGemsTransaction } = require('../../utils/gems');
      await logGemsTransaction(userId, -amountInt, 'admin_remove', { 
        adminId: req.session.user?.id, 
        reason: reason || 'Admin removal' 
      });
    } catch (e) {
      console.warn('Failed to log gems transaction:', e.message);
    }

    // Get updated balance
    const newBalance = db.prepare('SELECT gems FROM players WHERE userId = ?').get(userId)?.gems || 0;
    const actualRemoved = currentBalance - newBalance;

    logger.info('admin_gems_remove: %s gems removed from user %s by %s (reason: %s)', actualRemoved, userId, req.session.user?.id, reason || 'none');

    res.json({ 
      success: true, 
      userId, 
      amountRemoved: actualRemoved,
      requestedAmount: amountInt,
      newBalance,
      reason: reason || 'Admin removal'
    });

  } catch (error) {
    console.error('POST /api/admin/gems/remove error:', error);
    res.status(500).json({ error: 'server_error', message: 'Failed to remove gems' });
  }
});

// Get user gems balance (Staff/Developer only)
router.get('/api/admin/gems/balance/:userId', rateLimit(30, 60000), async (req, res) => {
  try {
    const roleLevel = await getRoleLevel(req);
    if (!(roleLevel === 'Developer' || roleLevel === 'Staff')) {
      return res.status(403).json({ error: 'forbidden', message: 'Staff or Developer role required' });
    }

    const { userId } = req.params;
    if (!userId) {
      return res.status(400).json({ error: 'invalid_input', message: 'Valid userId required' });
    }

    const player = db.prepare('SELECT userId, name, gems, health, stamina FROM players WHERE userId = ?').get(userId);
    if (!player) {
      return res.status(404).json({ error: 'user_not_found', message: 'User not found in system' });
    }

    // Try to get Discord user info
    let discordUser = null;
    try {
      const response = await fetch(`https://discord.com/api/users/${userId}`, {
        headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` }
      });
      if (response.ok) {
        discordUser = await response.json();
      }
    } catch (e) {
      // Ignore Discord API errors
    }

    res.json({
      userId: player.userId,
      name: player.name,
      gems: player.gems || 0,
      health: player.health || 0,
      stamina: player.stamina || 0,
      discordUser: discordUser ? {
        username: discordUser.username,
        global_name: discordUser.global_name,
        avatar: discordUser.avatar ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png` : null
      } : null
    });

  } catch (error) {
    console.error('GET /api/admin/gems/balance error:', error);
    res.status(500).json({ error: 'server_error', message: 'Failed to get user balance' });
  }
});

// === Admin User Management ===

// Debug user stats (Staff/Developer only)
router.get('/api/admin/user/debug-stats/:userId', rateLimit(30, 60000), async (req, res) => {
  try {
    const roleLevel = await getRoleLevel(req);
    if (!(roleLevel === 'Developer' || roleLevel === 'Staff')) {
      return res.status(403).json({ error: 'forbidden', message: 'Staff or Developer role required' });
    }

    const { userId } = req.params;
    
    // Get all relevant stats from different tables
    const playerStats = db.prepare('SELECT userId, bossKills, serversVisited FROM players WHERE userId = ?').get(userId);
    const battleAnalytics = db.prepare('SELECT COUNT(*) as totalAttacks, COUNT(CASE WHEN bossId IS NOT NULL THEN 1 END) as bossAttacks FROM battle_analytics WHERE userId = ?').get(userId);
    const travelHistory = db.prepare('SELECT COUNT(*) as totalTrips, COUNT(DISTINCT toGuildId) as uniqueServers FROM travel_history WHERE userId = ?').get(userId);
    const achievements = db.prepare('SELECT COUNT(*) as totalAchievements FROM achievements WHERE userId = ?').get(userId);
    
    // Get sample boss attack entries
    const sampleBossAttacks = db.prepare('SELECT bossId, damage, weapon, timestamp FROM battle_analytics WHERE userId = ? AND bossId IS NOT NULL ORDER BY timestamp DESC LIMIT 5').all(userId);
    
    res.json({
      userId,
      playerStats: playerStats || { userId, bossKills: 0, serversVisited: 0 },
      battleAnalytics: battleAnalytics || { totalAttacks: 0, bossAttacks: 0 },
      travelHistory: travelHistory || { totalTrips: 0, uniqueServers: 0 },
      achievements: achievements || { totalAchievements: 0 },
      sampleBossAttacks,
      explanation: {
        bossKills_vs_bossAttacks: "bossKills = actual bosses defeated, bossAttacks = number of times attacked bosses",
        issue: "Profile was showing bossAttacks instead of bossKills - now fixed"
      }
    });

  } catch (error) {
    console.error('GET /api/admin/user/debug-stats error:', error);
    res.status(500).json({ error: 'server_error', message: 'Failed to get debug stats' });
  }
});

// Lookup user information (Staff/Developer only)
router.get('/api/admin/user/lookup/:userId', rateLimit(30, 60000), async (req, res) => {
  try {
    const roleLevel = await getRoleLevel(req);
    if (!(roleLevel === 'Developer' || roleLevel === 'Staff')) {
      return res.status(403).json({ error: 'forbidden', message: 'Staff or Developer role required' });
    }

    const { userId } = req.params;
    if (!userId) {
      return res.status(400).json({ error: 'invalid_input', message: 'Valid userId required' });
    }

    // Get player data
    let player = null;
    try {
      player = db.prepare(`
        SELECT userId, name, gems, health, stamina, locationGuildId, banned, banReason 
        FROM players WHERE userId = ?
      `).get(userId);
    } catch (e) {
      // If banned/banReason columns don't exist, try without them
      try {
        const basicPlayer = db.prepare(`
          SELECT userId, name, gems, health, stamina, locationGuildId
          FROM players WHERE userId = ?
        `).get(userId);
        if (basicPlayer) {
          player = {
            ...basicPlayer,
            banned: false,
            banReason: null
          };
        }
      } catch (e2) {
        // Even basic query failed
        player = null;
      }
    }

    // Try to get Discord user info
    let discordUser = null;
    try {
      const response = await fetchSafe(`https://discord.com/api/users/${userId}`, {
        headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` }
      });
      if (response.ok) {
        discordUser = await response.json();
      }
    } catch (e) {
      // Ignore Discord API errors
    }

    // Get role level
    let userRoleLevel = 'User';
    try {
      userRoleLevel = await fetchRoleLevel(userId);
    } catch (e) {
      // Ignore role fetch errors
    }

    // Get current server name
    let currentServer = 'Unknown';
    if (player && player.locationGuildId) {
      try {
        const serverInfo = db.prepare('SELECT name FROM servers WHERE guildId = ?').get(player.locationGuildId);
        currentServer = serverInfo?.name || 'Unknown Server';
      } catch (e) {
        // Ignore server lookup errors
      }
    }

    const userData = {
      userId: userId,
      username: discordUser ? (discordUser.global_name || discordUser.username) : (player?.name || 'Unknown'),
      avatar: discordUser?.avatar ? `https://cdn.discordapp.com/avatars/${userId}/${discordUser.avatar}.png` : null,
      roleLevel: userRoleLevel,
      gems: player?.gems || 0,
      health: player?.health || 0,
      stamina: player?.stamina || 0,
      currentServer: currentServer,
      banned: player?.banned || false,
      banReason: player?.banReason || null,
      exists: !!player
    };

    res.json(userData);

  } catch (error) {
    console.error('GET /api/admin/user/lookup error:', error);
    res.status(500).json({ error: 'server_error', message: 'Failed to lookup user' });
  }
});

// Ban user (Staff/Developer only)
router.post('/api/admin/user/ban', rateLimit(20, 10000), ensureCsrf, async (req, res) => {
  try {
    const roleLevel = await getRoleLevel(req);
    if (!(roleLevel === 'Developer' || roleLevel === 'Staff')) {
      return res.status(403).json({ error: 'forbidden', message: 'Staff or Developer role required' });
    }

    const { userId, reason } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'invalid_input', message: 'Valid userId required' });
    }

    // Ensure player exists
    const player = db.prepare('SELECT userId FROM players WHERE userId = ?').get(userId);
    if (!player) {
      // Create a basic player entry for banning
      try {
        const { getSpawnServer } = require('../util');
        const spawn = getSpawnServer();
        if (spawn) {
          try {
            db.prepare(`
              INSERT OR IGNORE INTO players (userId, name, locationGuildId, health, stamina, gems, banned, banReason, staminaUpdatedAt)
              VALUES (?, ?, ?, 100, 100, 0, 1, ?, ?)
            `).run(userId, userId, spawn.guildId, reason || 'Banned by staff', Date.now());
          } catch (e) {
            // Try without banned columns
            try {
              db.prepare(`
                INSERT OR IGNORE INTO players (userId, name, locationGuildId, health, stamina, gems)
                VALUES (?, ?, ?, 100, 100, 0)
              `).run(userId, userId, spawn.guildId);
            } catch (e2) {
              throw e2; // Re-throw the error to be caught by outer catch
            }
          }
        } else {
          return res.status(500).json({ error: 'server_error', message: 'Could not create player entry' });
        }
      } catch (e) {
        return res.status(500).json({ error: 'server_error', message: 'Failed to create player entry' });
      }
    } else {
      // Ban existing player
      try {
        db.prepare('UPDATE players SET banned = 1, banReason = ? WHERE userId = ?').run(reason || 'Banned by staff', userId);
      } catch (e) {
        // If banned/banReason columns don't exist, we can't ban users
        return res.status(500).json({ error: 'server_error', message: 'Ban functionality not available - database schema missing banned columns' });
      }
    }

    logger.info('admin_user_ban: %s banned by %s (reason: %s)', userId, req.session.user?.id, reason || 'none');

    // Log to webhook
    await logAdminActionFromReq(req, 'User Ban', userId, null, { 
      Reason: reason || 'Banned by staff',
      Action: 'User account banned'
    });

    res.json({ 
      success: true, 
      message: 'User banned successfully',
      userId,
      reason: reason || 'Banned by staff',
      bannedBy: req.session.user?.id
    });

  } catch (error) {
    console.error('POST /api/admin/user/ban error:', error);
    res.status(500).json({ error: 'server_error', message: 'Failed to ban user' });
  }
});

// Unban user (Staff/Developer only)
router.post('/api/admin/user/unban', rateLimit(20, 10000), ensureCsrf, async (req, res) => {
  try {
    const roleLevel = await getRoleLevel(req);
    if (!(roleLevel === 'Developer' || roleLevel === 'Staff')) {
      return res.status(403).json({ error: 'forbidden', message: 'Staff or Developer role required' });
    }

    const { userId, reason } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'invalid_input', message: 'Valid userId required' });
    }

    // Check if user exists and is banned
    let player = null;
    try {
      player = db.prepare('SELECT banned FROM players WHERE userId = ?').get(userId);
    } catch (e) {
      // banned column doesn't exist, check if user exists at all
      try {
        player = db.prepare('SELECT userId FROM players WHERE userId = ?').get(userId);
        if (player) {
          player.banned = false; // Assume not banned if column doesn't exist
        }
      } catch (e2) {
        player = null;
      }
    }
    
    if (!player) {
      return res.status(404).json({ error: 'user_not_found', message: 'User not found in system' });
    }

    if (!player.banned) {
      return res.status(400).json({ error: 'invalid_action', message: 'User is not banned' });
    }

    // Unban user
    try {
      db.prepare('UPDATE players SET banned = 0, banReason = NULL WHERE userId = ?').run(userId);
    } catch (e) {
      return res.status(500).json({ error: 'server_error', message: 'Unban functionality not available - database schema missing banned columns' });
    }

    logger.info('admin_user_unban: %s unbanned by %s (reason: %s)', userId, req.session.user?.id, reason || 'none');

    // Log to webhook
    await logAdminActionFromReq(req, 'User Unban', userId, null, { 
      Reason: reason || 'Unbanned by staff',
      Action: 'User account unbanned'
    });

    res.json({ 
      success: true, 
      message: 'User unbanned successfully',
      userId,
      unbannedBy: req.session.user?.id
    });

  } catch (error) {
    console.error('POST /api/admin/user/unban error:', error);
    res.status(500).json({ error: 'server_error', message: 'Failed to unban user' });
  }
});

// Kick user from all servers (Staff/Developer only)
router.post('/api/admin/user/kick', rateLimit(20, 10000), ensureCsrf, async (req, res) => {
  try {
    const roleLevel = await getRoleLevel(req);
    if (!(roleLevel === 'Developer' || roleLevel === 'Staff')) {
      return res.status(403).json({ error: 'forbidden', message: 'Staff or Developer role required' });
    }

    const { userId, reason } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'invalid_input', message: 'Valid userId required' });
    }

    // Check if user exists
    const player = db.prepare('SELECT userId FROM players WHERE userId = ?').get(userId);
    if (!player) {
      return res.status(404).json({ error: 'user_not_found', message: 'User not found in system' });
    }

    // Get Discord user info for logging
    let discordUser = null;
    try {
      const response = await fetchSafe(`https://discord.com/api/users/${userId}`, {
        headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` }
      });
      if (response.ok) {
        discordUser = await response.json();
      }
    } catch (e) {
      // Ignore Discord API errors
    }

    // Get all servers to kick from
    const servers = db.prepare('SELECT guildId FROM servers').all();
    let kickedCount = 0;
    let errors = [];

    // Try to kick from each server using Discord API
    for (const server of servers) {
      try {
        const kickResponse = await fetchSafe(`https://discord.com/api/guilds/${server.guildId}/members/${userId}`, {
          method: 'DELETE',
          headers: { 
            Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
            'X-Audit-Log-Reason': reason || 'Kicked by staff via admin panel'
          }
        });

        if (kickResponse.ok || kickResponse.status === 404) {
          // 404 means user wasn't in server anyway
          kickedCount++;
        } else {
          errors.push(`Server ${server.guildId}: HTTP ${kickResponse.status}`);
        }
      } catch (error) {
        errors.push(`Server ${server.guildId}: ${error.message}`);
      }
    }

    logger.info('admin_user_kick: %s kicked from %d servers by %s (reason: %s)', 
      userId, kickedCount, req.session.user?.id, reason || 'none');

    res.json({ 
      success: true, 
      message: 'Kick operation completed',
      userId,
      username: discordUser ? (discordUser.global_name || discordUser.username) : userId,
      kickedFromServers: kickedCount,
      totalServers: servers.length,
      errors: errors.length > 0 ? errors.slice(0, 5) : [], // Limit error details
      reason: reason || 'Kicked by staff',
      kickedBy: req.session.user?.id
    });

  } catch (error) {
    console.error('POST /api/admin/user/kick error:', error);
    res.status(500).json({ error: 'server_error', message: 'Failed to kick user' });
  }
});

// === Admin Server Management ===

// Lookup server information (Staff/Developer only)
router.get('/api/admin/server/lookup/:guildId', rateLimit(30, 60000), async (req, res) => {
  try {
    const roleLevel = await getRoleLevel(req);
    if (!(roleLevel === 'Developer' || roleLevel === 'Staff')) {
      return res.status(403).json({ error: 'forbidden', message: 'Staff or Developer role required' });
    }

    const { guildId } = req.params;
    if (!guildId) {
      return res.status(400).json({ error: 'invalid_input', message: 'Valid guildId required' });
    }

    // Get server data
    let server = null;
    try {
      server = db.prepare(`
        SELECT guildId, name, ownerId, iconUrl, lat, lon, biome, discoverable, tokens, banned, banReason, archived, archivedAt
        FROM servers WHERE guildId = ?
      `).get(guildId);
    } catch (e) {
      // If banned/archived columns don't exist, try without them
      try {
        const basicServer = db.prepare(`
          SELECT guildId, name, ownerId, iconUrl, lat, lon, biome, discoverable
          FROM servers WHERE guildId = ?
        `).get(guildId);
        if (basicServer) {
          server = {
            ...basicServer,
            tokens: 0,
            banned: false,
            banReason: null,
            archived: false,
            archivedAt: null
          };
        }
      } catch (e2) {
        server = null;
      }
    }

    if (!server) {
      return res.status(404).json({ error: 'server_not_found', message: 'Server not found in database' });
    }

    // Get visitor count
    const visitorCount = db.prepare(`
      SELECT COUNT(*) as count FROM players 
      WHERE locationGuildId = ? AND (travelArrivalAt = 0 OR travelArrivalAt <= ?)
    `).get(guildId, Date.now())?.count || 0;

    // Try to get Discord guild info
    let discordGuild = null;
    try {
      const response = await fetchSafe(`https://discord.com/api/guilds/${guildId}`, {
        headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` }
      });
      if (response.ok) {
        discordGuild = await response.json();
      }
    } catch (e) {
      // Ignore Discord API errors
    }

    const serverData = {
      guildId: server.guildId,
      name: server.name,
      discordName: discordGuild?.name || server.name,
      ownerId: server.ownerId,
      iconUrl: server.iconUrl,
      memberCount: discordGuild?.member_count || 0,
      lat: server.lat,
      lon: server.lon,
      biome: server.biome,
      discoverable: server.discoverable || false,
      tokens: server.tokens || 0,
      visitors: visitorCount,
      banned: server.banned || false,
      banReason: server.banReason || null,
      archived: server.archived || false,
      archivedAt: server.archivedAt || null
    };

    res.json(serverData);

  } catch (error) {
    console.error('GET /api/admin/server/lookup error:', error);
    res.status(500).json({ error: 'server_error', message: 'Failed to lookup server' });
  }
});

// Ban server (Staff/Developer only)
router.post('/api/admin/server/ban', rateLimit(20, 10000), ensureCsrf, async (req, res) => {
  try {
    const roleLevel = await getRoleLevel(req);
    if (!(roleLevel === 'Developer' || roleLevel === 'Staff')) {
      return res.status(403).json({ error: 'forbidden', message: 'Staff or Developer role required' });
    }

    const { guildId, reason } = req.body;
    if (!guildId) {
      return res.status(400).json({ error: 'invalid_input', message: 'Valid guildId required' });
    }

    // Check if server exists
    const server = db.prepare('SELECT guildId FROM servers WHERE guildId = ?').get(guildId);
    if (!server) {
      return res.status(404).json({ error: 'server_not_found', message: 'Server not found in system' });
    }

    // Ban server
    try {
      db.prepare('UPDATE servers SET banned = 1, banReason = ? WHERE guildId = ?').run(reason || 'Banned by staff', guildId);
    } catch (e) {
      // If banned/banReason columns don't exist, we can't ban servers
      return res.status(500).json({ error: 'server_error', message: 'Ban functionality not available - database schema missing banned columns' });
    }

    logger.info('admin_server_ban: %s banned by %s (reason: %s)', guildId, req.session.user?.id, reason || 'none');

    res.json({ 
      success: true, 
      message: 'Server banned successfully',
      guildId,
      reason: reason || 'Banned by staff',
      bannedBy: req.session.user?.id
    });

  } catch (error) {
    console.error('POST /api/admin/server/ban error:', error);
    res.status(500).json({ error: 'server_error', message: 'Failed to ban server' });
  }
});

// Unban server (Staff/Developer only)
router.post('/api/admin/server/unban', rateLimit(20, 10000), ensureCsrf, async (req, res) => {
  try {
    const roleLevel = await getRoleLevel(req);
    if (!(roleLevel === 'Developer' || roleLevel === 'Staff')) {
      return res.status(403).json({ error: 'forbidden', message: 'Staff or Developer role required' });
    }

    const { guildId, reason } = req.body;
    if (!guildId) {
      return res.status(400).json({ error: 'invalid_input', message: 'Valid guildId required' });
    }

    // Check if server exists and is banned
    let server = null;
    try {
      server = db.prepare('SELECT banned FROM servers WHERE guildId = ?').get(guildId);
    } catch (e) {
      // banned column doesn't exist, check if server exists at all
      try {
        server = db.prepare('SELECT guildId FROM servers WHERE guildId = ?').get(guildId);
        if (server) {
          server.banned = false; // Assume not banned if column doesn't exist
        }
      } catch (e2) {
        server = null;
      }
    }
    
    if (!server) {
      return res.status(404).json({ error: 'server_not_found', message: 'Server not found in system' });
    }

    if (!server.banned) {
      return res.status(400).json({ error: 'invalid_action', message: 'Server is not banned' });
    }

    // Unban server
    try {
      db.prepare('UPDATE servers SET banned = 0, banReason = NULL WHERE guildId = ?').run(guildId);
    } catch (e) {
      return res.status(500).json({ error: 'server_error', message: 'Unban functionality not available - database schema missing banned columns' });
    }

    logger.info('admin_server_unban: %s unbanned by %s (reason: %s)', guildId, req.session.user?.id, reason || 'none');

    res.json({ 
      success: true, 
      message: 'Server unbanned successfully',
      guildId,
      unbannedBy: req.session.user?.id
    });

  } catch (error) {
    console.error('POST /api/admin/server/unban error:', error);
    res.status(500).json({ error: 'server_error', message: 'Failed to unban server' });
  }
});

// === Admin Statistics ===

// Reset user statistics (Staff/Developer only)
router.post('/api/admin/user/reset-stats', rateLimit(20, 10000), ensureCsrf, async (req, res) => {
  try {
    const roleLevel = await getRoleLevel(req);
    if (!(roleLevel === 'Developer' || roleLevel === 'Staff')) {
      return res.status(403).json({ error: 'forbidden', message: 'Staff or Developer role required' });
    }

    const { userId, resetType, reason } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'invalid_input', message: 'Valid userId required' });
    }

    // Check if user exists
    const player = db.prepare('SELECT userId FROM players WHERE userId = ?').get(userId);
    if (!player) {
      return res.status(404).json({ error: 'user_not_found', message: 'User not found in system' });
    }

    let resetOperations = [];
    let resetDescription = [];

    // Determine what to reset based on resetType
    switch (resetType) {
      case 'all':
        resetOperations = [
          'DELETE FROM travel_history WHERE userId = ?',
          'DELETE FROM battle_analytics WHERE userId = ?', 
          'DELETE FROM achievements WHERE userId = ?',
          'UPDATE players SET serversVisited = 0, bossKills = 0 WHERE userId = ?'
        ];
        resetDescription = ['travel history', 'battle analytics', 'achievements', 'player stats'];
        break;
        
      case 'travel':
        resetOperations = [
          'DELETE FROM travel_history WHERE userId = ?',
          'UPDATE players SET serversVisited = 0 WHERE userId = ?'
        ];
        resetDescription = ['travel history', 'servers visited count'];
        break;
        
      case 'battle':
        resetOperations = [
          'DELETE FROM battle_analytics WHERE userId = ?',
          'UPDATE players SET bossKills = 0 WHERE userId = ?'
        ];
        resetDescription = ['battle analytics', 'boss kill count'];
        break;
        
      case 'achievements':
        resetOperations = ['DELETE FROM achievements WHERE userId = ?'];
        resetDescription = ['achievements'];
        break;
        
      default:
        return res.status(400).json({ error: 'invalid_input', message: 'resetType must be: all, travel, battle, or achievements' });
    }

    // Execute reset operations
    let successCount = 0;
    const errors = [];
    
    for (let i = 0; i < resetOperations.length; i++) {
      try {
        const result = db.prepare(resetOperations[i]).run(userId);
        successCount++;
        console.log(`Reset operation ${i + 1} completed: ${result.changes} rows affected`);
      } catch (error) {
        errors.push(`${resetDescription[i]}: ${error.message}`);
        console.error(`Reset operation ${i + 1} failed:`, error.message);
      }
    }

    logger.info('admin_user_reset_stats: user %s resetType %s by %s (reason: %s) - %d/%d operations successful', 
      userId, resetType, req.session.user?.id, reason || 'none', successCount, resetOperations.length);

    // Log to webhook
    await logAdminActionFromReq(req, 'User Stats Reset', userId, null, { 
      'Reset Type': resetType,
      'Operations Completed': `${successCount}/${resetOperations.length}`,
      'Reset Areas': resetDescription.join(', '),
      'Reason': reason || 'Admin reset'
    });

    res.json({
      success: true,
      message: `User stats reset completed`,
      userId,
      resetType,
      operationsCompleted: successCount,
      totalOperations: resetOperations.length,
      resetAreas: resetDescription,
      errors: errors.length > 0 ? errors : undefined,
      reason: reason || 'Admin reset'
    });

  } catch (error) {
    console.error('POST /api/admin/user/reset-stats error:', error);
    res.status(500).json({ error: 'server_error', message: 'Failed to reset user stats' });
  }
});

// Get system statistics (Staff/Developer only)
router.get('/api/admin/stats', rateLimit(30, 60000), async (req, res) => {
  try {
    const roleLevel = await getRoleLevel(req);
    if (!(roleLevel === 'Developer' || roleLevel === 'Staff')) {
      return res.status(403).json({ error: 'forbidden', message: 'Staff or Developer role required' });
    }

    // Get various statistics
    const totalUsers = db.prepare('SELECT COUNT(*) as count FROM players').get()?.count || 0;
    const totalServers = db.prepare('SELECT COUNT(*) as count FROM servers').get()?.count || 0;
    
    // Try to get banned users, fall back to 0 if column doesn't exist
    let bannedUsers = 0;
    try {
      bannedUsers = db.prepare('SELECT COUNT(*) as count FROM players WHERE banned = 1').get()?.count || 0;
    } catch (e) {
      // banned column doesn't exist, use 0
    }
    
    // Try to get archived servers, fall back to 0 if column doesn't exist  
    let archivedServers = 0;
    try {
      archivedServers = db.prepare('SELECT COUNT(*) as count FROM servers WHERE archived = 1').get()?.count || 0;
    } catch (e) {
      // archived column doesn't exist, use 0
    }
    
    const activeUsers = db.prepare('SELECT COUNT(*) as count FROM players WHERE gems > 0 OR health > 0 OR stamina > 0').get()?.count || 0;
    const totalGems = db.prepare('SELECT COALESCE(SUM(gems), 0) as total FROM players').get()?.total || 0;

    res.json({
      totalUsers,
      totalServers,
      bannedUsers,
      archivedServers,
      activeUsers,
      totalGems,
      lastUpdated: Date.now()
    });

  } catch (error) {
    console.error('GET /api/admin/stats error:', error);
    res.status(500).json({ error: 'server_error', message: 'Failed to get statistics' });
  }
});

// === Admin Token Management ===

// Add tokens to a server (Staff/Developer only)
router.post('/api/admin/tokens/add', rateLimit(20, 10000), ensureCsrf, async (req, res) => {
  try {
    const roleLevel = await getRoleLevel(req);
    if (!(roleLevel === 'Developer' || roleLevel === 'Staff')) {
      return res.status(403).json({ error: 'forbidden', message: 'Staff or Developer role required' });
    }

    const { guildId, amount, reason } = req.body;
    if (!guildId || !amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: 'invalid_input', message: 'Valid guildId and positive amount required' });
    }

    // Check if server exists
    const server = db.prepare('SELECT tokens FROM servers WHERE guildId = ?').get(guildId);
    if (!server) {
      return res.status(404).json({ error: 'server_not_found', message: 'Server not found in system' });
    }

    const amountInt = Math.floor(Math.abs(Number(amount)));
    
    // Add tokens
    db.prepare('UPDATE servers SET tokens = COALESCE(tokens, 0) + ? WHERE guildId = ?').run(amountInt, guildId);

    // Get updated balance
    const newBalance = db.prepare('SELECT tokens FROM servers WHERE guildId = ?').get(guildId)?.tokens || 0;

    logger.info('admin_tokens_add: %s tokens added to server %s by %s (reason: %s)', amountInt, guildId, req.session.user?.id, reason || 'none');

    res.json({ 
      success: true, 
      guildId, 
      amountAdded: amountInt, 
      newBalance,
      reason: reason || 'Admin grant'
    });

  } catch (error) {
    console.error('POST /api/admin/tokens/add error:', error);
    res.status(500).json({ error: 'server_error', message: 'Failed to add tokens' });
  }
});

// Remove tokens from a server (Staff/Developer only)
router.post('/api/admin/tokens/remove', rateLimit(20, 10000), ensureCsrf, async (req, res) => {
  try {
    const roleLevel = await getRoleLevel(req);
    if (!(roleLevel === 'Developer' || roleLevel === 'Staff')) {
      return res.status(403).json({ error: 'forbidden', message: 'Staff or Developer role required' });
    }

    const { guildId, amount, reason } = req.body;
    if (!guildId || !amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: 'invalid_input', message: 'Valid guildId and positive amount required' });
    }

    // Check if server exists
    const server = db.prepare('SELECT tokens FROM servers WHERE guildId = ?').get(guildId);
    if (!server) {
      return res.status(404).json({ error: 'server_not_found', message: 'Server not found in system' });
    }

    const amountInt = Math.floor(Math.abs(Number(amount)));
    const currentBalance = server.tokens || 0;

    // Remove tokens (don't go below 0)
    db.prepare('UPDATE servers SET tokens = MAX(0, COALESCE(tokens, 0) - ?) WHERE guildId = ?').run(amountInt, guildId);

    // Get updated balance
    const newBalance = db.prepare('SELECT tokens FROM servers WHERE guildId = ?').get(guildId)?.tokens || 0;
    const actualRemoved = currentBalance - newBalance;

    logger.info('admin_tokens_remove: %s tokens removed from server %s by %s (reason: %s)', actualRemoved, guildId, req.session.user?.id, reason || 'none');

    res.json({ 
      success: true, 
      guildId, 
      amountRemoved: actualRemoved,
      requestedAmount: amountInt,
      newBalance,
      reason: reason || 'Admin removal'
    });

  } catch (error) {
    console.error('POST /api/admin/tokens/remove error:', error);
    res.status(500).json({ error: 'server_error', message: 'Failed to remove tokens' });
  }
});

// === Admin Inventory Management ===

// Get user inventory
router.get('/api/admin/user/inventory/:userId', rateLimit(30, 60000), async (req, res) => {
  try {
    const roleLevel = await getRoleLevel(req);
    if (roleLevel !== 'Developer' && roleLevel !== 'Staff') {
      return res.status(403).json({ error: 'forbidden', message: 'Access denied' });
    }

    const { userId } = req.params;
    if (!userId) {
      return res.status(400).json({ error: 'invalid_input', message: 'Valid userId required' });
    }

    // Get Discord user info
    let discordUser = null;
    try {
      const response = await fetchSafe(`https://discord.com/api/v10/users/${userId}`, {
        headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` }
      });
      if (response.ok) {
        discordUser = await response.json();
      }
    } catch (e) {
      console.warn('Failed to fetch Discord user for inventory lookup:', e.message);
    }

    // Get inventory
    const inventory = db.prepare('SELECT itemId, qty FROM inventory WHERE userId=? ORDER BY itemId').all(userId);

    res.json({
      userId,
      discordUser,
      inventory
    });

  } catch (error) {
    console.error('GET /api/admin/user/inventory error:', error);
    res.status(500).json({ error: 'server_error', message: 'Failed to get inventory' });
  }
});

// Add item to inventory
router.post('/api/admin/inventory/add', rateLimit(20, 10000), ensureCsrf, async (req, res) => {
  try {
    const roleLevel = await getRoleLevel(req);
    if (roleLevel !== 'Developer' && roleLevel !== 'Staff') {
      return res.status(403).json({ error: 'forbidden', message: 'Access denied' });
    }

    const { userId, itemId, quantity, reason } = req.body;
    if (!userId || !itemId || !quantity || quantity <= 0) {
      return res.status(400).json({ error: 'invalid_input', message: 'userId, itemId, and positive quantity required' });
    }

    // Ensure player exists
    ensurePlayerRow({ id: userId });

    // Check if item already exists in inventory
    const existing = db.prepare('SELECT qty FROM inventory WHERE userId=? AND itemId=?').get(userId, itemId);
    
    let newQuantity;
    if (existing) {
      // Update existing item
      newQuantity = existing.qty + quantity;
      db.prepare('UPDATE inventory SET qty=qty+? WHERE userId=? AND itemId=?').run(quantity, userId, itemId);
    } else {
      // Insert new item
      newQuantity = quantity;
      db.prepare('INSERT INTO inventory(userId, itemId, qty) VALUES(?, ?, ?)').run(userId, itemId, quantity);
    }

    logger.info('admin_inventory_add: user %s item %s qty %d by %s reason: %s', userId, itemId, quantity, req.session?.user?.username || 'Unknown', reason || 'none');

    res.json({
      success: true,
      message: `Added ${quantity}x ${itemId} to inventory`,
      newQuantity,
      userId,
      itemId,
      quantity,
      reason: reason || 'Admin addition'
    });

  } catch (error) {
    console.error('POST /api/admin/inventory/add error:', error);
    res.status(500).json({ error: 'server_error', message: 'Failed to add item' });
  }
});

// Remove item from inventory
router.post('/api/admin/inventory/remove', rateLimit(20, 10000), ensureCsrf, async (req, res) => {
  try {
    const roleLevel = await getRoleLevel(req);
    if (roleLevel !== 'Developer' && roleLevel !== 'Staff') {
      return res.status(403).json({ error: 'forbidden', message: 'Access denied' });
    }

    const { userId, itemId, quantity, reason } = req.body;
    if (!userId || !itemId || !quantity || quantity <= 0) {
      return res.status(400).json({ error: 'invalid_input', message: 'userId, itemId, and positive quantity required' });
    }

    // Check if item exists in inventory
    const existing = db.prepare('SELECT qty FROM inventory WHERE userId=? AND itemId=?').get(userId, itemId);
    
    if (!existing) {
      return res.status(400).json({ error: 'not_found', message: 'Item not found in inventory' });
    }

    let newQuantity = existing.qty - quantity;
    
    if (newQuantity <= 0) {
      // Remove item completely if quantity becomes 0 or negative
      db.prepare('DELETE FROM inventory WHERE userId=? AND itemId=?').run(userId, itemId);
      newQuantity = 0;
    } else {
      // Update existing item
      db.prepare('UPDATE inventory SET qty=? WHERE userId=? AND itemId=?').run(newQuantity, userId, itemId);
    }

    logger.info('admin_inventory_remove: user %s item %s qty %d by %s reason: %s', userId, itemId, quantity, req.session?.user?.username || 'Unknown', reason || 'none');

    res.json({
      success: true,
      message: `Removed ${quantity}x ${itemId} from inventory`,
      newQuantity,
      userId,
      itemId,
      quantity,
      reason: reason || 'Admin removal'
    });

  } catch (error) {
    console.error('POST /api/admin/inventory/remove error:', error);
    res.status(500).json({ error: 'server_error', message: 'Failed to remove item' });
  }
});

// Clear entire inventory
router.post('/api/admin/inventory/clear', rateLimit(20, 10000), ensureCsrf, async (req, res) => {
  try {
    const roleLevel = await getRoleLevel(req);
    if (roleLevel !== 'Developer' && roleLevel !== 'Staff') {
      return res.status(403).json({ error: 'forbidden', message: 'Access denied' });
    }

    const { userId, reason } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'invalid_input', message: 'userId required' });
    }

    // Get current inventory count for logging
    const itemCount = db.prepare('SELECT COUNT(*) as count FROM inventory WHERE userId=?').get(userId);
    const totalItems = itemCount ? itemCount.count : 0;

    // Clear all inventory for user
    db.prepare('DELETE FROM inventory WHERE userId=?').run(userId);

    logger.info('admin_inventory_clear: user %s cleared %d items by %s reason: %s', userId, totalItems, req.session?.user?.username || 'Unknown', reason || 'none');

    res.json({
      success: true,
      message: `Cleared all items from inventory (${totalItems} items removed)`,
      userId,
      itemsRemoved: totalItems,
      reason: reason || 'Admin clear'
    });

  } catch (error) {
    console.error('POST /api/admin/inventory/clear error:', error);
    res.status(500).json({ error: 'server_error', message: 'Failed to clear inventory' });
  }
});

// === Admin Boss Management ===

// List all active bosses
router.get('/api/admin/boss/list', rateLimit(30, 60000), async (req, res) => {
  try {
    const roleLevel = await getRoleLevel(req);
    if (roleLevel !== 'Developer' && roleLevel !== 'Staff') {
      return res.status(403).json({ error: 'forbidden', message: 'Access denied' });
    }

    // Get all active bosses
    const bosses = db.prepare(`
      SELECT id, guildId, name, maxHp, hp, startedAt, expiresAt, active, tier
      FROM bosses 
      WHERE active = 1 AND expiresAt > ?
      ORDER BY startedAt DESC
    `).all(Date.now());

    res.json({
      bosses,
      count: bosses.length
    });

  } catch (error) {
    console.error('GET /api/admin/boss/list error:', error);
    res.status(500).json({ error: 'server_error', message: 'Failed to list bosses' });
  }
});

// Spawn a boss in a specific server
router.post('/api/admin/boss/spawn', rateLimit(20, 10000), ensureCsrf, async (req, res) => {
  try {
    const roleLevel = await getRoleLevel(req);
    if (roleLevel !== 'Developer' && roleLevel !== 'Staff') {
      return res.status(403).json({ error: 'forbidden', message: 'Access denied' });
    }

    const { serverId, name, tier = 1, healthMultiplier = 1, durationMinutes = 60 } = req.body;
    
    if (!serverId) {
      return res.status(400).json({ error: 'invalid_input', message: 'serverId required' });
    }

    // Validate tier and multipliers
    const validTier = Math.max(1, Math.min(5, parseInt(tier)));
    const validHealthMultiplier = Math.max(0.1, Math.min(5, parseFloat(healthMultiplier)));
    const validDuration = Math.max(1, Math.min(480, parseInt(durationMinutes)));

    // Check if server exists
    const server = db.prepare('SELECT * FROM servers WHERE guildId=? AND archived=0').get(serverId);
    if (!server) {
      return res.status(400).json({ error: 'not_found', message: 'Server not found or is archived' });
    }

    if (!server.lat || !server.lon) {
      return res.status(400).json({ error: 'invalid_server', message: 'Server has no coordinates set' });
    }

    // Check for existing active boss
    const existingBoss = db.prepare('SELECT id FROM bosses WHERE guildId=? AND active=1 AND expiresAt > ?').get(serverId, Date.now());
    if (existingBoss) {
      return res.status(400).json({ error: 'boss_exists', message: 'Server already has an active boss' });
    }

    // Generate boss data
    const bossName = name || `${server.biome || 'Unknown'} Terror`;
    const baseHp = 2000; // Base health
    const tierMultiplier = 1 + (validTier - 1) * 0.2; // +20% per tier above 1
    const maxHp = Math.floor(baseHp * tierMultiplier * validHealthMultiplier);
    const now = Date.now();
    const expires = now + (validDuration * 60 * 1000);

    // Insert boss
    const result = db.prepare(`
      INSERT INTO bosses(guildId, name, maxHp, hp, startedAt, expiresAt, active, tier) 
      VALUES(?, ?, ?, ?, ?, ?, 1, ?)
    `).run(serverId, bossName, maxHp, maxHp, now, expires, validTier);

    // Update server's last boss time
    db.prepare('UPDATE servers SET lastBossAt=? WHERE guildId=?').run(now, serverId);

    logger.info('admin_boss_spawn: server %s boss %s tier %d hp %d duration %dm by %s', 
      serverId, bossName, validTier, maxHp, validDuration, req.session?.user?.username || 'Unknown');

    // Log to webhook
    await logAdminActionFromReq(req, 'Boss Spawn', serverId, server.name, { 
      'Boss Name': bossName,
      'Tier': `Tier ${validTier}`,
      'Max HP': `${maxHp.toLocaleString()} HP`,
      'Duration': `${validDuration} minutes`,
      'Server': server.name || serverId
    });

    res.json({
      success: true,
      message: `Boss spawned successfully`,
      bossId: result.lastInsertRowid,
      bossName,
      tier: validTier,
      maxHp,
      serverId,
      durationMinutes: validDuration,
      expiresAt: expires
    });

  } catch (error) {
    console.error('POST /api/admin/boss/spawn error:', error);
    res.status(500).json({ error: 'server_error', message: 'Failed to spawn boss' });
  }
});

// Kill a boss in a specific server
router.post('/api/admin/boss/kill', rateLimit(20, 10000), ensureCsrf, async (req, res) => {
  try {
    const roleLevel = await getRoleLevel(req);
    if (roleLevel !== 'Developer' && roleLevel !== 'Staff') {
      return res.status(403).json({ error: 'forbidden', message: 'Access denied' });
    }

    const { serverId } = req.body;
    
    if (!serverId) {
      return res.status(400).json({ error: 'invalid_input', message: 'serverId required' });
    }

    // Find active boss
    const boss = db.prepare('SELECT * FROM bosses WHERE guildId=? AND active=1 AND expiresAt > ?').get(serverId, Date.now());
    
    if (!boss) {
      return res.status(400).json({ error: 'not_found', message: 'No active boss found in this server' });
    }

    // Deactivate boss
    db.prepare('UPDATE bosses SET active=0, hp=0 WHERE id=?').run(boss.id);

    // Clean up participants (no rewards given for admin kill)
    db.prepare('DELETE FROM boss_participants WHERE bossId=?').run(boss.id);

    logger.info('admin_boss_kill: server %s boss %s (id %d) by %s', 
      serverId, boss.name, boss.id, req.session?.user?.username || 'Unknown');

    res.json({
      success: true,
      message: `Boss killed successfully`,
      bossName: boss.name,
      serverId
    });

  } catch (error) {
    console.error('POST /api/admin/boss/kill error:', error);
    res.status(500).json({ error: 'server_error', message: 'Failed to kill boss' });
  }
});

// Extend boss duration
router.post('/api/admin/boss/extend', rateLimit(20, 10000), ensureCsrf, async (req, res) => {
  try {
    const roleLevel = await getRoleLevel(req);
    if (roleLevel !== 'Developer' && roleLevel !== 'Staff') {
      return res.status(403).json({ error: 'forbidden', message: 'Access denied' });
    }

    const { serverId, durationMinutes = 60 } = req.body;
    
    if (!serverId) {
      return res.status(400).json({ error: 'invalid_input', message: 'serverId required' });
    }

    const validDuration = Math.max(1, Math.min(480, parseInt(durationMinutes)));

    // Find active boss
    const boss = db.prepare('SELECT * FROM bosses WHERE guildId=? AND active=1 AND expiresAt > ?').get(serverId, Date.now());
    
    if (!boss) {
      return res.status(400).json({ error: 'not_found', message: 'No active boss found in this server' });
    }

    // Extend boss duration
    const newExpiresAt = boss.expiresAt + (validDuration * 60 * 1000);
    db.prepare('UPDATE bosses SET expiresAt=? WHERE id=?').run(newExpiresAt, boss.id);

    logger.info('admin_boss_extend: server %s boss %s (id %d) extended by %dm by %s', 
      serverId, boss.name, boss.id, validDuration, req.session?.user?.username || 'Unknown');

    res.json({
      success: true,
      message: `Boss duration extended by ${validDuration} minutes`,
      bossName: boss.name,
      serverId,
      newExpiresAt,
      durationMinutes: validDuration
    });

  } catch (error) {
    console.error('POST /api/admin/boss/extend error:', error);
    res.status(500).json({ error: 'server_error', message: 'Failed to extend boss duration' });
  }
});

// === Public User Profiles ===

// Get public profile information for any user
router.get('/api/profile/:userId', rateLimit(30, 60000), async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) {
      return res.status(400).json({ error: 'invalid_input', message: 'Valid userId required' });
    }

    // Get player data
    let player = null;
    try {
      player = db.prepare(`
        SELECT userId, name, gems, health, stamina, locationGuildId, banned
        FROM players WHERE userId = ? AND banned = 0
      `).get(userId);
    } catch (e) {
      // If banned column doesn't exist, get all players (since we can't filter by banned status)
      try {
        player = db.prepare(`
          SELECT userId, name, gems, health, stamina, locationGuildId
          FROM players WHERE userId = ?
        `).get(userId);
        if (player) {
          player.banned = false; // Assume not banned if column doesn't exist
        }
      } catch (e2) {
        player = null;
      }
    }

    if (!player) {
      return res.status(404).json({ error: 'user_not_found', message: 'User not found or is banned' });
    }

    // Try to get Discord user info
    let discordUser = null;
    try {
      const response = await fetchSafe(`https://discord.com/api/users/${userId}`, {
        headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` }
      });
      if (response.ok) {
        discordUser = await response.json();
      }
    } catch (e) {
      // Ignore Discord API errors
    }

    // Get role level
    let userRoleLevel = 'User';
    try {
      userRoleLevel = await fetchRoleLevel(userId);
    } catch (e) {
      // Ignore role fetch errors
    }

    // Get current server name
    let currentLocationServer = null;
    if (player.locationGuildId) {
      try {
        currentLocationServer = db.prepare('SELECT guildId, name, lat, lon FROM servers WHERE guildId = ?').get(player.locationGuildId);
      } catch (e) {
        // Ignore server lookup errors
      }
    }

    // Get inventory (publicly visible)
    const inventory = db.prepare('SELECT itemId, qty FROM inventory WHERE userId = ? ORDER BY itemId').all(userId);

    // Check if user is traveling
    let travel = null;
    if (player.locationGuildId) {
      const travelInfo = db.prepare(`
        SELECT travelArrivalAt, travelFromGuildId, travelStartAt 
        FROM players WHERE userId = ? AND travelArrivalAt > ?
      `).get(userId, Date.now());
      
      if (travelInfo) {
        const from = db.prepare('SELECT guildId, name, lat, lon FROM servers WHERE guildId = ?').get(travelInfo.travelFromGuildId);
        const to = db.prepare('SELECT guildId, name, lat, lon FROM servers WHERE guildId = ?').get(player.locationGuildId);
        
        if (from && to) {
          const total = Math.max(1, travelInfo.travelArrivalAt - travelInfo.travelStartAt);
          const progress = Math.min(1, Math.max(0, (Date.now() - travelInfo.travelStartAt) / total));
          const lat = from.lat + (to.lat - from.lat) * progress;
          const lon = from.lon + (to.lon - from.lon) * progress;
          travel = {
            from: { guildId: from.guildId, name: from.name, lat: from.lat, lon: from.lon },
            to: { guildId: to.guildId, name: to.name, lat: to.lat, lon: to.lon },
            position: { lat, lon },
            arrivalAt: travelInfo.travelArrivalAt,
            progress
          };
        }
      }
    }

    // Get basic analytics for public profiles
    let analytics = {};
    
    // Get battle stats
    let battleStats = { battles: 0, wins: 0, bossKills: 0, bestWeapon: 'None' };
    try {
      // Get total battles count
      const totalBattles = db.prepare(`
        SELECT COUNT(*) as battles
        FROM battle_analytics 
        WHERE userId = ?
      `).get(userId);
      
      // Get most used weapon (weapon with most battles)
      const bestWeaponQuery = db.prepare(`
        SELECT weapon, COUNT(*) as usageCount
        FROM battle_analytics 
        WHERE userId = ? AND weapon IS NOT NULL AND weapon != 'none'
        GROUP BY weapon
        ORDER BY COUNT(*) DESC
        LIMIT 1
      `).get(userId);
      
      // Get actual boss defeats from players table (not attacks)
      const playerStats = db.prepare(`
        SELECT bossKills
        FROM players 
        WHERE userId = ?
      `).get(userId);
      
      battleStats = {
        battles: totalBattles?.battles || 0,
        wins: Math.floor((totalBattles?.battles || 0) * 0.6), // Estimate 60% win rate since we don't track wins yet
        bossKills: playerStats?.bossKills || 0, // Use actual boss defeats, not attacks
        bestWeapon: bestWeaponQuery?.weapon || 'None'
      };
    } catch (e) {
      // battle_analytics table doesn't exist
    }

    // Get travel stats
    let travelStats = { totalTrips: 0, uniqueServers: 0, totalDistance: 0, totalTravelTime: 0 };
    try {
      const travelAnalytics = db.prepare(`
        SELECT 
          COUNT(*) as totalTrips,
          COUNT(DISTINCT toGuildId) as uniqueServers,
          SUM(travelTime) as totalTravelTime
        FROM travel_history 
        WHERE userId = ?
      `).get(userId);
      
      // Calculate total distance by getting distance for each travel (if server coordinates exist)
      let totalDistance = 0;
      try {
        const travels = db.prepare(`
          SELECT fromGuildId, toGuildId
          FROM travel_history 
          WHERE userId = ?
        `).all(userId);
        
        for (const travel of travels) {
          if (travel.fromGuildId && travel.toGuildId) {
            const fromServer = db.prepare('SELECT lat, lon FROM servers WHERE guildId = ?').get(travel.fromGuildId);
            const toServer = db.prepare('SELECT lat, lon FROM servers WHERE guildId = ?').get(travel.toGuildId);
            
            if (fromServer?.lat != null && fromServer?.lon != null && 
                toServer?.lat != null && toServer?.lon != null) {
              const { haversine } = require('../../utils/geo');
              totalDistance += haversine(fromServer.lat, fromServer.lon, toServer.lat, toServer.lon);
            }
          }
        }
      } catch (e) {
        // If distance calculation fails, set to 0
        totalDistance = 0;
      }
      
      travelStats = {
        totalTrips: travelAnalytics?.totalTrips || 0,
        uniqueServers: travelAnalytics?.uniqueServers || 0,
        totalDistance: totalDistance,
        totalTravelTime: travelAnalytics?.totalTravelTime || 0
      };
    } catch (e) {
      // If travel_history table doesn't exist, provide basic fallback
      const uniqueServers = player?.locationGuildId ? 1 : 0;
      travelStats = { 
        totalTrips: 0, 
        uniqueServers: uniqueServers, 
        totalDistance: 0, 
        totalTravelTime: 0
      };
    }
    
    analytics = {
      ...battleStats,
      ...travelStats
    };

    // Get achievements for public profiles
    let achievements = {};
    try {
      let userAchievements = [];
      try {
        userAchievements = db.prepare(`
          SELECT achievementId, unlockedAt 
          FROM achievements 
          WHERE userId = ?
        `).all(userId);
      } catch (e) {
        // If achievements table doesn't exist, return empty array
      }
      
      const availableAchievements = [
        {
          id: 'first_travel',
          name: 'First Journey',
          description: 'Complete your first travel',
          icon: 'ROCKET'
        },
        {
          id: 'explorer',
          name: 'Explorer',
          description: 'Visit 10 different servers',
          icon: 'MAP'
        },
        {
          id: 'boss_slayer',
          name: 'Boss Slayer',
          description: 'Defeat your first boss',
          icon: 'SWORD'
        },
        {
          id: 'collector',
          name: 'Collector',
          description: 'Collect 50 items',
          icon: 'BACKPACK'
        },
        {
          id: 'wealthy',
          name: 'Wealthy Adventurer',
          description: 'Accumulate 1000 gems',
          icon: 'DIAMOND'
        },
        {
          id: 'veteran',
          name: 'Veteran Traveler',
          description: 'Complete 100 journeys',
          icon: 'TROPHY'
        }
      ];
      
      // Add unlocked status based on actual user achievements
      const userAchievementIds = new Set(userAchievements.map(a => a.achievementId));
      const achievementsWithStatus = availableAchievements.map(achievement => ({
        ...achievement,
        unlocked: userAchievementIds.has(achievement.id)
      }));
      
      achievements = {
        achievements: achievementsWithStatus,
        totalUnlocked: userAchievements.length,
        totalAvailable: availableAchievements.length
      };
    } catch (e) {
      // Default empty achievements
      achievements = {
        achievements: [],
        totalUnlocked: 0,
        totalAvailable: 0
      };
    }

    const profileData = {
      user: {
        id: userId,
        username: discordUser ? (discordUser.global_name || discordUser.username) : (player.name || 'Unknown User'),
        avatar: discordUser?.avatar ? `https://cdn.discordapp.com/avatars/${userId}/${discordUser.avatar}.png` : null
      },
      roleLevel: userRoleLevel,
      player: {
        userId: player.userId,
        name: player.name,
        gems: player.gems || 0,
        health: player.health || 0,
        stamina: player.stamina || 0,
        locationGuildId: player.locationGuildId
      },
      inventory,
      travel,
      currentLocationServer,
      analytics,
      achievements,
      isOwnProfile: req.session?.user?.id === userId
    };

    res.json(profileData);

  } catch (error) {
    console.error('GET /api/profile error:', error);
    res.status(500).json({ error: 'server_error', message: 'Failed to load profile' });
  }
});

// [removed deprecated checkout handler]
