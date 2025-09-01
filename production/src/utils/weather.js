const { db } = require('./store_sqlite');

// Discord notification configuration
const DISCORD_CONFIG = {
  WEATHER_CHANNEL_ID: '1411045103921004554',
  WEATHER_ROLE_ID: '1411069664339034152'
};

// Geographic weather preferences based on real-world climate patterns
const WEATHER_GEOGRAPHY = {
  'cyclone': {
    preferredRegions: ['tropical', 'coastal'],
    latRange: [-30, 30], // Tropical cyclone belt
    avoidPolar: true
  },
  'hurricane': {
    preferredRegions: ['tropical', 'coastal'],
    latRange: [5, 40], // Hurricane formation zones
    avoidPolar: true,
    seasonalBonus: [6, 7, 8, 9, 10, 11] // Hurricane season (Jun-Nov)
  },
  'blizzard': {
    preferredRegions: ['polar', 'temperate'],
    latRange: [30, 90], // Northern regions
    seasonalBonus: [12, 1, 2, 3] // Winter months
  },
  'heavy_snow': {
    preferredRegions: ['polar', 'temperate'],
    latRange: [25, 90],
    seasonalBonus: [11, 12, 1, 2, 3, 4]
  },
  'sandstorm': {
    preferredRegions: ['desert', 'arid'],
    latRange: [10, 45], // Desert belt
    lonPreference: 'continental' // Away from oceans
  },
  'thunderstorm': {
    preferredRegions: ['temperate', 'tropical'],
    latRange: [-50, 50],
    seasonalBonus: [4, 5, 6, 7, 8, 9] // Spring/Summer
  },
  'fog_bank': {
    preferredRegions: ['coastal', 'temperate'],
    latRange: [30, 60], // Mid-latitudes
    coastalPreference: true
  },
  'aurora_storm': {
    preferredRegions: ['polar'],
    latRange: [60, 90], // Arctic/Antarctic
    rareBonus: true
  },
  'volcanic_ash': {
    preferredRegions: ['volcanic'],
    // Volcanic activity zones (Ring of Fire, etc.)
    ringOfFire: true,
    ultraRare: true
  }
};

/**
 * Generate realistic weather location based on geographic preferences
 */
function generateRealisticWeatherLocation(weatherType, weatherData, servers, minLat, maxLat, minLon, maxLon) {
  const geoPrefs = WEATHER_GEOGRAPHY[weatherType];
  const now = new Date();
  const month = now.getMonth() + 1; // 1-12
  
  // Start with all inhabited areas
  let potentialLocs = [];
  
  // Filter servers by geographic preferences
  if (geoPrefs) {
    const filteredServers = servers.filter(server => {
      // Latitude range filter
      if (geoPrefs.latRange) {
        const [minLat, maxLat] = geoPrefs.latRange;
        if (server.lat < minLat || server.lat > maxLat) return false;
      }
      
      // Polar avoidance
      if (geoPrefs.avoidPolar && Math.abs(server.lat) > 60) return false;
      
      // Coastal preference
      if (geoPrefs.coastalPreference) {
        // Add coastal bias (simplified)
        return Math.random() < 0.7; // 70% chance for coastal areas
      }
      
      return true;
    });
    
    if (filteredServers.length > 0) {
      // Choose area near suitable servers
      const chosenServer = filteredServers[Math.floor(Math.random() * filteredServers.length)];
      
      // Add some randomness around the chosen server (±2 degrees)
      const centerLat = chosenServer.lat + (Math.random() - 0.5) * 4;
      const centerLon = chosenServer.lon + (Math.random() - 0.5) * 4;
      
      // Apply seasonal bonus
      let rarityMultiplier = 1;
      if (geoPrefs.seasonalBonus && geoPrefs.seasonalBonus.includes(month)) {
        rarityMultiplier = 2; // 2x more likely in appropriate season
      }
      
      return {
        centerLat: Math.max(minLat, Math.min(maxLat, centerLat)),
        centerLon: Math.max(minLon, Math.min(maxLon, centerLon)),
        rarityMultiplier
      };
    }
  }
  
  // Fallback to random location if no geographic preferences or suitable areas
  return {
    centerLat: minLat + Math.random() * (maxLat - minLat),
    centerLon: minLon + Math.random() * (maxLon - minLon),
    rarityMultiplier: 1
  };
}

