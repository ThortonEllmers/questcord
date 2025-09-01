const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { db } = require('../utils/store_sqlite');
const config = require('../utils/config');
const { getUserPrefix, isPremium } = require('../utils/roles');
const { isBanned, regenStamina } = require('./_guard');
const logger = require('../utils/logger');
const { itemById } = require('../utils/items');

// Crafting tiers and requirements
const CRAFTING_TIERS = {
  1: { name: 'Apprentice', requirement: 0, maxRarity: 'common' },
  2: { name: 'Journeyman', requirement: 25, maxRarity: 'uncommon' },
  3: { name: 'Expert', requirement: 100, maxRarity: 'rare' },
  4: { name: 'Artisan', requirement: 250, maxRarity: 'epic' },
  5: { name: 'Master', requirement: 500, maxRarity: 'legendary' },
  6: { name: 'Grandmaster', requirement: 750, maxRarity: 'mythic' },
  7: { name: 'Transcendent', requirement: 1000, maxRarity: 'transcendent' }
};

function getCraftingLevel(itemsCrafted) {
  let level = 1;
  for (const [tier, data] of Object.entries(CRAFTING_TIERS)) {
    if (itemsCrafted >= data.requirement) {
      level = parseInt(tier);
    }
  }
  return level;
}

function canCraftRarity(itemsCrafted, rarity) {
  const level = getCraftingLevel(itemsCrafted);
  const tierData = CRAFTING_TIERS[level];
  
  const rarityOrder = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'transcendent'];
  const currentMaxIndex = rarityOrder.indexOf(tierData.maxRarity);
  const requestedIndex = rarityOrder.indexOf(rarity);
  
  return requestedIndex <= currentMaxIndex;
}

function getCraftingTime(rarity, isPremiumUser) {
  const baseTimes = {
    'common': 60,      // 1 minute
    'uncommon': 300,   // 5 minutes
    'rare': 900,       // 15 minutes
    'epic': 1800,      // 30 minutes
    'legendary': 3600, // 1 hour
    'mythic': 7200,    // 2 hours
    'transcendent': 43200 // 12 hours
  };
  
  const baseTime = baseTimes[rarity] || 60;
  return isPremiumUser ? Math.floor(baseTime * 0.75) : baseTime; // 25% faster for premium
}

function hasRequiredItems(userId, recipe) {
  for (const ingredient of recipe) {
    const inv = db.prepare('SELECT qty FROM inventory WHERE userId=? AND itemId=?').get(userId, ingredient.id);
    if (!inv || inv.qty < ingredient.qty) {
      return false;
    }
  }
  return true;
}

function consumeIngredients(userId, recipe) {
  for (const ingredient of recipe) {
    const currentQty = db.prepare('SELECT qty FROM inventory WHERE userId=? AND itemId=?').get(userId, ingredient.id)?.qty || 0;
    const newQty = currentQty - ingredient.qty;
    
    if (newQty <= 0) {
      db.prepare('DELETE FROM inventory WHERE userId=? AND itemId=?').run(userId, ingredient.id);
    } else {
      db.prepare('UPDATE inventory SET qty=? WHERE userId=? AND itemId=?').run(newQty, userId, ingredient.id);
    }
  }
}

