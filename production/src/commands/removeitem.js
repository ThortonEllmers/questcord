const { SlashCommandBuilder } = require('discord.js');
const { db } = require('../utils/store_sqlite');
const config = require('../utils/config');
const { isStaffOrDev, getUserPrefix } = require('../utils/roles');
const logger = require('../utils/logger');

function findItemByIdOrName(q){
  const items = config.items || [];
  return items.find(i => i.id === q) || items.find(i => i.name.toLowerCase() === q.toLowerCase());
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('removeitem')
    .setDescription('Remove an item from a user (Staff/Developer only)')
    .addUserOption(o=>o.setName('user').setDescription('Target user').setRequired(true))
    .addStringOption(o=>o.setName('item').setDescription('Item to remove').setAutocomplete(true).setRequired(true))
    .addIntegerOption(o=>o.setName('amount').setDescription('Quantity (>=1)').setRequired(true)),
  async autocomplete(interaction){
    const focused = interaction.options.getFocused(true);
    if (focused.name !== 'item') return;
    const q = String(focused.value||'').toLowerCase();
    const items = (config.items || []).filter(i => i.id.includes(q) || i.name.toLowerCase().includes(q)).slice(0, 25);
    await interaction.respond(items.map(i=>({ name: `${i.name} (${i.id})`, value: i.id })));
  },
  async execute(interaction){
    const userPrefix = await getUserPrefix(interaction.client, interaction.user);
    if (!(await isStaffOrDev(interaction.client, interaction.user.id))) return interaction.reply({ content: `${userPrefix} Staff/Developer only.`, ephemeral: true });
    const target = interaction.options.getUser('user');
    const itemId = interaction.options.getString('item');
    const amount = Math.max(1, interaction.options.getInteger('amount'));
    const item = findItemByIdOrName(itemId);
    if (!item) return interaction.reply({ content: `${userPrefix} Unknown item. Use the dropdown autocomplete.`, ephemeral: true });
    const inv = db.prepare('SELECT qty FROM inventory WHERE userId=? AND itemId=?').get(target.id, item.id);
    if (!inv || inv.qty < amount) return interaction.reply({ content: `${userPrefix} User does not have enough of that item.`, ephemeral: true });
    db.prepare('UPDATE inventory SET qty=qty-? WHERE userId=? AND itemId=?').run(amount, target.id, item.id);
    db.prepare('DELETE FROM inventory WHERE userId=? AND itemId=? AND qty<=0').run(target.id, item.id);
    logger.info('admin_removeitem: %s removed %s x%s from %s', interaction.user.id, item.id, amount, target.id);
    return interaction.reply(`${userPrefix} Removed **${amount}x ${item.name}** from <@${target.id}>.`);
  }
};
