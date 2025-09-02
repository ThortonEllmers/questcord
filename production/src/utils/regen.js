const { db } = require('./store_sqlite');
const { recordTravel } = require('./travel_history');
let config = {};
try { config = require('../../config.json'); } catch { config = {}; }

const regenConfig = config.regen || {};
const MAX_H = regenConfig.maxHealth || 100;
const MAX_S = regenConfig.maxStamina || 100;
const BASE_HPM = regenConfig.baseHealthPerMinute || 2;
const BASE_SPM = regenConfig.baseStaminaPerMinute || 3;

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// Idempotent column adds
function ensureColumns() {
  try {
    const cols = db.prepare("PRAGMA table_info(players)").all().map(c => c.name);
    if (!cols.includes('healthUpdatedAt')) {
      db.prepare("ALTER TABLE players ADD COLUMN healthUpdatedAt INTEGER").run();
      db.prepare("UPDATE players SET healthUpdatedAt = strftime('%s','now')*1000 WHERE healthUpdatedAt IS NULL").run();
    }
    if (!cols.includes('staminaUpdatedAt')) {
      db.prepare("ALTER TABLE players ADD COLUMN staminaUpdatedAt INTEGER").run();
      db.prepare("UPDATE players SET staminaUpdatedAt = strftime('%s','now')*1000 WHERE staminaUpdatedAt IS NULL").run();
    }
    if (!cols.includes('isPremium')) {
      db.prepare("ALTER TABLE players ADD COLUMN isPremium INTEGER DEFAULT 0").run();
      db.prepare("UPDATE players SET isPremium = COALESCE(isPremium, 0)").run();
    }
    if (!cols.includes('lastCombatAt')) {
      db.prepare("ALTER TABLE players ADD COLUMN lastCombatAt INTEGER DEFAULT 0").run();
    }
    if (!cols.includes('regenEffects')) {
      db.prepare("ALTER TABLE players ADD COLUMN regenEffects TEXT DEFAULT '{}'").run();
    }
    if (!cols.includes('currentBiome')) {
      db.prepare("ALTER TABLE players ADD COLUMN currentBiome TEXT DEFAULT 'city'").run();
    }
  } catch (e) {
    // ignore; first boot might not have tables yet
  }
}
ensureColumns();

function getLocationMultiplier(biome) {
  const locationBonuses = regenConfig.locationBonuses || {};
  const bonus = locationBonuses[biome] || locationBonuses['city'] || {};
  return {
    health: bonus.healthMultiplier || 1.0,
    stamina: bonus.staminaMultiplier || 1.0
  };
}

function getActivityPenalty(userId, now) {
  const player = db.prepare(`SELECT travelArrivalAt, lastCombatAt FROM players WHERE userId=?`).get(userId);
  if (!player) return { health: 1.0, stamina: 1.0 };

  let healthMult = 1.0;
  let staminaMult = 1.0;

  const penalties = regenConfig.activityPenalties || {};
  
  // Check for recent travel
  if (player.travelArrivalAt && (now - player.travelArrivalAt) < (penalties.recently_traveled?.duration || 300000)) {
    const travelPenalty = penalties.recently_traveled || {};
    healthMult *= (travelPenalty.healthMultiplier || 0.7);
    staminaMult *= (travelPenalty.staminaMultiplier || 0.3);
  }

  // Check for recent combat
  if (player.lastCombatAt && (now - player.lastCombatAt) < (penalties.in_combat?.duration || 600000)) {
    const combatPenalty = penalties.in_combat || {};
    healthMult *= (combatPenalty.healthMultiplier || 0.2);
    staminaMult *= (combatPenalty.staminaMultiplier || 0.1);
  }

  return { health: healthMult, stamina: staminaMult };
}

