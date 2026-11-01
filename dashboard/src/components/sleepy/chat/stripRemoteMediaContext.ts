import { createContext } from 'react';

/** An app's conversation draws no remote media: model text is input, and a remote image is a GET
 *  that carries whatever the text put in its URL, with no card (plan r9, D6). */
export const StripRemoteMedia = createContext(false);
