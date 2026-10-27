import {test,expect} from '@playwright/test';
import {host,edit} from './host-fixture.mjs';

// The host checks every save payload with a meta-schema validator. A designer that carries one lends
// it, so the page fetches no copy of its own; an older designer without one leaves the host to import
// the staged copy once.
for(const designerValidates of [true,false]) {
  test(`a designer ${designerValidates?'that lends its validator':'without a validator'} still has every save payload checked`,async({page})=>{
    const state=await host(page,'template','edit',true,{designerValidates});
    const save=page.locator('#save');
    await edit(page,'Checked');await save.click();await expect(page.locator('#state')).toHaveText('Saved');
    expect(state.writes).toHaveLength(1);
    expect(state.validatorRequests??0).toBe(designerValidates?0:1);
    const lent=await page.evaluate(()=>window.__designerValidations??0);
    if(designerValidates)expect(lent).toBeGreaterThan(0);else expect(lent).toBe(0);
  });
}
