import { it } from 'vitest';
import { main } from './terminal-interaction.fixture';

it('recognizes supported live menus and rejects ordinary terminal prose', main);
