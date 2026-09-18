import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import en from "../i18n/en.json";
import vi from "../i18n/vi.json";

const DICTS: Record<string, Record<string, string>> = { en, vi };

type TFn = (key: string, vars?: Record<string, string | number>) => string;

interface I18nContextValue {
  locale: string;
  setLocale: (l: string) => void;
  t: TFn;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function interpolate(str: string, vars?: Record<string, string | number>): string {
  if (!vars) return str;
  return str.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}

export function I18nProvider({
  children,
  initialLocale,
}: {
  children: ReactNode;
  initialLocale?: string;
}) {
  const [locale, setLocaleState] = useState<string>(() => {
    return initialLocale || localStorage.getItem("locale") || "vi";
  });

  const setLocale = useCallback((l: string) => {
    setLocaleState(l);
    localStorage.setItem("locale", l);
  }, []);

  const t: TFn = useCallback(
    (key, vars) => {
      const dict = DICTS[locale] ?? DICTS.en ?? {};
      const raw = dict[key] ?? key;
      return interpolate(raw, vars);
    },
    [locale],
  );

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside I18nProvider");
  return ctx;
}

export function useT(): TFn {
  return useI18n().t;
}
