import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import { en, type Messages } from './en';

// UI copy is read by typed property access (`t.nav.proposals`). The context's
// default value is the English dictionary, so components work without a
// provider (tests, server rendering). Another language is a catalog of the
// same `Messages` type passed to <I18n.Provider value={es}>.
export const I18n = createContext<Messages>(en);

export function useT(): Messages {
  return useContext(I18n);
}

export { en, type Messages };
