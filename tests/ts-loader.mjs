/**
 * Custom ESM loader that maps .js imports to .ts when the .js doesn't exist.
 * Used by: node --import ./tests/ts-loader.mjs --experimental-transform-types tests/benchmark.test.ts
 */
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

export function resolve(specifier, context, nextResolve) {
  // Only intercept relative imports ending in .js
  if (specifier.startsWith('.') && specifier.endsWith('.js')) {
    const parentDir = context.parentURL
      ? path.dirname(fileURLToPath(context.parentURL))
      : process.cwd();
    const jsPath = path.resolve(parentDir, specifier);
    if (!existsSync(jsPath)) {
      const tsPath = jsPath.replace(/\.js$/, '.ts');
      if (existsSync(tsPath)) {
        return nextResolve(pathToFileURL(tsPath).href, context);
      }
    }
  }
  return nextResolve(specifier, context);
}
