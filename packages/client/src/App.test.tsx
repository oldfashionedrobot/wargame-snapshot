import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NewVersionBanner } from './App';

vi.mock('./net/api', () => ({
  outOfDateStore: { subscribe: () => () => {}, get: () => true },
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('NewVersionBanner', () => {
  it('reloads the page itself when it is the page', () => {
    render(<NewVersionBanner />);
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  });

  // ⚠️ A portal gives each upload its own address, so a frame reloading itself
  // gets the old build back.
  it('asks the player to reload the page around it when it is in a frame', () => {
    vi.spyOn(window, 'top', 'get').mockReturnValue({} as Window);
    render(<NewVersionBanner />);
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
    expect(screen.getByText(/Reload this page/)).toBeTruthy();
  });
});
