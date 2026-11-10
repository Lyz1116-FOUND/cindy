import assert from 'node:assert/strict';
export default {
  name: 'automation-unread',
  entry: './fixture.tsx',
  viewport: { width: 360, height: 640 },
  real: 'AutomationSessionGroupItem, SessionItem, automationSidebarGrouping',
  notCovered: 'Scheduler delivery, persisted read state, full sidebar ancestors and remote devices',
  stubs: {
    'src/renderer/contexts/AuthContext': {
      partial: 'export const useAuth = () => ({dataOwnerId: "fixture", isAuthenticated: false});',
    },
    'src/renderer/features/bots/BotFollowMark': {
      partial: 'export const BotFollowMark = () => null; export const useSessionFollowers = () => [];',
    },
  },
  cases: {
    demo: {
      about: 'Interactive task sidebar preview with reading and reset controls',
      viewport: { width: 960, height: 640 },
    },
    default: { about: 'Expanded history includes the header task; collapsed unread rows exclude it' },
    'follow-up': { about: 'Built-in teammate follow-up group header uses the current language, not the stored default name' },
    'follow-up-expanded': {
      about: 'Expanded built-in follow-up group shows localized child titles and preserves a custom name',
      viewport: { width: 520, height: 640 },
    },
  },
  async check(page, ui) {
    if (ui.case === 'follow-up' || ui.case === 'follow-up-expanded') {
      const title = await ui.t('routines.builtinFollowUp.name');
      const expanded = ui.case === 'follow-up-expanded';
      await page.getByText(title, { exact: true }).first().waitFor();
      assert.equal(await page.getByText('跟进任务', { exact: true }).count(), 0, 'stored default name is not rendered');
      await page.getByRole('button', {
        name: await ui.t(expanded ? 'ccAgent.sidebar.automationGroup.collapse' : 'ccAgent.sidebar.automationGroup.expand', { title }),
        exact: true,
      }).waitFor();
      if (expanded) {
        await page.locator('[data-session-id="follow-1"]').waitFor();
        await page.locator('[data-session-id="follow-2"]').waitFor();
        await page.locator('[data-session-id="follow-1"]').getByText(title, { exact: true }).first().waitFor();
        await page.locator('[data-session-id="follow-2"]').getByText('My task tracker', { exact: true }).first().waitFor();
        await ui.capture('expanded-localized-titles');
      } else {
        await ui.capture('localized-group-header');
      }
      return;
    }
    for (let i = 1; i <= 6; i++)
      assert.equal(await page.locator(`[data-session-id="run-${i}"]`).count(), 1);
    assert.equal(await page.locator('[data-session-id="run-0"]').count(), 0);
    assert.equal(await page.getByText('已读结果', { exact: true }).count(), 0);
    await page
      .getByRole('button', {
        name: await ui.t('ccAgent.sidebar.automationGroup.expand', { title: '每日巡检' }),
        exact: true,
      })
      .click();
    await page.locator('[data-session-id="run-7"]').waitFor();
    assert.equal(await page.locator('[data-session-id="run-0"]').count(), 1);
    assert.equal(await page.locator('[data-sidebar-session-row="true"]').count(), 8);
    await ui.capture('expanded-all-runs');
    await page
      .getByRole('button', {
        name: await ui.t('ccAgent.sidebar.automationGroup.collapse', { title: '每日巡检' }),
        exact: true,
      })
      .click();
    await page.locator('[data-session-id="run-7"]').waitFor({ state: 'detached' });
    assert.equal(await page.locator('[data-session-id="run-0"]').count(), 0);
    await page.locator('[data-session-id="run-6"]').click();
    await page.locator('[data-session-id="run-6"]').waitFor({ state: 'detached' });
  },
};
