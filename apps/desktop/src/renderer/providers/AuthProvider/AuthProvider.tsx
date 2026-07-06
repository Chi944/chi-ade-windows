import type { ReactNode } from "react";

/**
 * Local build: No cloud auth. Always renders children immediately.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
	return <>{children}</>;
}
