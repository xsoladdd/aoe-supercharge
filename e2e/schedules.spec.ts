import { axe, expect, test } from './fixtures.ts';

// Each browser adds and deletes a schedule of its own, aimed at the demo's "ops control" session.

test.describe('schedules', () => {
  test('add a scheduled prompt, turn it off and on, run it now, edit it and delete it', async ({
    signedIn: page,
    browserName,
  }) => {
    const name = `Nightly status (${browserName})`;
    await page.goto('/');
    await page
      .locator('[data-sidebar="sidebar"]')
      .getByRole('link', { name: 'Schedules', exact: true })
      .click();
    await expect(page).toHaveURL(/\/schedules$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Schedules' })).toBeVisible();

    await page.getByRole('button', { name: 'New schedule' }).click();
    const dialog = page.getByRole('dialog', { name: 'New schedule' });
    await expect(dialog.getByRole('button', { name: 'Add schedule' })).toBeDisabled();
    await dialog.getByLabel('Name').fill(name);
    await dialog.getByRole('combobox', { name: 'Chat' }).click();
    await page.getByRole('option', { name: 'ops control' }).click();
    await dialog.getByLabel('Prompt').fill('Post a short status update.');
    await dialog.getByLabel('Time').fill('07:30');
    await axe(page, 'schedule-dialog');
    await dialog.getByRole('button', { name: 'Add schedule' }).click();
    await expect(dialog).toBeHidden();

    const row = page.getByRole('listitem', { name });
    await expect(row).toContainText('Every day at 07:30');
    await expect(row.getByRole('link', { name: 'ops control' })).toBeVisible();
    await expect(row).toContainText('Last: never');
    await expect(row).not.toContainText('Next: off');

    const toggle = row.getByRole('switch', { name: `Run ${name} on schedule` });
    await toggle.click();
    await expect(row).toContainText('Next: off');
    await toggle.click();
    await expect(row).not.toContainText('Next: off');

    await row.getByRole('button', { name: 'Run now' }).click();
    await expect(page.getByText('Sent to the chat. It goes in once Claude is free.')).toBeVisible();
    await expect(row).toContainText('(Run now)');
    await expect(row.getByText(/^(Waiting for the chat|Sent)$/)).toBeVisible();
    await axe(page, 'schedules');

    await row.getByRole('button', { name: `Edit ${name}` }).click();
    const edit = page.getByRole('dialog', { name: 'Edit schedule' });
    await expect(edit.getByLabel('Name')).toHaveValue(name);
    await edit.getByRole('combobox', { name: 'Days' }).click();
    await page.getByRole('option', { name: 'Weekdays' }).click();
    await edit.getByRole('button', { name: 'Save' }).click();
    await expect(row).toContainText('Weekdays at 07:30');

    await row.getByRole('button', { name: `Delete ${name}` }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByRole('listitem', { name })).toHaveCount(0);
  });
});
