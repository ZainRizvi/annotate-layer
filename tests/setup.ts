import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

// A file's first render of the whole layer takes most of a second in jsdom, so on a busy machine
// the default 1 s wait of findBy* and waitFor runs out before the first pin appears.
configure({ asyncUtilTimeout: 5000 });
