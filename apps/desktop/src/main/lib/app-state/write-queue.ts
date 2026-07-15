import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
	SUPERSET_HOME_DIR_MODE,
	SUPERSET_SENSITIVE_FILE_MODE,
} from "../app-environment";
import type { AppState } from "./schemas";

export interface AppStateMutationCoordinatorOptions {
	validate: (state: unknown) => AppState;
	write: (state: AppState) => Promise<void>;
}

export interface AppStateMutationCommit<T> {
	label: string;
	revision: number;
	result: T;
	state: AppState;
}

export type AppStateConditionalMutationCommit<T> =
	| ({ status: "committed" } & AppStateMutationCommit<T>)
	| { status: "stale"; revision: number; state: AppState };

export type AppStateMutator<T> = (draft: AppState) => T | Promise<T>;

/**
 * Serializes every app-state transition against the latest committed snapshot.
 * A candidate becomes visible only after validation and durable persistence.
 */
export class AppStateMutationCoordinator {
	private committed: AppState;
	private revision = 0;
	private tail: Promise<void> = Promise.resolve();
	private readonly validate: (state: unknown) => AppState;
	private readonly write: (state: AppState) => Promise<void>;

	constructor(
		initialState: AppState,
		options: AppStateMutationCoordinatorOptions,
	) {
		this.validate = options.validate;
		this.write = options.write;
		this.committed = structuredClone(
			this.validate(structuredClone(initialState)),
		);
	}

	enqueue<T>(
		label: string,
		mutate: AppStateMutator<T>,
	): Promise<AppStateMutationCommit<T>> {
		const operation = this.tail.then(async () => {
			const draft = structuredClone(this.committed);
			const result = await mutate(draft);
			const validated = structuredClone(this.validate(draft));
			await this.write(structuredClone(validated));
			this.committed = validated;
			this.revision += 1;
			return {
				label,
				revision: this.revision,
				result,
				state: structuredClone(this.committed),
			};
		});

		// Attach the rejection handler immediately. The returned operation still
		// rejects for its caller, while the continuation tail is always usable.
		this.tail = operation.then(() => undefined).catch(() => undefined);
		return operation;
	}

	enqueueAtRevision<T>(
		label: string,
		expectedRevision: number,
		mutate: AppStateMutator<T>,
	): Promise<AppStateConditionalMutationCommit<T>> {
		const operation = this.tail.then(async () => {
			if (this.revision !== expectedRevision) {
				return {
					status: "stale" as const,
					revision: this.revision,
					state: structuredClone(this.committed),
				};
			}
			const draft = structuredClone(this.committed);
			const result = await mutate(draft);
			const validated = structuredClone(this.validate(draft));
			await this.write(structuredClone(validated));
			this.committed = validated;
			this.revision += 1;
			return {
				status: "committed" as const,
				label,
				revision: this.revision,
				result,
				state: structuredClone(this.committed),
			};
		});

		this.tail = operation.then(() => undefined).catch(() => undefined);
		return operation;
	}

	getSnapshot(): AppState {
		return structuredClone(this.committed);
	}

	getRevision(): number {
		return this.revision;
	}
}

export interface AtomicAppStateWriteDependencies {
	renameFile?: (source: string, destination: string) => Promise<void>;
	temporaryId?: () => string;
}

export async function writeAppStateAtomically(
	path: string,
	state: AppState,
	dependencies: AtomicAppStateWriteDependencies = {},
): Promise<void> {
	const parent = dirname(path);
	await mkdir(parent, { recursive: true, mode: SUPERSET_HOME_DIR_MODE });
	await chmod(parent, SUPERSET_HOME_DIR_MODE).catch(() => undefined);

	const temporaryPath = join(
		parent,
		`.${basename(path)}.${process.pid}.${dependencies.temporaryId?.() ?? randomUUID()}.tmp`,
	);
	let handle: Awaited<ReturnType<typeof open>> | null = null;
	try {
		handle = await open(temporaryPath, "wx", SUPERSET_SENSITIVE_FILE_MODE);
		await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
		await handle.sync();
		await handle.close();
		handle = null;
		await (dependencies.renameFile ?? rename)(temporaryPath, path);
		await chmod(path, SUPERSET_SENSITIVE_FILE_MODE).catch(() => undefined);
	} catch (error) {
		await handle?.close().catch(() => undefined);
		throw error;
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}
