import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    // The protocol package ships TypeScript source with extensionless imports;
    // Node cannot load that from node_modules, so Vite transforms it.
    server: { deps: { inline: ['@voyager-crew/bridge-protocol'] } },
  },
});
