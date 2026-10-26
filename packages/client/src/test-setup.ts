import { afterEach, beforeEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { GUEST_TOKEN_KEY } from './net/guest';

// Testing Library unmounts between tests only when it can find a global
// `afterEach` to hook -- which needs Vitest's `globals: true`, and this repo
// imports its test functions explicitly instead. Without this, every
// renderHook in a file stays mounted for the whole run: React roots pile up,
// fake-server subscriptions are never torn down, and useGameSession's
// unsubscribe-on-unmount never executes in any test. Verified before fixing:
// a probe test saw the previous test's `<div>` still in document.body.
afterEach(cleanup);

// Every suite but the one about identity runs as a guest already, so none of
// them has to script a mint before the call it is actually about.
beforeEach(() => {
  localStorage.setItem(GUEST_TOKEN_KEY, 'test-guest');
});
