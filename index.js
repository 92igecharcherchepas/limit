const {
  ActionRowBuilder,
  AuditLogEvent,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
} = require('discord.js');
require('dotenv').config();

const { v2FollowUp, v2Reply, v2Send, v2Update } = require('../componentV2');
const { sendRoleRemovalLogSafely } = require('./logger');
const storage = require('./storage');
const token = process.env.DISCORD_TOKEN || process.env.TOKEN;
const botOwnerId = process.env.BOT_OWNER_ID;
const prefix = process.env.PREFIX || '*';
const MAX_ROLE_LIMIT = 250000;
const roleLocks = new Map();

if (!token) {
  throw new Error('La variable DISCORD_TOKEN (ou TOKEN) est manquante dans le fichier .env.');
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

function isOwner(member) {
  return storage.getOwners().includes(member.id);
}

function canManageGuild(userId, permissions) {
  return Boolean(
    permissions?.has(PermissionFlagsBits.Administrator)
    || isOwner({ id: userId })
    || userId === botOwnerId
  );
}

function getRoleId(value) {
  const mention = value?.match(/^<@&(\d+)>$/);
  const id = mention ? mention[1] : value;
  return /^\d{17,20}$/.test(id || '') ? id : null;
}

function getLimitEntries(guild) {
  const limits = storage.getGuildLimits(guild.id);
  return Object.entries(limits).filter(([, limit]) => Number.isInteger(limit) && limit > 0);
}

function buildPanel(guild) {
  const entries = getLimitEntries(guild);
  const logChannelId = storage.getGuildLogChannelId(guild.id);
  const visibleEntries = entries.slice(0, 25);
  const description = entries.length
    ? visibleEntries.map(([roleId, limit]) => {
      const role = guild.roles.cache.get(roleId);
      return `• ${role ? role.toString() : `Rôle supprimé (\`${roleId}\`)`} — **${limit}** membre(s) max.`;
    }).join('\n') + (entries.length > visibleEntries.length ? `\n… et ${entries.length - visibleEntries.length} autre(s).` : '')
    : '*Aucune limite configurée.*';

  const components = [
    new ActionRowBuilder().addComponents(
      new RoleSelectMenuBuilder()
        .setCustomId('limit:set')
        .setPlaceholder('Choisir un rôle et définir son plafond')
        .setMinValues(1)
        .setMaxValues(1)
    ),
  ];

  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('limit:logs:configure')
      .setLabel(logChannelId ? 'Modifier le salon de logs' : 'Configurer le salon de logs')
      .setStyle(ButtonStyle.Primary)
  ));

  const removableEntries = entries.slice(0, 25);
  if (removableEntries.length) {
    const options = removableEntries.map(([roleId, limit]) => {
      const role = guild.roles.cache.get(roleId);
      return {
        label: (role?.name || `Rôle ${roleId}`).slice(0, 100),
        description: `${limit} membre(s) maximum`,
        value: roleId,
      };
    });
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('limit:remove')
        .setPlaceholder('Supprimer une limite')
        .setMinValues(1)
        .setMaxValues(options.length)
        .addOptions(options)
    ));
  }

  return {
    content: `## ⭐ Panel LimitRole — ${guild.name}\n${description}\n\nChoisis un rôle pour définir son plafond. Si le plafond est abaissé, les membres les plus récemment arrivés sur le serveur perdent le rôle en premier.\n\n**Salon de logs :** ${logChannelId ? `<#${logChannelId}> (\`${logChannelId}\`)` : '*Non configuré*'}\n-# Accessible aux administrateurs et aux owners configurés`,
    color: 0x5865f2,
    components,
  };
}

function buildOwnersText() {
  const owners = storage.getOwners();
  const description = owners.length
    ? owners.slice(0, 40).map((id) => `• <@${id}>`).join('\n')
      + (owners.length > 40 ? `\n… et ${owners.length - 40} autre(s).` : '')
    : '*Aucun owner ajouté.*';
  return `## 👑 Gestion des owners\nOwners actuels :\n${description}\n\nChoisis une action dans le menu déroulant.`;
}

function buildSysPanel() {
  return {
    content: buildOwnersText(),
    color: 0x5865f2,
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('sys:action')
          .setPlaceholder('Ajouter ou retirer des owners')
          .setMinValues(1)
          .setMaxValues(1)
          .addOptions(
            { label: 'Ajouter des owners', value: 'add', description: 'Donner accès au panel LimitRole' },
            { label: 'Retirer des owners', value: 'remove', description: 'Retirer cet accès' },
          )
      ),
    ],
  };
}