/**
 * Weather System for QuestCord
 * Generates dynamic weather events that affect travel and gameplay
 */

// Weather event types with severity levels and effects
const WEATHER_TYPES = {
  // Severe weather that requires pathfinding around
  'cyclone': {
    name: 'Cyclone',
    severity: 5,
    icon: 'CYCLONE',
    color: '#8B0000',
    radius: 150, // km radius of effect
    blockTravel: true,
    travelTimeMultiplier: 0, // Cannot travel through
    description: 'Devastating winds and destruction',
    rarity: 0.004 // Increased frequency
  },
  'supercell_thunderstorm': {
    name: 'Supercell Thunderstorm',
    severity: 4,
    icon: 'SUPERCELL_STORM',
    color: '#4B0082',
    radius: 100,
    blockTravel: true,
    travelTimeMultiplier: 0,
    description: 'Extreme lightning and hail',
    rarity: 0.008 // Increased frequency
  },
  'hurricane': {
    name: 'Hurricane',
    severity: 5,
    icon: 'HURRICANE',
    color: '#DC143C',
    radius: 200,
    blockTravel: true,
    travelTimeMultiplier: 0,
    description: 'Catastrophic storm system',
    rarity: 0.002 // Increased frequency
  },
  'blizzard': {
    name: 'Blizzard',
    severity: 4,
    icon: 'BLIZZARD',
    color: '#4682B4',
    radius: 80,
    blockTravel: true,
    travelTimeMultiplier: 0,
    description: 'Zero visibility snowstorm',
    rarity: 0.006 // Increased frequency
  },
  
  // Moderate weather that slows travel
  'thunderstorm': {
    name: 'Thunderstorm',
    severity: 3,
    icon: 'THUNDERSTORM',
    color: '#696969',
    radius: 60,
    blockTravel: false,
    travelTimeMultiplier: 1.5,
    description: 'Heavy rain and lightning',
    rarity: 0.025 // Increased frequency
  },
  'heavy_snow': {
    name: 'Heavy Snow',
    severity: 3,
    icon: 'SNOW',
    color: '#B0C4DE',
    radius: 70,
    blockTravel: false,
    travelTimeMultiplier: 1.4,
    description: 'Thick snowfall reducing visibility',
    rarity: 0.020 // Increased frequency
  },
  'sandstorm': {
    name: 'Sandstorm',
    severity: 3,
    icon: 'SANDSTORM',
    color: '#DDB570',
    radius: 90,
    blockTravel: false,
    travelTimeMultiplier: 1.6,
    description: 'Swirling sand and dust',
    rarity: 0.015 // Increased frequency
  },
  'fog_bank': {
    name: 'Dense Fog',
    severity: 2,
    icon: 'FOG',
    color: '#C0C0C0',
    radius: 40,
    blockTravel: false,
    travelTimeMultiplier: 1.3,
    description: 'Thick fog reducing visibility',
    rarity: 0.035 // Increased frequency
  },
  
  // Mild weather with minor effects
  'rain': {
    name: 'Rain',
    severity: 1,
    icon: 'RAIN',
    color: '#4169E1',
    radius: 50,
    blockTravel: false,
    travelTimeMultiplier: 1.1,
    description: 'Steady rainfall',
    rarity: 0.050 // Increased frequency
  },
  'light_snow': {
    name: 'Light Snow',
    severity: 1,
    icon: 'LIGHT_SNOW',
    color: '#E6E6FA',
    radius: 45,
    blockTravel: false,
    travelTimeMultiplier: 1.05,
    description: 'Gentle snowfall',
    rarity: 0.030 // Increased frequency
  },
  'high_winds': {
    name: 'High Winds',
    severity: 2,
    icon: 'WIND',
    color: '#708090',
    radius: 60,
    blockTravel: false,
    travelTimeMultiplier: 1.2,
    description: 'Strong gusting winds',
    rarity: 0.025 // Increased frequency
  },
  
  // Special/Rare weather events
  'aurora_storm': {
    name: 'Aurora Storm',
    severity: 1,
    icon: 'AURORA',
    color: '#00FF7F',
    radius: 100,
    blockTravel: false,
    travelTimeMultiplier: 0.9, // Actually helps travel!
    description: 'Beautiful aurora with electromagnetic effects',
    rarity: 0.0001,
    special: 'navigation_boost'
  },
  'meteor_shower': {
    name: 'Meteor Shower',
    severity: 2,
    icon: 'METEOR',
    color: '#FFD700',
    radius: 80,
    blockTravel: false,
    travelTimeMultiplier: 1.1,
    description: 'Spectacular celestial display',
    rarity: 0.0002,
    special: 'rare_loot_chance'
  },
  'volcanic_ash': {
    name: 'Volcanic Ash Cloud',
    severity: 4,
    icon: 'VOLCANIC',
    color: '#A0522D',
    radius: 120,
    blockTravel: true,
    travelTimeMultiplier: 0,
    description: 'Toxic ash cloud from volcanic activity',
    rarity: 0.0003
  },
  'plasma_storm': {
    name: 'Plasma Storm',
    severity: 3,
    icon: 'PLASMA',
    color: '#FF1493',
    radius: 75,
    blockTravel: false,
    travelTimeMultiplier: 1.3,
    description: 'Electromagnetic anomaly',
    rarity: 0.0001,
    special: 'energy_weapon_boost'
  }
};

