import { useEffect, useState } from 'react';
import { getAppIcon, getSplashLoader } from '../services/appIcon';
import whiteLogo from '../assets/logos/White.svg';

interface SplashScreenProps {
  /** True while the app + vault are still booting; flips false when ready. */
  isLoading: boolean;
  /** Flips true once boot + first-run backfill are done, to start the animation. */
  playVideo: boolean;
  /** Called after the fade-out completes so the parent can unmount this. */
  onFinish: () => void;
  /** Custom app icon id from the rainbow logo registry (falls back to default). */
  logo?: string;
}

/**
 * Startup splash overlay. Shows the static white logo while the app boots and
 * the first-run semantic backfill runs, then swaps in the color-matched
 * animated WebP loader (auto-plays natively in all WebViews) before fading
 * out and calling `onFinish`.
 */
export function SplashScreen({ isLoading, playVideo, onFinish, logo }: SplashScreenProps) {
  const [fade, setFade] = useState(false);

  useEffect(() => {
    if (!isLoading) {
      setFade(true);
      const timer = setTimeout(onFinish, 400);
      return () => clearTimeout(timer);
    }
  }, [isLoading, onFinish]);

  const loaderAnimation = getSplashLoader(logo);
  const showAnimation = loaderAnimation && playVideo;

  return (
    <div
      className={`fixed inset-0 z-[100] flex flex-col items-center justify-center bg-black rounded-none transition-opacity duration-[400ms] ease-out ${
        fade ? 'opacity-0 pointer-events-none' : 'opacity-100'
      }`}
    >
      <div className="splash-in flex flex-col items-center gap-7 px-8 rounded-none">
        <div className="relative w-80 h-80 splash-logo rounded-none">
          {loaderAnimation && (
            <img
              src={loaderAnimation}
              alt="Prism Logo"
              className={`absolute inset-0 w-full h-full object-contain transition-opacity duration-300 ${
                showAnimation ? 'opacity-100' : 'opacity-0'
              }`}
            />
          )}
          <img
            src={loaderAnimation ? whiteLogo : getAppIcon(logo)}
            alt="Prism Logo"
            className={`absolute inset-0 w-full h-full object-contain transition-opacity duration-300 ${
              loaderAnimation && showAnimation ? 'opacity-0' : 'opacity-100'
            }`}
          />
        </div>
        <div className="flex flex-col items-center gap-2 text-center rounded-none">
          <h1 className="text-8xl font-serif italic tracking-wide text-offwhite">
            Prism
          </h1>
        </div>
      </div>
    </div>
  );
}
