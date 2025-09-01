const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { db } = require('../utils/store_sqlite');
const { isStaffOrDev, getUserPrefix, isPremium } = require('../utils/roles');
const { isBanned } = require('./_guard');
const { ensurePlayerWithVehicles } = require('../utils/players');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Clear user data (Staff/Developer only)')
    .addSubcommand(sc => sc
      .setName('inventory')
      .setDescription('Clear a user\'s entire inventory')
      .addUserOption(o => o.setName('user').setDescription('User whose inventory to clear').setRequired(true))
      .addBooleanOption(o => o.setName('confirm').setDescription('Confirm you want to clear ALL items').setRequired(true)))
    .addSubcommand(sc => sc
      .setName('equipment')
      .setDescription('Clear a user\'s equipped items')
      .addUserOption(o => o.setName('user').setDescription('User whose equipment to clear').setRequired(true))
      .addBooleanOption(o => o.setName('confirm').setDescription('Confirm you want to clear ALL equipment').setRequired(true))),

  async execute(interaction) {
    const userPrefix = await getUserPrefix(interaction.client, interaction.user);
    if (isBanned(interaction.user.id)) {
      return interaction.reply({ content: `${userPrefix} You are banned from using this bot.`, ephemeral: true });
    }

    if (!(await isStaffOrDev(interaction.client, interaction.user.id))) {
      return interaction.reply({ content: `${userPrefix} Staff/Developer only.`, ephemeral: true });
    }

    const subcommand = interaction.options.getSubcommand();
    const targetUser = interaction.options.getUser('user');
    const confirm = interaction.options.getBoolean('confirm');

    if (!confirm) {
      return interaction.reply({ 
        content: `${userPrefix} You must set the confirm option to \`True\` to proceed with clearing data.`, 
        ephemeral: true 
      });
    }

    if (subcommand === 'inventory') {
      // Get current inventory count for logging
      const inventoryCount = db.prepare('SELECT COUNT(*) as count FROM inventory WHERE userId=?').get(targetUser.id);
      const itemCount = inventoryCount?.count || 0;

      if (itemCount === 0) {
        return interaction.reply({ 
          content: `${userPrefix} ${targetUser.username} has no items in their inventory.`, 
          ephemeral: true 
        });
      }

      // Clear entire inventory
      const result = db.prepare('DELETE FROM inventory WHERE userId=?').run(targetUser.id);

      // Restore default vehicles based on user's role hierarchy
      const userIsPremium = await isPremium(interaction.client, targetUser.id);
      
      // Always give commercial plane
      db.prepare('INSERT OR REPLACE INTO inventory(userId, itemId, qty) VALUES(?, ?, 1)')
        .run(targetUser.id, 'plane');
      
      let restoredItems = 'commercial plane';
      
      // Give private jet to premium+ users (includes staff and developers)
      if (userIsPremium) {
        db.prepare('INSERT OR REPLACE INTO inventory(userId, itemId, qty) VALUES(?, ?, 1)')
          .run(targetUser.id, 'private_jet');
        restoredItems = 'commercial plane & private jet';
      }
      
      // Ensure they have proper equipment setup
      await ensurePlayerWithVehicles(interaction.client, targetUser.id, targetUser.username);

      logger.info('clear_inventory: staff %s cleared inventory for user %s (%d items), restored vehicles: %s', 
        interaction.user.id, targetUser.id, itemCount, restoredItems);

      return interaction.reply(
        `${userPrefix} **Inventory Cleared**\n` +
        `Removed **${itemCount}** items from ${targetUser.username}'s inventory.\n` +
        `Restored default vehicles: **${restoredItems}**`
      );
    }

    if (subcommand === 'equipment') {
      // Get current equipment count for logging
      const equipmentCount = db.prepare('SELECT COUNT(*) as count FROM equipment WHERE userId=?').get(targetUser.id);
      const equipCount = equipmentCount?.count || 0;

      if (equipCount === 0) {
        return interaction.reply({ 
          content: `${userPrefix} ${targetUser.username} has no equipped items.`, 
          ephemeral: true 
        });
      }

      // Clear all equipment
      const result = db.prepare('DELETE FROM equipment WHERE userId=?').run(targetUser.id);

      // Reset vehicle to default plane
      db.prepare('UPDATE players SET vehicle=? WHERE userId=?').run('plane', targetUser.id);

      logger.info('clear_equipment: staff %s cleared equipment for user %s (%d items)', 
        interaction.user.id, targetUser.id, equipCount);

      return interaction.reply(
        `${userPrefix} **Equipment Cleared**\n` +
        `Removed **${equipCount}** equipped items from ${targetUser.username}.\n` +
        `Vehicle reset to commercial plane.`
      );
    }
  }
};