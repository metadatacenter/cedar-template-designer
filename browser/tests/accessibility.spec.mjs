import {readFileSync} from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import {test, expect} from '@playwright/test';
import {text} from './host-fixture.mjs';
import {EXCLUDED, states as reached, saveMeets, draftOffer, findingsOpen, versionDialog, modified, readOnly} from './host-states.mjs';

// Automated WCAG checks over the host's own page: its header, notices, recovery controls, findings and
// version dialog, in each state the host's other browser suites drive. axe decides names, roles, ARIA
// validity, the contrast it can compute and target sizes. It cannot decide focus order or what a
// screen reader announces, which the host's other suites assert where they matter. The scan leaves out
// the embedded components, whose own gates measure them.

/**
 * axe's verdict on the page: the rules that fail, and the results it could not decide.
 *
 * The rules are every rule axe-core tags for WCAG 2.0, 2.1 and 2.2 at levels A and AA, and Label in
 * Name. Label in Name, WCAG 2.1's criterion 2.5.3, needs a control's accessible name to contain the
 * text it shows. axe-core's rule for it is experimental, and a tag selection leaves experimental rules
 * out, so it runs by name, as in Workspace's, CED's, the term picker's and CEE's gates.
 */
async function audit(page) {
  const builders = [
    new AxeBuilder({page}).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']),
    new AxeBuilder({page}).withRules(['label-content-name-mismatch']),
  ];
  const verdicts = [];
  // axe runs one analysis at a time in a page.
  for (const builder of builders) {
    for (const selector of EXCLUDED) builder.exclude(selector);
    verdicts.push(await builder.analyze());
  }
  expect(verdicts[1].passes.concat(verdicts[1].violations, verdicts[1].incomplete, verdicts[1].inapplicable)
    .some(result => result.id === 'label-content-name-mismatch'), 'label-content-name-mismatch did not run').toBe(true);
  return {
    violations: verdicts.flatMap(verdict => verdict.violations.flatMap(result => result.nodes.map(node => ({rule: result.id, node})))),
    undecided: verdicts.flatMap(verdict => verdict.incomplete.flatMap(result => result.nodes.map(node => ({rule: result.id, node})))),
  };
}

/**
 * Wait until what is drawn has settled, so contrast is read at full opacity. A click can start a fade
 * a frame or two later, and Chromium lists a shadow tree's animations on its root, not on the document.
 */
async function drawn(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const roots = [document];
    for (const element of document.querySelectorAll('*')) if (element.shadowRoot) roots.push(element.shadowRoot);
    await Promise.all(roots.flatMap(root => root.getAnimations())
      .filter(animation => animation.effect?.getTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => undefined)));
  });
}

/** Each state the gate scans: those the host reaches, and narrow, hovered and focused variants of some. */
const states = {...reached};

/**
 * The states a narrow window rearranges, scanned again at the width of a phone. The header and the
 * notices beneath it have less room, and the dialog narrows to the window.
 */
for (const name of ['template edit', 'read only', 'refused save explained', 'server findings open', 'many server findings', 'version dialog', 'save unconfirmed', 'draft offer']) {
  const open = states[name];
  states[`narrow ${name}`] = async page => {
    await page.setViewportSize({width: 375, height: 812});
    return open(page);
  };
}

/**
 * One control of each kind the host draws, found in the state that shows it. Each is scanned once with
 * the pointer resting on it and once focused from the keyboard, since both change how it is drawn.
 */
