"use client";

/**
 * `useT()` — the translation hook (W8-S).
 *
 *   const t = useT();
 *   t("common.retry");
 *   t("billing.creditsBalance", { count: 3 }); // "3 credits"
 *
 * Interpolation is `{var}` (messages.ts `formatMessage`); missing keys fall
 * back to the `en` dictionary. See provider.tsx for the §9.5 logical
 * start/end alignment note and messages.ts for the key dictionary. Needs
 * <I18nProvider> to switch locales; without it, the hook safely returns
 * default-locale copy.
 */

import { useI18n, type TranslateFn } from "./provider";

export function useT(): TranslateFn {
  return useI18n().t;
}
