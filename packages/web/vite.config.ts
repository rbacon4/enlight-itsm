import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import license from 'rollup-plugin-license';
import path from 'node:path';

export default defineConfig({
  plugins: [
    react(),
    // Emit a third-party license/notice file covering every dependency bundled
    // into the shipped frontend (e.g. lucide-react) — satisfies the MIT/ISC
    // attribution requirement. Generated on `vite build` into dist/.
    license({
      thirdParty: {
        includePrivate: false,
        output: {
          file: path.resolve(__dirname, 'dist', 'THIRD-PARTY-LICENSES.txt'),
        },
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