const controls = {
  'Workspace return': ['template edit', page => page.getByRole('button', {name: 'Workspace', exact: true})],
  Save: [modified, page => page.getByRole('button', {name: 'Save', exact: true})],
  'notice action': [readOnly, page => page.getByRole('button', {name: 'Recheck access', exact: true})],
  'draft action': [draftOffer, page => page.getByRole('button', {name: 'Restore draft', exact: true})],
  'findings summary': [findingsOpen, page => page.locator('#server-issues summary')],
  'dialog action': [versionDialog, page => page.getByRole('button', {name: 'Create new draft', exact: true})],
};
for (const [kind, [open, find]] of Object.entries(controls)) {
  const opened = typeof open === 'string' ? states[open] : open;
  states[`hovered ${kind}`] = async page => {
    await opened(page);
    const control = find(page);
    await control.hover();
    await expect.poll(() => control.evaluate(element => element.matches(':hover'))).toBe(true);
  };
  states[`focused ${kind}`] = async page => {
    await opened(page);
    const control = find(page);
    // A key press first, so focus is drawn as it is for someone using the keyboard.
    await page.keyboard.press('Shift');
    await control.focus();
    await expect.poll(() => control.evaluate(element => element.matches(':focus-visible'))).toBe(true);
  };
}

/** The axe target of a node as one selector. */
const normalized = node => node.target.flat().join(' ');
const element = (page, node) => page.locator('css=' + node.target.flat().join(' ')).first();

/**
 * The lowest contrast between a text's colour and what is painted under the parts of it that show, as
 * WCAG computes it, or null when none of it shows. Two screenshots of the element, with its text and
 * with its text transparent, give where the glyphs are and the background at each. A pixel counts as a
 * glyph's only when the text changes it markedly, since an edge the glyph barely covers says nothing
 * its core does not. Glyphs something opaque covers are drawn in neither screenshot, so they do not count.
 */
async function textContrast(page, node) {
  const text = element(page, node);
  await text.scrollIntoViewIfNeeded();
  const box = await text.boundingBox();
  const clip = {
    x: Math.floor(box.x), y: Math.floor(box.y),
    width: Math.ceil(box.x + box.width) - Math.floor(box.x),
    height: Math.ceil(box.y + box.height) - Math.floor(box.y),
  };
  const shot = () => page.screenshot({clip, animations: 'disabled', caret: 'hide', scale: 'css'});
  const color = await text.evaluate(element => getComputedStyle(element).color);
  const shown = await shot();
  await text.evaluate(element => {
    element.dataset.contrastProbe = element.style.cssText;
    element.style.setProperty('color', 'transparent', 'important');
    element.style.setProperty('-webkit-text-fill-color', 'transparent', 'important');
  });
  const hidden = await shot();
  await text.evaluate(element => {
    element.style.cssText = element.dataset.contrastProbe;
    delete element.dataset.contrastProbe;
  });
  return page.evaluate(async ({shown, hidden, color}) => {
    const pixels = async png => {
      const image = new Image();
      image.src = 'data:image/png;base64,' + png;
      await image.decode();
      const canvas = new OffscreenCanvas(image.width, image.height);
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, image.width, image.height).data;
    };
    const canvas = new OffscreenCanvas(1, 1).getContext('2d');
    canvas.fillStyle = color;
    canvas.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = canvas.getImageData(0, 0, 1, 1).data;
    const luminance = channels => channels.map(value => value / 255)
      .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
      .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const [withText, without] = await Promise.all([pixels(shown), pixels(hidden)]);
    let lowest = Infinity;
    for (let i = 0; i < withText.length; i += 4) {
      if ([0, 1, 2].every(channel => Math.abs(withText[i + channel] - without[i + channel]) < 32)) continue;
      const background = [without[i], without[i + 1], without[i + 2]];
      const foreground = [r, g, b].map((value, channel) => (value * a + background[channel] * (255 - a)) / 255);
      const [light, dark] = [luminance(foreground), luminance(background)].sort((x, y) => y - x);
      lowest = Math.min(lowest, (light + 0.05) / (dark + 0.05));
    }
    return lowest === Infinity ? null : Math.floor(lowest * 100) / 100;
  }, {shown: shown.toString('base64'), hidden: hidden.toString('base64'), color});
}

