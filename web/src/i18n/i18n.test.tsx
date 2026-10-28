import { describe, expect, it, vi } from 'vitest';
import { render } from 'preact-render-to-string';
import type { VNode } from 'preact';
import { en } from './en';
import { es } from './es';
import { I18n } from './index';
import { CATALOGS, LOCALE_KEY, applyLocale, detectLocale, readStoredLocale, storeLocale, syncHtmlLang } from './locale';
import { LocaleProvider } from './LocaleProvider';
import { formatClock, formatUpdated } from './format';
import { CurrentLanguageSwitch, LanguageSwitch } from '../ui/shell/LanguageSwitch';
import { SignedOut } from '../ui/SignedOut';
import { SaveControl } from '../ui/shell/SaveControl';
import { ProposalList } from '../ui/review/ProposalList';
import { describeError } from '../workspace/model';
import { describeReviewError, mergeLabel } from '../review/labels';
import { NotTextError, RejectedError, TransientError } from '../domain';

const noop = () => undefined;

/** Every leaf of a catalog as a dotted path; arrays are walked by index. */
function leafPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) =>
    leafPaths(nested, prefix ? `${prefix}.${key}` : key),
  );
}

function leafAt(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], catalog);
}

describe('message catalogs', () => {
  const enPaths = leafPaths(en).sort();

  it('es has exactly the same keys as en (recursive)', () => {
    expect(leafPaths(es).sort()).toEqual(enPaths);
  });

  it('function messages take the same number of arguments in both languages', () => {
    for (const path of enPaths) {
      const a = leafAt(en, path);
      const b = leafAt(es, path);
      expect(typeof b, path).toBe(typeof a);
      if (typeof a === 'function') expect((b as (...args: unknown[]) => unknown).length, path).toBe(a.length);
    }
  });

  it('has no empty texts and no exclamation marks in Spanish', () => {
    for (const path of leafPaths(es)) {
      const value = leafAt(es, path);
      if (typeof value !== 'string') continue;
      expect(value.trim(), path).not.toBe('');
      expect(value, path).not.toMatch(/[!¡]/);
    }
  });

  it('keeps product names untranslated', () => {
    expect(es.app.name).toBe('galley');
    expect(es.landing.signIn).toContain('GitHub');
    expect(es.meta.lang).toBe('es');
    expect(en.meta.lang).toBe('en');
  });

  it('plurals depend on the count', () => {
    expect(es.save.unsaved(1)).toBe('1 archivo sin guardar');
    expect(es.save.unsaved(3)).toBe('3 archivos sin guardar');
    expect(en.save.unsaved(1)).toBe('1 unsaved file');
    expect(en.preview.notes(2, 0)).toBe('2 preview notes');
  });

  it('exposes both catalogs by locale', () => {
    expect(CATALOGS.es).toBe(es);
    expect(CATALOGS.en).toBe(en);
  });
});

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

const throwing = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};

describe('locale detection', () => {
  it('uses the stored choice first', () => {
    expect(detectLocale(memoryStorage({ [LOCALE_KEY]: 'en' }), ['es-ES'])).toBe('en');
    expect(detectLocale(memoryStorage({ [LOCALE_KEY]: 'es' }), ['en-US'])).toBe('es');
  });

  it('falls back to the browser language, then English', () => {
    expect(detectLocale(memoryStorage(), ['es-MX', 'en'])).toBe('es');
    expect(detectLocale(memoryStorage(), ['ES'])).toBe('es');
    expect(detectLocale(memoryStorage(), ['fr-FR', 'es'])).toBe('en');
    expect(detectLocale(memoryStorage(), [])).toBe('en');
    expect(detectLocale(undefined, [])).toBe('en');
  });

  it('ignores unknown stored values', () => {
    expect(detectLocale(memoryStorage({ [LOCALE_KEY]: 'de' }), ['es'])).toBe('es');
  });

  it('tolerates storage that throws', () => {
    expect(readStoredLocale(throwing)).toBeUndefined();
    expect(detectLocale(throwing, ['es'])).toBe('es');
    expect(() => storeLocale('es', throwing)).not.toThrow();
  });

  it('stores the choice', () => {
    const storage = memoryStorage();
    storeLocale('es', storage);
    expect(storage.data.get(LOCALE_KEY)).toBe('es');
  });
});

