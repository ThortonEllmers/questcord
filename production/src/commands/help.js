const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { isStaffOrDev, getUserPrefix } = require('../utils/roles');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Display all available commands organized by category')
    .addStringOption(option =>
      option
        .setName('category')
        .setDescription('Show commands from a specific category')
        .addChoices(
          { name: 'General', value: 'general' },
          { name: 'Player Stats', value: 'stats' },
          { name: 'Economy & Trading', value: 'economy' },
          { name: 'Travel & Exploration', value: 'travel' },
          { name: 'Items & Equipment', value: 'items' },
          { name: 'Crafting', value: 'crafting' },
          { name: 'Combat & Bosses', value: 'combat' },
          { name: 'Server Management', value: 'server' },
          { name: 'Staff Commands', value: 'staff' }
        )
    ),

  async execute(interaction) {
    const category = interaction.options.getString('category');
    const isStaff = await isStaffOrDev(interaction.client, interaction.user.id);
    const userPrefix = await getUserPrefix(interaction.client, interaction.user);
    
    if (category) {
      return await this.showCategory(interaction, category, isStaff);
    }
    
    const embed = new EmbedBuilder()
      .setTitle(`${userPrefix} - QuestCord Help`)
      .setDescription('Use `/help category:<name>` to see detailed commands for each category.')
      .setColor(0x00AE86)
      .addFields(
        {
          name: 'General',
          value: 'Basic information and utility commands',
          inline: true
        },
        {
          name: 'Player Stats',
          value: 'Health, stamina, and character info',
          inline: true
        },
        {
          name: 'Economy & Trading',
          value: 'Currency, market, and trading',
          inline: true
        },
        {
          name: 'Travel & Exploration',
          value: 'Movement, locations, and navigation',
          inline: true
        },
        {
          name: 'Items & Equipment',
          value: 'Inventory, equipment, and item usage',
          inline: true
        },
        {
          name: 'Crafting',
          value: 'Item creation and progression',
          inline: true
        },
        {
          name: 'Combat & Bosses',
          value: 'Fighting and boss battles',
          inline: true
        },
        {
          name: 'Server Management',
          value: 'Server settings and tokens',
          inline: true
        }
      );
      
    if (isStaff) {
      embed.addFields({
        name: 'Staff Commands',
        value: 'Administrative and developer tools',
        inline: true
      });
    }

    embed.setFooter({
      text: 'Use /help category:<name> for detailed command lists • QuestCord'
    });
    
    return interaction.reply({ embeds: [embed] });
  },

  async showCategory(interaction, category, isStaff) {
    const embed = new EmbedBuilder().setColor(0x00AE86);
    
    switch (category) {
      case 'general':
        embed.setTitle('General Commands')
          .addFields(
            {
              name: '/help',
              value: 'Display this help system with command categories',
              inline: false
            }
          );
        break;
        
      case 'stats':
        embed.setTitle('📊 Player Stats Commands')
          .addFields(
            {
              name: '/stats',
              value: 'View your current health, stamina, and character statistics',
              inline: false
            },
            {
              name: '/wallet',
              value: 'Check your current Drakari (currency) balance',
              inline: false
            }
          );
        break;
        
      case 'economy':
        embed.setTitle('💰 Economy & Trading Commands')
          .addFields(
            {
              name: '/market list',
              value: 'Browse items currently for sale in the market',
              inline: false
            },
            {
              name: '/market sell <item> <quantity> <price>',
              value: 'List your items for sale on the market',
              inline: false
            },
            {
              name: '/market buy <listing_id>',
              value: 'Purchase an item from the market',
              inline: false
            },
            {
              name: '/market cancel <listing_id>',
              value: 'Cancel your own market listing',
              inline: false
            },
            {
              name: '/wallet',
              value: 'Check your Drakari balance and recent transactions',
              inline: false
            }
          );
        break;
        
      case 'travel':
        embed.setTitle('🗺️ Travel & Exploration Commands')
          .addFields(
            {
              name: '/travel <server_id>',
              value: 'Travel to another server (uses stamina and time)',
              inline: false
            },
            {
              name: '/whereami',
              value: 'Show your current location and server information',
              inline: false
            },
            {
              name: '/nearby',
              value: 'List nearby servers you can travel to',
              inline: false
            }
          );
        break;
        
      case 'items':
        embed.setTitle('🎒 Items & Equipment Commands')
          .addFields(
            {
              name: '/inventory',
              value: 'View all items in your inventory',
              inline: false
            },
            {
              name: '/equip',
              value: 'Interactive dropdown to equip items from your inventory',
              inline: false
            },
            {
              name: '/unequip <slot>',
              value: 'Unequip an item from a specific slot',
              inline: false
            },
            {
              name: '/useitem <item>',
              value: 'Use a consumable item from your inventory',
              inline: false
            }
          );
        break;
        
      case 'crafting':
        embed.setTitle('🔨 Crafting Commands')
          .addFields(
            {
              name: '/craft item <item> [quantity]',
              value: 'Start crafting an item (requires materials and time)',
              inline: false
            },
            {
              name: '/craft status',
              value: 'Check your crafting level, progress, and active crafts',
              inline: false
            },
            {
              name: '/craft recipes [rarity]',
              value: 'Browse available recipes you can craft',
              inline: false
            },
            {
              name: '/craft complete',
              value: 'Collect finished crafted items',
              inline: false
            },
            {
              name: '/craft cancel <craft_id>',
              value: 'Cancel an active craft (50% material refund)',
              inline: false
            }
          )
          .setFooter({ 
            text: 'Crafting Tiers: Apprentice → Journeyman → Expert → Artisan → Master → Grandmaster → Transcendent'
          });
        break;
        
      case 'combat':
        embed.setTitle('⚔️ Combat & Bosses Commands')
          .addFields(
            {
              name: '/boss',
              value: 'View current boss information and participate in battles',
              inline: false
            }
          );
        break;
        
      case 'server':
        embed.setTitle('🏛️ Server Management Commands')
          .addFields(
            {
              name: '/tokens balance',
              value: 'Check your server\'s token balance',
              inline: false
            },
            {
              name: '/tokens buy',
              value: 'Get information on purchasing server tokens',
              inline: false
            },
            {
              name: '/biome',
              value: 'Change your server\'s biome (requires tokens)',
              inline: false
            },
            {
              name: '/relocate country <name>',
              value: 'Move your server to a specific country (requires tokens)',
              inline: false
            },
            {
              name: '/relocate list [continent]',
              value: 'Browse available countries and their token costs',
              inline: false
            },
            {
              name: '/relocate search <query>',
              value: 'Search for countries by name',
              inline: false
            }
          );
        break;
        
      case 'staff':
        if (!isStaff) {
          return interaction.reply({ 
            content: 'You do not have permission to view staff commands.', 
            ephemeral: true 
          });
        }
        
        embed.setTitle('👑 Staff & Developer Commands')
          .addFields(
            {
              name: '/teleport <server_id>',
              value: 'Instantly teleport to any server (staff only)',
              inline: false
            },
            {
              name: '/additem <user> <item> <amount>',
              value: 'Give items to any user',
              inline: false
            },
            {
              name: '/removeitem <user> <item> <amount>',
              value: 'Remove items from any user',
              inline: false
            },
            {
              name: '/setstats <user> <stat> <value>',
              value: 'Set health or stamina for any user',
              inline: false
            },
            {
              name: '/ban add/remove/list',
              value: 'Manage global user bans',
              inline: false
            },
            {
              name: '/server archive/restore/list',
              value: 'Archive, restore, or list servers',
              inline: false
            },
            {
              name: '/clear inventory/equipment <user>',
              value: 'Clear user inventory or equipped items (requires confirmation)',
              inline: false
            }
          )
          .setFooter({ 
            text: 'Role Hierarchy: Developer > Staff > Premium > User (higher roles inherit all lower permissions)'
          });
        break;
        
      default:
        return interaction.reply({ 
          content: 'Invalid category. Use `/help` to see all available categories.', 
          ephemeral: true 
        });
    }
    
    return interaction.reply({ embeds: [embed] });
  }
};