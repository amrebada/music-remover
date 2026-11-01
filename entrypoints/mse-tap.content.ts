import { installTap } from '@/src/lookahead/tap';
import { SITE_MATCHES } from '@/src/shared/sites';

export default defineContentScript({
  matches: SITE_MATCHES,
  world: 'MAIN',
  runAt: 'document_start',
  allFrames: true,
  main() {
    installTap();
  },
});
