import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../context/VaultContext';
import { useI18n } from '../../../context/I18nContext';
import { SANDBOX_ALLOW, SANDBOX_GRANT } from '../../../lib/sandboxHtml';
import { resolveChatKitTokens } from '../../sleepy/chat/chatHtmlKit';
import { mintAppNonce } from '../labAppRuntime';
import type { Frame, LibraryBlock } from '../board/boardTypes';
import { stringOption, type BlockViewProps } from './blockCommon';
import { buildHtmlBlockSrcdoc, createHtmlBlockHost, declaredInputNames, htmlBlockHash } from './htmlBlockBridge';

/**
 * `html`: the author's own markup in the network-less sandbox, with the full
 * `dc-` kit, fed ONLY the inputs it declares (plan D4; the rules live in
 * htmlBlockBridge.ts). `html` inline, or `ref` to a vault library entry
 * (`lab/blocks/<slug>.md`), which wins when both are set, as on the engine.
 *
 * The block fills its grid cell: no height bridge; a tall body scrolls inside
 * its own frame. Mount it under `htmlBlockKey(card id, path, block)`; the inner
 * frame is keyed by hash(html, inputs) as well, so an edit always remounts with
 * a fresh nonce and load counter and `srcDoc` is never swapped in place.
 */
export function HtmlBlock({ block, inputs }: BlockViewProps) {
  const { t, locale } = useI18n();
  const ref = stringOption(block.options, 'ref');
  const library = useLibraryEntry(ref);

  if (ref && library.status === 'loading') return <div className="lab-block-empty">{t('lab.blocks.html.loading')}</div>;
  if (ref && library.status !== 'ready') {
    return <div className="lab-block-empty">{t('lab.blocks.html.missingRef').replace('{ref}', ref)}</div>;
  }
  const html = ref ? library.entry?.html ?? '' : typeof block.options.html === 'string' ? block.options.html : '';
  if (!html.trim()) return <div className="lab-block-empty">{t('lab.blocks.html.empty')}</div>;
  const declared = declaredInputNames(block, library.entry);

  return (
    <HtmlBlockFrame
      key={`${htmlBlockHash(block, html)}:${declared.join(',')}`}
      html={html}
      declared={declared}
      inputs={inputs}
      lang={locale}
      title={library.entry?.title ?? t('lab.blocks.html.title')}
      stoppedText={t('lab.blocks.html.stopped')}
    />
  );
}

/** The library entry a `ref` names, from the same query the board page lists the library with. */
function useLibraryEntry(ref: string | null): { status: 'idle' | 'loading' | 'missing' | 'ready'; entry: LibraryBlock | null } {
  const api = useApi();
  const query = useQuery({
    queryKey: ['lab', 'blocks'],
    queryFn: () => api.get<{ blocks: LibraryBlock[] }>('/lab/blocks').then((r) => r.blocks ?? []),
    enabled: !!ref,
    retry: 0,
  });
  if (!ref) return { status: 'idle', entry: null };
  if (query.isPending && query.fetchStatus !== 'idle') return { status: 'loading', entry: null };
  const entry = query.data?.find((b) => b.slug === ref) ?? null;
  return entry ? { status: 'ready', entry } : { status: 'missing', entry: null };
}

/** The live `<html data-theme>`: the attribute is what restyles the tokens (LabAppFrame's rule). */
function useDataTheme(): 'light' | 'dark' {
  const read = (): 'light' | 'dark' => (document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

function HtmlBlockFrame({ html, declared, inputs, lang, title, stoppedText }: {
  html: string;
  declared: string[];
  inputs: Record<string, Frame> | undefined;
  lang: string;
  title: string;
  stoppedText: string;
}) {
  const theme = useDataTheme();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;
  const declaredRef = useRef(declared);
  declaredRef.current = declared;
  const didMountThemeRef = useRef(false);
  const [torn, setTorn] = useState(false);

  // Pinned for this instance's lifetime: nonce and srcdoc are built ONCE.
  const [instance] = useState(() => {
    const nonce = mintAppNonce();
    const scheme: 'light' | 'dark' = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    return { nonce, srcDoc: buildHtmlBlockSrcdoc({ html, tokens: resolveChatKitTokens(), scheme, nonce, inputs: declared, lang }) };
  });
  const [host] = useState(() => createHtmlBlockHost({
    nonce: instance.nonce,
    getFrameWindow: () => frameRef.current?.contentWindow ?? null,
    getDeclared: () => declaredRef.current,
    getInputs: () => inputsRef.current,
    onStop: (reason) => {
      console.error(`[lab-block] ${reason}`);
      setTorn(true);
    },
  }));

  useEffect(() => {
    const onMessage = (event: MessageEvent) => { host.handleMessage(event); };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [host]);

  // A theme flip goes over the bridge: rebuilding the srcdoc would reset the block's own state.
  useEffect(() => {
    if (!didMountThemeRef.current) { didMountThemeRef.current = true; return; }
    host.pushTheme(theme, resolveChatKitTokens());
  }, [host, theme]);

  if (torn) {
    return (
      <div className="lab-block-empty" role="alert">
        {stoppedText}
        {/* A different element: the navigated document is discarded, not just hidden. */}
        <iframe srcDoc="about:blank" title={title} style={{ display: 'none' }} />
      </div>
    );
  }

  return (
    <iframe
      ref={frameRef}
      className="lab-block-html-frame"
      title={title}
      sandbox={SANDBOX_GRANT}
      allow={SANDBOX_ALLOW}
      srcDoc={instance.srcDoc}
      onLoad={() => host.handleLoad()}
      style={{ colorScheme: theme }}
    />
  );
}
