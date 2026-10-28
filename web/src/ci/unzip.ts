// Takes the compiled paper out of a GitHub Actions artifact zip, in the browser.
// fflate is loaded on demand: only people who download a PDF pay for it.

export interface Document {
  /** File name inside the zip (the path, without directories). */
  name: string;
  type: string;
  bytes: Uint8Array;
}

/** The paper PDF, its DOCX, and the changes PDF (latexdiff), when the zip has them. */
export interface Documents {
  pdf?: Document;
  docx?: Document;
  diff?: Document;
}

const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
/** Refuse zips that would unpack into something far larger than a paper. */
const MAX_ENTRY = 200 * 1024 * 1024;

const base = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const usable = (path: string) => !path.endsWith('/') && !path.startsWith('__MACOSX/') && !base(path).startsWith('._');
const isDiff = (path: string) => /[-_.]diff\.pdf$/i.test(base(path));

/** Chooses the entries to extract from the names in the zip. */
export function pickDocuments(paths: string[]): { pdf?: string; docx?: string; diff?: string } {
  const files = paths.filter(usable);
  const pdfs = files.filter((p) => /\.pdf$/i.test(p));
  const paper = pdfs.find((p) => !isDiff(p)) ?? pdfs[0];
  const diff = pdfs.find((p) => p !== paper && isDiff(p));
  const docx = files.find((p) => /\.docx$/i.test(p));
  return { ...(paper && { pdf: paper }), ...(docx && { docx }), ...(diff && { diff }) };
}

const startsWith = (bytes: Uint8Array, magic: string) => [...magic].every((c, i) => bytes[i] === c.charCodeAt(0));

/** Unzips the documents of an artifact. A ".pdf" that is not a PDF is dropped. */
export async function extractDocuments(zip: Uint8Array): Promise<Documents> {
  const { unzipSync } = await import('fflate');
  const names: string[] = [];
  // First pass reads only the directory, so the choice sees every name.
  unzipSync(zip, {
    filter: (file) => {
      names.push(file.name);
      return false;
    },
  });
  const chosen = pickDocuments(names);
  const wanted = new Set(Object.values(chosen));
  const files = unzipSync(zip, { filter: (file) => wanted.has(file.name) && file.originalSize <= MAX_ENTRY });
  const doc = (path: string | undefined, type: string): Document | undefined =>
    path && files[path] ? { name: base(path), type, bytes: files[path] } : undefined;
  const pdf = doc(chosen.pdf, PDF);
  const diff = doc(chosen.diff, PDF);
  const docx = doc(chosen.docx, DOCX);
  return {
    ...(pdf && startsWith(pdf.bytes, '%PDF') && { pdf }),
    ...(docx && { docx }),
    ...(diff && startsWith(diff.bytes, '%PDF') && { diff }),
  };
}
