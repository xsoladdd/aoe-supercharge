import { cn } from '@/lib/utils';

/** Brand mark: the pastel reference gradient lives here only (no text on it, SPEC §14.3). */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('size-8 shrink-0', className)} aria-hidden>
      <defs>
        <linearGradient id="sc-brand" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#eb6fd4" />
          <stop offset=".48" stopColor="#a88ae4" />
          <stop offset="1" stopColor="#d171ef" />
        </linearGradient>
      </defs>
      <circle cx="16" cy="16" r="12" fill="none" stroke="url(#sc-brand)" strokeWidth="5" />
      <path d="M17.5 8.5 11 17h5l-1.5 6.5L21 15h-5z" fill="url(#sc-brand)" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <BrandMark />
      <div className="min-w-0 leading-tight group-data-[collapsible=icon]:hidden">
        <div className="text-[17px] font-semibold tracking-tight">Supercharge</div>
        <div className="text-[13px] text-muted-foreground">Agent of Empires</div>
      </div>
    </div>
  );
}
