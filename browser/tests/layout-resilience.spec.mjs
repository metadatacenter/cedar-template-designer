import {test, expect} from '@playwright/test';
import {VIEWPORTS, check} from './layout-resilience.generated.mjs';
import {EXCLUDED, states} from './host-states.mjs';

// Whether the host's own page survives a narrow window, a zoomed window and wider text, and whether its
// placeholders, field boundaries, icons, focus indicators and selection marks can be seen.
//
// The checks are the shared ones the token package generates into `layout-resilience.generated.mjs`,
// which says what WCAG asks and how each check measures it. This spec reaches each state the
// accessibility gate scans and records what the host excuses. The checks leave out the embedded
// components, whose own suites run the same checks.

/**
 * What the checks find that is left as it is, each with the visible change that would remove it. Fixes
 * that change nothing drawn are made in the host instead. Each entry gives its check, kind, selector,
 * states and why, as `Exception` in the generated declaration says. An entry none of its states
 * produces fails, so the list says exactly what remains.
 */
const EXCEPTIONS = [];

const CHECKS = ['reflow', 'resize', 'spacing', 'placeholder', 'boundary', 'indicators'];

/**
 * Overlays beyond dialogs and the top layer, whose cover hides the controls beneath. A new field's type
 * chooser covers the whole page until a type is chosen, and the fixture's designer draws it as one.
 */
const OVERLAYS = ['.chooser'];

for (const [state, reach] of Object.entries(states))
  for (const name of CHECKS)
    test(`${state}: ${name}`, async ({page}) => {
      await page.setViewportSize(VIEWPORTS[name]);
      const after = await reach(page);
      await page.mouse.move(0, 0);
      const request = {check: name, state, scope: null, exclude: EXCLUDED, exceptions: EXCEPTIONS};
      if (name === 'reflow' || name === 'resize') request.overlays = OVERLAYS;
      if (name === 'indicators') request.selected = [];
      const {measured} = await check(page, expect, request);
      // A check that measured nothing would pass whatever the page drew. Every state shows text and the
      // Workspace return, which takes the keyboard's focus.
      if (['reflow', 'resize', 'spacing'].includes(name)) expect(measured.texts, 'texts measured').toBeGreaterThan(0);
      if (name === 'indicators') expect(measured.focus, 'focus indicators measured').toBeGreaterThan(0);
      if (typeof after === 'function') await after();
    });
