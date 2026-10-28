import type { ProjectSource } from './index';

/** An in-memory project for tests: text files are strings, binary files bytes. */
export function memoryProject(files: Record<string, string | Uint8Array>): ProjectSource & { reads: string[] } {
  const reads: string[] = [];
  const get = (path: string) => {
    reads.push(path);
    const value = files[path];
    if (value === undefined) return Promise.reject(new Error(`${path} not found`));
    return Promise.resolve(value);
  };
  return {
    reads,
    files: Object.keys(files),
    readText: async (path) => {
      const value = await get(path);
      return typeof value === 'string' ? value : new TextDecoder().decode(value);
    },
    readBytes: async (path) => {
      const value = await get(path);
      return typeof value === 'string' ? new TextEncoder().encode(value) : value;
    },
  };
}
