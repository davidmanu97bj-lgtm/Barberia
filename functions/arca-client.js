"use strict";
const forge = require('node-forge');
const {XMLParser, XMLValidator} = require('fast-xml-parser');
const {X509Certificate, createPrivateKey} = require('node:crypto');
const NS = 'http://ar.gov.afip.dif.FEV1/';
const ENDPOINTS = Object.freeze({
  production:{wsaa:'https://wsaa.afip.gov.ar/ws/services/LoginCms',wsfe:'https://servicios1.afip.gov.ar/wsfev1/service.asmx'},
  homologation:{wsaa:'https://wsaahomo.afip.gov.ar/ws/services/LoginCms',wsfe:'https://wswhomo.afip.gov.ar/wsfev1/service.asmx'}
});
const list = value => value == null ? [] : Array.isArray(value) ? value : [value];
const escape = value => String(value).replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
const tags = object => Object.entries(object).map(([key,value])=>`<${key}>${typeof value==='object' ? tags(value) : escape(value)}</${key}>`).join('');
const parser = new XMLParser({removeNSPrefix:true,parseTagValue:false,processEntities:true});
function parseXml(xml) {
  if(typeof xml!=='string' || xml.length>2_000_000 || /<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml)!==true) throw new Error('ARCA_INVALID_XML');
  return parser.parse(xml);
}
class ArcaError extends Error {
  constructor(code,details=[]) { super(code);this.code=code;this.details=details; }
}
function errors(result) { return list(result?.Errors?.Err).map(e=>({code:String(e.Code),message:String(e.Msg||'').slice(0,400)})); }
function checkErrors(result) { const items=errors(result);if(items.length) throw new ArcaError('ARCA_REJECTED_REQUEST',items);return result; }
function makeCms({certificate,privateKey,cuit},now=new Date()) {
  const cert=new X509Certificate(certificate),key=createPrivateKey(privateKey);
  if(!cert.checkPrivateKey(key) || !cert.subject.includes(`CUIT ${cuit}`) || now<new Date(cert.validFrom) || now>=new Date(cert.validTo)) throw new ArcaError('ARCA_CERTIFICATE_INVALID');
  const xml=`<loginTicketRequest version="1.0"><header><uniqueId>${Math.floor(now.getTime()/1000)}</uniqueId><generationTime>${new Date(now.getTime()-300000).toISOString()}</generationTime><expirationTime>${new Date(now.getTime()+3600000).toISOString()}</expirationTime></header><service>wsfe</service></loginTicketRequest>`;
  const signed=forge.pkcs7.createSignedData();
  signed.content=forge.util.createBuffer(xml,'utf8');
  signed.addCertificate(cert.toString());
  signed.addSigner({key:forge.pki.privateKeyFromPem(key.export({format:'pem',type:'pkcs1'})),certificate:forge.pki.certificateFromPem(cert.toString()),digestAlgorithm:forge.pki.oids.sha256,
    authenticatedAttributes:[{type:forge.pki.oids.contentType,value:forge.pki.oids.data},{type:forge.pki.oids.messageDigest},{type:forge.pki.oids.signingTime,value:now}]});
  signed.sign();
  return forge.util.encode64(forge.asn1.toDer(signed.toAsn1()).getBytes());
}
function createArcaClient({environment,cuit,certificate,privateKey,fetchImpl=fetch,ticketStore}) {
  const endpoints=ENDPOINTS[environment];
  if(!endpoints || !/^\d{11}$/.test(String(cuit))) throw new ArcaError('ARCA_CONFIG_INVALID');
  let ticket,loginPending;
  async function soap(endpoint,action,body) {
    const response=await fetchImpl(endpoint,{method:'POST',redirect:'error',headers:{'Content-Type':'text/xml; charset=utf-8',SOAPAction:`"${action}"`},body:`<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${body}</soap:Body></soap:Envelope>`,signal:AbortSignal.timeout(25000)});
    const doc=parseXml(await response.text()).Envelope?.Body;
    if(doc?.Fault) throw new ArcaError('ARCA_SOAP_FAULT',[{code:String(doc.Fault.faultcode||''),message:String(doc.Fault.faultstring||'').slice(0,400)}]);
    if(!response.ok || !doc) throw new ArcaError('ARCA_UNAVAILABLE');
    return doc;
  }
  const valid = t => t?.token && t?.sign && Date.parse(t.expiresAt)>Date.now()+120000;
  async function authenticate() {
    if(valid(ticket)) return ticket;
    if(loginPending) return loginPending;
    loginPending=(async()=>{
      const cached=await ticketStore?.load();if(valid(cached)) return ticket=cached;
      const cms=makeCms({certificate,privateKey,cuit});
      const response=await soap(endpoints.wsaa,'',`<loginCms xmlns="http://wsaa.view.sua.dvadac.desein.afip.gov"><in0>${cms}</in0></loginCms>`);
      const data=parseXml(response.loginCmsResponse?.loginCmsReturn).loginTicketResponse;
      const next={token:data?.credentials?.token,sign:data?.credentials?.sign,expiresAt:data?.header?.expirationTime};
      if(!valid(next)) throw new ArcaError('ARCA_INVALID_TICKET');
      await ticketStore?.save(next);ticket=next;return ticket;
    })().finally(()=>{loginPending=null;});
    return loginPending;
  }
  async function call(operation,payload={}) {
    const auth=await authenticate();
    const response=await soap(endpoints.wsfe,NS+operation,`<${operation} xmlns="${NS}">${tags({Auth:{Token:auth.token,Sign:auth.sign,Cuit:cuit},...payload})}</${operation}>`);
    const result=response[operation+'Response']?.[operation+'Result'];
    if(!result)throw new ArcaError('ARCA_INVALID_RESPONSE');return result;
  }
  return {
    authenticate,
    async last(pointOfSale,type=11) {
      const result=checkErrors(await call('FECompUltimoAutorizado',{PtoVta:pointOfSale,CbteTipo:type}));
      const number=Number(result.CbteNro);if(!Number.isSafeInteger(number)||number<0)throw new ArcaError('ARCA_INVALID_NUMBER');return number;
    },
    async points() { return list(checkErrors(await call('FEParamGetPtosVenta')).ResultGet?.PtoVenta); },
    async consult(pointOfSale,number,type=11) {
      const result=await call('FECompConsultar',{FeCompConsReq:{CbteTipo:type,CbteNro:number,PtoVta:pointOfSale}});
      const issues=errors(result);if(issues.length===1&&issues[0].code==='602')return null;
      checkErrors(result);if(!result.ResultGet)throw new ArcaError('ARCA_INVALID_RESPONSE');return result.ResultGet;
    },
    async authorize(pointOfSale,detail) {
      const result=await call('FECAESolicitar',{FeCAEReq:{FeCabReq:{CantReg:1,PtoVta:pointOfSale,CbteTipo:11},FeDetReq:{FECAEDetRequest:detail}}});
      const rows=list(result.FeDetResp?.FECAEDetResponse);
      // Only a complete, explicit rejection is definitive. All other errors require reconciliation.
      if(rows.length!==1)throw new ArcaError('ARCA_UNCERTAIN',errors(result));
      return {header:result.FeCabResp,detail:rows[0],errors:errors(result)};
    }
  };
}
module.exports={createArcaClient,makeCms,parseXml,ArcaError,tags,list};
