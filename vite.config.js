import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
  plugins: [
    basicSsl()
  ],
  server: {
    https: true,
    host: true // Expose to network if needed
  },
  optimizeDeps: {
    exclude: ['@sparkjsdev/spark']
  },
  assetsInclude: ['**/*.wasm']
});
