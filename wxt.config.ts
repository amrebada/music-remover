import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifest: {
    name: 'Music Remover',
    description: 'Removes background music from videos and keeps the voices. Runs fully on your device.',
    permissions: ['tabCapture', 'offscreen', 'storage', 'activeTab'],
    // Model weights are downloaded once from Hugging Face and cached.
    host_permissions: ['https://huggingface.co/*', 'https://*.hf.co/*'],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    commands: {
      'toggle-live': {
        suggested_key: { default: 'Alt+Shift+M' },
        description: 'Start or stop live music removal on this tab',
      },
    },
  },
  vite: () => ({
    worker: { format: 'es' },
  }),
});
