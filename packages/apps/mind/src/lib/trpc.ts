// tRPC client wrapper. Re-exports createTRPCReact instance for client components.
// Required by legacy reviews page; new pages should fetch via fetch() to /api/trpc/*.
"use client";

import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "@/server/root";

export const api = createTRPCReact<AppRouter>();
