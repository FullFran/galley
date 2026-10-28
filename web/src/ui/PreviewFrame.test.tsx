import { afterEach, describe, expect, it, vi } from 'vitest';

// Regression test for the ready race: the frame may post `ready` as soon as it
// loads, so the message listener must be registered during the commit that
// creates the iframe (a layout effect), not in an effect that runs after paint.
// Without a browser DOM, the hooks are replaced: layout effects run at once and
// passive effects never run, so only a listener registered in a layout effect
// is seen.
vi.mock('preact/hooks', async (importOriginal) => {
  const hooks = await importOriginal<typeof import('preact/hooks')>();
  return {
    ...hooks,
    useLayoutEffect: (fn: () => void) => void fn(),
    useEffect: () => undefined,
  };
});

describe('PreviewFrame ready handshake', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('listens for the frame before it can post ready', async () => {
    const addEventListener = vi.fn();
    vi.stubGlobal('window', { addEventListener, removeEventListener: vi.fn() });
    const { render } = await import('preact-render-to-string');
    const { PreviewFrame } = await import('./PreviewFrame');

    render(<PreviewFrame seq={0} html="" assets={[]} diagnostics={[]} />);

    expect(addEventListener).toHaveBeenCalledWith('message', expect.any(Function));
  });
});
