import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const start=app.indexOf('function initializeTourismSelector(part)');
const end=app.indexOf('\nfor(const part of ["Origin","Destination"])initializeTourismSelector(part);',start);
assert.ok(start>=0&&end>start);

function selectorPage() {
  class Element {
    constructor(){this.children=[];this.listeners={};this.value='';this.attributes={};this.parent=null;}
    addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);}
    fire(type,details={}){for(const fn of this.listeners[type]||[])fn({target:this,preventDefault(){},...details});}
    append(child){child.parent=this;this.children.push(child);}
    replaceChildren(){for(const child of this.children)child.parent=null;this.children=[];}
    contains(node){return node===this||this.children.some(child=>child.contains(node));}
    closest(){return this.field;}
    setAttribute(key,value){this.attributes[key]=value;}
    focus(){this.fire('focus');}
    querySelector(){return this.children[0]||null;}
    querySelectorAll(){return this.children;}
  }
  const elements={},fields={},document=new Element(),routes=[];
  document.createElement=()=>new Element();
  for(const part of ['Origin','Destination']) {
    const field=fields[part]=new Element();document.append(field);
    for(const suffix of ['', 'Search','Clear','Matches']) {
      const el=elements['tourism'+part+suffix]=new Element();el.field=field;field.append(el);
    }
  }
  const searches=[];
  const context=vm.createContext({document,$:id=>elements[id],
    googleTourismPlaces:new Map(),
    clearTimeout(){},setTimeout(fn){fn();return 1;},
    exploraRouteCallable:async({query})=>{
      searches.push(query);
      return {data:{places:[{id:query.replace(/\s+/g,'-'),label:`${query} · Google Maps`}]}};
    },
    routeFailureMessage:()=>"No se pudo buscar el lugar.",
    selectTourismRoute:()=>routes.push([elements.tourismOrigin.value,elements.tourismDestination.value])});
  vm.runInContext(app.slice(start,end)+';initializeTourismSelector("Origin");initializeTourismSelector("Destination");',context);
  return {elements,fields,document,routes,searches};
}
async function settleSearch(){for(let i=0;i<5;i++)await Promise.resolve();}

test('tocar un resultado de Google Maps completa salida y llegada aunque el navegador pierda el foco antes del click',async()=>{
  const {elements,fields,document,routes,searches}=selectorPage();
  for(const [part,query] of [['Origin','cataratas argentina'],['Destination','aeroporto foz']]) {
    const input=elements['tourism'+part+'Search'],matches=elements['tourism'+part+'Matches'];
    input.value=query;input.fire('input');await settleSearch();const choice=matches.children[0];assert.ok(choice);
    document.fire('pointerdown',{target:choice});
    // En pantallas táctiles el desenfoque puede no indicar qué opción se está tocando.
    fields[part].fire('focusout',{target:input,relatedTarget:null});
    assert.ok(matches.children.includes(choice),'La opción debe seguir disponible hasta completar el toque');
    choice.onclick();
    assert.equal(input.value,`${query} · Google Maps`);assert.ok(elements['tourism'+part].value.startsWith('google:'));
    assert.equal(matches.children.length,0);assert.equal(input.attributes['aria-expanded'],'false');
  }
  assert.deepEqual(searches,['cataratas argentina','aeroporto foz']);
  assert.ok(routes.at(-1).every(Boolean));
});

test('la lista de Google se cierra al tocar o enfocar fuera del campo, sin seleccionar por abrirla',async()=>{
  const {elements,document}=selectorPage(),input=elements.tourismOriginSearch,matches=elements.tourismOriginMatches;
  for(const event of ['pointerdown','focusin']) {
    input.value='Iguazú';input.focus();await settleSearch();assert.ok(matches.children.length);assert.equal(elements.tourismOrigin.value,'');
    document.fire(event,{target:document});assert.equal(matches.children.length,0);assert.equal(input.attributes['aria-expanded'],'false');
  }
});
