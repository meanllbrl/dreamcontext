/**
 * File names that mark a local secret or config file (`.env`, `credentials*`, `*.pem`, `*.key`,
 * `id_rsa`, …). Shared by the brain scrub's one-click "add to .gitignore" (`routes/brain.ts`, which
 * re-exports it; the dashboard mirrors it in `BrainSyncControl.tsx`) and the Telegram outbound
 * classifier (`src/lib/telegram/files.ts`), which never sends a file of this class.
 */
export const SAFE_TO_GITIGNORE = /(^|\/)([^/]*\.env(\.[^/]+)?|[^/]*\.local\.[^/]+|[^/]*secrets?[^/]*\.(json|ya?ml|toml|env)|credentials?[^/]*\.(json|ya?ml|toml|env)|[^/]*\.(pem|key|p12|pfx|keystore|jks)|id_rsa[^/]*|id_ed25519[^/]*)$/i;