/** How each rule's undecided result is measured: the reading, and why it fails, or null when it passes. */
const measures = {
  'color-contrast': async (page, node) => {
    const ratio = await textContrast(page, node);
    if (ratio === null) return {measured: 'covered', failure: null};
    const required = parseFloat(node.any[0]?.data?.expectedContrastRatio ?? '4.5');
    return {measured: `${ratio.toFixed(2)}:1`, failure: ratio < required ? `under ${required}:1` : null};
  },
  // A target is measured by its size. One under 24 px would need its spacing measured instead.
  'target-size': async (page, node) => {
    const box = await element(page, node).boundingBox();
    const measured = `${Math.round(box.width)} × ${Math.round(box.height)} px`;
    return {measured, failure: Math.min(box.width, box.height) < 24 ? 'under 24 px' : null};
  },
};

const manyFindings = ['many server findings', 'narrow many server findings'];

/**
 * Results axe could not decide, each settled by a measurement this spec repeats. Each entry names the
 * rule, a selector the element matches, the text it starts with, the states that produce it, the
 * reading and why that passes. A state that leaves an undecided result no entry names fails, and so
 * does an entry none of its states produces, so the list says exactly what the gate has settled.
 */
const SETTLED = [
  {
    rule: 'color-contrast',
    target: '#server-issues-list > li',
    text: '/properties/Field',
    states: manyFindings,
    measured: '5.95:1',
    reason: 'The findings list scrolls beneath its count, and axe cannot tell what lies under a row scrolled out of view. ' +
      'Scrolled into view, nothing lies over it, and it meets 4.5:1 against the notice.',
  },
];

/**
 * Findings that only a visible change can fix, each kept here with that change, so that the gate passes
 * until it is made. A fix that changes nothing drawn is made in the host instead. Each entry names the
 * rule, a selector the element matches, the text it starts with and the states that produce it. An
 * entry none of its states produces fails, so a finding that goes away takes its entry with it.
 */
const EXCEPTIONS = [];

/** Fail on any finding `state` leaves that neither list names, and on any entry it no longer produces. */
async function judge(page, state, {violations, undecided}) {
  const excepted = EXCEPTIONS.filter(entry => entry.states.includes(state));
  const expected = SETTLED.filter(entry => entry.states.includes(state));
  const describe = async ({rule, node}) => {
    const target = element(page, node);
    const text = ((await target.textContent().catch(() => '')) ?? '').trim();
    const matches = async entries => {
      for (const entry of entries)
        if (entry.rule === rule && text.startsWith(entry.text) && await target.evaluate((element, selector) => element.matches(selector), entry.target))
          return entry;
    };
    return {rule, node, text, where: `${rule} ${normalized(node)} “${text.slice(0, 40)}”`, exception: await matches(excepted), entry: await matches(expected)};
  };
  const produced = new Set();
  const failures = [];
  for (const finding of await Promise.all(violations.map(describe))) {
    if (finding.exception) produced.add(finding.exception);
    else failures.push(`${finding.where}: ${finding.node.failureSummary.replace(/\s+/g, ' ')}`);
  }
  for (const finding of await Promise.all(undecided.map(describe))) {
    if (finding.exception) { produced.add(finding.exception); continue; }
    const reading = measures[finding.rule] ? await measures[finding.rule](page, finding.node) : {measured: 'no measure', failure: 'no measure'};
    const where = `${finding.where} measures ${reading.measured}`;
    const entry = finding.entry;
    if (!entry) failures.push(`undecided and not settled: ${where}`);
    else {
      produced.add(entry);
      if (reading.failure) failures.push(`${where}, ${reading.failure}`);
      else if (reading.measured !== entry.measured) failures.push(`${where}, not ${entry.measured}`);
    }
  }
  expect(failures, `${state}: findings neither list names`).toEqual([]);
  const unproduced = [...excepted, ...expected].filter(entry => !produced.has(entry))
    .map(entry => `${entry.rule} ${entry.target} “${entry.text}”`);
  expect(unproduced, `entries ${state} no longer produces`).toEqual([]);
}

for (const [name, state] of Object.entries(states))
  test(`accessible ${name}`, async ({page}) => {
    // Each of the thirty-odd rows scrolled out of view is measured from two screenshots.
    if (manyFindings.includes(name)) test.slow();
    const after = await state(page);
    await drawn(page);
    await judge(page, name, await audit(page));
    if (typeof after === 'function') await after();
  });

