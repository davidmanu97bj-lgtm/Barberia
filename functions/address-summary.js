"use strict";
const text = value => String(value || '').replace(/\s+/g,' ').trim();
const key = value => text(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
function unique(parts) {
  const seen=new Set();
  return parts.map(text).filter(part=>part&&!seen.has(key(part))&&seen.add(key(part))).join(' · ');
}
// Used for previously stored Google labels too. Keep street numbers and route km.
function summarizeAddress(value) {
  const raw=text(value);
  if(!raw.includes(','))return raw;
  const parts=raw.split(/\s*·\s*|,\s*/).map(part=>part
    .replace(/\b[A-Z]\d{4}[A-Z]{0,3}\b/gi,'')
    .replace(/\b\d{5}-\d{3}\b/g,'')
    .replace(/\b[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3}\b/gi,'')
    .replace(/\s+-\s+(?:PR|Paraná|Misiones|Alto Paraná)$/i,'')
    .trim())
    .filter(part=>part&&!/^\d{8}$/.test(part)&&!['argentina','brasil','brazil','paraguay','misiones','parana','alto parana','provincia de misiones','estado de parana'].includes(key(part)));
  return unique(parts);
}
function summarizeGooglePlace(place) {
  const components=place.addressComponents || [];
  const component=type=>text(components.find(c=>c.types?.includes(type))?.longText);
  const street=component('route'),number=component('street_number');
  const city=component('locality') || component('postal_town') || component('administrative_area_level_2');
  const name=text(place.displayName?.text);
  const address=[street,number].filter(Boolean).join(' ');
  if(!street&&!city)return summarizeAddress([name,place.formattedAddress].filter(Boolean).join(' · '));
  // Google often repeats the street and number as the place name.
  const nameIsAddress=address&&[key(address),key([number,street].filter(Boolean).join(' ')),key(street)].includes(key(name));
  return unique([nameIsAddress?'':name,address,city]);
}
module.exports={summarizeAddress,summarizeGooglePlace};
