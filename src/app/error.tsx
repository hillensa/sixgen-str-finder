"use client";
import { useEffect } from "react";
import ErrorState from "@/components/ErrorState";
import { logClientError } from "@/lib/log";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { logClientError("route", error); }, [error]);
  return <ErrorState error={error} reset={reset} />;
}
