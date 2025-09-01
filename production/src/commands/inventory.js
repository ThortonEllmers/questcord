const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const config = require('../utils/config');
const { itemById } = require('../utils/items');
const { ensurePlayerWithVehicles } = require('../utils/players');
const { getUserPrefix } = require('../utils/roles');

function metaFor(id) { 
  return itemById(id) || { name: id }; 
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('inventory')
    .setDescription('Show your inventory with sorting options')
    .addStringOption(o => o
      .setName('sort')
      .setDescription('How to sort your inventory')
      .setRequired(false)
      .addChoices(
        { name: 'Name (A-Z)', value: 'name' },
        { name: 'Quantity (High-Low)', value: 'quantity' },
        { name: 'Rarity (Rare-Common)', value: 'rarity' },
        { name: 'Category', value: 'category' },
        { name: 'Equipment Type', value: 'equipslot' }
      ))
    .addStringOption(o => o
      .setName('filter')
      .setDescription('Filter items by type')
      .setRequired(false)
      .addChoices(
        { name: 'All Items', value: 'all' },
        { name: 'Equipment Only', value: 'equipment' },
        { name: 'Weapons', value: 'weapon' },
        { name: 'Armor', value: 'armor' },
        { name: 'Materials', value: 'material' },
        { name: 'Consumables', value: 'consumable' },
        { name: 'Vehicles', value: 'vehicle' },
        { name: 'Artifacts', value: 'artifact' }
      )),
  async execute(interaction) {
    const { db } = require('../utils/store_sqlite'); // lazy require for deploy safety
    const userId = interaction.user.id;
    const sortBy = interaction.options.getString('sort') || 'name';
    const filterBy = interaction.options.getString('filter') || 'all';

    // Ensure player exists with proper vehicle setup
    await ensurePlayerWithVehicles(interaction.client, userId, interaction.user.username);

    // Optional: passive regen tick on read
    try { 
      const { applyRegenForUser } = require('../utils/regen'); 
      applyRegenForUser(userId); 
    } catch {
      // Silently ignore regen errors
    }

    const rows = db.prepare('SELECT itemId, qty FROM inventory WHERE userId=? AND qty>0').all(userId);
    const userPrefix = await getUserPrefix(interaction.client, interaction.user);

    if (rows.length === 0) {
      const emptyEmbed = new EmbedBuilder()
        .setTitle('🎒📦 **EMPTY INVENTORY** 📦🎒')
        .setDescription('✨ *Your adventure chest awaits its first treasures* ✨')
        .setColor(0x95A5A6)
        .setAuthor({ 
          name: `${userPrefix} - Inventory Manager`,
          iconURL: interaction.user.displayAvatarURL() 
        })
        .addFields(
          {
            name: '🏪 **Get Started**',
            value: '• **Market**: Buy items from other players\
• **Crafting**: Create equipment from materials\
• **Boss Battles**: Earn rare loot drops\
• **Exploration**: Find treasures while traveling',
            inline: false
          },
          {
            name: '🎯 **Quick Actions**',
            value: '• `/market search` - Browse available items\
• `/craft` - Create items from materials\
• `/boss` - Fight for legendary rewards\
• `/travel` - Explore new servers for loot',
            inline: false
          }
        )
        .setFooter({ 
          text: `🎒 Start your collection today • QuestCord Inventory`,
          iconURL: interaction.client.user.displayAvatarURL()
        });

      return interaction.reply({ embeds: [emptyEmbed], ephemeral: true });
    }

    // Add item metadata to each row
    const itemsWithMeta = rows.map(r => {
      const meta = metaFor(r.itemId);
      return {
        ...r,
        meta: meta,
        name: meta?.name || r.itemId,
        rarity: meta?.rarity || 'common',
        category: meta?.category || 'unknown',
        equipSlot: meta?.equipSlot || null
      };
    });

    // Apply filters
    let filteredItems = itemsWithMeta;
    if (filterBy !== 'all') {
      switch (filterBy) {
        case 'equipment':
          filteredItems = itemsWithMeta.filter(item => item.category === 'equipment');
          break;
        case 'weapon':
          filteredItems = itemsWithMeta.filter(item => item.equipSlot === 'weapon');
          break;
        case 'armor':
          filteredItems = itemsWithMeta.filter(item => item.equipSlot === 'armor');
          break;
        case 'material':
        case 'consumable':
        case 'vehicle':
        case 'artifact':
          filteredItems = itemsWithMeta.filter(item => item.category === filterBy);
          break;
      }
    }

    // Apply sorting
    const rarityOrder = { 'transcendent': 7, 'mythic': 6, 'legendary': 5, 'epic': 4, 'rare': 3, 'uncommon': 2, 'common': 1 };
    switch (sortBy) {
      case 'quantity':
        filteredItems.sort((a, b) => b.qty - a.qty);
        break;
      case 'rarity':
        filteredItems.sort((a, b) => (rarityOrder[b.rarity] || 0) - (rarityOrder[a.rarity] || 0));
        break;
      case 'category':
        filteredItems.sort((a, b) => a.category.localeCompare(b.category));
        break;
      case 'equipslot':
        filteredItems.sort((a, b) => (a.equipSlot || 'z').localeCompare(b.equipSlot || 'z'));
        break;
      case 'name':
      default:
        filteredItems.sort((a, b) => a.name.localeCompare(b.name));
        break;
    }

    // Generate rarity emojis and colors
    const rarityEmojis = {
      'transcendent': '🌟',
      'mythic': '🔮',
      'legendary': '👑',
      'epic': '💜',
      'rare': '💙',
      'uncommon': '💚',
      'common': '⚪'
    };

    const categoryEmojis = {
      'equipment': '⚔️',
      'material': '🧱',
      'consumable': '🧪',
      'vehicle': '🚗',
      'artifact': '🏺',
      'unknown': '❓'
    };

    // Build inventory display
    const inventoryEmbed = new EmbedBuilder()
      .setTitle('🎒⭐ **INVENTORY COLLECTION** ⭐🎒')
      .setDescription(`🎯 *${filteredItems.length} items found* • Sorted by ${sortBy} ${filterBy !== 'all' ? `• Filtered: ${filterBy}` : ''}`)
      .setColor(0x3498DB)
      .setAuthor({ 
        name: `${userPrefix} - Item Collector`,
        iconURL: interaction.user.displayAvatarURL() 
      });

    // Group items by category for better organization
    const itemsByCategory = {};
    filteredItems.forEach(item => {
      const cat = item.category || 'unknown';
      if (!itemsByCategory[cat]) itemsByCategory[cat] = [];
      itemsByCategory[cat].push(item);
    });

    // Add inventory summary
    const totalValue = filteredItems.reduce((sum, item) => sum + item.qty, 0);
    const uniqueCategories = Object.keys(itemsByCategory).length;
    
    inventoryEmbed.addFields({
      name: '📊 **Inventory Summary**',
      value: `🎒 **${filteredItems.length}** item types\
📦 **${totalValue}** total quantity\
🏷️ **${uniqueCategories}** categories\
${filterBy !== 'all' ? `🔍 Filter: **${filterBy}**` : ''}`,
      inline: false
    });

    // Display items by category (up to 6 categories to fit embed limits)
    Object.entries(itemsByCategory).slice(0, 6).forEach(([category, items]) => {
      const emoji = categoryEmojis[category] || '📦';
      const itemList = items.slice(0, 8).map(item => {
        const rarityEmoji = rarityEmojis[item.rarity] || '⚪';
        const equipInfo = item.equipSlot ? ` (${item.equipSlot})` : '';
        return `${rarityEmoji} **${item.name}**${equipInfo} × ${item.qty}`;
      }).join('\
');

      const moreItems = items.length > 8 ? `\
... and ${items.length - 8} more` : '';

      inventoryEmbed.addFields({
        name: `${emoji} **${category.toUpperCase()}** (${items.length})`,
        value: itemList + moreItems,
        inline: true
      });
    });

    // Add sorting/filtering help
    inventoryEmbed.addFields({
      name: '🔧 **Inventory Tools**',
      value: '• **Sort by**: Name, Quantity, Rarity, Category, Equipment Type\
• **Filter by**: Equipment, Weapons, Armor, Materials, etc.\
• **Quick Access**: `/equip`, `/useitem`, `/craft`',
      inline: false
    });

    inventoryEmbed.setFooter({ 
      text: `🎒 Use sorting and filtering options for better organization • QuestCord Inventory`,
      iconURL: interaction.client.user.displayAvatarURL()
    });

    await interaction.reply({ embeds: [inventoryEmbed], ephemeral: true });
  }
};
