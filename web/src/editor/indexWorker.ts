import { buildIndex } from './projectIndex';
import type { IndexReply, IndexRequest } from './indexClient';

// The index worker: plain text scanning of repository files, nothing runs.

interface WorkerScope {
  postMessage(message: IndexReply): void;
  onmessage: ((event: MessageEvent<IndexRequest>) => void) | null;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (event) => {
  const { id, input } = event.data;
  scope.postMessage({ id, index: buildIndex(input) });
};
