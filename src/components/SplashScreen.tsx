import { useEffect, useState } from 'react';
import { getAppIcon, getSplashLoader } from '../services/appIcon';

interface SplashScreenProps {
  /** True while the app + vault are still booting; flips false when ready. */
  isLoading: boolean;
  /** Called after the fade-out completes so the parent can unmount this. */
  onFinish: () => void;
  /** Custom app icon id from the rainbow logo registry (falls back to default). */
  logo?: string;
}

/**
 * Startup splash overlay. Mounts on launch, shows the animated Prism logo
 * (an mp4 loader color-matched to the chosen logo), the product title, then
 * fades itself out and calls `onFinish` once `isLoading` goes false. The
 * parent unmounts it after the fade completes.
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

  const loaderVideo = getSplashLoader(logo);

  return (
    <div
      className={`fixed inset-0 z-[100] flex flex-col items-center justify-center bg-black rounded-none transition-opacity duration-[400ms] ease-out ${
        fade ? 'opacity-0 pointer-events-none' : 'opacity-100'
      }`}
    >
      <div className="splash-in flex flex-col items-center gap-7 px-8 rounded-none">
        {loaderVideo ? (
          <video
            src={loaderVideo}
            autoPlay
            loop
            muted
            playsInline
            aria-label="Prism Logo"
            className="splash-logo w-80 h-80 rounded-none object-contain"
          />
        ) : (
          <img
            src={getAppIcon(logo)}
            alt="Prism Logo"
            className="splash-logo w-80 h-80 rounded-none object-contain"
          />
        )}
        <div className="flex flex-col items-center gap-2 text-center rounded-none">
          <h1 className="text-8xl font-serif italic tracking-wide text-offwhite">
            Prism
          </h1>
        </div>
      </div>
    </div>
  );
}
