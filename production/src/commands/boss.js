const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { db } = require('../utils/store_sqlite');
const config = require('../utils/config');
const { getUserPrefix, isStaffOrDev, isPremium } = require('../utils/roles');
const { isBanned, regenStamina } = require('./_guard');
const logger = require('../utils/logger');
const { itemById, rarityMult, pickLootByTier } = require('../utils/items');
const { awardBossParticipationGems } = require('../utils/gems');
const { checkBossAchievements } = require('../utils/achievements');

const BOSS_FIGHTER_ROLE_ID = '1411043105830076497';
const BOSS_NOTIFICATION_CHANNEL_ID = '1411045103921004554';

function choose(arr) { 
  return arr[Math.floor(Math.random() * arr.length)]; 
}

function nameForBiome(biome) {
  const map = config.boss?.names || {};
  const list = (biome && map[biome]) || map._default || ['Ancient Beast'];
  return choose(list);
}

function randomTier() {
  const chances = config.boss?.tierChances || { 1: 40, 2: 25, 3: 20, 4: 10, 5: 5 };
  const maxTier = config.boss?.maxTier || 5;
  
  // Create weighted array
  const weighted = [];
  for (let tier = 1; tier <= maxTier; tier++) {
    const chance = chances[tier] || 0;
    for (let i = 0; i < chance; i++) {
      weighted.push(tier);
    }
  }
  
  return weighted[Math.floor(Math.random() * weighted.length)] || 1;
}

function equippedWeapon(userId) {
  const row = db.prepare('SELECT itemId FROM equipment WHERE userId=? AND slot=?').get(userId, 'weapon');
  if (!row) return null;
  const it = itemById(row.itemId);
  return it || null;
}

async function assignBossFighterRole(interaction, userId) {
  try {
    const guild = interaction.guild;
    if (!guild) return;
    
    const member = await guild.members.fetch(userId);
    if (!member) return;
    
    const role = guild.roles.cache.get(BOSS_FIGHTER_ROLE_ID);
    if (!role) {
      console.warn('[boss] Boss fighter role not found:', BOSS_FIGHTER_ROLE_ID);
      return;
    }
    
    if (!member.roles.cache.has(BOSS_FIGHTER_ROLE_ID)) {
      await member.roles.add(role);
      logger.info('boss_role: Added boss fighter role to user %s in guild %s', userId, guild.id);
    }
  } catch (error) {
    console.warn('[boss] Failed to assign boss fighter role:', error.message);
  }
}

async function removeBossFighterRole(client, userId, guildId) {
  try {
    const guild = await client.guilds.fetch(guildId);
    if (!guild) return;
    
    const member = await guild.members.fetch(userId);
    if (!member) return;
    
    const role = guild.roles.cache.get(BOSS_FIGHTER_ROLE_ID);
    if (!role) return;
    
    if (member.roles.cache.has(BOSS_FIGHTER_ROLE_ID)) {
      // Check if user still has active boss participations in ANY guild
      const activeParticipations = db.prepare(`
        SELECT COUNT(*) as count 
        FROM boss_participants bp 
        JOIN bosses b ON bp.bossId = b.id 
        WHERE bp.userId = ? AND b.active = 1 AND b.expiresAt > ?
      `).get(userId, Date.now());
      
      // Only remove role if user has no active boss fights remaining
      if (activeParticipations.count === 0) {
        await member.roles.remove(role);
        logger.info('boss_role: Removed boss fighter role from user %s in guild %s (no active fights)', userId, guildId);
      } else {
        logger.info('boss_role: Kept boss fighter role for user %s in guild %s (%s active fights)', userId, guildId, activeParticipations.count);
      }
    }
  } catch (error) {
    console.warn('[boss] Failed to remove boss fighter role:', error.message);
  }
}

