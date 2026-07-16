import { expect, test } from "bun:test";
import {
	isBootErrorReported,
	markBootMounted,
	reportBootError,
} from "./boot-errors";

test("records renderer errors reported after the root was marked mounted", () => {
	markBootMounted();
	reportBootError("asynchronous router failure");
	expect(isBootErrorReported()).toBeTrue();
});
