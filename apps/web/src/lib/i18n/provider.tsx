"use client";

/**
 * Locale provider (W8-S) — holds the current locale, mirrors it onto
 * `<html lang>` / `<html dir>` for assistive tech, and exposes `t` + `useT`.
 *
 * LOGICAL-DIRECTION NOTE (spec §9.5 — logical start/end alignment, i18n):
 * alignment must be logical (`start`/`end`), never bare physical
 * `left`/`right`, unless a template explicitly needs a physical side. In JSX
 * use Tailwind logical utilities (`ms-*`, `me-*`, `ps-*`, `pe-*`, `text-start`,
 * `text-end`, `border-s-*`, `start-*`/`end-*`); in raw CSS use the
 * `*-inline-*` / `*-block-*` logical properties. Then es/de/fr mirror for
 * free and a future RTL locale is a data entry in LOCALE_DIRECTION
 * (messages.ts), not a layout refactor. The `dir` attribute below keeps
 * screen readers and `:dir()`-aware CSS in sync with that map.
 *
 * Wiring: mount once near the app root (next to other providers). Until the
 * root providers tree wires <I18nProvider> in, `useI18n`/`useT` degrade
 * gracefully to the default-locale dictionary instead of throwing, so
 * pages can adopt `t()` incrementally.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  DEFAULT_LOCALE,
  LOCALE_DIRECTION,
  translate,
  type Locale,
  type MessageKey,
  type MessageVars,
} from "./messages";

export type TranslateFn = (key: MessageKey, vars?: MessageVars) => string;

export type I18nContextValue = {
  locale: Locale;
  /** Switch the active locale (missing keys fall back to `en`). */
  setLocale: Dispatch<SetStateAction<Locale>>;
  /** Writing direction of the active locale ("ltr" | "rtl"). */
  dir: "ltr" | "rtl";
  /** Translate `key` with `{var}` interpolation. */
  t: TranslateFn;
};

const I18nContext = createContext<I18nContextValue | null>(null);

/**
 * Read-only defaults used when no <I18nProvider> is mounted. Stable identity:
 * consumers outside a provider keep rendering en copy (and `setLocale` is a
 * documented no-op) rather than crashing — prerendered pages stay green.
 */
const DEFAULT_CONTEXT: I18nContextValue = {
  locale: DEFAULT_LOCALE,
  setLocale: () => undefined,
  dir: LOCALE_DIRECTION[DEFAULT_LOCALE],
  t: (key, vars) => translate(DEFAULT_LOCALE, key, vars),
};

export type I18nProviderProps = {
  children: ReactNode;
  /** Initial locale; defaults to `en` (the dictionary's source of truth). */
  initialLocale?: Locale;
};

export function I18nProvider({ children, initialLocale = DEFAULT_LOCALE }: I18nProviderProps) {
  const [locale, setLocale] = useState<Locale>(initialLocale);

  useEffect(() => {
    // layout.tsx server-renders <html lang="en">; from hydration on, keep the
    // element in sync with the active locale (§9.5: `dir` follows
    // LOCALE_DIRECTION so logical CSS and screen readers both flip).
    document.documentElement.lang = locale;
    document.documentElement.dir = LOCALE_DIRECTION[locale];
  }, [locale]);

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale,
      dir: LOCALE_DIRECTION[locale],
      t: (key, vars) => translate(locale, key, vars),
    }),
    [locale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Context reader — prefer `useT()` for translations, `useI18n()` for locale. */
export function useI18n(): I18nContextValue {
  return useContext(I18nContext) ?? DEFAULT_CONTEXT;
}
