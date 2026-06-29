/* ===================================================================
 * Browser-native TTS for the Digital Lawyer
 *
 * Uses the Web Speech API (speechSynthesis) — free, no API key needed.
 * Falls back gracefully if the browser doesn't support it.
 * =================================================================== */

const MAX_CHUNK_LENGTH = 200;

/** Clean markdown and formatting artifacts before TTS. */
export function clean_for_tts(text: string): string {
  // Bold/italic
  text = text.replace(/\*\*(.*?)\*\*/g, "$1");
  // Italic
  text = text.replace(/\*(.*?)\*/g, "$1");
  // Headers
  text = text.replace(/^#{1,6}\s+/gm, "");
  // Links — keep text, remove URL
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // Inline code
  text = text.replace(/`([^`]+)`/g, "$1");
  // Remove excessive whitespace
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

/** Split text into sentence-level chunks for TTS. */
function splitSentences(text: string): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  return sentences.filter((s) => s.trim().length > 0);
}

/** Pick the best available voice. */
function pickVoice(): SpeechSynthesisVoice | null {
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return null;

  // Prefer English female voices (usually sound more natural for legal)
  const preferred =
    voices.find((v) => v.lang.startsWith("en") && v.name.toLowerCase().includes("female")) ||
    voices.find((v) => v.lang.startsWith("en-US")) ||
    voices.find((v) => v.lang.startsWith("en")) ||
    voices[0];

  return preferred || null;
}

let cachedVoice: SpeechSynthesisVoice | null = null;

function getVoice(): SpeechSynthesisVoice | null {
  if (cachedVoice) return cachedVoice;
  cachedVoice = pickVoice();
  return cachedVoice;
}

/** Speak text using the browser's built-in TTS. */
export async function speakText(text: string): Promise<void> {
  if (!("speechSynthesis" in window)) {
    throw new Error("TTS not supported in this browser");
  }

  const clean = clean_for_tts(text);
  if (!clean) return;

  // Cancel any ongoing speech
  speechSynthesis.cancel();

  const chunks = splitSentences(clean);
  const voice = getVoice();

  return new Promise((resolve, reject) => {
    let currentChunk = 0;

    function speakNext() {
      if (currentChunk >= chunks.length) {
        resolve();
        return;
      }

      const utterance = new SpeechSynthesisUtterance(chunks[currentChunk]);
      if (voice) utterance.voice = voice;
      utterance.rate = 1.05;
      utterance.pitch = 1.0;

      utterance.onend = () => {
        currentChunk++;
        speakNext();
      };
      utterance.onerror = (e) => {
        if (e.error === "canceled") {
          resolve();
          return;
        }
        reject(new Error(`TTS error: ${e.error}`));
      };

      speechSynthesis.speak(utterance);
    }

    speakNext();
  });
}

/** Check if TTS is available in the current browser. */
export function isTtsAvailable(): boolean {
  return "speechSynthesis" in window && speechSynthesis.getVoices().length > 0;
}

/** Preload voices (needed for some browsers). */
export function initTts(): Promise<void> {
  if (typeof speechSynthesis === "undefined") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const voices = speechSynthesis.getVoices();
    if (voices.length > 0) {
      resolve();
      return;
    }
    speechSynthesis.onvoiceschanged = () => {
      resolve();
    };
    // Timeout fallback
    setTimeout(resolve, 1000);
  });
}
