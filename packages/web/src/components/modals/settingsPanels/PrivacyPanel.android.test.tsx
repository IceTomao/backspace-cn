import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import i18n from '../../../i18n';
import { PrivacyPanel } from './PrivacyPanel';

const call = vi.hoisted(() => vi.fn());
vi.mock('../../../platform/android', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../platform/android')>(),
  isAndroid: () => true,
  androidCall: call,
  onAndroid: () => () => {},
}));

it('shows native notifications and enables background connection with permission', async () => {
  const settings = { theme: 'dark', dark: true, background: false, server: 'https://example.test', messageNotifications: false, notificationsAllowed: true };
  call.mockImplementation(async (_action, update) => update ? { ...settings, ...update } : settings);
  render(<PrivacyPanel />);

  const toggle = await screen.findByRole('switch', { name: i18n.t('settings:android.messageNotifications') });
  expect(toggle).toHaveAttribute('aria-checked', 'false');
  expect(screen.queryByText(i18n.t('settings:privacy.webPush.label'))).not.toBeInTheDocument();
  fireEvent.click(toggle);
  await waitFor(() => expect(call).toHaveBeenCalledWith('preferences', { messageNotifications: true, background: true }));
  await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
});
