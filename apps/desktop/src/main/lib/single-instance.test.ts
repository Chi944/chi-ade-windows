import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	acquireSingleInstanceLock,
	hasSingleInstanceLock,
	resetSingleInstanceLockForTests,
} from "./single-instance";

afterEach(() => resetSingleInstanceLockForTests());

describe("single-instance bootstrap gate", () => {
	test("requests the process lock once and shares the decision with main", () => {
		const requestLock = mock(() => true);

		expect(acquireSingleInstanceLock(requestLock)).toBe(true);
		expect(acquireSingleInstanceLock(requestLock)).toBe(true);
		expect(hasSingleInstanceLock()).toBe(true);
		expect(requestLock).toHaveBeenCalledTimes(1);
	});

	test("preserves a rejected lock without retrying or recording an owner", () => {
		const requestLock = mock(() => false);

		expect(acquireSingleInstanceLock(requestLock)).toBe(false);
		expect(hasSingleInstanceLock()).toBe(false);
		expect(acquireSingleInstanceLock(requestLock)).toBe(false);
		expect(requestLock).toHaveBeenCalledTimes(1);
	});

	test("refuses to invent a lock decision before bootstrap", () => {
		expect(() => hasSingleInstanceLock()).toThrow(
			"single-instance lock has not been acquired",
		);
	});
});
