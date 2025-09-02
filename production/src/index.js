// Load environment-specific .env file first, then fallback to default
// DEVELOPMENT VERSION WITH TEST CHANGES
const envFile = process.env.NODE_ENV ? `.env.${process.env.NODE_ENV}` : '.env';
require('dotenv').config({ path: envFile });
require('dotenv').config(); // Fallback to .env for any missing vars
const { Client, Collection, GatewayIntentBits, Partials, Events, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { db } = require('./utils/store_sqlite');
const { createWebServer } = require('./web/server');
const { createAutoPlacementIfMissing } = require('./web/util');
const { placeOnSpiral, findLandPosition, checkAndFixWaterServers, findNonCollidingLandPosition } = require('./utils/geo');
const logger = require('./utils/logger');
const config = require('./utils/config');
const { logBotStartup, logError, logBotShutdown, logCommandError } = require('./utils/webhook_safe');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember]
});

client.commands = new Collection();
const cmdFiles = fs.readdirSync(path.join(__dirname, 'commands')).filter(f => f.endsWith('.js') && !['_common.js', '_guard.js'].includes(f));
for (const f of cmdFiles) {
  const cmd = require(path.join(__dirname, 'commands', f));
  if (cmd.data) client.commands.set(cmd.data.name, cmd);
}

const buckets = new Map();
function hit(userId) {
  const now = Date.now();
  const lim = config.security?.commandRate || { max: 12, perMs: 10000 };
  const max = lim.max ?? 12;
  const perMs = lim.perMs ?? 10000;
  const b = buckets.get(userId) || { count: 0, reset: now + perMs };
  if (now > b.reset) {
    b.count = 0;
    b.reset = now + perMs;
  }
  b.count++;
  buckets.set(userId, b);
  return b.count <= max;
}

async function autoPlaceIfNeeded(guildId) {
  const s = db.prepare('SELECT * FROM servers WHERE guildId=?').get(guildId);
  if (!s || s.lat == null || s.lon == null) {
    try {
      const count = db.prepare('SELECT COUNT(*) as n FROM servers').get().n;
      const center = process.env.SPAWN_GUILD_ID ? db.prepare('SELECT lat, lon FROM servers WHERE guildId=?').get(process.env.SPAWN_GUILD_ID) || { lat: 0, lon: 0 } : { lat: 0, lon: 0 };
      
      // Use collision-aware placement
      const pos = await findNonCollidingLandPosition(center.lat, center.lon, db);
      const biome = require('./web/util').assignBiomeDeterministic(guildId);
      
      db.prepare('UPDATE servers SET lat=?, lon=?, biome=? WHERE guildId=?').run(pos.lat, pos.lon, biome, guildId);
      console.log(`Auto-placed guild ${guildId} at ${pos.lat}, ${pos.lon} (${biome})`);
    } catch (error) {
      console.warn(`Failed to auto-place guild ${guildId} with collision detection, using fallback:`, error.message);
      
      // Fallback to original spiral placement
      const count = db.prepare('SELECT COUNT(*) as n FROM servers').get().n;
      const center = process.env.SPAWN_GUILD_ID ? db.prepare('SELECT lat, lon FROM servers WHERE guildId=?').get(process.env.SPAWN_GUILD_ID) || { lat: 0, lon: 0 } : { lat: 0, lon: 0 };
      const pos = placeOnSpiral(count, center);
      const biome = require('./web/util').assignBiomeDeterministic(guildId);
      db.prepare('UPDATE servers SET lat=?, lon=?, biome=? WHERE guildId=?').run(pos.lat, pos.lon, biome, guildId);
    }
  }
}

function updateBossStatus() {
  try {
    const activeBossCount = db.prepare('SELECT COUNT(*) as count FROM bosses WHERE active=1 AND expiresAt > ?').get(Date.now()).count;
    
    let status;
    let activityType;
    if (activeBossCount === 0) {
      status = 'Peaceful World';
      activityType = 0; // PLAYING
    } else if (activeBossCount === 1) {
      status = '1 Boss Active!';
      activityType = 1; // STREAMING  
    } else {
      status = `${activeBossCount} Bosses Active!`;
      activityType = 1; // STREAMING
    }
    
    client.user.setActivity(status, { 
      type: activityType,
      url: activityType === 1 ? 'https://twitch.tv/questcord' : undefined
    });
    
    logger.info('boss_status: Updated bot status - %s', status);
  } catch (error) {
    logger.error('boss_status: Failed to update bot status - %s', error.message);
  }
}

