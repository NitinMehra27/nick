'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'nick.voiceReplies';

/**
 * Picks an installed, on-device voice. Voices with localService=false (for example Edge's
 * "Online (Natural)" voices) send the text to a cloud service, so they are never used.
 */
function localVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices().filter((v) => v.localService);
  const lang = navigator.language.toLowerCase();
  return (
    voices.find((v) => v.lang.toLowerCase() === lang) ??
    voices.find((v) => v.lang.toLowerCase().startsWith('en')) ??
    voices[0] ??
    null
  );
}

/**
 * Optional spoken replies using the browser's built-in speech synthesis with an on-device
 * voice only. Off by default; the choice is remembered in this browser.
 */
export function useVoiceReplies() {
  const [supported, setSupported] = useState(false);
  const [hasLocalVoice, setHasLocalVoice] = useState(false);
  const [enabled, setEnabledState] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const current = useRef<SpeechSynthesisUtterance | null>(null);

  useEffect(() => {
    if (!('speechSynthesis' in window)) return;
    setSupported(true);
    const refresh = () => setHasLocalVoice(!!localVoice());
    refresh();
    window.speechSynthesis.addEventListener('voiceschanged', refresh);
    try {
      setEnabledState(window.localStorage.getItem(STORAGE_KEY) === 'on');
    } catch {
      // storage unavailable: stay off
    }
    return () => {
      window.speechSynthesis.removeEventListener('voiceschanged', refresh);
      window.speechSynthesis.cancel();
    };
  }, []);

  const stop = useCallback(() => {
    if (!('speechSynthesis' in window)) return;
    current.current = null;
    window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  const setEnabled = useCallback(
    (on: boolean) => {
      setEnabledState(on);
      if (!on) stop();
      try {
        window.localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
      } catch {
        // not persisted; still applies to this page
      }
    },
    [stop],
  );

  const speak = useCallback(
    (text: string) => {
      if (!enabled || !supported) return;
      const voice = localVoice();
      if (!voice) return;
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text.replace(/[#*`_>]/g, ' ').slice(0, 1200));
      u.voice = voice;
      u.lang = voice.lang;
      u.onstart = () => setSpeaking(true);
      u.onend = u.onerror = () => {
        if (current.current === u) setSpeaking(false);
      };
      current.current = u;
      window.speechSynthesis.speak(u);
    },
    [enabled, supported],
  );

  return { supported, hasLocalVoice, enabled, setEnabled, speaking, speak, stop };
}
