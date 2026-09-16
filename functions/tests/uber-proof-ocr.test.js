const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {recognizeScreenshot,validateUberText} = require('../uber-proof');
test('OCR real sobre imagen sintética: acepta semana y monto y rechaza otra semana', async () => {
  const data = await recognizeScreenshot(fs.readFileSync(path.join(__dirname,'../../tests/fixtures/uber-ganancias-sinteticas.jpg')));
  assert.ok(data.confidence >= 60);
  assert.equal(validateUberText(data.text,data.confidence,{start:'2026-09-07',close:'2026-09-14'},100000).valid,true);
  assert.equal(validateUberText(data.text,data.confidence,{start:'2026-09-14',close:'2026-09-21'},100000).valid,false);
  assert.equal(validateUberText(data.text,data.confidence,{start:'2026-09-07',close:'2026-09-14'},120000).valid,false);
});
