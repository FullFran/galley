import { findInFiles } from './findAll';
import { FIND_TIMEOUT_MS, parseFindRequest, type FindReply } from './findRunner';

// The find worker: plain text and regular expression search, nothing runs.
// It also stops itself between matches near the time limit, so many cheap
// matches end with a partial result instead of being terminated.

interface WorkerScope {
  postMessage(message: FindReply): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (event) => {
  const request = parseFindRequest(event.data);
  if (!request) return;
  const stopAt = Date.now() + FIND_TIMEOUT_MS * 0.8;
  scope.postMessage({ id: request.id, result: findInFiles(request.files, request.options, { deadline: () => Date.now() > stopAt }) });
};
