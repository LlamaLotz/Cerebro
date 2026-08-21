import { useEffect, useState } from 'react';
import { getAppIcon, getSplashLoader } from '../services/appIcon';
import whiteLogo from '../assets/logos/White.svg';

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
  // Static (white no-rainbow) logo shows first; the animated loader swaps in
  // only once the video has actually loaded and is ready to play, so the
  // splash never stutters or flashes blank while the mp4 decodes.
  const [videoReady, setVideoReady] = useState(false);

  useEffect(() => {
    if (!isLoading) {
      setFade(true);
      const timer = setTimeout(onFinish, 400);
      return () => clearTimeout(timer);
    }
  }, [isLoading, onFinish]);

  const loaderVideo = getSplashLoader(logo);
  const handleVideoReady = () => setVideoReady(true);

  return (
    <div
      className={`fixed inset-0 z-[100] flex flex-col items-center justify-center bg-black rounded-none transition-opacity duration-[400ms] ease-out ${
        fade ? 'opacity-0 pointer-events-none' : 'opacity-100'
      }`}
    >
      <div className="splash-in flex flex-col items-center gap-7 px-8 rounded-none">
        <div className="relative w-80 h-80 splash-logo rounded-none">
          {loaderVideo && (
            <video
              src={loaderVideo}
              autoPlay
              loop
              muted
              playsInline
              preload="auto"
              onLoadedData={handleVideoReady}
              onCanPlayThrough={handleVideoReady}
              aria-label="Prism Logo"
              className={`absolute inset-0 w-full h-full object-contain transition-opacity duration-300 ${
                videoReady ? 'opacity-100' : 'opacity-0'
              }`}
            />
          )}
          <img
            src={loaderVideo ? whiteLogo : getAppIcon(logo)}
            alt="Prism Logo"
            className={`absolute inset-0 w-full h-full object-contain transition-opacity duration-300 ${
              loaderVideo && videoReady ? 'opacity-0' : 'opacity-100'
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
