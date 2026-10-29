import { useT } from '../i18n';
import { exitDemo } from './mode';

/** Always on screen in demo mode, so nobody mistakes the sample for their paper. */
export function DemoBanner() {
  const t = useT().demo;
  const leave = () => {
    exitDemo();
    location.assign(location.pathname);
  };
  return (
    <div class="demo-banner" role="status">
      <span>{t.banner}</span>
      <button type="button" onClick={leave}>{t.exit}</button>
    </div>
  );
}