// Export the function so it can be called from other modules
module.exports = { updateBossStatus };

client.once(Events.ClientReady, async () => {
  console.log(`[bot] Logged in as ${client.user.tag}`);
  
  // Log bot startup to webhook
  try {
    await logBotStartup();
    console.log('[webhook] Startup logged to Discord');
  } catch (error) {
    console.warn('[webhook] Failed to log startup:', error.message);
  }
  
  // Auto-deploy slash commands on startup
  try {
    console.log('[deploy] Deploying slash commands...');
    require('../scripts/deploy-commands');
    console.log('[deploy] Slash commands deployed successfully');
  } catch (error) {
    console.error('[deploy] Failed to deploy slash commands:', error.message);
    await logError(error, 'Slash command deployment failed');
  }
  
  // Initialize boss status tracking
  updateBossStatus();
  setInterval(updateBossStatus, 30000); // Update every 30 seconds
  
  // Initialize regeneration system (handles travel completion and stats recording)
  const { applyRegenToAll } = require('./utils/regen');
  applyRegenToAll(); // Run once on startup
  setInterval(applyRegenToAll, 60000); // Run every 60 seconds
  console.log('[regen] Batch regeneration system started - travel completion and stats recording active');
  
  // Initialize weather system
  const { initializeWeatherSystem, generateWeatherEvents } = require('./utils/weather');
  initializeWeatherSystem(); // Setup database tables
  generateWeatherEvents(client); // Generate initial weather
  setInterval(() => generateWeatherEvents(client), 5 * 60 * 1000); // Generate new weather every 5 minutes
  console.log('[weather] Dynamic weather system initialized - storms, cyclones, and weather effects active');
  
  // Initialize POI system with famous landmarks
  const { initializePOIs } = require('./utils/pois');
  initializePOIs();
  console.log('[poi] Points of Interest system initialized - famous landmarks ready for exploration');
  
  // Initialize automatic boss spawning system with randomized 4-6 hour intervals
  const { initializeBossSpawner, runBossSpawningCycle, getNextSpawnInterval, cleanupExpiredBosses, cleanupOrphanedBossFighterRoles } = require('./utils/boss_spawner');
  initializeBossSpawner(); // Setup boss spawning system
  
  // Startup cleanup: Clean up any expired bosses and orphaned roles from previous session
  console.log('[boss_spawner] Running startup cleanup...');
  
  // Add a small delay to ensure bot is fully ready and guilds are cached
  setTimeout(async () => {
    try {
      const expiredCount = await cleanupExpiredBosses(client); // Clean up expired bosses and database records
      await cleanupOrphanedBossFighterRoles(client); // Clean up orphaned Discord roles
      console.log(`[boss_spawner] Startup cleanup completed - cleaned up ${expiredCount} expired bosses and orphaned roles`);
    } catch (error) {
      console.warn('[boss_spawner] Startup cleanup failed:', error.message);
    }
  }, 5000); // Wait 5 seconds for bot to be fully ready
  
  // Initial spawn cycle will be run async without blocking startup
  runBossSpawningCycle(client).catch(err => console.warn('[boss_spawner] Initial spawn cycle failed:', err.message)); // Run initial spawn cycle
  
  // Set up randomized spawning intervals
  function scheduleNextBossSpawn() {
    const nextInterval = getNextSpawnInterval(); // 4-6 hours randomized
    const hoursFromNow = (nextInterval / (1000 * 60 * 60)).toFixed(1);
    console.log(`[boss_spawner] Next boss spawn scheduled in ${hoursFromNow} hours`);
    
    setTimeout(async () => {
      try {
        await runBossSpawningCycle(client);
      } catch (error) {
        console.warn('[boss_spawner] Scheduled spawn cycle failed:', error.message);
      }
      scheduleNextBossSpawn(); // Schedule the next one
    }, nextInterval);
  }
  
  scheduleNextBossSpawn(); // Start the randomized scheduling
  console.log('[boss_spawner] Automatic boss spawning system initialized - 4-6 hour randomized intervals with chance-based spawning (15 global limit)');
  
  for (const [id, guild] of client.guilds.cache) {
    const iconUrl = guild.iconURL({ extension: 'png', size: 64 });
    const exists = db.prepare('SELECT 1 FROM servers WHERE guildId=?').get(id);
    if (!exists) {
      db.prepare('INSERT INTO servers(guildId, name, ownerId, addedAt, iconUrl, archived) VALUES(?,?,?,?,?,0)').run(id, guild.name, guild.ownerId, Date.now(), iconUrl);
      logger.info('guild_add: %s (%s)', guild.name, id);
    } else {
      db.prepare('UPDATE servers SET name=?, ownerId=?, iconUrl=?, archived=0, archivedAt=NULL, archivedBy=NULL WHERE guildId=?').run(guild.name, guild.ownerId, iconUrl, id);
    }
    await autoPlaceIfNeeded(id);
  }
  createAutoPlacementIfMissing().catch(console.error);
  
  // Check for servers in water and fix them automatically
  try {
    console.log('Starting water check...');
    await checkAndFixWaterServers(db);
  } catch (error) {
    console.error('Water check failed:', error.message);
  }
  
  createWebServer();
});

