import * as esbuild from 'esbuild';

const args = new Set(process.argv.slice(2));
const production = args.has('--production');

const entries = args.has('--corpus')
  ? { corpus: 'scripts/corpus.ts', probe: 'scripts/probe.ts', compare: 'scripts/compare.ts' }
  : { client: 'src/client/extension.ts', server: 'src/server/server.ts' };

/** Lines the VS Code watch task waits for before launching the extension host. */
const watchMarkers = {
  name: 'watch-markers',
  setup(build) {
    build.onStart(() => console.log('[watch] build started'));
    build.onEnd((r) => {
      for (const e of r.errors) console.error(`✘ [ERROR] ${e.text}`);
      console.log('[watch] build finished');
    });
  },
};

const ctx = await esbuild.context({
  entryPoints: entries,
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: args.has('--watch') ? 'silent' : 'info',
  plugins: args.has('--watch') ? [watchMarkers] : [],
});

if (args.has('--watch')) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
