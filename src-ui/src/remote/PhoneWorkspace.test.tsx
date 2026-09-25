// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RemoteClient } from './client';
import { PhoneWorkspace } from './PhoneWorkspace';

const fixtures = vi.hoisted(() => ({ sessions: [{ id: 'old', tool: 'claude', cwd: '/project', running: true, paused: false, cols: 80, rows: 24, output_chunks: 0 }] }));
vi.mock('./useConnection', () => ({ useConnection: () => ({ state: { sessions: fixtures.sessions, device_name: 'test' }, tools: [], connection: 'online', refresh: () => {} }) }));
vi.mock('./ChatView', () => ({ ChatView: ({ session }: { session: { id: string } }) => <input aria-label={`composer-${session.id}`} /> }));
vi.mock('./LaunchSheet', () => ({ LaunchSheet: ({ onLaunched }: { onLaunched: (id: string) => void }) => <button onClick={() => onLaunched('new')}>Confirm launch</button> }));
beforeEach(() => { localStorage.clear(); vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('never sends a new-session prompt into the previously selected terminal while startup is pending', async () => {
  const client = new RemoteClient('http://localhost', '');
  const view = render(<PhoneWorkspace client={client} />);
  expect(screen.getByRole('textbox', { name: 'composer-old' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '新建会话' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm launch' }));
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.getByText('正在电脑上启动会话…')).toBeTruthy();
  fixtures.sessions = [...fixtures.sessions, { ...fixtures.sessions[0], id: 'new' }];
  await act(async () => { view.rerender(<PhoneWorkspace client={client} />); });
  expect(screen.getByRole('textbox', { name: 'composer-new' })).toBeTruthy();
  expect(screen.queryByRole('textbox', { name: 'composer-old' })).toBeNull();
});
