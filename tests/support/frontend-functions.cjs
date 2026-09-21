const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the pure functions from the shipped app, without initializing Firebase or the DOM.
module.exports = function loadFrontendFunctions() {
  const source = fs.readFileSync(path.resolve(__dirname, '../../app.js'), 'utf8');
  const names = ['uberUsesGrossCashRule', 'uberSettlementDelta', 'uberDriverSubmissionDelta', 'previewDefinition'];
  const functions = names.map(name => {
    const start = source.indexOf(`\nfunction ${name}(`);
    const end = source.indexOf('\nfunction ', start + 1);
    if (start < 0 || end < 0) throw new Error(`No se encontró ${name} en la aplicación publicada`);
    return source.slice(start, end);
  });
  return vm.runInNewContext(`${functions.join('\n')}\n({${names.join(',')}})`, {}, { timeout: 1000 });
};
