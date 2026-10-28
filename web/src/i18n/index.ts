import { createContext } from 'preact';
import { useContext, useRef } from 'preact/hooks';
import { en, type Messages } from './en';

// UI copy is read by typed property access (`t.nav.proposals`). The context's
// default value is the English dictionary, so components work without a
// provider (tests, server rendering). LocaleProvider passes the catalog of
// the chosen language (`en` or `es`, both of type `Messages`).
export const I18n = createContext<Messages>(en);

export function useT(): Messages {
  return useContext(I18n);
}

/**
 * The current catalog behind a stable ref, for callbacks and effects that must
 * not re-run when the language changes (a re-run could reload the repository
 * and drop unsaved edits).
 */
export function useTRef(): { current: Messages } {
  const t = useT();
  const ref = useRef(t);
  ref.current = t;
  return ref;
}

export { en, type Messages };
