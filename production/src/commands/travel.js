const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { db } = require('../utils/store_sqlite');
const { haversine } = require('../utils/geo');
const config = require('../utils/config');
const { isPremium, getUserPrefix } = require('../utils/roles');
const { isBanned, regenStamina } = require('./_guard');
const logger = require('../utils/logger');
const { itemById } = require('../utils/items');
const { ensurePlayerWithVehicles } = require('../utils/players');
const { getAllPOIs, getPOIById, calculateDistance, hasVisitedPOI, visitPOI } = require('../utils/pois');

async function vehicleSpeed(client, userId) {
  // Premium users get private jet speed
  if (await isPremium(client, userId)) {
    return config.vehicles?.private_jet?.speedMultiplier || 3.0;
  }
  // All non-premium users use commercial plane
  return config.vehicles?.plane?.speedMultiplier || 1.0;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('travel')
    .setDescription('Travel to a server or famous landmark')
    .addStringOption(o =>
      o.setName('destination_type')
       .setDescription('Choose destination type')
       .setRequired(true)
       .addChoices(
         { name: 'Server', value: 'server' },
         { name: 'Landmark', value: 'landmark' }
       )
    )
    .addStringOption(o =>
      o.setName('target')
       .setDescription('Server name/ID or landmark name')
       .setRequired(true)
       .setAutocomplete(true)
    ),

  async autocomplete(interaction) {
    const focusedValue = interaction.options.getFocused();
    const focusedOption = interaction.options.getFocused(true);
    const destinationType = interaction.options.getString('destination_type');
    const userId = interaction.user.id;

    try {
      // Get user's current location
      const player = db.prepare(`
        SELECT locationGuildId, travelArrivalAt
        FROM players WHERE userId=?
      `).get(userId) || {};

      // If traveling, can't get suggestions
      if (player.travelArrivalAt && player.travelArrivalAt > Date.now()) {
        return interaction.respond([
          { name: 'You are currently traveling', value: 'traveling' }
        ]);
      }

      const currentGuildId = player.locationGuildId || interaction.guildId;
      const currentServer = db.prepare('SELECT lat, lon FROM servers WHERE guildId=?').get(currentGuildId);

      if (focusedOption.name === 'target' && destinationType === 'landmark') {
        // Handle landmark autocomplete
        const pois = getAllPOIs();
        const filtered = pois.filter(poi => 
          poi.name.toLowerCase().includes(focusedValue.toLowerCase()) ||
          poi.country.toLowerCase().includes(focusedValue.toLowerCase())
        );

        // Calculate distances and add visit status
        const suggestions = filtered.slice(0, 25).map(poi => {
          let distance = '?';
          if (currentServer && currentServer.lat != null) {
            distance = Math.round(calculateDistance(currentServer.lat, currentServer.lon, poi.lat, poi.lon));
          }
          
          const visited = hasVisitedPOI(userId, poi.id);
          const status = visited ? '✅' : '💎' + poi.visitCost;
          
          return {
            name: `${poi.emoji} ${poi.name} (${poi.country}) • ${distance}km • ${status}`,
            value: poi.id
          };
        });

        return interaction.respond(suggestions);
      }

      // Handle server autocomplete (default or when destination_type is 'server')
      if (!destinationType || destinationType === 'server') {
        if (!currentServer || currentServer.lat == null || currentServer.lon == null) {
          // No location data, just show some servers
          const servers = db.prepare(`
            SELECT guildId, name FROM servers 
            WHERE archived=0 AND name IS NOT NULL 
            ORDER BY name LIMIT 10
          `).all();

          const choices = servers.map(s => ({
            name: s.name,
            value: s.name
          }));

          return interaction.respond(choices);
        }

        // Calculate distances and get closest servers
        const servers = db.prepare(`
          SELECT guildId, name, lat, lon FROM servers 
          WHERE archived=0 AND guildId != ? AND name IS NOT NULL 
          AND lat IS NOT NULL AND lon IS NOT NULL
        `).all(currentGuildId);

        // Calculate distances using haversine formula
        const serversWithDistance = servers.map(s => {
          const distance = haversine(
            currentServer.lat, currentServer.lon,
            s.lat, s.lon
          );
          return { ...s, distance };
        });

        // Sort by distance and take top 10
        serversWithDistance.sort((a, b) => a.distance - b.distance);
        const closest = serversWithDistance.slice(0, 10);

        // Filter based on what user is typing
        const filtered = closest.filter(s => 
          s.name.toLowerCase().includes(focusedValue.toLowerCase())
        );

        const choices = filtered.slice(0, 10).map(s => ({
          name: `${s.name} (${Math.round(s.distance)}km)`,
          value: s.name
        }));

        return interaction.respond(choices);
      }
    } catch (error) {
      console.error('Travel autocomplete error:', error);
      await interaction.respond([]);
    }
  },

  async execute(interaction) {
    const userPrefix = await getUserPrefix(interaction.client, interaction.user);
    if (isBanned(interaction.user.id)) return interaction.reply({ content: `${userPrefix} You are banned from using this bot.`, ephemeral: true });
    regenStamina(interaction.user.id);
    
    const destinationType = interaction.options.getString('destination_type');
    const target = interaction.options.getString('target');
    
    if (destinationType === 'landmark') {
      return this.handleLandmarkTravel(interaction, userPrefix, target);
    } else {
      return this.handleServerTravel(interaction, userPrefix, target);
    }
  },

  async handleLandmarkTravel(interaction, userPrefix, landmarkId) {
    const userId = interaction.user.id;
    const poi = getPOIById(landmarkId);
    
    if (!poi) {
      return interaction.reply({
        content: `${userPrefix} Landmark not found.`,
        ephemeral: true
      });
    }

    // Ensure player exists
    const player = await ensurePlayerWithVehicles(interaction.client, userId, interaction.user.username, interaction.guild?.id);
    
    // Check if user has enough gems for visit cost
    if ((player.gems || 0) < poi.visitCost) {
      return interaction.reply({
        content: `${userPrefix} Insufficient gems! You need ${poi.visitCost} 💎 gems to visit ${poi.name}. You have ${player.gems || 0}.`,
        ephemeral: true
      });
    }
    
    // Check if already visited (for first-time bonus)
    const alreadyVisited = hasVisitedPOI(userId, landmarkId);
    
    try {
      // Deduct visit cost in gems
      db.prepare('UPDATE players SET gems = COALESCE(gems, 0) - ? WHERE userId = ?').run(poi.visitCost, userId);
      
      // Record the visit (no rewards given)
      let visitResult;
      if (!alreadyVisited) {
        // Just record the visit without giving rewards
        db.prepare('INSERT INTO poi_visits (userId, poiId, visitedAt, isFirstVisit) VALUES (?, ?, ?, ?)').run(userId, landmarkId, Date.now(), 1);
        visitResult = { poi, isFirstVisit: true, reward: 0, visitedAt: Date.now() };
      } else {
        visitResult = { poi, isFirstVisit: false, reward: 0, visitedAt: Date.now() };
      }
      
      // Create success embed
      const embed = new EmbedBuilder()
        .setTitle(`${poi.emoji} **LANDMARK VISIT: ${poi.name.toUpperCase()}**`)
        .setDescription(`*${alreadyVisited ? 'Welcome back to' : 'Welcome to'} ${poi.name}, ${interaction.user.username}!*`)
        .setColor(alreadyVisited ? 0xE67E22 : 0x00D26A)
        .setAuthor({
          name: `${userPrefix} - World Explorer`,
          iconURL: interaction.user.displayAvatarURL()
        })
        .addFields(
          {
            name: '📍 **Location**',
            value: `${poi.emoji} **${poi.name}**\n${poi.country}`,
            inline: true
          },
          {
            name: '💸 **Travel Cost**',
            value: `${poi.visitCost} 💎 gems\nFlight expenses`,
            inline: true
          }
        );

      if (visitResult.isFirstVisit) {
        embed.addFields({
          name: '🌟 **First Visit**',
          value: `Welcome to ${poi.name}!\nFirst time visiting`,
          inline: true
        });
        embed.setDescription(`*🎉 Welcome to ${poi.name} for the first time!*`);
      } else {
        embed.addFields({
          name: '✅ **Return Visit**',
          value: `Welcome back!\nPreviously visited`,
          inline: true
        });
      }
      
      if (poi.description) {
        embed.addFields({
          name: '📖 **About This Landmark**',
          value: poi.description,
          inline: false
        });
      }
      
      embed.setFooter({
        text: alreadyVisited ? 'Thanks for visiting again! • QuestCord Travel' : 'Landmark discovered! • QuestCord Travel',
        iconURL: interaction.client.user.displayAvatarURL()
      }).setTimestamp();
      
      await interaction.reply({ embeds: [embed] });
      
    } catch (error) {
      console.error('Landmark travel error:', error);
      return interaction.reply({
        content: `${userPrefix} ${error.message}`,
        ephemeral: true
      });
    }
  },

  async handleServerTravel(interaction, userPrefix, target) {
    const servers = db.prepare('SELECT * FROM servers WHERE archived=0 AND (name LIKE ? OR guildId=?) AND lat IS NOT NULL AND lon IS NOT NULL').all(`%${target}%`, target);
    if (!servers.length) {
      return interaction.reply({ content: `${userPrefix} No matching active server with coordinates.`, ephemeral: true });
    }
    const dest = servers[0];
    let p = await ensurePlayerWithVehicles(interaction.client, interaction.user.id, interaction.user.username, interaction.guild?.id);
    let fromServer = db.prepare('SELECT * FROM servers WHERE guildId=? AND archived=0').get(p.locationGuildId || interaction.guild?.id);
    if (!fromServer || fromServer.lat == null) {
      fromServer = db.prepare('SELECT * FROM servers WHERE guildId=? AND archived=0').get(interaction.guild?.id);
    }
    const tcfg = config.travel || {};
    const minS = tcfg.minSeconds ?? 60;
    const maxS = tcfg.maxSeconds ?? 600;
    const distMult = tcfg.distanceMultiplier ?? 0.2;

    // Check for weather effects and calculate intelligent route
    let weatherInfo = null;
    let weatherMessage = '';
    let weatherTimeMultiplier = 1.0;
    
    try {
      const { getWeatherEffectsForTravel, recordWeatherEncounter } = require('../utils/weather');
      if (fromServer && fromServer.lat != null) {
        weatherInfo = getWeatherEffectsForTravel(fromServer.lat, fromServer.lon, dest.lat, dest.lon);
        weatherTimeMultiplier = weatherInfo.timeMultiplier || 1.0;
        
        if (weatherInfo.detourRequired) {
          weatherMessage = `\n🌪️ **Weather Alert:** Route adjusted to avoid ${weatherInfo.weatherAvoided}`;
          // Record weather avoidance for achievements
          for (const weatherEvent of weatherInfo.weatherEncountered) {
            recordWeatherEncounter(interaction.user.id, weatherEvent.id, 'avoided');
          }
        } else if (weatherInfo.weatherDescription !== 'Clear skies') {
          weatherMessage = `\n⛅ **Weather:** ${weatherInfo.weatherDescription} (${Math.round((weatherTimeMultiplier - 1) * 100)}% slower)`;
          // Record weather encounter for achievements
          for (const effect of weatherInfo.weatherEffects) {
            recordWeatherEncounter(interaction.user.id, effect.weather.id, 'flew_through');
          }
        }
      }
    } catch (error) {
      console.warn('[travel] Weather system unavailable:', error.message);
    }

    let timeSec = minS;
    if (fromServer && fromServer.lat != null) {
      const d = weatherInfo ? weatherInfo.totalDistance : haversine(fromServer.lat, fromServer.lon, dest.lat, dest.lon);
      const mult = await vehicleSpeed(interaction.client, interaction.user.id);
      let base = minS + (d * distMult) / mult;
      
      // Apply weather time multiplier
      base *= weatherTimeMultiplier;
      
      const staminaRow = db.prepare('SELECT stamina FROM players WHERE userId=?').get(interaction.user.id);
      const stamina = staminaRow?.stamina || 0;
      const maxReduction = (config.stamina?.travelMaxReductionPct ?? 50) / 100;
      const staminaFactor = 1 - Math.min(maxReduction, stamina / 200);
      timeSec = Math.round(base * staminaFactor);
      if (timeSec < minS) timeSec = minS;
      if (timeSec > maxS) timeSec = maxS;
      const spend = config.stamina?.travelCost ?? 10;
      const newSt = Math.max(0, stamina - spend);
      db.prepare('UPDATE players SET stamina=?, staminaUpdatedAt=? WHERE userId=?').run(newSt, Date.now(), interaction.user.id);
    }
    const arrival = Date.now() + timeSec * 1000;
    db.prepare('UPDATE players SET travelArrivalAt=?, travelStartAt=?, locationGuildId=?, travelFromGuildId=? WHERE userId=?').run(arrival, Date.now(), dest.guildId, fromServer ? fromServer.guildId : null, interaction.user.id);
    const base = (config.web && config.web.publicBaseUrl || '').replace(/\/$/, '');
    const isPremiumUser = await isPremium(interaction.client, interaction.user.id);
    const speedMult = await vehicleSpeed(interaction.client, interaction.user.id);
    
    // Calculate distance
    const distance = fromServer && fromServer.lat != null ? 
      haversine(fromServer.lat, fromServer.lon, dest.lat, dest.lon) : 0;
    
    // Get stamina info
    const staminaRow = db.prepare('SELECT stamina FROM players WHERE userId=?').get(interaction.user.id);
    const currentStamina = staminaRow?.stamina || 0;
    const staminaCost = config.stamina?.travelCost ?? 10;
    
    // Create epic travel embed with enhanced theming
    const travelEmbed = new EmbedBuilder()
      .setTitle('🌍✈️ **DIMENSIONAL GATEWAY ACTIVATED** ✈️🌍')
      .setDescription(`⚡ *Initiating quantum server jump through the multiverse* ⚡`)
      .setColor(isPremiumUser ? 0xFFD700 : 0x00AE86)
      .setAuthor({ 
        name: `${userPrefix} - Interdimensional Traveler`,
        iconURL: interaction.user.displayAvatarURL() 
      });

    // Enhanced vehicle theming
    const vehicleEmoji = isPremiumUser ? '🚀' : '✈️';
    const vehicleName = isPremiumUser ? 'Quantum Starship' : 'Interdimensional Cruiser';
    const vehicleDesc = isPremiumUser ? 
      '✨ Luxurious quantum-enhanced cabin with reality distortion fields' : 
      '⚡ Advanced propulsion systems with dimensional stabilizers';

    travelEmbed.addFields(
      {
        name: `${vehicleEmoji} **Transport Vessel**`,
        value: `**${vehicleName}**\n${vehicleDesc}`,
        inline: true
      },
      {
        name: '🗺️ **Destination**',
        value: `**${dest.name}**\n📍 Server ID: ${dest.guildId}`,
        inline: true
      },
      {
        name: '⏱️ **Journey Duration**',
        value: `**${Math.floor(timeSec/60)}m ${timeSec%60}s**\n🌟 ${speedMult}x quantum acceleration`,
        inline: true
      }
    );

    if (distance > 0) {
      travelEmbed.addFields({
        name: '📏 **Dimensional Distance**',
        value: `**${distance.toFixed(1)} km**\n🌌 Quantum tunnel trajectory`,
        inline: true
      });
    }

    if (fromServer) {
      travelEmbed.addFields({
        name: '🏃‍♀️ **Origin Portal**',
        value: `**${fromServer.name || fromServer.guildId}**\n🕐 ${new Date().toLocaleTimeString()}`,
        inline: true
      });
    }

    travelEmbed.addFields({
      name: '🎯 **Arrival Portal**',
      value: `**${new Date(arrival).toLocaleTimeString()}**\n🌌 ${new Date(arrival).toLocaleDateString()}\n⚡ Quantum sync in progress`,
      inline: true
    });

    // Energy consumption section
    travelEmbed.addFields({
      name: '⚡ **Energy Consumption**',
      value: `**Quantum fuel used:** ${staminaCost} units\n**Remaining energy:** ${Math.max(0, currentStamina - staminaCost)} units`,
      inline: true
    });

    // Premium benefits
    if (isPremiumUser) {
      travelEmbed.addFields({
        name: '👑 **Quantum Elite Perks**',
        value: `• ${speedMult}x quantum acceleration\n• Luxurious reality-warped cabin\n• Priority dimensional access\n• Complimentary cosmic refreshments\n• Enhanced multiverse navigation`,
        inline: false
      });
    }

    // Map link
    if (base) {
      travelEmbed.addFields({
        name: '🗺️ **Interactive Map**',
        value: `[View Destination on Map](${base}/${dest.guildId})`,
        inline: false
      });
    }

    // Weather information
    if (weatherMessage) {
      travelEmbed.addFields({
        name: '🌦️ **Weather Conditions**',
        value: weatherMessage.replace(/^\n/, ''),
        inline: false
      });
    }

    travelEmbed
      .setFooter({ 
        text: `🌌 Safe travels through the quantum void, adventurer! • QuestCord Dimensional Transit`,
        iconURL: interaction.client.user.displayAvatarURL()
      })
      .setTimestamp();

    logger.info('travel_start: user %s to %s from %s (speed: %sx)', interaction.user.id, dest.guildId, fromServer?.guildId, speedMult);
    await interaction.reply({ embeds: [travelEmbed] });
  }
};
