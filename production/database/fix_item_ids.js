const fs = require('fs');
const path = require('path');

// Function to convert item name to proper ID
function nameToId(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '') // Remove special characters
    .replace(/\s+/g, '_')        // Replace spaces with underscores
    .replace(/^_+|_+$/g, '')     // Remove leading/trailing underscores
    .substring(0, 50);           // Limit length
}

// Function to ensure unique IDs
function ensureUniqueId(baseId, usedIds, counter = 1) {
  const id = counter === 1 ? baseId : `${baseId}_${counter}`;
  if (usedIds.has(id)) {
    return ensureUniqueId(baseId, usedIds, counter + 1);
  }
  return id;
}

function fixItemIds() {
  console.log('🔧 Starting item ID replacement...');
  
  const configPath = path.join(__dirname, 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  
  let replacedCount = 0;
  const usedIds = new Set();
  const idMapping = new Map(); // Track old -> new ID mapping
  
  // First pass: collect existing non-generated IDs to avoid conflicts
  config.items.forEach(item => {
    if (item.id && !item.id.startsWith('generated_item_')) {
      usedIds.add(item.id);
    }
  });
  
  // Second pass: replace generated IDs
  config.items = config.items.map(item => {
    if (item.id && item.id.startsWith('generated_item_')) {
      const baseId = nameToId(item.name);
      const newId = ensureUniqueId(baseId, usedIds);
      
      usedIds.add(newId);
      idMapping.set(item.id, newId);
      
      const updatedItem = {
        ...item,
        id: newId
      };
      
      replacedCount++;
      if (replacedCount % 50 === 0) {
        console.log(`✅ Replaced ${replacedCount} IDs...`);
      }
      
      console.log(`  ${item.id} → ${newId} (${item.name})`);
      return updatedItem;
    }
    
    return item;
  });
  
  // Third pass: update any crafting recipes that reference old IDs
  let recipeUpdates = 0;
  config.items.forEach(item => {
    if (item.crafting && item.crafting.components) {
      item.crafting.components.forEach(component => {
        if (idMapping.has(component.itemId)) {
          console.log(`    Recipe fix: ${component.itemId} → ${idMapping.get(component.itemId)}`);
          component.itemId = idMapping.get(component.itemId);
          recipeUpdates++;
        }
      });
    }
  });
  
  // Save the updated config
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  
  console.log(`🎉 Successfully replaced ${replacedCount} generated item IDs!`);
  console.log(`🔧 Updated ${recipeUpdates} crafting recipe references`);
  console.log('📝 Updated config.json saved');
  
  // Save ID mapping for database migration
  const mappingPath = path.join(__dirname, 'id_mapping.json');
  fs.writeFileSync(mappingPath, JSON.stringify(Object.fromEntries(idMapping), null, 2));
  console.log('💾 ID mapping saved for database migration');
}

// Run the fix
fixItemIds();