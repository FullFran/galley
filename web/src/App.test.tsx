import { describe, expect, it } from 'vitest';
import { render } from 'preact-render-to-string';
import { App } from './App';

describe('App', () => {
  it('renders the product name as the page heading', () => {
    expect(render(<App />)).toBe('<h1>galley</h1>');
  });
});
