"use client";
import ErrorState from "@/components/ErrorState";

/** Last resort: the root layout itself failed, so this renders its own document. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#f8fafc", fontFamily: "system-ui, sans-serif" }}>
        <ErrorState error={error} reset={reset} title="The application failed to start" />
      </body>
    </html>
  );
}
