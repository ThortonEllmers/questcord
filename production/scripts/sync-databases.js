#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

console.log('🔄 Syncing databases...');

const prodDb = path.join(process.cwd(), 'data.sqlite');
const devDb = path.join(process.cwd(), 'data-dev.sqlite');

// Check if production database exists
if (!fs.existsSync(prodDb)) {
    console.error('❌ Production database not found!');
    process.exit(1);
}

// Create backup of development database if it exists
if (fs.existsSync(devDb)) {
    const backupPath = `${devDb}.backup.${Date.now()}`;
    fs.copyFileSync(devDb, backupPath);
    console.log(`📁 Development database backed up to: ${backupPath}`);
}

// Copy production to development
fs.copyFileSync(prodDb, devDb);

console.log('✅ Production database copied to development');

// Verify the sync
const Database = require('better-sqlite3');

const prodHandle = new Database(prodDb, { readonly: true });
const devHandle = new Database(devDb, { readonly: true });

const prodPlayers = prodHandle.prepare('SELECT COUNT(*) as count FROM players').get();
const devPlayers = devHandle.prepare('SELECT COUNT(*) as count FROM players').get();

const prodServers = prodHandle.prepare('SELECT COUNT(*) as count FROM servers').get();
const devServers = devHandle.prepare('SELECT COUNT(*) as count FROM servers').get();

prodHandle.close();
devHandle.close();

console.log('\n=== VERIFICATION ===');
console.log(`Production: ${prodPlayers.count} players, ${prodServers.count} servers`);
console.log(`Development: ${devPlayers.count} players, ${devServers.count} servers`);

if (prodPlayers.count === devPlayers.count && prodServers.count === devServers.count) {
    console.log('🎉 Databases are now synchronized!');
} else {
    console.log('❌ Sync verification failed');
    process.exit(1);
}