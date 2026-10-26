import {test, expect} from '@playwright/test';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import model from 'cedar-model-typescript-library';
import schema from 'cedar-model-typescript-library/schema.js';
const {SchemaArtifactValidator}=schema;
import {createJavaOracle} from 'cedar-model-typescript-library/conformance/java-oracle.mjs';
import {host} from './host-fixture.mjs';

const {CedarBuilders,CedarWriters,CedarReaders,TemplateValueValidator,JsonSourcePolicy}=model;
const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const BUNDLE=resolve(ROOT,process.env.CEDAR_CED_BUNDLE??'node_modules/cedar-embeddable-designer/cedar-embeddable-designer.js');
const ITEM='5f0d8c3e-2b7a-4c1e-9d6f-3a8b7c2e1f40';
function artifact(kind) {
  const builder=kind==='template'?CedarBuilders.templateBuilder():kind==='element'?CedarBuilders.templateElementBuilder():CedarBuilders.textFieldBuilder();
  const value=builder.withSchemaName('Study').withDescription('Study schema').build();
  if(kind!=='field') {
    const child=CedarBuilders.textFieldBuilder().withSchemaName('Value').withDescription('Value schema').build();
    value.addChild(child,child.createDeploymentBuilder('Value').withMultiInstance(true).withMinItems(0).withMaxItems(5).build());
  }
  const source=CedarWriters.json().getStrict().getWriterForArtifact(value).getAsJsonNode(value);
  source['@id']=`https://repo.designer.test/${kind==='template'?'templates':kind==='element'?'template-elements':'template-fields'}/${ITEM}`;
  return source;
}
let oracle;
test.describe.configure({mode:'serial'});
test.beforeAll(async()=>{test.setTimeout(180000);oracle=await createJavaOracle(SchemaArtifactValidator.schemaDigests,JsonSourcePolicy.stringify.bind(JsonSourcePolicy));});
test.afterAll(async()=>{await oracle?.close();});
async function validatePayload(body,kind) {
  const verdict=await oracle.validate(body,kind);
  return {...verdict,canSave:verdict.canSave&&verdict.readable,
    errors:[...verdict.errors,...(verdict.readable?[]:[{message:verdict.readerError,location:''}])]};
}

for(const kind of ['template','element','field']) test(`${kind}: the real designer's final host write passes both libraries`,async({page},testInfo)=>{
  const state=await host(page,kind,'edit',true,{designerBundle:BUNDLE,loadedArtifact:artifact(kind),item:ITEM,validatePayload});
  // Ordinary unchanged work has no recovery or validation controls to clear before Save.
  await expect(page.locator('#server-issues')).toBeHidden();
  await expect(page.locator('#check-save')).toBeHidden();
  await expect(page.locator('#save')).toBeEnabled();
  await page.screenshot({path:testInfo.outputPath('ordinary-editing.png'),fullPage:true});
  await page.locator('#save').click();
  await expect.poll(()=>state.writes.length).toBe(1);
  expect(state.validations).toHaveLength(1);
  const body=state.writes[0].body;
  expect(body).toEqual(state.validations[0]);
  const verdict=await oracle.validate(body,kind);
  expect(verdict.canSave,JSON.stringify(verdict.errors)).toBe(true);
  expect(verdict.readable,verdict.readerError).toBe(true);
  const readers=CedarReaders.json().getStrict();
  const reader=kind==='template'?readers.getTemplateReader():kind==='element'?readers.getTemplateElementReader():readers.getTemplateFieldReader();
  const read=reader.readFromString(JsonSourcePolicy.stringify(body));
  expect(TemplateValueValidator.validate(read.template??read.element??read.field).canSave).toBe(true);
});

test('retained container pages cannot bypass a clean real CED projection',async({page})=>{
  const source=artifact('template');source._ui.pages=[];
  const java=await oracle.validate(source,'template');expect(java.canSave).toBe(false);
  const state=await host(page,'template','edit',true,{designerBundle:BUNDLE,loadedArtifact:source,item:ITEM,validatePayload});
  await expect(page.locator('#save')).toBeDisabled();
  await expect(page.locator('#server-issues')).toBeVisible();
  expect(state.validations).toHaveLength(0);expect(state.writes).toHaveLength(0);
  await expect(page.locator('#check-save')).toBeHidden();
});

test('a real imported field language defect stays blocked before any network write',async({page})=>{
  const source=artifact('template');source.properties.Value.items['@context']['@language']='a b';
  expect((await oracle.validate(source,'template')).canSave).toBe(false);
  const state=await host(page,'template','edit',true,{designerBundle:BUNDLE,loadedArtifact:source,item:ITEM,validatePayload});
  await expect(page.locator('#save')).toBeDisabled();
  expect(state.writes).toHaveLength(0);
});

test('a refused server preflight preserves ordinary editing without uncertain-write recovery',async({page})=>{
  const state=await host(page,'template','edit',true,{designerBundle:BUNDLE,loadedArtifact:artifact('template'),item:ITEM,
    validationFailure:{json:{canSave:false,isValid:false,errors:[{location:'/schema:name',message:'Server refused this snapshot'}],warnings:[]}}});
  await page.locator('#save').click();
  await expect(page.locator('#server-issues')).toBeVisible();
  expect(state.writes).toHaveLength(0);
  await expect(page.locator('#check-save')).toBeHidden();
  await expect(page.locator('#state')).not.toHaveText(/Reload/);
});