/**
 * Initialize weather system database tables
 */
function initializeWeatherSystem() {
  try {
    // Create weather_events table
    db.prepare(`
      CREATE TABLE IF NOT EXISTS weather_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        centerLat REAL NOT NULL,
        centerLon REAL NOT NULL,
        radius REAL NOT NULL,
        severity INTEGER NOT NULL,
        startTime INTEGER NOT NULL,
        endTime INTEGER NOT NULL,
        active INTEGER DEFAULT 1,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
      )
    `).run();
    
    // Create weather_encounters table for tracking player interactions
    db.prepare(`
      CREATE TABLE IF NOT EXISTS weather_encounters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId TEXT NOT NULL,
        weatherEventId INTEGER NOT NULL,
        encounterType TEXT NOT NULL, -- 'avoided', 'flew_through', 'detoured'
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (weatherEventId) REFERENCES weather_events(id)
      )
    `).run();
    
    console.log('[weather] Weather system database initialized');
    return true;
  } catch (error) {
    console.error('[weather] Failed to initialize weather system:', error.message);
    return false;
  }
}

/**
 * Send Discord notification for significant weather events
 */
async function notifyDiscordWeatherEvent(weatherEvent, weatherType, client) {
  try {
    if (!client || weatherType.severity < 3) {
      return; // Only notify for moderate weather (severity 3+) and above
    }

    const channel = await client.channels.fetch(DISCORD_CONFIG.WEATHER_CHANNEL_ID);
    if (!channel) {
      console.warn('[weather] Could not find weather notification channel');
      return;
    }

    // Calculate duration
    const durationMs = weatherEvent.endTime - weatherEvent.startTime;
    const durationHours = Math.round(durationMs / 1000 / 60 / 60 * 10) / 10; // Round to 1 decimal

    // Find nearest servers for context
    const nearbyServers = db.prepare(`
      SELECT name, guildId,
        ((lat - ?) * (lat - ?) + (lon - ?) * (lon - ?)) as distanceSquared
      FROM servers 
      WHERE lat IS NOT NULL AND lon IS NOT NULL AND archived = 0
      ORDER BY distanceSquared
      LIMIT 3
    `).all(weatherEvent.centerLat, weatherEvent.centerLat, weatherEvent.centerLon, weatherEvent.centerLon);

    const nearbyText = nearbyServers.length > 0 
      ? `\n**Near:** ${nearbyServers.map(s => s.name).join(', ')}`
      : '';

    const { EmbedBuilder } = require('discord.js');
    const isSevereWeather = weatherType.blockTravel && weatherType.severity >= 4;
    const embed = new EmbedBuilder()
      .setTitle(`${weatherType.icon} **${weatherType.name.toUpperCase()} ${isSevereWeather ? 'ALERT' : 'ADVISORY'}** ${weatherType.icon}`)
      .setDescription(`${isSevereWeather ? '**SEVERE WEATHER WARNING**' : '**WEATHER ADVISORY**'}\n*${weatherType.description}*`)
      .setColor(parseInt(weatherType.color.replace('#', ''), 16) || 0xFF0000)
      .addFields(
        {
          name: '**TRAVEL WARNING**',
          value: weatherType.blockTravel 
            ? '**ALL TRAVEL THROUGH THIS AREA IS BLOCKED**\nTravelers will be automatically routed around this storm'
            : `**TRAVEL DELAYED** - Speed reduced by ${Math.round((weatherType.travelTimeMultiplier - 1) * 100)}%\nTravel through this area will take longer`,
          inline: false
        },
        {
          name: '**Storm Details**',
          value: `**Severity:** ${weatherType.severity}/5\n**Radius:** ${weatherEvent.radius}km\n**Duration:** ~${durationHours}h${nearbyText}`,
          inline: true
        },
        {
          name: '**Location**',
          value: `**Coordinates:** ${weatherEvent.centerLat.toFixed(2)}, ${weatherEvent.centerLon.toFixed(2)}\n**Map:** [View on QuestCord Map](https://questcord.com/)`,
          inline: true
        }
      )
      .setFooter({ 
        text: `${isSevereWeather ? 'Stay safe, adventurers!' : 'Plan your travels accordingly!'} Weather will clear automatically • QuestCord Weather System`,
        iconURL: client.user?.displayAvatarURL()
      })
      .setTimestamp();

    // Send notification with role mention
    await channel.send({
      content: `<@&${DISCORD_CONFIG.WEATHER_ROLE_ID}> ${isSevereWeather ? '**SEVERE WEATHER ALERT**' : '**WEATHER ADVISORY**'}`,
      embeds: [embed]
    });

    console.log(`[weather] Sent Discord notification for ${weatherType.name} event`);

  } catch (error) {
    console.error('[weather] Failed to send Discord notification:', error.message);
  }
}

