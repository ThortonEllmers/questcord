const { db } = require('../utils/store_sqlite');
const { placeOnSpiral, findLandPosition } = require('../utils/geo');
const config = require('../utils/config');

// Safe fetch helper for Node: use global fetch if present (Node 18+), else lazy-load node-fetch (ESM)
async function fetchSafe(...args){
  if (typeof globalThis.fetch === 'function') return globalThis.fetch(...args);
  const mod = await import('node-fetch');
  return mod.default(...args);
}

// ---------------- Core helpers ----------------

function getSpawnServer(){
  const id = process.env.SPAWN_GUILD_ID;
  if (!id) return null;
  return db.prepare('SELECT * FROM servers WHERE guildId=?').get(id);
}

function ensurePlayerRow(user){
  if (!user || !user.id) return;
  const row = db.prepare('SELECT userId FROM players WHERE userId=?').get(user.id);
  if (row) return;
  const spawnGuildId = process.env.SPAWN_GUILD_ID || null;
  db.prepare(`INSERT INTO players (userId, name, drakari, locationGuildId, travelArrivalAt, vehicle, health, stamina)
              VALUES (?, ?, 0, ?, NULL, 'plane', 100, 100)`)
    .run(user.id, user.username || 'adventurer', spawnGuildId);
}

// Deterministic biome assignment based on guildId
function assignBiomeDeterministic(guildId){
  try{
    const biomes = (config && config.biomes) ? Object.keys(config.biomes) : [
      'volcanic','ruins','swamp','water','forest','ice','meadow','mountain'
    ];
    if (!guildId || biomes.length === 0) return 'meadow';
    // Simple FNV-1a hash to index biomes
    let h = 2166136261;
    for (let i=0;i<guildId.length;i++){ h ^= guildId.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    const idx = h % biomes.length;
    return biomes[idx];
  }catch(e){
    return 'meadow';
  }
}

// Create a server row with automatic map placement if it doesn't exist
async function createAutoPlacementIfMissing({ guildId, name, ownerId, iconUrl } = {}){
  if (!guildId) return;
  const existing = db.prepare('SELECT guildId FROM servers WHERE guildId=?').get(guildId);
  if (existing) return;

  console.log(`Creating server ${guildId} - searching for land position...`);
  
  const count = db.prepare('SELECT COUNT(*) AS c FROM servers').get().c || 0;
  const spiralPos = placeOnSpiral(count + 1, { lat: 0, lon: 0 });
  
  // Find a land-based position starting from the spiral position
  const pos = await findLandPosition(spiralPos.lat, spiralPos.lon);
  console.log(`Server ${guildId} placed at land position: ${pos.lat}, ${pos.lon}`);
  
  const biome = assignBiomeDeterministic(guildId);
  db.prepare(`INSERT INTO servers (guildId, name, lat, lon, ownerId, addedAt, lastBossAt, iconUrl, discoverable)
              VALUES (?, ?, ?, ?, ?, ?, 0, ?, 1)`)
    .run(guildId, name || 'New Server', pos.lat, pos.lon, ownerId || null, Date.now(), iconUrl || null);
}

// --------------- Roles / Permissions ---------------

async function getMemberRoleIds(userId){
  try{
    const guildId = process.env.ROLE_GUILD_ID || process.env.SPAWN_GUILD_ID;
    if (!guildId) return [];
    const r = await fetchSafe(`https://discord.com/api/guilds/${guildId}/members/${userId}`, {
      headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` }
    });
    if (!r.ok) return [];
    const m = await r.json();
    return Array.isArray(m.roles) ? m.roles : [];
  }catch(e){
    return [];
  }
}

async function fetchRoleLevel(userId){
  try{
    const roles = await getMemberRoleIds(userId);
    const dev = (process.env.DEV_ROLE_IDS||'').split(',').map(s=>s.trim()).filter(Boolean);
    const staff = (process.env.STAFF_ROLE_IDS||'').split(',').map(s=>s.trim()).filter(Boolean);
    const premium = (process.env.PREMIUM_ROLE_IDS||'').split(',').map(s=>s.trim()).filter(Boolean);
    if (roles.some(id=>dev.includes(id))) return 'Developer';
    if (roles.some(id=>staff.includes(id))) return 'Staff';
    if (roles.some(id=>premium.includes(id))) return 'Premium';
    // DB fallback for premium
    const row = db.prepare('SELECT 1 FROM premium_users WHERE userId=?').get(userId);
    return row ? 'Premium' : 'User';
  }catch(e){
    const row = db.prepare('SELECT 1 FROM premium_users WHERE userId=?').get(userId);
    return row ? 'Premium' : 'User';
  }
}

module.exports = {
  getSpawnServer,
  ensurePlayerRow,
  assignBiomeDeterministic,
  createAutoPlacementIfMissing,
  getMemberRoleIds,
  fetchRoleLevel
};
