import { LookaheadController } from '@/src/lookahead/controller';
import { SITE_MATCHES } from '@/src/shared/sites';

export default defineContentScript({
  matches: SITE_MATCHES,
  // Must be listening before the MAIN-world tap forwards the first segments.
  runAt: 'document_start',
  allFrames: true,
  main() {
    void new LookaheadController().start();
  },
});
