const { SlashCommandBuilder } = require('discord.js');
const { db } = require('../utils/store_sqlite');
const { isStaffOrDev, getUserPrefix, isDev } = require('../utils/roles');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setstats')
    .setDescription('Set health or stamina for a user (staff/dev only)')
    .addUserOption(option =>
      option
        .setName('user')
        .setDescription('The user to modify')
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('stat')
        .setDescription('Which stat to modify')
        .setRequired(true)
        .addChoices(
          { name: 'Health', value: 'health' },
          { name: 'Stamina', value: 'stamina' }
        )
    )
    .addIntegerOption(option =>
      option
        .setName('amount')
        .setDescription('Amount to set (staff/dev: unlimited, others: 0-100)')
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(10000)
    ),

  async execute(interaction) {
    const userPrefix = await getUserPrefix(interaction.client, interaction.user);
    const userId = interaction.user.id;
    
    // Check if user is staff or developer
    if (!await isStaffOrDev(interaction.client, userId)) {
      return interaction.reply({ 
        content: `${userPrefix} This command is only available to staff and developers.`, 
        ephemeral: true 
      });
    }

    const targetUser = interaction.options.getUser('user');
    const stat = interaction.options.getString('stat');
    const amount = interaction.options.getInteger('amount');
    
    // Additional validation for non-staff/dev users
    const isStaffDev = await isStaffOrDev(interaction.client, userId);
    if (!isStaffDev && amount > 100) {
      return interaction.reply({
        content: `${userPrefix} You can only set values up to 100. Staff and developers can set unlimited amounts.`,
        ephemeral: true
      });
    }

    try {
      // Ensure player exists in database
      const existingPlayer = db.prepare('SELECT * FROM players WHERE userId=?').get(targetUser.id);
      
      if (!existingPlayer) {
        // Create player entry if doesn't exist
        const guildId = interaction.guildId || process.env.SPAWN_GUILD_ID;

        if (!guildId) {
          return interaction.reply({
            content: `${userPrefix} Error: No guild context available and SPAWN_GUILD_ID not configured.`,
            ephemeral: true
          });
        }

        db.prepare(`
          INSERT INTO players (userId, name, health, stamina, locationGuildId)
          VALUES (?, ?, ?, ?, ?)
        `).run(targetUser.id, targetUser.username, 100, 100, guildId);
      }

      // Update the specific stat
      const column = stat === 'health' ? 'health' : 'stamina';
      db.prepare(`UPDATE players SET ${column}=?, staminaUpdatedAt=? WHERE userId=?`)
        .run(amount, Date.now(), targetUser.id);

      // Log the action
      logger.info('setstats: %s set %s to %s for user %s', userId, stat, amount, targetUser.id);

      // Reply with success
      const statName = stat.charAt(0).toUpperCase() + stat.slice(1);
      const maxDisplay = isStaffDev ? '∞' : '100';
      await interaction.reply({
        content: `${userPrefix} ✅ Set **${targetUser.username}**'s ${statName} to **${amount}**${amount <= 100 ? '/100' : ` (Staff/Dev override)`}`,
        ephemeral: false // Make it visible so other staff can see the action
      });

    } catch (error) {
      console.error('Setstats command error:', error);
      logger.error('setstats error: %s', error.message);
      
      await interaction.reply({
        content: `${userPrefix} An error occurred while updating the user stats.`,
        ephemeral: true
      });
    }
  },
};