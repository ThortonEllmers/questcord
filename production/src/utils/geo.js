function deg2rad(d) { return d * Math.PI / 180; }
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371; // km
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function placeOnSpiral(i, center = { lat: 0, lon: 0 }) {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const r = 0.5 * Math.sqrt(i); // spread
  const t = i * golden;
  return { lat: center.lat + r * Math.sin(t), lon: center.lon + r * Math.cos(t) };
}

// Safe fetch helper
async function fetchSafe(...args) {
  if (typeof globalThis.fetch === 'function') return globalThis.fetch(...args);
  const mod = await import('node-fetch');
  return mod.default(...args);
}

// Check if coordinates are on land using multiple methods
async function isOnLand(lat, lon) {
  // console.log(`🗺️  Checking land status for ${lat.toFixed(4)}, ${lon.toFixed(4)}`); // Disabled to reduce spam
  
  // First try accurate coordinate-based detection
  const coordinateBased = isLandByCoordinates(lat, lon);
  // console.log(`📍 Coordinate-based detection: ${coordinateBased ? 'LAND' : 'WATER'}`); // Disabled to reduce spam
  
  // If coordinates suggest water, return false immediately
  if (!coordinateBased) {
    console.log(`🌊 Position determined to be in water by coordinates`);
    return false;
  }
  
  // If coordinates suggest land, double-check with elevation API
  try {
    const url = `https://api.open-elevation.com/api/v1/lookup?locations=${lat},${lon}`;
    const response = await fetchSafe(url, { timeout: 3000 });
    
    if (response.ok) {
      const data = await response.json();
      const elevation = data.results?.[0]?.elevation;
      
      // console.log(`🏔️  Elevation: ${elevation}m`); // Disabled to reduce spam
      
      // More sophisticated elevation analysis
      if (typeof elevation === 'number') {
        // Water bodies typically have elevation very close to 0 (sea level)
        // But some lakes can be above sea level, so we need more nuanced logic
        
        // If elevation is significantly negative, it's likely a deep water body
        if (elevation < -50) {
          console.log(`🌊 Deep water detected (elevation ${elevation}m)`);
          return false;
        }
        
        // If elevation is exactly 0 or very close to 0, might be ocean/sea
        // But also consider lakes at sea level, so use coordinate data as primary
        if (Math.abs(elevation) <= 2) {
          console.log(`🌊 Near sea level (${elevation}m), trusting coordinate detection: ${coordinateBased ? 'LAND' : 'WATER'}`);
          return coordinateBased; // Trust coordinate-based detection more
        }
        
        // If elevation is positive, likely land
        const isLand = elevation > 2;
        // console.log(`🏞️  Elevation suggests: ${isLand ? 'LAND' : 'WATER'}`); // Disabled to reduce spam
        return isLand;
      }
    } else {
      console.log(`❌ Elevation API returned ${response.status}`);
    }
  } catch (error) {
    console.warn('🚨 Elevation API failed, using coordinate-based detection:', error.message);
  }
  
  // Fallback to coordinate-based result
  console.log(`✅ Final result: ${coordinateBased ? 'LAND' : 'WATER'} (coordinate-based)`);
  return coordinateBased;
}

