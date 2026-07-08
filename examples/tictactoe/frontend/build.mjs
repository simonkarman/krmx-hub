// Bundles the static tic-tac-toe frontend into public/bundle.js.
import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: 'public/bundle.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  sourcemap: true,
  logLevel: 'info',
});
