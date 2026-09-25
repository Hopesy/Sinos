import { it } from 'vitest';
import { main } from './terminal-size-sync.fixture';

it('coordinates PTY geometry across startup, visibility, retries and disposal', main);
