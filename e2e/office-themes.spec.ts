import type { Page } from '@playwright/test';
import { axe, expect, signIn, test } from './fixtures.ts';

/** The office themes, in the picker's order (SPEC §14.5). */
const THEMES = [
  ['headquarters', 'Headquarters'],
  ['foundry', 'Foundry'],
  ['ryokan', 'Ryokan'],
  ['throne-hall', 'Throne Hall'],
  ['high-roller', 'High Roller'],
  ['fjord', 'Fjord'],
  ['starship', 'Starship'],
] as const;

/** Patches the `ui` settings, as the picker does. */
const setUi = (page: Page, ui: Record<string, unknown>) =>
  page.evaluate(async (ui) => {
    const { token } = (await (await fetch('/api/csrf')).json()) as { token: string };
    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-csrf-token': token },
      body: JSON.stringify({ patch: { ui } }),
    });
    return res.status;
  }, ui);

/** The office theme in the daemon's snapshot, as saved. */
const saved = async (page: Page) =>
  ((await (await page.request.get('/api/snapshot')).json()) as { ui: { officeTheme?: string } }).ui
    .officeTheme;

const floor = (page: Page) => page.locator('[data-office-floor]');

async function drawn(page: Page) {
  await expect(floor(page)).toHaveAttribute('data-renderer', /^(webgl|webgpu|canvas)$/);
}

/** Waits for a second in which the floor draws nothing: render on demand, nothing left moving. */
async function quiet(page: Page, timeout: number) {
  const app = page.getByRole('application');
  await expect
    .poll(
      async () => {
        const before = await app.getAttribute('data-frames');
        await page.waitForTimeout(1000);
        return (await app.getAttribute('data-frames')) === before;
      },
      { timeout },
    )
    .toBe(true);
}

