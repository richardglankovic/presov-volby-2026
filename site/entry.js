import { refreshForLatest, showStartupFailure } from './recovery.js';

const release = __APP_RELEASE__;
const baseUrl = new URL('./', document.baseURI).href;
// This tiny loader is embedded in the HTML. Even if an old cached HTML page
// points at an app bundle removed by a newer deployment, it can recover.
import(new URL(__APP_ENTRY__, baseUrl).href).catch(async error => {
  console.error('Application bundle:', error);
  if (await refreshForLatest(release, baseUrl, location)) return;
  showStartupFailure('Stránku sa nepodarilo načítať. Skontrolujte pripojenie a skúste znova.', baseUrl);
});
