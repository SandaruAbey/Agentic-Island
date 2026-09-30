import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

// Strict CSP for the packaged app. Skipped in dev because the React refresh preamble is an inline script.
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

const cspPlugin = (): Plugin => ({
  name: 'island-csp',
  transformIndexHtml: {
    order: 'post',
    handler: (html, ctx) =>
      ctx.server ? html : html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`)
  }
})

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: { alias: { '@shared': resolve('src/shared') } },
    plugins: [react(), cspPlugin()],
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } }
  }
})
