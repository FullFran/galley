import { describe, expect, it } from 'vitest';
import { createIndexer, type IndexWorkerLike, type IndexReply, type IndexRequest } from './indexClient';
import { buildIndex } from './projectIndex';
import { PROJECT } from './testProject';

function fakeWorker() {
  const sent: IndexRequest[] = [];
  let terminated = false;
  const worker: IndexWorkerLike = {
    onmessage: null,
    postMessage: (m) => void sent.push(m),
    terminate: () => void (terminated = true),
  };
  const reply = (id: number) =>
    worker.onmessage?.({ data: { id, index: buildIndex(sent.find((s) => s.id === id)?.input ?? PROJECT) } } as MessageEvent<IndexReply>);
  return { worker, sent, reply, terminated: () => terminated };
}

describe('index client', () => {
  it('builds the index in the worker', async () => {
    const fake = fakeWorker();
    const indexer = createIndexer(() => fake.worker);
    const pending = indexer.build(PROJECT);
    fake.reply(1);
    expect((await pending)?.labels.length).toBeGreaterThan(0);
  });

  it('drops a result that a newer build replaced', async () => {
    const fake = fakeWorker();
    const indexer = createIndexer(() => fake.worker);
    const first = indexer.build(PROJECT);
    const second = indexer.build({ ...PROJECT, files: [] });
    fake.reply(2);
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toMatchObject({ labels: [] });
    fake.reply(1);
  });

  it('terminates the worker on dispose', () => {
    const fake = fakeWorker();
    const indexer = createIndexer(() => fake.worker);
    void indexer.build(PROJECT);
    indexer.dispose();
    expect(fake.terminated()).toBe(true);
  });
});
