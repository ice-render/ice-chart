module.exports = {
  testEnvironment: 'jsdom',
  testMatch: ['**/tests/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.(ts|js)$': 'babel-jest',
  },
  setupFiles: ['<rootDir>/tests/setup/canvas-env.ts'],
  collectCoverageFrom: ['src/**/*.ts'],
  coverageReporters: ['text-summary', 'lcov'],
};
