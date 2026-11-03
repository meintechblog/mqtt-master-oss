import { describe, it, expect } from 'vitest';

// Test the routing logic without browser APIs
// Mirror the routes map from app.js
const routes = {
  '#/dashboard': 'Dashboard',
  '#/messages': 'Messages',
};

function resolveRoute(hash) {
  return routes[hash] || 'NotFound';
}

function getDefaultHash(currentHash) {
  return currentHash || '#/dashboard';
}

describe('Router', () => {
  it('resolves #/dashboard to Dashboard', () => {
    expect(resolveRoute('#/dashboard')).toBe('Dashboard');
  });

  it('resolves #/messages to Messages', () => {
    expect(resolveRoute('#/messages')).toBe('Messages');
  });

  it('resolves unknown hash to NotFound', () => {
    expect(resolveRoute('#/unknown')).toBe('NotFound');
  });

  it('defaults empty hash to #/dashboard', () => {
    expect(getDefaultHash('')).toBe('#/dashboard');
    expect(getDefaultHash(undefined)).toBe('#/dashboard');
  });

  it('Dashboard and Messages are different routes', () => {
    expect(resolveRoute('#/dashboard')).not.toBe(resolveRoute('#/messages'));
  });
});
