const test = require('node:test');
const assert = require('node:assert/strict');
const { createPdfBuffer } = require('../src/pdf');

test('transcript renderer produces a valid PDF for long and non-ASCII text', async () => {
  const content = Array.from({ length: 300 }, (_, index) =>
    `Question ${index + 1}: Why do you want to join? Answer: I can help the community.`
  ).join('\n\n') + '\nUrdu: درخواست';
  const pdf = await createPdfBuffer(content);

  assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.ok(pdf.includes(Buffer.from('%%EOF')));
});
