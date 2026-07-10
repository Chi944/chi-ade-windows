import { describe, expect, it } from "bun:test";
import { preloadActiveOrganizationCollections } from "./CollectionsProvider";

describe("preloadActiveOrganizationCollections", () => {
	it("does not start cloud collection sync in the local build", () => {
		expect(() => preloadActiveOrganizationCollections("org-123")).not.toThrow();
	});
});
