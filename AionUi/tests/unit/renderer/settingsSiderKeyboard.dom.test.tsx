import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import SettingsSider from '@/renderer/pages/settings/components/SettingsSider';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/renderer/hooks/system/useExtensionSettingsTabs', () => ({ useExtensionSettingsTabs: () => [] }));
vi.mock('@/renderer/hooks/system/useExtI18n', () => ({ useExtI18n: () => ({ resolveExtTabName: () => '' }) }));
vi.mock('@/renderer/utils/platform', () => ({ isElectronDesktop: () => true, resolveExtensionAssetUrl: () => '' }));

function CurrentPath() {
  return <span data-testid='current-path'>{useLocation().pathname}</span>;
}

it('lets keyboard users open a settings section', async () => {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={['/settings/agent']}>
      <SettingsSider />
      <CurrentPath />
    </MemoryRouter>
  );
  const model = screen.getByRole('link', { name: 'settings.model' });
  model.focus();
  await user.keyboard('{Enter}');
  expect(screen.getByTestId('current-path')).toHaveTextContent('/settings/model');
  expect(model).toHaveAttribute('aria-current', 'page');
});