client.on(Events.GuildCreate, async (guild) => {
  const iconUrl = guild.iconURL({ extension: 'png', size: 64 });
  const exists = db.prepare('SELECT 1 FROM servers WHERE guildId=?').get(guild.id);
  if (!exists) {
    db.prepare('INSERT INTO servers(guildId, name, ownerId, addedAt, iconUrl, archived) VALUES(?,?,?,?,?,0)').run(guild.id, guild.name, guild.ownerId, Date.now(), iconUrl);
  } else {
    db.prepare('UPDATE servers SET name=?, ownerId=?, iconUrl=?, archived=0, archivedAt=NULL, archivedBy=NULL WHERE guildId=?').run(guild.name, guild.ownerId, iconUrl, guild.id);
  }
  
  try {
    const center = process.env.SPAWN_GUILD_ID ? db.prepare('SELECT lat, lon FROM servers WHERE guildId=?').get(process.env.SPAWN_GUILD_ID) || { lat: 0, lon: 0 } : { lat: 0, lon: 0 };
    
    // Use collision-aware land placement
    const pos = await findNonCollidingLandPosition(center.lat, center.lon, db);
    const biome = require('./web/util').assignBiomeDeterministic(guild.id);
    
    db.prepare('UPDATE servers SET lat=?, lon=?, biome=? WHERE guildId=?').run(pos.lat, pos.lon, biome, guild.id);
    logger.info('guild_add: %s (%s) placed at collision-free land position %s,%s', guild.name, guild.id, pos.lat, pos.lon);
  } catch (error) {
    logger.error('Error placing guild with collision detection: %s', error.message);
    // Fallback to original placement if advanced placement fails
    const count = db.prepare('SELECT COUNT(*) as n FROM servers').get().n;
    const center = process.env.SPAWN_GUILD_ID ? db.prepare('SELECT lat, lon FROM servers WHERE guildId=?').get(process.env.SPAWN_GUILD_ID) || { lat: 0, lon: 0 } : { lat: 0, lon: 0 };
    const pos = placeOnSpiral(count, center);
    const biome = require('./web/util').assignBiomeDeterministic(guild.id);
    db.prepare('UPDATE servers SET lat=?, lon=?, biome=? WHERE guildId=?').run(pos.lat, pos.lon, biome, guild.id);
    logger.info('guild_add: %s (%s) placed at fallback position %s,%s', guild.name, guild.id, pos.lat, pos.lon);
  }
});

