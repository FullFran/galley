import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRenderClient, type WorkerLike, type WorkerReply, type WorkerRequest } from './client';
import { memoryProject } from './testProject';

/** A stand-in for the render worker, driven by `behave`. */
function fakeWorkers(behave: (msg: WorkerRequest, reply: (m: WorkerReply) => void) => void) {
  const spawned: (WorkerLike & { terminated: boolean })[] = [];
  const spawn = () => {
    const worker: WorkerLike & { terminated: boolean } = {
      terminated: false,
      onmessage: null,
      postMessage(msg) {
        const reply = (m: WorkerReply) =>
          queueMicrotask(() => {
            if (!worker.terminated) worker.onmessage?.({ data: m } as MessageEvent<WorkerReply>);
          });
        behave(msg as WorkerRequest, reply);
      },
      terminate() {
        worker.terminated = true;
      },
    };
    spawned.push(worker);
    return worker;
  };
  return { spawn, spawned };
}

afterEach(() => vi.useRealTimers());

describe('render client', () => {
  it('renders in the worker and answers its file reads from the project', async () => {
    const { spawn } = fakeWorkers((msg, reply) => {
      if (msg.type === 'render') reply({ type: 'read', id: msg.id, req: 1, path: 'index.qmd', binary: false });
      if (msg.type === 'read-result' && msg.ok) {
        reply({ type: 'done', id: msg.id, result: { html: `<p>${String(msg.value)}</p>`, assets: [], diagnostics: [] } });
      }
    });
    const client = createRenderClient(spawn, 5000);
    const out = await client.render(memoryProject({ 'index.qmd': 'Hello' }));
    expect(out?.html).toBe('<p>Hello</p>');
  });

  it('stops a render that exceeds its budget and starts a fresh worker', async () => {
    vi.useFakeTimers();
    const { spawn, spawned } = fakeWorkers(() => undefined);
    const client = createRenderClient(spawn, 5000);
    const pending = client.render(memoryProject({ 'index.qmd': 'x' }));
    await vi.advanceTimersByTimeAsync(5000);
    const out = await pending;
    expect(out?.html).toBe('');
    expect(out?.diagnostics.map((d) => d.message)).toEqual([expect.stringMatching(/too complex to preview/i)]);
    expect(spawned[0]?.terminated).toBe(true);
    void client.render(memoryProject({ 'index.qmd': 'y' }));
    expect(spawned.length).toBe(2);
  });

  it('does not count time spent waiting for file reads', async () => {
    vi.useFakeTimers();
    const { spawn, spawned } = fakeWorkers((msg, reply) => {
      if (msg.type === 'render') reply({ type: 'read', id: msg.id, req: 7, path: 'slow.qmd', binary: false });
      if (msg.type === 'read-result') reply({ type: 'done', id: msg.id, result: { html: 'ok', assets: [], diagnostics: [] } });
    });
    const slow = memoryProject({});
    slow.readText = () => new Promise((resolve) => setTimeout(() => resolve('late'), 20_000));
    const client = createRenderClient(spawn, 5000);
    const pending = client.render(slow);
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await pending)?.html).toBe('ok');
    expect(spawned[0]?.terminated).toBe(false);
  });

  it('keeps only the latest queued render', async () => {
    let finish: (() => void) | undefined;
    const { spawn } = fakeWorkers((msg, reply) => {
      if (msg.type === 'render') finish = () => reply({ type: 'done', id: msg.id, result: { html: `r${msg.id}`, assets: [], diagnostics: [] } });
    });
    const client = createRenderClient(spawn, 5000);
    const first = client.render(memoryProject({}));
    const second = client.render(memoryProject({}));
    const third = client.render(memoryProject({}));
    finish?.();
    expect((await first)?.html).toBe('r1');
    expect(await second).toBeUndefined();
    await Promise.resolve();
    finish?.();
    expect((await third)?.html).toBe('r3');
  });
});
