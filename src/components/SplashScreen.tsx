import { useEffect, useState } from 'react';
import { getAppIcon } from '../services/appIcon';

interface SplashScreenProps {
  /** True while the app + vault are still booting; flips false when ready. */
  isLoading: boolean;
  /** Called after the fade-out completes so the parent can unmount this. */
  onFinish: () => void;
  /** Custom app icon id from the rainbow logo registry (falls back to default). */
  logo?: string;
}

/**
 * Startup splash overlay. Mounts on launch, shows the Prism logo, product
 * title and an `ldrs` loader, then fades itself out and calls `onFinish` once
 * `isLoading` goes false. The parent unmounts it after the fade completes.
 */
export function SplashScreen({ isLoading, onFinish, logo }: SplashScreenProps) {
  const [fade, setFade] = useState(false);

  useEffect(() => {
    if (!isLoading) {
      setFade(true);
      const timer = setTimeout(onFinish, 400);
      return () => clearTimeout(timer);
    }
  }, [isLoading, onFinish]);

  return (
    <div
      className={`fixed inset-0 z-[100] flex flex-col items-center justify-center bg-base rounded-none transition-opacity duration-[400ms] ease-out ${
        fade ? 'opacity-0 pointer-events-none' : 'opacity-100'
      }`}
    >
      <div className="splash-in flex flex-col items-center gap-7 px-8 rounded-none">
        <img
          src={getAppIcon(logo)}
          alt="Prism Logo"
          className="splash-logo w-56 h-56 rounded-none object-contain"
        />
        <div className="flex flex-col items-center gap-2 text-center rounded-none">
          <h1 className="text-6xl font-serif italic tracking-wide text-offwhite">
            Prism
          </h1>
        </div>
        <div className="mt-4 rounded-none">
          <l-quantum size="42" speed="1.75" color="#FEB05D" />
        </div>
      </div>
    </div>
  );
}
