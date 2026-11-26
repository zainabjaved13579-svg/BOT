const test = require('node:test');
const assert = require('node:assert/strict');
const commands = require('../src/commands');

test('/ticket theme-add and theme-remove use names instead of internal keys', () => {
  const ticket = commands.find(command => command.name === 'ticket');
  const themeAdd = ticket.options.find(option => option.name === 'theme-add');
  const themeRemove = ticket.options.find(option => option.name === 'theme-remove');
  const addOptions = themeAdd.options.map(option => option.name);
  const removeOptions = themeRemove.options.map(option => option.name);

  assert.deepEqual(addOptions.slice(0, 3), ['name', 'description', 'emoji']);
  assert.equal(addOptions.includes('key'), false);
  assert.ok(themeAdd.options.slice(0, 3).every(option => option.required));
  assert.deepEqual(removeOptions, ['name']);
});

