import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const original=JSON.parse(fs.readFileSync(new URL('./original-preservation.json',import.meta.url)));
const app=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
for(const [name,expected] of Object.entries(original))test('original intacto: '+name,()=>{
 let bytes;if(name.includes('/'))bytes=fs.readFileSync(new URL('../'+name,import.meta.url));
 else {const a=app.indexOf('function '+name+'(');bytes=app.slice(a,app.indexOf('\n}',a)+2);}
 assert.equal(hash(bytes),expected);
});
test('SH válido, sin publicación al pedir ayuda y sin escrituras Git destructivas',()=>{
 execFileSync('bash',['-n','explora.sh']);const help=execFileSync('bash',['explora.sh','help'],{encoding:'utf8'});
 assert.match(help,/migrate-pdfs/);assert.match(help,/No hace git push/);
 const sh=fs.readFileSync('explora.sh','utf8');assert.match(sh,/PUBLICAR \$project/);assert.match(sh,/--project "\$project"/);
 assert.doesNotMatch(sh,/^\s*git (?:push|reset|clean)\b|--force(?:\s|$)/m);
});
test('no se incluye el backend privado ni secretos en el build de Hosting',()=>{
 const cfg=JSON.parse(fs.readFileSync('firebase.json'));assert.equal(cfg.hosting.public,'dist');
 const options=JSON.parse(fs.readFileSync('functions/deployment-options.json'));for(const k of ['telegramEnabled','arcaEnabled','routesEnabled'])assert.equal(typeof options[k],'boolean');
 assert.match(fs.readFileSync('tools/functions-manifest.mjs','utf8'),/receiptPdf/);
});