function buildOwnerUserSelect(action) {
  const verb = action === 'add' ? 'ajouter' : 'retirer';
  return {
    content: `## 👑 Gestion des owners\nSélectionne les membres à **${verb}** comme owners.`,
    color: 0x5865f2,
    components: [
      new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder()
          .setCustomId(`sys:users:${action}`)
          .setPlaceholder(`Membres à ${verb}`)
          .setMinValues(1)
          .setMaxValues(10)
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('sys:back')
          .setLabel('Retour')
          .setStyle(ButtonStyle.Secondary)
      ),
    ],
  };
}

async function withRoleLock(guildId, roleId, callback) {
  const key = `${guildId}:${roleId}`;
  const previous = roleLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const queued = previous.then(() => current, () => current);
  roleLocks.set(key, queued);
  await previous.catch(() => {});
  try {
    return await callback();
  } finally {
    release();
    if (roleLocks.get(key) === queued) roleLocks.delete(key);
  }
}

async function trimRoleToLimit(guild, roleId, limit) {
  return withRoleLock(guild.id, roleId, async () => {
    const role = await guild.roles.fetch(roleId);
    if (!role) throw new Error('Ce rôle n’existe plus sur le serveur.');
    const members = await guild.members.fetch();
    const holders = [...members.values()]
      .filter((member) => member.roles.cache.has(roleId))
      .sort((left, right) => (left.joinedTimestamp || Number.MAX_SAFE_INTEGER)
        - (right.joinedTimestamp || Number.MAX_SAFE_INTEGER));
    const toRemove = holders.slice(limit);
    for (const member of toRemove) {
      await member.roles.remove(role, 'Limite de membres du rôle dépassée');
      await sendRoleRemovalLogSafely(client, {
        guild,
        member,
        role,
        limit,
        assignedBy: null,
      });
    }
    return toRemove.length;
  });
}

async function enforceNewAssignment(member, roleId, limit) {
  return withRoleLock(member.guild.id, roleId, async () => {
    const role = await member.guild.roles.fetch(roleId);
    if (!role) return false;
    const members = await member.guild.members.fetch();
    const holders = [...members.values()].filter((entry) => entry.roles.cache.has(roleId));
    const updatedMember = members.get(member.id);
    if (holders.length <= limit || !updatedMember?.roles.cache.has(roleId)) return false;

    let assignedBy = null;
    try {
      const auditLogs = await member.guild.fetchAuditLogs({ type: AuditLogEvent.MemberRoleUpdate, limit: 6 });
      const recentEntry = auditLogs.entries.find((entry) => {
        if (entry.target?.id !== member.id || Date.now() - entry.createdTimestamp > 15_000) return false;
        return entry.changes.some((change) => change.key === '$add'
          && Array.isArray(change.new)
          && change.new.some((addedRole) => addedRole.id === roleId));
      });
      assignedBy = recentEntry?.executor || null;
    } catch (error) {
      console.warn(`Impossible d’identifier la personne ayant attribué le rôle ${roleId} :`, error.message);
    }

    await updatedMember.roles.remove(role, 'Limite de membres du rôle dépassée');
    await sendRoleRemovalLogSafely(client, {
      guild: member.guild,
      member: updatedMember,
      role,
      limit,
      assignedBy,
    });
    try {
      await v2Send(updatedMember, `Le rôle **${role.name}** t’a été retiré : son nombre maximum de membres est atteint.`);
    } catch (error) {
      console.warn(`Impossible d’envoyer le message privé à ${updatedMember.user.tag}:`, error.message);
    }
    return true;
  });
}

