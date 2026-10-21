/**
 * Minimal i18n dictionary — W8-S.
 *
 * Locale codes match the lang-suffixed variant naming in spec §10.2
 * (`… — <size/lang>`, e.g. `Headline — es`): a layer variant named `… — es`
 * renders copy from the `es` bundle here, so document variants and UI chrome
 * always agree on the same locale identifiers.
 *
 * `en` is the source of truth: its literal keys define `MessageKey`. Other
 * locales are partial bundles — missing keys fall back to `en` at lookup time
 * (`translate` below), so translations land incrementally without lockstep
 * PRs. Keys are flat, dot-namespaced, lower-case segments (`"common.retry"`).
 *
 * Dictionary strings are user-facing: per §15.2 / AGENTS.md they must never
 * leak internal ids, absolute paths, stack traces or the internal codename.
 */

export const LOCALES = ["en", "es", "de", "fr"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

/** en is the complete dictionary; its keys are the canonical key set. */
export const en = {
  "common.loading": "Loading…",
  "common.save": "Save",
  "common.cancel": "Cancel",
  "common.close": "Close",
  "common.retry": "Try again",
  "common.error": "Something went wrong.",
  "common.empty": "Nothing here yet.",
  "common.signOut": "Sign out",
  "billing.creditsBalance": "{count} credits",
  "a11y.skipToContent": "Skip to main content",
  "a11y.mainLandmark": "Main content",
} as const;

export type MessageKey = keyof typeof en;

/** Only the default locale is required to be complete; others may be partial. */
export type MessageBundle = Partial<Record<MessageKey, string>>;

/**
 * Stub bundles — W8-S scaffold. Translation waves fill these in; a missing key
 * falls back to `en` via `translate`, never to a blank string.
 */
export const es: MessageBundle = {};
export const de: MessageBundle = {};
export const fr: MessageBundle = {};

export const dictionaries: Record<Locale, MessageBundle> = { en, es, de, fr };

/**
 * Writing direction per locale (§9.5 logical alignment). All locales shipped
 * today are LTR; the map exists so adding an RTL locale is a data change plus
 * an audit of any remaining physical `left`/`right` CSS — not a refactor.
 */
export const LOCALE_DIRECTION: Record<Locale, "ltr" | "rtl"> = {
  en: "ltr",
  es: "ltr",
  de: "ltr",
  fr: "ltr",
};

export type MessageVars = Readonly<Record<string, string | number>>;

/**
 * Interpolate `{var}` placeholders: `formatMessage("{count} credits", { count: 3 })`
 * → `"3 credits"`. Missing vars collapse to "" (a leaked `{placeholder}` reads
 * worse than a quiet omission); the replacer-function form avoids `$&`-style
 * `String.replace` substitution pitfalls when values contain "$".
 */
export function formatMessage(template: string, vars?: MessageVars): string {
  if (!vars) {
    return template;
  }
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_placeholder, name: string) => {
    const value = vars[name];
    return value === undefined ? "" : String(value);
  });
}

/**
 * Resolve `key` for `locale` with `{var}` interpolation. Falls back to the
 * `en` dictionary for keys a locale has not translated yet. Type-safe for
 * callers (`MessageKey`); unknown runtime locales are treated as the default.
 */
export function translate(locale: Locale, key: MessageKey, vars?: MessageVars): string {
  const bundle: MessageBundle = dictionaries[locale];
  const template: string = bundle[key] ?? en[key];
  return formatMessage(template, vars);
}
