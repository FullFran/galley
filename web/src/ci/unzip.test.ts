import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { extractDocuments, pickDocuments } from './unzip';

describe('pickDocuments', () => {
  it('picks the paper PDF over the diff PDF, and the DOCX', () => {
    expect(pickDocuments(['render.log', 'paper-diff.pdf', 'paper.pdf', 'paper.docx'])).toEqual({ pdf: 'paper.pdf', docx: 'paper.docx', diff: 'paper-diff.pdf' });
  });

  it('takes a diff-looking PDF when it is the only one', () => {
    expect(pickDocuments(['out/paper-diff.pdf'])).toEqual({ pdf: 'out/paper-diff.pdf' });
  });

  it('is case-insensitive and ignores directories and macOS metadata', () => {
    expect(pickDocuments(['dist/', '__MACOSX/._Paper.PDF', 'dist/Paper.PDF'])).toEqual({ pdf: 'dist/Paper.PDF' });
  });

  it('finds nothing in a zip without documents', () => {
    expect(pickDocuments(['render.log'])).toEqual({});
  });
});

describe('extractDocuments', () => {
  const zip = zipSync({
    'paper-tld100-glow-curve.pdf': strToU8('%PDF-1.7 paper'),
    'paper-tld100-glow-curve-diff.pdf': strToU8('%PDF-1.7 diff'),
    'paper-tld100-glow-curve.docx': strToU8('PK docx'),
    'render.log': strToU8('log'),
  });

  it('unzips the PDF, DOCX and diff PDF with their types', async () => {
    const docs = await extractDocuments(zip);
    expect(docs.pdf?.name).toBe('paper-tld100-glow-curve.pdf');
    expect(docs.pdf?.type).toBe('application/pdf');
    expect(new TextDecoder().decode(docs.pdf?.bytes)).toBe('%PDF-1.7 paper');
    expect(docs.docx?.type).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(new TextDecoder().decode(docs.diff?.bytes)).toBe('%PDF-1.7 diff');
  });

  it('drops a ".pdf" entry that is not a PDF', async () => {
    const docs = await extractDocuments(zipSync({ 'paper.pdf': strToU8('<html>') }));
    expect(docs.pdf).toBeUndefined();
  });

  it('rejects bytes that are not a zip', async () => {
    await expect(extractDocuments(strToU8('not a zip'))).rejects.toThrow();
  });
});
