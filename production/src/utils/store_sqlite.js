const Database = require('better-sqlite3');
const path = require('path');

// Use different database for different environments
const getDatabasePath = () => {
  const env = process.env.NODE_ENV || 'production';
  if (env === 'development') {
    return path.join(process.cwd(), 'data-dev.sqlite');
  } else if (env === 'test') {
    return path.join(process.cwd(), 'data-test.sqlite');
  } else {
    return path.join(process.cwd(), 'data.sqlite');
  }
};

const db = new Database(getDatabasePath());
db.pragma('journal_mode = WAL');

console.log(`[Database] Using database: ${getDatabasePath()}`);

// Create core tables if they don't exist
try {
  // Servers table
  db.exec(`
    CREATE TABLE IF NOT EXISTS servers (
      guildId TEXT PRIMARY KEY,
      name TEXT,
      lat REAL,
      lon REAL,
      ownerId TEXT,
      addedAt INTEGER,
      lastBossAt INTEGER DEFAULT 0,
      iconUrl TEXT,
      discoverable INTEGER DEFAULT 1,
      archived INTEGER DEFAULT 0,
      archivedAt INTEGER,
      archivedBy TEXT,
      biome TEXT,
      tokens INTEGER DEFAULT 1,
      isBanned INTEGER DEFAULT 0,
      banReason TEXT,
      bannedAt INTEGER
    )
  `);
  
  // Players table
  db.exec(`
    CREATE TABLE IF NOT EXISTS players (
      userId TEXT PRIMARY KEY,
      name TEXT,
      drakari INTEGER DEFAULT 0,
      locationGuildId TEXT,
      travelArrivalAt INTEGER DEFAULT 0,
      travelFromGuildId TEXT,
      travelStartAt INTEGER DEFAULT 0,
      vehicle TEXT,
      health INTEGER DEFAULT 100,
      stamina INTEGER DEFAULT 100,
      staminaUpdatedAt INTEGER DEFAULT 0,
      gems INTEGER DEFAULT 0,
      loginStreak INTEGER DEFAULT 0,
      lastLoginAt INTEGER DEFAULT 0,
      serversVisited INTEGER DEFAULT 0,
      bossKills INTEGER DEFAULT 0,
      itemsCrafted INTEGER DEFAULT 0,
      banned INTEGER DEFAULT 0,
      banReason TEXT,
      bannedAt INTEGER
    )
  `);
  
  // Bosses table
  db.exec(`
    CREATE TABLE IF NOT EXISTS bosses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guildId TEXT,
      name TEXT,
      maxHp INTEGER,
      hp INTEGER,
      startedAt INTEGER,
      expiresAt INTEGER,
      active INTEGER DEFAULT 1,
      tier INTEGER DEFAULT 1
    )
  `);
  
  // Inventory table
  db.exec(`
    CREATE TABLE IF NOT EXISTS inventory (
      userId TEXT,
      itemId TEXT,
      qty INTEGER,
      PRIMARY KEY (userId, itemId)
    )
  `);
  
  // Boss participants table
  db.exec(`
    CREATE TABLE IF NOT EXISTS boss_participants (
      bossId INTEGER,
      userId TEXT,
      damage INTEGER DEFAULT 0,
      PRIMARY KEY (bossId, userId)
    )
  `);
  
  console.log('[db] Core tables initialized');
} catch (e) {
  console.error('[db] Failed to create core tables:', e.message);
}

// Best-effort ALTER for existing DBs
try { db.exec('ALTER TABLE players ADD COLUMN travelStartAt INTEGER DEFAULT 0'); } catch (e) { }
try { db.exec('ALTER TABLE bosses ADD COLUMN tier INTEGER'); } catch (e) { }

module.exports = { db };

