import { describe, expect, it } from 'vitest';
import { FRAME_READY, PREVIEW_RENDER, PREVIEW_SCROLL, createReadyGate, parseFrameMessage, parseRenderMessage, parseScrollMessage } from './protocol';

const valid = () => ({
  type: PREVIEW_RENDER,
  seq: 3,
  html: '<p>Hi</p>',
  assets: [{ id: 'a0', type: 'image/png', bytes: new Uint8Array([1, 2]) }],
});

describe('parseRenderMessage', () => {
  it('accepts a well-formed render message', () => {
    expect(parseRenderMessage(valid())).toEqual(valid());
  });

  it.each([
    ['null', null],
    ['a string', 'render'],
    ['an array', [valid()]],
    ['another type', { ...valid(), type: 'other' }],
    ['extra keys', { ...valid(), script: 'x' }],
    ['a missing key', { type: PREVIEW_RENDER, seq: 1, html: '' }],
    ['a fractional seq', { ...valid(), seq: 1.5 }],
    ['a negative seq', { ...valid(), seq: -1 }],
    ['non-string html', { ...valid(), html: 42 }],
    ['oversized html', { ...valid(), html: 'x'.repeat(8 * 1024 * 1024 + 1) }],
    ['assets that are not an array', { ...valid(), assets: {} }],
    ['an HTML asset', { ...valid(), assets: [{ id: 'a0', type: 'text/html', bytes: new Uint8Array() }] }],
    ['an asset id with markup', { ...valid(), assets: [{ id: '"><x', type: 'image/png', bytes: new Uint8Array() }] }],
    ['asset bytes as a string', { ...valid(), assets: [{ id: 'a0', type: 'image/png', bytes: 'AAAA' }] }],
    ['extra asset keys', { ...valid(), assets: [{ id: 'a0', type: 'image/png', bytes: new Uint8Array(), src: 'x' }] }],
    ['too many assets', { ...valid(), assets: Array.from({ length: 501 }, (_, i) => ({ id: `a${i}`, type: 'image/png', bytes: new Uint8Array() })) }],
  ])('rejects %s', (_name, data) => {
    expect(parseRenderMessage(data)).toBeUndefined();
  });
});

describe('parseFrameMessage', () => {
  it('accepts only the ready message', () => {
    expect(parseFrameMessage({ type: FRAME_READY })).toEqual({ type: FRAME_READY });
    expect(parseFrameMessage({ type: FRAME_READY, extra: 1 })).toBeUndefined();
    expect(parseFrameMessage({ type: 'galley-preview:token' })).toBeUndefined();
    expect(parseFrameMessage('ready')).toBeUndefined();
  });
});

describe('ready gate', () => {
  // The frame posts ready while its script runs, before the iframe's load event.
  it('accepts one ready per frame load and allows posting after it', () => {
    const gate = createReadyGate();
    expect(gate.canPost()).toBe(false);
    expect(gate.ready()).toBe(true);
    expect(gate.ready()).toBe(false);
    gate.loaded();
    expect(gate.canPost()).toBe(true);
  });

  it('accepts a fresh ready after a reload of the preview page', () => {
    const gate = createReadyGate();
    gate.ready();
    gate.loaded();
    expect(gate.ready()).toBe(true);
    gate.loaded();
    expect(gate.canPost()).toBe(true);
  });

  it('stops posting when the frame loaded without a fresh ready', () => {
    const gate = createReadyGate();
    gate.ready();
    gate.loaded();
    gate.loaded();
    expect(gate.canPost()).toBe(false);
    expect(gate.ready()).toBe(true);
    expect(gate.canPost()).toBe(true);
  });
});

describe('parseScrollMessage', () => {
  const scroll = () => ({ type: PREVIEW_SCROLL, id: 'sec-band', text: 'Band model' });

  it('accepts a heading target', () => {
    expect(parseScrollMessage(scroll())).toEqual(scroll());
    expect(parseScrollMessage({ ...scroll(), id: '' })).toEqual({ ...scroll(), id: '' });
  });

  it.each([
    ['another type', { ...scroll(), type: PREVIEW_RENDER }],
    ['extra keys', { ...scroll(), html: '<p>' }],
    ['an id with markup', { ...scroll(), id: '"><img>' }],
    ['a long text', { ...scroll(), text: 'x'.repeat(501) }],
    ['a non-string text', { ...scroll(), text: 3 }],
  ])('rejects %s', (_name, data) => {
    expect(parseScrollMessage(data)).toBeUndefined();
  });
});
