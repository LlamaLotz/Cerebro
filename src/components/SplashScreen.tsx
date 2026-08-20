import { useEffect, useState } from 'react';

interface SplashScreenProps {
  /** True while the app + vault are still booting; flips false when ready. */
  isLoading: boolean;
  /** Called after the fade-out completes so the parent can unmount this. */
  onFinish: () => void;
}

/**
 * Startup splash overlay. Mounts on launch, shows the Prism logo, product
 * title and an `ldrs` loader, then fades itself out and calls `onFinish` once
 * `isLoading` goes false. The parent unmounts it after the fade completes.
 */
export function SplashScreen({ isLoading, onFinish }: SplashScreenProps) {
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
          src="/logo.png"
          alt="Prism Logo"
          className="splash-logo w-24 h-24 rounded-none"
        />
        <div className="flex flex-col items-center gap-2 text-center rounded-none">
          <h1 className="text-2xl font-display font-semibold tracking-[0.35em] text-offwhite">
            PRISM
          </h1>
        </div>
        <div className="mt-4 rounded-none">
          <l-quantum size="42" speed="1.75" color="#FEB05D" />
        </div>
      </div>
    </div>
  );
}