/**
 * Generate random weather events based on probability
 */
function generateWeatherEvents(client = null) {
  try {
    const now = Date.now();
    
    // Clean up expired weather events
    db.prepare('DELETE FROM weather_events WHERE endTime < ?').run(now);
    
    // Get current active weather count
    const activeCount = db.prepare('SELECT COUNT(*) as count FROM weather_events WHERE active = 1').get().count;
    
    // Don't generate too many weather events at once (max 75 active globally)
    if (activeCount >= 75) {
      return;
    }
    
    // Get world bounds for weather generation (approximate inhabited area)
    const servers = db.prepare('SELECT lat, lon FROM servers WHERE lat IS NOT NULL AND lon IS NOT NULL AND archived = 0').all();
    if (servers.length === 0) return;
    
    const lats = servers.map(s => s.lat);
    const lons = servers.map(s => s.lon);
    const minLat = Math.min(...lats) - 2;
    const maxLat = Math.max(...lats) + 2;
    const minLon = Math.min(...lons) - 2;
    const maxLon = Math.max(...lons) + 2;
    
    // Generate weather events based on probability and geography
    for (const [typeId, weather] of Object.entries(WEATHER_TYPES)) {
      if (Math.random() < weather.rarity) {
        // Use geographic preferences for realistic weather placement
        const location = generateRealisticWeatherLocation(typeId, weather, servers, minLat, maxLat, minLon, maxLon);
        
        // Apply seasonal and geographic rarity bonus
        const effectiveRarity = weather.rarity * location.rarityMultiplier;
        if (Math.random() > effectiveRarity && location.rarityMultiplier > 1) {
          continue; // Skip this iteration if the bonus wasn't enough
        }
        
        // Duration based on severity (30min to 6 hours)
        const baseDuration = 30 * 60 * 1000; // 30 minutes
        const duration = baseDuration + (weather.severity * 60 * 60 * 1000); // +1 hour per severity level
        
        const endTime = now + duration + (Math.random() * duration); // Add some randomness
        
        // Create weather event with 5x larger radius
        const result = db.prepare(`
          INSERT INTO weather_events (type, centerLat, centerLon, radius, severity, startTime, endTime)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(typeId, location.centerLat, location.centerLon, weather.radius * 5, weather.severity, now, endTime);
        
        const weatherEvent = {
          id: result.lastInsertRowid,
          type: typeId,
          centerLat: location.centerLat,
          centerLon: location.centerLon,
          radius: weather.radius * 5, // Store actual 5x radius
          severity: weather.severity,
          startTime: now,
          endTime
        };

        // Send Discord notification for moderate and severe weather
        if (client) {
          notifyDiscordWeatherEvent(weatherEvent, weather, client);
        }
        
        console.log(`[weather] Generated ${weather.name} at (${location.centerLat.toFixed(2)}, ${location.centerLon.toFixed(2)}), radius: ${weather.radius * 5}km, duration: ${Math.round((endTime - now) / 1000 / 60)}min`);
      }
    }
    
  } catch (error) {
    console.error('[weather] Error generating weather events:', error.message);
  }
}

/**
 * Get all active weather events
 */
function getActiveWeather() {
  try {
    const now = Date.now();
    return db.prepare(`
      SELECT * FROM weather_events 
      WHERE active = 1 AND startTime <= ? AND endTime > ?
    `).all(now, now);
  } catch (error) {
    console.error('[weather] Error getting active weather:', error.message);
    return [];
  }
}

/**
 * Check if a coordinate is affected by severe weather
 */
function isLocationAffectedBySevereWeather(lat, lon) {
  const activeWeather = getActiveWeather();
  
  for (const weather of activeWeather) {
    const weatherType = WEATHER_TYPES[weather.type];
    if (!weatherType || !weatherType.blockTravel) continue;
    
    const distance = calculateDistance(lat, lon, weather.centerLat, weather.centerLon);
    if (distance <= weather.radius) {
      return {
        blocked: true,
        weather: weather,
        weatherType: weatherType,
        distance: distance
      };
    }
  }
  
  return { blocked: false };
}

/**
 * Calculate distance between two points in kilometers
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

/**
 * Find safe path around severe weather using A* pathfinding
 */
function findSafePathAroundWeather(fromLat, fromLon, toLat, toLon) {
  const activeWeather = getActiveWeather().filter(w => WEATHER_TYPES[w.type]?.blockTravel);
  
  // If no severe weather, return direct path
  if (activeWeather.length === 0) {
    return {
      path: [{lat: fromLat, lon: fromLon}, {lat: toLat, lon: toLon}],
      weatherEncountered: [],
      totalDistance: calculateDistance(fromLat, fromLon, toLat, toLon),
      detourRequired: false
    };
  }
  
  // Check if direct path intersects severe weather
  const directPathBlocked = checkPathIntersectsWeather(fromLat, fromLon, toLat, toLon, activeWeather);
  
  if (!directPathBlocked.blocked) {
    return {
      path: [{lat: fromLat, lon: fromLon}, {lat: toLat, lon: toLon}],
      weatherEncountered: [],
      totalDistance: calculateDistance(fromLat, fromLon, toLat, toLon),
      detourRequired: false
    };
  }
  
  // Find path around weather using simplified pathfinding
  const safePath = findPathAroundObstacles(fromLat, fromLon, toLat, toLon, activeWeather);
  
  return {
    path: safePath,
    weatherEncountered: directPathBlocked.weatherEvents,
    totalDistance: calculatePathDistance(safePath),
    detourRequired: true,
    weatherAvoided: directPathBlocked.weatherEvents.map(w => WEATHER_TYPES[w.type]?.name).join(', ')
  };
}

/**
 * Check if a path intersects with severe weather
 */
function checkPathIntersectsWeather(fromLat, fromLon, toLat, toLon, weatherEvents) {
  const intersections = [];
  
  for (const weather of weatherEvents) {
    const weatherType = WEATHER_TYPES[weather.type];
    if (!weatherType?.blockTravel) continue;
    
    // Check if path intersects weather circle
    const intersects = lineIntersectsCircle(
      fromLat, fromLon, toLat, toLon,
      weather.centerLat, weather.centerLon, weather.radius / 111 // Convert km to degrees (approx)
    );
    
    if (intersects) {
      intersections.push(weather);
    }
  }
  
  return {
    blocked: intersections.length > 0,
    weatherEvents: intersections
  };
}

/**
 * Simple pathfinding around circular obstacles
 */
function findPathAroundObstacles(fromLat, fromLon, toLat, toLon, obstacles) {
  // For each obstacle that blocks the direct path, create waypoints around it
  let currentPath = [{lat: fromLat, lon: fromLon}];
  
  for (const obstacle of obstacles) {
    const weatherType = WEATHER_TYPES[obstacle.type];
    if (!weatherType?.blockTravel) continue;
    
    // Create waypoints around the weather system
    const safeDistance = (obstacle.radius / 111) * 1.2; // 20% safety margin, convert to degrees
    
    // Calculate perpendicular points to create detour
    const bearing = Math.atan2(toLon - fromLon, toLat - fromLat);
    const perpBearing1 = bearing + Math.PI / 2;
    const perpBearing2 = bearing - Math.PI / 2;
    
    // Two possible detour points
    const detour1 = {
      lat: obstacle.centerLat + Math.cos(perpBearing1) * safeDistance,
      lon: obstacle.centerLon + Math.sin(perpBearing1) * safeDistance
    };
    const detour2 = {
      lat: obstacle.centerLat + Math.cos(perpBearing2) * safeDistance,
      lon: obstacle.centerLon + Math.sin(perpBearing2) * safeDistance
    };
    
    // Choose closer detour point
    const dist1 = calculateDistance(fromLat, fromLon, detour1.lat, detour1.lon);
    const dist2 = calculateDistance(fromLat, fromLon, detour2.lat, detour2.lon);
    
    const chosenDetour = dist1 < dist2 ? detour1 : detour2;
    currentPath.push(chosenDetour);
  }
  
  // Add final destination
  currentPath.push({lat: toLat, lon: toLon});
  
  return currentPath;
}

/**
 * Check if line intersects circle (weather system)
 */
function lineIntersectsCircle(x1, y1, x2, y2, cx, cy, radius) {
  // Distance from center to line
  const A = y2 - y1;
  const B = x1 - x2;
  const C = x2 * y1 - x1 * y2;
  
  const distance = Math.abs(A * cx + B * cy + C) / Math.sqrt(A * A + B * B);
  
  return distance <= radius;
}

/**
 * Calculate total distance of a path
 */
function calculatePathDistance(path) {
  let totalDistance = 0;
  for (let i = 1; i < path.length; i++) {
    totalDistance += calculateDistance(
      path[i-1].lat, path[i-1].lon,
      path[i].lat, path[i].lon
    );
  }
  return totalDistance;
}

/**
 * Get weather effects for a travel route
 */
function getWeatherEffectsForTravel(fromLat, fromLon, toLat, toLon) {
  const pathResult = findSafePathAroundWeather(fromLat, fromLon, toLat, toLon);
  
  // Check for weather along the safe path that affects travel time
  const weatherEffects = [];
  let totalTimeMultiplier = 1.0;
  
  const allWeather = getActiveWeather();
  for (const weather of allWeather) {
    const weatherType = WEATHER_TYPES[weather.type];
    if (!weatherType) continue;
    
    // Check if any point in path is affected by this weather
    for (const point of pathResult.path) {
      const distance = calculateDistance(point.lat, point.lon, weather.centerLat, weather.centerLon);
      if (distance <= weather.radius) {
        weatherEffects.push({
          weather: weather,
          weatherType: weatherType,
          effect: weatherType.travelTimeMultiplier
        });
        
        // Apply the worst weather effect encountered
        if (weatherType.travelTimeMultiplier > totalTimeMultiplier) {
          totalTimeMultiplier = weatherType.travelTimeMultiplier;
        }
        break;
      }
    }
  }
  
  return {
    ...pathResult,
    weatherEffects,
    timeMultiplier: totalTimeMultiplier,
    weatherDescription: weatherEffects.map(e => e.weatherType.name).join(', ') || 'Clear skies'
  };
}

/**
 * Record weather encounter for achievements/statistics
 */
function recordWeatherEncounter(userId, weatherEventId, encounterType) {
  try {
    db.prepare(`
      INSERT INTO weather_encounters (userId, weatherEventId, encounterType, timestamp)
      VALUES (?, ?, ?, ?)
    `).run(userId, weatherEventId, encounterType, Date.now());
  } catch (error) {
    console.error('[weather] Error recording weather encounter:', error.message);
  }
}

/**
 * Create a weather event at specific coordinates (for staff commands)
 */
function createWeatherEvent(type, lat, lon, durationMinutes = 60, customRadius = null, client = null) {
  try {
    const weatherType = WEATHER_TYPES[type];
    if (!weatherType) {
      console.error(`[weather] Invalid weather type: ${type}`);
      return null;
    }

    const now = Date.now();
    const duration = durationMinutes * 60 * 1000; // Convert to milliseconds
    const expiresAt = now + duration;
    const radius = customRadius || (weatherType.radius * 5); // 5x larger radius
    const eventId = `weather_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    // Create weather event in database
    const result = db.prepare(`
      INSERT INTO weather_events (
        id, type, name, centerLat, centerLon, radius, 
        severity, blockTravel, icon, color, 
        createdAt, endTime, expiresAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      type,
      weatherType.name,
      lat,
      lon,
      radius,
      weatherType.severity,
      weatherType.blockTravel ? 1 : 0,
      weatherType.icon,
      weatherType.color,
      now,
      expiresAt,
      expiresAt
    );

    const weatherEvent = {
      id: eventId,
      type,
      name: weatherType.name,
      centerLat: lat,
      centerLon: lon,
      radius,
      severity: weatherType.severity,
      blockTravel: weatherType.blockTravel,
      icon: weatherType.icon,
      color: weatherType.color,
      createdAt: now,
      expiresAt
    };

    console.log(`[weather] Created ${weatherType.name} at ${lat}, ${lon} (${radius}km radius, ${durationMinutes}min duration)`);

    // Send Discord notification for moderate and severe weather
    if (weatherType.severity >= 3 && client) {
      notifyDiscordWeatherEvent(weatherEvent, weatherType, client);
    }

    return weatherEvent;
  } catch (error) {
    console.error('[weather] Error creating weather event:', error.message);
    return null;
  }
}

/**
 * Remove a specific weather event by ID
 */
function removeWeatherEvent(eventId) {
  try {
    const result = db.prepare('DELETE FROM weather_events WHERE id = ?').run(eventId);
    if (result.changes > 0) {
      console.log(`[weather] Removed weather event: ${eventId}`);
      return true;
    }
    return false;
  } catch (error) {
    console.error('[weather] Error removing weather event:', error.message);
    return false;
  }
}

/**
 * Clear all active weather events
 */
function clearAllWeatherEvents() {
  try {
    const result = db.prepare('DELETE FROM weather_events WHERE expiresAt > ?').run(Date.now());
    console.log(`[weather] Cleared ${result.changes} active weather events`);
    return result.changes;
  } catch (error) {
    console.error('[weather] Error clearing weather events:', error.message);
    return 0;
  }
}

/**
 * Create weather event in a specific country/region
 */
async function createWeatherInCountry(type, countryName, client = null) {
  try {
    // Country coordinates database (major countries and regions)
    const COUNTRY_COORDS = {
      'usa': { lat: 39.8283, lon: -98.5795, name: 'United States' },
      'united states': { lat: 39.8283, lon: -98.5795, name: 'United States' },
      'canada': { lat: 56.1304, lon: -106.3468, name: 'Canada' },
      'uk': { lat: 55.3781, lon: -3.4360, name: 'United Kingdom' },
      'united kingdom': { lat: 55.3781, lon: -3.4360, name: 'United Kingdom' },
      'germany': { lat: 51.1657, lon: 10.4515, name: 'Germany' },
      'france': { lat: 46.2276, lon: 2.2137, name: 'France' },
      'japan': { lat: 36.2048, lon: 138.2529, name: 'Japan' },
      'australia': { lat: -25.2744, lon: 133.7751, name: 'Australia' },
      'brazil': { lat: -14.2350, lon: -51.9253, name: 'Brazil' },
      'china': { lat: 35.8617, lon: 104.1954, name: 'China' },
      'india': { lat: 20.5937, lon: 78.9629, name: 'India' },
      'russia': { lat: 61.5240, lon: 105.3188, name: 'Russia' },
      'mexico': { lat: 23.6345, lon: -102.5528, name: 'Mexico' },
      'spain': { lat: 40.4637, lon: -3.7492, name: 'Spain' },
      'italy': { lat: 41.8719, lon: 12.5674, name: 'Italy' },
      'norway': { lat: 60.4720, lon: 8.4689, name: 'Norway' },
      'sweden': { lat: 60.1282, lon: 18.6435, name: 'Sweden' },
      'finland': { lat: 61.9241, lon: 25.7482, name: 'Finland' },
      'iceland': { lat: 64.9631, lon: -19.0208, name: 'Iceland' },
      'greenland': { lat: 71.7069, lon: -42.6043, name: 'Greenland' },
      'south africa': { lat: -30.5595, lon: 22.9375, name: 'South Africa' },
      'egypt': { lat: 26.0975, lon: 30.0444, name: 'Egypt' },
      'antarctica': { lat: -82.8628, lon: 135.0000, name: 'Antarctica' },
      'pacific': { lat: 0.0000, lon: -160.0000, name: 'Pacific Ocean' },
      'atlantic': { lat: 0.0000, lon: -30.0000, name: 'Atlantic Ocean' }
    };

    const normalizedCountry = countryName.toLowerCase().trim();
    const countryData = COUNTRY_COORDS[normalizedCountry];

    if (!countryData) {
      return {
        success: false,
        message: `Country "${countryName}" not found. Available regions: ${Object.keys(COUNTRY_COORDS).join(', ')}`
      };
    }

    // Add some random offset to avoid exact same coordinates
    const latOffset = (Math.random() - 0.5) * 10; // ±5 degrees
    const lonOffset = (Math.random() - 0.5) * 20; // ±10 degrees
    
    const finalLat = Math.max(-90, Math.min(90, countryData.lat + latOffset));
    const finalLon = Math.max(-180, Math.min(180, countryData.lon + lonOffset));

    // Create the weather event with default 120 minute duration for regional events
    const weatherEvent = createWeatherEvent(type, finalLat, finalLon, 120, null, client);

    if (!weatherEvent) {
      return {
        success: false,
        message: 'Failed to create weather event'
      };
    }

    return {
      success: true,
      weatherEvent,
      coordinates: { lat: finalLat, lon: finalLon },
      region: countryData.name
    };
  } catch (error) {
    console.error('[weather] Error creating country weather:', error.message);
    return {
      success: false,
      message: `Error creating weather event: ${error.message}`
    };
  }
}

module.exports = {
  WEATHER_TYPES,
  initializeWeatherSystem,
  generateWeatherEvents,
  getActiveWeather,
  isLocationAffectedBySevereWeather,
  findSafePathAroundWeather,
  getWeatherEffectsForTravel,
  recordWeatherEncounter,
  calculateDistance,
  createWeatherEvent,
  removeWeatherEvent,
  clearAllWeatherEvents,
  createWeatherInCountry
};