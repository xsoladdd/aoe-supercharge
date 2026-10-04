import { useLocation, useSearch } from 'wouter';

/** Drawers are deep-linkable: `?session=<id>` opens the session drawer on any page. */
export function useSessionHref(): (id: string) => string {
  const [location] = useLocation();
  return (id: string) => `${location}?session=${encodeURIComponent(id)}`;
}

export function useSearchParam(name: string): string | null {
  return new URLSearchParams(useSearch()).get(name);
}
