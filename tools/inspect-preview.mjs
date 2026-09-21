import {chromium,webkit} from 'playwright';
import assert from 'node:assert/strict';
for(const engine of ['chromium','webkit']){
 const browser=await (engine==='chromium'?chromium:webkit).launch(engine==='chromium'?{channel:'msedge'}:{});
 const page=await browser.newPage();
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 for(const width of [320,390,430,768]){
  await page.setViewportSize({width,height:844});await page.goto('http://localhost:8080');
  await page.locator('.activity-row').first().waitFor();await page.locator('#closeDayBtn').click();
  await page.locator('.period-summary').waitFor();
  const text=await page.locator('#periodSections').innerText();assert.ok(text.includes('18.800'),text);assert.ok(text.includes('Debés de multa'),text);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,engine+' '+width+' horizontal overflow');
  await page.locator('#confirmPeriodClose').click();await page.locator('#periodReceiptModal').waitFor({state:'visible'});
  await page.locator('#cancelPeriodReceipt').click();assert.equal(await page.locator('#periodReceiptModal').isVisible(),false);
  console.log(engine,width,'cards, amounts, one closure, cancel: OK');
  if(engine==='chromium'&&width===390){await page.screenshot({path:'../period-cards-current.png',fullPage:true});}
 }
 assert.deepEqual(errors,[]);await browser.close();
}
