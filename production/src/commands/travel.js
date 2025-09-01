const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { db } = require('../utils/store_sqlite');
const { haversine } = require('../utils/geo');
const config = require('../utils/config');
const { isPremium, getUserPrefix } = require('../utils/roles');
const { isBanned, regenStamina } = require('./_guard');
const logger = require('../utils/logger');
const { itemById } = require('../utils/items');
const { ensurePlayerWithVehicles } = require('../utils/players');

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
    .setDescription('Travel to a target server by name or id (virtual travel).')
    .addStringOption(o =>
      o.setName('target')
       .setDescription('Server name or id')
       .setRequired(true)
       .setAutocomplete(true)
    ),

  async autocomplete(interaction) {
    const focusedValue = interaction.options.getFocused();
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

      await interaction.respond(choices);
    } catch (error) {
      console.error('Travel autocomplete error:', error);
      await interaction.respond([]);
    }
  },

  async execute(interaction) {
    const userPrefix = await getUserPrefix(interaction.client, interaction.user);
    if (isBanned(interaction.user.id)) return interaction.reply({ content: `${userPrefix} You are banned from using this bot.`, ephemeral: true });
    regenStamina(interaction.user.id);
    const target = interaction.options.getString('target');
    const servers = db.prepare('SELECT * FROM servers WHERE archived=0 AND (name LIKE ? OR guildId=?) AND lat IS NOT NULL AND lon IS NOT NULL').all(`%${target}%`, target);
    if (!servers.length) {
      return interaction.reply({ content: `${userPrefix} No matching active server with coordinates.`, ephemeral: true });
    }
    const dest = servers[0];
    let p = await ensurePlayerWithVehicles(interaction.client, interaction.user.id, interaction.user.username, interaction.guild.id);
    let fromServer = db.prepare('SELECT * FROM servers WHERE guildId=? AND archived=0').get(p.locationGuildId || interaction.guild.id);
    if (!fromServer || fromServer.lat == null) {
      fromServer = db.prepare('SELECT * FROM servers WHERE guildId=? AND archived=0').get(interaction.guild.id);
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
    
    // Create spectacular travel embed
    const travelEmbed = new EmbedBuilder()
      .setTitle('🌍✈️ **JOURNEY INITIATED** ✈️🌍')
      .setDescription(`🚀 *Preparing for departure to another server* 🚀`)
      .setColor(isPremiumUser ? 0xFFD700 : 0x00AE86)
      .setAuthor({ 
        name: `${userPrefix} - New Server Awaits`,
        iconURL: interaction.user.displayAvatarURL() 
      });

    // Flight details
    const vehicleEmoji = isPremiumUser ? '✈️' : '🛩️';
    const vehicleName = isPremiumUser ? 'Premium Private Jet' : 'Commercial Aircraft';
    const vehicleDesc = isPremiumUser ? 
      '🥂 Luxury cabin with premium amenities' : 
      '🎒 Comfortable economy seating';

    travelEmbed.addFields(
      {
        name: `${vehicleEmoji} **Vehicle**`,
        value: `**${vehicleName}**\n${vehicleDesc}`,
        inline: true
      },
      {
        name: '🗺️ **Destination**',
        value: `**${dest.name}**\n📍 Server ID: ${dest.guildId}`,
        inline: true
      },
      {
        name: '⏱️ **Flight Time**',
        value: `**${Math.floor(timeSec/60)}m ${timeSec%60}s**\n🏃‍♂️ ${speedMult}x speed boost`,
        inline: true
      }
    );

    if (distance > 0) {
      travelEmbed.addFields({
        name: '📏 **Distance**',
        value: `**${distance.toFixed(1)} km**\n🗺️ Great circle route`,
        inline: true
      });
    }

    if (fromServer) {
      travelEmbed.addFields({
        name: '🏃‍♀️ **Departure**',
        value: `**${fromServer.name || fromServer.guildId}**\n🕐 ${new Date().toLocaleTimeString()}`,
        inline: true
      });
    }

    travelEmbed.addFields({
      name: '🕐 **Arrival Time**',
      value: `**${new Date(arrival).toLocaleTimeString()}**\n📅 ${new Date(arrival).toLocaleDateString()}`,
      inline: true
    });

    // Stamina section
    travelEmbed.addFields({
      name: '💨 **Stamina Usage**',
      value: `**Used:** ${staminaCost} stamina\n**Remaining:** ${Math.max(0, currentStamina - staminaCost)} stamina`,
      inline: true
    });

    // Premium benefits
    if (isPremiumUser) {
      travelEmbed.addFields({
        name: '👑 **Premium Benefits**',
        value: `• ${speedMult}x faster travel\n• Luxury accommodations\n• Priority boarding\n• Complimentary refreshments`,
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
        text: `✈️ Bon voyage! Safe travels to your destination • QuestCord Travel`,
        iconURL: interaction.client.user.displayAvatarURL()
      })
      .setTimestamp();

    logger.info('travel_start: user %s to %s from %s (speed: %sx)', interaction.user.id, dest.guildId, fromServer?.guildId, speedMult);
    await interaction.reply({ embeds: [travelEmbed] });
  }
};
