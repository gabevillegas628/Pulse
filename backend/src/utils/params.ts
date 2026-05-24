/** Express v5 types route params as string | string[] — normalize to string. */
export const p = (v: string | string[]): string => (Array.isArray(v) ? v[0] : v)
