/** Guided local fiscal configuration. Certificates/keys are entered separately by SH. */
import fs from 'node:fs';
import readline from 'node:readline/promises';
import {stdin,stdout} from 'node:process';
if(!stdin.isTTY || !process.argv[2])throw new Error('Abrí el asistente desde una terminal con bash explora.sh arca.');
const rl=readline.createInterface({input:stdin,output:stdout});
const question=async(text,defaultValue='')=>{const answer=(await rl.question(text+(defaultValue?` [${defaultValue}]`: '')+': ')).trim();return answer||defaultValue;};
try {
 const environment=await question('Ambiente: homologation (pruebas) o production (facturas reales)','homologation');
 if(!['homologation','production'].includes(environment))throw new Error('Ambiente inválido.');
 const cuit=(await question('CUIT del emisor, 11 dígitos')).replace(/\D/g,'');
 const legalName=await question('Nombre/razón social del emisor');
 const address=await question('Domicilio fiscal');
 const grossIncomeId=await question('Número de Ingresos Brutos, o texto EXENTO si corresponde');
 const activityStart=await question('Inicio de actividades (AAAA-MM-DD)');
 const pointOfSale=Number(await question('Punto de venta habilitado exclusivamente para esta app'));
 if(await question('¿Este punto de venta será usado SOLO por esta app? Escribí SI')!=='SI')throw new Error('No se activa un punto de venta compartido con otra emisión.');
 let homologationPassed=false,registrationVerified=false;
 if(environment==='production'){
  homologationPassed=await question('¿Completaste y verificaste las pruebas de homologación? Escribí SI')==='SI';
  registrationVerified=await question('¿Verificaste con tu contadora la situación fiscal y punto de venta para factura C? Escribí SI')==='SI';
  if(!homologationPassed||!registrationVerified)throw new Error('Completá las verificaciones antes de activar producción.');
 }
 if(!/^\d{11}$/.test(cuit)||!legalName||!address||!grossIncomeId||!/^\d{4}-\d{2}-\d{2}$/.test(activityStart)||!Number.isInteger(pointOfSale)||pointOfSale<1||pointOfSale>99998)throw new Error('Revisá los datos fiscales: hay campos vacíos o inválidos.');
 const config={enabled:true,environment,regime:'monotributo',cuit,legalName,address,grossIncomeId,activityStart,pointOfSale,exclusivePointOfSale:true,homologationPassed,registrationVerified};
 fs.writeFileSync(process.argv[2],JSON.stringify(config,null,2)+'\n',{mode:0o600});
 console.log('Datos guardados solo en .explora-local; no se suben al repositorio. El certificado y la clave se solicitan por separado.');
} finally {rl.close();}
