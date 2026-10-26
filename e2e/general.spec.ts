import { axe, expect, test } from './fixtures.ts';

// General chats belong to no project. The three engines share one world, so each starts and deletes
// a chat of its own; the General control chat is started by whichever engine runs first.

test.describe('General', () => {
  test('start the control chat and a chat from the sidebar; deleting says what happens to its folder', async ({
    signedIn: page,
    browserName,
  }) => {
    await page.goto('/');
    const sidebar = page.locator('[data-sidebar="sidebar"]');
    const group = sidebar.locator('[data-sidebar="group"]', {
      has: page.locator('[data-sidebar="group-label"]', { hasText: /^General$/ }),
    });
    await expect(group).toBeVisible();

    const start = group.getByRole('button', { name: 'Start control chat' });
    if (await start.isVisible()) await start.click();
    const control = group.getByRole('link', { name: /Control chat/ });
    await expect(control).toBeVisible();
    await control.click();
    await expect(page).toHaveURL(/\/chat\//);
    await expect(page.getByRole('navigation', { name: 'breadcrumb' })).toContainText('General');

    await group.getByRole('button', { name: 'New chat' }).click();
    const dialog = page.getByRole('dialog', { name: 'New chat' });
    await expect(dialog).toContainText('deletes that folder and everything in it');
    const title = `Scratch notes ${browserName}`;
    await dialog.getByRole('textbox', { name: 'Title' }).fill(title);
    await dialog.getByRole('textbox', { name: 'First message' }).fill('Hello from the dashboard');
    await axe(page, 'new chat dialog');
    const before = new URL(page.url()).pathname;
    await dialog.getByRole('button', { name: 'Start chat' }).click();
    // With the worker cap full, the dialog says why and offers to start it anyway.
    const anyway = dialog.getByRole('button', { name: 'Start anyway' });
    await Promise.race([page.waitForURL((u) => u.pathname !== before), anyway.waitFor()]);
    if (await anyway.isVisible()) await anyway.click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('navigation', { name: 'breadcrumb' })).toContainText(title);

    const row = group.getByRole('link', { name: new RegExp(title) });
    await expect(row).toBeVisible();
    await expect(
      sidebar
        .locator('[data-sidebar="group"]', { hasText: 'Other AoE sessions' })
        .getByRole('link', { name: new RegExp(title) }),
    ).toHaveCount(0);

    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete…' }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText('A General chat keeps its scratch folder in the trash');
    await confirm
      .getByRole('checkbox', { name: 'Delete permanently instead of moving to the trash' })
      .check();
    await expect(confirm).toContainText('is deleted too, with everything in it');
    await confirm.getByRole('button', { name: 'Delete permanently' }).click();
    await expect(row).toHaveCount(0);
  });
});
