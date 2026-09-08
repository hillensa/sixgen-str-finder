"use client";
import { useEffect } from "react";
import ErrorState from "@/components/ErrorState";
import { logClientError } from "@/lib/log";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { logClientError("app", error); }, [error]);
  return <ErrorState error={error} reset={reset} />;
}