test.describe('office themes', () => {
  test('the picker shows every theme with a preview; a pick restyles the floor at once, without rebuilding it, and is kept', async ({
    signedIn: page,
  }) => {
    await page.goto('/office');
    await drawn(page);
    await expect(floor(page)).toHaveAttribute('data-office-theme', 'headquarters');
    const app = page.getByRole('application');
    // The same canvas from start to end: a theme restyles the office, it does not rebuild the scene.
    await page.locator('[data-office-floor] canvas').evaluate((c) => (c.dataset.themeProbe = 'kept'));

    try {
      const button = page.locator('[data-theme-button]');
      await button.click();
      const menu = page.getByRole('menu', { name: 'Office theme' });
      await expect(menu).toBeVisible();
      const options = menu.getByRole('menuitemradio');
      await expect(options).toHaveCount(THEMES.length);
      for (const [i, [id, name]] of THEMES.entries()) {
        await expect(options.nth(i)).toHaveAttribute('data-office-theme-option', id);
        await expect(options.nth(i)).toContainText(name);
        await expect(options.nth(i).locator('svg').first()).toBeVisible();
      }
      await expect(menu.getByRole('menuitemradio', { name: /Headquarters/ })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await axe(page, 'office theme picker');

      // A click applies it behind the open menu, which stays open to try the next one.
      const before = Number(await app.getAttribute('data-frames'));
      await menu.getByRole('menuitemradio', { name: /Foundry/ }).click();
      await expect(floor(page)).toHaveAttribute('data-office-theme', 'foundry');
      await expect(menu).toBeVisible();
      await expect(menu.getByRole('menuitemradio', { name: /Foundry/ })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await expect.poll(async () => Number(await app.getAttribute('data-frames'))).toBeGreaterThan(before);

      // The keyboard works too: down to Ryokan, Enter.
      await menu.getByRole('menuitemradio', { name: /Foundry/ }).focus();
      await page.keyboard.press('ArrowDown');
      await expect(menu.getByRole('menuitemradio', { name: /Ryokan/ })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(floor(page)).toHaveAttribute('data-office-theme', 'ryokan');

      // Escape closes it, back on the button.
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
      await expect(button).toBeFocused();
      await expect(page.locator('[data-office-floor] canvas[data-theme-probe="kept"]')).toHaveCount(1);

      // Saved in Supercharge's settings, so it is the same everywhere, and after a reload.
      await expect.poll(() => saved(page)).toBe('ryokan');
      await page.reload();
      await drawn(page);
      await expect(floor(page)).toHaveAttribute('data-office-theme', 'ryokan');
    } finally {
      await setUi(page, { officeTheme: 'headquarters' });
    }
    await expect(floor(page)).toHaveAttribute('data-office-theme', 'headquarters');
  });

  test('a theme it does not know (since removed, or mistyped) shows Headquarters', async ({
    signedIn: page,
  }) => {
    await page.goto('/office');
    await drawn(page);
    try {
      expect(await setUi(page, { officeTheme: 'foundry' })).toBe(200);
      await expect(floor(page)).toHaveAttribute('data-office-theme', 'foundry');
      // Kept as written, read as Headquarters.
      expect(await setUi(page, { officeTheme: 'grand-library' })).toBe(200);
      await expect.poll(() => saved(page)).toBe('grand-library');
      await expect(floor(page)).toHaveAttribute('data-office-theme', 'headquarters');
      await page.locator('[data-theme-button]').click();
      await expect(
        page.getByRole('menu', { name: 'Office theme' }).getByRole('menuitemradio', { name: /Headquarters/ }),
      ).toHaveAttribute('aria-checked', 'true');
      await page.keyboard.press('Escape');
    } finally {
      await setUi(page, { officeTheme: 'headquarters' });
    }
  });

  test('torches and neon move a moment after a pick, then the floor goes quiet; with reduced motion they keep still', async ({
    signedIn: page,
    browser,
  }) => {
    await page.goto('/office');
    await drawn(page);
    try {
      expect(await setUi(page, { officeTheme: 'throne-hall' })).toBe(200);
      await expect(floor(page)).toHaveAttribute('data-office-theme', 'throne-hall');
      // The flames flicker for a few seconds, then nothing is drawn while nothing moves.
      await quiet(page, 20_000);

      const ctx = await browser.newContext({ reducedMotion: 'reduce' });
      const still = await ctx.newPage();
      try {
        await signIn(still);
        await still.goto('/office');
        await drawn(still);
        await expect(floor(still)).toHaveAttribute('data-motion', 'jump');
        await expect(floor(still)).toHaveAttribute('data-office-theme', 'throne-hall');
        expect(await setUi(still, { officeTheme: 'high-roller' })).toBe(200);
        await expect(floor(still)).toHaveAttribute('data-office-theme', 'high-roller');
        await quiet(still, 8_000);
      } finally {
        await ctx.close();
      }
    } finally {
      await setUi(page, { officeTheme: 'headquarters' });
    }
  });

  // Every theme by day and by night, for review: OFFICE_THEME_SHOTS=1 npx playwright test office-themes --project chromium
  test('screenshots for review: every theme, dark and light', async ({
    signedIn: page,
    browserName,
  }, info) => {
    test.skip(
      !process.env.OFFICE_THEME_SHOTS || browserName !== 'chromium',
      'only when asked, on one engine',
    );
    test.setTimeout(240_000);
    try {
      for (const mode of ['dark', 'light'] as const) {
        for (const [id] of THEMES) {
          expect(await setUi(page, { theme: mode, officeTheme: id })).toBe(200);
          await page.goto('/office');
          await drawn(page);
          await expect(floor(page)).toHaveAttribute('data-office-theme', id);
          for (const [view, chip] of [
            ['office', 'Whole office'],
            ['door', /^(?!Whole).*office$/],
          ] as const) {
            await page
              .getByRole('navigation', { name: 'Go to' })
              .getByRole('button', { name: chip })
              .first()
              .click();
            await page.mouse.move(0, 0);
            await quiet(page, 20_000);
            await page
              .getByRole('application')
              .screenshot({ path: info.outputPath(`${id}-${mode}-${view}.png`) });
          }
        }
      }
    } finally {
      await setUi(page, { theme: 'dark', officeTheme: 'headquarters' });
    }
  });
});