async function sendBossSpawnNotification(client, bossData, serverData, spawnerUser) {
  try {
    const channel = await client.channels.fetch(BOSS_NOTIFICATION_CHANNEL_ID);
    if (!channel) {
      console.warn('[boss] Boss notification channel not found:', BOSS_NOTIFICATION_CHANNEL_ID);
      return;
    }
    
    const tierEmojis = {
      1: '🟠', 2: '🟡', 3: '🔴', 4: '🟣', 5: '⚫'
    };
    
    const tierNames = {
      1: 'Novice', 2: 'Veteran', 3: 'Elite', 4: 'Legendary', 5: 'Mythic'
    };
    
    const spawnEmbed = new EmbedBuilder()
      .setTitle('🚨 **BOSS SPAWNED** 🚨')
      .setDescription(`${tierEmojis[bossData.tier]} **${bossData.name}** has emerged from the shadows!`)
      .setColor(bossData.tier >= 5 ? 0x8b0000 : bossData.tier >= 3 ? 0xff4444 : bossData.tier >= 2 ? 0xff8c00 : 0xff6b35)
      .addFields(
        {
          name: '👹 Boss Details',
          value: `**Name:** ${bossData.name}\n**Tier:** ${bossData.tier} (${tierNames[bossData.tier] || 'Unknown'})\n**Health:** ${bossData.maxHp.toLocaleString()} HP`,
          inline: true
        },
        {
          name: '📍 Location',
          value: `**Server:** ${serverData.name || serverData.guildId}\n**Guild ID:** ${serverData.guildId}`,
          inline: true
        },
        {
          name: '⏰ Battle Info',
          value: `**Duration:** ${Math.floor((config.boss?.ttlSeconds||3600)/60)} minutes\n**Spawned by:** ${spawnerUser.username}\n**Spawned at:** <t:${Math.floor(Date.now()/1000)}:F>`,
          inline: false
        }
      )
      .setFooter({ 
        text: '⚔️ Use /boss attack to join the battle! • QuestCord Boss Alert',
        iconURL: client.user.displayAvatarURL()
      })
      .setTimestamp();
    
    const message = await channel.send({ 
      embeds: [spawnEmbed],
      content: `<@&1411051374153826386> A **Tier ${bossData.tier} Boss** has spawned! 🔥⚔️`
    });
    
    // Add reactions to the notification
    await message.react('⚔️');
    await message.react('🔥');
    await message.react(tierEmojis[bossData.tier]);
    
    logger.info('boss_notification: Sent spawn notification for %s (tier %s) in %s', bossData.name, bossData.tier, serverData.guildId);
  } catch (error) {
    console.warn('[boss] Failed to send boss spawn notification:', error.message);
  }
}

