const { db } = require('./store_sqlite');
const { isPremium } = require('./roles');

/**
 * Ensure player exists and has proper vehicle inventory setup
 */
async function ensurePlayerWithVehicles(client, userId, username, guildId = null) {
  // Check if player exists
  let player = db.prepare('SELECT * FROM players WHERE userId=?').get(userId);
  
  if (!player) {
    // Create new player with default plane
    db.prepare(`
      INSERT INTO players(userId, name, locationGuildId, vehicle, health, stamina, drakari, travelArrivalAt) 
      VALUES(?, ?, ?, 'plane', 100, 100, 0, 0)
    `).run(userId, username, guildId);
    
    // Add commercial plane to inventory
    db.prepare(`
      INSERT INTO inventory(userId, itemId, qty) VALUES(?, 'plane', 1)
    `).run(userId);
    
    // Equip commercial plane by default
    db.prepare(`
      INSERT INTO equipment(userId, slot, itemId) VALUES(?, 'vehicle', 'plane')
    `).run(userId);
    
    player = db.prepare('SELECT * FROM players WHERE userId=?').get(userId);
  }
  
  // Ensure player has commercial plane in inventory
  const hasPlane = db.prepare('SELECT qty FROM inventory WHERE userId=? AND itemId=?').get(userId, 'plane');
  if (!hasPlane) {
    db.prepare(`
      INSERT INTO inventory(userId, itemId, qty) VALUES(?, 'plane', 1)
    `).run(userId);
  }
  
  // Handle premium jet based on current status
  await updatePremiumVehicles(client, userId);
  
  return player;
}

/**
 * Update user's premium vehicles based on their current premium status
 */
async function updatePremiumVehicles(client, userId) {
  const userIsPremium = await isPremium(client, userId);
  const hasPrivateJet = db.prepare('SELECT qty FROM inventory WHERE userId=? AND itemId=?').get(userId, 'private_jet');
  
  if (userIsPremium && !hasPrivateJet) {
    // Add private jet for premium users
    db.prepare(`
      INSERT INTO inventory(userId, itemId, qty) VALUES(?, 'private_jet', 1)
    `).run(userId);
  } else if (!userIsPremium && hasPrivateJet) {
    // Remove private jet from non-premium users
    db.prepare('DELETE FROM inventory WHERE userId=? AND itemId=?').run(userId, 'private_jet');
    
    // If they had private jet equipped, switch to commercial plane
    const equippedVehicle = db.prepare('SELECT itemId FROM equipment WHERE userId=? AND slot=?').get(userId, 'vehicle');
    if (equippedVehicle && equippedVehicle.itemId === 'private_jet') {
      db.prepare('UPDATE equipment SET itemId=? WHERE userId=? AND slot=?').run('plane', userId, 'vehicle');
      db.prepare('UPDATE players SET vehicle=? WHERE userId=?').run('plane', userId);
    }
  }
}

/**
 * Ensure default plane is equipped if no vehicle is equipped
 */
function ensureDefaultVehicle(userId) {
  const equippedVehicle = db.prepare('SELECT itemId FROM equipment WHERE userId=? AND slot=?').get(userId, 'vehicle');
  
  if (!equippedVehicle) {
    // Equip commercial plane by default
    db.prepare(`
      INSERT OR REPLACE INTO equipment(userId, slot, itemId) VALUES(?, 'vehicle', 'plane')
    `).run(userId);
    
    db.prepare('UPDATE players SET vehicle=? WHERE userId=?').run('plane', userId);
  }
}

module.exports = {
  ensurePlayerWithVehicles,
  updatePremiumVehicles,
  ensureDefaultVehicle
};