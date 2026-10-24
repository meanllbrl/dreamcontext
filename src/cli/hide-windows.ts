// MUST be the first import of src/cli/index.ts. Module bodies elsewhere run at import time
// (e.g. `promisify(execFile)` captures its custom symbol), so the child_process patch has to land
// before any of them loads. A no-op off Windows. See src/lib/proc.ts for the why.
import { installHiddenWindowDefaults } from '../lib/proc.js';

installHiddenWindowDefaults();
