import { useEffect, useRef, useState } from 'react';
import { getAppIcon, getSplashLoader } from '../services/appIcon';
import whiteLogo from '../assets/logos/White.svg';

interface SplashScreenProps {
  /** True while the app + vault are still booting; flips false when ready. */
  isLoading: boolean;
  /** Flips true once boot + first-run backfill are done, to start the video. */
  playVideo: boolean;
  /** Called after the fade-out completes so the parent can unmount this. */
  onFinish: () => void;
  /** Custom app icon id from the rainbow logo registry (falls back to default). */
  logo?: string;
}

/**
 * Startup splash overlay. Shows the static white logo while the app boots and
 * the first-run semantic backfill runs, then (once `playVideo` is true and the
 * mp4 is buffered) swaps in the color-matched animated loader and plays it
 * before fading out and calling `onFinish`.
 */
export function SplashScreen({ isLoading, playVideo, onFinish, logo }: SplashScreenProps) {
  const [fade, setFade] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!isLoading) {
      setFade(true);
      const timer = setTimeout(onFinish, 400);
      return () => clearTimeout(timer);
    }
  }, [isLoading, onFinish]);

  const loaderVideo = getSplashLoader(logo);

  // Detect when the mp4 is buffered enough to play.
  //
  // On macOS (WKWebView) the browser blocks video.load() and
  // preload="auto" unless the element has the autoplay attribute.
  // Adding autoplay lets WKWebView begin fetching and decoding the
  // mp4 immediately; the video is still hidden (opacity-0) until
  // showVideo flips true, so there's no visible side-effect.
  useEffect(() => {
    if (!loaderVideo) return;
    const video = videoRef.current;
    if (!video) return;

    const markReady = () => setVideoReady(true);
    if (video.readyState >= 2) {
      markReady();
      return;
    }

    video.addEventListener('loadeddata', markReady);
    video.addEventListener('canplaythrough', markReady);
    video.addEventListener('error', markReady);

    // Fallback: if the video never loads, mark it ready anyway so
    // the splash isn't stuck forever.
    const fallback = setTimeout(markReady, 3000);

    return () => {
      clearTimeout(fallback);
      video.removeEventListener('loadeddata', markReady);
      video.removeEventListener('canplaythrough', markReady);
      video.removeEventListener('error', markReady);
    };
  }, [loaderVideo]);

  // Once boot + backfill are done AND the video is ready, reveal the
  // animation from frame 0.  On macOS the video may already be playing
  // (autoplay), so we just reset currentTime; on other platforms we
  // kick off play() explicitly.
  useEffect(() => {
    if (!playVideo || !videoReady) return;
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = 0;
    if (video.paused) video.play().catch(() => {});
  }, [playVideo, videoReady]);

  const showVideo = videoReady && playVideo;

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
              ref={videoRef}
              src={loaderVideo}
              muted
              loop
              playsInline
              autoPlay
              preload="auto"
              aria-label="Prism Logo"
              className={`absolute inset-0 w-full h-full object-contain transition-opacity duration-300 ${
                showVideo ? 'opacity-100' : 'opacity-0'
              }`}
              onLoadedData={() => setVideoReady(true)}
              onCanPlayThrough={() => setVideoReady(true)}
            />
          )}
          <img
            src={loaderVideo ? whiteLogo : getAppIcon(logo)}
            alt="Prism Logo"
            className={`absolute inset-0 w-full h-full object-contain transition-opacity duration-300 ${
              loaderVideo && showVideo ? 'opacity-0' : 'opacity-100'
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