async function handleLimitCommand(message, args) {
  if (!canManageGuild(message.author.id, message.member?.permissions)) {
    await v2Reply(message, 'Seuls les administrateurs et les owners configurés peuvent gérer les limites.');
    return;
  }

  if (args[0]?.toLowerCase() === 'remove') {
    const roleId = getRoleId(args[1]);
    if (!roleId) {
      await v2Reply(message, `Utilisation : \`${prefix}limit remove @rôle\``);
      return;
    }
    const limits = storage.getGuildLimits(message.guild.id);
    if (!Object.hasOwn(limits, roleId)) {
      await v2Reply(message, 'Ce rôle n’a pas de limite configurée.');
      return;
    }
    storage.removeGuildLimit(message.guild.id, roleId);
    await v2Reply(message, `La limite du rôle <@&${roleId}> a été supprimée.`);
    return;
  }

  const roleId = getRoleId(args[0]);
  const limit = Number(args[1]);
  const role = roleId && await message.guild.roles.fetch(roleId);
  if (!role || role.id === message.guild.id || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ROLE_LIMIT) {
    await v2Reply(message, `Utilisation : \`${prefix}limit @rôle nombre\` (nombre entre 1 et ${MAX_ROLE_LIMIT}).`);
    return;
  }

  storage.setGuildLimit(message.guild.id, role.id, limit);
  const removed = await trimRoleToLimit(message.guild, role.id, limit);
  await v2Reply(message, `Limite définie pour ${role} : **${limit}** membre(s) maximum.${removed ? ` ${removed} membre(s) ont perdu le rôle pour respecter la limite.` : ''}`);
}

async function handleMessage(message) {
  if (message.author.bot || !message.guild || !message.content.startsWith(prefix)) return;
  const [command, ...args] = message.content.slice(prefix.length).trim().split(/\s+/);
  switch (command?.toLowerCase()) {
    case 'help':
    case 'aide':
      await v2Reply(message, {
        content: [
          '##  Aide — LimitRole',
          `**${prefix}limit @rôle nombre** — fixe le nombre maximum de membres pouvant avoir ce rôle.`,
          `**${prefix}limit remove @rôle** — supprime la limite de ce rôle.`,
          `**${prefix}panel** — ouvre le panel pour gérer les limites et configurer le salon de logs.`,
          `**${prefix}sys** — ouvre la gestion des owners (réservée au propriétaire principal).`,
          `**${prefix}help** — affiche cette aide.`,
          '',
          'La gestion des rôles et le panel sont réservés aux administrateurs et aux owners configurés.',
        ].join('\n'),
        color: 0x5865f2,
      });
      break;
    case 'limit':
    case 'limitrole':
      await handleLimitCommand(message, args);
      break;
    case 'panel':
      if (!canManageGuild(message.author.id, message.member?.permissions)) {
        await v2Reply(message, 'Seuls les administrateurs et les owners configurés peuvent ouvrir ce panel.');
        return;
      }
      await v2Reply(message, buildPanel(message.guild));
      break;
    case 'sys':
      if (!botOwnerId || message.author.id !== botOwnerId) {
        await v2Reply(message, 'Seul le propriétaire principal configuré dans `BOT_OWNER_ID` peut gérer les owners.');
        return;
      }
      await v2Reply(message, buildSysPanel());
      break;
    default:
      break;
  }
}

