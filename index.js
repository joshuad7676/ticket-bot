// ticket-bot — editable panel + dropdown + ticket message
// discord.js v14 | Node 18+ | pure JS (no native deps)
// Run: node index.js

require('dotenv').config();
const fs = require('fs');
const express = require('express');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  MessageFlags,
} = require('discord.js');

// ---------- ENV ----------
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = (process.env.GUILD_ID || '').trim();
const BOT_PASSWORD = process.env.BOT_PASSWORD || '879';
const PORT = Number(process.env.PORT || 3002);

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('Missing DISCORD_TOKEN / CLIENT_ID / GUILD_ID in .env');
  process.exit(1);
}

// ---------- KEEP-ALIVE ----------
const app = express();
app.get('/', (req, res) => res.status(200).send('Ticket bot is alive'));
const server = app.listen(PORT, () => console.log(`Keep-alive server on port ${PORT}`));
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use (another bot still running?).`);
    console.error(`Fix: stop the other window, OR set a different PORT in .env and restart.`);
    process.exit(1);
  }
  throw err;
});

// ---------- STATE ----------
const authorized = new Set(); // user IDs that entered password
const CONFIG_FILE = 'ticket-config.json';
const config = {
  panelChannelId: null,
  panelMessageId: null,
  panelTitle: '🎫 Need help? Open a ticket',
  panelDescription: 'Choose a reason below to open a private ticket.\nStaff will help you soon.',
  panelPlaceholder: 'Select a reason...',
  panelColor: '#5865F2',
  options: [
    { label: 'General Support', description: 'General questions and help', emoji: '💬' },
    { label: 'Report a Player', description: 'Report rule breaking', emoji: '🚨' },
    { label: 'Appeal', description: 'Appeal a punishment', emoji: '⚖️' },
  ],
  ticketMessage: 'Hello {user}! Your ticket for **{reason}** was created.\nStaff will be with you shortly.\n\nUse `/close` or the button below to close this ticket.',
  categoryId: null,   // tickets are created here if set
  staffRoleId: null,  // staff can see all tickets if set
};
try {
  if (fs.existsSync(CONFIG_FILE)) Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
} catch (e) { console.error('config load:', e.message); }
function saveConfig() {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch (e) {}
}

// ---------- CLIENT ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // for the "i wanna use you please" ping phrase
  ],
});

// ---------- HELPERS ----------
function isUnlocked(userId) {
  return authorized.has(userId);
}
async function requireMyGuild(interaction) {
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({ content: '❌ Only works inside a server, not in DMs.', flags: MessageFlags.Ephemeral });
    return false;
  }
  if (interaction.guildId !== GUILD_ID) {
    await interaction.reply({ content: '❌ Refused: wrong server (check GUILD_ID).', flags: MessageFlags.Ephemeral });
    return false;
  }
  return true;
}
async function requireUnlock(interaction) {
  if (!isUnlocked(interaction.user.id)) {
    await interaction.reply({
      content: '🔒 Locked. Ping me with "i wanna use you please" or use `/unlock password:xxx` first.',
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }
  return true;
}
function parseColor(str) {
  const fallback = 0x5865f2;
  if (!str) return fallback;
  const hex = str.trim().replace('#', '');
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return parseInt(hex, 16);
  return fallback;
}
function buildPanelEmbed() {
  return new EmbedBuilder()
    .setTitle(config.panelTitle)
    .setDescription(config.panelDescription)
    .setColor(parseColor(config.panelColor));
}
function buildPanelRow() {
  const opts = config.options.slice(0, 25).map(o => {
    const opt = { label: o.label.slice(0, 100), value: o.label.slice(0, 100), description: (o.description || '').slice(0, 100) };
    if (o.emoji) opt.emoji = o.emoji;
    return opt;
  });
  const menu = new StringSelectMenuBuilder()
    .setCustomId('ticket_select')
    .setPlaceholder(config.panelPlaceholder || 'Select a reason...')
    .addOptions(opts.length ? opts : [{ label: 'Open Ticket', value: 'Open Ticket' }]);
  return new ActionRowBuilder().addComponents(menu);
}
function buildCloseRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('close_ticket').setLabel('Close Ticket').setStyle(ButtonStyle.Danger)
  );
}
async function postPanel(guild, channel) {
  const embed = buildPanelEmbed();
  const row = buildPanelRow();
  const msg = await channel.send({ embeds: [embed], components: [row] });
  config.panelChannelId = channel.id;
  config.panelMessageId = msg.id;
  saveConfig();
  return msg;
}
async function refreshPanel(guild) {
  // re-edit the existing panel message so option/message edits show up
  if (!config.panelChannelId || !config.panelMessageId) return false;
  try {
    const ch = await guild.channels.fetch(config.panelChannelId);
    if (!ch?.isTextBased()) return false;
    const msg = await ch.messages.fetch(config.panelMessageId);
    await msg.edit({ embeds: [buildPanelEmbed()], components: [buildPanelRow()] });
    return true;
  } catch { return false; }
}
function isTicketChannel(channel) {
  if (!channel) return false;
  if (channel.name?.startsWith('ticket-')) return true;
  if (config.categoryId && channel.parentId === config.categoryId) return true;
  return false;
}

// ---------- SLASH COMMANDS ----------
const commands = [
  new SlashCommandBuilder()
    .setName('unlock')
    .setDescription('Unlock setup commands with the password')
    .addStringOption(o => o.setName('password').setDescription('Bot password').setRequired(true)),

  new SlashCommandBuilder()
    .setName('setup-panel')
    .setDescription('Post the ticket panel (custom message + dropdown)')
    .addChannelOption(o => o.setName('channel').setDescription('Where to post?').setRequired(true))
    .addStringOption(o => o.setName('title').setDescription('Panel title').setRequired(false))
    .addStringOption(o => o.setName('description').setDescription('Panel message').setRequired(false))
    .addStringOption(o => o.setName('placeholder').setDescription('Dropdown placeholder').setRequired(false))
    .addStringOption(o => o.setName('color').setDescription('Hex color, e.g. #5865F2').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('edit-panel')
    .setDescription('Edit the panel message in place (no repost)')
    .addStringOption(o => o.setName('title').setDescription('New title').setRequired(false))
    .addStringOption(o => o.setName('description').setDescription('New message').setRequired(false))
    .addStringOption(o => o.setName('placeholder').setDescription('New dropdown placeholder').setRequired(false))
    .addStringOption(o => o.setName('color').setDescription('Hex color, e.g. #5865F2').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('add-option')
    .setDescription('Add a dropdown reason (what users pick to open a ticket)')
    .addStringOption(o => o.setName('label').setDescription('E.g. General Support').setRequired(true))
    .addStringOption(o => o.setName('description').setDescription('E.g. General questions').setRequired(false))
    .addStringOption(o => o.setName('emoji').setDescription('E.g. 💬').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('remove-option')
    .setDescription('Remove a dropdown reason by label')
    .addStringOption(o => o.setName('label').setDescription('Exact label').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('options')
    .setDescription('List current dropdown reasons')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('set-ticket-message')
    .setDescription('Edit the message sent when a ticket is opened ({user} {reason})')
    .addStringOption(o => o.setName('message').setDescription('Welcome text').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('set-category')
    .setDescription('Tickets get created inside this category')
    .addChannelOption(o => o.setName('category').setDescription('Category').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('set-staff')
    .setDescription('Staff role that can see all tickets')
    .addRoleOption(o => o.setName('role').setDescription('Staff role').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('ticket-config')
    .setDescription('Show current panel/options/ticket settings')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  // usable by anyone inside their own ticket:
  new SlashCommandBuilder()
    .setName('close')
    .setDescription('Close this ticket')
    .addStringOption(o => o.setName('reason').setDescription('Why?').setRequired(false)),
  new SlashCommandBuilder()
    .setName('add')
    .setDescription('Add a user to this ticket')
    .addUserOption(o => o.setName('user').setDescription('Who?').setRequired(true)),
  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove a user from this ticket')
    .addUserOption(o => o.setName('user').setDescription('Who?').setRequired(true)),
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log('Slash commands registered to guild', GUILD_ID);
}

// ---------- EVENTS ----------
client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (e) {
    console.error('Command register failed:', e.status, e.code, e.message);
  }
});

// password ping phrase
client.on('messageCreate', async (msg) => {
  if (msg.author.bot || !msg.guild) return;
  if (msg.mentions.users.has(client.user.id) && msg.content.toLowerCase().includes('i wanna use you please')) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('unlock_btn').setLabel('Enter Password').setStyle(ButtonStyle.Primary)
    );
    await msg.reply({ content: 'Click below to enter the password:', components: [row] });
  }
});

// ---------- INTERACTIONS ----------
client.on('interactionCreate', async (interaction) => {
  try {
    // unlock button -> modal
    if (interaction.isButton() && interaction.customId === 'unlock_btn') {
      const modal = new ModalBuilder().setCustomId('unlock_modal').setTitle('Enter password:');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('password').setLabel('Enter password:').setStyle(TextInputStyle.Short).setRequired(true)
      ));
      return interaction.showModal(modal);
    }
    if (interaction.isModalSubmit() && interaction.customId === 'unlock_modal') {
      const pw = interaction.fields.getTextInputValue('password');
      if (pw === BOT_PASSWORD) {
        authorized.add(interaction.user.id);
        return interaction.reply({ content: '✅ Unlocked!', flags: MessageFlags.Ephemeral });
      }
      return interaction.reply({ content: '❌ Wrong password.', flags: MessageFlags.Ephemeral });
    }

    // dropdown pick -> open ticket (NO unlock needed, anyone can use)
    if (interaction.isStringSelectMenu() && interaction.customId === 'ticket_select') {
      if (!interaction.inGuild()) return interaction.reply({ content: '❌ Only in servers.', flags: MessageFlags.Ephemeral });
      if (interaction.guildId !== GUILD_ID) return interaction.reply({ content: '❌ Wrong server.', flags: MessageFlags.Ephemeral });
      const picked = interaction.values[0];
      const opt = config.options.find(o => o.label === picked) || { label: picked };
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const safe = interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) || 'user';
      const overwrites = [
        { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      ];
      if (config.staffRoleId) {
        overwrites.push({ id: config.staffRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
      }
      const ch = await interaction.guild.channels.create({
        name: `ticket-${safe}-${Math.floor(1000 + Math.random() * 9000)}`,
        type: ChannelType.GuildText,
        parent: config.categoryId || undefined,
        permissionOverwrites: overwrites,
        reason: `Ticket by ${interaction.user.tag} (${opt.label})`,
      });
      const text = config.ticketMessage.replaceAll('{user}', `<@${interaction.user.id}>`).replaceAll('{reason}', opt.label);
      await ch.send({ content: text, components: [buildCloseRow()] });
      if (config.staffRoleId) await ch.send(`<@&${config.staffRoleId}> new ticket: **${opt.label}** from <@${interaction.user.id}>`);
      return interaction.editReply(`✅ Ticket opened: ${ch}`);
    }

    // close button inside ticket
    if (interaction.isButton() && interaction.customId === 'close_ticket') {
      if (!interaction.inGuild()) return;
      const ch = interaction.channel;
      if (!isTicketChannel(ch)) return interaction.reply({ content: '❌ Not a ticket channel.', flags: MessageFlags.Ephemeral });
      await interaction.reply('🔒 Closing in 5 seconds...');
      setTimeout(() => ch.delete(`Closed by ${interaction.user.tag}`).catch(() => {}), 5000);
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    // /unlock — open to everyone
    if (interaction.commandName === 'unlock') {
      const pw = interaction.options.getString('password', true);
      if (pw === BOT_PASSWORD) {
        authorized.add(interaction.user.id);
        return interaction.reply({ content: '✅ Unlocked!', flags: MessageFlags.Ephemeral });
      }
      return interaction.reply({ content: '❌ Wrong password.', flags: MessageFlags.Ephemeral });
    }

    // /close /add /remove work inside tickets WITHOUT unlock (opener + staff)
    if (interaction.commandName === 'close' || interaction.commandName === 'add' || interaction.commandName === 'remove') {
      if (!(await requireMyGuild(interaction))) return;
      const ch = interaction.channel;
      if (!isTicketChannel(ch)) return interaction.reply({ content: '❌ Run this inside a ticket channel.', flags: MessageFlags.Ephemeral });
      const member = interaction.member;
      const isStaff = config.staffRoleId ? member.roles.cache.has(config.staffRoleId) : false;
      const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator) || member.permissions.has(PermissionFlagsBits.ManageGuild);

      if (interaction.commandName === 'close') {
        // anyone in the ticket can close if no staff role set; else opener/staff/admin
        await interaction.reply('🔒 Closing in 5 seconds...');
        setTimeout(() => ch.delete(`Closed by ${interaction.user.tag}`).catch(() => {}), 5000);
        return;
      }
      if (!isStaff && !isAdmin) {
        return interaction.reply({ content: '❌ Only staff can add/remove users.', flags: MessageFlags.Ephemeral });
      }
      const user = interaction.options.getUser('user', true);
      if (interaction.commandName === 'add') {
        await ch.permissionOverwrites.edit(user.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
        return interaction.reply(`✅ Added <@${user.id}>`);
      } else {
        await ch.permissionOverwrites.delete(user.id).catch(() => {});
        return interaction.reply(`✅ Removed <@${user.id}>`);
      }
    }

    // everything below needs my guild + unlock
    if (!(await requireMyGuild(interaction))) return;
    if (!(await requireUnlock(interaction))) return;
    const guild = interaction.guild;

    if (interaction.commandName === 'setup-panel') {
      const channel = interaction.options.getChannel('channel', true);
      const title = interaction.options.getString('title');
      const description = interaction.options.getString('description');
      const placeholder = interaction.options.getString('placeholder');
      const color = interaction.options.getString('color');
      if (channel.type !== ChannelType.GuildText) return interaction.reply({ content: '❌ Pick a text channel.', flags: MessageFlags.Ephemeral });
      if (title) config.panelTitle = title;
      if (description) config.panelDescription = description;
      if (placeholder) config.panelPlaceholder = placeholder;
      if (color) config.panelColor = color;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const msg = await postPanel(guild, channel);
      return interaction.editReply(`✅ Panel posted in ${channel} (message ${msg.id})`);
    }

    if (interaction.commandName === 'edit-panel') {
      const title = interaction.options.getString('title');
      const description = interaction.options.getString('description');
      const placeholder = interaction.options.getString('placeholder');
      const color = interaction.options.getString('color');
      if (title) config.panelTitle = title;
      if (description) config.panelDescription = description;
      if (placeholder) config.panelPlaceholder = placeholder;
      if (color) config.panelColor = color;
      saveConfig();
      const ok = await refreshPanel(guild);
      return interaction.reply({ content: ok ? '✅ Panel updated.' : '⚠️ Saved, but no panel posted yet — run /setup-panel first.', flags: MessageFlags.Ephemeral });
    }

    if (interaction.commandName === 'add-option') {
      const label = interaction.options.getString('label', true);
      const description = interaction.options.getString('description') || '';
      const emoji = interaction.options.getString('emoji') || '';
      if (config.options.some(o => o.label.toLowerCase() === label.toLowerCase())) {
        return interaction.reply({ content: '❌ That label already exists.', flags: MessageFlags.Ephemeral });
      }
      if (config.options.length >= 25) return interaction.reply({ content: '❌ Max 25 options.', flags: MessageFlags.Ephemeral });
      config.options.push({ label, description, emoji });
      saveConfig();
      await refreshPanel(guild);
      return interaction.reply({ content: `✅ Added "${label}" (${config.options.length} total). Panel refreshed.`, flags: MessageFlags.Ephemeral });
    }

    if (interaction.commandName === 'remove-option') {
      const label = interaction.options.getString('label', true);
      const before = config.options.length;
      config.options = config.options.filter(o => o.label.toLowerCase() !== label.toLowerCase());
      if (config.options.length === before) return interaction.reply({ content: '❌ No option with that label.', flags: MessageFlags.Ephemeral });
      saveConfig();
      await refreshPanel(guild);
      return interaction.reply({ content: `✅ Removed "${label}". Panel refreshed.`, flags: MessageFlags.Ephemeral });
    }

    if (interaction.commandName === 'options') {
      const list = config.options.map((o, i) => `${i + 1}. **${o.label}** ${o.emoji || ''} — ${o.description || 'no description'}`).join('\n') || 'none';
      return interaction.reply({ content: `📋 Dropdown reasons:\n${list}`, flags: MessageFlags.Ephemeral });
    }

    if (interaction.commandName === 'set-ticket-message') {
      config.ticketMessage = interaction.options.getString('message', true);
      saveConfig();
      return interaction.reply({ content: '✅ Ticket message updated. Use {user} and {reason} as placeholders.', flags: MessageFlags.Ephemeral });
    }

    if (interaction.commandName === 'set-category') {
      const cat = interaction.options.getChannel('category', true);
      if (cat.type !== ChannelType.GuildCategory) return interaction.reply({ content: '❌ Pick a category channel.', flags: MessageFlags.Ephemeral });
      config.categoryId = cat.id;
      saveConfig();
      return interaction.reply({ content: `✅ New tickets will open in **${cat.name}**`, flags: MessageFlags.Ephemeral });
    }

    if (interaction.commandName === 'set-staff') {
      const role = interaction.options.getRole('role', true);
      config.staffRoleId = role.id;
      saveConfig();
      return interaction.reply({ content: `✅ Staff role set to **${role.name}**`, flags: MessageFlags.Ephemeral });
    }

    if (interaction.commandName === 'ticket-config') {
      const cat = config.categoryId ? `<#${config.categoryId}>` : 'not set';
      const staff = config.staffRoleId ? `<@&${config.staffRoleId}>` : 'not set';
      const opts = config.options.map(o => `• ${o.label}`).join('\n') || 'none';
      return interaction.reply({
        content: `⚙️ **Ticket config**\nPanel: "${config.panelTitle}" in <#${config.panelChannelId || '?'}>\nPlaceholder: ${config.panelPlaceholder}\nCategory: ${cat} | Staff: ${staff}\nOptions:\n${opts}\nTicket msg: ${config.ticketMessage.slice(0, 500)}`,
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (e) {
    console.error('interaction:', e);
    try {
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: `❌ Error: ${e.message}`, flags: MessageFlags.Ephemeral });
      } else if (interaction.isRepliable() && interaction.deferred) {
        await interaction.editReply(`❌ Error: ${e.message}`);
      }
    } catch {}
  }
});

client.login(TOKEN);
