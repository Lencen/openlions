"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { api } from "@/lib/trpc";

export default function Providers({ children }: { children: ReactNode }) {
  const [qc] = useState(() => new QueryClient({
    defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
  }));
  const [trpcClient] = useState(() =>
    api.createClient({
      links: [
        httpBatchLink({
          url: typeof window === "undefined" ? "http://localhost:3000/api/trpc" : "/api/trpc",
        }),
      ],
    })
  );
  return (
    <api.Provider client={trpcClient} queryClient={qc}>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </api.Provider>
  );
}
