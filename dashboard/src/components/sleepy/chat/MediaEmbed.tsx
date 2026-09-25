import type { CSSProperties, SyntheticEvent } from 'react';

/**
 * THE inline player. Every clip or audio file the app plays in place goes through this
 * one element: a user's attachment in the transcript, a file opened in the SlideOver, a
 * post in the Agents channel. Three surfaces used to write their own `<video>`/`<audio>`,
 * so a fix (preload, playsInline, the ratio callback, an audio file drawn in a video box)
 * landed in one and not the others. Now it lands here.
 *
 * What is shared and what is not: the element, its attributes and the ratio measurement
 * are this atom's; the box around it (a figure with a reserved aspect, the SlideOver's
 * fill, the transcript's thumbnail cap) stays with the surface, through `className`.
 */
export type MediaEmbedKind = 'video' | 'audio';

export interface MediaEmbedProps {
  src: string;
  kind: MediaEmbedKind;
  className?: string;
  style?: CSSProperties;
  /** The file could not be fetched or decoded (a refused path, a missing file). */
  onError?: () => void;
  /** A clip's own width / height, once its metadata is in. Audio never reports one. */
  onRatio?: (ratio: number) => void;
}

export function MediaEmbed({ src, kind, className, style, onError, onRatio }: MediaEmbedProps) {
  if (kind === 'audio') {
    return (
      <audio
        className={className}
        style={style}
        src={src}
        controls
        preload="metadata"
        onError={onError}
      />
    );
  }
  const measure = (e: SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget;
    if (onRatio && v.videoWidth > 0 && v.videoHeight > 0) onRatio(v.videoWidth / v.videoHeight);
  };
  return (
    <video
      className={className}
      style={style}
      src={src}
      controls
      preload="metadata"
      playsInline
      onLoadedMetadata={measure}
      onError={onError}
    />
  );
}
