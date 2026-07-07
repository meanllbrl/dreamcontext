import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Local embedding model wrapper — pure Node, offline after first download,
 * zero daemons. Loads @huggingface/transformers (ONNX/WASM) via dynamic
 * import(): it is an optionalDependency (native onnxruntime binaries, same
 * treatment as node-pty), so recall degrades gracefully to BM25-only when it
 * is not installed.
 *
 * Model: multilingual-e5-small — 384-dim, ~113 MB quantized (q8), best
 * TR/EN quality-per-MB (spike-validated 2026-07-07: no token_type_ids error,
 * ~1s cached cold-start, ~22 ms warm single embed, ~3 ms/doc batched).
 *
 * E5 contract: queries are prefixed `query: `, documents `passage: ` — the
 * model was trained with these markers and retrieval quality drops without them.
 */
export const EMBED_MODEL = process.env.DREAMCONTEXT_EMBED_MODEL ?? 'Xenova/multilingual-e5-small';
export const EMBED_DIMS = 384;

/** Batch size for passage embedding — spike showed ~3 ms/doc at 16. */
const BATCH_SIZE = 16;

type Extractor = (
  texts: string | string[],
  opts: { pooling: 'mean'; normalize: boolean },
) => Promise<{ data: Float32Array; dims: number[] }>;

let extractorPromise: Promise<Extractor | null> | null = null;

/**
 * Lazily load the feature-extraction pipeline. Returns null (never throws)
 * when @huggingface/transformers is unavailable — callers fall back to BM25.
 * The model cache lives under ~/.dreamcontext/models so it survives npm
 * reinstalls (the library default is node_modules/.cache, wiped on install).
 */
async function getExtractor(): Promise<Extractor | null> {
  if (extractorPromise === null) {
    extractorPromise = (async () => {
      try {
        const tf = await import('@huggingface/transformers');
        tf.env.cacheDir = join(homedir(), '.dreamcontext', 'models');
        const pipe = await tf.pipeline('feature-extraction', EMBED_MODEL, { dtype: 'q8' });
        return pipe as unknown as Extractor;
      } catch (err) {
        if (process.env.DREAMCONTEXT_DEBUG) {
          console.error(`[embed] model load failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return null;
      }
    })();
  }
  return extractorPromise;
}

/** True when the embedding model can be loaded on this machine. */
export async function embeddingsAvailable(): Promise<boolean> {
  return (await getExtractor()) !== null;
}

/**
 * Embed document passages (batched, `passage: ` prefix). Returns one
 * L2-normalized 384-dim vector per input, or null when the model is
 * unavailable. Output order matches input order.
 */
export async function embedPassages(texts: string[]): Promise<Float32Array[] | null> {
  const extractor = await getExtractor();
  if (extractor === null) return null;
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE).map((t) => `passage: ${t}`);
    const res = await extractor(batch, { pooling: 'mean', normalize: true });
    const dims = res.dims[res.dims.length - 1];
    for (let j = 0; j < batch.length; j++) {
      out.push(res.data.slice(j * dims, (j + 1) * dims));
    }
  }
  return out;
}

/** Embed a search query (`query: ` prefix). Null when the model is unavailable. */
export async function embedQuery(text: string): Promise<Float32Array | null> {
  const extractor = await getExtractor();
  if (extractor === null) return null;
  const res = await extractor(`query: ${text}`, { pooling: 'mean', normalize: true });
  return res.data.slice(0, res.dims[res.dims.length - 1]);
}
