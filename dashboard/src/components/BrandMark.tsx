/** The gateway mark: three clients on the left converge on one endpoint (same drawing as the favicon). */
export function BrandMark({ className = "size-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} role="img" aria-label="Team MCP Gateway">
      <rect width="32" height="32" rx="8" className="fill-primary" />
      <circle cx="9" cy="9" r="2.6" className="fill-primary-foreground" opacity=".7" />
      <circle cx="9" cy="23" r="2.6" className="fill-primary-foreground" opacity=".7" />
      <circle cx="23" cy="16" r="3.4" className="fill-primary-foreground" />
      <path d="M11 10.2 20 14.6M11 21.8 20 17.4" className="stroke-primary-foreground" strokeWidth="1.8" strokeLinecap="round" opacity=".7" fill="none" />
    </svg>
  );
}
