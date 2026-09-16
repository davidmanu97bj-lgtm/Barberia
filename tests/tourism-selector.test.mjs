import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {searchTourismPlaces} from '../tourism-catalog.js';

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
  const context=vm.createContext({document,$:id=>elements[id],searchTourismPlaces,tourismUsage:{},tourismUsageKey:'test',localStorage:{setItem(){}},
    tourismCountryNames:{ARG:'Argentina',BRA:'Brasil',PRY:'Paraguay'},
    selectTourismRoute:()=>routes.push([elements.tourismOrigin.value,elements.tourismDestination.value])});
  vm.runInContext(app.slice(start,end)+';initializeTourismSelector("Origin");initializeTourismSelector("Destination");',context);
  return {elements,fields,document,routes};
}

test('tocar una sugerencia completa salida y llegada aunque el navegador pierda el foco antes del click',()=>{
  const {elements,fields,document,routes}=selectorPage();
  for(const [part,query,id] of [['Origin','cataratas argentina','cataratas-argentina'],['Destination','aeroporto foz',null]]) {
    const input=elements['tourism'+part+'Search'],matches=elements['tourism'+part+'Matches'];
    input.value=query;input.fire('input');const choice=matches.children[0];assert.ok(choice);
    document.fire('pointerdown',{target:choice});
    // En pantallas táctiles el desenfoque puede no indicar qué opción se está tocando.
    fields[part].fire('focusout',{target:input,relatedTarget:null});
    assert.ok(matches.children.includes(choice),'La opción debe seguir disponible hasta completar el toque');
    choice.fire('click');
    assert.ok(input.value.length>query.length);assert.ok(elements['tourism'+part].value);
    if(id)assert.equal(elements['tourism'+part].value,id);
    assert.equal(matches.children.length,0);assert.equal(input.attributes['aria-expanded'],'false');
  }
  assert.ok(routes.at(-1).every(Boolean));
});

test('la lista se cierra al tocar o enfocar fuera del campo, sin seleccionar por abrirla',()=>{
  const {elements,document}=selectorPage(),input=elements.tourismOriginSearch,matches=elements.tourismOriginMatches;
  for(const event of ['pointerdown','focusin']) {
    input.focus();assert.ok(matches.children.length);assert.equal(input.value,'');assert.equal(elements.tourismOrigin.value,'');
    document.fire(event,{target:document});assert.equal(matches.children.length,0);assert.equal(input.attributes['aria-expanded'],'false');
  }
});