// --- Ensure optional columns exist ---
try {
  const cols = db.prepare("PRAGMA table_info(servers)").all().map(c => c.name);
  // Generic tokens for server-level feature unlocks
  if (!cols.includes('tokens')) {
    db.exec("ALTER TABLE servers ADD COLUMN tokens INTEGER DEFAULT 1");
    console.log('[db] Added servers.tokens');
  }
  // Back-compat: migrate any existing biomeChangeTokens into tokens (one-time best-effort)
  if (cols.includes('biomeChangeTokens')) {
    try {
      db.exec("UPDATE servers SET tokens = COALESCE(tokens, biomeChangeTokens, 1)");
      console.log('[db] Migrated biomeChangeTokens -> tokens');
    } catch (e) {
      console.warn('[db] Migration tokens from biomeChangeTokens failed:', e.message);
    }
  }
} catch (e) {
  console.warn('[db] Could not ensure tokens column:', e.message);
}

// --- Ensure ban columns exist ---
try {
  const cols2 = db.prepare("PRAGMA table_info(servers)").all().map(c => c.name);
  if (!cols2.includes('isBanned')) {
    db.exec("ALTER TABLE servers ADD COLUMN isBanned INTEGER DEFAULT 0");
    console.log('[db] Added servers.isBanned');
  }
  if (!cols2.includes('banReason')) {
    db.exec("ALTER TABLE servers ADD COLUMN banReason TEXT");
    console.log('[db] Added servers.banReason');
  }
  if (!cols2.includes('bannedAt')) {
    db.exec("ALTER TABLE servers ADD COLUMN bannedAt INTEGER");
    console.log('[db] Added servers.bannedAt');
  }
} catch (e) {
  console.warn('[db] Could not ensure ban columns:', e.message);
}

// --- Ensure new feature columns exist ---
try {
  const playerCols = db.prepare("PRAGMA table_info(players)").all().map(c => c.name);
  
  // Add gems currency
  if (!playerCols.includes('gems')) {
    db.exec("ALTER TABLE players ADD COLUMN gems INTEGER DEFAULT 0");
    console.log('[db] Added players.gems');
  }
  
  // Add daily login streak
  if (!playerCols.includes('loginStreak')) {
    db.exec("ALTER TABLE players ADD COLUMN loginStreak INTEGER DEFAULT 0");
    console.log('[db] Added players.loginStreak');
  }
  
  // Add last login date
  if (!playerCols.includes('lastLoginAt')) {
    db.exec("ALTER TABLE players ADD COLUMN lastLoginAt INTEGER DEFAULT 0");
    console.log('[db] Added players.lastLoginAt');
  }
  
  // Add total servers visited for achievements
  if (!playerCols.includes('serversVisited')) {
    db.exec("ALTER TABLE players ADD COLUMN serversVisited INTEGER DEFAULT 0");
    console.log('[db] Added players.serversVisited');
  }
  
  // Add total boss kills for achievements
  if (!playerCols.includes('bossKills')) {
    db.exec("ALTER TABLE players ADD COLUMN bossKills INTEGER DEFAULT 0");
    console.log('[db] Added players.bossKills');
  }
  
} catch (e) {
  console.warn('[db] Could not ensure new feature columns:', e.message);
}