function getActiveItemEffects(userId, now) {
  const player = db.prepare(`SELECT regenEffects FROM players WHERE userId=?`).get(userId);
  if (!player || !player.regenEffects) return { health: 1.0, stamina: 1.0 };

  let effects;
  try {
    effects = JSON.parse(player.regenEffects);
  } catch {
    return { health: 1.0, stamina: 1.0 };
  }

  let healthMult = 1.0;
  let staminaMult = 1.0;
  const itemBonuses = regenConfig.itemBonuses || {};
  let effectsChanged = false;

  for (const [effectName, effectData] of Object.entries(effects)) {
    if (effectData.expiresAt > now) {
      const bonus = itemBonuses[effectName];
      if (bonus) {
        healthMult *= (bonus.healthMultiplier || 1.0);
        staminaMult *= (bonus.staminaMultiplier || 1.0);
      }
    } else {
      delete effects[effectName];
      effectsChanged = true;
    }
  }

  if (effectsChanged) {
    db.prepare(`UPDATE players SET regenEffects=? WHERE userId=?`)
      .run(JSON.stringify(effects), userId);
  }

  return { health: healthMult, stamina: staminaMult };
}

function getPremiumBonuses(isPremium) {
  if (!isPremium) return { health: 1.0, stamina: 1.0, maxHealthBonus: 0, maxStaminaBonus: 0 };
  
  const premiumBonuses = regenConfig.premiumBonuses || {};
  return {
    health: premiumBonuses.healthMultiplier || 1.5,
    stamina: premiumBonuses.staminaMultiplier || 1.3,
    maxHealthBonus: premiumBonuses.maxHealthBonus || 50,
    maxStaminaBonus: premiumBonuses.maxStaminaBonus || 30
  };
}

function applyItemEffect(userId, itemId, duration = null) {
  const itemBonuses = regenConfig.itemBonuses || {};
  const bonus = itemBonuses[itemId];
  if (!bonus) return false;

  const effectDuration = duration || bonus.duration || 900000; // Default 15 minutes
  const expiresAt = Date.now() + effectDuration;

  const player = db.prepare(`SELECT regenEffects FROM players WHERE userId=?`).get(userId);
  let effects = {};
  
  if (player && player.regenEffects) {
    try {
      effects = JSON.parse(player.regenEffects);
    } catch {}
  }

  effects[itemId] = { expiresAt };
  
  db.prepare(`UPDATE players SET regenEffects=? WHERE userId=?`)
    .run(JSON.stringify(effects), userId);
  
  return true;
}

function updateCombatStatus(userId) {
  const now = Date.now();
  db.prepare(`UPDATE players SET lastCombatAt=? WHERE userId=?`).run(now, userId);
}

function updateBiome(userId, biome) {
  db.prepare(`UPDATE players SET currentBiome=? WHERE userId=?`).run(biome, userId);
}

function applyRegenForUser(userId) {
  try {
    const now = Date.now();
    const row = db.prepare(`
      SELECT health, stamina, healthUpdatedAt, staminaUpdatedAt, 
             isPremium, currentBiome, travelArrivalAt, lastCombatAt, regenEffects 
      FROM players WHERE userId=?
    `).get(userId);
    
    if (!row) return;
    
    let { health, stamina, healthUpdatedAt, staminaUpdatedAt, isPremium, currentBiome } = row;

    // Calculate maximum values with premium bonuses
    const premiumBonuses = getPremiumBonuses(isPremium);
    const maxH = MAX_H + premiumBonuses.maxHealthBonus;
    const maxS = MAX_S + premiumBonuses.maxStaminaBonus;

    // Calculate elapsed time in minutes
    const hElapsedMin = Math.max(0, Math.floor((now - (healthUpdatedAt || 0)) / 60000));
    const sElapsedMin = Math.max(0, Math.floor((now - (staminaUpdatedAt || 0)) / 60000));

    if (hElapsedMin > 0 || sElapsedMin > 0) {
      // Get all multipliers
      const locationMult = getLocationMultiplier(currentBiome || 'city');
      const activityPenalty = getActivityPenalty(userId, now);
      const itemEffects = getActiveItemEffects(userId, now);

      // Calculate health regeneration
      if (hElapsedMin > 0 && health < maxH) {
        const totalHealthMult = locationMult.health * 
                               activityPenalty.health * 
                               itemEffects.health * 
                               premiumBonuses.health;
        
        const healthRegen = hElapsedMin * BASE_HPM * totalHealthMult;
        health = clamp(health + healthRegen, 0, maxH);
        healthUpdatedAt = now;
      }

      // Calculate stamina regeneration  
      if (sElapsedMin > 0 && stamina < maxS) {
        const totalStaminaMult = locationMult.stamina * 
                                activityPenalty.stamina * 
                                itemEffects.stamina * 
                                premiumBonuses.stamina;
        
        const staminaRegen = sElapsedMin * BASE_SPM * totalStaminaMult;
        stamina = clamp(stamina + staminaRegen, 0, maxS);
        staminaUpdatedAt = now;
      }

      // Update database
      if (health !== row.health || stamina !== row.stamina) {
        db.prepare(`
          UPDATE players SET health=?, stamina=?, healthUpdatedAt=?, staminaUpdatedAt=? 
          WHERE userId=?
        `).run(health, stamina, healthUpdatedAt, staminaUpdatedAt, userId);
      }
    }
  } catch (e) {
    console.error('Regen error for user:', userId, e);
  }
}

