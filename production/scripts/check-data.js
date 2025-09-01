#!/usr/bin/env node

const Database = require('better-sqlite3');
const db = new Database('data.sqlite');

console.log('=== DETAILED DATABASE INSPECTION ===');

// Check players table
console.log('\n📊 PLAYERS TABLE:');
const players = db.prepare('SELECT * FROM players').all();
console.log('Total players:', players.length);

if (players.length > 0) {
    players.forEach((player, i) => {
        console.log(`Player ${i+1}:`);
        console.log(`  Discord ID: ${player.discordId}`);
        console.log(`  Username: ${player.username || 'N/A'}`);
        console.log(`  Level: ${player.level || 0}`);
        console.log(`  XP: ${player.xp || 0}`);
        console.log(`  Health: ${player.health || 0}/${player.maxHealth || 0}`);
        console.log(`  Gold: ${player.gold || 0}`);
        console.log(`  Location: ${player.lat || 'N/A'}, ${player.lon || 'N/A'}`);
        console.log('  ---');
    });
} else {
    console.log('❌ NO PLAYER DATA FOUND!');
}

// Check servers table  
console.log('\n🌍 SERVERS TABLE:');
const servers = db.prepare('SELECT * FROM servers').all();
console.log('Total servers:', servers.length);

if (servers.length > 0) {
    servers.forEach((server, i) => {
        console.log(`Server ${i+1}:`);
        console.log(`  Guild ID: ${server.guildId}`);
        console.log(`  Name: ${server.name || 'N/A'}`);
        console.log(`  Location: ${server.lat}, ${server.lon}`);
        console.log(`  Owner: ${server.ownerId || 'N/A'}`);
        console.log('  ---');
    });
}

// Check if specific user exists
console.log('\n🔍 CHECKING FOR YOUR USER (378501056008683530):');
const yourPlayer = db.prepare('SELECT * FROM players WHERE discordId = ?').get('378501056008683530');
if (yourPlayer) {
    console.log('✅ Found your player data:', yourPlayer);
} else {
    console.log('❌ Your player data NOT found!');
}

// Check inventory
console.log('\n🎒 INVENTORY SAMPLE:');
const inventoryCount = db.prepare('SELECT COUNT(*) as count FROM inventory').get().count;
console.log('Total inventory items:', inventoryCount);

if (inventoryCount > 0) {
    const sampleItems = db.prepare('SELECT * FROM inventory LIMIT 3').all();
    sampleItems.forEach(item => {
        console.log(`  Item: ${item.itemId} x${item.quantity} (Player: ${item.playerId})`);
    });
}

// Check if we have the right database structure
console.log('\n🏗️  TABLE STRUCTURE CHECK:');
const tableInfo = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Available tables:', tableInfo.map(t => t.name).join(', '));

db.close();