// --- Create new feature tables ---
try {
  // Waypoints table
  db.exec(`
    CREATE TABLE IF NOT EXISTS waypoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT NOT NULL,
      name TEXT NOT NULL,
      guildId TEXT NOT NULL,
      serverName TEXT,
      createdAt INTEGER NOT NULL,
      UNIQUE(userId, name)
    )
  `);
  console.log('[db] Ensured waypoints table exists');

  // Travel history table
  db.exec(`
    CREATE TABLE IF NOT EXISTS travel_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT NOT NULL,
      fromGuildId TEXT,
      toGuildId TEXT NOT NULL,
      fromServerName TEXT,
      toServerName TEXT,
      travelTime INTEGER NOT NULL,
      timestamp INTEGER NOT NULL
    )
  `);
  console.log('[db] Ensured travel_history table exists');

  // Achievements table
  db.exec(`
    CREATE TABLE IF NOT EXISTS achievements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT NOT NULL,
      achievementId TEXT NOT NULL,
      unlockedAt INTEGER NOT NULL,
      rewardClaimed INTEGER DEFAULT 0,
      UNIQUE(userId, achievementId)
    )
  `);
  console.log('[db] Ensured achievements table exists');

  // Daily challenges table
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_challenges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT NOT NULL,
      challengeId TEXT NOT NULL,
      progress INTEGER DEFAULT 0,
      target INTEGER NOT NULL,
      completed INTEGER DEFAULT 0,
      rewardClaimed INTEGER DEFAULT 0,
      dateKey TEXT NOT NULL,
      UNIQUE(userId, challengeId, dateKey)
    )
  `);
  console.log('[db] Ensured daily_challenges table exists');

  // Battle analytics table
  db.exec(`
    CREATE TABLE IF NOT EXISTS battle_analytics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT NOT NULL,
      bossId INTEGER,
      damage INTEGER NOT NULL,
      weapon TEXT,
      timestamp INTEGER NOT NULL
    )
  `);
  console.log('[db] Ensured battle_analytics table exists');

  // Premium items table (for premium equipment)
  db.exec(`
    CREATE TABLE IF NOT EXISTS premium_items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      rarity TEXT NOT NULL,
      damage INTEGER DEFAULT 0,
      defense INTEGER DEFAULT 0,
      description TEXT,
      price INTEGER DEFAULT 0,
      premiumOnly INTEGER DEFAULT 1
    )
  `);
  console.log('[db] Ensured premium_items table exists');

  // Gem transactions log table
  db.exec(`
    CREATE TABLE IF NOT EXISTS gem_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT NOT NULL,
      amount INTEGER NOT NULL,
      type TEXT NOT NULL,
      description TEXT,
      timestamp INTEGER NOT NULL
    )
  `);
  console.log('[db] Ensured gem_transactions table exists');

  // Bans table for user ban management
  db.exec(`
    CREATE TABLE IF NOT EXISTS bans (
      userId TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      expiresAt INTEGER,
      bannedAt INTEGER NOT NULL DEFAULT (UNIXEPOCH() * 1000)
    )
  `);
  console.log('[db] Ensured bans table exists');

  // Premium users table for database-based premium status
  db.exec(`
    CREATE TABLE IF NOT EXISTS premium_users (
      userId TEXT PRIMARY KEY,
      expiresAt INTEGER,
      addedAt INTEGER NOT NULL DEFAULT (UNIXEPOCH() * 1000),
      addedBy TEXT,
      notes TEXT
    )
  `);
  console.log('[db] Ensured premium_users table exists');

  // Equipment table for player equipped items
  db.exec(`
    CREATE TABLE IF NOT EXISTS equipment (
      userId TEXT,
      slot TEXT,
      itemId TEXT,
      equippedAt INTEGER NOT NULL DEFAULT (UNIXEPOCH() * 1000),
      PRIMARY KEY (userId, slot)
    )
  `);
  console.log('[db] Ensured equipment table exists');

  // Market listings table for player-to-player trading
  db.exec(`
    CREATE TABLE IF NOT EXISTS market_listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sellerId TEXT NOT NULL,
      itemId TEXT NOT NULL,
      qty INTEGER NOT NULL,
      price INTEGER NOT NULL,
      expiresAt INTEGER NOT NULL,
      createdAt INTEGER NOT NULL DEFAULT (UNIXEPOCH() * 1000)
    )
  `);
  console.log('[db] Ensured market_listings table exists');

  // POIs (Points of Interest) table for famous landmarks
  db.exec(`
    CREATE TABLE IF NOT EXISTS pois (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      country TEXT,
      category TEXT NOT NULL,
      emoji TEXT,
      discoveryReward INTEGER DEFAULT 100,
      visitCost INTEGER DEFAULT 50,
      createdAt INTEGER NOT NULL
    )
  `);
  console.log('[db] Ensured pois table exists');

  // POI visits tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS poi_visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT NOT NULL,
      poiId TEXT NOT NULL,
      visitedAt INTEGER NOT NULL,
      isFirstVisit INTEGER DEFAULT 0,
      UNIQUE(userId, poiId),
      FOREIGN KEY (poiId) REFERENCES pois(id)
    )
  `);
  console.log('[db] Ensured poi_visits table exists');

} catch (e) {
  console.warn('[db] Could not create new feature tables:', e.message);
}

