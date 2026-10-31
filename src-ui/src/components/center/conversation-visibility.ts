import { createContext } from 'react';

// Session owners and interaction controls stay mounted when a tab is hidden.
// Expensive transcript renderers can discard their derived trees and tokens.
export const ConversationVisible = createContext(true);
