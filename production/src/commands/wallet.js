const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { db } = require('../utils/store_sqlite');
const config = require('../utils/config');
const { tag, getUserPrefix } = require('../utils/roles');
const { isBanned, regenStamina } = require('./_guard');

module.exports = {
  data: new SlashCommandBuilder().setName('wallet').setDescription('Check your currency balance.'),
  async execute(interaction){
    if (isBanned(interaction.user.id)) return interaction.reply({ content: 'You are banned from using this bot.', ephemeral: true });
    regenStamina(interaction.user.id);
    const userId = interaction.user.id;
    let row = db.prepare('SELECT * FROM players WHERE userId=?').get(userId);
    if (!row){
      db.prepare('INSERT INTO players(userId, name) VALUES(?,?)').run(userId, interaction.user.username);
      row = db.prepare('SELECT * FROM players WHERE userId=?').get(userId);
    }
    const userPrefix = await getUserPrefix(interaction.client, interaction.user);
    
    // Get player stats for enhanced display
    const isPremiumUser = await tag(interaction.client, interaction.user, 'premium') === 'premium';
    
    // Calculate wealth status
    const balance = row.drakari;
    let wealthTier, wealthIcon, wealthColor;
    if (balance >= 100000) {
      wealthTier = 'LEGENDARY MAGNATE';
      wealthIcon = '👑';
      wealthColor = 0xFFD700;
    } else if (balance >= 50000) {
      wealthTier = 'WEALTHY MERCHANT';
      wealthIcon = '💎';
      wealthColor = 0x9B59B6;
    } else if (balance >= 25000) {
      wealthTier = 'PROSPEROUS TRADER';
      wealthIcon = '💰';
      wealthColor = 0x3498DB;
    } else if (balance >= 10000) {
      wealthTier = 'SUCCESSFUL ADVENTURER';
      wealthIcon = '🏆';
      wealthColor = 0x2ECC71;
    } else if (balance >= 5000) {
      wealthTier = 'RISING ENTREPRENEUR';
      wealthIcon = '⭐';
      wealthColor = 0xF39C12;
    } else if (balance >= 1000) {
      wealthTier = 'ASPIRING TRADER';
      wealthIcon = '🌟';
      wealthColor = 0xE67E22;
    } else {
      wealthTier = 'STARTING ADVENTURER';
      wealthIcon = '🔰';
      wealthColor = 0x95A5A6;
    }

    const embed = new EmbedBuilder()
      .setTitle('Wallet')
      .setColor(isPremiumUser ? 0xFFD700 : wealthColor)
      .setAuthor({
        name: `${userPrefix} - ${wealthTier}`,
        iconURL: interaction.user.displayAvatarURL()
      })
      .addFields(
        {
          name: 'Current Balance',
          value: `${balance.toLocaleString()} ${config.currencyName}\n${wealthIcon} ${wealthTier}`,
          inline: true
        },
        {
          name: 'Account Status',
          value: isPremiumUser
            ? 'Premium Member'
            : 'Standard Account',
          inline: true
        },
        {
          name: 'Quick Actions',
          value: 'View /market listings\nBuy premium items\nTrade with players',
          inline: true
        }
      );

    if (balance >= 10000) {
      embed.addFields({
        name: 'Wealth Analysis',
        value: `• Portfolio value: ${balance.toLocaleString()} ${config.currencyName}\n• Top tier adventurer status\n• Consider investing in rare equipment\n• Premium items available`,
        inline: false
      });
    }

    embed
      .setFooter({
        text: `QuestCord Treasury`,
        iconURL: interaction.client.user.displayAvatarURL()
      })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  }
};
