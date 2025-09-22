const { SlashCommandBuilder } = require('discord.js');
const { db } = require('../utils/store_sqlite');
const { isStaffOrDev, tag, getUserPrefix } = require('../utils/roles');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban management (global for the bot)')
    .addSubcommand(sc=>sc.setName('add').setDescription('Ban a user').addUserOption(o=>o.setName('user').setDescription('User').setRequired(true)).addStringOption(o=>o.setName('reason').setDescription('Reason').setRequired(true)).addIntegerOption(o=>o.setName('minutes').setDescription('Duration in minutes (0 = forever)').setRequired(true)))
    .addSubcommand(sc=>sc.setName('remove').setDescription('Unban a user').addUserOption(o=>o.setName('user').setDescription('User').setRequired(true)))
    .addSubcommand(sc=>sc.setName('list').setDescription('List current bans')),
  async execute(interaction){
    const userPrefix = await getUserPrefix(interaction.client, interaction.user);
    if (!(await isStaffOrDev(interaction.client, interaction.user.id))) return interaction.reply({ content: `${userPrefix} Staff/Developer only.`, ephemeral: true });
    const sub = interaction.options.getSubcommand();
    if (sub === 'add'){
      const u = interaction.options.getUser('user');
      const reason = interaction.options.getString('reason');
      const minutes = interaction.options.getInteger('minutes');
      const exp = minutes > 0 ? Date.now() + minutes*60000 : null;
      db.prepare('INSERT OR REPLACE INTO bans(userId, reason, expiresAt) VALUES(?,?,?)').run(u.id, reason, exp);
      logger.info('ban_add: %s banned %s for %s minutes', interaction.user.id, u.id, minutes);
      return interaction.reply(`${userPrefix} Banned <@${u.id}> ${minutes>0?`for ${minutes}m`: 'permanently'} — ${reason}`);
    }
    if (sub === 'remove'){
      const u = interaction.options.getUser('user');
      db.prepare('DELETE FROM bans WHERE userId=?').run(u.id);
      logger.info('ban_remove: %s unbanned %s', interaction.user.id, u.id);
      return interaction.reply(`${userPrefix} Unbanned <@${u.id}>`);
    }
    if (sub === 'list'){
      const rows = db.prepare('SELECT * FROM bans').all();
      if (!rows.length) return interaction.reply(`${userPrefix} No active bans.`);
      const lines = rows.map(r=> `• <@${r.userId}> — ${r.reason} ${r.expiresAt?`(until ${new Date(r.expiresAt).toISOString()})`:''}`);
      return interaction.reply(`${userPrefix} Current bans:\n${lines.join('\n')}`);
    }
  }
};
