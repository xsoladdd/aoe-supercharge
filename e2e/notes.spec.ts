import { axe, expect, test } from './fixtures.ts';

// The demo has, for northwind-web, two todos and a note (one of each from Claude), and a global note.
// Each browser works on notes of its own, so the three engines never tick each other's.

test.describe('notes', () => {
  test('the Notes page lists each project, then the global notes; Claude’s and yours', async ({
    signedIn: page,
  }) => {
    await page.goto('/');
    await page.locator('[data-sidebar="sidebar"]').getByRole('link', { name: 'Notes', exact: true }).click();
    await expect(page).toHaveURL(/\/notes$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Notes' })).toBeVisible();
    const nw = page.getByRole('region', { name: 'northwind-web' });
    await expect(
      nw.getByRole('checkbox', { name: 'Confirm the cutover window with the client' }),
    ).not.toBeChecked();
    await expect(nw.getByText('Staging is read-only on Fridays from 15:00')).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Global' }).getByText('Renew the GitLab token'),
    ).toBeVisible();
    // The project sections come before the global one.
    const order = await page
      .locator('section[data-scope]')
      .evaluateAll((s) => s.map((x) => x.getAttribute('data-scope')));
    expect(order.indexOf('northwind-web')).toBeLessThan(order.indexOf('global'));
    await axe(page, 'notes');
  });

  test('add a todo, tick it, archive it, and restore it from the archive', async ({
    signedIn: page,
    browserName,
  }) => {
    const text = `Check the footer links (${browserName})`;
    await page.goto('/notes?scope=northwind-web');
    const form = page.getByRole('form', { name: 'Add a todo or a note' });
    await expect(form.getByRole('radio', { name: 'To do' })).toHaveAttribute('aria-checked', 'true');
    await form.getByRole('textbox', { name: 'Todo' }).press('Enter');
    await expect(form.getByRole('alert')).toHaveText('Write the todo first.');
    await form.getByRole('textbox', { name: 'Todo' }).fill(text);
    await form.getByRole('button', { name: 'Add' }).click();
    const box = page.getByRole('checkbox', { name: text });
    await expect(box).not.toBeChecked();
    await expect(form.getByRole('textbox', { name: 'Todo' })).toHaveValue('');

    await box.check();
    await expect(box).toBeChecked();
    const row = page.locator('li[data-note]', { has: box });
    await expect(row).toHaveAttribute('data-done', 'true');

    await row.getByRole('button', { name: `Archive: ${text}` }).click();
    await expect(page.getByRole('checkbox', { name: text })).toHaveCount(0);
    await page.getByRole('link', { name: 'Archived' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Archived notes' })).toBeVisible();
    await page.getByRole('button', { name: `Restore: ${text}` }).click();
    await expect(page.getByRole('button', { name: `Restore: ${text}` })).toHaveCount(0);
    await page.getByRole('link', { name: 'Back to the board' }).click();
    await expect(page.getByRole('checkbox', { name: text })).toBeChecked();
    // Tidy up for the other engines' runs.
    await page
      .locator('li[data-note]', { has: page.getByRole('checkbox', { name: text }) })
      .getByRole('button', { name: /^Archive:/ })
      .click();
  });

  test('a global note goes under Global', async ({ signedIn: page, browserName }) => {
    const text = `Ask about the holiday rota (${browserName})`;
    await page.goto('/notes');
    const form = page.getByRole('form', { name: 'Add a todo or a note' });
    await form.getByRole('radio', { name: 'Note' }).click();
    await form.getByRole('combobox', { name: 'For' }).selectOption({ label: 'Global' });
    await form.getByRole('textbox', { name: 'Note' }).fill(text);
    await form.getByRole('textbox', { name: 'Note' }).press('Enter');
    await expect(page.getByRole('region', { name: 'Global' }).getByText(text)).toBeVisible();
    await page.getByRole('button', { name: `Archive: ${text}` }).click();
    await expect(page.getByText(text)).toHaveCount(0);
  });

  test('the whiteboard in the office opens up close, with the boxes to tick', async ({
    signedIn: page,
    browserName,
  }) => {
    const text = `Send the launch email (${browserName})`;
    await page.goto('/office');
    const floor = page.locator('[data-office-floor]');
    await expect(floor).toHaveAttribute('data-renderer', /^(webgl|webgpu|canvas)$/);
    await page.getByRole('navigation', { name: 'Go to' }).getByRole('button', { name: 'Whiteboard' }).click();
    await expect(floor).toHaveAttribute('data-camera-focus', 'board');
    const card = page.locator('[data-whiteboard-card]');
    await expect(card.getByRole('heading', { name: 'Whiteboard' })).toBeVisible();
    await expect(card.getByRole('checkbox', { name: 'Book a QA pass on the iPad' })).toBeVisible();
    await card.getByRole('textbox', { name: 'Todo' }).fill(text);
    await card.getByRole('textbox', { name: 'Todo' }).press('Enter');
    const box = card.getByRole('checkbox', { name: text });
    await box.check();
    await expect(box).toBeChecked();
    await axe(page, 'office whiteboard');
    await card.getByRole('button', { name: `Archive: ${text}` }).click();
    await expect(card.getByRole('checkbox', { name: text })).toHaveCount(0);
    // Escape puts the card away, as a worker's does.
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
  });
});
