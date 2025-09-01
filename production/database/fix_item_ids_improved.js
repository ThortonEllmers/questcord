const fs = require('fs');
const path = require('path');

// Function to convert item name to base ID
function nameToBaseId(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '') // Remove special characters
    .replace(/\s+/g, '_')        // Replace spaces with underscores
    .replace(/^_+|_+$/g, '')     // Remove leading/trailing underscores
    .substring(0, 30);           // Reasonable length
}

// Function to create descriptive ID including rarity/category context
function createDescriptiveId(item, usedIds) {
  const baseName = nameToBaseId(item.name);
  
  // Try different combinations in order of preference
  const candidates = [
    baseName, // First try just the name
    `${item.category}_${baseName}`, // Add category
    `${baseName}_${item.rarity}`, // Add rarity
    `${item.rarity}_${baseName}`, // Rarity first
    `${item.category}_${baseName}_${item.rarity}`, // Full descriptive
  ];
  
  // Find first available ID
  for (const candidate of candidates) {
    if (!usedIds.has(candidate)) {
      return candidate;
    }
  }
  
  // If all combinations taken, add counter as last resort
  let counter = 1;
  while (true) {
    const numberedId = `${baseName}_${counter}`;
    if (!usedIds.has(numberedId)) {
      return numberedId;
    }
    counter++;
  }
}

function fixItemIds() {
  console.log('🔧 Starting improved item ID replacement...');
  
  const configPath = path.join(__dirname, 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  
  let replacedCount = 0;
  const usedIds = new Set();
  const idMapping = new Map(); // Track old -> new ID mapping
  
  // First pass: collect existing non-generated IDs to avoid conflicts
  config.items.forEach(item => {
    if (item.id && !item.id.startsWith('generated_item_') && !item.id.includes('_2') && !item.id.includes('_3')) {
      usedIds.add(item.id);
    }
  });
  
  // Second pass: replace problematic IDs
  config.items = config.items.map(item => {
    // Replace generated IDs or numbered IDs
    if (item.id && (item.id.startsWith('generated_item_') || /_\d+$/.test(item.id))) {
      const newId = createDescriptiveId(item, usedIds);
      
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
  
  console.log(`🎉 Successfully replaced ${replacedCount} item IDs!`);
  console.log(`🔧 Updated ${recipeUpdates} crafting recipe references`);
  console.log('📝 Updated config.json saved');
  
  // Save ID mapping for database migration
  const mappingPath = path.join(__dirname, 'id_mapping_improved.json');
  fs.writeFileSync(mappingPath, JSON.stringify(Object.fromEntries(idMapping), null, 2));
  console.log('💾 Improved ID mapping saved for database migration');
}

// Run the fix
fixItemIds();