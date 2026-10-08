import {test,expect} from '@playwright/test';
import {host,text} from './host-fixture.mjs';

// Opening the Designer, creating or editing, in either language, with each request the page makes
// while it opens answered in each way it can fail. The page stops loading and says why in the
// language it speaks. The server's own words appear when it gives some. The browser's and the
// parser's words never appear, and nothing speaks of a save that has not happened.

const SERVER_MESSAGE='Server says no';
const ANSWERS={
  'an answer that is not JSON':route=>route.fulfill({status:200,contentType:'text/html',body:'<html>Sign in</html>'}),
  401:route=>route.fulfill({status:401,json:{}}),
  403:route=>route.fulfill({status:403,json:{message:SERVER_MESSAGE}}),
  404:route=>route.fulfill({status:404,json:{message:SERVER_MESSAGE}}),
  500:route=>route.fulfill({status:500,json:{message:SERVER_MESSAGE}}),
  'an empty 502':route=>route.fulfill({status:502,body:''}),
  'no answer':route=>route.abort('failed'),
};
const REQUESTS={create:['configuration','profile','manifest','component','folder'],
  edit:['configuration','profile','manifest','component','artifact','report']};

/** What the page says, for a request and an answer, in a language. */
function expected(request,answer,mode,say){
  if(answer==='no answer'&&request!=='component')return say('Error.Unreachable');
  if(request==='configuration')return say('Error.ConfigurationLoad');
  if(request==='manifest')return say('Error.ManifestLoad');
  if(request==='component')return say('Error.ComponentLoad',{name:'cedar-embeddable-designer'});
  switch(answer){
    case 'an answer that is not JSON':return say('Error.UnreadableAnswer');
    case '401':return say('Error.SessionEnded');
    case '403':return say(mode==='create'?'Error.ForbiddenCreate':'Error.ForbiddenOpen');
    case 'an empty 502':return say('Error.RequestFailed',{status:502,detail:say('Error.ReloadToRetry')});
    default:return say('Error.RequestFailed',{status:Number(answer),detail:SERVER_MESSAGE});
  }
}

for(const mode of ['create','edit'])for(const language of ['en','hu'])for(const request of REQUESTS[mode])
  for(const answer of Object.keys(ANSWERS)){
    // A script that answers 200 with something other than JavaScript is not a failure of loading it.
    if(request==='component'&&answer==='an answer that is not JSON')continue;
    test(`${mode} in ${language}: the ${request} request meets ${answer}`,async({page})=>{
      await host(page,'template',mode,true,{language,openingFailure:{request,answer:ANSWERS[answer]}});
      const message=page.locator('#message');
      await expect(message).toHaveText(expected(request,answer,mode,(key,params)=>text(language,key,params)));
      await expect(message).toHaveAttribute('data-tone','error');
      await expect(page.locator('#editor')).toBeHidden();
      await expect(message).not.toContainText(/Failed to fetch|Cannot read|Unexpected token|JSON/);
    });
  }

// The address says which designer opens, so the heading names it from the start and never shows
// another designer's name while the page loads.
for(const [kind,title] of [['template','Template Designer'],['element','Element Designer'],['field','Field Designer']])
  test(`opening a ${kind} names only its own designer`,async({page})=>{
    await page.addInitScript(()=>{
      window.titles=[];
      new MutationObserver(()=>{
        const shown=document.getElementById('title')?.textContent;
        if(shown&&shown!==window.titles.at(-1))window.titles.push(shown);
      }).observe(document,{subtree:true,childList:true,characterData:true});
    });
    await host(page,kind,'edit');
    expect(await page.evaluate(()=>window.titles)).toEqual([title]);
  });