function applyRegenToAll() {
  try {
    const now = Date.now();
    
    // First, complete any finished travels and record history
    const completedTravels = db.prepare(`
      SELECT userId, travelFromGuildId, locationGuildId, travelStartAt, travelArrivalAt
      FROM players 
      WHERE travelArrivalAt > 0 AND travelArrivalAt <= ?
    `).all(now);
    
    // Record travel history for completed travels
    for (const travel of completedTravels) {
      const travelTime = travel.travelArrivalAt - travel.travelStartAt;
      recordTravel(travel.userId, travel.travelFromGuildId, travel.locationGuildId, travelTime);
      
      // Handle landmark arrivals
      if (travel.locationGuildId && travel.locationGuildId.startsWith('landmark_')) {
        const landmarkId = travel.locationGuildId.replace('landmark_', '');
        
        try {
          // Get POI info
          const poi = db.prepare('SELECT * FROM pois WHERE id = ?').get(landmarkId);
          if (poi) {
            // Check if already visited
            const alreadyVisited = db.prepare('SELECT 1 FROM poi_visits WHERE userId = ? AND poiId = ?').get(travel.userId, landmarkId);
            
            if (!alreadyVisited) {
              // Record first visit
              db.prepare('INSERT INTO poi_visits (userId, poiId, visitedAt, isFirstVisit) VALUES (?, ?, ?, 1)').run(
                travel.userId, landmarkId, now
              );
            }
          }
        } catch (error) {
          console.error('Error processing landmark arrival:', error);
        }
        
        // Set player location back to their origin server (landmarks aren't real locations)
        db.prepare('UPDATE players SET locationGuildId = ? WHERE userId = ?').run(travel.travelFromGuildId, travel.userId);
      }
    }
    
    // Clear completed travels
    db.prepare(`
      UPDATE players 
      SET travelArrivalAt = 0 
      WHERE travelArrivalAt > 0 AND travelArrivalAt <= ?
    `).run(now);
    
    const rows = db.prepare(`
      SELECT userId, health, stamina, healthUpdatedAt, staminaUpdatedAt, 
             isPremium, currentBiome, travelArrivalAt, lastCombatAt, regenEffects 
      FROM players
    `).all();
    
    const upd = db.prepare(`
      UPDATE players SET health=?, stamina=?, healthUpdatedAt=?, staminaUpdatedAt=?, regenEffects=? 
      WHERE userId=?
    `);
    
    const tx = db.transaction((list) => {
      for (const r of list) {
        const premiumBonuses = getPremiumBonuses(r.isPremium);
        const maxH = MAX_H + premiumBonuses.maxHealthBonus;
        const maxS = MAX_S + premiumBonuses.maxStaminaBonus;

        let h = r.health, s = r.stamina;
        let hu = r.healthUpdatedAt || 0;
        let su = r.staminaUpdatedAt || 0;
        let regenEffects = r.regenEffects;

        const hMin = Math.max(0, Math.floor((now - hu) / 60000));
        const sMin = Math.max(0, Math.floor((now - su) / 60000));

        if (hMin > 0 || sMin > 0) {
          // Get all multipliers (simplified for batch processing)
          const locationMult = getLocationMultiplier(r.currentBiome || 'city');
          
          // Simplified activity penalty calculation
          let activityHealthMult = 1.0;
          let activityStaminaMult = 1.0;
          
          if (r.travelArrivalAt && (now - r.travelArrivalAt) < 300000) {
            activityHealthMult *= 0.7;
            activityStaminaMult *= 0.3;
          }
          
          if (r.lastCombatAt && (now - r.lastCombatAt) < 600000) {
            activityHealthMult *= 0.2;
            activityStaminaMult *= 0.1;
          }

          // Process item effects
          let itemHealthMult = 1.0;
          let itemStaminaMult = 1.0;
          let effects = {};
          
          if (regenEffects) {
            try {
              effects = JSON.parse(regenEffects);
              const itemBonuses = regenConfig.itemBonuses || {};
              
              for (const [effectName, effectData] of Object.entries(effects)) {
                if (effectData.expiresAt > now) {
                  const bonus = itemBonuses[effectName];
                  if (bonus) {
                    itemHealthMult *= (bonus.healthMultiplier || 1.0);
                    itemStaminaMult *= (bonus.staminaMultiplier || 1.0);
                  }
                } else {
                  delete effects[effectName];
                }
              }
              
              regenEffects = JSON.stringify(effects);
            } catch {
              regenEffects = '{}';
            }
          } else {
            regenEffects = '{}';
          }

          // Apply regeneration
          if (hMin > 0 && h < maxH) {
            const totalHealthMult = locationMult.health * 
                                   activityHealthMult * 
                                   itemHealthMult * 
                                   premiumBonuses.health;
            h = clamp(h + hMin * BASE_HPM * totalHealthMult, 0, maxH);
            hu = now;
          }

          if (sMin > 0 && s < maxS) {
            const totalStaminaMult = locationMult.stamina * 
                                    activityStaminaMult * 
                                    itemStaminaMult * 
                                    premiumBonuses.stamina;
            s = clamp(s + sMin * BASE_SPM * totalStaminaMult, 0, maxS);
            su = now;
          }
        }

        if (h !== r.health || s !== r.stamina || regenEffects !== r.regenEffects) {
          upd.run(h, s, hu, su, regenEffects, r.userId);
        }
      }
    });
    
    tx(rows);
  } catch (e) {
    console.error('Batch regen error:', e);
  }
}

