import { CONFIG_PATH, type ProjectConfig } from './project';
import { parseConfig } from './schema';

/** Reads and validates `.galley.yml` when the repository has one. */
export async function loadProjectConfig(
  files: readonly string[],
  readText: (path: string) => Promise<string>,
): Promise<ProjectConfig> {
  if (!files.includes(CONFIG_PATH)) return { kind: 'missing' };
  let text: string;
  try {
    text = await readText(CONFIG_PATH);
  } catch {
    return { kind: 'invalid', problems: [{ severity: 'error', message: `${CONFIG_PATH} could not be read as text.` }] };
  }
  const { config, problems } = parseConfig(text);
  return config ? { kind: 'valid', config, problems } : { kind: 'invalid', problems };
}
