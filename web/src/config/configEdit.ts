import { dump } from 'js-yaml';

// Small text edits to `.galley.yml` that keep the admin's comments and
// layout: one new `labels` entry or one new `editable` item, in block style.
// Anything else (flow style `{}` or `[]`, odd indentation) returns undefined,
// and the caller falls back to rewriting the whole file or stops.

const scalar = (value: string) => dump(value, { lineWidth: -1 }).replace(/\n$/, '');

interface Block {
  /** Index of the `key:` line. */
  start: number;
  /** Index after the block's last indented line. */
  end: number;
  /** Indentation of the first child, or undefined when the block is empty. */
  indent?: string;
  /** Text after `key:` on its own line. */
  inline: string;
}

function findBlock(lines: string[], key: string): Block | undefined {
  const start = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (start < 0) return undefined;
  const inline = lines[start]?.slice(key.length + 1).replace(/#.*$/, '').trim() ?? '';
  let end = start + 1;
  let indent: string | undefined;
  let lastContent = start;
  for (; end < lines.length; end += 1) {
    const line = lines[end] ?? '';
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line) && !line.startsWith('- ')) break;
    indent ??= /^(\s*)/.exec(line)?.[1] ?? '';
    lastContent = end;
  }
  return { start, end: lastContent + 1, indent, inline };
}

/** Adds `path: name` to `labels`. */
export function addLabel(text: string, path: string, name: string): string | undefined {
  const lines = text.replace(/\n$/, '').split('\n');
  const entry = `${scalar(path)}: ${scalar(name)}`;
  const block = findBlock(lines, 'labels');
  if (!block) return `${lines.join('\n')}\nlabels:\n  ${entry}\n`;
  if (block.inline !== '') return undefined;
  const indent = block.indent ?? '  ';
  if (indent === '' || indent.includes('\t')) return undefined;
  lines.splice(block.end, 0, `${indent}${entry}`);
  return `${lines.join('\n')}\n`;
}

/** Adds `- path` to `editable`. */
export function addEditable(text: string, path: string): string | undefined {
  const lines = text.replace(/\n$/, '').split('\n');
  const block = findBlock(lines, 'editable');
  if (!block) return `${lines.join('\n')}\neditable:\n  - ${scalar(path)}\n`;
  if (block.inline !== '') return undefined;
  const indent = block.indent ?? '  ';
  if (indent.includes('\t')) return undefined;
  lines.splice(block.end, 0, `${indent}- ${scalar(path)}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Sets `sections.<path>.status`, changing the one line in place or adding the
 * entry (or the block). Undefined for flow style or odd indentation.
 */
export function setSectionStatus(text: string, path: string, status: string): string | undefined {
  const lines = text.replace(/\n$/, '').split('\n');
  const key = `${scalar(path)}:`;
  const block = findBlock(lines, 'sections');
  if (!block) return `${lines.join('\n')}\nsections:\n  ${key}\n    status: ${status}\n`;
  if (block.inline !== '') return undefined;
  const indent = block.indent ?? '  ';
  if (indent === '' || indent.includes('\t')) return undefined;
  for (let i = block.start + 1; i < block.end; i += 1) {
    const line = lines[i] ?? '';
    if (line !== `${indent}${key}` && !line.startsWith(`${indent}${key} `)) continue;
    // The entry's own lines are indented deeper than its key.
    for (let j = i + 1; j < block.end; j += 1) {
      const inner = lines[j] ?? '';
      if (inner.trim() === '' || inner.trimStart().startsWith('#')) continue;
      const own = /^(\s*)/.exec(inner)?.[1] ?? '';
      if (own.length <= indent.length) break;
      const match = /^(\s*status:\s*)([^#\s]*)(.*)$/.exec(inner);
      if (match) {
        lines[j] = `${match[1]}${status}${match[3]}`;
        return `${lines.join('\n')}\n`;
      }
    }
    lines.splice(i + 1, 0, `${indent}${indent}status: ${status}`);
    return `${lines.join('\n')}\n`;
  }
  lines.splice(block.end, 0, `${indent}${key}`, `${indent}${indent}status: ${status}`);
  return `${lines.join('\n')}\n`;
}
