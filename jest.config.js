module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // The suite mixes CPU-heavy work (RSA-3072 keygen, PBKDF2@310k) with real
  // HTTP-server tests. At jest's default ~(cores-1) workers the full 106-suite
  // run pegs every core for minutes, which intermittently starved individual
  // server/crypto suites into timeouts or 500s (green in isolation). Bounding
  // workers keeps the machine from saturating; the higher default timeout
  // absorbs the remaining crypto slowness under load. Override per-run with
  // `jest --maxWorkers=N` when desired.
  maxWorkers: '50%',
  testTimeout: 15000,
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  testPathIgnorePatterns: ['<rootDir>/src/__tests__/browser/', '<rootDir>/src/__tests__/_helpers/'],
  // Timestamp-tie stress mode: set MINDOODB_TEST_CLOCK_QUANTUM_MS (e.g. 50) to
  // quantize all semantic timestamps so same-instant collisions become the
  // norm instead of a rare race. See _helpers/setupSemanticClock.ts.
  setupFiles: ['<rootDir>/src/__tests__/_helpers/setupSemanticClock.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
  // Handle .js extensions in imports (for ESM/Node16 resolution)
  // and map mindoodb/* package imports to local source for example server tests
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^mindoodb/(.*)$': '<rootDir>/src/$1',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/index.ts',
  ],
};