function addItemToInventory(userId, itemId, qty = 1) {
  const existing = db.prepare('SELECT qty FROM inventory WHERE userId=? AND itemId=?').get(userId, itemId);
  if (existing) {
    db.prepare('UPDATE inventory SET qty=qty+? WHERE userId=? AND itemId=?').run(qty, userId, itemId);
  } else {
    db.prepare('INSERT INTO inventory(userId, itemId, qty) VALUES(?,?,?)').run(userId, itemId, qty);
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('craft')
    .setDescription('Craft items using materials')
    .addSubcommand(sc => sc.setName('item').setDescription('Craft a specific item')
      .addStringOption(o => o.setName('item').setDescription('Item to craft').setRequired(true).setAutocomplete(true))
      .addIntegerOption(o => o.setName('quantity').setDescription('Quantity to craft (default: 1)').setMinValue(1).setMaxValue(10)))
    .addSubcommand(sc => sc.setName('status').setDescription('Check your crafting status and active crafts'))
    .addSubcommand(sc => sc.setName('recipes').setDescription('Browse available recipes')
      .addStringOption(o => o.setName('rarity').setDescription('Filter by rarity').setChoices(
        { name: 'Common', value: 'common' },
        { name: 'Uncommon', value: 'uncommon' },
        { name: 'Rare', value: 'rare' },
        { name: 'Epic', value: 'epic' },
        { name: 'Legendary', value: 'legendary' },
        { name: 'Mythic', value: 'mythic' },
        { name: 'Transcendent', value: 'transcendent' }
      )))
    .addSubcommand(sc => sc.setName('complete').setDescription('Complete a finished craft'))
    .addSubcommand(sc => sc.setName('cancel').setDescription('Cancel an active craft')
      .addIntegerOption(o => o.setName('craft_id').setDescription('Craft ID to cancel').setRequired(true))),

  async autocomplete(interaction) {
    if (interaction.options.getSubcommand() !== 'item') return;
    
    const focusedValue = interaction.options.getFocused().toLowerCase();
    const userId = interaction.user.id;
    
    // Get user's crafting progress
    const userData = db.prepare('SELECT itemsCrafted FROM players WHERE userId=?').get(userId);
    const itemsCrafted = userData?.itemsCrafted || 0;
    
    // Filter craftable items based on level and search
    const craftableItems = (config.items || []).filter(item => {
      if (!item.craftable || !item.recipe) return false;
      if (!canCraftRarity(itemsCrafted, item.rarity)) return false;
      if (item.premiumNeeded && !isPremium(interaction.client, userId)) return false;
      return item.name.toLowerCase().includes(focusedValue) || item.id.includes(focusedValue);
    }).slice(0, 25);

    await interaction.respond(
      craftableItems.map(item => ({
        name: `${item.name} (${item.rarity})`,
        value: item.id
      }))
    );
  },

  async execute(interaction) {
    const userPrefix = await getUserPrefix(interaction.client, interaction.user);
    if (isBanned(interaction.user.id)) return interaction.reply({ content: `${userPrefix} You are banned from using this bot.`, ephemeral: true });
    regenStamina(interaction.user.id);
    
    const subcommand = interaction.options.getSubcommand();
    const userId = interaction.user.id;
    
    // Ensure player exists
    let player = db.prepare('SELECT * FROM players WHERE userId=?').get(userId);
    if (!player) {
      db.prepare('INSERT INTO players(userId, name, itemsCrafted) VALUES(?,?,0)').run(userId, interaction.user.username);
      player = db.prepare('SELECT * FROM players WHERE userId=?').get(userId);
    }

    // Ensure crafting tables exist
    try {
      db.prepare(`CREATE TABLE IF NOT EXISTS active_crafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId TEXT NOT NULL,
        itemId TEXT NOT NULL,
        quantity INTEGER DEFAULT 1,
        startTime INTEGER NOT NULL,
        completionTime INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`).run();
    } catch (e) {}

    if (subcommand === 'status') {
      const itemsCrafted = player.itemsCrafted || 0;
      const craftingLevel = getCraftingLevel(itemsCrafted);
      const tierData = CRAFTING_TIERS[craftingLevel];
      const nextTier = CRAFTING_TIERS[craftingLevel + 1];
      
      const activeCrafts = db.prepare('SELECT * FROM active_crafts WHERE userId=? ORDER BY completionTime ASC').all(userId);
      
      // Calculate progress to next tier
      const progress = nextTier ? Math.round(((itemsCrafted - tierData.requirement) / (nextTier.requirement - tierData.requirement)) * 100) : 100;
      const progressBar = nextTier ? '█'.repeat(Math.floor(progress/5)) + '░'.repeat(20 - Math.floor(progress/5)) : '█'.repeat(20);
      
      const statusEmbed = new EmbedBuilder()
        .setTitle('🔨⚡ **CRAFTING MASTERY** ⚡🔨')
        .setDescription(`🎯 *Forge your destiny with skill and precision* ⚒️`)
        .setColor(craftingLevel >= 6 ? 0xFFD700 : craftingLevel >= 4 ? 0x9B59B6 : craftingLevel >= 2 ? 0x3498DB : 0x2ECC71)
        .setAuthor({ 
          name: `${userPrefix} - ${tierData.name}`,
          iconURL: interaction.user.displayAvatarURL() 
        })
        .addFields(
          {
            name: '🏅 **Crafting Level**',
            value: `**${craftingLevel}** - ${tierData.name}\n🎯 ${itemsCrafted} items forged`,
            inline: true
          },
          {
            name: '💎 **Max Rarity**',
            value: `**${tierData.maxRarity.toUpperCase()}**\n✨ Unlock better recipes`,
            inline: true
          },
          {
            name: '🔧 **Active Crafts**',
            value: `**${activeCrafts.length}** / 5 slots used\n⏳ ${activeCrafts.filter(c => c.completionTime <= Date.now()).length} ready`,
            inline: true
          }
        );

      if (nextTier) {
        const remaining = nextTier.requirement - itemsCrafted;
        statusEmbed.addFields({
          name: '📈 **Progress to Next Level**',
          value: `\`${progressBar}\`\n**${remaining}** more items to **${nextTier.name}**\n🎭 Unlock ${nextTier.maxRarity} recipes`,
          inline: false
        });
      }

      if (activeCrafts.length > 0) {
        const craftsList = activeCrafts.map((craft, index) => {
          const item = itemById(craft.itemId);
          const timeLeft = Math.max(0, Math.ceil((craft.completionTime - Date.now()) / 1000));
          const status = timeLeft > 0 ? 
            `⏱️ ${Math.floor(timeLeft / 60)}m ${timeLeft % 60}s` : 
            '✅ **Ready!**';
          return `${index + 1}. **${item?.name || craft.itemId}** x${craft.quantity} - ${status}`;
        }).join('\n');

        statusEmbed.addFields({
          name: '🛠️ **Current Projects**',
          value: craftsList + (activeCrafts.filter(c => c.completionTime <= Date.now()).length > 0 ? '\n\n🎁 Use `/craft complete` to collect finished items!' : ''),
          inline: false
        });
      } else {
        statusEmbed.addFields({
          name: '🔨 **Workshop Status**',
          value: '• No active crafts\n• All slots available\n• Ready for new projects!\n• Use `/craft recipes` to browse',
          inline: false
        });
      }

      statusEmbed
        .setFooter({ 
          text: `⚒️ Master craftsmen forge legendary equipment • QuestCord Workshop`,
          iconURL: interaction.client.user.displayAvatarURL()
        })
        .setTimestamp();

      return interaction.reply({ embeds: [statusEmbed] });
    }

    if (subcommand === 'recipes') {
      const rarityFilter = interaction.options.getString('rarity');
      const itemsCrafted = player.itemsCrafted || 0;
      
      let recipes = (config.items || []).filter(item => {
        if (!item.craftable || !item.recipe) return false;
        if (!canCraftRarity(itemsCrafted, item.rarity)) return false;
        if (rarityFilter && item.rarity !== rarityFilter) return false;
        return true;
      }).slice(0, 10);

      if (recipes.length === 0) {
        const noRecipesEmbed = new EmbedBuilder()
          .setTitle('📋❌ **NO RECIPES AVAILABLE** ❌📋')
          .setDescription('No recipes match your current crafting level and filters')
          .setColor(0x95A5A6)
          .setAuthor({ 
            name: `${userPrefix} - Recipe Browser`,
            iconURL: interaction.user.displayAvatarURL() 
          })
          .addFields(
            {
              name: '🏅 **Current Level**',
              value: `${getCraftingLevel(itemsCrafted)} - ${CRAFTING_TIERS[getCraftingLevel(itemsCrafted)].name}`,
              inline: true
            },
            {
              name: '💎 **Max Rarity**',
              value: CRAFTING_TIERS[getCraftingLevel(itemsCrafted)].maxRarity,
              inline: true
            },
            {
              name: '📈 **Unlock More**',
              value: 'Craft more items to unlock higher tier recipes!',
              inline: true
            }
          )
          .setFooter({ 
            text: `🔨 Keep crafting to unlock legendary recipes • QuestCord Workshop`,
            iconURL: interaction.client.user.displayAvatarURL()
          })
          .setTimestamp();
        return interaction.reply({ embeds: [noRecipesEmbed] });
      }

      // Group recipes by rarity for better organization
      const rarityGroups = {};
      const rarityColors = {
        'common': '⚪',
        'uncommon': '🟢',
        'rare': '🔵', 
        'epic': '🟣',
        'legendary': '🟠',
        'mythic': '🔴',
        'transcendent': '✨'
      };

      recipes.forEach(item => {
        if (!rarityGroups[item.rarity]) {
          rarityGroups[item.rarity] = [];
        }
        rarityGroups[item.rarity].push(item);
      });

      const recipesEmbed = new EmbedBuilder()
        .setTitle('📜⚒️ **CRAFTING RECIPES** ⚒️📜')
        .setDescription(`🎯 *${recipes.length} recipes available for your skill level* 🔨${rarityFilter ? `\n🎭 Filtered by: **${rarityFilter.toUpperCase()}**` : ''}`)
        .setColor(0x00AE86)
        .setAuthor({ 
          name: `${userPrefix} - Master Recipe Book`,
          iconURL: interaction.user.displayAvatarURL() 
        })
        .addFields({
          name: '📊 **Recipe Statistics**',
          value: `• **${recipes.length}** total recipes\n• **${Object.keys(rarityGroups).length}** rarity tiers\n• Level ${getCraftingLevel(itemsCrafted)} accessible`,
          inline: false
        });

      // Add recipes grouped by rarity
      Object.keys(rarityGroups).sort((a, b) => {
        const order = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'transcendent'];
        return order.indexOf(a) - order.indexOf(b);
      }).forEach(rarity => {
        const items = rarityGroups[rarity];
        const rarityIcon = rarityColors[rarity] || '⚪';
        
        const recipeList = items.map(item => {
          const ingredients = item.recipe.map(ing => {
            const ingItem = itemById(ing.id);
            return `${ingItem?.name || ing.id} x${ing.qty}`;
          }).join(', ');
          
          return `**${item.name}**\n└ ${ingredients}`;
        }).join('\n\n');

        recipesEmbed.addFields({
          name: `${rarityIcon} **${rarity.toUpperCase()} TIER** (${items.length})`,
          value: recipeList,
          inline: false
        });
      });

      recipesEmbed
        .setFooter({ 
          text: `⚡ Use /craft item <name> to start crafting • QuestCord Recipes`,
          iconURL: interaction.client.user.displayAvatarURL()
        })
        .setTimestamp();

      return interaction.reply({ embeds: [recipesEmbed] });
    }

    if (subcommand === 'complete') {
      const completedCrafts = db.prepare('SELECT * FROM active_crafts WHERE userId=? AND completionTime<=? ORDER BY completionTime ASC').all(userId, Date.now());
      
      if (completedCrafts.length === 0) {
        const noCraftsEmbed = new EmbedBuilder()
          .setTitle('⏳🔨 **NO COMPLETED CRAFTS** 🔨⏳')
          .setDescription('Your workshop is still hard at work forging items')
          .setColor(0x95A5A6)
          .setAuthor({ 
            name: `${userPrefix} - Workshop Status`,
            iconURL: interaction.user.displayAvatarURL() 
          })
          .addFields({
            name: '🛠️ **Current Status**',
            value: '• No finished items to collect\n• Check active crafts with `/craft status`\n• Start new crafts with `/craft item`',
            inline: false
          })
          .setFooter({ 
            text: `⚒️ Patience yields the finest craftsmanship • QuestCord Workshop`,
            iconURL: interaction.client.user.displayAvatarURL()
          })
          .setTimestamp();
        return interaction.reply({ embeds: [noCraftsEmbed] });
      }

      let completedItems = [];
      let totalExperience = 0;
      for (const craft of completedCrafts) {
        const item = itemById(craft.itemId);
        addItemToInventory(userId, craft.itemId, craft.quantity);
        completedItems.push({
          name: item?.name || craft.itemId,
          quantity: craft.quantity,
          rarity: item?.rarity || 'common'
        });
        totalExperience += craft.quantity;
        
        // Update crafted count
        db.prepare('UPDATE players SET itemsCrafted=itemsCrafted+? WHERE userId=?').run(craft.quantity, userId);
      }

      // Remove completed crafts
      db.prepare('DELETE FROM active_crafts WHERE userId=? AND completionTime<=?').run(userId, Date.now());
      
      // Check for level up
      const newItemsCrafted = (player.itemsCrafted || 0) + totalExperience;
      const oldLevel = getCraftingLevel(player.itemsCrafted || 0);
      const newLevel = getCraftingLevel(newItemsCrafted);
      
      const itemsList = completedItems.map(item => {
        const rarityColors = {
          'common': '⚪',
          'uncommon': '🟢',
          'rare': '🔵',
          'epic': '🟣', 
          'legendary': '🟠',
          'mythic': '🔴',
          'transcendent': '✨'
        };
        const icon = rarityColors[item.rarity] || '⚪';
        return `${icon} **${item.name}** x${item.quantity}`;
      }).join('\n');

      const completeEmbed = new EmbedBuilder()
        .setTitle('🎉🔨 **CRAFTING COMPLETE** 🔨🎉')
        .setDescription('🏆 *Your masterpiece is ready for collection!* ⚡')
        .setColor(0x00D26A)
        .setAuthor({ 
          name: `${userPrefix} - Master Craftsman`,
          iconURL: interaction.user.displayAvatarURL() 
        })
        .addFields(
          {
            name: '🎁 **Items Forged**',
            value: itemsList,
            inline: false
          },
          {
            name: '📈 **Experience Gained**',
            value: `**+${totalExperience}** crafting XP\nTotal items crafted: **${newItemsCrafted}**`,
            inline: true
          },
          {
            name: '🏅 **Current Level**',
            value: `**${newLevel}** - ${CRAFTING_TIERS[newLevel].name}\nMax rarity: **${CRAFTING_TIERS[newLevel].maxRarity}**`,
            inline: true
          }
        );

      if (newLevel > oldLevel) {
        completeEmbed.addFields({
          name: '🎊 **LEVEL UP!** 🎊',
          value: `🏆 Advanced to **${CRAFTING_TIERS[newLevel].name}**!\n✨ You can now craft **${CRAFTING_TIERS[newLevel].maxRarity}** quality items!`,
          inline: false
        });
      }

      completeEmbed
        .setFooter({ 
          text: `⚒️ Excellence in craftsmanship recognized • QuestCord Workshop`,
          iconURL: interaction.client.user.displayAvatarURL()
        })
        .setTimestamp();

      logger.info('craft_complete: user %s collected %d items', userId, completedCrafts.length);
      return interaction.reply({ embeds: [completeEmbed] });
    }

    if (subcommand === 'cancel') {
      const craftId = interaction.options.getInteger('craft_id');
      const craft = db.prepare('SELECT * FROM active_crafts WHERE id=? AND userId=?').get(craftId, userId);
      
      if (!craft) {
        const notFoundEmbed = new EmbedBuilder()
          .setTitle('❌🔨 **CRAFT NOT FOUND** 🔨❌')
          .setDescription('The specified craft could not be found or doesn\'t belong to you')
          .setColor(0xFF6B6B)
          .setAuthor({ 
            name: `${userPrefix} - Workshop Error`,
            iconURL: interaction.user.displayAvatarURL() 
          })
          .addFields({
            name: '🔍 **Troubleshooting**',
            value: '• Check craft ID with `/craft status`\n• Ensure it\'s your active craft\n• Make sure it hasn\'t already completed',
            inline: false
          })
          .setFooter({ 
            text: `🛠️ Use /craft status to see active crafts • QuestCord Workshop`,
            iconURL: interaction.client.user.displayAvatarURL()
          })
          .setTimestamp();
        return interaction.reply({ embeds: [notFoundEmbed], ephemeral: true });
      }

      // Refund 50% of materials
      const item = itemById(craft.itemId);
      let refundedItems = [];
      if (item?.recipe) {
        for (const ingredient of item.recipe) {
          const refundQty = Math.ceil((ingredient.qty * craft.quantity) / 2);
          addItemToInventory(userId, ingredient.id, refundQty);
          const ingItem = itemById(ingredient.id);
          refundedItems.push(`${ingItem?.name || ingredient.id} x${refundQty}`);
        }
      }

      db.prepare('DELETE FROM active_crafts WHERE id=?').run(craftId);
      
      const cancelEmbed = new EmbedBuilder()
        .setTitle('🚫🔨 **CRAFT CANCELLED** 🔨🚫')
        .setDescription('Your crafting project has been halted and materials partially refunded')
        .setColor(0xFF8C00)
        .setAuthor({ 
          name: `${userPrefix} - Workshop Manager`,
          iconURL: interaction.user.displayAvatarURL() 
        })
        .addFields(
          {
            name: '🗑️ **Cancelled Item**',
            value: `**${item?.name || craft.itemId}** x${craft.quantity}\nCraft ID: #${craftId}`,
            inline: true
          },
          {
            name: '💰 **Materials Refunded (50%)**',
            value: refundedItems.length > 0 ? refundedItems.join('\n') : 'No materials to refund',
            inline: true
          },
          {
            name: '📊 **Workshop Status**',
            value: 'Craft slot now available\nReady for new projects',
            inline: true
          }
        )
        .setFooter({ 
          text: `🔄 Start a new craft with /craft item • QuestCord Workshop`,
          iconURL: interaction.client.user.displayAvatarURL()
        })
        .setTimestamp();

      logger.info('craft_cancel: user %s cancelled craft %d', userId, craftId);
      return interaction.reply({ embeds: [cancelEmbed] });
    }

    if (subcommand === 'item') {
      const itemId = interaction.options.getString('item');
      const quantity = interaction.options.getInteger('quantity') || 1;
      const item = itemById(itemId);
      
      if (!item || !item.craftable || !item.recipe) {
        return interaction.reply({ content: `${userPrefix} Item not found or not craftable.`, ephemeral: true });
      }

      const itemsCrafted = player.itemsCrafted || 0;
      if (!canCraftRarity(itemsCrafted, item.rarity)) {
        const requiredLevel = Object.values(CRAFTING_TIERS).find(t => t.maxRarity === item.rarity);
        return interaction.reply({ content: `${userPrefix} You need ${requiredLevel?.requirement || 0} crafted items to make ${item.rarity} items.`, ephemeral: true });
      }

      if (item.premiumNeeded && !(await isPremium(interaction.client, userId))) {
        return interaction.reply({ content: `${userPrefix} This recipe requires Premium membership.`, ephemeral: true });
      }

      // Check if user has required materials (accounting for quantity)
      const scaledRecipe = item.recipe.map(ing => ({ ...ing, qty: ing.qty * quantity }));
      if (!hasRequiredItems(userId, scaledRecipe)) {
        const missing = scaledRecipe.filter(ing => {
          const inv = db.prepare('SELECT qty FROM inventory WHERE userId=? AND itemId=?').get(userId, ing.id);
          return !inv || inv.qty < ing.qty;
        });
        
        const missingText = missing.map(ing => {
          const ingItem = itemById(ing.id);
          const current = db.prepare('SELECT qty FROM inventory WHERE userId=? AND itemId=?').get(userId, ing.id)?.qty || 0;
          return `${ingItem?.name || ing.id}: ${current}/${ing.qty}`;
        }).join(', ');
        
        return interaction.reply({ content: `${userPrefix} Missing materials: ${missingText}`, ephemeral: true });
      }

      // Check active craft limit (max 5 concurrent crafts)
      const activeCraftCount = db.prepare('SELECT COUNT(*) as count FROM active_crafts WHERE userId=?').get(userId)?.count || 0;
      if (activeCraftCount >= 5) {
        return interaction.reply({ content: `${userPrefix} You can only have 5 active crafts at once. Complete or cancel some first.`, ephemeral: true });
      }

      // Consume materials
      consumeIngredients(userId, scaledRecipe);
      
      // Calculate crafting time
      const isPremiumUser = await isPremium(interaction.client, userId);
      const craftingTime = getCraftingTime(item.rarity, isPremiumUser) * quantity;
      const completionTime = Date.now() + (craftingTime * 1000);
      
      // Start craft
      const craftResult = db.prepare('INSERT INTO active_crafts(userId, itemId, quantity, startTime, completionTime) VALUES(?,?,?,?,?)').run(
        userId, itemId, quantity, Date.now(), completionTime
      );

      logger.info('craft_start: user %s started crafting %s x%d', userId, itemId, quantity);
      
      const timeText = craftingTime >= 3600 ? `${Math.floor(craftingTime / 3600)}h ${Math.floor((craftingTime % 3600) / 60)}m` : 
                       craftingTime >= 60 ? `${Math.floor(craftingTime / 60)}m ${craftingTime % 60}s` : `${craftingTime}s`;
      
      const finalCompletionTime = Date.now() + (craftingTime * 1000);
      const rarityColors = {
        'common': '⚪',
        'uncommon': '🟢',
        'rare': '🔵',
        'epic': '🟣',
        'legendary': '🟠',
        'mythic': '🔴',
        'transcendent': '✨'
      };
      const rarityIcon = rarityColors[item.rarity] || '⚪';

      const startEmbed = new EmbedBuilder()
        .setTitle('🔥⚒️ **CRAFTING INITIATED** ⚒️🔥')
        .setDescription(`🎯 *Your workshop springs to life with creative energy* ⚡`)
        .setColor(item.rarity === 'legendary' || item.rarity === 'mythic' || item.rarity === 'transcendent' ? 0xFFD700 : 0x00AE86)
        .setAuthor({ 
          name: `${userPrefix} - Master Artisan`,
          iconURL: interaction.user.displayAvatarURL() 
        })
        .addFields(
          {
            name: '🎨 **Item Being Crafted**',
            value: `${rarityIcon} **${item.name}**\n💎 ${item.rarity} quality`,
            inline: true
          },
          {
            name: '🔢 **Quantity**',
            value: `**${quantity}** item${quantity > 1 ? 's' : ''}\n${quantity > 1 ? '🏭 Batch production' : '🎯 Single craft'}`,
            inline: true
          },
          {
            name: '⏱️ **Crafting Time**',
            value: `**${timeText}**\n${isPremiumUser ? '👑 Premium speed boost' : '⚒️ Standard pace'}`,
            inline: true
          },
          {
            name: '🆔 **Craft ID**',
            value: `**#${craftResult.lastInsertRowid}**\nUse for cancellation`,
            inline: true
          },
          {
            name: '🕐 **Completion Time**',
            value: `**${new Date(finalCompletionTime).toLocaleTimeString()}**\n📅 ${new Date(finalCompletionTime).toLocaleDateString()}`,
            inline: true
          },
          {
            name: '📊 **Workshop Status**',
            value: `**${activeCraftCount + 1}** / 5 slots used\nEfficiency optimized`,
            inline: true
          }
        );

      // Add consumed materials info
      const materialsUsed = scaledRecipe.map(ing => {
        const ingItem = itemById(ing.id);
        return `• ${ingItem?.name || ing.id} x${ing.qty}`;
      }).join('\n');

      startEmbed.addFields({
        name: '📦 **Materials Consumed**',
        value: materialsUsed,
        inline: false
      });

      if (item.description) {
        startEmbed.addFields({
          name: '📖 **Item Description**',
          value: item.description,
          inline: false
        });
      }

      startEmbed
        .setFooter({ 
          text: `⚒️ Use /craft complete when ready • QuestCord Workshop`,
          iconURL: interaction.client.user.displayAvatarURL()
        })
        .setTimestamp();

      return interaction.reply({ embeds: [startEmbed] });
    }
  }
};