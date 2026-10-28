// Minimal typings for the parts of citeproc-js that galley uses.
declare module 'citeproc' {
  interface Sys {
    retrieveLocale(lang: string): string;
    retrieveItem(id: string): unknown;
  }
  interface CiteItem {
    id: string;
    prefix?: string;
    suffix?: string;
    'suppress-author'?: boolean;
    'author-only'?: boolean;
  }
  interface Engine {
    updateItems(ids: string[]): void;
    makeCitationCluster(items: CiteItem[]): string;
    makeBibliography(): false | [{ entry_ids: string[][] }, string[]];
  }
  const CSL: {
    Engine: new (sys: Sys, style: string, lang?: string, forceLang?: boolean) => Engine;
  };
  export default CSL;
}
