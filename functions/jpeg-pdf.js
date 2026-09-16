/* Dependency-free JPEG-in-PDF writer. Embeds the complete image, not OCR text.
 * The source image is fitted (never cropped) on an A4 page. Binary xref offsets
 * are measured in bytes. Shared by the browser and the Uber verification server.
 */
(function(root,factory) {
  const api=factory();
  if (typeof module==='object' && module.exports) module.exports=api;
  else root.ExploraJpegPdf=api;
})(typeof globalThis!=='undefined' ? globalThis : this,function() {
  'use strict';
  const encode = value => new TextEncoder().encode(value);
  function jpegInfo(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) throw new Error('La imagen no es un JPEG válido.');
    let at=2;
    while (at+4 < bytes.length) {
      if (bytes[at++] !== 255) throw new Error('Cabecera JPEG dañada.');
      while (bytes[at]===255) at++;
      const marker=bytes[at++];
      if (marker===217 || marker===218) break;
      if (marker===1 || (marker>=208 && marker<=215)) continue;
      const length=(bytes[at]<<8)+bytes[at+1];
      if (length<2 || at+length>bytes.length) throw new Error('JPEG incompleto.');
      if ([192,193,194].includes(marker)) {
        const height=(bytes[at+3]<<8)+bytes[at+4], width=(bytes[at+5]<<8)+bytes[at+6], channels=bytes[at+7];
        if (!width || !height || ![1,3].includes(channels) || bytes[at+2]!==8) throw new Error('Usá una imagen JPEG RGB o en escala de grises.');
        return {width,height,channels};
      }
      at+=length;
    }
    throw new Error('No se pudieron leer las dimensiones de la imagen.');
  }
  function create(input) {
    const jpeg=input instanceof Uint8Array ? input : new Uint8Array(input);
    const {width,height,channels}=jpegInfo(jpeg);
    const pageWidth=width>height ? 841.89 : 595.28;
    const pageHeight=width>height ? 595.28 : 841.89;
    const scale=Math.min((pageWidth-32)/width,(pageHeight-32)/height);
    const w=width*scale,h=height*scale,x=(pageWidth-w)/2,y=(pageHeight-h)/2;
    const stream=encode(`q\n${w.toFixed(4)} 0 0 ${h.toFixed(4)} ${x.toFixed(4)} ${y.toFixed(4)} cm\n/Im0 Do\nQ\n`);
    const parts=[], offsets=[0]; let size=0;
    const append=data=>{ const value=typeof data==='string'?encode(data):data; parts.push(value);size+=value.byteLength; };
    const object=(id,body)=>{ offsets[id]=size;append(`${id} 0 obj\n`);append(body);append('\nendobj\n'); };
    append('%PDF-1.4\n%'); append(new Uint8Array([226,227,207,211]));append('\n');
    object(1,'<< /Type /Catalog /Pages 2 0 R >>');
    object(2,'<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    object(3,`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
    offsets[4]=size;
    append(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /${channels===1?'DeviceGray':'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
    append(jpeg);append('\nendstream\nendobj\n');
    offsets[5]=size;append(`5 0 obj\n<< /Length ${stream.length} >>\nstream\n`);append(stream);append('endstream\nendobj\n');
    const xref=size;
    append('xref\n0 6\n0000000000 65535 f \n');
    for(let id=1;id<=5;id++) append(String(offsets[id]).padStart(10,'0')+' 00000 n \n');
    append(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    const result=new Uint8Array(size);let cursor=0;
    for(const part of parts){result.set(part,cursor);cursor+=part.length;}
    return result;
  }
  return Object.freeze({create,jpegInfo});
});
