import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
  base: '/chess/',
  plugins: [
    basicSsl()
  ],
  server: {
    https: true,
    host: true // Expose to network if needed
  },
  build: {
    target: 'esnext',
    minify: false,
    rollupOptions: {
      external: ['@mediapipe/tasks-vision', '@sparkjsdev/spark', 'three'],
      output: {
        paths: {
          '@mediapipe/tasks-vision': 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/vision_bundle.mjs',
          '@sparkjsdev/spark': 'https://cdn.jsdelivr.net/npm/@sparkjsdev/spark@0.1.10/dist/spark.module.js',
          'three': './three-polyfill.js'
        }
      }
    }
  },
});