client.on(Events.GuildDelete, (guild) => {
  db.prepare('UPDATE servers SET archived=1, archivedAt=?, archivedBy=? WHERE guildId=?').run(Date.now(), 'system', guild.id);
  logger.info('guild_remove_soft: %s', guild.id);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      const cmd = client.commands.get(interaction.commandName);
      if (cmd && cmd.autocomplete) return cmd.autocomplete(interaction);
      return;
    }
    if (interaction.isButton()) {
      // Handle button interactions
      if (interaction.customId.startsWith('market_buy_')) {
        const listingId = parseInt(interaction.customId.replace('market_buy_', ''));
        
        // Import the market command and use its buy logic
        const marketCommand = require('./commands/market');
        
        // Create a proper fake interaction object for the buy subcommand
        const fakeInteraction = {
          ...interaction,
          user: interaction.user,
          client: interaction.client,
          guildId: interaction.guildId,
          reply: interaction.reply.bind(interaction),
          followUp: interaction.followUp.bind(interaction),
          options: {
            getSubcommand: () => 'buy',
            getInteger: (name) => name === 'listing' ? listingId : null
          }
        };
        
        try {
          await marketCommand.execute(fakeInteraction);
        } catch (error) {
          console.error('Button interaction error:', error);
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: 'Error processing purchase.', ephemeral: true });
          }
        }
        return;
      }
      
      // Handle quick sell buttons
      if (interaction.customId.startsWith('quick_sell_')) {
        const itemId = interaction.customId.replace('quick_sell_', '');
        const { itemById } = require('./utils/items');
        const item = itemById(itemId);
        
        if (!item) {
          return interaction.reply({ content: '❌ Item not found.', ephemeral: true });
        }
        
        // Create modal for price input
        const modal = new ModalBuilder()
          .setCustomId(`sell_modal_${itemId}`)
          .setTitle(`Sell ${item.name}`);
        
        // Price input
        const priceInput = new TextInputBuilder()
          .setCustomId('sell_price')
          .setLabel('Price per item (in Drakari)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Enter price (e.g. 100)')
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(10);
        
        // Quantity input
        const qtyInput = new TextInputBuilder()
          .setCustomId('sell_quantity')
          .setLabel('Quantity to sell')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Enter quantity (e.g. 5)')
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(10);
        
        // Duration input
        const durationInput = new TextInputBuilder()
          .setCustomId('sell_duration')
          .setLabel('⏰ Listing Duration')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('10m, 1h, 6h, 12h, or 24h')
          .setRequired(true)
          .setMinLength(2)
          .setMaxLength(4);
        
        const priceRow = new ActionRowBuilder().addComponents(priceInput);
        const qtyRow = new ActionRowBuilder().addComponents(qtyInput);
        const durationRow = new ActionRowBuilder().addComponents(durationInput);
        
        modal.addComponents(priceRow, qtyRow, durationRow);
        
        await interaction.showModal(modal);
        return;
      }
    }
    
    // Handle modal submissions
    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith('sell_modal_')) {
        const itemId = interaction.customId.replace('sell_modal_', '');
        const price = parseInt(interaction.fields.getTextInputValue('sell_price'));
        const qty = parseInt(interaction.fields.getTextInputValue('sell_quantity'));
        const duration = interaction.fields.getTextInputValue('sell_duration');
        
        // Validate inputs
        if (isNaN(price) || price <= 0) {
          return interaction.reply({ content: '❌ Invalid price. Please enter a positive number.', ephemeral: true });
        }
        
        if (isNaN(qty) || qty <= 0) {
          return interaction.reply({ content: '❌ Invalid quantity. Please enter a positive number.', ephemeral: true });
        }
        
        if (!['10m', '1h', '6h', '12h', '24h'].includes(duration)) {
          return interaction.reply({ content: '❌ Invalid duration. Use: 10m, 1h, 6h, 12h, or 24h', ephemeral: true });
        }
        
        // Check listing limits
        const { isPremium } = require('./utils/roles');
        const isPremiumUser = await isPremium(interaction.client, interaction.user.id);
        const maxListings = isPremiumUser ? 5 : 2;
        
        const currentListings = db.prepare('SELECT COUNT(*) as count FROM market_listings WHERE sellerId = ? AND expiresAt > ?')
          .get(interaction.user.id, Date.now());
        
        if (currentListings.count >= maxListings) {
          return interaction.reply({ 
            content: `❌ Market listing limit reached! ${isPremiumUser ? 'Premium users' : 'Users'} can have up to **${maxListings}** active listings.\n\nCancel existing listings with \`/market cancel <listing_id>\` or upgrade to premium for more slots.`, 
            ephemeral: true 
          });
        }
        
        // Create listing directly instead of using disabled subcommand
        try {
          const { itemById, isTradable } = require('./utils/items');
          const config = require('./utils/config');
          const { getUserPrefix } = require('./utils/roles');
          const logger = require('./utils/logger');
          const { EmbedBuilder } = require('discord.js');
          
          const userPrefix = await getUserPrefix(interaction.client, interaction.user);
          const item = itemById(itemId);
          
          if (!item) {
            return interaction.reply({ content: `${userPrefix} Item not found.`, ephemeral: true });
          }
          
          if (!isTradable(itemId)) {
            return interaction.reply({ content: `${userPrefix} This item cannot be traded.`, ephemeral: true });
          }
          
          // Check inventory
          const inv = db.prepare('SELECT qty FROM inventory WHERE userId=? AND itemId=?').get(interaction.user.id, itemId);
          if (!inv || inv.qty < qty) {
            return interaction.reply({ content: `${userPrefix} Not enough items in inventory.`, ephemeral: true });
          }
          
          // Calculate expiration time
          const mult = { '10m': 600, '1h': 3600, '6h': 21600, '12h': 43200, '24h': 86400 }[duration];
          let actualExpires = Date.now() + mult * 1000;
          
          // Premium users get 2x listing duration
          if (isPremiumUser) {
            actualExpires = Date.now() + (mult * 2 * 1000);
          }
          
          // Calculate listing fee (premium users get 50% off)
          const listingFee = Math.floor(price * 0.02); // 2% listing fee
          const actualFee = isPremiumUser ? Math.floor(listingFee * 0.5) : listingFee;
          
          const playerBalance = db.prepare('SELECT drakari FROM players WHERE userId=?').get(interaction.user.id);
          if (!playerBalance || playerBalance.drakari < actualFee) {
            return interaction.reply({ 
              content: `${userPrefix} Insufficient funds for listing fee. Required: ${actualFee} ${config.currencyName}`, 
              ephemeral: true 
            });
          }
          
          // Deduct items from inventory and listing fee
          db.prepare('UPDATE inventory SET qty=qty-? WHERE userId=? AND itemId=?').run(qty, interaction.user.id, itemId);
          db.prepare('DELETE FROM inventory WHERE qty<=0').run();
          db.prepare('UPDATE players SET drakari=drakari-? WHERE userId=?').run(actualFee, interaction.user.id);
          
          // Create market listing
          const info = db.prepare('INSERT INTO market_listings(sellerId,itemId,qty,price,expiresAt) VALUES(?,?,?,?,?)').run(interaction.user.id, itemId, qty, price, actualExpires);
          logger.info('market_list: user %s listed %s x%s for %s', interaction.user.id, itemId, qty, price);
          
          // Create success embed
          const listingEmbed = new EmbedBuilder()
            .setTitle('MARKETPLACE LISTING CREATED')
            .setDescription(`Your **${item.name}** is now available for purchase!`)
            .setColor(0x00FF00)
            .addFields(
              {
                name: '**Listed Item**',
                value: `**${item.name}** × ${qty}${isPremiumUser ? ' [PREMIUM]' : ''}`,
                inline: true
              },
              {
                name: '**Asking Price**',
                value: `${price.toLocaleString()} ${config.currencyName}\n(${Math.round(price/qty).toLocaleString()} each)`,
                inline: true
              },
              {
                name: '**Listing ID**',
                value: `**#${info.lastInsertRowid}**\nUse for buy/cancel`,
                inline: true
              },
              {
                name: '**Listing Fee**',
                value: `${actualFee.toLocaleString()} ${config.currencyName}${isPremiumUser ? ' (50% off)' : ''}\n${((actualFee/price)*100).toFixed(1)}% of price`,
                inline: true
              },
              {
                name: '**Duration**',
                value: `${duration}${isPremiumUser ? ' × 2 (premium bonus)' : ''}\nExpires: <t:${Math.floor(actualExpires/1000)}:R>`,
                inline: true
              },
              {
                name: '**Sale Tax**',
                value: `${config.marketTaxPct}% on sale\n(${Math.floor(price * (config.marketTaxPct/100)).toLocaleString()} ${config.currencyName})`,
                inline: true
              }
            );
            
          listingEmbed.setFooter({ 
            text: `${isPremiumUser ? 'Premium listings get priority display' : 'Use /market browse to see all listings'} • QuestCord`,
            iconURL: interaction.client.user.displayAvatarURL()
          }).setTimestamp();

          await interaction.reply({ embeds: [listingEmbed] });
          
        } catch (error) {
          console.error('Modal submission error:', error);
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: '❌ Error listing item for sale. Please try again.', ephemeral: true });
          }
        }
        return;
      }
    }
    
    if (!interaction.isChatInputCommand()) return;
    if (!hit(interaction.user.id)) return interaction.reply({ content: 'Slow down a bit.', ephemeral: true });
    const cmd = client.commands.get(interaction.commandName);
    if (!cmd) return;
    
    // Create context object that commands expect
    const ctx = {
      db,
      config,
      tag: (s) => `\`${s}\``, // Simple tag function
      fetchRoleLevel: require('./web/util').fetchRoleLevel,
      log: (event, data) => logger.info('cmd_%s: %s', event, JSON.stringify(data))
    };
    
    await cmd.execute(interaction);
    logger.info('cmd: %s by %s in %s', interaction.commandName, interaction.user.id, interaction.guildId);
  } catch (e) {
    console.error(e);
    
    // Log command error to webhook
    try {
      await logCommandError(interaction.commandName, interaction.user.id, interaction.guildId, e);
    } catch (webhookError) {
      console.warn('[webhook] Failed to log command error:', webhookError.message);
    }
    
    if (interaction.isRepliable()) {
      if (interaction.deferred || interaction.replied) interaction.followUp({ content: 'Error executing command.', ephemeral: true });
      else interaction.reply({ content: 'Error executing command.', ephemeral: true });
    }
    logger.error('cmd error: %s by %s in %s - %s', interaction.commandName, interaction.user.id, interaction.guildId, e?.message || e);
  }
});