function getRegenStatus(userId) {
  const row = db.prepare(`
    SELECT health, stamina, isPremium, currentBiome, 
           travelArrivalAt, lastCombatAt, regenEffects 
    FROM players WHERE userId=?
  `).get(userId);
  
  if (!row) return null;

  const now = Date.now();
  const premiumBonuses = getPremiumBonuses(row.isPremium);
  const maxH = MAX_H + premiumBonuses.maxHealthBonus;
  const maxS = MAX_S + premiumBonuses.maxStaminaBonus;
  
  const locationMult = getLocationMultiplier(row.currentBiome || 'city');
  const activityPenalty = getActivityPenalty(userId, now);
  const itemEffects = getActiveItemEffects(userId, now);

  const effectiveHealthRegen = BASE_HPM * 
                              locationMult.health * 
                              activityPenalty.health * 
                              itemEffects.health * 
                              premiumBonuses.health;
  
  const effectiveStaminaRegen = BASE_SPM * 
                               locationMult.stamina * 
                               activityPenalty.stamina * 
                               itemEffects.stamina * 
                               premiumBonuses.stamina;

  return {
    health: row.health,
    maxHealth: maxH,
    stamina: row.stamina,
    maxStamina: maxS,
    healthRegenPerMinute: effectiveHealthRegen,
    staminaRegenPerMinute: effectiveStaminaRegen,
    currentBiome: row.currentBiome,
    isPremium: row.isPremium,
    activeEffects: row.regenEffects ? JSON.parse(row.regenEffects) : {}
  };
}

module.exports = { 
  applyRegenForUser, 
  applyRegenToAll, 
  applyItemEffect, 
  updateCombatStatus, 
  updateBiome, 
  getRegenStatus,
  MAX_H, 
  MAX_S 
};