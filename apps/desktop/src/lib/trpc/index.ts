import { createTRPCReact } from "@trpc/react-query";
import { initTRPC } from "@trpc/server";
import superjson from "superjson";
import type { AppRouter } from "./routers";

export interface ElectronTrpcContext {
	senderId?: number;
	isMainFrame?: boolean;
}

/**
 * Core tRPC initialization
 * This provides the base router and procedure builders used by all routers
 */
const t = initTRPC.context<ElectronTrpcContext>().create({
	transformer: superjson,
	isServer: true,
});

export const router = t.router;
export const mergeRouters = t.mergeRouters;
export const publicProcedure = t.procedure;
export const trpc = createTRPCReact<AppRouter>();
