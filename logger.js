const {
  ContainerBuilder,
  MessageFlags,
  TextDisplayBuilder,
} = require('discord.js');
const storage = require('./storage');

const missingChannelWarnings = new Set();

function describeUser(user) {
  return user ? `<@${user.id}> (\`${user.tag}, ${user.id}\`)` : '*Non identifié*';
}

async function sendRoleRemovalLog(client, {
  guild,
  member,
  role,
  limit,
  assignedBy,
}) {
  const logChannelId = storage.getGuildLogChannelId(guild.id);
  if (!logChannelId) {
    if (!missingChannelWarnings.has(guild.id)) {
      console.warn(`Aucun salon de logs n’est configuré dans le panel pour ${guild.name} (${guild.id}).`);
      missingChannelWarnings.add(guild.id);
    }
    return;
  }

  const channel = await client.channels.fetch(logChannelId);
  if (!channel?.isSendable()) {
    throw new Error(`Le salon de logs ${logChannelId} est introuvable ou ne peut pas recevoir de messages.`);
  }

  const workerId = process.env.WORKER_ID || client.shard?.ids?.[0] || 0;
  const limitLabel = `${limit} membre${limit === 1 ? '' : 's'}, déjà atteinte`;
  const content = [
    '## ⭐ Super limite : rôle retiré',
    `> 👤 **Membre :** ${describeUser(member.user)}`,
    `> ⭐ **Rôle :** ${role} (\`${role.name}, ${role.id}\`)`,
    `> 👥 **Limite :** ${limitLabel}`,
    `> 👤 **Donné par :** ${describeUser(assignedBy)}`,
    `> 🔒 **Retiré par :** le worker /${workerId}`,
  ].join('\n');

  const container = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(content));
  await channel.send({
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowedMentions: { parse: [] },
  });
}

async function sendRoleRemovalLogSafely(client, details) {
  try {
    await sendRoleRemovalLog(client, details);
  } catch (error) {
    console.error('Impossible d’envoyer le journal de retrait de rôle :', error);
  }
}

module.exports = { sendRoleRemovalLogSafely };
