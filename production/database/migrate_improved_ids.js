const fs = require('fs');
const path = require('path');
const { db } = require('./src/utils/store_sqlite');

function migrateDatabase() {
  console.log('🔄 Starting database migration for improved item IDs...');
  
  // Load improved ID mapping
  const mappingPath = path.join(__dirname, 'id_mapping_improved.json');
  if (!fs.existsSync(mappingPath)) {
    console.error('❌ id_mapping_improved.json not found. Run fix_item_ids_improved.js first.');
    return;
  }
  
  const idMapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
  const mappingCount = Object.keys(idMapping).length;
  console.log(`📋 Loaded ${mappingCount} improved ID mappings`);
  
  let totalUpdated = 0;
  
  try {
    // Begin transaction for data consistency
    db.exec('BEGIN TRANSACTION');
    
    // 1. Update inventory table
    console.log('🎒 Updating inventory table...');
    const inventoryStmt = db.prepare('UPDATE inventory SET itemId = ? WHERE itemId = ?');
    let inventoryUpdated = 0;
    
    for (const [oldId, newId] of Object.entries(idMapping)) {
      const result = inventoryStmt.run(newId, oldId);
      if (result.changes > 0) {
        inventoryUpdated += result.changes;
        console.log(`  ${oldId} → ${newId} (${result.changes} entries)`);
      }
    }
    
    console.log(`✅ Updated ${inventoryUpdated} inventory entries`);
    totalUpdated += inventoryUpdated;
    
    // 2. Update equipment table
    console.log('⚔️ Updating equipment table...');
    const equipmentStmt = db.prepare('UPDATE equipment SET itemId = ? WHERE itemId = ?');
    let equipmentUpdated = 0;
    
    for (const [oldId, newId] of Object.entries(idMapping)) {
      const result = equipmentStmt.run(newId, oldId);
      if (result.changes > 0) {
        equipmentUpdated += result.changes;
        console.log(`  ${oldId} → ${newId} (${result.changes} entries)`);
      }
    }
    
    console.log(`✅ Updated ${equipmentUpdated} equipment entries`);
    totalUpdated += equipmentUpdated;
    
    // 3. Update market_listings table
    console.log('🏪 Updating market listings table...');
    const marketStmt = db.prepare('UPDATE market_listings SET itemId = ? WHERE itemId = ?');
    let marketUpdated = 0;
    
    for (const [oldId, newId] of Object.entries(idMapping)) {
      const result = marketStmt.run(newId, oldId);
      if (result.changes > 0) {
        marketUpdated += result.changes;
        console.log(`  ${oldId} → ${newId} (${result.changes} entries)`);
      }
    }
    
    console.log(`✅ Updated ${marketUpdated} market listing entries`);
    totalUpdated += marketUpdated;
    
    // Check for any remaining numbered IDs
    console.log('🔍 Checking for remaining numbered item IDs...');
    
    const remainingInventory = db.prepare("SELECT COUNT(*) as count FROM inventory WHERE itemId LIKE '%_[0-9]' OR itemId LIKE '%_[0-9][0-9]'").get();
    const remainingEquipment = db.prepare("SELECT COUNT(*) as count FROM equipment WHERE itemId LIKE '%_[0-9]' OR itemId LIKE '%_[0-9][0-9]'").get();
    const remainingMarket = db.prepare("SELECT COUNT(*) as count FROM market_listings WHERE itemId LIKE '%_[0-9]' OR itemId LIKE '%_[0-9][0-9]'").get();
    
    console.log(`📊 Remaining numbered IDs:`);
    console.log(`  Inventory: ${remainingInventory.count}`);
    console.log(`  Equipment: ${remainingEquipment.count}`);
    console.log(`  Market: ${remainingMarket.count}`);
    
    // Commit transaction
    db.exec('COMMIT');
    
    console.log(`🎉 Migration completed successfully!`);
    console.log(`📊 Total database entries updated: ${totalUpdated}`);
    console.log(`📝 Config items updated: ${mappingCount}`);
    console.log(`💾 All changes committed to database`);
    
    // Create backup of mapping file
    const backupPath = path.join(__dirname, `id_mapping_improved_backup_${Date.now()}.json`);
    fs.copyFileSync(mappingPath, backupPath);
    console.log(`🔒 Backup created: ${path.basename(backupPath)}`);
    
  } catch (error) {
    // Rollback on error
    db.exec('ROLLBACK');
    console.error('❌ Migration failed, changes rolled back:', error.message);
    throw error;
  }
}

// Run migration
migrateDatabase();