// Accurate coordinate-based land detection using precise boundaries
function isLandByCoordinates(lat, lon) {
  // Avoid polar regions (mostly ice/water)
  if (Math.abs(lat) > 78) return false;
  
  // Define major ocean areas with precise boundaries
  const oceanAreas = [
    // Pacific Ocean - Central/Eastern  
    { latMin: -60, latMax: 65, lonMin: -180, lonMax: -100, name: "Eastern Pacific" },
    { latMin: -60, latMax: 65, lonMin: 140, lonMax: 165, name: "Western Pacific" }, // Exclude NZ area
    
    // Atlantic Ocean - Central
    { latMin: -60, latMax: 70, lonMin: -65, lonMax: -10, name: "Central Atlantic" },
    
    // Indian Ocean - Central
    { latMin: -50, latMax: 30, lonMin: 45, lonMax: 100, name: "Central Indian" },
    
    // Arctic Ocean
    { latMin: 78, latMax: 90, lonMin: -180, lonMax: 180, name: "Arctic" },
    
    // Southern Ocean
    { latMin: -90, latMax: -60, lonMin: -180, lonMax: 180, name: "Southern" },
    
    // Specific problem areas
    // Mediterranean gaps
    { latMin: 30, latMax: 46, lonMin: -6, lonMax: 36, name: "Mediterranean", 
      exceptions: [
        // Spain/Portugal
        { latMin: 35, latMax: 44, lonMin: -10, lonMax: -6 },
        // Italy
        { latMin: 36, latMax: 47, lonMin: 6, lonMax: 19 },
        // Balkans
        { latMin: 39, latMax: 47, lonMin: 13, lonMax: 30 },
        // Turkey
        { latMin: 36, latMax: 42, lonMin: 26, lonMax: 45 }
      ]
    },
    
    // Caribbean/Gulf of Mexico
    { latMin: 10, latMax: 30, lonMin: -100, lonMax: -60, name: "Caribbean",
      exceptions: [
        // Florida/Cuba area
        { latMin: 20, latMax: 28, lonMin: -85, lonMax: -79 },
        // Caribbean islands
        { latMin: 10, latMax: 25, lonMin: -85, lonMax: -60 }
      ]
    },
    
    // Red Sea/Persian Gulf area
    { latMin: 12, latMax: 32, lonMin: 32, lonMax: 58, name: "Red Sea/Persian Gulf",
      exceptions: [
        // Saudi Arabia/Middle East
        { latMin: 15, latMax: 33, lonMin: 34, lonMax: 56 }
      ]
    }
  ];
  
  // Check if point is in any ocean area
  for (const ocean of oceanAreas) {
    if (lat >= ocean.latMin && lat <= ocean.latMax && 
        lon >= ocean.lonMin && lon <= ocean.lonMax) {
      
      // Check if it's in an exception (land) area within this ocean zone
      if (ocean.exceptions) {
        for (const exception of ocean.exceptions) {
          if (lat >= exception.latMin && lat <= exception.latMax && 
              lon >= exception.lonMin && lon <= exception.lonMax) {
            return true; // It's in an exception area (land)
          }
        }
      }
      
      return false; // It's in ocean
    }
  }
  
  // Define major continental areas (definitely land)
  const continentalAreas = [
    // North America mainland
    { latMin: 25, latMax: 75, lonMin: -170, lonMax: -50 },
    
    // South America
    { latMin: -55, latMax: 15, lonMin: -82, lonMax: -35 },
    
    // Europe/Asia
    { latMin: 35, latMax: 75, lonMin: -10, lonMax: 180 },
    { latMin: -10, latMax: 35, lonMin: 60, lonMax: 180 }, // Asia extends south
    
    // Africa
    { latMin: -35, latMax: 37, lonMin: -18, lonMax: 52 },
    
    // Australia
    { latMin: -45, latMax: -10, lonMin: 112, lonMax: 155 },
    
    // New Zealand (both North and South Islands)
    { latMin: -47, latMax: -34, lonMin: 166, lonMax: 179 }
  ];
  
  // Check if in major continental area
  for (const continent of continentalAreas) {
    if (lat >= continent.latMin && lat <= continent.latMax && 
        lon >= continent.lonMin && lon <= continent.lonMax) {
      return true;
    }
  }
  
  // If not in ocean or continental area, it might be an island
  // Use conservative approach - assume water unless proven otherwise
  return false;
}

