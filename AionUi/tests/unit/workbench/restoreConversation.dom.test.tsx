import React from 'react';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { useRestoreConversation } from '@/renderer/pages/Workbench/useRestoreConversation';
const get = vi.hoisted(() => vi.fn());
vi.mock('@/renderer/pages/conversation/utils/conversationCache', () => ({ getConversationOrNull: get }));
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  get.mockReset();
});
function Host() {
  useRestoreConversation();
  return <Outlet />;
}
function Current() {
  return <p>{useLocation().pathname}</p>;
}
function mount() {
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route element={<Host />}>
          <Route index element={<Navigate to='/guid' replace />} />
          <Route path='/guid' element={<Current />} />
          <Route path='/conversation/:id' element={<Current />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}
it('restores the saved chat after the root route redirects to the welcome route', async () => {
  window.localStorage.setItem('workbench.lastConversation', 'saved-chat');
  get.mockResolvedValue({ id: 'saved-chat' });
  mount();
  await waitFor(() => expect(screen.getByText('/conversation/saved-chat')).toBeTruthy());
});
it('leaves a missing saved conversation on the usable welcome page', async () => {
  window.localStorage.setItem('workbench.lastConversation', 'deleted');
  get.mockResolvedValue(null);
  mount();
  await waitFor(() => expect(get).toHaveBeenCalledWith('deleted'));
  expect(screen.getByText('/guid')).toBeTruthy();
});
