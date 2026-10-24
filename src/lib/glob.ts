import fastGlob from 'fast-glob';
import { resolve } from 'node:path';

/**
 * fast-glob, with ABSOLUTE results in the platform's own spelling.
 *
 * fast-glob always answers with forward slashes; on Windows an absolute result is
 * `D:/a/vault/knowledge/x.md` while every other path the code compares it with (`join`,
 * `realpath`, a vault root from the registry) is `D:\a\vault\knowledge\x.md`. The two never
 * matched: vault discovery, recall's document paths and every startsWith containment check
 * disagreed on Windows. Absolute results are resolved there; relative results stay POSIX (they
 * are keys), and nothing changes on any other platform.
 */
type Options = fastGlob.Options;

function native(paths: string[], options?: Options): string[] {
  return process.platform === 'win32' && options?.absolute ? paths.map((p) => resolve(p)) : paths;
}

function fg(source: string | string[], options?: Options): Promise<string[]> {
  return fastGlob(source, options).then((paths) => native(paths as string[], options));
}
fg.sync = (source: string | string[], options?: Options): string[] => native(fastGlob.sync(source, options) as string[], options);

export default fg;
