import '@testing-library/jest-dom';

// jsdom doesn't implement matchMedia — provide a no-op stub so components
// using useMediaQuery don't throw in unit tests (always returns false = mobile).
// Guard: this setup file runs in both node and jsdom environments.
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
