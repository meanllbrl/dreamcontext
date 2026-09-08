/** The shipped push-to-talk chord, mirroring `DEFAULT_PUSH_TO_TALK` in
 *  `src/lib/voice/config.ts`. Its own module so both the prefs cache and the Settings card
 *  can read it without importing each other. */
export const DEFAULT_PUSH_TO_TALK = 'Alt+Space';
