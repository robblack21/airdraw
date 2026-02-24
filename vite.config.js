import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
  base: '/',
  plugins: [
    basicSsl()
  ],
  server: {
    https: true,
    host: true
  },
  build: {
    target: 'esnext',
    minify: false,
    rollupOptions: {
      external: (id) => id === '@mediapipe/tasks-vision' || id === 'three' || id.startsWith('three/'),
      output: {
        paths: {
          '@mediapipe/tasks-vision': 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/vision_bundle.mjs',
          'three': '/three-polyfill.js',
          'three/addons/loaders/RGBELoader.js': 'https://unpkg.com/three@0.178.0/examples/jsm/loaders/RGBELoader.js'
        }
      }
    }
  },
});
