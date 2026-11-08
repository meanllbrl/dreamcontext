/**
 * The Codex a dreamcontext install fetches: one exact version from the official npm registry, and
 * the sha512 npm published for it. To move it: read the new hashes with
 * `npm view @openai/codex@<v>[-<platform>] dist.integrity` and run a real Codex turn on it.
 */
export const CODEX_PIN = {
  version: '0.164.0',
  registry: 'https://registry.npmjs.org/',
  package: '@openai/codex',
  integrity: 'sha512-TWj7UGyPRe3Pj/A3ddNAxs1te3a/W/xAd+J0LHrrFTmsSfahGMOLF/vn88D3QCIgAT3B1rm1y/Z3NYE0rx6cZQ==',
  platforms: {
    'darwin-arm64': { triple: 'aarch64-apple-darwin', integrity: 'sha512-pDizgOUAtq3/k3AbUFHbaU19WpYKCja+oFpNSTLKrDQj4lTUNSDuTPJip4uQVn2/1EipQdpQrGMOQBVuI1znAA==' },
    'darwin-x64': { triple: 'x86_64-apple-darwin', integrity: 'sha512-lIe+udnguPGzBezkgbkj2Eaz0YqOhNXT7jja136Fj0sXfI+UKNS2icmaK14GcoRAgeVEpDTtC1ftamWBPmD1zg==' },
    'linux-x64': { triple: 'x86_64-unknown-linux-musl', integrity: 'sha512-XLAoaWsGOT2khzl+P4FYDPTkzAr9W0VFXFaVkqlFdkM0soa1gH/4S0wSD57Ek3HHwkirAEGz2/Mwehseh+l5Mg==' },
    'linux-arm64': { triple: 'aarch64-unknown-linux-musl', integrity: 'sha512-LL5iTQjyDL4YRX44EWqhIfEQ5uGnmgxkQBJSxjZSeJ8L1Og83pdlzUJW/PRJ76oaVwOVgh6HXwuPEiBNEHU4lg==' },
  },
} as const;

export type CodexPlatform = keyof typeof CODEX_PIN.platforms;