// Each scenario the surface registry records has a state here that reaches it through the real host,
// so a surface added to the registry cannot go unscanned.
const SCENARIOS = {'host-page': 'template edit', version: 'version dialog', error: 'load failed'};
test('every registered surface scenario is scanned', () => {
  const registry = JSON.parse(readFileSync(new URL('../../.ui-surfaces.json', import.meta.url), 'utf8'));
  const scenarios = [...new Set(registry.surfaces.map(surface => surface.scenario).filter(Boolean))];
  expect(scenarios.filter(scenario => !(SCENARIOS[scenario] in states))).toEqual([]);
});

/** A save the server refuses with `errors`, its findings listed and the list open. */
async function findingsListed(page, errors) {
  await saveMeets(page, {status: 400, json: {message: 'Validation failed', objects: {validationReport: {errors}}}});
  await page.locator('#server-issues summary').click();
  await expect(page.locator('#server-issues li')).toHaveCount(errors.length);
  return page.locator('#server-issues-list');
}
/** Where Tab moves focus from the findings summary. */
async function tabFromSummary(page) {
  await page.locator('#server-issues summary').focus();
  await page.keyboard.press('Tab');
  return page.evaluate(() => document.activeElement.id);
}
const outline = locator => locator.evaluate(element => {
  const style = getComputedStyle(element);
  return [style.outlineStyle, style.outlineWidth, style.outlineColor, style.outlineOffset];
});
const scrolls = list => list.evaluate(element => element.scrollHeight > element.clientHeight);

// A list of findings that scrolls is a tab stop named by its count, so that a keyboard can scroll it.
test('a long findings list is a tab stop named by its count and shows the shared focus ring', async ({page}) => {
  const list = await findingsListed(page, Array.from({length: 40}, (_, i) => ({location: `/properties/Field${i}`, message: 'Invalid default IRI'})));
  expect(await scrolls(list)).toBe(true);
  await expect(list).toHaveAttribute('tabindex', '0');
  await expect(page.getByRole('list', {name: text('en', 'Message.ServerFindings', {count: 40}), exact: true})).toBeVisible();
  // The ring every host control takes from the keyboard.
  await page.keyboard.press('Shift');
  await page.locator('#back').focus();
  const ring = await outline(page.locator('#back'));
  expect(ring[0]).toBe('solid');
  expect(await tabFromSummary(page)).toBe('server-issues-list');
  expect(await list.evaluate(element => element.matches(':focus-visible'))).toBe(true);
  expect(await outline(list)).toEqual(ring);
});

for (const count of [1, 2])
  test(`a findings list of ${count} that fits adds no tab stop`, async ({page}) => {
    const list = await findingsListed(page, Array.from({length: count}, (_, i) => ({location: `/properties/Field${i}`, message: 'Invalid default IRI'})));
    expect(await scrolls(list)).toBe(false);
    await expect(list).not.toHaveAttribute('tabindex');
    await expect(list).not.toHaveAttribute('aria-labelledby');
    expect(await tabFromSummary(page)).not.toBe('server-issues-list');
  });

test('narrowing the window until a short findings list scrolls makes it a tab stop, and widening it again does not', async ({page}) => {
  const message = 'The default value is not an IRI the field accepts, so the server refused to store the template as it stands.';
  const list = await findingsListed(page, Array.from({length: 3}, (_, i) => ({location: `/properties/Field${i}`, message})));
  expect(await scrolls(list)).toBe(false);
  await expect(list).not.toHaveAttribute('tabindex');
  await page.setViewportSize({width: 375, height: 500});
  await expect.poll(() => scrolls(list)).toBe(true);
  await expect(list).toHaveAttribute('tabindex', '0');
  await expect(list).toHaveAttribute('aria-labelledby', 'server-issues-title');
  expect(await tabFromSummary(page)).toBe('server-issues-list');
  await page.setViewportSize({width: 1280, height: 720});
  await expect.poll(() => scrolls(list)).toBe(false);
  await expect(list).not.toHaveAttribute('tabindex');
});
