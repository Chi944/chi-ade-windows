import { Navigate } from "@tanstack/react-router";

/**
 * Router not-found fallback. Instead of a dead 404, route home: the workspace
 * index sends the user to their agents list (or /welcome when there are no
 * categories yet). This also catches a restored/stale route to a deleted agent.
 */
export function NotFound() {
	return <Navigate to="/workspace" replace />;
}
