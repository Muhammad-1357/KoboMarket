import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["<rootDir>/tests/**/*.test.ts"],
  setupFilesAfterEnv: ["<rootDir>/tests/setup.ts"],
  testTimeout: 60000,
  clearMocks: true
};

export default config;
