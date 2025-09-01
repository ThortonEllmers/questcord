const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getUserPrefix } = require('../utils/roles');
const { isBanned, regenStamina } = require('./_guard');
const { db } = require('../utils/store_sqlite');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('analytics')
    .setDescription('View detailed battle analytics and performance statistics')
    .addSubcommand(sc => sc
      .setName('battles')
      .setDescription('View your battle performance statistics'))
    .addSubcommand(sc => sc
      .setName('weapons')
      .setDescription('Compare weapon effectiveness and damage output'))
    .addSubcommand(sc => sc
      .setName('history')
      .setDescription('View recent battle history and damage trends')),

  async execute(interaction) {
    const userPrefix = await getUserPrefix(interaction.client, interaction.user);
    if (isBanned(interaction.user.id)) {
      return interaction.reply({ content: `${userPrefix} You are banned from using this bot.`, ephemeral: true });
    }
    regenStamina(interaction.user.id);

    const subcommand = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    if (subcommand === 'battles') {
      // Get overall battle statistics
      const battleStats = db.prepare(`
        SELECT 
          COUNT(*) as totalFights,
          SUM(damage) as totalDamage,
          AVG(damage) as avgDamage,
          MAX(damage) as maxDamage,
          COUNT(DISTINCT bossId) as uniqueBosses
        FROM battle_analytics
        WHERE userId = ?
      `).get(userId) || {};

      // Get recent activity (last 7 days)
      const weekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
      const recentActivity = db.prepare(`
        SELECT COUNT(*) as recentFights, SUM(damage) as recentDamage
        FROM battle_analytics
        WHERE userId = ? AND timestamp > ?
      `).get(userId, weekAgo) || {};

      // Get player's boss kill count from players table
      const player = db.prepare('SELECT bossKills FROM players WHERE userId = ?').get(userId);
      const bossKills = player?.bossKills || 0;

      const analyticsEmbed = new EmbedBuilder()
        .setTitle('⚔️📊 **BATTLE ANALYTICS** 📊⚔️')
        .setDescription('📈 *Comprehensive analysis of your combat performance* 📈')
        .setColor(0xE74C3C)
        .setAuthor({ 
          name: `${userPrefix} - Combat Analyst`,
          iconURL: interaction.user.displayAvatarURL() 
        });

      if (battleStats.totalFights === 0) {
        analyticsEmbed.addFields(
          {
            name: '📭 **No Battle Data**',
            value: '• Join your first boss battle with `/boss`\\n• Fight alongside other players for glory\\n• Earn gems, loot, and track your progress\\n• Build your combat reputation!',
            inline: false
          },
          {
            name: '🎯 **Get Started**',
            value: '• **Find Bosses**: Check active servers for boss spawns\\n• **Team Up**: Battles are more effective with allies\\n• **Weapon Choice**: Different weapons have varying effectiveness\\n• **Track Progress**: Return here to see your improvement',
            inline: false
          }
        );
      } else {
        // Main battle statistics
        analyticsEmbed.addFields(
          {
            name: '⚔️ **Combat Record**',
            value: `**${battleStats.totalFights}** total attacks
**${bossKills}** bosses defeated
**${battleStats.uniqueBosses}** unique enemies
**${recentActivity.recentFights || 0}** fights this week`,
            inline: true
          },
          {
            name: '💥 **Damage Statistics**',
            value: `**${battleStats.totalDamage?.toLocaleString() || 0}** total damage
**${Math.round(battleStats.avgDamage || 0)}** average per hit
**${battleStats.maxDamage?.toLocaleString() || 0}** highest single hit
**${Math.round(recentActivity.recentDamage / (recentActivity.recentFights || 1) || 0)}** recent average`,
            inline: true
          },
          {
            name: '📈 **Performance Metrics**',
            value: `**${Math.round((battleStats.totalDamage || 0) / (battleStats.totalFights || 1))}** damage/fight
**${(recentActivity.recentFights || 0 / 7).toFixed(1)}** fights/day
**${Math.round((recentActivity.recentDamage || 0) / 7)}** daily damage
${battleStats.maxDamage >= 1000 ? '🏆 **Elite Warrior**' : battleStats.maxDamage >= 500 ? '⭐ **Skilled Fighter**' : '🔰 **Learning Fighter**'}`,
            inline: true
          }
        );

        // Performance trends
        const improvement = recentActivity.recentFights > 0 ? 
          ((recentActivity.recentDamage / recentActivity.recentFights) / battleStats.avgDamage - 1) * 100 : 0;

        analyticsEmbed.addFields({
          name: '📊 **Performance Analysis**',
          value: `• **Consistency**: ${battleStats.avgDamage >= 100 ? 'Excellent' : battleStats.avgDamage >= 50 ? 'Good' : 'Developing'} damage output
• **Recent Form**: ${improvement > 10 ? '📈 Improving' : improvement < -10 ? '📉 Declining' : '➡️ Steady'} (${improvement > 0 ? '+' : ''}${improvement.toFixed(1)}%)
• **Activity Level**: ${recentActivity.recentFights >= 10 ? 'Very Active' : recentActivity.recentFights >= 5 ? 'Active' : 'Casual'} fighter
• **Boss Success**: ${(bossKills / battleStats.uniqueBosses * 100).toFixed(0)}% kill participation rate`,
          inline: false
        });
      }

      const achievementIcon = bossKills >= 50 ? '👑' : bossKills >= 10 ? '🏅' : bossKills >= 1 ? '⚔️' : '🔰';
      const achievementTitle = bossKills >= 50 ? 'Legendary Warrior' :
        bossKills >= 10 ? 'Monster Hunter' :
        bossKills >= 1 ? 'Boss Slayer' : 'Aspiring Fighter';
      const rank = battleStats.totalFights >= 100 ? 'Veteran' : 
        battleStats.totalFights >= 50 ? 'Experienced' : 
        battleStats.totalFights >= 10 ? 'Regular' : 'Newcomer';
      
      analyticsEmbed.addFields({
        name: '🎖️ **Battle Achievements**',
        value: `${achievementIcon} **${achievementTitle}**
• **Progress**: ${bossKills}/50 boss kills
• **Rank**: ${rank}
• **Specialization**: View \`/analytics weapons\` for weapon mastery`,
        inline: false
      });

      analyticsEmbed.setFooter({ 
        text: `⚔️ Battle data updates after each boss fight • QuestCord Analytics`,
        iconURL: interaction.client.user.displayAvatarURL()
      });

      return interaction.reply({ embeds: [analyticsEmbed] });
    }

    if (subcommand === 'weapons') {
      // Get weapon usage statistics
      const weaponStats = db.prepare(`
        SELECT 
          weapon,
          COUNT(*) as uses,
          SUM(damage) as totalDamage,
          AVG(damage) as avgDamage,
          MAX(damage) as maxDamage
        FROM battle_analytics
        WHERE userId = ? AND weapon IS NOT NULL
        GROUP BY weapon
        ORDER BY totalDamage DESC
      `).all(userId);

      const weaponsEmbed = new EmbedBuilder()
        .setTitle('⚔️🗡️ **WEAPON MASTERY** 🗡️⚔️')
        .setDescription('🎯 *Analysis of your weapon effectiveness and preferences* 🎯')
        .setColor(0x8E44AD)
        .setAuthor({ 
          name: `${userPrefix} - Weapon Master`,
          iconURL: interaction.user.displayAvatarURL() 
        });

      if (weaponStats.length === 0) {
        weaponsEmbed.addFields(
          {
            name: '🗡️ **No Weapon Data**',
            value: '• Equip weapons before entering battle\n• Different weapons have varying damage ranges\n• Track which weapons work best for you\n• Build your arsenal strategically!',
            inline: false
          },
          {
            name: '⚔️ **Weapon Tips**',
            value: '• **Equip First**: Use `/equip <weapon>` before fights\n• **Experiment**: Try different weapon types\n• **Upgrade**: Craft better weapons as you progress\n• **Specialize**: Focus on weapons that suit your style',
            inline: false
          }
        );
      } else {
        // Weapon performance summary
        const totalWeaponDamage = weaponStats.reduce((sum, w) => sum + w.totalDamage, 0);
        const totalWeaponUses = weaponStats.reduce((sum, w) => sum + w.uses, 0);
        const favoriteWeapon = weaponStats[0];

        weaponsEmbed.addFields(
          {
            name: '🏆 **Weapon Portfolio**',
            value: `**${weaponStats.length}** weapons mastered\n**${totalWeaponUses}** total attacks\n**${totalWeaponDamage?.toLocaleString()}** combined damage\n**${Math.round(totalWeaponDamage / totalWeaponUses)}** overall average`,
            inline: true
          },
          {
            name: '⭐ **Favorite Weapon**',
            value: `**${favoriteWeapon.weapon}**\n${favoriteWeapon.uses} uses (${Math.round(favoriteWeapon.uses / totalWeaponUses * 100)}%)\n${favoriteWeapon.totalDamage?.toLocaleString()} damage\n${Math.round(favoriteWeapon.avgDamage)} avg per hit`,
            inline: true
          },
          {
            name: '💪 **Combat Style**',
            value: weaponStats.length >= 5 ? '🌟 **Versatile Fighter**\nMasters multiple weapons' : 
                   weaponStats.length >= 3 ? '⚔️ **Balanced Warrior**\nUses variety of weapons' :
                   '🗡️ **Specialist**\nFocuses on few weapons',
            inline: true
          }
        );

        // Top weapons performance
        const topWeapons = weaponStats.slice(0, 5).map((weapon, index) => {
          const rankEmoji = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'][index];
          const efficiency = Math.round(weapon.avgDamage);
          const usage = Math.round(weapon.uses / totalWeaponUses * 100);
          return `${rankEmoji} **${weapon.weapon}**\n📊 ${efficiency} avg dmg • 🎯 ${usage}% usage • ⚡ ${weapon.maxDamage} max hit`;
        }).join('\n\n');

        weaponsEmbed.addFields({
          name: '🏅 **Weapon Leaderboard**',
          value: topWeapons,
          inline: false
        });

        // Weapon recommendations
        const bestDamage = Math.max(...weaponStats.map(w => w.avgDamage));
        const mostUsed = weaponStats[0];
        const recommendations = [];

        if (bestDamage > mostUsed.avgDamage) {
          const bestWeapon = weaponStats.find(w => w.avgDamage === bestDamage);
          recommendations.push(`• Consider using **${bestWeapon.weapon}** more (highest avg damage: ${Math.round(bestDamage)})`);
        }

        if (weaponStats.length < 3) {
          recommendations.push('• Try experimenting with more weapon types for versatility');
        }

        if (recommendations.length === 0) {
          recommendations.push('• Your weapon usage is well optimized!');
        }

        weaponsEmbed.addFields({
          name: '💡 **Performance Insights**',
          value: recommendations.join('\n') + '\n• Use `/craft` to create stronger weapons\n• Different bosses may have resistances to certain weapon types',
          inline: false
        });
      }

      weaponsEmbed.setFooter({ 
        text: `🗡️ Master your arsenal for maximum effectiveness • QuestCord Weapons`,
        iconURL: interaction.client.user.displayAvatarURL()
      });

      return interaction.reply({ embeds: [weaponsEmbed] });
    }

    if (subcommand === 'history') {
      // Get recent battle history
      const battleHistory = db.prepare(`
        SELECT damage, weapon, timestamp, bossId
        FROM battle_analytics
        WHERE userId = ?
        ORDER BY timestamp DESC
        LIMIT 20
      `).all(userId);

      const historyEmbed = new EmbedBuilder()
        .setTitle('📜⚔️ **BATTLE HISTORY** ⚔️📜')
        .setDescription('⏰ *Your recent combat encounters and damage progression* ⏰')
        .setColor(0x2ECC71)
        .setAuthor({ 
          name: `${userPrefix} - Combat Log`,
          iconURL: interaction.user.displayAvatarURL() 
        });

      if (battleHistory.length === 0) {
        historyEmbed.addFields(
          {
            name: '📭 **Empty Battle Log**',
            value: '• No recorded battles yet\n• Start fighting bosses to build your history\n• Track your improvement over time\n• Analyze your combat patterns',
            inline: false
          },
          {
            name: '🔥 **Join the Action**',
            value: '• Use `/boss` to find active boss battles\n• Fight alongside other adventurers\n• Each battle adds to your combat record\n• Watch your skills improve over time!',
            inline: false
          }
        );
      } else {
        // Recent battles summary
        const recentDamage = battleHistory.slice(0, 5).reduce((sum, b) => sum + b.damage, 0) / Math.min(5, battleHistory.length);
        const olderDamage = battleHistory.slice(5, 10).reduce((sum, b) => sum + b.damage, 0) / Math.max(1, battleHistory.slice(5, 10).length);
        const trend = recentDamage > olderDamage ? '📈 Improving' : recentDamage < olderDamage ? '📉 Declining' : '➡️ Steady';

        historyEmbed.addFields(
          {
            name: '📊 **Recent Performance**',
            value: `**${battleHistory.length}** recorded battles\n**${Math.round(recentDamage)}** recent avg damage\n**${trend}** performance trend\n**${Math.max(...battleHistory.map(b => b.damage))}** highest recent hit`,
            inline: true
          },
          {
            name: '⏰ **Activity Timeline**',
            value: `Last fight: ${new Date(battleHistory[0].timestamp).toLocaleDateString()}\nMost active weapon: **${getBestWeapon(battleHistory)}**\nFighting consistency: ${getActivityLevel(battleHistory)}`,
            inline: true
          }
        );

        // Recent battle log
        const battleLog = battleHistory.slice(0, 8).map((battle, index) => {
          const date = new Date(battle.timestamp);
          const timeAgo = Math.floor((Date.now() - battle.timestamp) / (1000 * 60 * 60 * 24));
          const weapon = battle.weapon || 'Bare Hands';
          
          return `**${index + 1}.** ${battle.damage.toLocaleString()} dmg with ${weapon}\
📅 ${timeAgo === 0 ? 'Today' : `${timeAgo}d ago`} • Boss #${battle.bossId || 'Unknown'}`;
        }).join('\n\n');

        historyEmbed.addFields({
          name: '⚔️ **Combat Log**',
          value: battleLog,
          inline: false
        });

        if (battleHistory.length > 8) {
          historyEmbed.addFields({
            name: '📋 **Extended History**',
            value: `... and **${battleHistory.length - 8}** more battles\nUse \`/analytics battles\` for complete statistics`,
            inline: false
          });
        }

        // Performance insights
        const damageVariance = getVariance(battleHistory.map(b => b.damage));
        const consistency = damageVariance < 100 ? 'Very Consistent' : damageVariance < 500 ? 'Fairly Consistent' : 'Variable';

        historyEmbed.addFields({
          name: '🎯 **Performance Insights**',
          value: `• **Consistency**: ${consistency} damage output\n• **Recent Form**: ${Math.round(recentDamage)} avg damage (last 5 fights)\n• **Weapon Preference**: Favors ${getBestWeapon(battleHistory)}\n• **Activity Pattern**: ${getActivityLevel(battleHistory)} fighter`,
          inline: false
        });
      }

      historyEmbed.setFooter({ 
        text: `⚔️ Battle history helps track your combat improvement • QuestCord Analytics`,
        iconURL: interaction.client.user.displayAvatarURL()
      });

      return interaction.reply({ embeds: [historyEmbed] });
    }
  }
};

// Helper functions
function getBestWeapon(battles) {
  const weaponCounts = {};
  battles.forEach(battle => {
    const weapon = battle.weapon || 'Bare Hands';
    weaponCounts[weapon] = (weaponCounts[weapon] || 0) + 1;
  });
  
  return Object.keys(weaponCounts).reduce((a, b) => weaponCounts[a] > weaponCounts[b] ? a : b, 'None');
}

function getActivityLevel(battles) {
  if (battles.length === 0) return 'Inactive';
  
  const daysSinceFirst = Math.floor((Date.now() - battles[battles.length - 1].timestamp) / (1000 * 60 * 60 * 24)) || 1;
  const battlesPerDay = battles.length / daysSinceFirst;
  
  if (battlesPerDay >= 2) return 'Very Active';
  if (battlesPerDay >= 1) return 'Active';
  if (battlesPerDay >= 0.5) return 'Regular';
  return 'Casual';
}

function getVariance(numbers) {
  const avg = numbers.reduce((sum, n) => sum + n, 0) / numbers.length;
  const variance = numbers.reduce((sum, n) => sum + Math.pow(n - avg, 2), 0) / numbers.length;
  return Math.sqrt(variance);
}