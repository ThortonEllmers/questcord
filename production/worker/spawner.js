require('dotenv').config();
const { db } = require('../src/utils/store_sqlite');
const config = require('../src/utils/config');
const { log } = require('../src/utils/logger');

function now(){ return Date.now(); }

function tryLock(key, ms){
  try {
    const row = db.prepare('SELECT until FROM locks WHERE key=?').get(key);
    const t = now();
    if (!row || (row.until && row.until < t)){
      const until = t + ms;
      db.prepare('INSERT OR REPLACE INTO locks(key, until) VALUES(?, ?)').run(key, until);
      return true;
    }
    return false;
  } catch(e){
    try { db.prepare('INSERT OR REPLACE INTO locks(key, until) VALUES(?, ?)').run(key, now()+ms); return true; } catch(e2){ return false; }
  }
}

function regenStaminaAll(){
  const t = now();
  const inc = config.stamina?.regenPerMinute ?? 1;
  const rows = db.prepare('SELECT userId, stamina, staminaUpdatedAt FROM players').all();
  for (const r of rows){
    const last = r.staminaUpdatedAt || 0;
    const mins = Math.floor((t - last)/60000);
    if (mins > 0){
      const next = Math.min(100, (r.stamina || 0) + mins*inc);
      db.prepare('UPDATE players SET stamina=?, staminaUpdatedAt=? WHERE userId=?').run(next, t, r.userId);
    }
  }
}

function pickServersWithoutBoss(limit){
  const cd = (config.boss?.cooldownSeconds||0)*1000;
  const t = now();
  const spawnId = process.env.SPAWN_GUILD_ID;
  const rows = db.prepare('SELECT * FROM servers WHERE archived=0 AND lat IS NOT NULL AND lon IS NOT NULL').all();
  return rows.filter(s => {
    if (spawnId && s.guildId === spawnId) return false;
    const active = db.prepare('SELECT 1 FROM bosses WHERE guildId=? AND active=1').get(s.guildId);
    if (active) return false;
    if (s.lastBossAt && t - s.lastBossAt < cd) return false;
    return true;
  }).sort(()=>Math.random()-0.5).slice(0, limit);
}

function spawnBossAt(server){
  const biome = server.biome;
  const map = config.boss?.names || {};
  const list = (biome && map[biome]) || map._default || ['Ancient Beast'];
  const name = list[Math.floor(Math.random()*list.length)];
  const hp = config.boss?.baseHp || 2000;
  const expires = now() + (config.boss?.ttlSeconds||3600)*1000;
  db.prepare('INSERT INTO bosses(guildId, name, maxHp, hp, startedAt, expiresAt, active) VALUES(?,?,?,?,?,?,1)').run(server.guildId, name, hp, hp, now(), expires);
  db.prepare('UPDATE servers SET lastBossAt=? WHERE guildId=?').run(now(), server.guildId);
  log('boss_spawn_auto', { guildId: server.guildId, details: { name } });
}

function cleanupBosses(){
  const t = now();
  db.prepare('UPDATE bosses SET active=0 WHERE active=1 AND expiresAt<?').run(t);
}

function spawnLoop(){
  if (!tryLock('boss-spawn', (config.boss?.spawnTickSeconds||20)*1000 - 1000)) return;
  cleanupBosses();
  const totalServers = db.prepare('SELECT COUNT(*) as n FROM servers WHERE archived=0 AND lat IS NOT NULL AND lon IS NOT NULL').get().n;
  const activeBosses = db.prepare('SELECT COUNT(*) as n FROM bosses WHERE active=1').get().n;
  const target = Math.max(0, Math.floor(totalServers * (config.boss?.targetRatio||0.01)));
  if (activeBosses >= target) return;
  const need = target - activeBosses;
  const candidates = pickServersWithoutBoss(Math.min(need, 5));
  candidates.forEach(spawnBossAt);
}

function cleanupEvents(){
  const t = now();
  db.prepare('UPDATE events SET active=0 WHERE active=1 AND expiresAt<?').run(t);
}

function spawnEvents(){
  if (!tryLock('event-spawn', (config.events?.spawnTickSeconds||30)*1000 - 1000)) return;
  cleanupEvents();
  const totalServers = db.prepare('SELECT COUNT(*) as n FROM servers WHERE archived=0 AND lat IS NOT NULL AND lon IS NOT NULL').get().n;
  const active = db.prepare('SELECT COUNT(*) as n FROM events WHERE active=1').get().n;
  const target = Math.max(0, Math.floor(totalServers * (config.events?.targetRatio||0.02)));
  if (active >= target) return;
  const servers = db.prepare('SELECT * FROM servers WHERE archived=0 AND lat IS NOT NULL AND lon IS NOT NULL AND guildId != ? ORDER BY RANDOM() LIMIT ?').all(process.env.SPAWN_GUILD_ID||'', Math.min(target - active, 10));
  const list = config.events?.types || ['World Event'];
  const ttl = (config.events?.ttlSeconds||1800)*1000;
  const t = now();
  for (const s of servers){
    const type = list[Math.floor(Math.random()*list.length)];
    db.prepare('INSERT INTO events(guildId, type, startedAt, expiresAt, active) VALUES(?,?,?,?,1)').run(s.guildId, type, t, t+ttl);
  }
}

setInterval(spawnLoop, (config.boss?.spawnTickSeconds||20)*1000);
setInterval(spawnEvents, (config.events?.spawnTickSeconds||30)*1000);
setInterval(regenStaminaAll, 60000);
console.log('[worker] Spawner started');
