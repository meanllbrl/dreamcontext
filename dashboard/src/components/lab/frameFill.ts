import { createContext } from 'react';

/**
 * True where a Lab card is drawn into a box the HOST sizes (a whiteboard widget), not into a Lab
 * grid cell. An app/v1 or html/v1 insight body is a 320px preview in a Lab cell; inside a box
 * like that, the preview stopped at 320px and left the rest of the card empty (owner,
 * 2026-10-07: "insight sığmıyor karta, dar alanda takılı kalıyor"). Under this flag the frame
 * fills its block instead and scrolls its own document when the content is taller.
 */
export const LabFrameFill = createContext(false);