async function handleInteraction(interaction) {
  if (!interaction.inGuild()) return;
  const customId = interaction.customId || '';
  if (!customId.startsWith('limit:') && !customId.startsWith('sys:')) return;

  if (customId.startsWith('sys:')) {
    if (!botOwnerId || interaction.user.id !== botOwnerId) {
      await v2Reply(interaction, { content: 'Seul le propriétaire principal configuré dans `BOT_OWNER_ID` peut gérer les owners.', ephemeral: true });
      return;
    }
    if (interaction.isStringSelectMenu() && customId === 'sys:action') {
      await v2Update(interaction, buildOwnerUserSelect(interaction.values[0]));
      return;
    }
    if (interaction.isUserSelectMenu() && customId.startsWith('sys:users:')) {
      const action = customId.slice('sys:users:'.length);
      if (action !== 'add' && action !== 'remove') return;
      const owners = new Set(storage.getOwners());
      for (const userId of interaction.values) {
        if (action === 'add') owners.add(userId);
        else if (userId !== botOwnerId) owners.delete(userId);
      }
      storage.setOwners([...owners]);
      await v2Update(interaction, buildSysPanel());
      return;
    }
    if (interaction.isButton() && customId === 'sys:back') {
      await v2Update(interaction, buildSysPanel());
    }
    return;
  }

  if (!canManageGuild(interaction.user.id, interaction.memberPermissions)) {
    await v2Reply(interaction, { content: 'Seuls les administrateurs et les owners configurés peuvent utiliser ce panel.', ephemeral: true });
    return;
  }

  if (interaction.isRoleSelectMenu() && customId === 'limit:set') {
    const roleId = interaction.values[0];
    if (roleId === interaction.guild.id) {
      await v2Reply(interaction, { content: 'Le rôle @everyone ne peut pas avoir de limite.', ephemeral: true });
      return;
    }
    const modal = new ModalBuilder()
      .setCustomId(`limit:modal:${interaction.guild.id}:${roleId}`)
      .setTitle('Définir la limite du rôle');
    const input = new TextInputBuilder()
      .setCustomId('limit:number')
      .setLabel(`Nombre maximum (1-${MAX_ROLE_LIMIT})`)
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMinLength(1)
      .setMaxLength(6)
      .setPlaceholder('Exemple : 1');
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
    return;
  }

  if (interaction.isStringSelectMenu() && customId === 'limit:remove') {
    for (const roleId of interaction.values) {
      storage.removeGuildLimit(interaction.guild.id, roleId);
    }
    await v2Update(interaction, buildPanel(interaction.guild));
    return;
  }

  if (interaction.isButton() && customId === 'limit:logs:configure') {
    const modal = new ModalBuilder()
      .setCustomId('limit:logs:modal')
      .setTitle('Configurer le salon de logs');
    const input = new TextInputBuilder()
      .setCustomId('limit:logs:channel')
      .setLabel('ID ou mention du salon (serveur externe)')
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(25)
      .setPlaceholder('Exemple : 123456789012345678');
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
    return;
  }

  if (interaction.isModalSubmit() && customId === 'limit:logs:modal') {
    const value = interaction.fields.getTextInputValue('limit:logs:channel').trim();
    const channelId = value.match(/^<#(\d{17,20})>$/)?.[1] || value;
    if (value && !/^\d{17,20}$/.test(channelId)) {
      await v2Reply(interaction, {
        content: 'ID ou mention invalide. Copie l’identifiant du salon ou sa mention Discord.',
        ephemeral: true,
      });
      return;
    }

    if (!channelId) {
      storage.setGuildLogChannelId(interaction.guild.id, null);
      const panel = buildPanel(interaction.guild);
      await v2Update(interaction, {
        ...panel,
        content: `${panel.content}\n-# Salon de logs désactivé.`,
      });
      return;
    }

    let channel;
    try {
      channel = await client.channels.fetch(channelId);
    } catch (error) {
      console.error(`Impossible de récupérer le salon de logs ${channelId} :`, error);
      await v2Reply(interaction, {
        content: 'Je ne peux pas accéder à ce salon. Vérifie son ID et que le bot a rejoint le serveur de destination.',
        ephemeral: true,
      });
      return;
    }

    const permissions = channel?.guild && channel.isSendable()
      && typeof channel.permissionsFor === 'function'
      ? channel.permissionsFor(client.user)
      : null;
    if (!channel?.guild || !channel.isTextBased() || !channel.isSendable()
      || !permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
      await v2Reply(interaction, {
        content: 'Je ne trouve pas ce salon, ou je n’ai pas les permissions **Voir le salon** et **Envoyer des messages**. Vérifie que le bot a rejoint le serveur des logs.',
        ephemeral: true,
      });
      return;
    }

    storage.setGuildLogChannelId(interaction.guild.id, channel.id);
    const panel = buildPanel(interaction.guild);
    panel.content += `\n-# Salon de logs configuré sur **${channel.guild.name}**.`;
    await v2Update(interaction, panel);
    return;
  }

  if (interaction.isModalSubmit() && customId.startsWith('limit:modal:')) {
    const [, , guildId, roleId] = customId.split(':');
    const limit = Number(interaction.fields.getTextInputValue('limit:number'));
    if (guildId !== interaction.guild.id || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ROLE_LIMIT) {
      await v2Reply(interaction, { content: `Entre un nombre entier entre 1 et ${MAX_ROLE_LIMIT}.`, ephemeral: true });
      return;
    }
    const role = await interaction.guild.roles.fetch(roleId);
    if (!role || role.id === interaction.guild.id) {
      await v2Reply(interaction, { content: 'Ce rôle n’existe plus ou ne peut pas être limité.', ephemeral: true });
      return;
    }
    storage.setGuildLimit(interaction.guild.id, role.id, limit);
    const removed = await trimRoleToLimit(interaction.guild, role.id, limit);
    const panel = buildPanel(interaction.guild);
    panel.content += `\n-# Limite enregistrée${removed ? ` — ${removed} membre(s) retiré(s)` : ''}`;
    await v2Update(interaction, panel);
  }
}

client.on(Events.MessageCreate, (message) => {
  handleMessage(message).catch((error) => {
    console.error('Erreur lors du traitement d’une commande LimitRole :', error);
    if (message.channel.isSendable()) {
      v2Reply(message, 'Une erreur est survenue. Vérifie les permissions du bot et la hiérarchie des rôles.').catch((replyError) => {
        console.error('Impossible de répondre à la commande LimitRole :', replyError);
      });
    }
  });
});

client.on(Events.InteractionCreate, (interaction) => {
  handleInteraction(interaction).catch(async (error) => {
    console.error('Erreur lors du traitement d’une interaction LimitRole :', error);
    const response = { content: 'Une erreur est survenue. Vérifie les permissions du bot et la hiérarchie des rôles.', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await v2FollowUp(interaction, response).catch((replyError) => console.error('Impossible de signaler l’erreur :', replyError));
    } else {
      await v2Reply(interaction, response).catch((replyError) => console.error('Impossible de signaler l’erreur :', replyError));
    }
  });
});

client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
  try {
    const addedRoleIds = newMember.roles.cache
      .filter((role) => !oldMember.roles.cache.has(role.id))
      .map((role) => role.id);
    const limits = storage.getGuildLimits(newMember.guild.id);
    for (const roleId of addedRoleIds) {
      const limit = limits[roleId];
      if (!Number.isInteger(limit) || limit < 1) continue;
      enforceNewAssignment(newMember, roleId, limit).catch((error) => {
        console.error(`Impossible d’appliquer la limite du rôle ${roleId} sur ${newMember.guild.id} :`, error);
      });
    }
  } catch (error) {
    console.error(`Impossible de charger les limites des rôles pour ${newMember.guild.id} :`, error);
  }
});

client.once(Events.ClientReady, (readyClient) => {
  readyClient.user.setStatus('dnd');
  console.log(`LimitRole connecté en tant que ${readyClient.user.tag}`);
  if (!botOwnerId) console.warn('BOT_OWNER_ID n’est pas défini : la commande *sys est désactivée.');
});

client.login(token).catch((error) => {
  console.error('Connexion Discord impossible :', error);
  process.exitCode = 1;
});