client.login(process.env.DISCORD_TOKEN);

// Handle uncaught exceptions and log them
process.on('uncaughtException', async (error) => {
  console.error('Uncaught Exception:', error);
  try {
    await logError(error, 'Uncaught Exception');
  } catch (webhookError) {
    console.warn('Failed to log uncaught exception:', webhookError.message);
  }
  process.exit(1);
});

// Handle unhandled promise rejections and log them
process.on('unhandledRejection', async (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  try {
    await logError(new Error(`Unhandled Rejection: ${reason}`), 'Unhandled Promise Rejection');
  } catch (webhookError) {
    console.warn('Failed to log unhandled rejection:', webhookError.message);
  }
});

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nReceived SIGINT. Graceful shutdown initiated...');
  try {
    await logBotShutdown('Manual shutdown (SIGINT)');
    console.log('Shutdown logged to Discord');
  } catch (webhookError) {
    console.warn('Failed to log shutdown:', webhookError.message);
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nReceived SIGTERM. Graceful shutdown initiated...');
  try {
    await logBotShutdown('System shutdown (SIGTERM)');
    console.log('Shutdown logged to Discord');
  } catch (webhookError) {
    console.warn('Failed to log shutdown:', webhookError.message);
  }
  process.exit(0);
});

// Ensure a guild has a biome assigned; if missing, assign randomly from config.biomes
function ensureGuildBiome(guildId) {
  try {
    const row = db.prepare('SELECT biome FROM servers WHERE guildId=?').get(guildId);
    if (!row) return;
    if (!row.biome || !String(row.biome).trim()) {
      const arr = Array.isArray(config.biomes) && config.biomes.length ? config.biomes : [
        'Volcanic','Ruins','Swamp','Water','Forest','Ice','Meadow','Mountain'
      ];
      const pick = arr[Math.floor(Math.random() * arr.length)];
      db.prepare('UPDATE servers SET biome=?, tokens=COALESCE(tokens, 1) WHERE guildId=?')
        .run(String(pick).toLowerCase(), guildId);
      console.log('[biome] Assigned random biome to guild', guildId, '→', pick);
    }
  } catch (e) { console.warn('[biome] ensureGuildBiome error:', e.message); }
}



// On ready, ensure all guilds have a biome
client.once(Events.ClientReady, async () => {
  try {
    for (const [id] of client.guilds.cache) {
      ensureGuildBiome(id);
    }
  } catch (e) { console.warn('[biome] ready hook error:', e.message); }
});

