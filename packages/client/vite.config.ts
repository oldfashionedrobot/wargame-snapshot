// vitest/config is vite's defineConfig plus the typed `test` key -- one config
// for both tools, which is the reason the client runs Vitest at all.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// ⚠️ **The client always reaches the server cross-origin** -- from Vite in
// development exactly as from a portal's CDN in production -- so the server's
// address is compiled in, from one variable, `API_ORIGIN`, read from the root
// `.env` or the environment of a release. Unset, it is the local server on
// `PORT`, which is where the server reads its own port; development and the
// gate's build want exactly that.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('../..', import.meta.url)), [
    'PORT',
    'API_ORIGIN',
    'BUILD',
  ]);
  const apiOrigin = env.API_ORIGIN ?? `http://localhost:${env.PORT ?? 3001}`;
  return {
    plugins: [react(), contentSecurityPolicy(apiOrigin)],
    // Relative, because a portal serves the build at a path of its own -- itch
    // under `/html/<id>/` -- where an absolute `/assets` would miss it.
    base: './',
    // An asset like any image, so a test can import a figure to read it.
    assetsInclude: ['**/*.glb'],
    define: {
      __API_ORIGIN__: JSON.stringify(apiOrigin),
      // A release's build number, which the server reports too; 0 elsewhere.
      __BUILD__: JSON.stringify(Number(env.BUILD ?? 0)),
    },
    test: {
      environment: 'happy-dom',
      // Unmounts what each test rendered. See the file for why this is not
      // automatic here.
      setupFiles: ['./src/test-setup.ts'],
    },
  };
});

/**
 * The page's CSP, written into the built `index.html` -- a meta tag, because
 * the itch copy is served by itch and can carry nothing else, and one policy for
 * both copies. ⚠️ **Enforced, and only in a build**: a meta tag cannot report
 * only, and the dev server's hot reload needs inline script. So a new kind of
 * source works in development and is refused in a build until it is listed
 * here. `frame-ancestors` is the server's header, since a meta tag cannot set
 * it.
 */
function contentSecurityPolicy(apiOrigin: string): Plugin {
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    // The textures inside a model reach the GPU through a blob: image.
    "img-src 'self' data: blob:",
    `connect-src 'self' ${apiOrigin}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  return {
    name: 'content-security-policy',
    apply: 'build',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: policy },
        injectTo: 'head-prepend',
      },
    ],
  };
}
