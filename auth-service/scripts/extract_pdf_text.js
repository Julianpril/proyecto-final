#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: node scripts/extract_pdf_text.js <path-to-pdf>');
    process.exit(2);
  }
  const filePath = path.resolve(process.cwd(), arg);
  if (!fs.existsSync(filePath)) {
    console.error('File not found:', filePath);
    process.exit(3);
  }
  try {
    const dataBuffer = fs.readFileSync(filePath);
    const PDFParse = pdf && pdf.PDFParse;
    if (typeof PDFParse !== 'function') {
      console.error('pdf-parse export not recognized. Expected PDFParse class.');
      process.exit(4);
    }

    const parser = new PDFParse({ data: dataBuffer });
    const data = await parser.getText({});
    await parser.destroy();

    // Print extracted text
    console.log(data.text || '');
  } catch (err) {
    console.error('Error extracting PDF text:', err.message || err);
    process.exit(1);
  }
}

main();