async function sendBossDefeatNotification(client, bossData, serverData, participants, battleDuration) {
  try {
    const channel = await client.channels.fetch(BOSS_NOTIFICATION_CHANNEL_ID);
    if (!channel) return;
    
    const tierEmojis = {
      1: '🟠', 2: '🟡', 3: '🔴', 4: '🟣', 5: '⚫'
    };
    
    const tierNames = {
      1: 'Novice', 2: 'Veteran', 3: 'Elite', 4: 'Legendary', 5: 'Mythic'
    };
    
    // Calculate total damage dealt
    const totalDamage = participants.reduce((sum, p) => sum + p.damage, 0);
    
    // Find top 3 damage dealers
    const topDamagers = [...participants]
      .sort((a, b) => b.damage - a.damage)
      .slice(0, 3);
    
    const victoryEmbed = new EmbedBuilder()
      .setTitle('🏆 **BOSS DEFEATED** 🏆')
      .setDescription(`${tierEmojis[bossData.tier]} **${bossData.name}** has been vanquished by ${participants.length} brave warriors!`)
      .setColor(0xFFD700)
      .addFields(
        {
          name: '👹 Boss Stats',
          value: `**Name:** ${bossData.name}\n**Tier:** ${bossData.tier} (${tierNames[bossData.tier] || 'Unknown'})\n**Max Health:** ${bossData.maxHp.toLocaleString()} HP`,
          inline: true
        },
        {
          name: '📊 Battle Stats',
          value: `**Participants:** ${participants.length}\n**Total Damage:** ${totalDamage.toLocaleString()}\n**Duration:** ${Math.floor(battleDuration / 60000)}m ${Math.floor((battleDuration % 60000) / 1000)}s`,
          inline: true
        },
        {
          name: '🏅 Top Damage Dealers',
          value: topDamagers.map((p, i) => {
            const medals = ['🥇', '🥈', '🥉'];
            const percentage = Math.round((p.damage / totalDamage) * 100);
            return `${medals[i]} <@${p.userId}> - ${p.damage.toLocaleString()} (${percentage}%)`;
          }).join('\n') || 'No damage recorded',
          inline: false
        },
        {
          name: '💰 Rewards Distributed',
          value: `**${config.currencyName || 'Drakari'}:** ${50*(bossData.tier||1)} per participant\n**Items:** 3-5 Tier ${bossData.tier} items per participant\n**Location:** ${serverData.name || serverData.guildId}`,
          inline: false
        }
      )
      .setFooter({ 
        text: '🌟 Victory achieved through teamwork! • QuestCord Boss Victory',
        iconURL: client.user.displayAvatarURL()
      })
      .setTimestamp();
    
    const message = await channel.send({ 
      embeds: [victoryEmbed],
      content: `🎉 **VICTORY!** The **Tier ${bossData.tier} ${bossData.name}** has been defeated! 🎉`
    });
    
    // Add victory reactions
    await message.react('🎉');
    await message.react('🏆');
    await message.react('⚔️');
    await message.react('💰');
    
    logger.info('boss_notification: Sent defeat notification for %s (tier %s) with %s participants', bossData.name, bossData.tier, participants.length);
  } catch (error) {
    console.warn('[boss] Failed to send boss defeat notification:', error.message);
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('boss')
    .setDescription('Boss actions')
    .addSubcommand(sc => sc.setName('status').setDescription('Show active boss at your location'))
    .addSubcommand(sc => sc.setName('attack').setDescription('Attack the boss at your location (must be visiting)'))
    .addSubcommand(sc => sc.setName('spawn').setDescription('Force spawn a boss (staff/dev only)')
      .addStringOption(option => option.setName('serverid').setDescription('Server ID (optional - defaults to current server)').setRequired(false))),
  async execute(interaction) {
    const userPrefix = await getUserPrefix(interaction.client, interaction.user);
    if (isBanned(interaction.user.id)) return interaction.reply({ content: `${userPrefix} You are banned from using this bot.`, flags: 64 });
    regenStamina(interaction.user.id);
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    const player = db.prepare('SELECT * FROM players WHERE userId=?').get(userId);
    const location = (player && player.locationGuildId) || interaction.guild.id;
    const here = db.prepare('SELECT * FROM servers WHERE guildId=? AND archived=0').get(location);

    if (sub === 'spawn') {
      if (!(await isStaffOrDev(interaction.client, userId))) return interaction.reply({ content: `${userPrefix} Staff/Developer only.`, flags: 64 });
      
      // Get target server - use provided serverid or default to current location
      const targetServerId = interaction.options.getString('serverid');
      let targetServer;
      
      if (targetServerId) {
        targetServer = db.prepare('SELECT * FROM servers WHERE guildId=? AND archived=0').get(targetServerId);
        if (!targetServer) {
          return interaction.reply({ content: `${userPrefix} Server ID ${targetServerId} not found or is archived.`, flags: 64 });
        }
      } else {
        targetServer = here;
      }
      
      if (!targetServer || targetServer.lat == null) return interaction.reply({ content: `${userPrefix} Target server has no coordinates yet.`, flags: 64 });
      if (process.env.SPAWN_GUILD_ID && targetServer.guildId === process.env.SPAWN_GUILD_ID) {
        return interaction.reply({ content: `${userPrefix} Bosses cannot spawn in the spawn server.`, flags: 64 });
      }

      // Check global boss limit (max 10 active bosses)
      const activeBossCount = db.prepare('SELECT COUNT(*) as count FROM bosses WHERE active=1 AND expiresAt > ?').get(Date.now()).count;
      if (activeBossCount >= 10) {
        return interaction.reply({ 
          content: `${userPrefix} **Global boss limit reached!** There are already **10 active bosses** worldwide. Wait for some to be defeated or expire before spawning new ones.`, 
          flags: 64 
        });
      }

      // Check server eligibility (1 in 3 servers can have bosses based on guild ID hash)
      const serverHash = parseInt(targetServer.guildId.slice(-8), 16); // Use last 8 chars of guild ID as hash
      const serverEligible = (serverHash % 3) === 0; // 1 in 3 servers eligible

      if (!serverEligible) {
        return interaction.reply({ 
          content: `${userPrefix} **Target server is not eligible for boss spawns.** Only 1 in 3 servers can host bosses to maintain balanced distribution across the network.`, 
          flags: 64 
        });
      }

      const now = Date.now();
      const cd = (config.boss?.cooldownSeconds || 0) * 1000;
      if (targetServer.lastBossAt && now - targetServer.lastBossAt < cd) {
        return interaction.reply({ content: `${userPrefix} Target server is on boss cooldown.`, flags: 64 });
      }
      const name = nameForBiome(targetServer.biome);
      const tier = randomTier();
      const hp = Math.floor((config.boss?.baseHp || 2000) * (1 + (tier - 1) * 0.2));
      const expires = now + (config.boss?.ttlSeconds || 3600) * 1000;
      db.prepare('INSERT INTO bosses(guildId, name, maxHp, hp, startedAt, expiresAt, active, tier) VALUES(?,?,?,?,?,?,1,?)').run(targetServer.guildId, name, hp, hp, now, expires, tier);
      db.prepare('UPDATE servers SET lastBossAt=? WHERE guildId=?').run(now, targetServer.guildId);
      logger.info('boss_spawn: %s in %s name=%s hp=%s', userId, targetServer.guildId, name, hp);
      
      const spawnEmbed = new EmbedBuilder()
        .setTitle('🔥⚔️ **BOSS SUMMONED** ⚔️🔥')
        .setDescription('🌪️ *A mighty foe emerges from the shadows...* 🌪️')
        .setColor(0xFF4500)
        .setAuthor({ 
          name: `${userPrefix} - Boss Master`,
          iconURL: interaction.user.displayAvatarURL() 
        })
        .addFields(
          {
            name: '👹 **Boss**',
            value: `**${name}**\n🏮 Tier ${tier} Threat`,
            inline: true
          },
          {
            name: '❤️ **Health**',
            value: `**${hp.toLocaleString()}** HP\n💀 Maximum threat level`,
            inline: true
          },
          {
            name: '📍 **Location**',
            value: `**${targetServer.name || targetServer.guildId}**\n🗺️ Server: ${targetServer.guildId}`,
            inline: true
          },
          {
            name: '⚔️ **Combat Instructions**',
            value: '• Use `/boss attack` to engage\n• Must be visiting this server\n• Bring your best equipment!',
            inline: false
          },
          {
            name: '⏰ **Battle Window**',
            value: `**${Math.floor((config.boss?.ttlSeconds||3600)/60)} minutes** remaining\nBoss will vanish if not defeated!`,
            inline: false
          }
        )
        .setFooter({ 
          text: `⚔️ Rally your allies and claim victory! • QuestCord Boss Battle`,
          iconURL: interaction.client.user.displayAvatarURL()
        })
        .setTimestamp();

      // Respond to the user FIRST to avoid timeout
      const spawnReply = await interaction.reply({ embeds: [spawnEmbed] });
      
      // Do the slow operations AFTER responding
      // Send spawn notification to Discord channel
      const bossData = { name, tier, maxHp: hp, startedAt: now };
      const serverData = { name: targetServer.name, guildId: targetServer.guildId };
      sendBossSpawnNotification(interaction.client, bossData, serverData, interaction.user).catch(e => {
        console.warn('[boss] Failed to send spawn notification:', e.message);
      });
      
      // Update bot status
      try {
        const { updateBossStatus } = require('../index');
        if (typeof updateBossStatus === 'function') {
          updateBossStatus();
        }
      } catch (e) {
        // updateBossStatus is not exported, that's fine
      }
      
      // Add boss-related emoji reactions
      try {
        await spawnReply.react('⚔️');
        await spawnReply.react('🔥');
        await spawnReply.react('👹');
        await spawnReply.react('💀');
      } catch (e) {
        console.warn('[boss] Failed to add reactions to spawn message:', e.message);
      }
      
      return;
    }

    const boss = db.prepare('SELECT * FROM bosses WHERE guildId=? AND active=1 ORDER BY id DESC LIMIT 1').get(location);
    if (sub === 'status') {
      if (!boss) {
        const noBossEmbed = new EmbedBuilder()
          .setTitle('🔍❌ **NO ACTIVE BOSS** ❌🔍')
          .setDescription('This server is currently peaceful... for now.')
          .setColor(0x95A5A6)
          .setAuthor({ 
            name: `${userPrefix} - Scout Report`,
            iconURL: interaction.user.displayAvatarURL() 
          })
          .addFields({
            name: '🏞️ **Current Status**',
            value: '• No active threats detected\n• Server is currently safe\n• Staff can spawn bosses with `/boss spawn`',
            inline: false
          })
          .setFooter({ 
            text: `🛡️ Stay vigilant, adventurer • QuestCord Security`,
            iconURL: interaction.client.user.displayAvatarURL()
          })
          .setTimestamp();
        return interaction.reply({ embeds: [noBossEmbed] });
      }
      
      if (boss.expiresAt < Date.now()) {
        // Remove boss fighter role from all participants
        const parts = db.prepare('SELECT userId FROM boss_participants WHERE bossId=?').all(boss.id);
        for (const part of parts) {
          await removeBossFighterRole(interaction.client, part.userId, location);
        }
        
        db.prepare('UPDATE bosses SET active=0 WHERE id=?').run(boss.id);
        db.prepare('DELETE FROM boss_participants WHERE bossId=?').run(boss.id);
        
        // Immediately run orphaned role cleanup after boss vanishes
        try {
          const { cleanupOrphanedBossFighterRoles } = require('../utils/boss_spawner');
          await cleanupOrphanedBossFighterRoles(interaction.client);
        } catch (error) {
          console.warn('[boss] Failed to run immediate role cleanup after boss vanish:', error.message);
        }
        
        const vanishedEmbed = new EmbedBuilder()
          .setTitle('💨👻 **BOSS VANISHED** 👻💨')
          .setDescription('The mighty foe has retreated into the shadows...')
          .setColor(0x95A5A6)
          .setAuthor({ 
            name: `${userPrefix} - Battle Report`,
            iconURL: interaction.user.displayAvatarURL() 
          })
          .addFields({
            name: '⏰ **Battle Window Expired**',
            value: `**${boss.name}** has disappeared\nThe threat has passed... for now`,
            inline: false
          })
          .setFooter({ 
            text: `🕐 Be ready for the next encounter • QuestCord`,
            iconURL: interaction.client.user.displayAvatarURL()
          })
          .setTimestamp();
        return interaction.reply({ embeds: [vanishedEmbed] });
      }
      
      const eq = equippedWeapon(userId);
      const timeLeft = Math.ceil((boss.expiresAt - Date.now()) / 1000);
      const timeDisplay = timeLeft >= 60 ? `${Math.floor(timeLeft / 60)}m ${timeLeft % 60}s` : `${timeLeft}s`;
      const healthPercent = Math.round((boss.hp / boss.maxHp) * 100);
      
      let healthBar = '';
      const barLength = 20;
      const filledBars = Math.floor((boss.hp / boss.maxHp) * barLength);
      healthBar = '█'.repeat(filledBars) + '░'.repeat(barLength - filledBars);
      
      const statusEmbed = new EmbedBuilder()
        .setTitle(`👹⚔️ **${boss.name.toUpperCase()}** ⚔️👹`)
        .setDescription(`🏮 *Tier ${boss.tier||1} Boss Battle in Progress* 🏮`)
        .setColor(healthPercent > 75 ? 0xFF0000 : healthPercent > 50 ? 0xFF8C00 : healthPercent > 25 ? 0xFFD700 : 0x00FF00)
        .setAuthor({ 
          name: `${userPrefix} - Battle Status`,
          iconURL: interaction.user.displayAvatarURL() 
        })
        .addFields(
          {
            name: '❤️ **Boss Health**',
            value: `\`${healthBar}\`\n**${boss.hp.toLocaleString()}** / **${boss.maxHp.toLocaleString()}** HP\n📊 ${healthPercent}% remaining`,
            inline: false
          },
          {
            name: '🏮 **Threat Level**',
            value: `**Tier ${boss.tier || 1}**\n${boss.tier >= 5 ? '💀 Legendary' : boss.tier >= 3 ? '🔥 Elite' : '⚔️ Standard'}`,
            inline: true
          },
          {
            name: '⏰ **Time Remaining**',
            value: `**${timeDisplay}**\n⏳ Until vanish`,
            inline: true
          },
          {
            name: '⚔️ **Your Weapon**',
            value: eq ? `**${eq.name}**\n💎 ${eq.rarity} quality` : '**None Equipped**\n⚠️ Equip a weapon!',
            inline: true
          }
        )
        .addFields({
          name: '🎯 **Combat Tips**',
          value: '• Use `/boss attack` to deal damage\n• Higher rarity weapons deal more damage\n• Coordinate with other players for maximum effect!',
          inline: false
        })
        .setFooter({ 
          text: `⚔️ Victory brings great rewards • QuestCord Boss Battle`,
          iconURL: interaction.client.user.displayAvatarURL()
        })
        .setTimestamp();

      return interaction.reply({ embeds: [statusEmbed] });
    }

    if (sub === 'attack') {
      if (!boss) return interaction.reply(`${userPrefix} No active boss here.`);
      if (!player || player.locationGuildId !== location || (player.travelArrivalAt && Date.now() < player.travelArrivalAt)){
        return interaction.reply({ content: `${userPrefix} You must be visiting this server (arrived) to attack.`, flags: 64 });
      }
      if (boss.expiresAt < Date.now()) {
        db.prepare('UPDATE bosses SET active=0 WHERE id=?').run(boss.id);
        return interaction.reply(`${userPrefix} The boss has vanished.`);
      }
      const weapon = equippedWeapon(userId);
      const rarity = weapon?.rarity || 'common';
      const rarityMul = rarityMult(rarity);
      const attackBonus = weapon?.attackBonus || 1.0;
      let dmg = Math.floor(Math.random() * 150) + 50;
      dmg = Math.floor(dmg * rarityMul * attackBonus);

      const p = db.prepare('SELECT health, stamina FROM players WHERE userId=?').get(userId) || { health: 100, stamina: 100 };
      const stamina = p.stamina;
      const health = p.health;
      if (health <= 0) {
        return interaction.reply({ content: `${userPrefix} You are downed (0 health). Use healing items to recover before attacking again.`, flags: 64 });
      }
      const spend = config.stamina?.attackCost ?? 5;
      if (stamina < spend) {
        return interaction.reply({ content: `${userPrefix} You are too exhausted to attack. (Stamina ${stamina}/${spend} required)`, flags: 64 });
      }
      const newSt = Math.max(0, stamina - spend);
      db.prepare('UPDATE players SET stamina=?, staminaUpdatedAt=? WHERE userId=?').run(newSt, Date.now(), userId);

      // Assign boss fighter role
      await assignBossFighterRole(interaction, userId);

      db.prepare('UPDATE bosses SET hp=MAX(hp-?,0) WHERE id=?').run(dmg, boss.id);
      const current = db.prepare('SELECT hp FROM bosses WHERE id=?').get(boss.id).hp;
      
      // Boss counterattacks if still alive
      if (current > 0) {
        const ctr = (config.boss?.counterDamage) || { min: 5, max: 30 };
        const min = Math.max(0, parseInt(ctr.min ?? 5, 10));
        const max = Math.max(min, parseInt(ctr.max ?? 30, 10));
        const bossDmg = Math.floor(Math.random() * (max - min + 1)) + min;
        const rowhp = db.prepare('SELECT health FROM players WHERE userId=?').get(userId) || { health: 100 };
        const newHp = Math.max(0, (rowhp.health ?? 100) - bossDmg);
        db.prepare('UPDATE players SET health=? WHERE userId=?').run(newHp, userId);
        try { 
          await interaction.followUp(`It strikes back! You take **${bossDmg}** damage (HP **${newHp}**).`); 
        } catch (e) {
          // Silently handle follow-up errors
        }
      }
      const cur = db.prepare('SELECT damage FROM boss_participants WHERE bossId=? AND userId=?').get(boss.id, userId);
      if (!cur) {
        db.prepare('INSERT INTO boss_participants(bossId, userId, damage) VALUES(?,?,?)').run(boss.id, userId, dmg);
      } else {
        db.prepare('UPDATE boss_participants SET damage=damage+? WHERE bossId=? AND userId=?').run(dmg, boss.id, userId);
      }
      
      // Track battle analytics
      try {
        db.prepare(`
          INSERT INTO battle_analytics (userId, bossId, damage, weapon, timestamp)
          VALUES (?, ?, ?, ?, ?)
        `).run(userId, boss.id, dmg, weapon?.id || 'none', Date.now());
      } catch (e) {
        console.warn('[boss] Failed to track battle analytics:', e.message);
      }
      
      // Update challenge progress (avoid circular dependency)
      try {
        const challenges = require('../utils/challenges');
        challenges.updateChallengeProgress(userId, 'boss_damage', dmg);
        challenges.updateChallengeProgress(userId, 'boss_fight', 1);
      } catch (e) {
        console.warn('[boss] Failed to update challenge progress:', e.message);
      }
      
      // Award gems for boss participation
      try {
        awardBossParticipationGems(userId, dmg, boss.maxHp);
      } catch (e) {
        console.warn('[boss] Failed to award participation gems:', e.message);
      }
      
      logger.info('boss_attack: user %s dmg=%s weapon=%s', userId, dmg, weapon?.id);

      if (current <= 0) {
        db.prepare('UPDATE bosses SET active=0 WHERE id=?').run(boss.id);
        
        // Record boss defeat for spawning system cooldown
        try {
          const { recordBossDefeat } = require('../utils/boss_spawner');
          recordBossDefeat();
        } catch (error) {
          console.warn('[boss] Failed to record boss defeat for spawning system:', error.message);
        }
        const parts = db.prepare('SELECT * FROM boss_participants WHERE bossId=?').all(boss.id);
        for (const part of parts) {
          const prem = await isPremium(interaction.client, part.userId);
          // 3-5 rolls per participant using tiered rarity, avoid premiumNeeded for non-premium users
          const numRolls = 3 + Math.floor(Math.random() * 3); // 3-5 items
          for (let i = 0; i < numRolls; i++) {
            const lootId = pickLootByTier(boss.tier || 1, prem);
            if (!lootId) continue;
            const existing = db.prepare('SELECT qty FROM inventory WHERE userId=? AND itemId=?').get(part.userId, lootId);
            if (!existing) db.prepare('INSERT INTO inventory(userId,itemId,qty) VALUES(?,?,?)').run(part.userId, lootId, 1);
            else db.prepare('UPDATE inventory SET qty=qty+1 WHERE userId=? AND itemId=?').run(part.userId, lootId);
          }
          db.prepare('UPDATE players SET drakari=drakari+?, bossKills=COALESCE(bossKills,0)+1 WHERE userId=?').run(50 * (boss.tier || 1), part.userId);
          
          // Remove boss fighter role from participants
          await removeBossFighterRole(interaction.client, part.userId, location);
          
          // Check boss achievements for each participant
          try {
            checkBossAchievements(part.userId);
          } catch (e) {
            console.warn('[boss] Failed to check achievements for user:', part.userId, e.message);
          }
        }
        db.prepare('DELETE FROM boss_participants WHERE bossId=?').run(boss.id);
        logger.info('boss_defeat: %s participants=%s name=%s', location, parts.length, boss.name);
        
        // Immediately run orphaned role cleanup to ensure roles are removed from users
        // who no longer have any active boss fights
        try {
          const { cleanupOrphanedBossFighterRoles } = require('../utils/boss_spawner');
          await cleanupOrphanedBossFighterRoles(interaction.client);
        } catch (error) {
          console.warn('[boss] Failed to run immediate role cleanup:', error.message);
        }
        
        const victoryEmbed = new EmbedBuilder()
          .setTitle('🎉👑 **VICTORY ACHIEVED** 👑🎉')
          .setDescription(`🏆 *The ${boss.name} has been vanquished!* 🏆`)
          .setColor(0xFFD700)
          .setAuthor({ 
            name: `${userPrefix} - Champion`,
            iconURL: interaction.user.displayAvatarURL() 
          })
          .addFields(
            {
              name: '👹 **Defeated Boss**',
              value: `**${boss.name}**\n🏮 Tier ${boss.tier || 1} Threat Eliminated`,
              inline: true
            },
            {
              name: '👥 **Heroes**',
              value: `**${parts.length}** brave warriors\n⚔️ United in victory`,
              inline: true
            },
            {
              name: '💰 **Rewards**',
              value: `**${50 * (boss.tier || 1)} ${config.currencyName}**\n💎 Plus Tier ${boss.tier || 1} loot`,
              inline: true
            },
            {
              name: '🎁 **Loot Distribution**',
              value: `• **3-5 items** per participant\n• Tier ${boss.tier || 1} quality guaranteed\n• Rare items possible\n• Premium users get enhanced drops`,
              inline: false
            }
          )
          .setFooter({ 
            text: `🌟 Glory to the victorious heroes! Check your inventory • QuestCord Victory`,
            iconURL: interaction.client.user.displayAvatarURL()
          })
          .setTimestamp();

        const victoryReply = await interaction.reply({ embeds: [victoryEmbed] });
        
        // Do slow operations AFTER replying
        // Send defeat notification to Discord channel
        const battleDuration = Date.now() - boss.startedAt;
        const bossData = { name: boss.name, tier: boss.tier || 1, maxHp: boss.maxHp, startedAt: boss.startedAt };
        const serverData = { name: here?.name, guildId: location };
        sendBossDefeatNotification(interaction.client, bossData, serverData, parts, battleDuration).catch(e => {
          console.warn('[boss] Failed to send defeat notification:', e.message);
        });
        
        // Update bot status
        try {
          const { updateBossStatus } = require('../index');
          if (typeof updateBossStatus === 'function') {
            updateBossStatus();
          }
        } catch (e) {
          // updateBossStatus is not exported, that's fine
        }
        
        // Add victory emoji reactions
        try {
          await victoryReply.react('🎉');
          await victoryReply.react('👑');
          await victoryReply.react('🏆');
          await victoryReply.react('💰');
          await victoryReply.react('⚔️');
        } catch (e) {
          console.warn('[boss] Failed to add reactions to victory message:', e.message);
        }
        
        return;
      } else {
        const healthPercent = Math.round((current / boss.maxHp) * 100);
        const weaponText = weapon ? `**${weapon.name}** (${weapon.rarity})` : 'bare fists';
        
        const attackEmbed = new EmbedBuilder()
          .setTitle('⚔️💥 **COMBAT STRIKE** 💥⚔️')
          .setDescription(`🎯 *Your attack finds its mark!* ⚡`)
          .setColor(dmg >= 300 ? 0xFF0000 : dmg >= 200 ? 0xFF8C00 : dmg >= 100 ? 0xFFD700 : 0x00AE86)
          .setAuthor({ 
            name: `${userPrefix} - Warrior`,
            iconURL: interaction.user.displayAvatarURL() 
          })
          .addFields(
            {
              name: '💥 **Damage Dealt**',
              value: `**${dmg.toLocaleString()}** damage\n⚔️ Using ${weaponText}`,
              inline: true
            },
            {
              name: '❤️ **Boss Health**',
              value: `**${current.toLocaleString()}** / **${boss.maxHp.toLocaleString()}** HP\n📊 ${healthPercent}% remaining`,
              inline: true
            },
            {
              name: '🎯 **Attack Rating**',
              value: dmg >= 300 ? '🔥 **DEVASTATING**' : 
                     dmg >= 200 ? '💪 **POWERFUL**' : 
                     dmg >= 100 ? '⚔️ **SOLID**' : '🗡️ **DECENT**',
              inline: true
            }
          )
          .setFooter({ 
            text: `🏹 Keep fighting! Victory is within reach • QuestCord Battle`,
            iconURL: interaction.client.user.displayAvatarURL()
          })
          .setTimestamp();

        return interaction.reply({ embeds: [attackEmbed] });
      }
    }
  }
};
