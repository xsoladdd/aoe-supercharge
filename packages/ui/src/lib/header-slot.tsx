import { createContext, useContext } from 'react';
import { createPortal } from 'react-dom';

/** The right side of the top bar, where a page can put its own controls instead of a second header row. */
export const HeaderSlotContext = createContext<HTMLElement | null>(null);

export function HeaderActions({ children }: { children: React.ReactNode }) {
  const slot = useContext(HeaderSlotContext);
  return slot ? createPortal(children, slot) : null;
}
