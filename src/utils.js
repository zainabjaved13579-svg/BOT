const MAX_LEVEL = 100;
const MAX_LEVEL_XP = MAX_LEVEL ** 2 * 100;
const XP_PER_MESSAGE = 10;

function toSafeString(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

function xpForMessages(messageCount) {
  const count = Number.isFinite(Number(messageCount))
    ? Math.max(0, Math.floor(Number(messageCount)))
    : 0;
  return count * XP_PER_MESSAGE;
}

function normalizeText(value) {
  return toSafeString(value).normalize('NFKC').toLocaleLowerCase().trim();
}

function escapeRegExp(value) {
  return toSafeString(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesWholePhrase(text, phrase) {
  const normalizedText = normalizeText(text);
  const normalizedPhrase = normalizeText(phrase);

  if (!normalizedText || !normalizedPhrase) return false;

  const escaped = escapeRegExp(normalizedPhrase).replace(/\s+/g, '\\s+');
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}($|[^\\p{L}\\p{N}_])`, 'u')
    .test(normalizedText);
}

function shouldRemoveLink(text, linksEnabled, allowInTicket = false) {
  if (!linksEnabled || allowInTicket) return false;
  const value = toSafeString(text);
  if (!value) return false;
  return /\b(?:https?:\/\/|www\.)\S+|\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|gg|me|co|tv|dev|app|xyz|info|site|live)(?:\/\S*)?/i
    .test(value);
}

function memberHasBlockedRole(memberRoleIds, blockedRoleIds) {
  const memberRoles = new Set((Array.isArray(memberRoleIds) ? memberRoleIds : []).map(String));
  const blockedRoles = Array.isArray(blockedRoleIds) ? blockedRoleIds : [];
  return blockedRoles.some(roleId => memberRoles.has(String(roleId)));
}

function isCommandAuthorized(userId, ownerId, memberRoleIds, authorizedRoleIds) {
  if (String(userId) === String(ownerId)) return true;
  const memberRoles = new Set((Array.isArray(memberRoleIds) ? memberRoleIds : []).map(String));
  const authorizedRoles = Array.isArray(authorizedRoleIds) ? authorizedRoleIds : [];
  return authorizedRoles.some(roleId => memberRoles.has(String(roleId)));
}

function levelForXp(xp) {
  const safeXp = Number.isFinite(Number(xp)) ? Math.max(0, Number(xp)) : 0;
  return Math.min(MAX_LEVEL, Math.floor(Math.sqrt(safeXp / 100)));
}

function xpForNextLevel(level) {
  const safeLevel = Number.isFinite(Number(level)) ? Math.max(0, Math.floor(Number(level))) : 0;
  return Math.min(MAX_LEVEL, safeLevel + 1) ** 2 * 100;
}

function getApplicationStep(questions, questionIndex) {
  if (!Array.isArray(questions) || questions.length === 0) return null;

  const index = Number.isFinite(Number(questionIndex))
    ? Math.max(0, Math.floor(Number(questionIndex)))
    : 0;
  if (index >= questions.length) return null;

  const question = questions[index];
  if (question === undefined || question === null) return null;

  return {
    index,
    nextIndex: index + 1,
    question
  };
}

function applyTemplate(template, member, guild) {
  const safeTemplate = toSafeString(template);
  const userName = member?.user?.username ?? member?.username ?? 'Unknown member';
  const guildName = guild?.name ?? 'Unknown server';
  const userMention = member?.id ? `<@${member.id}>` : '@member';

  return safeTemplate
    .replaceAll('{user}', userMention)
    .replaceAll('{username}', userName)
    .replaceAll('{server}', guildName);
}

module.exports = {
  normalizeText,
  matchesWholePhrase,
  shouldRemoveLink,
  memberHasBlockedRole,
  isCommandAuthorized,
  MAX_LEVEL,
  MAX_LEVEL_XP,
  XP_PER_MESSAGE,
  xpForMessages,
  levelForXp,
  xpForNextLevel,
  getApplicationStep,
  applyTemplate
};
