import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const source = app.slice(app.indexOf('let stopInvoiceSubscription = null;'), app.indexOf('async function refreshArcaBillingStatus()'));
function element(tag) {
  return {tag, children:[], events:{}, disabled:false,
    append(...children) { for (const child of children) { const i=this.children.indexOf(child); if(i>=0)this.children.splice(i,1); this.children.push(child); } },
    setAttribute(key,value) { this[key]=value; },
    querySelector(selector) { return this.children.find(c=>'.'+c.className===selector)||null; },
    addEventListener(name, fn) { this.events[name]=fn; },
    remove() { this.removed=true; }
  };
}
function setup(request) {
  const urls=[],revoked=[],auth={currentUser:{uid:'driver-a'}};
  const context=vm.createContext({auth,functions:{},httpsCallable:()=>request,
    document:{createElement:element},navigator:{},File,Uint8Array,atob,
    URL:{createObjectURL(file){urls.push(file);return 'blob:test-'+urls.length;},revokeObjectURL(url){revoked.push(url);}}
  });
  vm.runInContext(source,context);
  return {context,urls,revoked,auth,button:element('button'),panel:element('article')};
}
const response={data:{base64:Buffer.from('%PDF-1.3\nfixture').toString('base64'),filename:'Factura-C-00002-00000001.pdf'}};
test('PDF preparado deja enlaces reales para guardar y abrir, sin clic sintético ni vencimiento prematuro',async()=>{
  const t=setup(async()=>response);
  await t.context.prepareInvoiceDownload('invoice-a',t.button,t.panel);
  const links=t.panel.children.find(c=>c.className==='invoice-file-actions').children;
  assert.equal(links[0].download,response.data.filename);
  assert.equal(links[0].href,'blob:test-1');
  assert.equal(links[1].target,'_blank');
  assert.equal(links[1].rel,'noopener');
  assert.equal(t.urls[0].type,'application/pdf');
  assert.equal(await t.urls[0].text(),'%PDF-1.3\nfixture');
  assert.equal(t.button.removed,true);
  assert.deepEqual(t.revoked,[]);
  t.context.clearInvoiceFiles();
  assert.deepEqual(t.revoked,['blob:test-1']);
});
test('cerrar el perfil o cambiar de cuenta descarta una respuesta pendiente',async()=>{
  for(const action of ['close','account']){
    let resolve;const t=setup(()=>new Promise(r=>{resolve=r;}));
    const pending=t.context.prepareInvoiceDownload('invoice-a',t.button,t.panel);
    if(action==='close')t.context.clearInvoiceFiles();else t.auth.currentUser={uid:'driver-b'};
    resolve(response);await pending;
    assert.equal(t.urls.length,0);
    assert.equal(t.panel.children.some(c=>c.className==='invoice-file-actions'),false);
  }
});
test('error de red permite reintentar y una respuesta inválida no se ofrece como factura',async()=>{
  let tries=0;const t=setup(async()=>{if(++tries===1)throw Error('network');return response;});
  await t.context.prepareInvoiceDownload('invoice-a',t.button,t.panel);
  assert.equal(t.button.disabled,false);
  assert.equal(t.urls.length,0);
  await t.context.prepareInvoiceDownload('invoice-a',t.button,t.panel);
  assert.equal(t.urls.length,1);
  assert.equal(t.panel.children.filter(c=>c.className==='invoice-file-status').length,1);
  const bad=setup(async()=>({data:{...response.data,base64:btoa('error')}}));
  await bad.context.prepareInvoiceDownload('invoice-a',bad.button,bad.panel);
  assert.equal(bad.urls.length,0);
  assert.equal(bad.button.disabled,false);
});