describe('html lang', () => {
  it('follows the locale', () => {
    const doc = { documentElement: { lang: 'en' } };
    syncHtmlLang('es', doc);
    expect(doc.documentElement.lang).toBe('es');
  });

  it('applyLocale stores the choice and updates lang, even when storage fails', () => {
    const doc = { documentElement: { lang: 'en' } };
    const storage = memoryStorage();
    applyLocale('es', { storage, doc });
    expect(storage.data.get(LOCALE_KEY)).toBe('es');
    expect(doc.documentElement.lang).toBe('es');
    applyLocale('en', { storage: throwing, doc });
    expect(doc.documentElement.lang).toBe('en');
  });
});

describe('LanguageSwitch', () => {
  it('renders two toggle buttons with aria-pressed', () => {
    const html = render(<LanguageSwitch locale="es" label="Idioma" onLocale={noop} />);
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Idioma"');
    expect(html).toMatch(/aria-pressed="true"[^>]*>ES</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>EN</);
    expect(html).toContain('lang="es"');
    expect(html).toContain('lang="en"');
  });

  it('calls onLocale with the chosen language', () => {
    const onLocale = vi.fn();
    const tree = LanguageSwitch({ locale: 'es', label: 'Idioma', onLocale }) as VNode<{ children: VNode<{ onClick: () => void; lang: string }>[] }>;
    const buttons = tree.props.children;
    buttons.find((b) => b.props.lang === 'en')?.props.onClick();
    expect(onLocale).toHaveBeenCalledWith('en');
  });
});

describe('Spanish UI', () => {
  it('renders the landing page in Spanish through the provider', () => {
    const html = render(
      <LocaleProvider initial="es">
        <SignedOut loginFailed={false} onSignIn={noop} languageSwitch={<CurrentLanguageSwitch />} />
      </LocaleProvider>,
    );
    expect(html).toContain('Entrar con GitHub');
    expect(html).toContain('Hecho por');
    expect(html).toMatch(/aria-pressed="true"[^>]*>ES</);
    expect(html).not.toContain('Sign in with GitHub');
  });

  it('renders the save control in Spanish', () => {
    const html = render(
      <I18n.Provider value={es}>
        <SaveControl dirtyCount={2} message="" placeholder="" saving={false} onMessage={noop} onSave={noop} />
      </I18n.Provider>,
    );
    expect(html).toContain('Guardar para revisión');
    expect(html).toContain('2 archivos sin guardar');
    // Full name for assistive tech; the short label is for narrow headers.
    expect(html).toContain('aria-label="Guardar para revisión"');
    expect(html).toContain('>Guardar</span>');
  });

  it('renders a proposal status chip in Spanish', () => {
    const html = render(
      <I18n.Provider value={es}>
        <ProposalList
          rows={[
            {
              summary: { number: 1, title: 't', updatedAt: '', draft: false },
              overall: 'approved',
              merge: { mergeable: true, state: 'clean' },
            },
          ]}
          onOpen={noop}
        />
      </I18n.Provider>,
    );
    expect(html).toMatch(/class="chip chip-ok"[^>]*>Aprobada/);
    expect(html).toContain('Lista para incorporar.');
  });

  it('explains errors in the active language', () => {
    expect(describeError(new TransientError('x'), es)).toMatch(/conexión/);
    expect(describeError(new NotTextError('x'), en)).toMatch(/cannot be edited here/);
    expect(describeReviewError(new RejectedError('x', 'branch'), es)).toMatch(/protegida/);
    expect(mergeLabel(null, 'unknown', es)).toMatch(/GitHub/);
  });
});

describe('formatting', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');

  it('formats recent updates as relative time', () => {
    expect(formatUpdated('2026-10-28T09:00:00Z', 'es', now)).toBe('hace 3 horas');
    expect(formatUpdated('2026-10-26T12:00:00Z', 'en', now)).toBe('2 days ago');
  });

  it('formats older updates as a date in the locale', () => {
    expect(formatUpdated('2026-01-05T12:00:00Z', 'es', now)).toMatch(/ene/);
    expect(formatUpdated('2026-01-05T12:00:00Z', 'en', now)).toMatch(/Jan/);
    expect(formatUpdated('not a date', 'en', now)).toBe('');
  });

  it('formats the compile time as a clock', () => {
    expect(formatClock(now, 'es')).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});
