'use client';

import { createContext, useContext } from 'react';

/** Presentation only; conversation data, sending and execution stay with the host runtime. */
export const ConversationAppearance = createContext<'workspace' | 'messenger'>('workspace');
export const useMessengerAppearance = () => useContext(ConversationAppearance) === 'messenger';
