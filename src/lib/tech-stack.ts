import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Best-effort tech-stack detection from well-known manifest files in `dir`.
 * Shared by `dreamcontext init` (interactive prefill) and the launcher's quiz
 * onboarding (prefilling the stack for an existing folder). Returns a
 * human-readable comma-joined string, or null when nothing recognizable is found.
 *
 * Defaults to `process.cwd()` so existing call sites stay unchanged.
 */
export function detectTechStack(dir: string = process.cwd()): string | null {
  // package.json -> Node/JS ecosystem
  const pkgPath = join(dir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const stack: string[] = ['Node.js'];

      if (deps['react'] || deps['react-dom']) stack.push('React');
      if (deps['next']) stack.push('Next.js');
      if (deps['vue']) stack.push('Vue');
      if (deps['nuxt']) stack.push('Nuxt');
      if (deps['svelte']) stack.push('Svelte');
      if (deps['express']) stack.push('Express');
      if (deps['fastify']) stack.push('Fastify');
      if (deps['typescript']) stack.push('TypeScript');
      if (deps['tailwindcss']) stack.push('Tailwind CSS');
      if (deps['prisma'] || deps['@prisma/client']) stack.push('Prisma');

      return stack.join(', ');
    } catch {
      return 'Node.js';
    }
  }

  // pubspec.yaml -> Flutter/Dart
  if (existsSync(join(dir, 'pubspec.yaml'))) return 'Flutter, Dart';

  // Cargo.toml -> Rust
  if (existsSync(join(dir, 'Cargo.toml'))) return 'Rust';

  // go.mod -> Go
  if (existsSync(join(dir, 'go.mod'))) return 'Go';

  // requirements.txt or pyproject.toml -> Python
  if (existsSync(join(dir, 'requirements.txt')) || existsSync(join(dir, 'pyproject.toml'))) {
    return 'Python';
  }

  return null;
}
