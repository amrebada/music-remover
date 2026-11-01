import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifest: {
    // Translations live in public/_locales; the store lists each language's name and description.
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    default_locale: 'en',
    permissions: ['tabCapture', 'offscreen', 'storage', 'activeTab'],
    // Model weights are downloaded once from Hugging Face and cached.
    host_permissions: ['https://huggingface.co/*', 'https://*.hf.co/*'],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    commands: {
      'toggle-live': {
        suggested_key: { default: 'Alt+Shift+M' },
        description: '__MSG_commandToggleLive__',
      },
    },
  },
  vite: () => ({
    worker: { format: 'es' },
  }),
});
