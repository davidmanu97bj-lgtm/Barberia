import fs from 'node:fs';
import path from 'node:path';
import {ROOT,PROJECT_ID} from './project.mjs';
const [project,filename]=process.argv.slice(2);
if(!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project||''))throw new Error('ID de proyecto inválido.');
let value=JSON.parse(fs.readFileSync(filename,'utf8'));
value=value.result?.sdkConfig||value.result||value.sdkConfig||value;
if(typeof value==='string')value=JSON.parse(value);
if(value.projectId!==project||!value.apiKey||!value.appId||!value.storageBucket)throw new Error('Configuración web incompleta o de otro proyecto.');
const fields=['apiKey','authDomain','projectId','storageBucket','messagingSenderId','appId'];
const lines=fields.filter(key=>value[key]).map(key=>`  ${key}: ${JSON.stringify(value[key])}`);
fs.writeFileSync(path.join(ROOT,'firebase-config.js'),`// Generado por explora.sh. No contiene secretos de backend.\nexport const firebaseConfig = {\n${lines.join(',\n')}\n};\nexport const BUSINESS_ID = ${JSON.stringify(project)};\nexport const USER_EMAIL_DOMAIN = "explora.local";\nexport const LOGIN_ALIASES = {};\n`);
fs.writeFileSync(path.join(ROOT,'.firebaserc'),JSON.stringify({projects:{default:project}},null,2)+'\n');
if(project!==PROJECT_ID) {
  fs.writeFileSync(path.join(ROOT,'functions/deployment-options.json'),JSON.stringify({telegramEnabled:false,arcaEnabled:false,routesEnabled:false},null,2)+'\n');
  console.log('Cambió el proyecto: integraciones deshabilitadas hasta configurar sus credenciales en el nuevo destino.');
}
console.log(`Configuración web actualizada a ${project}. No se publicó ni se trasladaron datos.`);
