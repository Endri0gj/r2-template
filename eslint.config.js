// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: [
      'dist/*',
      // `server/` is a separate package with its own runtime. Its code imports
      // Workers-only module specifiers (`cloudflare:test`, `cloudflare:workers`)
      // that this React Native config cannot resolve, and it is typechecked by
      // its own tsconfig via `npm run server:typecheck`.
      'server/**',
    ],
  },
]);
