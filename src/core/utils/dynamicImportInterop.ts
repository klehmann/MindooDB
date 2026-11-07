/**
 * Reads a named export from the result of a dynamic `import()`.
 *
 * mindoodb's CommonJS build keeps real `import()` calls (`module: nodenext`).
 * Node and Rollup's commonjs plugin expose the CJS exports as named exports,
 * but esbuild (e.g. Vite's dependency prebundle) only gives `default` with
 * the whole `module.exports` object. Look in both places.
 */
export function namedExport<T>(mod: unknown, name: string): T {
  const m = mod as Record<string, unknown> | null | undefined;
  const direct = m?.[name];
  if (direct !== undefined) return direct as T;
  const fallback = (m?.default as Record<string, unknown> | undefined)?.[name];
  if (fallback !== undefined) return fallback as T;
  throw new Error(`Dynamically imported module has no export "${name}"`);
}
