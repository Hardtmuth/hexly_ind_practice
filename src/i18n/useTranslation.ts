import { useMemo } from 'react'
import { useTranslation as useTranslationBase } from 'react-i18next'

export type TranslateOptions = Record<string, unknown>
export type TranslateFn = (
  key: string,
  defaultValueOrOptions?: string | TranslateOptions,
) => string

export const useTranslation = () => {
  const { t, i18n } = useTranslationBase()

  return useMemo(() => ({
    t: t as unknown as TranslateFn,
    i18n,
  }), [t, i18n]) 
}

export default useTranslation
