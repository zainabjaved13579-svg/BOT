const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_LEVEL,
  MAX_LEVEL_XP,
  XP_PER_MESSAGE,
  findUsedInvite,
  formatApplicationAnswers,
  getApplicationStep,
  isGlobalCommandAdmin,
  isCommandAuthorized,
  levelForXp,
  memberHasBlockedRole,
  matchesWholePhrase,
  shouldRemoveLink,
  xpForMessages,
  xpForNextLevel
} = require('../src/utils');

test('auto-reply and moderation phrase matching ignores case and respects word boundaries', () => {
  assert.equal(matchesWholePhrase('Can someone HELP me?', 'help'), true);
  assert.equal(matchesWholePhrase('helpful advice', 'help'), false);
  assert.equal(matchesWholePhrase('Need STAFF help now', 'staff help'), true);
});

test('link moderation respects the partnership-ticket exception', () => {
  assert.equal(shouldRemoveLink('Visit https://example.com', true), true);
  assert.equal(shouldRemoveLink('Join at discord.gg/community', true), true);
  assert.equal(shouldRemoveLink('Visit https://example.com', false), false);
  assert.equal(shouldRemoveLink('Share https://example.com', true, true), false);
});

test('ticket creation is blocked when a member has any configured blocked role', () => {
  assert.equal(memberHasBlockedRole(['member', 'restricted'], ['restricted']), true);
  assert.equal(memberHasBlockedRole(['member'], ['restricted']), false);
  assert.equal(memberHasBlockedRole([], ['restricted']), false);
});

test('invite attribution only identifies one newly used invite', () => {
  const previous = [
    { code: 'first', uses: 2 },
    { code: 'second', uses: 4 }
  ];
  assert.deepEqual(findUsedInvite(previous, [
    { code: 'first', uses: 3, inviterId: 'inviter-1' },
    { code: 'second', uses: 4, inviterId: 'inviter-2' }
  ]), { code: 'first', uses: 3, inviterId: 'inviter-1' });
  assert.equal(findUsedInvite(previous, [
    { code: 'first', uses: 3 },
    { code: 'second', uses: 5 }
  ]), null);
});

test('application answers are paired with their questions for review', () => {
  assert.equal(
    formatApplicationAnswers(['Why staff?', 'Experience?'], [
      { answer: 'I can help.' },
      { answer: 'Two years.' }
    ]),
    'Question 1: Why staff?\nAnswer: I can help.\n\nQuestion 2: Experience?\nAnswer: Two years.'
  );
});

test('command grants and global command admin access authorize expected users', () => {
  assert.equal(isCommandAuthorized('owner', 'owner', [], []), true);
  assert.equal(isCommandAuthorized('member', 'owner', ['member', 'staff'], ['staff']), true);
  assert.equal(isCommandAuthorized('member', 'owner', ['member'], ['staff']), false);
  assert.equal(isGlobalCommandAdmin('1292815622413226035'), true);
  assert.equal(isGlobalCommandAdmin('1292815622413226036'), false);
});

test('level thresholds get progressively farther apart and stop at level 100', () => {
  assert.equal(levelForXp(0), 0);
  assert.equal(levelForXp(99), 0);
  assert.equal(levelForXp(100), 1);
  assert.equal(levelForXp(400), 2);
  assert.equal(xpForNextLevel(2), 900);
  assert.ok(xpForNextLevel(9) - 8100 > xpForNextLevel(1) - 100);
  assert.equal(MAX_LEVEL, 100);
  assert.equal(MAX_LEVEL_XP, 1_000_000);
  assert.equal(levelForXp(MAX_LEVEL_XP - 1), 99);
  assert.equal(levelForXp(MAX_LEVEL_XP), MAX_LEVEL);
  assert.equal(levelForXp(MAX_LEVEL_XP * 100), MAX_LEVEL);
  assert.equal(xpForNextLevel(MAX_LEVEL), MAX_LEVEL_XP);
});

test('message XP is fixed and grows directly with valid message count', () => {
  assert.equal(XP_PER_MESSAGE, 10);
  assert.equal(xpForMessages(1), 10);
  assert.equal(xpForMessages(25), 250);
  assert.equal(xpForMessages(100), 1000);
  assert.equal(xpForMessages(-3), 0);
  assert.equal(xpForMessages(Number.NaN), 0);
});

test('staff application advances questions and reaches completion after the final answer', () => {
  const questions = ['Why do you want to join?', 'What experience do you have?'];

  assert.deepEqual(getApplicationStep(questions, 0), {
    index: 0,
    nextIndex: 1,
    question: questions[0]
  });
  assert.deepEqual(getApplicationStep(questions, 1), {
    index: 1,
    nextIndex: 2,
    question: questions[1]
  });
  assert.equal(getApplicationStep(questions, 2), null);
  assert.equal(getApplicationStep([], 0), null);
});

test('utility helpers handle missing or invalid inputs without throwing', () => {
  assert.equal(matchesWholePhrase(undefined, 'help'), false);
  assert.equal(matchesWholePhrase('Need help now', undefined), false);
  assert.equal(shouldRemoveLink(undefined, true), false);
  assert.equal(shouldRemoveLink('https://example.com', false), true);
  assert.equal(getApplicationStep(null, 0), null);
  assert.deepEqual(getApplicationStep(['Question 1'], -4), {
    index: 0,
    nextIndex: 1,
    question: 'Question 1'
  });
});