// Find a land-based position using spiral search
async function findLandPosition(startLat = 0, startLon = 0, maxAttempts = 100) {
  // First check if starting position is already on land
  if (await isOnLand(startLat, startLon)) {
    return { lat: startLat, lon: startLon };
  }
  
  console.log(`Searching for land position near ${startLat}, ${startLon}`);
  
  // Search in expanding spiral pattern with larger radius
  for (let i = 1; i <= maxAttempts; i++) {
    const pos = placeOnSpiral(i, { lat: startLat, lon: startLon });
    
    // Increase search radius for better coverage
    const searchRadius = 1.5; // Increased from default 0.5
    pos.lat = startLat + searchRadius * Math.sqrt(i) * Math.sin(i * Math.PI * (3 - Math.sqrt(5)));
    pos.lon = startLon + searchRadius * Math.sqrt(i) * Math.cos(i * Math.PI * (3 - Math.sqrt(5)));
    
    // Clamp to valid coordinate ranges
    pos.lat = Math.max(-85, Math.min(85, pos.lat));
    pos.lon = Math.max(-180, Math.min(180, pos.lon));
    
    if (await isOnLand(pos.lat, pos.lon)) {
      console.log(`Found land position at ${pos.lat}, ${pos.lon} after ${i} attempts`);
      return pos;
    }
    
    // Add small delay to avoid overwhelming the API
    if (i % 10 === 0) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  
  // Country-specific fallbacks for known problematic areas
  const countryFallbacks = {
    // New Zealand fallbacks (Wellington area)
    nz: [{ lat: -41.2865, lon: 174.7762 }, { lat: -36.8485, lon: 174.7633 }],
    // Australia fallbacks
    au: [{ lat: -33.8688, lon: 151.2093 }, { lat: -37.8136, lon: 144.9631 }],
    // Japan fallbacks
    jp: [{ lat: 35.6762, lon: 139.6503 }, { lat: 34.6937, lon: 135.5023 }]
  };
  
  // Try region-specific fallbacks first
  if (startLat < -30 && startLon > 160) { // Oceania region
    for (const fallback of countryFallbacks.nz) {
      if (await isOnLand(fallback.lat, fallback.lon)) {
        console.log(`Using New Zealand fallback: ${fallback.lat}, ${fallback.lon}`);
        return fallback;
      }
    }
  }
  
  // Try global cities as fallbacks to avoid stacking
  const cityFallbacks = [
    { lat: 40.7128, lon: -74.0060, name: "New York" },
    { lat: 51.5074, lon: -0.1278, name: "London" },
    { lat: 35.6762, lon: 139.6503, name: "Tokyo" },
    { lat: -33.8688, lon: 151.2093, name: "Sydney" },
    { lat: 48.8566, lon: 2.3522, name: "Paris" },
    { lat: -23.5505, lon: -46.6333, name: "São Paulo" },
    { lat: 28.6139, lon: 77.2090, name: "Delhi" },
    { lat: -26.2041, lon: 28.0473, name: "Johannesburg" }
  ];
  
  for (const city of cityFallbacks) {
    if (await isOnLand(city.lat, city.lon)) {
      console.log(`🌍 Using city fallback: ${city.name}`);
      return city;
    }
  }
  
  // Emergency fallback to Auckland, New Zealand
  const fallback = { lat: -36.8485, lon: 174.7633 };
  console.warn('🚨 Using emergency Auckland fallback:', fallback);
  return fallback;
}

// Check if a position collides with existing servers
function isPositionTooClose(lat, lon, existingServers, minDistanceKm = 50) {
  for (const server of existingServers) {
    if (server.lat != null && server.lon != null) {
      const distance = haversine(lat, lon, server.lat, server.lon);
      if (distance < minDistanceKm) {
        return true;
      }
    }
  }
  return false;
}

// Find a random global land position that doesn't collide with existing servers
async function findNonCollidingLandPosition(startLat = 0, startLon = 0, db, maxAttempts = 100) {
  // Get existing server positions for collision detection
  const existingServers = db.prepare(`
    SELECT lat, lon FROM servers 
    WHERE lat IS NOT NULL AND lon IS NOT NULL AND archived = 0
  `).all();
  
  console.log(`🌍 Finding random global land position avoiding ${existingServers.length} existing servers`);
  
  // Define global land regions for random selection
  const globalLandRegions = [
    // North America
    { latMin: 25, latMax: 70, lonMin: -170, lonMax: -50, weight: 3, name: "North America" },
    
    // South America  
    { latMin: -55, latMax: 15, lonMin: -82, lonMax: -35, weight: 2, name: "South America" },
    
    // Europe
    { latMin: 35, latMax: 75, lonMin: -10, lonMax: 50, weight: 2, name: "Europe" },
    
    // Asia - Western/Central
    { latMin: 15, latMax: 75, lonMin: 50, lonMax: 140, weight: 4, name: "Western Asia" },
    
    // Asia - Eastern (China, Japan, Korea)
    { latMin: 20, latMax: 55, lonMin: 100, lonMax: 145, weight: 3, name: "Eastern Asia" },
    
    // Asia - Southeast (Indonesia, Philippines, etc)
    { latMin: -11, latMax: 25, lonMin: 95, lonMax: 145, weight: 2, name: "Southeast Asia" },
    
    // Africa
    { latMin: -35, latMax: 37, lonMin: -18, lonMax: 52, weight: 3, name: "Africa" },
    
    // Australia/Oceania
    { latMin: -50, latMax: -10, lonMin: 110, lonMax: 180, weight: 1, name: "Australia/Oceania" }
  ];
  
  // Create weighted region selection
  const weightedRegions = [];
  globalLandRegions.forEach(region => {
    for (let i = 0; i < region.weight; i++) {
      weightedRegions.push(region);
    }
  });
  
  // Try random positions across different regions
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Select random region (weighted)
    const region = weightedRegions[Math.floor(Math.random() * weightedRegions.length)];
    
    // Generate random position within region
    const randomLat = region.latMin + Math.random() * (region.latMax - region.latMin);
    const randomLon = region.lonMin + Math.random() * (region.lonMax - region.lonMin);
    
    console.log(`🎲 Attempt ${attempt}: Trying ${region.name} at ${randomLat.toFixed(4)}, ${randomLon.toFixed(4)}`);
    
    // Check if position is valid (on land and not too close to others)
    if (await isOnLand(randomLat, randomLon) && 
        !isPositionTooClose(randomLat, randomLon, existingServers)) {
      console.log(`🎯 Found random global land position in ${region.name}: ${randomLat}, ${randomLon} after ${attempt} attempts`);
      return { lat: randomLat, lon: randomLon };
    }
    
    // Add delay every 10 attempts to avoid overwhelming APIs
    if (attempt % 10 === 0) {
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
  
  // If we can't find a random spot, try global city fallbacks with collision detection
  const globalCityFallbacks = [
    // North America
    { lat: 40.7128, lon: -74.0060, name: "New York" },
    { lat: 34.0522, lon: -118.2437, name: "Los Angeles" },
    { lat: 41.8781, lon: -87.6298, name: "Chicago" },
    { lat: 45.5017, lon: -73.5673, name: "Montreal" },
    { lat: 29.7604, lon: -95.3698, name: "Houston" },
    
    // South America
    { lat: -23.5505, lon: -46.6333, name: "São Paulo" },
    { lat: -34.6037, lon: -58.3816, name: "Buenos Aires" },
    { lat: -25.2637, lon: -57.5759, name: "Asunción" },
    
    // Europe
    { lat: 51.5074, lon: -0.1278, name: "London" },
    { lat: 48.8566, lon: 2.3522, name: "Paris" },
    { lat: 52.5200, lon: 13.4050, name: "Berlin" },
    { lat: 55.7558, lon: 37.6173, name: "Moscow" },
    { lat: 41.9028, lon: 12.4964, name: "Rome" },
    
    // Asia
    { lat: 35.6762, lon: 139.6503, name: "Tokyo" },
    { lat: 39.9042, lon: 116.4074, name: "Beijing" },
    { lat: 28.6139, lon: 77.2090, name: "Delhi" },
    { lat: 1.3521, lon: 103.8198, name: "Singapore" },
    { lat: 31.2304, lon: 121.4737, name: "Shanghai" },
    
    // Africa  
    { lat: -26.2041, lon: 28.0473, name: "Johannesburg" },
    { lat: 30.0444, lon: 31.2357, name: "Cairo" },
    { lat: -1.2921, lon: 36.8219, name: "Nairobi" },
    
    // Australia/Oceania
    { lat: -33.8688, lon: 151.2093, name: "Sydney" },
    { lat: -37.8136, lon: 144.9631, name: "Melbourne" },
    { lat: -36.8485, lon: 174.7633, name: "Auckland" }
  ];
  
  for (const fallback of globalCityFallbacks) {
    if (await isOnLand(fallback.lat, fallback.lon) && 
        !isPositionTooClose(fallback.lat, fallback.lon, existingServers, 25)) {
      console.log(`🏙️  Using global city fallback: ${fallback.name} (${fallback.lat}, ${fallback.lon})`);
      return fallback;
    }
  }
  
  // Final emergency fallback - random position around a major city
  const emergencyBase = globalCityFallbacks[Math.floor(Math.random() * globalCityFallbacks.length)];
  const emergencyFallback = { 
    lat: emergencyBase.lat + (Math.random() - 0.5) * 5,  // ±2.5 degrees 
    lon: emergencyBase.lon + (Math.random() - 0.5) * 5 
  };
  console.warn(`🚨 Using emergency random fallback near ${emergencyBase.name}:`, emergencyFallback);
  return emergencyFallback;
}

// Check and fix servers that are in water
async function checkAndFixWaterServers(db) {
  try {
    // console.log('🌊 Checking for servers in water...'); // Disabled to reduce spam
    
    // Get all servers with coordinates
    const servers = db.prepare(`
      SELECT guildId, name, lat, lon 
      FROM servers 
      WHERE lat IS NOT NULL AND lon IS NOT NULL AND archived = 0
    `).all();
    
    // console.log(`Found ${servers.length} servers to check`); // Disabled to reduce spam
    
    let fixedCount = 0;
    const batchSize = 5; // Process in batches to avoid overwhelming APIs
    
    for (let i = 0; i < servers.length; i += batchSize) {
      const batch = servers.slice(i, i + batchSize);
      
      await Promise.all(batch.map(async (server) => {
        try {
          const isLand = await isOnLand(server.lat, server.lon);
          
          if (!isLand) {
            console.log(`🏊 Server "${server.name}" (${server.guildId}) is in water at ${server.lat}, ${server.lon}`);
            
            // Find nearest land position
            const landPosition = await findLandPosition(server.lat, server.lon, 50);
            
            // Update server position
            db.prepare(`
              UPDATE servers 
              SET lat = ?, lon = ? 
              WHERE guildId = ?
            `).run(landPosition.lat, landPosition.lon, server.guildId);
            
            console.log(`🏝️  Moved "${server.name}" to land at ${landPosition.lat}, ${landPosition.lon}`);
            fixedCount++;
            
          } else {
            // console.log(`✅ Server "${server.name}" is already on land`); // Disabled to reduce spam
          }
        } catch (error) {
          console.warn(`❌ Failed to check server ${server.guildId}: ${error.message}`);
        }
      }));
      
      // Small delay between batches to be respectful to APIs
      if (i + batchSize < servers.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    if (fixedCount > 0) {
      console.log(`🎉 Fixed ${fixedCount} servers that were in water`);
    } else {
      console.log('✨ All servers are already on land!');
    }
    
    return { total: servers.length, fixed: fixedCount };
    
  } catch (error) {
    console.error('❌ Error during water check:', error);
    throw error;
  }
}

module.exports = { 
  haversine, 
  placeOnSpiral, 
  isOnLand, 
  isLandByCoordinates,
  findLandPosition,
  checkAndFixWaterServers,
  isPositionTooClose,
  findNonCollidingLandPosition
};
