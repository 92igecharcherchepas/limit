const fs = require('node:fs');
const path = require('node:path');

const dataDirectory = path.join(__dirname, 'data');
const limitsFile = path.join(dataDirectory, 'limits.json');
const ownersFile = path.join(dataDirectory, 'owners.json');
const settingsFile = path.join(dataDirectory, 'settings.json');

function ensureFile(filePath, initialValue) {
  fs.mkdirSync(dataDirectory, { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `${JSON.stringify(initialValue, null, 2)}\n`, 'utf8');
  }
}

function readJson(filePath, initialValue) {
  ensureFile(filePath, initialValue);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  ensureFile(filePath, {});
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function getOwners() {
  const data = readJson(ownersFile, { owners: [] });
  if (!Array.isArray(data.owners) || data.owners.some((id) => typeof id !== 'string')) {
    throw new Error('Le fichier data/owners.json doit contenir une liste "owners" de Discord IDs.');
  }
  return [...new Set(data.owners)];
}

function setOwners(owners) {
  writeJson(ownersFile, { owners: [...new Set(owners)] });
}

function getGuildLimits(guildId) {
  const data = readJson(limitsFile, {});
  const limits = data[guildId] || {};
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) {
    throw new Error(`Les limites enregistrées pour le serveur ${guildId} sont invalides.`);
  }
  return { ...limits };
}

function setGuildLimit(guildId, roleId, limit) {
  const data = readJson(limitsFile, {});
  if (!data[guildId] || typeof data[guildId] !== 'object' || Array.isArray(data[guildId])) {
    data[guildId] = {};
  }
  data[guildId][roleId] = limit;
  writeJson(limitsFile, data);
}

function removeGuildLimit(guildId, roleId) {
  const data = readJson(limitsFile, {});
  if (data[guildId] && typeof data[guildId] === 'object') {
    delete data[guildId][roleId];
    if (Object.keys(data[guildId]).length === 0) delete data[guildId];
    writeJson(limitsFile, data);
  }
}

function getGuildLogChannelId(guildId) {
  const data = readJson(settingsFile, {});
  const channelId = data[guildId]?.logChannelId;
  if (channelId != null && typeof channelId !== 'string') {
    throw new Error(`Le salon de logs configuré pour le serveur ${guildId} est invalide.`);
  }
  return channelId || null;
}

function setGuildLogChannelId(guildId, channelId) {
  const data = readJson(settingsFile, {});
  const settings = data[guildId] && typeof data[guildId] === 'object' && !Array.isArray(data[guildId])
    ? data[guildId]
    : {};
  if (channelId) settings.logChannelId = channelId;
  else delete settings.logChannelId;
  if (Object.keys(settings).length) data[guildId] = settings;
  else delete data[guildId];
  writeJson(settingsFile, data);
}

module.exports = {
  getOwners,
  setOwners,
  getGuildLimits,
  setGuildLimit,
  removeGuildLimit,
  getGuildLogChannelId,
  setGuildLogChannelId,
};
