import { useEffect } from 'react';

const ICON = '/favicon.svg';
let base: Promise<string | null> | null = null;

/** The tab icon with a red count in its corner (9+ past nine), as an SVG data URL. */
export function badgedIcon(svg: string, count: number): string {
  const label = count > 9 ? '9+' : String(count);
  // The icon nests as it is (an inner <svg> fills the outer one); the badge draws over its corner.
  const icon = svg.replace(/<\?xml[^>]*\?>/, '').trim();
  const badge =
    `<circle cx="22" cy="10" r="9.25" fill="#e5484d" stroke="#fff" stroke-width="1.5"/>` +
    `<text x="22" y="10.5" fill="#fff" font-family="system-ui,-apple-system,sans-serif" font-weight="700" ` +
    `font-size="${label.length > 1 ? 10.5 : 13}" text-anchor="middle" dominant-baseline="central">${label}</text>`;
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${icon}${badge}</svg>`,
  )}`;
}

/** Puts `count` on the tab icon, like Slack's red badge; 0 brings the plain icon back. */
export function useFaviconBadge(count: number) {
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
    if (!link) return;
    if (count <= 0) {
      if (link.getAttribute('href') !== ICON) link.href = ICON;
      return;
    }
    let live = true;
    base ??= fetch(ICON)
      .then((r) => (r.ok ? r.text() : null))
      .catch(() => null);
    void base.then((svg) => {
      if (!svg)
        base = null; // try again on the next change
      else if (live) link.href = badgedIcon(svg, count);
    });
    return () => {
      live = false;
    };
  }, [count]);
}
