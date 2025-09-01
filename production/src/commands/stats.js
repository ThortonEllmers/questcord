const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getUserPrefix, isPremium } = require('../utils/roles');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Show your current health and stamina')
    .addBooleanOption(o => o.setName('public').setDescription('Show to everyone (default: no)')),

  async execute(interaction) {
    const { db } = require('../utils/store_sqlite'); // <- lazy requires for deploy
    const { MAX_H, MAX_S, applyRegenForUser } = require('../utils/regen');

    const userId = interaction.user.id;
    try { applyRegenForUser(userId); } catch {}

    try { db.prepare("ALTER TABLE players ADD COLUMN isPremium INTEGER DEFAULT 0").run(); } catch {}

    // Check both database and Discord roles for premium status
    const row = db.prepare("SELECT health, stamina, isPremium FROM players WHERE userId=?").get(userId) || { health: 0, stamina: 0, isPremium: 0 };
    const userIsPremium = (await isPremium(interaction.client, userId)) || row.isPremium;
    
    // Premium users get 1.5x max health (150 instead of 100)
    const maxH = userIsPremium ? MAX_H * 1.5 : MAX_H;
    const maxS = MAX_S;

    const bar = (v, m) => {
      const pct = m ? Math.round((v/m)*100) : 0;
      const ticks = Math.max(0, Math.min(20, Math.round((pct/100)*20)));
      return `\`${'█'.repeat(ticks).padEnd(20,'·')}\` ${Math.round(v)}/${Math.round(m)}  (${pct}%)`;
    };

    const userPrefix = await getUserPrefix(interaction.client, interaction.user);
    
    const embed = new EmbedBuilder()
      .setTitle('📊 Player Statistics')
      .setDescription('Your current health, stamina, and status')
      .setColor(userIsPremium ? 0xFFD700 : 0x00AE86)
      .setAuthor({ 
        name: `${userPrefix}`,
        iconURL: interaction.user.displayAvatarURL() 
      })
      .addFields(
        { 
          name: '❤️ Health', 
          value: bar(row.health || 0, maxH), 
          inline: false 
        },
        { 
          name: '💨 Stamina', 
          value: bar(row.stamina || 0, maxS), 
          inline: false 
        },
        { 
          name: '👑 Premium Status', 
          value: userIsPremium 
            ? '✅ **Premium Active** (1.5× max health)' 
            : '❌ **Not Premium**', 
          inline: true 
        }
      )
      .setFooter({ 
        text: `Health and stamina regenerate over time • QuestCord`,
        iconURL: interaction.client.user.displayAvatarURL()
      })
      .setTimestamp();

    const pub = interaction.options.getBoolean('public') || false;
    await interaction.reply({ embeds: [embed], ephemeral: !pub });
  }
};
