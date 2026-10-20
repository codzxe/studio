"use client";

// Base client providers (W1-K). React Query is the server-state layer for
// every gateway call the product UI makes (§13); the marketing pages stay
// server-rendered and never touch it. Wave-8 pages (dashboard, editor shell)
// mount under this provider.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

export function Providers({ children }: { children: ReactNode }) {
  // Lazy init: one client per browser session / per SSR request, never
  // recreated on re-render, and it never hydrates shared state.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 1,
            refetchOnWindowFocus: false,
            staleTime: 15_000,
          },
        },
      }),
  );

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
