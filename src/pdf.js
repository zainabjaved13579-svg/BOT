const PDFDocument = require('pdfkit');

function createPdfBuffer(content) {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ size: 'A4', margin: 48 });
    const chunks = [];
    document.on('data', chunk => chunks.push(chunk));
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.on('error', reject);
    document
      .font('Helvetica')
      .fontSize(10)
      .fillColor('#222222')
      .text(String(content).replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '?'), { lineGap: 3 });
    document.end();
  });
}

module.exports = { createPdfBuffer };
